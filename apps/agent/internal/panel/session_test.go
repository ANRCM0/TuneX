package panel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"net"

	"github.com/gorilla/websocket"
	"github.com/relayx/agent/internal/config"
	"github.com/relayx/agent/internal/fernet"
)

// fakePanel speaks just enough Engine.IO/Socket.IO to drive one agent session:
// OPEN, the namespace CONNECT, a register ack carrying an encrypted licence,
// and one `config` push with a single TCP forward service.
type fakePanel struct {
	t *testing.T

	registerPayload map[string]any

	listen map[string]any
}

func rawPayload(t *testing.T, msg []byte) (ackID int, event string, args []json.RawMessage) {
	t.Helper()
	if len(msg) < 3 || msg[0] != '4' || msg[1] != '2' {
		t.Fatalf("expected a socket.io event packet, got %q", msg)
	}
	rest := msg[2:]
	i := 0
	for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
		i++
	}
	if i > 0 {
		id, err := strconv.Atoi(string(rest[:i]))
		if err != nil {
			t.Fatalf("bad ack id in %q", msg)
		}
		ackID = id
	}
	var body []json.RawMessage
	if err := json.Unmarshal(rest[i:], &body); err != nil {
		t.Fatalf("bad event body %q: %v", rest[i:], err)
	}
	if len(body) == 0 {
		t.Fatalf("event without a name: %q", msg)
	}
	if err := json.Unmarshal(body[0], &event); err != nil {
		t.Fatalf("event name is not a string: %q", body[0])
	}
	return ackID, event, body[1:]
}

func (f *fakePanel) serve(conn *websocket.Conn, snapshot map[string]any) {
	defer conn.Close()
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"srv","pingInterval":25000,"pingTimeout":20000}`))

	// Namespace connect.
	if _, _, err := conn.ReadMessage(); err != nil {
		return
	}
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`40{"sid":"sio"}`))

	// Register with ack.
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return
	}
	id, event, args := rawPayload(f.t, msg)
	if event != "register" {
		f.t.Errorf("first event = %q, want register", event)
		return
	}
	var payload map[string]any
	if len(args) > 0 {
		_ = json.Unmarshal(args[0], &payload)
	}
	f.registerPayload = payload

	ack := map[string]any{
		"site_url": "http://panel.test",
		"type":     "business",
		"license":  snapshot["license"],
		"now":      snapshot["now"],
	}
	body, _ := json.Marshal([]any{ack})
	_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("43%d%s", id, body)))

	// Config push, then wait for the listen report.
	_ = conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`42["config",%q]`, snapshot["config"])))

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_, event, args := rawPayload(f.t, msg)
		if event == "listen" && len(args) > 0 {
			var listen map[string]any
			_ = json.Unmarshal(args[0], &listen)
			f.listen = listen
			return
		}
	}
}

// netListenPort reserves a free TCP port and releases it for the agent to bind.
func netListenPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func TestSessionRegistersAndAppliesConfig(t *testing.T) {
	// Two free ports: the tunnel listener and the forward target (never dialled).
	probe, err := netListenPort()
	if err != nil {
		t.Fatalf("free port: %v", err)
	}

	licenseKey, err := fernet.DecodeKey(config.DefaultLicenseSecret)
	if err != nil {
		t.Fatal(err)
	}
	configKey, err := fernet.DecodeKey(config.DefaultConfigSecret)
	if err != nil {
		t.Fatal(err)
	}
	licenseDoc, _ := json.Marshal(map[string]any{
		"site_url":   "http://panel.test",
		"type":       "business",
		"expired_at": time.Now().Add(24 * time.Hour).Unix(),
	})
	licenseToken, err := fernet.Encrypt(licenseKey, licenseDoc)
	if err != nil {
		t.Fatal(err)
	}
	gostDoc, _ := json.Marshal(map[string]any{
		"services": []any{
			map[string]any{
				"name":     "tcp-1",
				"addr":     fmt.Sprintf("127.0.0.1:%d", probe),
				"handler":  map[string]any{"type": "tcp"},
				"listener": map[string]any{"type": "tcp"},
				"forwarder": map[string]any{
					"nodes":    []any{map[string]any{"name": "n", "addr": "127.0.0.1:9", "metadata": map[string]any{"weight": "1"}}},
					"selector": map[string]any{"strategy": "round"},
				},
				"metadata": map[string]any{"enableStats": true, "observer.resetTraffic": true, "observer.period": "30s"},
			},
		},
	})
	configToken, err := fernet.Encrypt(configKey, gostDoc)
	if err != nil {
		t.Fatal(err)
	}

	panel := &fakePanel{t: t}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		panel.serve(conn, map[string]any{
			"license": licenseToken,
			"config":  configToken,
			"now":     float64(time.Now().Unix()),
		})
	}))
	defer server.Close()

	cfg := config.New()
	cfg.Server = server.URL
	cfg.Token = "token"
	cfg.NodeID = "node-test"
	cfg.ConnectIP = []string{"127.0.0.1"}
	agent, err := New(cfg, "0.13.23-test")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer agent.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go func() { _ = agent.Run(ctx) }()

	// Wait for the server side to see the listen report.
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) && panel.listen == nil {
		time.Sleep(20 * time.Millisecond)
	}

	if panel.registerPayload == nil {
		t.Fatal("agent never registered")
	}
	if got := panel.registerPayload["node_id"]; got != "node-test" {
		t.Fatalf("node_id = %v", got)
	}
	if got := panel.registerPayload["version"]; got != "0.13.23-test" {
		t.Fatalf("version = %v", got)
	}
	if got, ok := panel.registerPayload["connect_ip"].([]any); !ok || len(got) != 1 || got[0] != "127.0.0.1" {
		t.Fatalf("connect_ip = %v", panel.registerPayload["connect_ip"])
	}
	if ports, ok := panel.registerPayload["ports"].(map[string]any); !ok || len(ports) != 9 {
		t.Fatalf("ports = %v", panel.registerPayload["ports"])
	}
	if sysinfo, ok := panel.registerPayload["sysinfo"].(map[string]any); !ok || sysinfo["hostname"] == nil {
		t.Fatalf("sysinfo = %v", panel.registerPayload["sysinfo"])
	}

	if panel.listen == nil {
		t.Fatal("agent never reported the listener (licence or config apply failed)")
	}
	if panel.listen["name"] != "tcp-1" {
		t.Fatalf("listen name = %v", panel.listen["name"])
	}
	if port, _ := panel.listen["port"].(float64); int(port) != probe {
		t.Fatalf("listen port = %v, want %d", panel.listen["port"], probe)
	}
	if panel.listen["node_id"] != "node-test" {
		t.Fatalf("listen node_id = %v", panel.listen["node_id"])
	}
	if strings.TrimSpace(fmt.Sprint(panel.listen["type"])) != "tcp" {
		t.Fatalf("listen type = %v", panel.listen["type"])
	}
}

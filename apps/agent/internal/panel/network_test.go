package panel

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayx/agent/internal/config"
	"github.com/relayx/agent/internal/gostcfg"
)

func newTestAgent(t *testing.T) *Agent {
	t.Helper()
	cfg := config.New()
	cfg.Server = "http://127.0.0.1:1"
	cfg.Token = "token"
	cfg.NodeID = "test-node"
	agent, err := New(cfg, "test-version")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = agent.Close() })
	return agent
}

func TestFetchIP(t *testing.T) {
	agent := newTestAgent(t)
	ctx := context.Background()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "curl/8.4.0" {
			t.Errorf("user-agent = %q", r.Header.Get("User-Agent"))
		}
		_, _ = io.WriteString(w, " 1.2.3.4 \n")
	}))
	defer srv.Close()

	ip, err := agent.fetchIP(ctx, srv.URL)
	if err != nil || ip != "1.2.3.4" {
		t.Fatalf("fetchIP = %q, %v", ip, err)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "not-an-ip")
	}))
	defer bad.Close()
	if _, err := agent.fetchIP(ctx, bad.URL); err == nil {
		t.Fatal("non-IP body accepted")
	}

	// The resolver does not inspect the status code, only the body.
	withStatus := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, "5.6.7.8")
	}))
	defer withStatus.Close()
	if ip, err := agent.fetchIP(ctx, withStatus.URL); err != nil || ip != "5.6.7.8" {
		t.Fatalf("status-ignoring fetch = %q, %v", ip, err)
	}
}

func TestConnectIPsUsesConfiguredValues(t *testing.T) {
	cfg := config.New()
	cfg.Server = "http://127.0.0.1:1"
	cfg.Token = "token"
	cfg.NodeID = "n"
	cfg.ConnectIP = []string{"203.0.113.5", "203.0.113.6"}
	agent, err := New(cfg, "v")
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()

	got := agent.connectIPs(context.Background())
	if len(got) != 2 || got[0] != "203.0.113.5" {
		t.Fatalf("connectIPs = %v", got)
	}
}

func TestConnectIPsDiscoveryAndDedup(t *testing.T) {
	old := publicIPServices
	defer func() { publicIPServices = old }()

	// The same IP from two services is reported once.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "203.0.113.7")
	}))
	defer srv.Close()

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "nonsense")
	}))
	defer broken.Close()

	publicIPServices = []string{srv.URL, broken.URL, srv.URL}
	agent := newTestAgent(t)

	got := agent.connectIPs(context.Background())
	if len(got) != 1 || got[0] != "203.0.113.7" {
		t.Fatalf("connectIPs = %v", got)
	}
}

func TestDialTest(t *testing.T) {
	agent := newTestAgent(t)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()

	ms, err := agent.dialTest(ln.Addr().String())
	if err != nil || ms < 0 {
		t.Fatalf("dialTest = %v, %v", ms, err)
	}

	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	closedAddr := closed.Addr().String()
	_ = closed.Close()
	if _, err := agent.dialTest(closedAddr); err == nil {
		t.Fatal("dialTest to a closed port succeeded")
	}
}

func TestObserveLoopPostsEvents(t *testing.T) {
	doc := `{"services":[{"name":"ss-1","addr":"127.0.0.1:0",
		"handler":{"type":"ss","auth":{"username":"aes-256-gcm","password":"pw"}},
		"listener":{"type":"tcp"},
		"metadata":{"enableStats":true,"observer.resetTraffic":true,"observer.period":"10ms"}}]}`
	cfg, err := gostcfg.Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	agent := newTestAgent(t)
	for _, res := range agent.svc.Apply(cfg) {
		if !res.OK() {
			t.Fatalf("service did not start: %+v", res)
		}
	}

	received := make(chan []byte, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received <- body
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agent.observeLoop(ctx, []string{srv.URL}, 10*time.Millisecond)

	select {
	case body := <-received:
		var payload struct {
			Events []struct {
				Kind    string `json:"kind"`
				Service string `json:"service"`
				Type    string `json:"type"`
			} `json:"events"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("payload: %v (%s)", err, body)
		}
		if len(payload.Events) != 1 || payload.Events[0].Service != "ss-1" || payload.Events[0].Kind != "service" {
			t.Fatalf("events = %+v", payload.Events)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no observer post")
	}
}

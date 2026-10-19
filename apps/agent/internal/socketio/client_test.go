package socketio

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWebsocketURL(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{in: "http://127.0.0.1:3000", want: "ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket"},
		{in: "https://panel.test", want: "wss://panel.test/socket.io/?EIO=4&transport=websocket"},
		{in: "http://panel.test/socket.io", want: "ws://panel.test/socket.io/?EIO=4&transport=websocket"},
		{in: "http://panel.test/socket.io/", want: "ws://panel.test/socket.io/?EIO=4&transport=websocket"},
		{in: "ws://panel.test/base", want: "ws://panel.test/base/socket.io/?EIO=4&transport=websocket"},
		{in: "wss://panel.test", want: "wss://panel.test/socket.io/?EIO=4&transport=websocket"},
		{in: "http://panel.test/?token=abc", want: "ws://panel.test/socket.io/?EIO=4&token=abc&transport=websocket"},
		{in: "ftp://panel.test", wantErr: true},
		{in: "://bad", wantErr: true},
	}
	for _, c := range cases {
		got, err := websocketURL(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("websocketURL(%q) accepted", c.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("websocketURL(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("websocketURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildEvent(t *testing.T) {
	got, err := buildEvent("config", -1, []any{map[string]any{"a": 1}})
	if err != nil {
		t.Fatalf("buildEvent: %v", err)
	}
	if got != `42["config",{"a":1}]` {
		t.Fatalf("buildEvent = %q", got)
	}

	got, err = buildEvent("ping-node", 7, nil)
	if err != nil {
		t.Fatalf("buildEvent: %v", err)
	}
	if got != `427["ping-node"]` {
		t.Fatalf("buildEvent ack = %q", got)
	}

	if _, err := buildEvent("bad", -1, []any{make(chan int)}); err == nil {
		t.Fatal("unmarshalable argument accepted")
	}
}

func TestAckPacket(t *testing.T) {
	if got := ackPacket(3, []any{map[string]any{"ok": true}}); got != `433[{"ok":true}]` {
		t.Fatalf("ackPacket = %q", got)
	}
	if got := ackPacket(0, nil); got != `430[]` {
		t.Fatalf("ackPacket empty = %q", got)
	}
}

func TestBackoff(t *testing.T) {
	cases := []struct {
		attempt int
		min     time.Duration
		max     time.Duration
	}{
		{0, 750 * time.Millisecond, 1250 * time.Millisecond},
		{1, 1500 * time.Millisecond, 2500 * time.Millisecond},
		{2, 3 * time.Second, 5 * time.Second},
		{3, 3750 * time.Millisecond, 6250 * time.Millisecond},
		{10, 3750 * time.Millisecond, 6250 * time.Millisecond},
	}
	for i := 0; i < 50; i++ {
		for _, c := range cases {
			got := Backoff(c.attempt)
			if got < c.min || got > c.max {
				t.Fatalf("Backoff(%d) = %v, want within [%v, %v]", c.attempt, got, c.min, c.max)
			}
		}
	}
}

func TestTruncateAndJoin(t *testing.T) {
	if got := truncate([]byte("hello"), 10); got != "hello" {
		t.Fatalf("truncate short = %q", got)
	}
	if got := truncate([]byte("hello"), 3); got != "hel…" {
		t.Fatalf("truncate long = %q", got)
	}
	// joinRaw feeds the debug log line, so it joins without wrapping brackets.
	joined := joinRaw([]json.RawMessage{json.RawMessage(`{"a":1}`), json.RawMessage(`[2]`)})
	if string(joined) != `{"a":1},[2]` {
		t.Fatalf("joinRaw = %s", joined)
	}
	if string(joinRaw(nil)) != "" {
		t.Fatalf("joinRaw(nil) = %q", joinRaw(nil))
	}
}

// testServer accepts one websocket connection and runs fn on it.
func testServer(t *testing.T, fn func(*websocket.Conn)) *httptest.Server {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		fn(conn)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func dial(t *testing.T, url string, cfg Config) *Client {
	t.Helper()
	cfg.URL = url
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, cfg)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestDialHandshakeAndEvent(t *testing.T) {
	var mu sync.Mutex
	var gotConnect []byte
	var gotAck []byte
	done := make(chan struct{})

	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"srv-1","pingInterval":25000,"pingTimeout":20000}`))
		_, connect, err := conn.ReadMessage()
		if err != nil {
			return
		}
		mu.Lock()
		gotConnect = connect
		mu.Unlock()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40{"sid":"sio-1"}`))

		// Incoming event with ack id 1; the handler replies.
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`421["hello",{"a":1}]`))
		_, ack, err := conn.ReadMessage()
		if err != nil {
			return
		}
		mu.Lock()
		gotAck = ack
		mu.Unlock()
		close(done)
	})

	client := dial(t, srv.URL, Config{})
	client.On("hello", func(args []json.RawMessage) (any, error) {
		if len(args) != 1 || strings.TrimSpace(string(args[0])) != `{"a":1}` {
			t.Errorf("handler args = %v", args)
		}
		return map[string]any{"ok": true}, nil
	})

	select {
	case <-client.Connected():
	case <-time.After(5 * time.Second):
		t.Fatal("client never connected")
	}
	if client.SID() != "srv-1" {
		t.Fatalf("SID = %q", client.SID())
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("server never saw the ACK")
	}
	mu.Lock()
	defer mu.Unlock()
	if string(gotConnect) != "40" {
		t.Fatalf("connect packet = %q", gotConnect)
	}
	if string(gotAck) != `431[{"ok":true}]` {
		t.Fatalf("ack packet = %q", gotAck)
	}
}

func TestDialNamespaceAndAuth(t *testing.T) {
	gotConnect := make(chan string, 1)
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s2"}`))
		_, connect, err := conn.ReadMessage()
		if err != nil {
			return
		}
		gotConnect <- string(connect)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40/admin,{"sid":"n1"}`))
	})

	client := dial(t, srv.URL, Config{Namespace: "/admin", Auth: map[string]any{"token": "t1"}})
	select {
	case connect := <-gotConnect:
		if connect != `40/admin,{"token":"t1"}` {
			t.Fatalf("connect = %q", connect)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no connect packet")
	}
	_ = client
}

func TestDialConnectError(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s3"}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`44{"message":"nope"}`))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := Dial(ctx, Config{URL: srv.URL})
	if err == nil || !strings.Contains(err.Error(), "connect_error") {
		t.Fatalf("Dial = %v", err)
	}
}

func TestEmitWithAckAndPing(t *testing.T) {
	acked := make(chan string, 1)
	pong := make(chan string, 1)
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s4"}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40`))
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			text := string(msg)
			switch {
			case strings.HasPrefix(text, "42"):
				// 42<id>["ping-node",...]
				id := text[2]
				acked <- text
				_ = conn.WriteMessage(websocket.TextMessage, []byte("43"+string(id)+`[{"pong":true}]`))
			case text == "2probe":
				pong <- text
				_ = conn.WriteMessage(websocket.TextMessage, []byte("3probe"))
			}
		}
	})

	client := dial(t, srv.URL, Config{})
	<-client.Connected()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	body, err := client.EmitWithAck(ctx, "ping-node", map[string]any{"x": 1})
	if err != nil {
		t.Fatalf("EmitWithAck: %v", err)
	}
	if len(body) != 1 || strings.TrimSpace(string(body[0])) != `{"pong":true}` {
		t.Fatalf("ack body = %v", body)
	}
	select {
	case sent := <-acked:
		if sent != `420["ping-node",{"x":1}]` {
			t.Fatalf("event packet = %q", sent)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("event not sent")
	}
	if err := client.Emit("no-ack", 1); err != nil {
		t.Fatalf("Emit: %v", err)
	}
}

func TestDispatchPingPong(t *testing.T) {
	// The read loop answers an Engine.IO ping with a pong carrying the payload.
	pong := make(chan string, 1)
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s5"}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40`))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`2probe`))
		_, msg, err := conn.ReadMessage()
		if err == nil {
			pong <- string(msg)
		}
		time.Sleep(50 * time.Millisecond)
	})
	_ = dial(t, srv.URL, Config{})
	select {
	case got := <-pong:
		if got != "3probe" {
			t.Fatalf("pong = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no pong")
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s6"}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40`))
		time.Sleep(200 * time.Millisecond)
	})
	client := dial(t, srv.URL, Config{})
	<-client.Connected()
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if !client.Closed() {
		t.Fatal("Closed() is false")
	}
	if err := client.Emit("x"); err != ErrClosed {
		t.Fatalf("Emit after Close = %v", err)
	}
}

func TestDisconnectEventFiresHandler(t *testing.T) {
	fired := make(chan string, 1)
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s7"}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40`))
		// Socket.IO DISCONNECT packet (41) from the server.
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`41`))
		time.Sleep(100 * time.Millisecond)
	})

	client := dial(t, srv.URL, Config{})
	client.On("disconnect", func([]json.RawMessage) (any, error) {
		fired <- "disconnect"
		return nil, nil
	})
	<-client.Connected()

	select {
	case <-fired:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect handler was not called")
	}
	deadline := time.Now().Add(2 * time.Second)
	for !client.Closed() {
		if time.Now().After(deadline) {
			t.Fatal("client not closed after a disconnect packet")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestEngineCloseFiresDisconnectHandler(t *testing.T) {
	fired := make(chan struct{}, 1)
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`0{"sid":"s8"}`))
		_, _, _ = conn.ReadMessage()
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`40`))
		// Engine.IO CLOSE packet (1).
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`1`))
		time.Sleep(100 * time.Millisecond)
	})

	client := dial(t, srv.URL, Config{})
	client.On("disconnect", func([]json.RawMessage) (any, error) {
		fired <- struct{}{}
		return nil, nil
	})
	<-client.Connected()

	select {
	case <-fired:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect handler was not called on engine close")
	}
}

package mtcp

import (
	"io"
	"net"
	"testing"
	"time"
)

// echoServer starts an mtcp server that echoes each stream.
func echoServer(t *testing.T) *Server {
	t.Helper()
	srv := &Server{Serve: func(conn net.Conn) {
		defer conn.Close()
		_, _ = io.Copy(conn, conn)
	}}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

func TestDialEcho(t *testing.T) {
	srv := echoServer(t)
	addr := srv.Addr().String()

	conn, err := Dial(addr)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	payload := []byte("mtcp-over-smux")
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if string(buf) != string(payload) {
		t.Fatalf("echo = %q", buf)
	}
}

func TestDialReusesSession(t *testing.T) {
	srv := echoServer(t)
	addr := srv.Addr().String()

	first, err := Dial(addr)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	second, err := Dial(addr)
	if err != nil {
		t.Fatalf("second Dial: %v", err)
	}
	defer first.Close()
	defer second.Close()

	// Both streams must run over one smux session (one TCP connection).
	deadline := time.Now().Add(5 * time.Second)
	for {
		srv.mu.Lock()
		n := len(srv.sessions)
		srv.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server sessions = %d, want 1", n)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Two independent streams on the shared session.
	for i, conn := range []net.Conn{first, second} {
		msg := []byte{byte('a' + i)}
		if _, err := conn.Write(msg); err != nil {
			t.Fatalf("stream %d write: %v", i, err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 1)
		if _, err := io.ReadFull(conn, buf); err != nil {
			t.Fatalf("stream %d read: %v", i, err)
		}
		if buf[0] != msg[0] {
			t.Fatalf("stream %d echo = %q", i, buf)
		}
	}
}

func TestCloseStopsListener(t *testing.T) {
	srv := echoServer(t)
	addr := srv.Addr().String()
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := Dial(addr); err == nil {
		t.Fatal("Dial after Close succeeded")
	}
}

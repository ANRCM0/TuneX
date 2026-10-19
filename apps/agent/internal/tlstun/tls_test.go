package tlstun

import (
	"io"
	"net"
	"testing"
	"time"
)

func echoServer(t *testing.T, mux bool) *Server {
	t.Helper()
	srv := &Server{
		Name: "relayx",
		Mux:  mux,
		Serve: func(conn net.Conn) {
			defer conn.Close()
			_, _ = io.Copy(conn, conn)
		},
	}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv
}

func roundTrip(t *testing.T, conn net.Conn, payload string) {
	t.Helper()
	if _, err := conn.Write([]byte(payload)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if string(buf) != payload {
		t.Fatalf("echo = %q, want %q", buf, payload)
	}
}

func TestPlainTLSEcho(t *testing.T) {
	srv := echoServer(t, false)
	if srv.Addr() == nil {
		t.Fatal("Addr() is nil after Listen")
	}
	conn, err := Dial("tls", srv.Addr().String(), "relayx")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	roundTrip(t, conn, "tls-plain")
}

func TestUnknownKindIsPlainTLS(t *testing.T) {
	srv := echoServer(t, false)
	conn, err := Dial("something-else", srv.Addr().String(), "relayx")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	roundTrip(t, conn, "tls-kind")
}

func TestMTLSReusesSession(t *testing.T) {
	srv := echoServer(t, true)
	first, err := Dial("mtls", srv.Addr().String(), "relayx")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	second, err := Dial("mtls", srv.Addr().String(), "relayx")
	if err != nil {
		t.Fatalf("second Dial: %v", err)
	}
	defer first.Close()
	defer second.Close()

	deadline := time.Now().Add(5 * time.Second)
	for {
		srv.mu.Lock()
		n := len(srv.sessions)
		srv.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sessions = %d, want 1", n)
		}
		time.Sleep(10 * time.Millisecond)
	}

	roundTrip(t, first, "stream-1")
	roundTrip(t, second, "stream-2")
}

func TestCloseStopsListener(t *testing.T) {
	srv := echoServer(t, false)
	addr := srv.Addr().String()
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := Dial("tls", addr, "relayx"); err == nil {
		t.Fatal("Dial after Close succeeded")
	}
}

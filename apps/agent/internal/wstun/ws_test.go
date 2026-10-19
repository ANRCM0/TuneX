package wstun

import (
	"io"
	"net"
	"testing"
	"time"
)

func echoServer(t *testing.T, mux bool, path string) *Server {
	t.Helper()
	srv := &Server{
		Name: "relayx",
		Path: path,
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

func TestWSSEchoDefaultPath(t *testing.T) {
	srv := echoServer(t, false, "")
	conn, err := Dial("wss", srv.Addr().String(), "relayx", "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	roundTrip(t, conn, "wss-default")
}

func TestWSSEchoCustomPath(t *testing.T) {
	srv := echoServer(t, false, "tunnel")
	conn, err := Dial("wss", srv.Addr().String(), "relayx", "tunnel")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	roundTrip(t, conn, "wss-custom")
}

func TestMWSSReusesSession(t *testing.T) {
	srv := echoServer(t, true, DefaultPath)
	first, err := Dial("mwss", srv.Addr().String(), "relayx", DefaultPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	second, err := Dial("mwss", srv.Addr().String(), "relayx", DefaultPath)
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

	roundTrip(t, first, "mwss-1")
	roundTrip(t, second, "mwss-2")
}

func TestWSAndMWSWithoutTLS(t *testing.T) {
	plain := &Server{
		Name:  "relayx",
		Plain: true,
		Serve: func(conn net.Conn) {
			defer conn.Close()
			_, _ = io.Copy(conn, conn)
		},
	}
	if err := plain.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { _ = plain.Close() })
	conn, err := Dial("ws", plain.Addr().String(), "", "")
	if err != nil {
		t.Fatalf("ws Dial: %v", err)
	}
	defer conn.Close()
	roundTrip(t, conn, "ws-plain")

	muxed := &Server{
		Name:  "relayx",
		Plain: true,
		Mux:   true,
		Serve: func(conn net.Conn) {
			defer conn.Close()
			_, _ = io.Copy(conn, conn)
		},
	}
	if err := muxed.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen mux: %v", err)
	}
	t.Cleanup(func() { _ = muxed.Close() })
	first, err := Dial("mws", muxed.Addr().String(), "", DefaultPath)
	if err != nil {
		t.Fatalf("mws Dial: %v", err)
	}
	defer first.Close()
	second, err := Dial("mws", muxed.Addr().String(), "", DefaultPath)
	if err != nil {
		t.Fatalf("mws second: %v", err)
	}
	defer second.Close()
	roundTrip(t, first, "mws-1")
	roundTrip(t, second, "mws-2")
}

func TestWrongPathIsRejected(t *testing.T) {
	srv := echoServer(t, false, "/ws")
	if _, err := Dial("wss", srv.Addr().String(), "relayx", "/nope"); err == nil {
		t.Fatal("Dial to a wrong path succeeded")
	}
}

func TestCloseStopsListener(t *testing.T) {
	srv := echoServer(t, false, "")
	addr := srv.Addr().String()
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := Dial("wss", addr, "relayx", ""); err == nil {
		t.Fatal("Dial after Close succeeded")
	}
}

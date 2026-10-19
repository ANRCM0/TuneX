package quicx

import (
	"io"
	"net"
	"testing"
	"time"
)

func echoServer(t *testing.T) *Server {
	t.Helper()
	srv := &Server{
		Name: "relayx",
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

func roundTrip(t *testing.T, conn net.Conn, payload []byte) {
	t.Helper()
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if string(buf) != string(payload) {
		t.Fatalf("echo length %d mismatch", len(buf))
	}
}

func TestQUICEcho(t *testing.T) {
	srv := echoServer(t)
	if srv.Addr() == nil {
		t.Fatal("Addr() is nil after Listen")
	}
	conn, err := Dial(srv.Addr().String(), "relayx")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()
	roundTrip(t, conn, []byte("quic-stream"))
}

func TestQUICReusesSession(t *testing.T) {
	srv := echoServer(t)
	addr := srv.Addr().String()

	first, err := Dial(addr, "relayx")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	second, err := Dial(addr, "relayx")
	if err != nil {
		t.Fatalf("second Dial: %v", err)
	}
	defer first.Close()
	defer second.Close()

	sessMu.Lock()
	shared := sess[addr] != nil
	sessMu.Unlock()
	if !shared {
		t.Fatal("Dial did not cache a session for the address")
	}

	roundTrip(t, first, []byte("stream-one"))
	roundTrip(t, second, []byte("stream-two"))
}

func TestQUICLargePayload(t *testing.T) {
	srv := echoServer(t)
	conn, err := Dial(srv.Addr().String(), "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	payload := make([]byte, 64*1024)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	roundTrip(t, conn, payload)
}

func TestListenValidationAndIdleState(t *testing.T) {
	srv := &Server{}
	if srv.Addr() != nil {
		t.Fatal("Addr before Listen is not nil")
	}
	if err := srv.Close(); err != nil {
		t.Fatalf("Close before Listen: %v", err)
	}
	if err := srv.Listen("not-an-address"); err == nil {
		t.Fatal("invalid listen address accepted")
	}
}

func TestDialRejectsBadAddress(t *testing.T) {
	if _, err := Dial("127.0.0.1:notaport", "relayx"); err == nil {
		t.Fatal("invalid address accepted")
	}
}

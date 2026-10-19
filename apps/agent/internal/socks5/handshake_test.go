package socks5

import (
	"io"
	"net"
	"testing"
	"time"
)

func dialRaw(t *testing.T, addr string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	return c
}

func TestHandshakeVersionAndMethods(t *testing.T) {
	addr := startServer(t, &Server{})

	// Wrong SOCKS version: the connection is closed without a reply.
	c := dialRaw(t, addr)
	if _, err := c.Write([]byte{0x04, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err == nil {
		t.Fatalf("wrong version answered with %v", buf)
	}

	// A server without credentials requires method 0x00; offering only 0x02 is
	// rejected with 05 FF.
	c = dialRaw(t, addr)
	if _, err := c.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("method reply: %v", err)
	}
	if buf[0] != 0x05 || buf[1] != authNoAcceptable {
		t.Fatalf("method reply = %v", buf)
	}
}

func TestHandshakeRequiresUserPassWhenConfigured(t *testing.T) {
	addr := startServer(t, &Server{Username: "u", Password: "p"})

	c := dialRaw(t, addr)
	if _, err := c.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("method reply: %v", err)
	}
	if buf[1] != authNoAcceptable {
		t.Fatalf("method reply = %v, want no-acceptable", buf)
	}
}

func TestUserPassFailures(t *testing.T) {
	addr := startServer(t, &Server{Username: "u", Password: "p"})

	// Wrong sub-negotiation version → 01 01 and close.
	c := dialRaw(t, addr)
	_, _ = c.Write([]byte{0x05, 0x01, 0x02})
	_, _ = io.ReadFull(c, make([]byte, 2))
	_, _ = c.Write([]byte{0x02, 0x01, 'u', 0x01, 'p'})
	buf2 := make([]byte, 2)
	if _, err := io.ReadFull(c, buf2); err != nil {
		t.Fatalf("auth reply: %v", err)
	}
	if buf2[0] != userPassVersion || buf2[1] != 0x01 {
		t.Fatalf("wrong-version reply = %v", buf2)
	}

	// Wrong password → 01 01.
	c = dialRaw(t, addr)
	_, _ = c.Write([]byte{0x05, 0x01, 0x02})
	_, _ = io.ReadFull(c, make([]byte, 2))
	_, _ = c.Write([]byte{0x01, 0x01, 'u', 0x01, 'x'})
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("auth reply: %v", err)
	}
	if buf[0] != userPassVersion || buf[1] != 0x01 {
		t.Fatalf("auth reply = %v", buf)
	}

	// Correct credentials → 01 00.
	c = dialRaw(t, addr)
	_, _ = c.Write([]byte{0x05, 0x01, 0x02})
	_, _ = io.ReadFull(c, make([]byte, 2))
	_, _ = c.Write([]byte{0x01, 0x01, 'u', 0x01, 'p'})
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("auth reply: %v", err)
	}
	if buf[1] != 0x00 {
		t.Fatalf("auth reply = %v", buf)
	}
}

func TestProxyV1Required(t *testing.T) {
	echo := tcpEcho(t)

	// With the header the connection proxies normally.
	withHeader := startServer(t, &Server{ProxyV1: true})
	c := dialRaw(t, withHeader)
	if _, err := c.Write([]byte("PROXY TCP4 1.2.3.4 5.6.7.8 12345 443\r\n")); err != nil {
		t.Fatal(err)
	}
	if err := clientHandshake(c, "", ""); err != nil {
		t.Fatalf("handshake after PROXY: %v", err)
	}
	if err := clientConnect(c, echo); err != nil {
		t.Fatalf("connect: %v", err)
	}

	// Without it the greeting never gets an answer.
	withoutHeader := startServer(t, &Server{ProxyV1: true})
	c2 := dialRaw(t, withoutHeader)
	_ = c2.SetDeadline(time.Now().Add(time.Second))
	if _, err := c2.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c2, make([]byte, 2)); err == nil {
		t.Fatal("greeting accepted without a PROXY header")
	}
}

func TestUDPForwardStatsAndClose(t *testing.T) {
	f := &UDPForward{}
	if st, live := f.TakeStats(false); st.In != 0 || st.Out != 0 || live != 0 {
		t.Fatalf("initial stats = %+v live=%d", st, live)
	}
	if err := f.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	if f.pc == nil {
		t.Fatal("packet conn is nil after Listen")
	}
	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

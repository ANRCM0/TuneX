package relayx

import (
	"net"
	"testing"
	"time"
)

func TestDialEcho(t *testing.T) {
	srv := &Server{
		Key: "site-key",
		Serve: func(c net.Conn) {
			defer c.Close()
			buf := make([]byte, 32)
			n, err := c.Read(buf)
			if err != nil {
				return
			}
			_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
		},
	}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := Dial(DialOptions{Addr: srv.Addr().String(), Key: "site-key", Host: "panel.example"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-relayx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-relayx" {
		t.Fatalf("got %q", buf[:n])
	}

	if _, err := Dial(DialOptions{Addr: srv.Addr().String(), Key: "nope"}); err == nil {
		t.Fatal("bad key was accepted")
	}
}

func TestPathRequired(t *testing.T) {
	srv := &Server{Key: "site-key", Path: "/only"}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	if _, err := Dial(DialOptions{Addr: srv.Addr().String(), Key: "site-key"}); err == nil {
		t.Fatal("default path was accepted")
	}
	c, err := Dial(DialOptions{Addr: srv.Addr().String(), Key: "site-key", Path: "/only"})
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}

func TestSessionReuse(t *testing.T) {
	srv := &Server{
		Key: "site-key",
		Serve: func(c net.Conn) {
			defer c.Close()
			buf := make([]byte, 32)
			n, err := c.Read(buf)
			if err != nil {
				return
			}
			_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
		},
	}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	opt := DialOptions{Addr: srv.Addr().String(), Key: "site-key"}
	before := len(sessionCache)
	c1, err := Dial(opt)
	if err != nil {
		t.Fatal(err)
	}
	c2, err := Dial(opt)
	if err != nil {
		t.Fatal(err)
	}
	if len(sessionCache) != before+1 {
		t.Fatalf("sessions = %d, want %d", len(sessionCache), before+1)
	}
	for _, c := range []net.Conn{c1, c2} {
		if _, err := c.Write([]byte("again")); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 32)
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, err := c.Read(buf)
		if err != nil || string(buf[:n]) != "pong:again" {
			t.Fatalf("got %q %v", buf[:n], err)
		}
	}
	if err := c1.Close(); err != nil {
		t.Fatal(err)
	}
	sess := c1.(*streamConn).session
	if sess.IsClosed() {
		t.Fatal("closing one stream closed the shared session")
	}
	_ = c2.Close()
}

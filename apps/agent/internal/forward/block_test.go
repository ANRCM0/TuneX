package forward

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestBlockBittorrent(t *testing.T) {
	echo := newEcho(t)
	defer echo.Close()
	srv, err := StartTCP("127.0.0.1:0", echo.Addr().String(), false, []string{"bittorrent"}, nil, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	payload := append([]byte{19}, []byte("BitTorrent protocol")...)
	if _, err := c.Write(payload); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 8)); err == nil {
		t.Fatal("blocked connection stayed open")
	}

	ok, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if _, err := ok.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	_ = ok.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, err := ok.Read(buf)
	if err != nil && n == 0 {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("http was blocked")
	}
}

func TestUnknownDroppedWithoutFallback(t *testing.T) {
	echo := newEcho(t)
	defer echo.Close()
	srv, err := StartTCP("127.0.0.1:0", echo.Addr().String(), false, []string{"bittorrent"}, nil, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("not-a-known-protocol")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 8)); err == nil {
		t.Fatal("unknown protocol was forwarded")
	}

	allow, err := StartTCP("127.0.0.1:0", echo.Addr().String(), false, []string{"bittorrent"}, nil, nil, nil, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	defer allow.Close()
	ok, err := net.Dial("tcp", allow.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if _, err := ok.Write([]byte("not-a-known-protocol")); err != nil {
		t.Fatal(err)
	}
	_ = ok.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 32)
	n, err := ok.Read(buf)
	if err != nil || string(buf[:n]) != "not-a-known-protocol" {
		t.Fatalf("fallback read %q %v", buf[:n], err)
	}
}

func newEcho(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(c)
		}
	}()
	return ln
}

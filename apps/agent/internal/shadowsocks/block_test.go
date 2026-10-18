package shadowsocks

import (
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/relayx/agent/internal/socksaddr"
)

func TestBlockBittorrent(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan []byte, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 64)
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		n, _ := c.Read(buf)
		got <- append([]byte(nil), buf[:n]...)
		_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
	}()

	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	addr, err := socksaddr.Marshal(host, uint16(port))
	if err != nil {
		t.Fatal(err)
	}

	srv, err := New("aes-128-gcm", "secret")
	if err != nil {
		t.Fatal(err)
	}
	srv.Block = []string{"bittorrent"}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	blocked, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	w, err := NewWriter(blocked, "aes-128-gcm", "secret")
	if err != nil {
		t.Fatal(err)
	}
	payload := append(append([]byte(nil), addr...), 19)
	payload = append(payload, []byte("BitTorrent protocol")...)
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-got:
		t.Fatalf("blocked payload reached the target: %q", b)
	case <-time.After(700 * time.Millisecond):
	}
	blocked.Close()

	ok, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	w, err = NewWriter(ok, "aes-128-gcm", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(append(addr, []byte("GET / HTTP/1.0\r\n\r\n")...)); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-got:
		if len(b) == 0 || b[0] == 19 {
			t.Fatalf("target got %q", b)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("allowed payload was not forwarded")
	}
	r, err := NewReader(ok, "aes-128-gcm", "secret")
	if err != nil {
		t.Fatal(err)
	}
	_ = ok.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, err := r.Read(buf)
	if n == 0 {
		t.Fatal(err)
	}
	if string(buf[:5]) != "pong:" {
		t.Fatalf("reply %q", buf[:n])
	}
	_, _ = io.Copy(io.Discard, r)
}

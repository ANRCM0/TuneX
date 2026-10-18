package relay

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/relayx/agent/internal/shadowsocks"
	"github.com/relayx/agent/internal/socks5"
)

func TestConnectFraming(t *testing.T) {
	af, err := addrFeature("127.0.0.1:80")
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := writeMsg(&buf, cmdConnect, []feature{af}); err != nil {
		t.Fatal(err)
	}
	want := []byte{
		0x01, 0x01, 0x00, 0x0a,
		0x02, 0x00, 0x07,
		0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x50,
	}
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("framing %x, want %x", buf.Bytes(), want)
	}
}

func TestDialThroughServer(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()

	srv := &Server{Username: "node", Password: "secret"}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	conn, err := Dial([]Hop{{
		Addr:      srv.Addr().String(),
		Connector: "relay",
		Username:  "node",
		Password:  "secret",
	}}, echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hello-relay")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := io.ReadFull(conn, buf[:len("pong:hello-relay")])
	if err != nil {
		t.Fatal(err)
	}
	if got := string(buf[:n]); got != "pong:hello-relay" {
		t.Fatalf("got %q", got)
	}
	conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		st, _ := srv.TakeStats(false)
		if st.In > 0 && st.Out > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("relay stats in=%d out=%d", st.In, st.Out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestConnectBlocksBittorrent(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()
	got := make(chan struct{}, 1)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 32)
		n, _ := c.Read(buf)
		if n > 0 {
			got <- struct{}{}
		}
	}()
	srv := &Server{Block: []string{"bittorrent"}}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	conn, err := Dial(nil, srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := Handshake(conn, ln.Addr().String(), "", ""); err != nil {
		t.Fatal(err)
	}
	hs := append([]byte{19}, []byte("BitTorrent protocol")...)
	if _, err := conn.Write(hs); err != nil {
		t.Fatal(err)
	}
	select {
	case <-got:
		t.Fatal("bittorrent reached the target")
	case <-time.After(700 * time.Millisecond):
	}
	ok, err := Dial(nil, srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if err := Handshake(ok, echo.Addr().String(), "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := ok.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	_ = ok.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := ok.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(buf[:n], []byte("pong:")) {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestRejectBadAuth(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()
	srv := &Server{Username: "node", Password: "secret"}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	_, err := Dial([]Hop{{
		Addr:      srv.Addr().String(),
		Connector: "relay",
		Username:  "node",
		Password:  "nope",
	}}, echo.Addr().String())
	if err == nil {
		t.Fatal("expected unauthorized")
	}
}

func TestDialThroughSocks5(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()
	srv := &socks5.Server{}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	conn, err := Dial([]Hop{{
		Addr:      srv.Addr().String(),
		Connector: "socks5",
	}}, echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("via-socks")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := conn.Read(buf)
	if err != nil || string(buf[:n]) != "pong:via-socks" {
		t.Fatalf("got %q %v", buf[:n], err)
	}
}

func TestDialThroughShadowsocks(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()
	srv, err := shadowsocks.New("aes-128-gcm", "hop-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	conn, err := Dial([]Hop{{
		Addr:      srv.Addr().String(),
		Connector: "ss",
		Username:  "aes-128-gcm",
		Password:  "hop-secret",
	}}, echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("via-ss")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := conn.Read(buf)
	if err != nil || string(buf[:n]) != "pong:via-ss" {
		t.Fatalf("got %q %v", buf[:n], err)
	}
}

func TestDialThroughHTTP(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()
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
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				req, err := http.ReadRequest(br)
				if err != nil || req.Method != http.MethodConnect {
					return
				}
				want := "Basic " + base64.StdEncoding.EncodeToString([]byte("u:p"))
				if req.Header.Get("Proxy-Authorization") != want {
					_, _ = io.WriteString(c, "HTTP/1.1 407 Proxy Auth Required\r\n\r\n")
					return
				}
				dst, err := net.Dial("tcp", req.Host)
				if err != nil {
					_, _ = io.WriteString(c, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
					return
				}
				defer dst.Close()
				if _, err := io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
					return
				}
				go func() { _, _ = io.Copy(dst, br) }()
				_, _ = io.Copy(c, dst)
			}(c)
		}
	}()
	conn, err := Dial([]Hop{{
		Addr:      ln.Addr().String(),
		Connector: "http",
		Username:  "u",
		Password:  "p",
	}}, echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("via-http")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := conn.Read(buf)
	if err != nil || string(buf[:n]) != "pong:via-http" {
		t.Fatalf("got %q %v", buf[:n], err)
	}
}

func serveEcho(t *testing.T) net.Listener {
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
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()
	return ln
}

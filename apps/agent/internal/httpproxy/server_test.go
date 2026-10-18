package httpproxy

import (
	"encoding/base64"
	"io"
	"net"
	"testing"
	"time"
)

func TestCONNECT(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
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
	srv := &Server{Username: "u", Password: "p"}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := io.WriteString(c, "CONNECT "+echo.Addr().String()+" HTTP/1.1\r\nHost: "+echo.Addr().String()+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 128)
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n])[:12] != "HTTP/1.1 407" {
		t.Fatalf("got %q", buf[:n])
	}
	_ = c.Close()

	c, err = net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	token := base64.StdEncoding.EncodeToString([]byte("u:p"))
	if _, err := io.WriteString(c, "CONNECT "+echo.Addr().String()+" HTTP/1.1\r\nHost: "+echo.Addr().String()+"\r\nProxy-Authorization: Basic "+token+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err = c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if n < 12 || string(buf[:12]) != "HTTP/1.1 200" {
		t.Fatalf("got %q", buf[:n])
	}
	if _, err := io.WriteString(c, "via-http"); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err = c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-http" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestAbsoluteGet(t *testing.T) {
	origin, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer origin.Close()
	go func() {
		c, err := origin.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 512)
		n, _ := c.Read(buf)
		if n < 4 || string(buf[:4]) != "GET " {
			return
		}
		_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\npong:get")
	}()
	srv := &Server{}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	req := "GET http://" + origin.Addr().String() + "/hello HTTP/1.1\r\nHost: " + origin.Addr().String() + "\r\n\r\n"
	if _, err := io.WriteString(c, req); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytesContains(buf[:n], []byte("pong:get")) {
		t.Fatalf("got %q", buf[:n])
	}
	deadline := time.Now().Add(time.Second)
	for {
		st, _ := srv.TakeStats(false)
		if st.In > 0 && st.Out > 0 && st.Conns == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stats %+v", st)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestProxyV1ThenGet(t *testing.T) {
	origin, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer origin.Close()
	go func() {
		c, err := origin.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 512)
		n, _ := c.Read(buf)
		if n < 4 || string(buf[:4]) != "GET " {
			return
		}
		_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\npong:prox")
	}()
	srv := &Server{ProxyV1: true}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	hdr := "PROXY TCP4 192.0.2.1 192.0.2.2 1234 80\r\n"
	req := hdr + "GET http://" + origin.Addr().String() + "/hello HTTP/1.1\r\nHost: " + origin.Addr().String() + "\r\n\r\n"
	if _, err := io.WriteString(c, req); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if !bytesContains(buf[:n], []byte("pong:prox")) {
		t.Fatalf("got %q", buf[:n])
	}
}

func bytesContains(b, sub []byte) bool {
	if len(sub) == 0 || len(b) < len(sub) {
		return false
	}
	for i := 0; i+len(sub) <= len(b); i++ {
		if string(b[i:i+len(sub)]) == string(sub) {
			return true
		}
	}
	return false
}

package httpproxy

import (
	"bufio"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func echoListener(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
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

func startProxy(t *testing.T, srv *Server) string {
	t.Helper()
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv.Addr().String()
}

func TestConnectWithAuth(t *testing.T) {
	echo := echoListener(t)
	proxy := startProxy(t, &Server{Username: "u", Password: "p"})

	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := Connect(c, echo.Addr().String(), "u", "p")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer conn.Close()

	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 16)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := conn.Read(buf)
	if err != nil || string(buf[:n]) != "hello" {
		t.Fatalf("read = %q, %v", buf[:n], err)
	}
}

func TestConnectRejectedByAuth(t *testing.T) {
	echo := echoListener(t)
	proxy := startProxy(t, &Server{Username: "u", Password: "p"})

	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := Connect(c, echo.Addr().String(), "u", "wrong"); err == nil ||
		!strings.Contains(err.Error(), "407") {
		t.Fatalf("Connect err = %v", err)
	}
}

func TestConnectWithoutServerAuth(t *testing.T) {
	echo := echoListener(t)
	proxy := startProxy(t, &Server{})

	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := Connect(c, echo.Addr().String(), "", "")
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	_ = conn.Close()
}

func TestServerRejectsNonAbsoluteRequest(t *testing.T) {
	proxy := startProxy(t, &Server{})
	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := io.WriteString(c, "POST /path HTTP/1.1\r\nHost: example.test\r\nContent-Length: 0\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	status, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("response: %v", err)
	}
	if status.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", status.StatusCode)
	}
}

func TestServerBypassAndDialFailure(t *testing.T) {
	proxy := startProxy(t, &Server{
		Bypass: func(string) bool { return true },
	})
	request := func(addr, target string) *http.Response {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		if _, err := io.WriteString(c, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n"); err != nil {
			t.Fatal(err)
		}
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatalf("response: %v", err)
		}
		return resp
	}

	if resp := request(proxy, "example.test:443"); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("bypass status = %d", resp.StatusCode)
	}

	proxy2 := startProxy(t, &Server{
		Dial: func(net.Addr, string) (net.Conn, error) {
			return nil, errors.New("boom")
		},
	})
	if resp := request(proxy2, "example.test:443"); resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("dial failure status = %d", resp.StatusCode)
	}
}

func TestOriginAddr(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "http://example.test:8080/path", nil)
	if got := originAddr(req); got != "example.test:8080" {
		t.Fatalf("abs url = %q", got)
	}

	req, _ = http.NewRequest(http.MethodGet, "/path", nil)
	req.Host = "example.test"
	if got := originAddr(req); got != "example.test:80" {
		t.Fatalf("host fallback = %q", got)
	}

	if got := originAddr(&http.Request{}); got != "" {
		t.Fatalf("empty = %q", got)
	}
}

func TestAuthOK(t *testing.T) {
	open := &Server{}
	if !open.authOK(&http.Request{Header: http.Header{}}) {
		t.Fatal("credential-less server rejected a request")
	}

	srv := &Server{Username: "u", Password: "p"}
	header := func(value string) *http.Request {
		h := http.Header{}
		if value != "" {
			h.Set("Proxy-Authorization", value)
		}
		return &http.Request{Header: h}
	}
	good := "Basic " + base64.StdEncoding.EncodeToString([]byte("u:p"))
	if !srv.authOK(header(good)) {
		t.Fatal("valid credentials rejected")
	}
	for _, bad := range []string{
		"",
		"Bearer token",
		"Basic !!!",
		"Basic " + base64.StdEncoding.EncodeToString([]byte("u:wrong")),
		"Basic " + base64.StdEncoding.EncodeToString([]byte("nocolon")),
	} {
		if srv.authOK(header(bad)) {
			t.Fatalf("bad header %q accepted", bad)
		}
	}
}

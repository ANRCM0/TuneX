package forward

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestProxyV1Stripped(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	got := make(chan string, 1)
	go func() {
		c, err := echo.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 64)
		n, _ := c.Read(buf)
		got <- string(buf[:n])
	}()

	srv, err := StartTCP("127.0.0.1:0", echo.Addr().String(), true, nil, nil, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := io.WriteString(c, "PROXY TCP4 192.0.2.1 192.0.2.2 12345 443\r\nhello-proxy"); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-got:
		if s != "hello-proxy" {
			t.Fatalf("got %q", s)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timeout")
	}
}

func TestProxyV1RejectsGarbage(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		c, err := echo.Accept()
		if err != nil {
			return
		}
		accepted <- struct{}{}
		c.Close()
	}()

	srv, err := StartTCP("127.0.0.1:0", echo.Addr().String(), true, nil, nil, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = io.WriteString(c, "hello-without-header")
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 8)
	if _, err := c.Read(buf); err == nil {
		t.Fatal("expected the forwarder to close a connection with no PROXY header")
	}
	select {
	case <-accepted:
		t.Fatal("target accepted a connection that had no PROXY header")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestParseProxyV1(t *testing.T) {
	ok := []string{
		"PROXY TCP4 192.0.2.1 192.0.2.2 1 2\r\n",
		"PROXY TCP6 2001:db8::1 2001:db8::2 1 2\r\n",
		"PROXY UNKNOWN\r\n",
	}
	for _, s := range ok {
		if err := parseProxyV1([]byte(s)); err != nil {
			t.Fatalf("%q: %v", s, err)
		}
	}
	bad := []string{
		"PROXY TCP4 192.0.2.1 192.0.2.2 1 2\n",
		"PROXY TCP4 2001:db8::1 192.0.2.2 1 2\r\n",
		"NOTPROXY TCP4 192.0.2.1 192.0.2.2 1 2\r\n",
		"PROXY TCP4 192.0.2.1 192.0.2.2 99999 2\r\n",
	}
	for _, s := range bad {
		if err := parseProxyV1([]byte(s)); err == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}

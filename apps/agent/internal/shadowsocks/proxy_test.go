package shadowsocks

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestProxyV1ThenTCP(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		c, err := echo.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 64)
		n, err := c.Read(buf)
		if err != nil {
			return
		}
		_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
	}()
	srv, err := New("aes-128-gcm", "secret")
	if err != nil {
		t.Fatal(err)
	}
	srv.ProxyV1 = true
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := io.WriteString(c, "PROXY TCP4 192.0.2.1 192.0.2.2 1234 80\r\n"); err != nil {
		t.Fatal(err)
	}
	tun, err := Client(c, "aes-128-gcm", "secret", echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(tun, "via-ss"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = tun.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := tun.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-ss" {
		t.Fatalf("got %q", buf[:n])
	}
}

package mierux

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/enfein/mieru/v3/apis/constant"
	"github.com/enfein/mieru/v3/apis/model"
	"github.com/relayx/agent/internal/limit"
)

func TestGateRejectsSecond(t *testing.T) {
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
				_, _ = io.Copy(io.Discard, c)
			}(c)
		}
	}()
	tcp := echo.Addr().(*net.TCPAddr)
	req := &model.Request{
		Command: constant.Socks5ConnectCmd,
		DstAddr: model.AddrSpec{IP: net.ParseIP("127.0.0.1"), Port: tcp.Port},
	}
	srv := &Server{Gate: limit.New(1, 0, 0, 0)}
	hold, client := net.Pipe()
	defer hold.Close()
	go srv.serve(hold, req)
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	if _, err := client.Read(buf); err != nil {
		t.Fatal(err)
	}

	second, other := net.Pipe()
	defer other.Close()
	done := make(chan struct{})
	go func() {
		srv.serve(second, req)
		close(done)
	}()
	_ = other.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := other.Read(buf)
	if err != nil || n < 2 || buf[1] == 0 {
		t.Fatalf("reply %v n=%d err=%v", buf[:n], n, err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("rejected serve did not return")
	}
}

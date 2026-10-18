package forward

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/limit"
)

func TestAdmissionRejects(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan struct{}, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		_ = c.Close()
		got <- struct{}{}
	}()

	srv, err := StartTCP("127.0.0.1:0", ln.Addr().String(), false, nil, func(net.Addr) bool { return false }, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = c.Write([]byte("hi"))
	_ = c.Close()
	select {
	case <-got:
		t.Fatal("rejected client reached the target")
	case <-time.After(400 * time.Millisecond):
	}

	ok, err := StartTCP("127.0.0.1:0", ln.Addr().String(), false, nil, func(net.Addr) bool { return true }, nil, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	c, err = net.Dial("tcp", ok.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("allowed client did not reach the target")
	}
}

func TestBypassTarget(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan struct{}, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		_ = c.Close()
		got <- struct{}{}
	}()
	srv, err := StartTCP("127.0.0.1:0", ln.Addr().String(), false, nil, nil, func(string) bool { return true }, nil, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = c.Write([]byte("hi"))
	_ = c.Close()
	select {
	case <-got:
		t.Fatal("bypassed target was dialled")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestConnLimit(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 2)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			_, _ = io.Copy(io.Discard, c)
		}
	}()
	srv, err := StartTCP("127.0.0.1:0", ln.Addr().String(), false, nil, nil, nil, limit.New(1, 0, 0, 0), nil, false)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	first, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := first.Write([]byte("hold")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("first connection was not forwarded")
	}
	second, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	_, _ = second.Write([]byte("no"))
	select {
	case <-accepted:
		t.Fatal("second connection from the same IP was forwarded")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestUDPSessionLimit(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	s := &UDPServer{
		Target:  echo.LocalAddr().String(),
		Gate:    limit.New(1, 0, 0, 0),
		clients: map[string]*udpSession{},
	}
	defer func() {
		s.mu.Lock()
		for _, sess := range s.clients {
			s.release(sess)
			_ = sess.conn.Close()
		}
		s.mu.Unlock()
	}()
	a := &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 1}
	b := &net.UDPAddr{IP: net.ParseIP("192.0.2.1"), Port: 2}
	if _, err := s.session(a); err != nil {
		t.Fatal(err)
	}
	if _, err := s.session(b); err == nil {
		t.Fatal("second UDP session from the same IP was allowed")
	}
	s.mu.Lock()
	s.release(s.clients[a.String()])
	delete(s.clients, a.String())
	s.mu.Unlock()
	if _, err := s.session(b); err != nil {
		t.Fatal(err)
	}
}

func TestUDPAdmission(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	got := make(chan struct{}, 1)
	go func() {
		buf := make([]byte, 32)
		_ = echo.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, _, err := echo.ReadFrom(buf); err == nil {
			got <- struct{}{}
		}
	}()

	denied, err := StartUDP("127.0.0.1:0", echo.LocalAddr().String(), func(net.Addr) bool { return false }, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer denied.Close()
	c, err := net.Dial("udp", denied.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("nope")); err != nil {
		t.Fatal(err)
	}
	_ = c.Close()
	select {
	case <-got:
		t.Fatal("rejected datagram reached the target")
	case <-time.After(300 * time.Millisecond):
	}

	ok, err := StartUDP("127.0.0.1:0", echo.LocalAddr().String(), func(net.Addr) bool { return true }, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	c, err = net.Dial("udp", ok.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("yes")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("allowed datagram did not reach the target")
	}
}

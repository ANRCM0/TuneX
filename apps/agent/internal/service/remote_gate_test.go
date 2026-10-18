package service

import (
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/limit"
)

func TestRemoteTCPGate(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	accepted := make(chan struct{})
	go func() {
		c, err := echo.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		close(accepted)
		buf := make([]byte, 8)
		_, _ = c.Read(buf)
	}()
	f := &remoteForward{target: echo.Addr().String(), gate: limit.New(1, 0, 0, 0)}
	a, client := net.Pipe()
	defer client.Close()
	go f.serve(a)
	select {
	case <-accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("first stream was not dialed")
	}
	b, other := net.Pipe()
	defer other.Close()
	done := make(chan struct{})
	go func() {
		f.serve(b)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("second stream was not rejected")
	}
}

func TestRemoteUDPGate(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	f := &remoteUDP{
		target: echo.LocalAddr().String(),
		peers:  map[string]*net.UDPConn{},
		gate:   limit.New(1, 0, 0, 0),
	}
	first := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 1}
	second := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 2}
	c, err := f.session(first)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.session(second); err == nil {
		t.Fatal("second peer from the same IP was accepted")
	}
	_ = c.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := f.session(second); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("peer was not released")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

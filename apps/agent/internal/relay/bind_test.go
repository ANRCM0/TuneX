package relay

import (
	"io"
	"net"
	"testing"
	"time"
)

func TestUDPBindRoundTrip(t *testing.T) {
	srv := &Server{AllowBind: true}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	tun, err := DialBindUDP([]Hop{{Addr: srv.Addr().String(), Connector: "relay"}}, "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Close()

	client, err := net.DialUDP("udp", nil, mustUDP(t, tun.LocalAddr().String()))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("ping-udp")); err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, 32)
	n, peer, err := readTun(tun, buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "ping-udp" {
		t.Fatalf("got %q", buf[:n])
	}
	if _, err := tun.WriteTo([]byte("pong-udp"), peer); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err = client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong-udp" {
		t.Fatalf("got %q", buf[:n])
	}
}

func mustUDP(t *testing.T, addr string) *net.UDPAddr {
	t.Helper()
	ua, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	return ua
}

func readTun(tun *UDPTun, buf []byte) (int, net.Addr, error) {
	type result struct {
		n    int
		addr net.Addr
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		n, addr, err := tun.ReadFrom(buf)
		ch <- result{n, addr, err}
	}()
	select {
	case r := <-ch:
		return r.n, r.addr, r.err
	case <-time.After(3 * time.Second):
		return 0, nil, io.ErrUnexpectedEOF
	}
}

func TestBindRoundTrip(t *testing.T) {
	srv := &Server{AllowBind: true}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	conn, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	ln, err := Bind(conn, "127.0.0.1:0", "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	pub, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	if _, err := pub.Write([]byte("hello-bind")); err != nil {
		t.Fatal(err)
	}

	got, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer got.Close()
	buf := make([]byte, 32)
	_ = got.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := io.ReadFull(got, buf[:len("hello-bind")])
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "hello-bind" {
		t.Fatalf("got %q", buf[:n])
	}
	if _, err := got.Write([]byte("pong:hello-bind")); err != nil {
		t.Fatal(err)
	}
	_ = pub.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err = io.ReadFull(pub, buf[:len("pong:hello-bind")])
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:hello-bind" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestBindRejectedWithoutAllow(t *testing.T) {
	srv := &Server{}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	conn, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := Bind(conn, "127.0.0.1:0", "", ""); err == nil {
		t.Fatal("expected bind to be rejected")
	}
}

package shadowsocks

import (
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/socksaddr"
)

func TestUDPRoundTrip(t *testing.T) {
	dst := socksaddr.Addr{Host: "127.0.0.1", Port: 9}
	pkt, err := PackUDP("aes-256-gcm", "secret", dst, []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	got, payload, err := UnpackUDP("aes-256-gcm", "secret", pkt)
	if err != nil {
		t.Fatal(err)
	}
	if got.String() != "127.0.0.1:9" || string(payload) != "hello" {
		t.Fatalf("got %s %q", got, payload)
	}
	if _, _, err := UnpackUDP("aes-256-gcm", "other", pkt); err == nil {
		t.Fatal("expected decrypt failure with the wrong password")
	}
	if _, err := PackUDP("rc4-md5", "secret", dst, []byte("x")); err == nil {
		t.Fatal("expected unsupported method")
	}
}

func TestUDPBlock(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	got := make(chan []byte, 1)
	go func() {
		buf := make([]byte, 2048)
		for {
			n, _, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			got <- append([]byte(nil), buf[:n]...)
		}
	}()
	echoAddr := echo.LocalAddr().(*net.UDPAddr)
	srv, err := NewUDP("none", "")
	if err != nil {
		t.Fatal(err)
	}
	srv.Block = []string{"bittorrent"}
	if err := srv.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	client, err := net.DialUDP("udp", nil, srv.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	dst := socksaddr.Addr{Host: echoAddr.IP.String(), Port: uint16(echoAddr.Port)}
	hs := append([]byte{19}, []byte("BitTorrent protocol")...)
	pkt, err := PackUDP("none", "", dst, hs)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(pkt); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-got:
		t.Fatalf("bittorrent reached the target: %q", b)
	case <-time.After(400 * time.Millisecond):
	}
	hello, err := PackUDP("none", "", dst, []byte("dns-looking"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(hello); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-got:
		t.Fatalf("unknown payload was forwarded: %q", b)
	case <-time.After(400 * time.Millisecond):
	}
}

func TestUDPForward(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()

	echoAddr := echo.LocalAddr().(*net.UDPAddr)
	srv, err := NewUDP("chacha20-ietf-poly1305", "udp-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	client, err := net.DialUDP("udp", nil, srv.Addr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	dst := socksaddr.Addr{Host: echoAddr.IP.String(), Port: uint16(echoAddr.Port)}
	pkt, err := PackUDP(srv.Method, srv.Password, dst, []byte("hello-ssu"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(pkt); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 2048)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	got, payload, err := UnpackUDP(srv.Method, srv.Password, buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "pong:hello-ssu" {
		t.Fatalf("payload %q from %s", payload, got)
	}
	if got.Port != uint16(echoAddr.Port) {
		t.Fatalf("reply address %s, want port %d", got, echoAddr.Port)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		st, cur := srv.TakeStats(false)
		if st.In >= int64(len("hello-ssu")) && st.Out >= int64(len("pong:hello-ssu")) && st.Conns >= 1 && cur >= 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ssu stats in=%d out=%d conns=%d current=%d", st.In, st.Out, st.Conns, cur)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestUDPClientPicksHop(t *testing.T) {
	a, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	n := 0
	dst := socksaddr.Addr{Host: "127.0.0.1", Port: 9}
	cli := &UDPClient{
		Hop:    a.LocalAddr().String(),
		Method: "none",
		Target: dst,
		Pick: func(net.Addr) (string, string, string, socksaddr.Addr, func()) {
			n++
			hop := a.LocalAddr().String()
			if n%2 == 0 {
				hop = b.LocalAddr().String()
			}
			return hop, "none", "", dst, nil
		},
	}
	if err := cli.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	send := func(msg string) {
		c, err := net.DialUDP("udp", nil, cli.pc.LocalAddr().(*net.UDPAddr))
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		if _, err := c.Write([]byte(msg)); err != nil {
			t.Fatal(err)
		}
	}
	send("one")
	send("two")
	got := map[string]bool{}
	for _, pc := range []net.PacketConn{a, b} {
		_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 2048)
		if _, _, err := pc.ReadFrom(buf); err != nil {
			t.Fatal(err)
		}
		got[pc.LocalAddr().String()] = true
	}
	if !got[a.LocalAddr().String()] || !got[b.LocalAddr().String()] {
		t.Fatalf("hops used %v", got)
	}
}

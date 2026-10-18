package openvpn

import (
	"net"
	"testing"
)

func TestForwardIPv4UDP(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 64)
		n, addr, err := echo.ReadFrom(buf)
		if err != nil {
			return
		}
		_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
	}()
	dst := echo.LocalAddr().(*net.UDPAddr)
	pkt, err := BuildIPv4UDP(net.ParseIP("10.8.0.2"), 40000, dst.IP, dst.Port, []byte("via-ip"))
	if err != nil {
		t.Fatal(err)
	}
	reply, err := ForwardIPv4UDP(pkt)
	if err != nil {
		t.Fatal(err)
	}
	src, sport, back, bport, payload, err := ParseIPv4UDP(reply)
	if err != nil {
		t.Fatal(err)
	}
	if !src.Equal(dst.IP) || sport != dst.Port || !back.Equal(net.ParseIP("10.8.0.2")) || bport != 40000 {
		t.Fatalf("reply %s:%d -> %s:%d", src, sport, back, bport)
	}
	if string(payload) != "pong:via-ip" {
		t.Fatalf("payload %q", payload)
	}
}

func TestIPv4Dest(t *testing.T) {
	pkt, err := BuildIPv4UDP(net.ParseIP("10.8.0.2"), 40000, net.ParseIP("192.0.2.9"), 53, []byte("q"))
	if err != nil {
		t.Fatal(err)
	}
	got, ok := IPv4Dest(pkt)
	if !ok || got != "192.0.2.9:53" {
		t.Fatalf("dest %q ok=%v", got, ok)
	}
	if _, ok := IPv4Dest([]byte{0x45}); ok {
		t.Fatal("short header")
	}
}

func TestL4Blocked(t *testing.T) {
	hs := append([]byte{19}, []byte("BitTorrent protocol")...)
	udp, err := BuildIPv4UDP(net.ParseIP("10.8.0.2"), 40000, net.ParseIP("192.0.2.9"), 6881, hs)
	if err != nil {
		t.Fatal(err)
	}
	if !L4Blocked(udp, []string{"bittorrent"}, true) {
		t.Fatal("udp handshake was allowed")
	}
	syn, err := BuildIPv4TCP(IPv4TCP{
		Src: net.ParseIP("10.8.0.2"), Dst: net.ParseIP("192.0.2.9"),
		SrcPort: 40000, DstPort: 80, Flags: tcpSYN,
	})
	if err != nil {
		t.Fatal(err)
	}
	if L4Blocked(syn, []string{"bittorrent"}, false) {
		t.Fatal("empty SYN was blocked")
	}
	data, err := BuildIPv4TCP(IPv4TCP{
		Src: net.ParseIP("10.8.0.2"), Dst: net.ParseIP("192.0.2.9"),
		SrcPort: 40000, DstPort: 80, Flags: tcpPSH | tcpACK, Payload: []byte("not-a-protocol"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if L4Blocked(data, []string{"bittorrent"}, true) {
		t.Fatal("fallback dropped an unknown payload")
	}
	if !L4Blocked(data, []string{"bittorrent"}, false) {
		t.Fatal("unknown payload was forwarded without fallback")
	}
}

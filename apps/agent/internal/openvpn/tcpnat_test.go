package openvpn

import (
	"net"
	"testing"
	"time"
)

func TestTCPNatEcho(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 64)
		n, err := c.Read(buf)
		if err != nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
		_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
	}()
	dst := ln.Addr().(*net.TCPAddr)
	nat := NewTCPNat()
	defer nat.Close()
	syn, err := BuildIPv4TCP(IPv4TCP{
		Src: net.ParseIP("10.8.0.2"), Dst: dst.IP, SrcPort: 40001, DstPort: dst.Port,
		Seq: 1000, Flags: tcpSYN,
	})
	if err != nil {
		t.Fatal(err)
	}
	reply, err := nat.Handle(syn)
	if err != nil {
		t.Fatal(err)
	}
	synack, err := ParseIPv4TCP(reply)
	if err != nil {
		t.Fatal(err)
	}
	if synack.Flags != tcpSYN|tcpACK || synack.Ack != 1001 {
		t.Fatalf("syn-ack flags %x ack %d", synack.Flags, synack.Ack)
	}
	data, err := BuildIPv4TCP(IPv4TCP{
		Src: net.ParseIP("10.8.0.2"), Dst: dst.IP, SrcPort: 40001, DstPort: dst.Port,
		Seq: 1001, Ack: synack.Seq + 1, Flags: tcpPSH | tcpACK, Payload: []byte("via-tcp"),
	})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	reply, err = nat.Handle(data)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 150*time.Millisecond {
		t.Fatal("handle blocked on the peer")
	}
	ack, err := ParseIPv4TCP(reply)
	if err != nil {
		t.Fatal(err)
	}
	if len(ack.Payload) != 0 || ack.Flags&tcpACK == 0 {
		t.Fatalf("expected a pure ack, flags %x payload %d", ack.Flags, len(ack.Payload))
	}
	select {
	case pkt := <-nat.Replies():
		parsed, err := ParseIPv4TCP(pkt)
		if err != nil {
			t.Fatal(err)
		}
		if string(parsed.Payload) != "pong:via-tcp" {
			t.Fatalf("payload %q", parsed.Payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no delayed tcp reply")
	}
}

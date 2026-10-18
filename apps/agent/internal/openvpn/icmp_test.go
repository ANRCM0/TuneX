package openvpn

import (
	"net"
	"testing"
)

func TestICMPEchoGateway(t *testing.T) {
	if !GatewayIP("10.8.0.0/24").Equal(net.IPv4(10, 8, 0, 1)) {
		t.Fatal(GatewayIP("10.8.0.0/24"))
	}
	req, err := BuildICMPEcho(net.ParseIP("10.8.0.2"), net.ParseIP("10.8.0.1"), 8, 7, 3, []byte("ping-gw"))
	if err != nil {
		t.Fatal(err)
	}
	reply, err := ReplyICMP(req, GatewayIP("10.8.0.0/24"))
	if err != nil {
		t.Fatal(err)
	}
	src, dst, typ, id, seq, payload, err := ParseICMPEcho(reply)
	if err != nil {
		t.Fatal(err)
	}
	if typ != 0 || id != 7 || seq != 3 || string(payload) != "ping-gw" {
		t.Fatalf("type %d id %d seq %d payload %q", typ, id, seq, payload)
	}
	if !src.Equal(net.ParseIP("10.8.0.1")) || !dst.Equal(net.ParseIP("10.8.0.2")) {
		t.Fatalf("src %s dst %s", src, dst)
	}
	if _, err := ReplyICMP(req, net.ParseIP("10.9.0.1")); err == nil {
		t.Fatal("answered a ping that was not for this gateway")
	}
}

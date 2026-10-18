package service

import (
	"crypto/tls"
	"encoding/hex"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/gostcfg"
	"github.com/relayx/agent/internal/openvpn"
)

func TestApplyOpenVPN(t *testing.T) {
	var raw [256]byte
	for i := range raw {
		raw[i] = byte(i + 1)
	}
	var b strings.Builder
	b.WriteString("-----BEGIN OpenVPN Static key V1-----\\n")
	for i := 0; i < len(raw); i += 16 {
		b.WriteString(hex.EncodeToString(raw[i : i+16]))
		b.WriteString("\\n")
	}
	b.WriteString("-----END OpenVPN Static key V1-----")

	const port = 19341
	body := `{
		"services": [{
			"name": "ovpn-1",
			"addr": "127.0.0.1:19341",
			"handler": {"type": "tungo"},
			"metadata": {"enableStats": true, "observer.resetTraffic": true},
			"listener": {"type": "openvpn", "metadata": {"tlsCrypt": "` + b.String() + `"}}
		}]
	}`
	cfg, err := gostcfg.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 1 || !results[0].OK() || results[0].Port != port {
		t.Fatalf("apply: %+v", results)
	}

	clientKey, err := openvpn.NewTLSCrypt(raw[:], true)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", "127.0.0.1:19341")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _, peer0, err := openvpn.Dial(conn, clientKey, &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         "relayx",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if peer0 != 0 {
		t.Fatalf("first peer-id = %d", peer0)
	}
	conn2, err := net.Dial("tcp", "127.0.0.1:19341")
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	stream, keys, peer1, err := openvpn.Dial(conn2, clientKey, &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         "relayx",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if peer1 != 1 {
		t.Fatalf("second peer-id = %d", peer1)
	}
	ch, err := openvpn.NewDataChannel(keys, peer1, 0)
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := ch.Seal([]byte("via-ovpn"))
	if err != nil {
		t.Fatal(err)
	}
	if pkt[1] != 0 || pkt[2] != 0 || pkt[3] != 1 {
		t.Fatalf("peer id bytes %d %d %d", pkt[1], pkt[2], pkt[3])
	}
	if err := openvpn.WriteTCP(conn2, pkt); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		var in uint64
		for _, ev := range m.ObserveEvents() {
			if ev.Service == "ovpn-1" && ev.Stats != nil {
				in = ev.Stats.InputBytes
			}
		}
		if in == uint64(len("via-ovpn")) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("openvpn input bytes = %d", in)
		}
		time.Sleep(20 * time.Millisecond)
	}

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
	ip, err := openvpn.BuildIPv4UDP(net.ParseIP("10.8.0.2"), 40000, dst.IP, dst.Port, []byte("via-ip"))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := ch.Seal(ip)
	if err != nil {
		t.Fatal(err)
	}
	if err := openvpn.WriteTCP(conn2, sealed); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-stream.Data():
		plain, err := ch.Open(got)
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, _, payload, err := openvpn.ParseIPv4UDP(plain)
		if err != nil {
			t.Fatal(err)
		}
		if string(payload) != "pong:via-ip" {
			t.Fatalf("payload %q", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no udp reply on the data channel")
	}

	echoReq, err := openvpn.BuildICMPEcho(net.ParseIP("10.8.0.2"), net.ParseIP("10.8.0.1"), 8, 9, 1, []byte("ping-gw"))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err = ch.Seal(echoReq)
	if err != nil {
		t.Fatal(err)
	}
	if err := openvpn.WriteTCP(conn2, sealed); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-stream.Data():
		plain, err := ch.Open(got)
		if err != nil {
			t.Fatal(err)
		}
		src, _, typ, _, _, payload, err := openvpn.ParseICMPEcho(plain)
		if err != nil {
			t.Fatal(err)
		}
		if typ != 0 || string(payload) != "ping-gw" || !src.Equal(net.ParseIP("10.8.0.1")) {
			t.Fatalf("icmp type %d from %s payload %q", typ, src, payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no icmp echo reply")
	}

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
		_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
	}()
	tcpDst := ln.Addr().(*net.TCPAddr)
	syn, err := openvpn.BuildIPv4TCP(openvpn.IPv4TCP{
		Src: net.ParseIP("10.8.0.2"), Dst: tcpDst.IP, SrcPort: 40001, DstPort: tcpDst.Port,
		Seq: 1000, Flags: 0x02,
	})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err = ch.Seal(syn)
	if err != nil {
		t.Fatal(err)
	}
	if err := openvpn.WriteTCP(conn2, sealed); err != nil {
		t.Fatal(err)
	}
	var synack openvpn.IPv4TCP
	select {
	case got := <-stream.Data():
		plain, err := ch.Open(got)
		if err != nil {
			t.Fatal(err)
		}
		synack, err = openvpn.ParseIPv4TCP(plain)
		if err != nil {
			t.Fatal(err)
		}
		if synack.Flags != 0x12 || synack.Ack != 1001 {
			t.Fatalf("syn-ack flags %x ack %d", synack.Flags, synack.Ack)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no tcp syn-ack")
	}
	data, err := openvpn.BuildIPv4TCP(openvpn.IPv4TCP{
		Src: net.ParseIP("10.8.0.2"), Dst: tcpDst.IP, SrcPort: 40001, DstPort: tcpDst.Port,
		Seq: 1001, Ack: synack.Seq + 1, Flags: 0x18, Payload: []byte("via-tcp"),
	})
	if err != nil {
		t.Fatal(err)
	}
	sealed, err = ch.Seal(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := openvpn.WriteTCP(conn2, sealed); err != nil {
		t.Fatal(err)
	}
	tcpDeadline := time.Now().Add(2 * time.Second)
	for {
		select {
		case got := <-stream.Data():
			plain, err := ch.Open(got)
			if err != nil {
				t.Fatal(err)
			}
			seg, err := openvpn.ParseIPv4TCP(plain)
			if err != nil {
				t.Fatal(err)
			}
			if string(seg.Payload) == "pong:via-tcp" {
				return
			}
		case <-time.After(time.Until(tcpDeadline)):
			t.Fatal("no tcp reply on the data channel")
		}
	}
}

func TestApplyOpenVPNUDP(t *testing.T) {
	var raw [256]byte
	for i := range raw {
		raw[i] = byte(i + 9)
	}
	var b strings.Builder
	b.WriteString("-----BEGIN OpenVPN Static key V1-----\\n")
	for i := 0; i < len(raw); i += 16 {
		b.WriteString(hex.EncodeToString(raw[i : i+16]))
		b.WriteString("\\n")
	}
	b.WriteString("-----END OpenVPN Static key V1-----")
	const port = 19343
	body := `{
		"services": [{
			"name": "ovpn-udp",
			"addr": "127.0.0.1:19343",
			"handler": {"type": "tungo"},
			"listener": {"type": "openvpn", "metadata": {"udp": true, "tlsCrypt": "` + b.String() + `"}}
		}]
	}`
	cfg, err := gostcfg.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 1 || !results[0].OK() || results[0].Port != port {
		t.Fatalf("apply: %+v", results)
	}
	clientKey, err := openvpn.NewTLSCrypt(raw[:], true)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := openvpn.DialUDP("127.0.0.1:19343")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _, peer, err := openvpn.Dial(conn, clientKey, &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         "relayx",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if peer != 0 {
		t.Fatalf("peer-id = %d", peer)
	}
}

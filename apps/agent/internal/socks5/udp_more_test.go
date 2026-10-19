package socks5

import (
	"bytes"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/socksaddr"
)

func TestUDPIdleAndPortParsing(t *testing.T) {
	var nilSrv *UDPServer
	if got := nilSrv.idle(); got != udpIdle {
		t.Fatalf("nil idle = %v", got)
	}
	if got := (&UDPServer{}).idle(); got != udpIdle {
		t.Fatalf("default idle = %v", got)
	}
	if got := (&UDPServer{Idle: time.Second}).idle(); got != time.Second {
		t.Fatalf("override idle = %v", got)
	}

	cases := map[string]uint16{"53": 53, "0": 0, "65535": 65535}
	for in, want := range cases {
		if got, err := parsePort(in); err != nil || got != want {
			t.Fatalf("parsePort(%q) = %d, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "x", "70000", "-1"} {
		if _, err := parsePort(bad); err == nil {
			t.Fatalf("parsePort(%q) accepted", bad)
		}
	}

	// addrFrom carries host/port only; the ATYP is chosen at encode time.
	if a := addrFrom("1.2.3.4", 80); a.Host != "1.2.3.4" || a.Port != 80 || a.String() != "1.2.3.4:80" {
		t.Fatalf("addrFrom ipv4 = %+v", a)
	}
	if a := addrFrom("example.test", 53); a.Host != "example.test" || a.Port != 53 {
		t.Fatalf("addrFrom domain = %+v", a)
	}
}

func TestUDPCodecErrors(t *testing.T) {
	dst := socksaddr.Addr{Type: socksaddr.ATYPIPv4, Host: "1.2.3.4", Port: 80}
	pkt, err := EncodeUDP(dst, []byte("hello"))
	if err != nil {
		t.Fatalf("EncodeUDP: %v", err)
	}
	got, payload, err := DecodeUDP(pkt)
	if err != nil || got.Host != "1.2.3.4" || string(payload) != "hello" {
		t.Fatalf("DecodeUDP = %+v %q %v", got, payload, err)
	}

	if _, _, err := DecodeUDP([]byte{0, 0}); err == nil {
		t.Fatal("short packet accepted")
	}
	// RSV is ignored (recovered permissive parsing); only FRAG is checked.
	rsv := append([]byte{}, pkt...)
	rsv[0] = 1
	if _, payload, err := DecodeUDP(rsv); err != nil || string(payload) != "hello" {
		t.Fatalf("non-zero RSV = %v, %v", payload, err)
	}
	// Only fragment 0 is supported.
	bad := append([]byte{}, pkt...)
	bad[2] = 1
	if _, _, err := DecodeUDP(bad); err == nil {
		t.Fatal("fragment accepted")
	}
}

func TestUDPServerBypassAndAdmission(t *testing.T) {
	echo, echoAddr := udpEcho(t)
	defer echo.Close()
	_ = echoAddr

	srv := &UDPServer{Bypass: func(string) bool { return true }}
	if err := srv.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	client, err := net.DialUDP("udp", nil, srv.pc.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	dst := socksaddr.Addr{Host: "127.0.0.1", Port: 9}
	pkt, _ := EncodeUDP(dst, []byte("blocked"))
	if _, err := client.Write(pkt); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	buf := make([]byte, 256)
	if _, err := client.Read(buf); err == nil {
		t.Fatal("bypassed datagram produced a reply")
	}
	if st, live := srv.TakeStats(false); st.Conns != 0 || live != 0 {
		t.Fatalf("stats after bypass = %+v live=%d", st, live)
	}
}

func TestUDPServerAdmissionDropsPackets(t *testing.T) {
	srv := &UDPServer{Allow: func(net.Addr) bool { return false }}
	if err := srv.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	client, err := net.DialUDP("udp", nil, srv.pc.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	pkt, _ := EncodeUDP(socksaddr.Addr{Host: "127.0.0.1", Port: 9}, []byte("x"))
	_, _ = client.Write(pkt)
	time.Sleep(100 * time.Millisecond)
	srv.mu.Lock()
	sessions := len(srv.sessions)
	srv.mu.Unlock()
	if sessions != 0 {
		t.Fatalf("admission-rejected packet opened %d sessions", sessions)
	}
}

func TestUDPServerSessionReaping(t *testing.T) {
	echo, echoAddr := udpEcho(t)
	defer echo.Close()

	srv := &UDPServer{Idle: 60 * time.Millisecond}
	if err := srv.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	client, err := net.DialUDP("udp", nil, srv.pc.LocalAddr().(*net.UDPAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	pkt, _ := EncodeUDP(socksaddr.Addr{Host: echoAddr.IP.String(), Port: uint16(echoAddr.Port)}, []byte("hi"))
	if _, err := client.Write(pkt); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 256)
	if _, err := client.Read(buf); err != nil {
		t.Fatalf("echo: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		srv.mu.Lock()
		live := len(srv.sessions)
		srv.mu.Unlock()
		if live == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("session not reaped (live=%d)", live)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestUDPDecodeRejectsUnsupportedATYP(t *testing.T) {
	raw := append([]byte{0, 0, 0, 0x09, 0, 0}, bytes.Repeat([]byte{0}, 8)...)
	if _, _, err := DecodeUDP(raw); err == nil {
		t.Fatal("unsupported ATYP accepted")
	}
}

package wireguard

import (
	"encoding/base64"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/openvpn"
)

func TestNewValidation(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))

	cases := []Config{
		{PrivateKey: key},  // no interface
		{Interface: "wg0"}, // no key
		{Interface: "wg0", PrivateKey: key, ListenPort: -1}, // bad port
		{Interface: "wg0", PrivateKey: key, ListenPort: 70000},
		{Interface: "wg0", PrivateKey: key, Peers: []Peer{{}}}, // peer without key
		{
			Interface: "wg0", PrivateKey: key,
			Peers: []Peer{{PublicKey: key, AllowedIPs: []string{"not-a-cidr"}}},
		},
	}
	for i, cfg := range cases {
		if _, err := New(cfg); err == nil {
			t.Fatalf("case %d accepted: %+v", i, cfg)
		}
	}

	good := Config{
		Interface:  "wg0",
		PrivateKey: key,
		Address:    []string{"10.66.0.1/24"},
		ListenPort: 51820,
		Peers:      []Peer{{PublicKey: key, AllowedIPs: []string{"10.66.0.2/32", "192.0.2.7"}}},
	}
	if _, err := New(good); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

func TestUpUserspaceRejectsBadKey(t *testing.T) {
	m := &Manager{conf: Config{Interface: "wg0", PrivateKey: "not-a-key"}}
	if err := m.upUserspace(); err == nil {
		t.Fatal("userspace accepted an invalid private key")
	}
}

// newLoopWG builds the packet-loop side without a WireGuard device.
func newLoopWG(t *testing.T) *userspaceWG {
	t.Helper()
	return &userspaceWG{
		tun:  newChanTUN("wg-test", 1420),
		nat:  openvpn.NewTCPNat(),
		stop: make(chan struct{}),
	}
}

func TestLoopAnswersGatewayPing(t *testing.T) {
	u := newLoopWG(t)
	defer u.Close()

	gw := net.ParseIP("10.66.0.1").To4()
	go u.loop(gw)

	request, err := openvpn.BuildICMPEcho(net.ParseIP("10.66.0.2"), gw, 8, 7, 1, []byte("ping"))
	if err != nil {
		t.Fatalf("BuildICMPEcho: %v", err)
	}
	u.tun.out <- request

	buf := make([]byte, 128)
	sizes := make([]int, 1)
	deadline := time.Now().Add(2 * time.Second)
	for {
		n, err := u.tun.Read([][]byte{buf}, sizes, 0)
		if err == nil && n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no ICMP reply (err=%v)", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	reply := buf[:sizes[0]]
	if reply[20] != 0 {
		t.Fatalf("reply type = %d, want echo reply", reply[20])
	}
	if u.rx.Load() != int64(len(request)) || u.tx.Load() <= 0 {
		t.Fatalf("counters rx=%d tx=%d", u.rx.Load(), u.tx.Load())
	}
}

func TestLoopRespectsBypass(t *testing.T) {
	u := newLoopWG(t)
	u.bypass = func(string) bool { return true }
	defer u.Close()

	gw := net.ParseIP("10.66.0.1").To4()
	go u.loop(gw)

	request, _ := openvpn.BuildICMPEcho(net.ParseIP("10.66.0.2"), gw, 8, 1, 1, nil)
	u.tun.out <- request
	time.Sleep(100 * time.Millisecond)
	if len(u.tun.in) != 0 {
		t.Fatalf("bypassed packet produced %d replies", len(u.tun.in))
	}
	if u.rx.Load() != int64(len(request)) {
		t.Fatalf("rx = %d", u.rx.Load())
	}
}

func TestLoopDropsBlockedProtocol(t *testing.T) {
	u := newLoopWG(t)
	u.block = []string{"http"}
	u.fallback = true
	defer u.Close()

	gw := net.ParseIP("10.66.0.1").To4()
	go u.loop(gw)

	// TCP payload that sniffs as HTTP.
	pkt := make([]byte, 20+20+16)
	pkt[0] = 0x45
	pkt[2] = 0
	pkt[3] = byte(len(pkt))
	pkt[8] = 64
	pkt[9] = 6 // TCP
	copy(pkt[12:16], net.ParseIP("10.66.0.2").To4())
	copy(pkt[16:20], net.ParseIP("203.0.113.9").To4())
	pkt[20+12] = 0x50 // data offset
	copy(pkt[40:], "GET / HTTP/1.1\r\n")

	u.tun.out <- pkt
	time.Sleep(100 * time.Millisecond)
	if len(u.tun.in) != 0 {
		t.Fatalf("blocked HTTP packet produced %d replies", len(u.tun.in))
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	u := newLoopWG(t)
	u.Close()
	u.Close()
	if _, err := u.tun.Read([][]byte{make([]byte, 8)}, make([]int, 1), 0); err == nil {
		t.Fatal("read after close succeeded")
	}
}

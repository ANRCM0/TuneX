package wireguard

import (
	"encoding/base64"
	"encoding/hex"
	"net"
	"os"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun"
)

func TestKeyHex(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	want := hex.EncodeToString(raw)

	for _, encoded := range []string{
		base64.StdEncoding.EncodeToString(raw),
		base64.RawStdEncoding.EncodeToString(raw),
		"  " + base64.StdEncoding.EncodeToString(raw) + "\n",
	} {
		got, err := keyHex(encoded)
		if err != nil {
			t.Fatalf("keyHex(%q): %v", encoded, err)
		}
		if got != want {
			t.Fatalf("keyHex(%q) = %s", encoded, got)
		}
	}

	if _, err := keyHex(base64.StdEncoding.EncodeToString(raw[:16])); err == nil {
		t.Fatal("short key accepted")
	}
	if _, err := keyHex("not a key"); err == nil {
		t.Fatal("garbage key accepted")
	}
}

func TestGatewayOf(t *testing.T) {
	if got := gatewayOf(nil); got != nil {
		t.Fatalf("empty = %v", got)
	}
	if got := gatewayOf([]string{"10.66.0.9/24"}); !got.Equal(net.ParseIP("10.66.0.9")) {
		t.Fatalf("cidr = %v", got)
	}
	if got := gatewayOf([]string{"10.66.0.1"}); !got.Equal(net.ParseIP("10.66.0.1")) {
		t.Fatalf("plain = %v", got)
	}
}

func ipv4Packet(src, dst net.IP, payload string) []byte {
	pkt := make([]byte, 20+len(payload))
	pkt[0] = 0x45
	pkt[2] = 0
	pkt[3] = byte(20 + len(payload))
	pkt[8] = 64
	pkt[9] = 17
	copy(pkt[12:16], src.To4())
	copy(pkt[16:20], dst.To4())
	copy(pkt[20:], payload)
	return pkt
}

func TestInnerSrc(t *testing.T) {
	pkt := ipv4Packet(net.ParseIP("10.1.2.3"), net.ParseIP("10.66.0.1"), "x")
	src := innerSrc(pkt)
	if src == nil || src.String() != "10.1.2.3" {
		t.Fatalf("innerSrc = %v", src)
	}

	if got := innerSrc([]byte{0x45, 0, 0, 20}); got != nil {
		t.Fatalf("short packet = %v", got)
	}
	v6 := make([]byte, 40)
	v6[0] = 0x60
	if got := innerSrc(v6); got != nil {
		t.Fatalf("ipv6 packet = %v", got)
	}
}

func TestIPCConfig(t *testing.T) {
	priv := base64.StdEncoding.EncodeToString(make([]byte, 32))
	pub := base64.StdEncoding.EncodeToString([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
		17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32})
	psk := base64.StdEncoding.EncodeToString([]byte{32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
		16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1})
	keepalive := 25

	cfg := Config{
		PrivateKey: priv,
		ListenPort: 51820,
		Peers: []Peer{
			{
				PublicKey:           pub,
				PresharedKey:        psk,
				Endpoint:            "1.2.3.4:51820",
				AllowedIPs:          []string{"10.66.0.2/32"},
				PersistentKeepalive: &keepalive,
			},
			{PublicKey: pub},
			{PublicKey: "not-a-key"},
		},
	}

	got := ipcConfig(cfg)
	for _, want := range []string{
		"private_key=" + hex.EncodeToString(make([]byte, 32)),
		"listen_port=51820",
		"public_key=" + hex.EncodeToString([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
			17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}),
		"preshared_key=",
		"endpoint=1.2.3.4:51820",
		"allowed_ip=10.66.0.2/32",
		"persistent_keepalive_interval=25",
		// second peer defaults its allowed ips, the third is skipped entirely
		"allowed_ip=0.0.0.0/0",
	} {
		if !contains(got, want) {
			t.Fatalf("ipcConfig missing %q in:\n%s", want, got)
		}
	}
	if count := occurrences(got, "public_key="); count != 2 {
		t.Fatalf("public_key count = %d, want 2 (invalid peer skipped)", count)
	}

	if got := ipcConfig(Config{PrivateKey: "bad"}); got != "" {
		t.Fatalf("invalid private key = %q", got)
	}
}

func contains(haystack, needle string) bool {
	return occurrences(haystack, needle) > 0
}

func occurrences(haystack, needle string) int {
	count := 0
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			count++
		}
	}
	return count
}

func TestChanTUN(t *testing.T) {
	dev := newChanTUN("wg0", 1420)
	if dev.File() != nil {
		t.Fatal("chanTUN should not expose a file")
	}
	if name, _ := dev.Name(); name != "wg0" {
		t.Fatalf("name = %q", name)
	}
	if mtu, _ := dev.MTU(); mtu != 1420 {
		t.Fatalf("mtu = %d", mtu)
	}
	if dev.BatchSize() != 1 {
		t.Fatalf("batch = %d", dev.BatchSize())
	}
	if ev := <-dev.Events(); ev != tun.EventUp {
		t.Fatalf("first event = %v", ev)
	}

	// Inject → Read hands the packet back at the requested offset.
	dev.inject([]byte("packet-1"))
	buf := make([]byte, 64)
	sizes := make([]int, 1)
	n, err := dev.Read([][]byte{buf}, sizes, 4)
	if err != nil || n != 1 || string(buf[4:4+sizes[0]]) != "packet-1" {
		t.Fatalf("Read = %d %v size=%d", n, err, sizes[0])
	}

	// Write → the packet shows up on the out channel after the offset.
	if _, err := dev.Write([][]byte{[]byte("....payload")}, 4); err != nil {
		t.Fatalf("Write: %v", err)
	}
	select {
	case pkt := <-dev.out:
		if string(pkt) != "payload" {
			t.Fatalf("out packet = %q", pkt)
		}
	case <-time.After(time.Second):
		t.Fatal("no packet on the out channel")
	}

	if err := dev.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := dev.Read([][]byte{buf}, sizes, 0); err != os.ErrClosed {
		t.Fatalf("Read after close = %v", err)
	}
}

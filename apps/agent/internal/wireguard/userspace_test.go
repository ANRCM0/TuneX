package wireguard

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/device"

	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/openvpn"
)

func TestUserspaceUDP(t *testing.T) {
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

	// Let the device pick its own ephemeral port and read it back through the
	// WireGuard UAPI; probing then closing a socket races other parallel test
	// packages for the same port. Keep a small retry for slow handshakes.
	var lastErr error
	for attempt := 1; attempt <= 5; attempt++ {
		lastErr = runUserspaceUDP(echo)
		if lastErr == nil {
			return
		}
		t.Logf("attempt %d: %v", attempt, lastErr)
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no decrypted reply after 5 attempts: %v", lastErr)
}

func runUserspaceUDP(echo net.PacketConn) error {
	var sPriv, sPub, cPriv, cPub string
	sPriv, sPub = testWgKey()
	cPriv, cPub = testWgKey()
	server, err := New(Config{
		Interface:  "wgtest-s",
		PrivateKey: sPriv,
		ListenPort: 0,
		Address:    []string{"10.66.0.1/32"},
		Peers:      []Peer{{PublicKey: cPub, AllowedIPs: []string{"0.0.0.0/0"}}},
	})
	if err != nil {
		return err
	}
	server.SetPolicy(nil, []string{"bittorrent"}, true)
	if err := server.Up(); err != nil {
		return err
	}
	defer server.Down()
	if server.user == nil {
		return errors.New("expected userspace wireguard server")
	}
	port, err := uapiListenPort(server.user.dev)
	if err != nil {
		return err
	}
	client, err := New(Config{
		Interface:  "wgtest-c",
		PrivateKey: cPriv,
		Address:    []string{"10.66.0.2/32"},
		Peers: []Peer{{
			PublicKey:  sPub,
			AllowedIPs: []string{"0.0.0.0/0"},
			Endpoint:   "127.0.0.1:" + itoa(port),
		}},
	})
	if err != nil {
		return err
	}
	if err := client.Up(); err != nil {
		return err
	}
	defer client.Down()
	if client.user == nil {
		return errors.New("expected userspace wireguard client")
	}

	echoAddr := echo.LocalAddr().(*net.UDPAddr)
	pkt, err := openvpn.BuildIPv4UDP(net.ParseIP("10.66.0.2"), 40000, echoAddr.IP, echoAddr.Port, []byte("via-wg"))
	if err != nil {
		return err
	}
	blocked, err := openvpn.BuildIPv4UDP(net.ParseIP("10.66.0.2"), 40000, echoAddr.IP, echoAddr.Port, append([]byte{19}, []byte("BitTorrent protocol")...))
	if err != nil {
		return err
	}
	client.user.tun.inject(blocked)
	client.user.tun.inject(pkt)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case got := <-client.user.tun.out:
			_, _, _, _, payload, err := openvpn.ParseIPv4UDP(got)
			if err != nil {
				continue
			}
			if bytes.Contains(payload, []byte("BitTorrent protocol")) {
				return errors.New("bittorrent was forwarded")
			}
			if string(payload) == "pong:via-wg" {
				return nil
			}
		case <-deadline:
			return errors.New("no decrypted reply")
		}
	}
}

func uapiListenPort(dev *device.Device) (int, error) {
	var b bytes.Buffer
	if err := dev.IpcGetOperation(&b); err != nil {
		return 0, err
	}
	for _, line := range bytes.Split(b.Bytes(), []byte("\n")) {
		if bytes.HasPrefix(line, []byte("listen_port=")) {
			return strconv.Atoi(string(line[len("listen_port="):]))
		}
	}
	return 0, errors.New("listen_port missing from UAPI")
}

func testWgKey() (privB64, pubB64 string) {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		panic(err)
	}
	priv[0] &= 248
	priv[31] &= 127
	priv[31] |= 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(priv[:]), base64.StdEncoding.EncodeToString(pub)
}

func TestAdmitCapsSource(t *testing.T) {
	// A per-IP cap counts one inner address once. The service-wide cap is
	// what stops a second inner address.
	u := &userspaceWG{gate: limit.New(1, 1, 0, 0)}
	a := ipv4(net.ParseIP("10.0.0.1"))
	b := ipv4(net.ParseIP("10.0.0.2"))
	if !u.admit(a) || !u.admit(a) {
		t.Fatal("the first source should be allowed twice")
	}
	if u.admit(b) {
		t.Fatal("a second source was allowed")
	}
}

func ipv4(ip net.IP) []byte {
	pkt := make([]byte, 20)
	pkt[0] = 0x45
	copy(pkt[12:16], ip.To4())
	return pkt
}

func wgKey(t *testing.T) (privB64, pubB64 string) {
	t.Helper()
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		t.Fatal(err)
	}
	priv[0] &= 248
	priv[31] &= 127
	priv[31] |= 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(priv[:]), base64.StdEncoding.EncodeToString(pub)
}

func itoa(n int) string {
	return fmtInt(n)
}

func fmtInt(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

package realityx

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"net"
	"testing"

	utls "github.com/refraction-networking/utls"
	"github.com/relayx/agent/internal/selfsign"
)

func TestChromeKeyShareLayout(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go func() { _, _ = b.Read(make([]byte, 1)) }()

	uconn := utls.UClient(a, &utls.Config{
		ServerName:         "127.0.0.1",
		NextProtos:         []string{"h2", "http/1.1"},
		InsecureSkipVerify: true,
	}, utls.HelloChrome_Auto)
	if err := uconn.BuildHandshakeState(); err != nil {
		t.Fatal(err)
	}
	hello := uconn.HandshakeState.Hello
	hello.SessionId = make([]byte, 32)
	if err := uconn.BuildHandshakeState(); err != nil {
		t.Fatal(err)
	}
	hello = uconn.HandshakeState.Hello
	t.Logf("raw len %d sidlen %d random %d", len(hello.Raw), hello.Raw[38], len(hello.Random))
	for _, ks := range hello.KeyShares {
		tail := ks.Data
		if len(tail) > 32 {
			tail = tail[len(tail)-32:]
		}
		t.Logf("share group %d len %d tail %x", ks.Group, len(ks.Data), tail)
	}
	keys := uconn.HandshakeState.State13.KeyShareKeys
	if keys == nil {
		t.Fatal("no keys")
	}
	if keys.Ecdhe != nil {
		t.Logf("ecdhe %x", keys.Ecdhe.PublicKey().Bytes())
	} else {
		t.Log("ecdhe nil")
	}
	if keys.MlkemEcdhe != nil {
		t.Logf("mlkem-ecdhe %x", keys.MlkemEcdhe.PublicKey().Bytes())
	} else {
		t.Log("mlkem nil")
	}
	zero := append([]byte(nil), hello.Raw...)
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var sid [8]byte
	if err := sealSessionID(uconn, priv.PublicKey(), sid); err != nil {
		t.Fatal(err)
	}
	if err := uconn.BuildHandshakeState(); err != nil {
		t.Fatal(err)
	}
	sealed := uconn.HandshakeState.Hello.Raw
	if len(sealed) != len(zero) {
		t.Fatalf("len zero %d sealed %d", len(zero), len(sealed))
	}
	restored := append([]byte(nil), sealed...)
	copy(restored[39:71], make([]byte, 32))
	if !bytes.Equal(restored, zero) {
		t.Fatalf("zeroing session id does not restore the AAD")
	}
}

func TestSealSurvivesRemarshal(t *testing.T) {
	pub, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := net.Dial("tcp", "127.0.0.1:1")
	if err != nil {
		// no listener required: BuildHandshakeState does not write
		l, lerr := net.Listen("tcp", "127.0.0.1:0")
		if lerr != nil {
			t.Fatal(lerr)
		}
		defer l.Close()
		go func() {
			c, _ := l.Accept()
			if c != nil {
				c.Close()
			}
		}()
		raw, err = net.Dial("tcp", l.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
	}
	defer raw.Close()
	uconn := utls.UClient(raw, &utls.Config{
		ServerName:         "127.0.0.1",
		NextProtos:         []string{"h2", "http/1.1"},
		InsecureSkipVerify: true,
	}, utls.HelloChrome_Auto)
	var sid [8]byte
	sid[0] = 0x01
	if err := sealSessionID(uconn, pub.PublicKey(), sid); err != nil {
		t.Fatal(err)
	}
	aad := append([]byte(nil), uconn.HandshakeState.Hello.Raw...)
	if err := uconn.BuildHandshakeState(); err != nil {
		t.Fatal(err)
	}
	sent := append([]byte(nil), uconn.HandshakeState.Hello.Raw...)
	if len(sent) != len(aad) || len(sent) < 71 {
		t.Fatalf("len aad %d sent %d", len(aad), len(sent))
	}
	zeroed := append([]byte(nil), sent...)
	for i := 39; i < 71; i++ {
		zeroed[i] = 0
	}
	if !bytes.Equal(zeroed, aad) {
		for i := range aad {
			if aad[i] != zeroed[i] {
				t.Fatalf("first diff at %d: aad %x sent %x", i, aad[i], sent[i])
			}
		}
	}
	priv := x25519Private(uconn)
	shared, err := priv.ECDH(pub.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	authKey, err := hkdf.Key(sha256.New, shared, uconn.HandshakeState.Hello.Random[:20], "REALITY", 32)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(authKey)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := aead.Open(nil, uconn.HandshakeState.Hello.Random[20:], sent[39:71], zeroed)
	if err != nil {
		t.Fatal(err)
	}
	if opened[8] != 0x01 {
		t.Fatalf("short id %x", opened[8:])
	}
}

func TestChromeToGoTLS(t *testing.T) {
	tlsCfg, err := selfsign.Server("localhost", nil)
	if err != nil {
		t.Fatal(err)
	}
	tlsCfg.MinVersion = tls.VersionTLS13
	dest, err := tls.Listen("tcp", "127.0.0.1:0", tlsCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer dest.Close()
	errc := make(chan error, 1)
	go func() {
		c, err := dest.Accept()
		if err != nil {
			errc <- err
			return
		}
		defer c.Close()
		errc <- c.(*tls.Conn).Handshake()
	}()
	raw, err := net.Dial("tcp", dest.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	uconn := utls.UClient(raw, &utls.Config{
		ServerName:         "localhost",
		NextProtos:         []string{"h2", "http/1.1"},
		InsecureSkipVerify: true,
	}, utls.HelloChrome_Auto)
	if err := uconn.Handshake(); err != nil {
		t.Fatalf("client: %v", err)
	}
	if err := <-errc; err != nil {
		t.Fatalf("server: %v", err)
	}
}

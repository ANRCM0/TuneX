package realityx

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/selfsign"
)

func portOf(t *testing.T, addr net.Addr) string {
	t.Helper()
	tcpAddr, ok := addr.(*net.TCPAddr)
	if !ok {
		t.Fatalf("not a TCP address: %v", addr)
	}
	return strconv.Itoa(tcpAddr.Port)
}

func TestDecodeShortID(t *testing.T) {
	zero, err := DecodeShortID("")
	if err != nil || zero != [8]byte{} {
		t.Fatalf("empty short id = %v, %v", zero, err)
	}

	sid, err := DecodeShortID("aabb")
	if err != nil || sid != [8]byte{0xaa, 0xbb, 0, 0, 0, 0, 0, 0} {
		t.Fatalf("short id = %v, %v", sid, err)
	}

	full, err := DecodeShortID("0011223344556677")
	if err != nil || full != [8]byte{0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77} {
		t.Fatalf("full short id = %v, %v", full, err)
	}

	if _, err := DecodeShortID("001122334455667788"); err == nil {
		t.Fatal("nine-byte short id accepted")
	}
	if _, err := DecodeShortID("zz"); err == nil {
		t.Fatal("non-hex short id accepted")
	}
}

func TestDecodeKey(t *testing.T) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}

	for _, encoded := range []string{
		base64.RawURLEncoding.EncodeToString(raw),
		base64.URLEncoding.EncodeToString(raw),
		base64.RawStdEncoding.EncodeToString(raw),
		base64.StdEncoding.EncodeToString(raw),
		"  " + base64.RawURLEncoding.EncodeToString(raw) + "\n",
	} {
		got, err := decodeKey(encoded)
		if err != nil {
			t.Fatalf("decodeKey(%q): %v", encoded, err)
		}
		if string(got) != string(raw) {
			t.Fatalf("decodeKey(%q) round trip mismatch", encoded)
		}
	}

	if _, err := decodeKey(base64.RawURLEncoding.EncodeToString(raw[:16])); err == nil {
		t.Fatal("short key accepted")
	}
	if _, err := decodeKey("not base64!"); err == nil {
		t.Fatal("garbage key accepted")
	}
}

func TestServerConfigDefaults(t *testing.T) {
	curve := ecdh.X25519()
	priv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privB64 := base64.RawURLEncoding.EncodeToString(priv.Bytes())

	cfg, err := serverConfig(ServerConfig{PrivateKey: privB64})
	if err != nil {
		t.Fatalf("serverConfig: %v", err)
	}
	if cfg.Dest != "www.apple.com:443" {
		t.Fatalf("default dest = %q", cfg.Dest)
	}
	if !cfg.SessionTicketsDisabled || cfg.Type != "tcp" {
		t.Fatalf("config = %+v", cfg)
	}
	if !cfg.ServerNames["www.apple.com"] {
		t.Fatalf("server names = %v", cfg.ServerNames)
	}
	if !cfg.ShortIds[[8]byte{}] {
		t.Fatalf("short ids = %v", cfg.ShortIds)
	}

	// A bare host gets :443; an IP dest also accepts an empty SNI.
	cfg, err = serverConfig(ServerConfig{PrivateKey: privB64, Dest: "127.0.0.1", ShortID: "aa"})
	if err != nil {
		t.Fatalf("serverConfig: %v", err)
	}
	if cfg.Dest != "127.0.0.1:443" || !cfg.ServerNames["127.0.0.1"] || !cfg.ServerNames[""] {
		t.Fatalf("ip dest config = %+v", cfg)
	}

	if _, err := serverConfig(ServerConfig{PrivateKey: "short"}); err == nil {
		t.Fatal("bad private key accepted")
	}
	if _, err := serverConfig(ServerConfig{PrivateKey: privB64, ShortID: "zz"}); err == nil {
		t.Fatal("bad short id accepted")
	}
}

// TestListenDialEcho performs a real REALITY handshake against a local TLS 1.3
// destination: the listener dials dest to mimic its certificate, the client
// seals the session id with the matching key, and the stream carries data both
// ways.
func TestListenDialEcho(t *testing.T) {
	curve := ecdh.X25519()
	priv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.PublicKey()

	// TLS 1.3 destination the listener mimics.
	destTLS, err := selfsign.Server("localhost", []string{"h2", "http/1.1"})
	if err != nil {
		t.Fatalf("dest tls: %v", err)
	}
	destLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer destLn.Close()
	go func() {
		for {
			conn, err := destLn.Accept()
			if err != nil {
				return
			}
			go func() {
				tlsConn := tls.Server(conn, destTLS)
				_ = tlsConn.Handshake()
				// Keep the destination session open: closing it immediately
				// makes the listener retry its certificate probe.
				_, _ = io.Copy(io.Discard, tlsConn)
				_ = tlsConn.Close()
			}()
		}
	}()

	ln, err := Listen("127.0.0.1:0", ServerConfig{
		PrivateKey: base64.RawURLEncoding.EncodeToString(priv.Bytes()),
		Dest:       "localhost:" + portOf(t, destLn.Addr()),
		ShortID:    "aabbccdd",
	})
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	client, err := Dial(ln.Addr().String(), ClientConfig{
		PublicKey:  base64.RawURLEncoding.EncodeToString(pub.Bytes()),
		ShortID:    "aabbccdd",
		ServerName: "localhost",
	})
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer client.Close()

	payload := []byte("reality-echo")
	if _, err := client.Write(payload); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, len(payload))
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if strings.TrimSpace(string(buf)) != string(payload) {
		t.Fatalf("echo = %q", buf)
	}
}

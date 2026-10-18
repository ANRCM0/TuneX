package service

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"io"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/gostcfg"
	"github.com/relayx/agent/internal/realityx"
	"github.com/relayx/agent/internal/selfsign"
	"github.com/relayx/agent/internal/vless"
)

func TestApplyVLESSReality(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	tlsCfg, err := selfsign.Server("127.0.0.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	tlsCfg.MinVersion = tls.VersionTLS13
	dest, err := tls.Listen("tcp", "127.0.0.1:0", tlsCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer dest.Close()
	go func() {
		for {
			c, err := dest.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				if tc, ok := c.(*tls.Conn); ok {
					_ = tc.Handshake()
				}
				_, _ = io.Copy(io.Discard, c)
			}(c)
		}
	}()

	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privB64 := base64.RawURLEncoding.EncodeToString(priv.Bytes())
	pubB64 := base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes())
	const uuid = "11111111-1111-1111-1111-111111111111"
	const shortID = "01234567"

	body := `{
		"services": [{
			"name": "tcp-vless",
			"addr": "127.0.0.1:19311",
			"observer": "observer",
			"metadata": {"enableStats": true, "observer.resetTraffic": true},
			"handler": {"type": "vless", "metadata": {"users": {"user": "` + uuid + `"}}},
			"listener": {"type": "reality", "metadata": {
				"privateKey": "` + privB64 + `",
				"dest": "` + dest.Addr().String() + `",
				"shortId": "` + shortID + `"
			}}
		}]
	}`
	cfg, err := gostcfg.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 1 || !results[0].OK() {
		t.Fatalf("apply: %+v", results)
	}

	id, err := vless.ParseUUID(uuid)
	if err != nil {
		t.Fatal(err)
	}
	c, err := realityx.Dial("127.0.0.1:19311", realityx.ClientConfig{
		PublicKey:  pubB64,
		ShortID:    shortID,
		ServerName: "127.0.0.1",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := vless.Write(c, id, echo.Addr().String()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("via-vless")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-vless" {
		t.Fatalf("got %q", buf[:n])
	}
	c.Close()
	deadline := time.Now().Add(3 * time.Second)
	var in uint64
	for time.Now().Before(deadline) {
		events := m.ObserveEvents()
		if len(events) == 1 && events[0].Service == "tcp-vless" && events[0].Stats != nil && events[0].Stats.InputBytes > 0 {
			in = events[0].Stats.InputBytes
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if in == 0 {
		t.Fatal("vless observer reported no input bytes")
	}
}

package openvpn

import (
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/selfsign"
)

func TestUDPHandshake(t *testing.T) {
	var raw [256]byte
	for i := range raw {
		raw[i] = byte(i + 3)
	}
	serverKey, err := NewTLSCrypt(raw[:], false)
	if err != nil {
		t.Fatal(err)
	}
	clientKey, err := NewTLSCrypt(raw[:], true)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := ListenUDP("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg, err := selfsign.Server("relayx", nil)
	if err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			errc <- err
			return
		}
		defer c.Close()
		_, _, err = Serve(c, serverKey, cfg, 7, "10.8.0.0/24", "", 0)
		errc <- err
	}()

	conn, err := DialUDP(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, keys, peer, err := Dial(conn, clientKey, &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         "relayx",
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if peer != 7 {
		t.Fatalf("peer-id = %d", peer)
	}
	if len(keys.SendCipher) != 32 {
		t.Fatalf("send cipher is %d bytes", len(keys.SendCipher))
	}
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

func TestPushReplyMTU(t *testing.T) {
	got := string(pushReply(1, "10.8.0.0/24", "AES-256-GCM", 1400))
	if !strings.Contains(got, "tun-mtu 1400") || !strings.Contains(got, "cipher AES-256-GCM") {
		t.Fatalf("reply %q", got)
	}
	plain := string(pushReply(1, "10.8.0.0/24", "", 0))
	if strings.Contains(plain, "tun-mtu") {
		t.Fatalf("zero mtu was pushed: %q", plain)
	}
}

func TestAES128Handshake(t *testing.T) {
	if _, name, err := CipherKeyLen("aes-128-gcm"); err != nil || name != "AES-128-GCM" {
		t.Fatalf("name %s err %v", name, err)
	}
	if _, _, err := CipherKeyLen("CHACHA20-POLY1305"); err == nil {
		t.Fatal("unknown cipher was accepted")
	}
	var raw [256]byte
	for i := range raw {
		raw[i] = byte(i + 9)
	}
	serverKey, err := NewTLSCrypt(raw[:], false)
	if err != nil {
		t.Fatal(err)
	}
	clientKey, err := NewTLSCrypt(raw[:], true)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	cfg, err := selfsign.Server("relayx", nil)
	if err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			errc <- err
			return
		}
		defer c.Close()
		stream, keys, err := Serve(c, serverKey, cfg, 3, "10.9.0.0/24", "AES-128-GCM", 0)
		if err != nil {
			errc <- err
			return
		}
		if len(keys.SendCipher) != 16 {
			errc <- fmt.Errorf("server key %d", len(keys.SendCipher))
			return
		}
		ch, err := NewDataChannel(keys, 3, 0)
		if err != nil {
			errc <- err
			return
		}
		select {
		case pkt := <-stream.Data():
			plain, err := ch.Open(pkt)
			if err != nil || string(plain) != "aes128" {
				errc <- fmt.Errorf("plain %q %v", plain, err)
				return
			}
		case <-time.After(3 * time.Second):
			errc <- fmt.Errorf("no data packet")
			return
		}
		errc <- nil
	}()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, keys, peer, err := Dial(conn, clientKey, &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         "relayx",
	}, "AES-128-GCM")
	if err != nil {
		t.Fatal(err)
	}
	if peer != 3 || len(keys.SendCipher) != 16 {
		t.Fatalf("peer %d key %d", peer, len(keys.SendCipher))
	}
	ch, err := NewDataChannel(keys, peer, 0)
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := ch.Seal([]byte("aes128"))
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteTCP(conn, pkt); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errc:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not finish")
	}
}

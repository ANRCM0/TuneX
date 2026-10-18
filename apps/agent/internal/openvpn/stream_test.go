package openvpn

import (
	"bytes"
	"crypto/tls"
	"io"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/selfsign"
)

func TestStandaloneAck(t *testing.T) {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(i + 9)
	}
	clientKey, err := NewTLSCrypt(key, true)
	if err != nil {
		t.Fatal(err)
	}
	serverKey, err := NewTLSCrypt(key, false)
	if err != nil {
		t.Fatal(err)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	clientSess, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	serverSess, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	go func() {
		s := NewStream(b, serverKey, serverSess, clientSess, 1)
		<-stop
		s.Close()
	}()
	defer close(stop)
	if err := WriteControl(a, clientKey, Control{
		Opcode: opControlV1, LocalSession: clientSess, MessageID: 1, Payload: []byte("need-ack"),
	}, 1, uint32(time.Now().Unix())); err != nil {
		t.Fatal(err)
	}
	_ = a.SetReadDeadline(time.Now().Add(2 * time.Second))
	raw, err := ReadTCP(a)
	if err != nil {
		t.Fatal(err)
	}
	ack, _, _, err := OpenControl(clientKey, raw)
	if err != nil {
		t.Fatal(err)
	}
	if ack.Opcode != opAckV1 || len(ack.AckIDs) != 1 || ack.AckIDs[0] != 1 || ack.AckSession != clientSess {
		t.Fatalf("ack %+v", ack)
	}
}

func TestTLSOverControl(t *testing.T) {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(i * 3)
	}
	clientKey, err := NewTLSCrypt(key, true)
	if err != nil {
		t.Fatal(err)
	}
	serverKey, err := NewTLSCrypt(key, false)
	if err != nil {
		t.Fatal(err)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	errc := make(chan error, 1)
	var serverSess SessionID
	go func() {
		_, sid, err := AcceptHardReset(b, serverKey)
		serverSess = sid
		errc <- err
	}()

	local, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteControl(a, clientKey, Control{
		Opcode: opHardResetClientV2, LocalSession: local,
	}, 1, uint32(time.Now().Unix())); err != nil {
		t.Fatal(err)
	}
	raw, err := ReadTCP(a)
	if err != nil {
		t.Fatal(err)
	}
	reply, _, _, err := OpenControl(clientKey, raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-errc; err != nil {
		t.Fatal(err)
	}

	cli := NewStream(a, clientKey, local, reply.LocalSession, 1)
	srv := NewStream(b, serverKey, serverSess, local, 1)

	cfg, err := selfsign.Server("relayx", nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		sc := tls.Server(srv, cfg)
		if err := sc.Handshake(); err != nil {
			done <- err
			return
		}
		buf := make([]byte, 4)
		if _, err := io.ReadFull(sc, buf); err != nil {
			done <- err
			return
		}
		_, err := sc.Write([]byte("pong"))
		done <- err
	}()

	cc := tls.Client(cli, &tls.Config{InsecureSkipVerify: true, ServerName: "relayx"})
	if err := cc.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := cc.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(cc, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "pong" {
		t.Fatalf("got %q", buf)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestKeyMethodOnControl(t *testing.T) {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(i*5 + 1)
	}
	clientKey, err := NewTLSCrypt(key, true)
	if err != nil {
		t.Fatal(err)
	}
	serverKey, err := NewTLSCrypt(key, false)
	if err != nil {
		t.Fatal(err)
	}
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	errc := make(chan error, 1)
	var serverSess SessionID
	go func() {
		_, sid, err := AcceptHardReset(b, serverKey)
		serverSess = sid
		errc <- err
	}()
	local, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteControl(a, clientKey, Control{
		Opcode: opHardResetClientV2, LocalSession: local,
	}, 1, uint32(time.Now().Unix())); err != nil {
		t.Fatal(err)
	}
	raw, err := ReadTCP(a)
	if err != nil {
		t.Fatal(err)
	}
	reply, _, _, err := OpenControl(clientKey, raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-errc; err != nil {
		t.Fatal(err)
	}

	cli := NewStream(a, clientKey, local, reply.LocalSession, 1)
	srv := NewStream(b, serverKey, serverSess, local, 1)
	cfg, err := selfsign.Server("relayx", nil)
	if err != nil {
		t.Fatal(err)
	}
	type derived struct {
		keys DataKeys
		err  error
	}
	ready := make(chan derived, 1)
	go func() {
		sc := tls.Server(srv, cfg)
		if err := sc.Handshake(); err != nil {
			ready <- derived{err: err}
			return
		}
		buf := make([]byte, 2048)
		n, err := sc.Read(buf)
		if err != nil {
			ready <- derived{err: err}
			return
		}
		clientSrc, _, err := ParseClient(buf[:n])
		if err != nil {
			ready <- derived{err: err}
			return
		}
		serverSrc, err := NewKeySource(false)
		if err != nil {
			ready <- derived{err: err}
			return
		}
		if _, err := sc.Write(MarshalServer(serverSrc, "cipher AES-256-GCM", "", "", "")); err != nil {
			ready <- derived{err: err}
			return
		}
		keys, err := DeriveKeys(clientSrc, serverSrc, local, serverSess, 32, false)
		ready <- derived{keys: keys, err: err}
	}()

	cc := tls.Client(cli, &tls.Config{InsecureSkipVerify: true, ServerName: "relayx"})
	if err := cc.Handshake(); err != nil {
		t.Fatal(err)
	}
	clientSrc, err := NewKeySource(true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cc.Write(MarshalClient(clientSrc, "cipher AES-256-GCM", "", "", "")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2048)
	n, err := cc.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	serverSrc, _, err := ParseServer(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	clientKeys, err := DeriveKeys(clientSrc, serverSrc, local, serverSess, 32, true)
	if err != nil {
		t.Fatal(err)
	}
	got := <-ready
	if got.err != nil {
		t.Fatal(got.err)
	}
	if !bytes.Equal(clientKeys.SendCipher, got.keys.RecvCipher) {
		t.Fatal("live control channel did not agree on the data key")
	}
	aCh, err := NewDataChannel(clientKeys, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	bCh, err := NewDataChannel(got.keys, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := aCh.Seal([]byte("on-tcp"))
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteTCP(a, pkt); err != nil {
		t.Fatal(err)
	}
	select {
	case gotPkt := <-srv.Data():
		plain, err := bCh.Open(gotPkt)
		if err != nil || string(plain) != "on-tcp" {
			t.Fatalf("plain %q %v", plain, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("data packet was not demuxed off the control connection")
	}
}

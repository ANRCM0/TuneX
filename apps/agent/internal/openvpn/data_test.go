package openvpn

import (
	"bytes"
	"testing"
)

func TestDataChannelAEAD(t *testing.T) {
	send := bytes.Repeat([]byte{1}, 32)
	recv := bytes.Repeat([]byte{2}, 32)
	sendIV := bytes.Repeat([]byte{3}, 8)
	recvIV := bytes.Repeat([]byte{4}, 8)
	a, err := NewDataChannel(DataKeys{
		SendCipher: send, RecvCipher: recv, SendHMAC: sendIV, RecvHMAC: recvIV,
	}, 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDataChannel(DataKeys{
		SendCipher: recv, RecvCipher: send, SendHMAC: recvIV, RecvHMAC: sendIV,
	}, 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := a.Seal([]byte("ping-data"))
	if err != nil {
		t.Fatal(err)
	}
	if op, _ := parseOpcodeKeyID(pkt[0]); op != opDataV2 {
		t.Fatalf("opcode %d", op)
	}
	var buf bytes.Buffer
	if err := WriteTCP(&buf, pkt); err != nil {
		t.Fatal(err)
	}
	got, err := ReadTCP(&buf)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := b.Open(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != "ping-data" {
		t.Fatalf("plain %q", plain)
	}
	if _, err := b.Open(got); err == nil {
		t.Fatal("replayed data packet was accepted")
	}
	back, err := b.Seal([]byte("pong-data"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err = a.Open(back)
	if err != nil || string(plain) != "pong-data" {
		t.Fatalf("back %q %v", plain, err)
	}
}

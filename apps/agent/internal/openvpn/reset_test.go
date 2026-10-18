package openvpn

import (
	"net"
	"testing"
	"time"
)

func TestHardResetExchange(t *testing.T) {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(255 - i)
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
	var got Control
	var sid SessionID
	go func() {
		var err error
		got, sid, err = AcceptHardReset(b, serverKey)
		errc <- err
	}()

	local, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	pkt := Control{
		Opcode:       opHardResetClientV2,
		LocalSession: local,
		MessageID:    0,
	}
	if err := WriteControl(a, clientKey, pkt, 1, uint32(time.Now().Unix())); err != nil {
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
	if got.LocalSession != local || reply.Opcode != opHardResetServerV2 {
		t.Fatalf("client session or opcode mismatch")
	}
	if reply.LocalSession != sid || len(reply.AckIDs) != 1 || reply.AckIDs[0] != 0 || reply.AckSession != local {
		t.Fatalf("reply %+v sid %x", reply, sid)
	}
}

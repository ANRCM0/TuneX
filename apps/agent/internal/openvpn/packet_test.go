package openvpn

import (
	"bytes"
	"testing"
)

func TestControlSealOverTCP(t *testing.T) {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(i)
	}
	client, err := NewTLSCrypt(key, true)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewTLSCrypt(key, false)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	var remote SessionID
	remote[0] = 9
	pkt := Control{
		Opcode:       opHardResetClientV2,
		KeyID:        0,
		LocalSession: sid,
		AckIDs:       []uint32{3},
		AckSession:   remote,
		MessageID:    1,
		Payload:      []byte{0x16, 0x03, 0x01},
	}
	raw, err := pkt.Seal(client, 7, 1714567890)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := WriteTCP(&buf, raw); err != nil {
		t.Fatal(err)
	}
	got, err := ReadTCP(&buf)
	if err != nil {
		t.Fatal(err)
	}
	ctrl, id, ts, err := OpenControl(server, got)
	if err != nil {
		t.Fatal(err)
	}
	if ctrl.Opcode != opHardResetClientV2 || ctrl.MessageID != 1 || id != 7 || ts != 1714567890 {
		t.Fatalf("opcode %d msg %d id %d ts %d", ctrl.Opcode, ctrl.MessageID, id, ts)
	}
	if ctrl.LocalSession != sid || len(ctrl.AckIDs) != 1 || ctrl.AckIDs[0] != 3 || ctrl.AckSession != remote {
		t.Fatalf("session/ack mismatch: %+v", ctrl)
	}
	if !bytes.Equal(ctrl.Payload, pkt.Payload) {
		t.Fatalf("payload %x", ctrl.Payload)
	}
}

package openvpn

import (
	"bytes"
	"strings"
	"testing"
)

func testKey() []byte {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(i)
	}
	return key
}

func TestTLSCryptRoundTrip(t *testing.T) {
	client, err := NewTLSCrypt(testKey(), true)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewTLSCrypt(testKey(), false)
	if err != nil {
		t.Fatal(err)
	}
	header := []byte{0x38, 1, 2, 3, 4, 5, 6, 7, 8}
	plain := []byte("client hello over openvpn control channel")
	packet, err := client.Wrap(header, 7, 1714567890, plain)
	if err != nil {
		t.Fatal(err)
	}
	if len(packet) != 9+8+32+len(plain) {
		t.Fatalf("len %d", len(packet))
	}
	gotHeader, id, ts, got, err := server.Unwrap(packet)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotHeader, header) || id != 7 || ts != 1714567890 || !bytes.Equal(got, plain) {
		t.Fatalf("header %x id %d ts %d plain %q", gotHeader, id, ts, got)
	}

	reply, err := server.Wrap([]byte{0x40, 8, 7, 6, 5, 4, 3, 2, 1}, 9, 1714567900, []byte("server hello"))
	if err != nil {
		t.Fatal(err)
	}
	_, id, ts, got, err = client.Unwrap(reply)
	if err != nil || id != 9 || ts != 1714567900 || string(got) != "server hello" {
		t.Fatalf("reply id %d ts %d plain %q err %v", id, ts, got, err)
	}

	packet[len(packet)-1] ^= 0xff
	if _, _, _, _, err = server.Unwrap(packet); err == nil {
		t.Fatal("tampered packet was accepted")
	}
}

func TestParseStaticKey(t *testing.T) {
	var b strings.Builder
	b.WriteString("-----BEGIN OpenVPN Static key V1-----\n")
	for i := 0; i < 16; i++ {
		b.WriteString(strings.Repeat("ab", 16))
		b.WriteByte('\n')
	}
	b.WriteString("-----END OpenVPN Static key V1-----\n")
	raw, err := ParseStaticKey(b.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 256 || raw[0] != 0xab || raw[255] != 0xab {
		t.Fatalf("len %d first %x", len(raw), raw[0])
	}
	if _, err := NewTLSCrypt(raw, false); err != nil {
		t.Fatal(err)
	}
}

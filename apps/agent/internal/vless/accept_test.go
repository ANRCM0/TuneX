package vless

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"testing"
	"time"
)

func uuidBytes() [16]byte {
	var id [16]byte
	for i := range id {
		id[i] = byte(i + 1)
	}
	return id
}

func writeAddr(buf *bytes.Buffer, host string, port uint16) {
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], port)
	buf.Write(p[:])
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			buf.WriteByte(1)
			buf.Write(v4)
			return
		}
		buf.WriteByte(3)
		buf.Write(ip.To16())
		return
	}
	buf.WriteByte(2)
	buf.WriteByte(byte(len(host)))
	buf.WriteString(host)
}

func requestBytes(id [16]byte, cmd byte, addon []byte, host string, port uint16) []byte {
	buf := &bytes.Buffer{}
	buf.WriteByte(0)
	buf.Write(id[:])
	buf.WriteByte(byte(len(addon)))
	buf.Write(addon)
	buf.WriteByte(cmd)
	writeAddr(buf, host, port)
	return buf.Bytes()
}

func TestParseUUID(t *testing.T) {
	canonical := "01020304-0506-0708-090a-0b0c0d0e0f10"
	id, err := ParseUUID(canonical)
	if err != nil || id != uuidBytes() {
		t.Fatalf("ParseUUID = %v, %v", id, err)
	}
	plain, err := ParseUUID("0102030405060708090a0b0c0d0e0f10")
	if err != nil || plain != id {
		t.Fatalf("hex uuid = %v, %v", plain, err)
	}
	if _, err := ParseUUID("0102"); err == nil {
		t.Fatal("short uuid accepted")
	}
	if _, err := ParseUUID("zzzz"); err == nil {
		t.Fatal("non-hex uuid accepted")
	}
}

func TestParseUsers(t *testing.T) {
	users, err := ParseUsers(map[string]any{"alice": "01020304-0506-0708-090a-0b0c0d0e0f10"})
	if err != nil || len(users) != 1 {
		t.Fatalf("ParseUsers = %v, %v", users, err)
	}
	if _, ok := users[uuidBytes()]; !ok {
		t.Fatal("uuid missing from the user set")
	}

	if _, err := ParseUsers(nil); err == nil {
		t.Fatal("nil users accepted")
	}
	if _, err := ParseUsers(map[string]any{}); err == nil {
		t.Fatal("empty users accepted")
	}
	if _, err := ParseUsers(map[string]any{"bob": "nope"}); err == nil {
		t.Fatal("invalid uuid accepted")
	}
}

func acceptOverPipe(t *testing.T, payload []byte, users map[[16]byte]struct{}) (target string, plain net.Conn, udp bool, err error) {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close() })
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))
	_ = server.SetDeadline(time.Now().Add(2 * time.Second))
	go func() {
		_, _ = client.Write(payload)
		// Drain the two-byte success response when Accept writes one.
		buf := make([]byte, 2)
		if _, err := io.ReadFull(client, buf); err == nil && (buf[0] != 0 || buf[1] != 0) {
			t.Errorf("response = %v", buf)
		}
	}()
	return Accept(server, users)
}

func TestAcceptTCP(t *testing.T) {
	users := map[[16]byte]struct{}{uuidBytes(): {}}
	target, plain, udp, err := acceptOverPipe(t, requestBytes(uuidBytes(), 1, nil, "1.2.3.4", 80), users)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if target != "1.2.3.4:80" || udp {
		t.Fatalf("target = %q udp=%v", target, udp)
	}
	if plain == nil {
		t.Fatal("nil conn")
	}
	_ = plain.Close()
}

func TestAcceptDomainAndUDP(t *testing.T) {
	users := map[[16]byte]struct{}{uuidBytes(): {}}

	target, _, udp, err := acceptOverPipe(t, requestBytes(uuidBytes(), 2, nil, "example.test", 53), users)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if target != "example.test:53" || !udp {
		t.Fatalf("target = %q udp=%v", target, udp)
	}
}

func TestAcceptVisionWrapsConn(t *testing.T) {
	users := map[[16]byte]struct{}{uuidBytes(): {}}
	target, plain, udp, err := acceptOverPipe(
		t,
		requestBytes(uuidBytes(), 1, visionAddon(), "1.2.3.4", 443),
		users,
	)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if target != "1.2.3.4:443" || udp {
		t.Fatalf("target = %q udp=%v", target, udp)
	}
	if _, ok := plain.(*visionConn); !ok {
		t.Fatalf("conn type = %T, want *visionConn", plain)
	}
	_ = plain.Close()
}

func TestAcceptRejections(t *testing.T) {
	users := map[[16]byte]struct{}{uuidBytes(): {}}

	badVersion := requestBytes(uuidBytes(), 1, nil, "1.2.3.4", 80)
	badVersion[0] = 1
	if _, _, _, err := acceptOverPipe(t, badVersion, users); err == nil {
		t.Fatal("bad version accepted")
	}

	unknown := requestBytes([16]byte{0xff}, 1, nil, "1.2.3.4", 80)
	if _, _, _, err := acceptOverPipe(t, unknown, users); err == nil {
		t.Fatal("unknown user accepted")
	}

	badCmd := requestBytes(uuidBytes(), 9, nil, "1.2.3.4", 80)
	if _, _, _, err := acceptOverPipe(t, badCmd, users); err == nil {
		t.Fatal("bad command accepted")
	}

	if _, _, _, err := acceptOverPipe(t, []byte{0, 1, 2}, users); err == nil {
		t.Fatal("truncated request accepted")
	}
}

func TestWriteHeader(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))

	writeErr := make(chan error, 1)
	go func() { writeErr <- Write(server, uuidBytes(), "example.test:443") }()

	// Read the header back off the wire (from the peer) and compare it with the
	// request layout.
	head := make([]byte, 18)
	if _, err := io.ReadFull(client, head); err != nil {
		t.Fatalf("header: %v", err)
	}
	if head[0] != 0 || head[17] != 0 {
		t.Fatalf("version/addon = %d/%d", head[0], head[17])
	}
	id := uuidBytes()
	if !bytes.Equal(head[1:17], id[:]) {
		t.Fatalf("uuid = %x", head[1:17])
	}
	cmd := make([]byte, 1)
	if _, err := io.ReadFull(client, cmd); err != nil || cmd[0] != 1 {
		t.Fatalf("cmd = %v, %v", cmd, err)
	}
	addr := make([]byte, 2+1+1+12)
	if _, err := io.ReadFull(client, addr); err != nil {
		t.Fatalf("addr: %v", err)
	}
	if binary.BigEndian.Uint16(addr[:2]) != 443 || addr[2] != 2 || addr[3] != 12 {
		t.Fatalf("addr = %v", addr)
	}
	if string(addr[4:]) != "example.test" {
		t.Fatalf("host = %q", addr[4:])
	}
	// Write also waits for the server's two-byte "accepted" response.
	if _, err := client.Write([]byte{0, 0}); err != nil {
		t.Fatalf("response: %v", err)
	}
	if err := <-writeErr; err != nil {
		t.Fatalf("Write: %v", err)
	}
}

func TestPacketFraming(t *testing.T) {
	var buf bytes.Buffer
	if err := writePacket(&buf, []byte("datagram")); err != nil {
		t.Fatalf("writePacket: %v", err)
	}
	if got := binary.BigEndian.Uint16(buf.Bytes()[:2]); got != uint16(len("datagram")) {
		t.Fatalf("length = %d", got)
	}
	payload, err := readPacket(&buf)
	if err != nil || string(payload) != "datagram" {
		t.Fatalf("readPacket = %q, %v", payload, err)
	}

	if _, err := readPacket(bytes.NewReader([]byte{0})); err == nil {
		t.Fatal("truncated length accepted")
	}
	if _, err := readPacket(bytes.NewReader([]byte{0, 5, 'a'})); err == nil {
		t.Fatal("truncated payload accepted")
	}
}

func TestReadAddrErrors(t *testing.T) {
	bad := []byte{0, 80, 9, 0, 0}
	if _, err := readAddr(bytes.NewReader(bad)); err == nil {
		t.Fatal("unknown atyp accepted")
	}
	if _, err := readAddr(bytes.NewReader([]byte{0})); err == nil {
		t.Fatal("truncated port accepted")
	}
}

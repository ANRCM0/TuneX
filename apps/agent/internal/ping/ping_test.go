package ping

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestBuildEcho(t *testing.T) {
	payload := []byte("relayx-ping")
	pkt := buildEcho(0x1234, payload)

	if len(pkt) != 8+len(payload) {
		t.Fatalf("packet length = %d", len(pkt))
	}
	if pkt[0] != 8 || pkt[1] != 0 {
		t.Fatalf("type/code = %d/%d, want echo request", pkt[0], pkt[1])
	}
	if got := binary16(pkt[4:6]); got != 0x1234 {
		t.Fatalf("id = %#x", got)
	}
	// The replica stores the payload length in the sequence field, matching the
	// recovered upstream packet layout.
	if got := binary16(pkt[6:8]); got != uint16(len(payload)) {
		t.Fatalf("sequence = %d, want payload length %d", got, len(payload))
	}
	if string(pkt[8:]) != string(payload) {
		t.Fatalf("payload = %q", pkt[8:])
	}

	// Re-running checksum over the packet (which already contains the field)
	// yields 0 because the ones-complement sum reaches 0xFFFF.
	if sum := checksum(pkt); sum != 0 {
		t.Fatalf("checksum over the packet = %#x, want 0", sum)
	}
}

func binary16(b []byte) uint16 {
	return uint16(b[0])<<8 | uint16(b[1])
}

func TestChecksumOddLength(t *testing.T) {
	// Odd-length input must still fold the final byte.
	if got := checksum([]byte{0x00, 0x01, 0x02}); got != 0xFDFE {
		t.Fatalf("checksum = %#x", got)
	}
}

func TestIsPermission(t *testing.T) {
	if !isPermission(ErrPermission) || !isPermission(os.ErrPermission) {
		t.Fatal("permission sentinels not recognised")
	}
	if isPermission(errors.New("boom")) {
		t.Fatal("unrelated error treated as permission")
	}
}

func TestPingLoopback(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := Ping(ctx, "127.0.0.1", 3*time.Second)
	if err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if res.Method != "icmp" && res.Method != "tcp" {
		t.Fatalf("method = %q", res.Method)
	}
	if res.Milliseconds < 0 {
		t.Fatalf("milliseconds = %v", res.Milliseconds)
	}
}

func TestPingResolveFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := Ping(ctx, "no-such-host.invalid", time.Second); err == nil {
		t.Fatal("ping of a nonexistent host succeeded")
	}
}

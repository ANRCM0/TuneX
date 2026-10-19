package shadowsocks

import (
	"bytes"
	"encoding/hex"
	"io"
	"strings"
	"testing"
)

func TestSupportedMethods(t *testing.T) {
	for _, name := range []string{"chacha20-ietf-poly1305", "aes-128-gcm", "aes-256-gcm", "none"} {
		if !Supported(name) {
			t.Fatalf("%q should be supported", name)
		}
	}
	for _, name := range []string{"", "rc4-md5", "aes-192-gcm"} {
		if Supported(name) {
			t.Fatalf("%q should not be supported", name)
		}
	}
}

func TestMasterKeyVectors(t *testing.T) {
	// EVP_BytesToKey(MD5, no salt) over "secret", cross-checked with OpenSSL.
	if got := hex.EncodeToString(MasterKey("secret", 16)); got != "5ebe2294ecd0e0f08eab7690d2a6ee69" {
		t.Fatalf("master16 = %s", got)
	}
	if got := hex.EncodeToString(MasterKey("secret", 32)); got != "5ebe2294ecd0e0f08eab7690d2a6ee6926ae5cc854e36b6bdfca366848dea6bb" {
		t.Fatalf("master32 = %s", got)
	}
}

func TestSubKeyVectors(t *testing.T) {
	master := MasterKey("secret", 32)
	sub, err := SubKey(master, []byte("0123456789abcdef"), 32)
	if err != nil {
		t.Fatalf("SubKey: %v", err)
	}
	if got := hex.EncodeToString(sub); got != "825b438f2eeee00579370352d3725da970ea4fcc06e51132fc9f6bc5ecd1ca0b" {
		t.Fatalf("subkey32 = %s", got)
	}
	short, err := SubKey(master, []byte("0123456789abcdef"), 16)
	if err != nil {
		t.Fatalf("SubKey: %v", err)
	}
	if got := hex.EncodeToString(short); got != "825b438f2eeee00579370352d3725da9" {
		t.Fatalf("subkey16 = %s", got)
	}

	other, _ := SubKey(master, []byte("ffffffffffffffff"), 32)
	if bytes.Equal(sub, other) {
		t.Fatal("different salts produced the same subkey")
	}
}

func TestNewRejectsUnknownMethod(t *testing.T) {
	if _, err := New("rc4-md5", "secret"); err == nil {
		t.Fatal("unknown method accepted by New")
	}
	if srv, err := New("none", "secret"); err != nil || srv == nil {
		t.Fatalf("none: %v", err)
	}
	if _, err := New("none", ""); err == nil {
		t.Fatal("empty password accepted")
	}
}

func TestChunkRoundTrip(t *testing.T) {
	for _, method := range []string{"aes-256-gcm", "chacha20-ietf-poly1305", "none"} {
		t.Run(method, func(t *testing.T) {
			var wire bytes.Buffer
			writer, err := NewWriter(&wire, method, "secret")
			if err != nil {
				t.Fatalf("NewWriter: %v", err)
			}
			payload := strings.Repeat("abcdefgh", 200) // two chunks
			if _, err := writer.Write([]byte(payload)); err != nil {
				t.Fatalf("Write: %v", err)
			}
			if err := writer.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}

			reader, err := NewReader(bytes.NewReader(wire.Bytes()), method, "secret")
			if err != nil {
				t.Fatalf("NewReader: %v", err)
			}
			got, err := io.ReadAll(reader)
			if err != nil {
				t.Fatalf("ReadAll: %v", err)
			}
			if string(got) != payload {
				t.Fatalf("round trip mismatch: %d bytes vs %d", len(got), len(payload))
			}
		})
	}
}

func TestChunkReaderRejectsTampering(t *testing.T) {
	var wire bytes.Buffer
	writer, err := NewWriter(&wire, "aes-256-gcm", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	raw := wire.Bytes()
	raw[len(raw)-1] ^= 0x01 // flip a ciphertext bit

	reader, err := NewReader(bytes.NewReader(raw), "aes-256-gcm", "secret")
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	if _, err := io.ReadAll(reader); err == nil {
		t.Fatal("tampered chunk accepted")
	}
}

func TestNewReaderErrors(t *testing.T) {
	if _, err := NewReader(bytes.NewReader(nil), "rc4-md5", "x"); err == nil {
		t.Fatal("unknown method accepted")
	}
	if _, err := NewReader(bytes.NewReader(nil), "aes-256-gcm", "x"); err == nil {
		t.Fatal("missing salt accepted")
	}
}

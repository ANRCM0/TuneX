package fernet

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/config"
)

// Vectors produced by the panel's own `fernet@0.3.3` package
// (apps/backend, the same one `services/fernet.ts` uses) under this key:
//
//	octets 0x00..0x1f, base64url = AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=
//
// The plaintext for panelToken is the JSON document below; expiredToken wraps
// the string "expired" and was sealed one hour before the vectors were taken.
const (
	panelKey     = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
	panelToken   = "gAAAAABq1Z2Nez8anFn_kjWSxsg1Z4D2CMvH7MIVWL-svTi_HE4kFOHz6maZjNTqoOEty9XOSZnxcWbnIMtbTmJiI1eURRxNm-7V2kb87np-uwiTRC_tuY4="
	expiredToken = "gAAAAABq1Y98v9rDYghRsuj5P7eQ6ebZAn-rJim2H6bjszoqh1shsXDcpvgrFu2zFopo39P3jyBKzERfmr00UazYgstwvm7Ubw=="
	panelJSON    = `{"hello":"世界","n":1}`
)

func mustKey(t *testing.T) []byte {
	t.Helper()
	key, err := DecodeKey(panelKey)
	if err != nil {
		t.Fatalf("DecodeKey: %v", err)
	}
	return key
}

func TestDecodeKey(t *testing.T) {
	key, err := DecodeKey(panelKey)
	if err != nil {
		t.Fatalf("DecodeKey: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("key length = %d, want 32", len(key))
	}

	unpadded := strings.TrimRight(panelKey, "=")
	if got, err := DecodeKey(unpadded); err != nil || !bytes.Equal(got, key) {
		t.Fatalf("unpadded key: %v, equal=%v", err, bytes.Equal(got, key))
	}
	if got, err := DecodeKey("  " + panelKey + "\n"); err != nil || !bytes.Equal(got, key) {
		t.Fatalf("surrounding whitespace: %v", err)
	}

	// Standard (non URL-safe) base64 is tolerated.
	std := strings.NewReplacer("-", "+", "_", "/").Replace(panelKey)
	if got, err := DecodeKey(std); err != nil || !bytes.Equal(got, key) {
		t.Fatalf("standard base64: %v", err)
	}

	short := "AAECAwQFBgcICQoLDA0ODw==" // 16 bytes
	if _, err := DecodeKey(short); !errors.Is(err, ErrKeyLength) {
		t.Fatalf("short key error = %v, want ErrKeyLength", err)
	}
	if _, err := DecodeKey(""); !errors.Is(err, ErrKeyLength) {
		t.Fatalf("empty key error = %v, want ErrKeyLength", err)
	}
	if _, err := DecodeKey("not base64!!"); err == nil {
		t.Fatal("expected an error for non-base64 input")
	}
}

func TestDecodeKeysSkipsInvalidEntries(t *testing.T) {
	keys := DecodeKeys("not-a-key", panelKey, "")
	if len(keys) != 1 || !bytes.Equal(keys[0], mustKey(t)) {
		t.Fatalf("DecodeKeys returned %d keys", len(keys))
	}
}

func TestDecryptsPanelToken(t *testing.T) {
	plain, err := VerifyAndDecrypt([][]byte{mustKey(t)}, panelToken, 0)
	if err != nil {
		t.Fatalf("VerifyAndDecrypt: %v", err)
	}
	if string(plain) != panelJSON {
		t.Fatalf("plaintext = %q, want %q", plain, panelJSON)
	}
}

func TestTimestampIsIgnoredWithoutTTL(t *testing.T) {
	plain, err := VerifyAndDecrypt([][]byte{mustKey(t)}, expiredToken, 0)
	if err != nil {
		t.Fatalf("ttl=0 should ignore the timestamp: %v", err)
	}
	if string(plain) != "expired" {
		t.Fatalf("plaintext = %q", plain)
	}

	if _, err := VerifyAndDecrypt([][]byte{mustKey(t)}, expiredToken, time.Hour); !errors.Is(err, ErrExpired) {
		t.Fatalf("ttl=1h error = %v, want ErrExpired", err)
	}
}

func TestWrongKeyAndTampering(t *testing.T) {
	other := make([]byte, 32)
	for i := range other {
		other[i] = byte(0xff - i)
	}
	if _, err := VerifyAndDecrypt([][]byte{other}, panelToken, 0); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("wrong key error = %v, want ErrInvalidToken", err)
	}

	// A second key in the list is still accepted (upstream DecodeKeys semantics).
	if _, err := VerifyAndDecrypt([][]byte{other, mustKey(t)}, panelToken, 0); err != nil {
		t.Fatalf("second key: %v", err)
	}

	tampered := []byte(panelToken)
	tampered[len(tampered)/2] ^= 0x01
	if _, err := VerifyAndDecrypt([][]byte{mustKey(t)}, string(tampered), 0); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("tampered token error = %v, want ErrInvalidToken", err)
	}

	if _, err := VerifyAndDecrypt(nil, panelToken, 0); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("no keys error = %v", err)
	}
	if _, err := VerifyAndDecrypt([][]byte{mustKey(t)}, "!!!", 0); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("garbage token error = %v", err)
	}
}

func TestEncryptRoundTrip(t *testing.T) {
	key := mustKey(t)
	plaintext := []byte("config: {\"services\":[]} — 隧道")
	token, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if strings.ContainsAny(token, "-_") == false && strings.ContainsAny(token, "+/") {
		t.Fatalf("token is not url-safe base64: %q", token)
	}
	got, err := VerifyAndDecrypt([][]byte{key}, token, time.Minute)
	if err != nil {
		t.Fatalf("VerifyAndDecrypt: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("round trip = %q", got)
	}

	if _, err := Encrypt([]byte("short"), plaintext); !errors.Is(err, ErrKeyLength) {
		t.Fatalf("short key error = %v, want ErrKeyLength", err)
	}
}

// TestPanelDefaultKeyInterop decrypts a token produced by the panel's fernet
// package with the key the panel hardcodes (work/modules/006__src__services__fernet.ts:2,
// also this agent's key1). This is the out-of-the-box config push path.
func TestPanelDefaultKeyInterop(t *testing.T) {
	const panelDefaultKey = "KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4="
	const token = "gAAAAABq1hCI_1whgtJL7U9Fo1IHT73StVDOZ7Q8zFNfDLix5goZBk4RN_7WPnls6DOmedq_GWy8VHhSjFLAvnXrjYw8VCIygaHVsGfikf8upPGOaclwl00="
	const want = `{"services":[{"name":"tcp-1"}]}`

	key, err := DecodeKey(panelDefaultKey)
	if err != nil {
		t.Fatalf("DecodeKey(panel default): %v", err)
	}
	plain, err := VerifyAndDecrypt([][]byte{key}, token, 0)
	if err != nil {
		t.Fatalf("VerifyAndDecrypt: %v", err)
	}
	if string(plain) != want {
		t.Fatalf("plaintext = %q, want %q", plain, want)
	}

	// The agent's own default must be the same literal.
	agentKey, err := DecodeKey(config.DefaultConfigSecret)
	if err != nil {
		t.Fatalf("agent default key: %v", err)
	}
	if string(agentKey) != string(key) {
		t.Fatal("agent default key differs from the panel key")
	}
}

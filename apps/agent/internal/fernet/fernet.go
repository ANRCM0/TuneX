// Package fernet implements the Fernet symmetric-encryption token format
// (https://github.com/fernet/spec) used by the panel to encrypt every
// `config` push and the `license` blob of the register acknowledgement.
//
// The implementation is deliberately wire-compatible with the two peers it has
// to talk to:
//
//   - `github.com/fernet/fernet-go`, vendored by the upstream agent (key set by
//     `fernet.DecodeKeys` in `app/fernet.init`);
//   - the npm `fernet@0.3.3` package used by the panel
//     (`apps/backend/src/services/fernet.ts`), whose Secret splits the
//     base64url-decoded 32 bytes into a 16-byte signing key and a 16-byte
//     AES-128 key.
//
// Token layout: base64url( 0x80 || uint64 timestamp || IV[16] || AES-128-CBC
// ciphertext || HMAC-SHA256[32] ), where the HMAC key is the signing key and
// covers everything before the MAC. Upstream decrypts with ttl=0, i.e. the
// embedded timestamp is not checked (see reports/AGENT_CONTROL.md:156-157).
package fernet

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	versionByte   = 0x80
	macLen        = sha256.Size
	minTokenLen   = 1 + 8 + aes.BlockSize + aes.BlockSize + macLen
	signingKeyLen = 16
	cipherKeyLen  = 16
)

// Errors returned by DecodeKey / VerifyAndDecrypt.
var (
	// ErrKeyLength means the supplied key did not decode to exactly 32 bytes.
	ErrKeyLength = errors.New("fernet: key must be 32 url-safe base64-encoded bytes")
	// ErrInvalidToken means the token is malformed, has a bad version, or
	// failed authentication.
	ErrInvalidToken = errors.New("fernet: invalid token")
	// ErrExpired means a token with a positive ttl was outside its window.
	ErrExpired = errors.New("fernet: token expired")
)

// DecodeKey decodes one base64url (padding optional) 32-byte Fernet key.
func DecodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, ErrKeyLength
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil {
		// Tolerate standard (non-URL-safe) base64 as well.
		b, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
		if err != nil {
			return nil, fmt.Errorf("fernet: decode key: %w", err)
		}
	}
	if len(b) != signingKeyLen+cipherKeyLen {
		return nil, ErrKeyLength
	}
	return b, nil
}

// DecodeKeys decodes a key list, skipping entries that do not decode, exactly
// like fernet.DecodeKeys in the upstream agent.
func DecodeKeys(ss ...string) [][]byte {
	keys := make([][]byte, 0, len(ss))
	for _, s := range ss {
		if k, err := DecodeKey(s); err == nil {
			keys = append(keys, k)
		}
	}
	return keys
}

// Encrypt produces a Fernet token for plaintext under key.
func Encrypt(key []byte, plaintext []byte) (string, error) {
	if len(key) != signingKeyLen+cipherKeyLen {
		return "", ErrKeyLength
	}
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	body, err := seal(key, time.Now(), iv, plaintext)
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(body), nil
}

func seal(key []byte, ts time.Time, iv, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key[signingKeyLen:])
	if err != nil {
		return nil, err
	}
	padded := pkcs7Pad(plaintext, aes.BlockSize)

	out := make([]byte, 0, 1+8+aes.BlockSize+len(padded)+macLen)
	out = append(out, versionByte)
	var tsBytes [8]byte
	binary.BigEndian.PutUint64(tsBytes[:], uint64(ts.Unix()))
	out = append(out, tsBytes[:]...)
	out = append(out, iv...)
	ct := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ct, padded)
	out = append(out, ct...)

	mac := hmac.New(sha256.New, key[:signingKeyLen])
	mac.Write(out)
	return mac.Sum(out), nil
}

// VerifyAndDecrypt authenticates token against the first key that verifies and
// returns the plaintext. A ttl <= 0 disables the timestamp check (upstream
// semantics).
func VerifyAndDecrypt(keys [][]byte, token string, ttl time.Duration) ([]byte, error) {
	if len(keys) == 0 {
		return nil, ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(token), "="))
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(strings.TrimSpace(token), "="))
		if err != nil {
			return nil, ErrInvalidToken
		}
	}
	if len(raw) < minTokenLen || raw[0] != versionByte {
		return nil, ErrInvalidToken
	}
	macStart := len(raw) - macLen
	body, wantMAC := raw[:macStart], raw[macStart:]

	for _, key := range keys {
		if len(key) != signingKeyLen+cipherKeyLen {
			continue
		}
		m := hmac.New(sha256.New, key[:signingKeyLen])
		m.Write(body)
		if subtle.ConstantTimeCompare(m.Sum(nil), wantMAC) != 1 {
			continue
		}
		ts := int64(binary.BigEndian.Uint64(body[1:9]))
		if ttl > 0 {
			age := time.Since(time.Unix(ts, 0))
			if age > ttl || age < -ttl/2 {
				return nil, ErrExpired
			}
		}
		iv := body[9 : 9+aes.BlockSize]
		ct := body[9+aes.BlockSize:]
		if len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
			return nil, ErrInvalidToken
		}
		block, err := aes.NewCipher(key[signingKeyLen:])
		if err != nil {
			return nil, err
		}
		pt := make([]byte, len(ct))
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(pt, ct)
		pt, err = pkcs7Unpad(pt, aes.BlockSize)
		if err != nil {
			return nil, ErrInvalidToken
		}
		return pt, nil
	}
	return nil, ErrInvalidToken
}

func pkcs7Pad(b []byte, size int) []byte {
	n := size - len(b)%size
	out := make([]byte, len(b)+n)
	copy(out, b)
	for i := len(b); i < len(out); i++ {
		out[i] = byte(n)
	}
	return out
}

func pkcs7Unpad(b []byte, size int) ([]byte, error) {
	if len(b) == 0 || len(b)%size != 0 {
		return nil, ErrInvalidToken
	}
	n := int(b[len(b)-1])
	if n == 0 || n > size || n > len(b) {
		return nil, ErrInvalidToken
	}
	for _, c := range b[len(b)-n:] {
		if int(c) != n {
			return nil, ErrInvalidToken
		}
	}
	return b[:len(b)-n], nil
}

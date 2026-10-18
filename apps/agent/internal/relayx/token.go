// Package relayx speaks the fork's listener/dialer pair: an HKDF token on a
// websocket upgrade, then smux v1 carrying gost-relay.
//
// The camouflage layer upstream puts in front of this (uTLS ClientHello
// Chrome/133) is not implemented. Replica nodes talk to each other in the
// clear on the listener port.
package relayx

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash"
	"io"
	"strings"
	"time"

	"golang.org/x/crypto/hkdf"
)

const (
	authInfo     = "relayx-auth-v1"
	tokenLen     = 56
	nonceLen     = 16
	defaultSkew  = 300 * time.Second
	bearerPrefix = "Bearer "
	// DefaultPath is the first decoy path from the upstream table. The panel
	// does not send a path, so the dialer uses this and an empty listener path
	// accepts any path.
	DefaultPath = "/api/v1/upload"
)

var (
	ErrUnauthorized = errors.New("relayx: unauthorized")
	ErrExpired      = errors.New("relayx: token expired")
	ErrMismatch     = errors.New("relayx: token mismatch")
	ErrReplay       = errors.New("relayx: token replay")
)

// DeriveAuthKey is HKDF-SHA256(ikm=metadata key, empty salt, info relayx-auth-v1, L=32).
func DeriveAuthKey(ikm string) ([]byte, error) {
	if ikm == "" {
		return nil, ErrUnauthorized
	}
	r := hkdf.New(func() hash.Hash { return sha256.New() }, []byte(ikm), nil, []byte(authInfo))
	out := make([]byte, 32)
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, err
	}
	return out, nil
}

// BuildToken returns the raw base64url token (no Bearer prefix). mux sets the
// high bit of the nonce, which the listener copies into the first byte it
// writes after the upgrade.
func BuildToken(ikm string, mux bool, now time.Time) (string, error) {
	key, err := DeriveAuthKey(ikm)
	if err != nil {
		return "", err
	}
	raw := make([]byte, tokenLen)
	if _, err := rand.Read(raw[:nonceLen]); err != nil {
		return "", err
	}
	raw[0] = raw[0] & 0x7f
	if mux {
		raw[0] |= 0x80
	}
	binary.BigEndian.PutUint64(raw[nonceLen:nonceLen+8], uint64(now.Unix()))
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(raw[:nonceLen+8])
	copy(raw[nonceLen+8:], mac.Sum(nil))
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// Validate checks a raw token (no Bearer prefix) and records it so a second
// presentation inside the window is a replay. cache may be nil to skip that
// check. skew 0 means 300s.
func Validate(ikm, token string, now time.Time, skew time.Duration, cache *Replay) (mux bool, err error) {
	key, err := DeriveAuthKey(ikm)
	if err != nil {
		return false, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != tokenLen {
		return false, ErrUnauthorized
	}
	if skew <= 0 {
		skew = defaultSkew
	}
	ts := int64(binary.BigEndian.Uint64(raw[nonceLen : nonceLen+8]))
	delta := now.Unix() - ts
	if delta < 0 {
		delta = -delta
	}
	if time.Duration(delta)*time.Second > skew {
		return false, ErrExpired
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(raw[:nonceLen+8])
	if !hmac.Equal(mac.Sum(nil), raw[nonceLen+8:]) {
		return false, ErrMismatch
	}
	if cache != nil {
		var id [24]byte
		copy(id[:], raw[:24])
		if err := cache.See(id, ts); err != nil {
			return false, err
		}
	}
	return raw[0]&0x80 != 0, nil
}

// ParseAuthorization returns the token after "Bearer ".
func ParseAuthorization(header string) (string, error) {
	if !strings.HasPrefix(header, bearerPrefix) || len(header) == len(bearerPrefix) {
		return "", ErrUnauthorized
	}
	return header[len(bearerPrefix):], nil
}

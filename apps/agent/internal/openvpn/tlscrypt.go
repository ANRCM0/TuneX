// Package openvpn starts the OpenVPN data plane. This file is only the
// tls-crypt control-packet wrapper OpenVPN 2.4+ puts around the TLS records.
// A full listener (handshake, data channel, TUN) is not here yet.
//
// A static key is 256 bytes. The first 128 are server encrypt / client
// decrypt; the second 128 are the other direction. Each half is a 32-byte
// AES-256 key, 32 unused bytes, then a 32-byte HMAC-SHA256 key.
//
// A packet is header (opcode and 8-byte session id) || packet id || unix time
// || HMAC-SHA256(header || ids || plaintext) || AES-256-CTR(plaintext).
// The CTR IV is the first 16 bytes of the HMAC.
package openvpn

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

const (
	headerSize = 1 + 8
	pidSize    = 4 + 4
	tagSize    = sha256.Size
	keySize    = 256
	slotSize   = 128
)

// TLSCrypt wraps one direction and unwraps the other.
type TLSCrypt struct {
	encKey []byte
	encMAC []byte
	decKey []byte
	decMAC []byte
}

// NewTLSCrypt splits a 256-byte static key. client selects the peer role.
func NewTLSCrypt(staticKey []byte, client bool) (*TLSCrypt, error) {
	if len(staticKey) != keySize {
		return nil, fmt.Errorf("openvpn: tls-crypt key is %d bytes, want %d", len(staticKey), keySize)
	}
	enc, dec := staticKey[:slotSize], staticKey[slotSize:]
	if client {
		enc, dec = dec, enc
	}
	return &TLSCrypt{
		encKey: append([]byte(nil), enc[:32]...),
		encMAC: append([]byte(nil), enc[64:96]...),
		decKey: append([]byte(nil), dec[:32]...),
		decMAC: append([]byte(nil), dec[64:96]...),
	}, nil
}

// ParseStaticKey reads an OpenVPN static key file (hex between the V1 markers).
func ParseStaticKey(text string) ([]byte, error) {
	var hexLines []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-----") || strings.HasPrefix(line, "#") {
			continue
		}
		hexLines = append(hexLines, line)
	}
	raw, err := hex.DecodeString(strings.Join(hexLines, ""))
	if err != nil {
		return nil, fmt.Errorf("openvpn: tls-crypt key: %w", err)
	}
	if len(raw) != keySize {
		return nil, fmt.Errorf("openvpn: tls-crypt key is %d bytes, want %d", len(raw), keySize)
	}
	return raw, nil
}

// Wrap seals plaintext. header must be 9 bytes (opcode and session id).
func (c *TLSCrypt) Wrap(header []byte, packetID, unixTime uint32, plaintext []byte) ([]byte, error) {
	if len(header) != headerSize {
		return nil, fmt.Errorf("openvpn: tls-crypt header is %d bytes, want %d", len(header), headerSize)
	}
	ad := make([]byte, 0, headerSize+pidSize)
	ad = append(ad, header...)
	var pid [pidSize]byte
	binary.BigEndian.PutUint32(pid[:4], packetID)
	binary.BigEndian.PutUint32(pid[4:], unixTime)
	ad = append(ad, pid[:]...)
	tag := mac(c.encMAC, ad, plaintext)
	body, err := crypt(c.encKey, tag[:aes.BlockSize], plaintext)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(ad)+len(tag)+len(body))
	out = append(out, ad...)
	out = append(out, tag...)
	out = append(out, body...)
	return out, nil
}

// Unwrap checks the HMAC and returns the header, packet id, time, and plaintext.
func (c *TLSCrypt) Unwrap(packet []byte) (header []byte, packetID, unixTime uint32, plaintext []byte, err error) {
	if len(packet) < headerSize+pidSize+tagSize {
		return nil, 0, 0, nil, errors.New("openvpn: tls-crypt packet too short")
	}
	adEnd := headerSize + pidSize
	tagEnd := adEnd + tagSize
	header = append([]byte(nil), packet[:headerSize]...)
	tag := packet[adEnd:tagEnd]
	plain, err := crypt(c.decKey, tag[:aes.BlockSize], packet[tagEnd:])
	if err != nil {
		return nil, 0, 0, nil, err
	}
	if !hmac.Equal(tag, mac(c.decMAC, packet[:adEnd], plain)) {
		return nil, 0, 0, nil, errors.New("openvpn: tls-crypt authentication failed")
	}
	packetID = binary.BigEndian.Uint32(packet[headerSize : headerSize+4])
	unixTime = binary.BigEndian.Uint32(packet[headerSize+4 : adEnd])
	return header, packetID, unixTime, plain, nil
}

func mac(key, ad, plain []byte) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(ad)
	_, _ = h.Write(plain)
	return h.Sum(nil)
}

func crypt(key, iv, in []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	out := append([]byte(nil), in...)
	cipher.NewCTR(block, iv).XORKeyStream(out, out)
	return out, nil
}

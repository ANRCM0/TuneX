package openvpn

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
)

const (
	preMasterSize = 48
	randomSize    = 32
	maxCipherLen  = 64
	maxHMACLen    = 64
)

// KeySource is one side of an OpenVPN key-method-2 exchange.
// The client sends PreMaster; the server leaves it zero.
type KeySource struct {
	PreMaster [preMasterSize]byte
	Random1   [randomSize]byte
	Random2   [randomSize]byte
}

// NewKeySource fills the fields a client sends. Server callers ignore PreMaster.
func NewKeySource(client bool) (KeySource, error) {
	var k KeySource
	if client {
		if _, err := rand.Read(k.PreMaster[:]); err != nil {
			return k, err
		}
	}
	if _, err := rand.Read(k.Random1[:]); err != nil {
		return k, err
	}
	if _, err := rand.Read(k.Random2[:]); err != nil {
		return k, err
	}
	return k, nil
}

// MarshalClient writes a key-method-2 client record: uint32 0, method 2,
// pre-master, two randoms, then options, username, password and peer-info strings.
func MarshalClient(src KeySource, options, user, pass, peer string) []byte {
	out := make([]byte, 0, 5+preMasterSize+2*randomSize)
	out = binary.BigEndian.AppendUint32(out, 0)
	out = append(out, 2)
	out = append(out, src.PreMaster[:]...)
	out = append(out, src.Random1[:]...)
	out = append(out, src.Random2[:]...)
	out = appendString(out, options)
	out = appendString(out, user)
	out = appendString(out, pass)
	out = appendString(out, peer)
	return out
}

// MarshalServer writes a key-method-2 server record. There is no pre-master.
func MarshalServer(src KeySource, options, user, pass, peer string) []byte {
	out := make([]byte, 0, 5+2*randomSize)
	out = binary.BigEndian.AppendUint32(out, 0)
	out = append(out, 2)
	out = append(out, src.Random1[:]...)
	out = append(out, src.Random2[:]...)
	out = appendString(out, options)
	out = appendString(out, user)
	out = appendString(out, pass)
	out = appendString(out, peer)
	return out
}

// ParseClient reads a client key-method-2 record.
func ParseClient(packet []byte) (KeySource, string, error) {
	var src KeySource
	if len(packet) < 5+preMasterSize+2*randomSize {
		return src, "", errors.New("openvpn: key method 2 client packet too short")
	}
	if binary.BigEndian.Uint32(packet[:4]) != 0 || packet[4]&0x0f != 2 {
		return src, "", errors.New("openvpn: not key method 2")
	}
	off := 5
	copy(src.PreMaster[:], packet[off:off+preMasterSize])
	off += preMasterSize
	copy(src.Random1[:], packet[off:off+randomSize])
	off += randomSize
	copy(src.Random2[:], packet[off:off+randomSize])
	off += randomSize
	opt, _, err := readString(packet, off)
	return src, opt, err
}

// ParseServer reads a server key-method-2 record.
func ParseServer(packet []byte) (KeySource, string, error) {
	var src KeySource
	if len(packet) < 5+2*randomSize {
		return src, "", errors.New("openvpn: key method 2 server packet too short")
	}
	if binary.BigEndian.Uint32(packet[:4]) != 0 || packet[4]&0x0f != 2 {
		return src, "", errors.New("openvpn: not key method 2")
	}
	off := 5
	copy(src.Random1[:], packet[off:off+randomSize])
	off += randomSize
	copy(src.Random2[:], packet[off:off+randomSize])
	off += randomSize
	opt, _, err := readString(packet, off)
	return src, opt, err
}

// DeriveKeys runs the OpenVPN TLS1.0 PRF. client is true for the peer that
// sends on the client-to-server keys. cipherLen is 16, 24 or 32.
func DeriveKeys(clientSrc, serverSrc KeySource, clientSess, serverSess SessionID, cipherLen int, client bool) (DataKeys, error) {
	var zero DataKeys
	if cipherLen != 16 && cipherLen != 24 && cipherLen != 32 {
		return zero, fmt.Errorf("openvpn: cipher key length %d", cipherLen)
	}
	var master [48]byte
	if err := prf(clientSrc.PreMaster[:], "OpenVPN master secret",
		clientSrc.Random1[:], serverSrc.Random1[:], nil, nil, master[:]); err != nil {
		return zero, err
	}
	block := make([]byte, 2*(maxCipherLen+maxHMACLen))
	if err := prf(master[:], "OpenVPN key expansion",
		clientSrc.Random2[:], serverSrc.Random2[:], clientSess[:], serverSess[:], block); err != nil {
		return zero, err
	}
	c2s := block[:maxCipherLen+maxHMACLen]
	s2c := block[maxCipherLen+maxHMACLen:]
	keys := DataKeys{
		SendCipher: append([]byte(nil), c2s[:cipherLen]...),
		SendHMAC:   append([]byte(nil), c2s[maxCipherLen:maxCipherLen+maxHMACLen]...),
		RecvCipher: append([]byte(nil), s2c[:cipherLen]...),
		RecvHMAC:   append([]byte(nil), s2c[maxCipherLen:maxCipherLen+maxHMACLen]...),
	}
	if !client {
		keys.SendCipher, keys.RecvCipher = keys.RecvCipher, keys.SendCipher
		keys.SendHMAC, keys.RecvHMAC = keys.RecvHMAC, keys.SendHMAC
	}
	return keys, nil
}

func appendString(out []byte, s string) []byte {
	if s == "" {
		return binary.BigEndian.AppendUint16(out, 0)
	}
	out = binary.BigEndian.AppendUint16(out, uint16(len(s)+1))
	out = append(out, s...)
	return append(out, 0)
}

func readString(packet []byte, off int) (string, int, error) {
	if off+2 > len(packet) {
		return "", off, errors.New("openvpn: string truncated")
	}
	n := int(binary.BigEndian.Uint16(packet[off : off+2]))
	if n == 0 {
		return "", off + 2, nil
	}
	if off+2+n > len(packet) {
		return "", off, errors.New("openvpn: string truncated")
	}
	raw := packet[off+2 : off+2+n]
	if len(raw) > 0 && raw[len(raw)-1] == 0 {
		raw = raw[:len(raw)-1]
	}
	return string(raw), off + 2 + n, nil
}

func prf(secret []byte, label string, clientSeed, serverSeed, clientSess, serverSess, out []byte) error {
	seed := make([]byte, 0, len(label)+len(clientSeed)+len(serverSeed)+len(clientSess)+len(serverSess))
	seed = append(seed, label...)
	seed = append(seed, clientSeed...)
	seed = append(seed, serverSeed...)
	seed = append(seed, clientSess...)
	seed = append(seed, serverSess...)
	split := (len(secret) + 1) / 2
	s1 := secret[:split]
	s2 := secret[len(secret)-split:]
	md5Out := pHash(md5.New, s1, seed, len(out))
	sha1Out := pHash(sha1.New, s2, seed, len(out))
	for i := range out {
		out[i] = md5Out[i] ^ sha1Out[i]
	}
	return nil
}

func pHash(newHash func() hash.Hash, secret, seed []byte, size int) []byte {
	out := make([]byte, 0, size)
	a := hmacSum(newHash, secret, seed)
	for len(out) < size {
		chunk := append(append([]byte{}, a...), seed...)
		out = append(out, hmacSum(newHash, secret, chunk)...)
		a = hmacSum(newHash, secret, a)
	}
	return out[:size]
}

func hmacSum(newHash func() hash.Hash, key, data []byte) []byte {
	mac := hmac.New(newHash, key)
	_, _ = mac.Write(data)
	return mac.Sum(nil)
}

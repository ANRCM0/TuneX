package openvpn

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
)

const (
	dataTagSize = 16
	dataIVSize  = 12
	// peerIDUnset selects P_DATA_V1 (no 3-byte peer id). Any other value is P_DATA_V2.
	peerIDUnset uint32 = 0xffffff
)

// DataKeys is one direction of an OpenVPN AEAD data channel.
// Cipher keys are 16 or 32 bytes. The first 8 bytes of each HMAC key are the
// implicit IV tail (nonce bytes 4..12).
type DataKeys struct {
	SendCipher []byte
	RecvCipher []byte
	SendHMAC   []byte
	RecvHMAC   []byte
}

// DataChannel seals and opens P_DATA_V2 (or V1) packets with AES-GCM.
// The panel's default cipher is AES-256-GCM. The tag is stored before the
// ciphertext, which is OpenVPN's layout, not the Go Seal order.
type DataChannel struct {
	send cipher.AEAD
	recv cipher.AEAD

	sendIV [dataIVSize]byte
	recvIV [dataIVSize]byte
	header []byte

	mu      sync.Mutex
	sendID  uint32
	highest uint32
	window  uint64
	seen    bool
}

// NewDataChannel builds an AES-GCM data channel. peerID 0xffffff means P_DATA_V1.
func NewDataChannel(keys DataKeys, peerID uint32, keyID uint8) (*DataChannel, error) {
	send, err := aesGCM(keys.SendCipher)
	if err != nil {
		return nil, fmt.Errorf("openvpn: send cipher: %w", err)
	}
	recv, err := aesGCM(keys.RecvCipher)
	if err != nil {
		return nil, fmt.Errorf("openvpn: recv cipher: %w", err)
	}
	if len(keys.SendHMAC) < 8 || len(keys.RecvHMAC) < 8 {
		return nil, errors.New("openvpn: implicit IV key is shorter than 8 bytes")
	}
	d := &DataChannel{send: send, recv: recv, header: dataHeader(peerID, keyID)}
	copy(d.sendIV[4:], keys.SendHMAC[:8])
	copy(d.recvIV[4:], keys.RecvHMAC[:8])
	return d, nil
}

func aesGCM(key []byte) (cipher.AEAD, error) {
	switch len(key) {
	case 16, 32:
	default:
		return nil, fmt.Errorf("openvpn: AES-GCM key is %d bytes", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithTagSize(block, dataTagSize)
}

func dataHeader(peerID uint32, keyID uint8) []byte {
	if peerID == peerIDUnset {
		return []byte{opcodeKeyID(opDataV1, keyID)}
	}
	return []byte{
		opcodeKeyID(opDataV2, keyID),
		byte(peerID >> 16),
		byte(peerID >> 8),
		byte(peerID),
	}
}

// Seal encrypts plaintext. Packet ids start at 1.
func (d *DataChannel) Seal(plaintext []byte) ([]byte, error) {
	d.mu.Lock()
	d.sendID++
	id := d.sendID
	d.mu.Unlock()
	var idb [4]byte
	binary.BigEndian.PutUint32(idb[:], id)
	nonce := d.sendIV
	binary.BigEndian.PutUint32(nonce[:4], binary.BigEndian.Uint32(nonce[:4])^id)
	ad := append(append([]byte{}, d.header...), idb[:]...)
	if op, _ := parseOpcodeKeyID(d.header[0]); op != opDataV2 {
		ad = idb[:]
	}
	sealed := d.send.Seal(nil, nonce[:], plaintext, ad)
	tag := sealed[len(sealed)-dataTagSize:]
	body := sealed[:len(sealed)-dataTagSize]
	out := make([]byte, 0, len(d.header)+4+dataTagSize+len(body))
	out = append(out, d.header...)
	out = append(out, idb[:]...)
	out = append(out, tag...)
	out = append(out, body...)
	return out, nil
}

// Open decrypts a data packet and rejects a replayed packet id.
func (d *DataChannel) Open(packet []byte) ([]byte, error) {
	if len(packet) < len(d.header)+4+dataTagSize {
		return nil, errors.New("openvpn: data packet too short")
	}
	if !bytesEqual(packet[:len(d.header)], d.header) {
		return nil, errors.New("openvpn: data header mismatch")
	}
	off := len(d.header)
	id := binary.BigEndian.Uint32(packet[off : off+4])
	tag := packet[off+4 : off+4+dataTagSize]
	body := packet[off+4+dataTagSize:]
	combined := make([]byte, 0, len(body)+dataTagSize)
	combined = append(combined, body...)
	combined = append(combined, tag...)
	ad := append(append([]byte{}, d.header...), packet[off:off+4]...)
	if op, _ := parseOpcodeKeyID(d.header[0]); op != opDataV2 {
		ad = packet[off : off+4]
	}
	nonce := d.recvIV
	binary.BigEndian.PutUint32(nonce[:4], binary.BigEndian.Uint32(nonce[:4])^id)
	plain, err := d.recv.Open(nil, nonce[:], combined, ad)
	if err != nil {
		return nil, err
	}
	if err := d.accept(id); err != nil {
		return nil, err
	}
	return plain, nil
}

func (d *DataChannel) accept(id uint32) error {
	const window = 64
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.seen {
		d.highest = id
		d.window = 1
		d.seen = true
		return nil
	}
	if id > d.highest {
		shift := id - d.highest
		if shift >= window {
			d.window = 1
		} else {
			d.window = d.window<<shift | 1
		}
		d.highest = id
		return nil
	}
	diff := d.highest - id
	if diff == 0 || diff >= window || d.window&(uint64(1)<<diff) != 0 {
		return fmt.Errorf("openvpn: replayed data packet %d", id)
	}
	d.window |= uint64(1) << diff
	return nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

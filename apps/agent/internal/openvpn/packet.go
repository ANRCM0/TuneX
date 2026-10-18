package openvpn

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Opcode is the high 5 bits of the first header byte. Values match OpenVPN.
type Opcode uint8

const (
	opHardResetClientV2 Opcode = 7
	opHardResetServerV2 Opcode = 8
	opControlV1         Opcode = 4
	opAckV1             Opcode = 5
	opDataV1            Opcode = 6
	opDataV2            Opcode = 9

	sessionIDSize   = 8
	reliableAckSize = 8
	opcodeShift     = 3
	keyIDMask       = 0x07
)

// SessionID is the 8-byte OpenVPN session identifier.
type SessionID [sessionIDSize]byte

// NewSessionID fills id with random bytes.
func NewSessionID() (SessionID, error) {
	var id SessionID
	_, err := rand.Read(id[:])
	return id, err
}

// Control is one control-channel message before tls-crypt.
type Control struct {
	Opcode       Opcode
	KeyID        uint8
	LocalSession SessionID
	AckIDs       []uint32
	AckSession   SessionID
	MessageID    uint32
	Payload      []byte
}

func (o Opcode) isControl() bool {
	switch o {
	case 1, 2, 3, opControlV1, opAckV1, opHardResetClientV2, opHardResetServerV2, 10, 11:
		return true
	default:
		return false
	}
}

func (o Opcode) hasMessageID() bool {
	return o.isControl() && o != opAckV1
}

func opcodeKeyID(op Opcode, keyID uint8) byte {
	return byte(op)<<opcodeShift | (keyID & keyIDMask)
}

func parseOpcodeKeyID(b byte) (Opcode, uint8) {
	return Opcode(b >> opcodeShift), b & keyIDMask
}

// EncodePlain writes the ack array, optional remote session, and message id.
func (p Control) EncodePlain() ([]byte, error) {
	if !p.Opcode.isControl() {
		return nil, fmt.Errorf("openvpn: opcode %d is not control", p.Opcode)
	}
	if len(p.AckIDs) > reliableAckSize {
		return nil, fmt.Errorf("openvpn: %d ack ids", len(p.AckIDs))
	}
	out := []byte{byte(len(p.AckIDs))}
	var b [4]byte
	for _, id := range p.AckIDs {
		binary.BigEndian.PutUint32(b[:], id)
		out = append(out, b[:]...)
	}
	if len(p.AckIDs) > 0 {
		out = append(out, p.AckSession[:]...)
	}
	if p.Opcode.hasMessageID() {
		binary.BigEndian.PutUint32(b[:], p.MessageID)
		out = append(out, b[:]...)
		out = append(out, p.Payload...)
	}
	return out, nil
}

// DecodePlain reverses EncodePlain.
func DecodePlain(op Opcode, plain []byte) (ackIDs []uint32, ackRemote SessionID, messageID uint32, payload []byte, err error) {
	if len(plain) < 1 {
		return nil, SessionID{}, 0, nil, errors.New("openvpn: control payload too short")
	}
	n := int(plain[0])
	if n > reliableAckSize {
		return nil, SessionID{}, 0, nil, fmt.Errorf("openvpn: %d ack ids", n)
	}
	off := 1
	if len(plain) < off+n*4 {
		return nil, SessionID{}, 0, nil, errors.New("openvpn: ack array truncated")
	}
	ackIDs = make([]uint32, n)
	for i := 0; i < n; i++ {
		ackIDs[i] = binary.BigEndian.Uint32(plain[off : off+4])
		off += 4
	}
	if n > 0 {
		if len(plain) < off+sessionIDSize {
			return nil, SessionID{}, 0, nil, errors.New("openvpn: ack session truncated")
		}
		copy(ackRemote[:], plain[off:off+sessionIDSize])
		off += sessionIDSize
	}
	if op.hasMessageID() {
		if len(plain) < off+4 {
			return nil, SessionID{}, 0, nil, errors.New("openvpn: message id truncated")
		}
		messageID = binary.BigEndian.Uint32(plain[off : off+4])
		off += 4
		payload = append([]byte(nil), plain[off:]...)
	} else if len(plain) != off {
		return nil, SessionID{}, 0, nil, errors.New("openvpn: ack packet has trailing bytes")
	}
	return ackIDs, ackRemote, messageID, payload, nil
}

// Seal wraps the control message with tls-crypt. packetID and unixTime are the replay header.
func (p Control) Seal(c *TLSCrypt, packetID, unixTime uint32) ([]byte, error) {
	plain, err := p.EncodePlain()
	if err != nil {
		return nil, err
	}
	header := make([]byte, headerSize)
	header[0] = opcodeKeyID(p.Opcode, p.KeyID)
	copy(header[1:], p.LocalSession[:])
	return c.Wrap(header, packetID, unixTime, plain)
}

// OpenControl unwraps a tls-crypt packet into a control message.
func OpenControl(c *TLSCrypt, packet []byte) (Control, uint32, uint32, error) {
	hdr, packetID, unixTime, plain, err := c.Unwrap(packet)
	if err != nil {
		return Control{}, 0, 0, err
	}
	op, keyID := parseOpcodeKeyID(hdr[0])
	if !op.isControl() {
		return Control{}, 0, 0, fmt.Errorf("openvpn: opcode %d is not control", op)
	}
	var local SessionID
	copy(local[:], hdr[1:])
	acks, remote, msgID, payload, err := DecodePlain(op, plain)
	if err != nil {
		return Control{}, 0, 0, err
	}
	return Control{
		Opcode: op, KeyID: keyID, LocalSession: local,
		AckIDs: acks, AckSession: remote, MessageID: msgID, Payload: payload,
	}, packetID, unixTime, nil
}

// WriteTCP writes a uint16 big-endian length and the packet. OpenVPN rejects a length above 65535.
func WriteTCP(w io.Writer, packet []byte) error {
	if len(packet) > 65535 {
		return fmt.Errorf("openvpn: tcp packet is %d bytes", len(packet))
	}
	buf := make([]byte, 2+len(packet))
	binary.BigEndian.PutUint16(buf, uint16(len(packet)))
	copy(buf[2:], packet)
	_, err := w.Write(buf)
	return err
}

// ReadTCP reads one length-prefixed packet.
func ReadTCP(r io.Reader) ([]byte, error) {
	var b [2]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(b[:]))
	if n == 0 {
		return nil, errors.New("openvpn: empty tcp packet")
	}
	buf := make([]byte, n)
	_, err := io.ReadFull(r, buf)
	return buf, err
}

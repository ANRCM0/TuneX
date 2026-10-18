package openvpn

import (
	"bytes"
	"net"
	"sync"
	"time"
)

// Stream is the reliable control channel after the hard reset, as a byte
// pipe. Each Write is one P_CONTROL_V1. Reads reassemble payloads in message
// id order. A received message id is acknowledged with P_ACK_V1 immediately.
// An ack that has not been flushed yet is still carried on the next Write.
//
// Message ids start at nextMsg on both sides. The hard reset uses 0, so the
// TLS records that follow start at 1. Packets before nextMsg are not delivered.
type Stream struct {
	conn   net.Conn
	crypt  *TLSCrypt
	local  SessionID
	remote SessionID

	mu      sync.Mutex
	writeMu sync.Mutex
	cond    *sync.Cond
	send    uint32
	pkt     uint32
	expect  uint32
	acks    []uint32
	in      bytes.Buffer
	err     error
	data    chan []byte
}

// NewStream starts reading conn. nextMsg is the first control message id to deliver.
func NewStream(conn net.Conn, crypt *TLSCrypt, local, remote SessionID, nextMsg uint32) *Stream {
	s := &Stream{
		conn: conn, crypt: crypt, local: local, remote: remote,
		// pkt starts at 2: the hard reset already used tls-crypt packet id 1.
		send: nextMsg, pkt: 2, expect: nextMsg,
		data: make(chan []byte, 4),
	}
	s.cond = sync.NewCond(&s.mu)
	go s.loop()
	return s
}

// Data receives P_DATA_V2 packets read on the same TCP connection as the
// control channel. The buffer is 4; a full buffer drops the packet.
func (s *Stream) Data() <-chan []byte { return s.data }

func (s *Stream) loop() {
	defer close(s.data)
	for {
		raw, err := ReadTCP(s.conn)
		if err == nil && len(raw) > 0 {
			if op, _ := parseOpcodeKeyID(raw[0]); op == opDataV2 {
				select {
				case s.data <- raw:
				default:
				}
				continue
			}
		}
		var ctrl Control
		if err == nil {
			ctrl, _, _, err = OpenControl(s.crypt, raw)
		}
		s.mu.Lock()
		if err != nil {
			if s.err == nil {
				s.err = err
			}
			s.cond.Broadcast()
			s.mu.Unlock()
			return
		}
		if ctrl.Opcode.hasMessageID() {
			if ctrl.MessageID == s.expect && len(ctrl.Payload) > 0 {
				_, _ = s.in.Write(ctrl.Payload)
				s.expect++
			}
			s.acks = append(s.acks, ctrl.MessageID)
		}
		s.cond.Broadcast()
		s.mu.Unlock()
		if ctrl.Opcode.hasMessageID() {
			_ = s.flushAcks()
		}
	}
}

func (s *Stream) flushAcks() error {
	s.mu.Lock()
	if len(s.acks) == 0 {
		s.mu.Unlock()
		return nil
	}
	acks := s.acks
	s.acks = nil
	pkt := s.pkt
	s.pkt++
	s.mu.Unlock()
	ctrl := Control{
		Opcode:       opAckV1,
		LocalSession: s.local,
		AckIDs:       acks,
		AckSession:   s.remote,
	}
	s.writeMu.Lock()
	err := WriteControl(s.conn, s.crypt, ctrl, pkt, uint32(time.Now().Unix()))
	s.writeMu.Unlock()
	if err != nil {
		s.mu.Lock()
		s.acks = append(acks, s.acks...)
		s.mu.Unlock()
	}
	return err
}

func (s *Stream) Read(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.in.Len() == 0 && s.err == nil {
		s.cond.Wait()
	}
	if s.in.Len() == 0 {
		return 0, s.err
	}
	return s.in.Read(p)
}

func (s *Stream) Write(p []byte) (int, error) {
	s.mu.Lock()
	acks := s.acks
	s.acks = nil
	msg := s.send
	s.send++
	pkt := s.pkt
	s.pkt++
	s.mu.Unlock()
	ctrl := Control{
		Opcode:       opControlV1,
		LocalSession: s.local,
		AckIDs:       acks,
		AckSession:   s.remote,
		MessageID:    msg,
		Payload:      append([]byte(nil), p...),
	}
	s.writeMu.Lock()
	err := WriteControl(s.conn, s.crypt, ctrl, pkt, uint32(time.Now().Unix()))
	s.writeMu.Unlock()
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func (s *Stream) Close() error { return s.conn.Close() }

func (s *Stream) LocalAddr() net.Addr  { return s.conn.LocalAddr() }
func (s *Stream) RemoteAddr() net.Addr { return s.conn.RemoteAddr() }

func (s *Stream) SetDeadline(t time.Time) error      { return s.conn.SetDeadline(t) }
func (s *Stream) SetReadDeadline(t time.Time) error  { return s.conn.SetReadDeadline(t) }
func (s *Stream) SetWriteDeadline(t time.Time) error { return s.conn.SetWriteDeadline(t) }

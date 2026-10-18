package shadowsocks

import (
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
	"github.com/relayx/agent/internal/socksaddr"
)

// UDP idle time before a client session and its reply socket are dropped.
// A shadowsocks UDP association has no explicit close.
const udpIdle = 60 * time.Second

func (s *UDPServer) idle() time.Duration {
	if s != nil && s.Idle > 0 {
		return s.Idle
	}
	return udpIdle
}

// UDPServer is a shadowsocks AEAD UDP listener (gost handler name `ssu`).
//
// Each datagram is independent (SIP004):
//
//	[salt][AEAD(SOCKS5 address || payload)]
//
// The nonce is all zeros and is not incremented: one seal per packet. The
// destination is the address inside the packet, matching the TCP server and
// gost's handler/ss/udp, not the service forwarder. With no cipher the method is "none": a 16-byte salt and then the plaintext
// address and payload, which is what the panel emits for a UDP out-node hop.
type UDPServer struct {
	Method   string
	Password string
	// Allow rejects a remote address that fails the panel admission list.
	Allow func(net.Addr) bool
	// Bypass reports that the datagram destination must not be dialled.
	Bypass func(addr string) bool
	// Gate counts one client session as a connection and delays payload bytes.
	Gate *limit.Gate
	// Block is handler metadata "block.protocol". The payload after the SOCKS
	// address is named. sniffing.fallback false drops an unrecognized payload.
	Block         []string
	SniffFallback bool
	// Idle is the session lifetime without a packet. Zero keeps udpIdle.
	// A panel listener with keepalive uses gost's 5s default.
	Idle time.Duration

	pc     net.PacketConn
	m      method
	master []byte

	mu       sync.Mutex
	closed   bool
	sessions map[string]*udpSession
	stats    forward.Stats
}

// TakeStats reports datagram payload bytes for the panel observer.
func (s *UDPServer) TakeStats(reset bool) (forward.Stats, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stats
	cur := len(s.sessions)
	if reset {
		s.stats = forward.Stats{}
	}
	return st, cur
}

type udpSession struct {
	client net.Addr
	conn   *net.UDPConn
	last   time.Time
	held   bool
}

// NewUDP prepares a shadowsocks UDP server. ListenUDP binds it.
func NewUDP(method, password string) (*UDPServer, error) {
	m, ok := methods[method]
	if !ok {
		return nil, fmt.Errorf("shadowsocks: unsupported method %q (allowed: %v)", method, AllowedMethods)
	}
	if password == "" && m.keySize != 0 {
		return nil, errors.New("shadowsocks: empty password")
	}
	return &UDPServer{
		Method:   method,
		Password: password,
		m:        m,
		master:   MasterKey(password, m.keySize),
		sessions: map[string]*udpSession{},
	}, nil
}

// ListenUDP binds addr and starts reading datagrams.
func (s *UDPServer) ListenUDP(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	s.pc = pc
	go s.readLoop()
	go s.reap()
	return nil
}

// Addr returns the bound address.
func (s *UDPServer) Addr() net.Addr {
	if s.pc == nil {
		return nil
	}
	return s.pc.LocalAddr()
}

// Close stops the listener and every reply socket.
func (s *UDPServer) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	pc := s.pc
	sessions := s.sessions
	s.sessions = map[string]*udpSession{}
	s.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	for _, ses := range sessions {
		s.release(ses)
		_ = ses.conn.Close()
	}
	return nil
}

func (s *UDPServer) release(ses *udpSession) {
	if ses == nil || !ses.held {
		return
	}
	ses.held = false
	if s.Gate != nil {
		s.Gate.Leave(ses.client)
	}
}

func (s *UDPServer) readLoop() {
	buf := make([]byte, 64*1024)
	for {
		n, client, err := s.pc.ReadFrom(buf)
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				logx.Warnf("shadowsocks udp: read on %s: %v", s.pc.LocalAddr(), err)
			}
			return
		}
		if s.Allow != nil && !s.Allow(client) {
			logx.Debugf("shadowsocks udp: admission rejected %s", client)
			continue
		}
		plain, err := openUDP(s.m, s.master, buf[:n])
		if err != nil {
			logx.Debugf("shadowsocks udp: drop %s: %v", client, err)
			continue
		}
		dst, used, err := socksaddr.Parse(plain)
		if err != nil {
			logx.Debugf("shadowsocks udp: bad destination from %s: %v", client, err)
			continue
		}
		if s.Bypass != nil && s.Bypass(dst.String()) {
			logx.Debugf("shadowsocks udp: bypass %s", dst)
			continue
		}
		payload := append([]byte(nil), plain[used:]...)
		if len(payload) > 0 && sniff.Reject(s.Block, s.SniffFallback, sniff.Detect(payload)) {
			logx.Debugf("shadowsocks udp: blocked payload from %s", client)
			continue
		}
		if s.Gate != nil {
			s.Gate.Wait(client, len(payload))
		}
		ses, err := s.session(client)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			logx.Debugf("shadowsocks udp: %s: %v", client, err)
			continue
		}
		target, err := net.ResolveUDPAddr("udp", dst.String())
		if err != nil {
			logx.Debugf("shadowsocks udp: resolve %s: %v", dst, err)
			continue
		}
		if _, err := ses.conn.WriteToUDP(payload, target); err != nil {
			logx.Debugf("shadowsocks udp: write %s: %v", dst, err)
			continue
		}
		s.mu.Lock()
		s.stats.In += int64(len(payload))
		s.mu.Unlock()
	}
}

func (s *UDPServer) session(client net.Addr) (*udpSession, error) {
	key := client.String()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, net.ErrClosed
	}
	if ses, ok := s.sessions[key]; ok {
		ses.last = time.Now()
		return ses, nil
	}
	if s.Gate != nil && !s.Gate.Enter(client) {
		return nil, errors.New("shadowsocks udp: connection limit")
	}
	conn, err := net.ListenUDP("udp", nil)
	if err != nil {
		if s.Gate != nil {
			s.Gate.Leave(client)
		}
		return nil, err
	}
	ses := &udpSession{client: client, conn: conn, last: time.Now(), held: s.Gate != nil}
	s.sessions[key] = ses
	s.stats.Conns++
	go s.replyLoop(key, ses)
	return ses, nil
}

func (s *UDPServer) replyLoop(key string, ses *udpSession) {
	buf := make([]byte, 64*1024)
	for {
		_ = ses.conn.SetReadDeadline(time.Now().Add(s.idle()))
		n, from, err := ses.conn.ReadFromUDP(buf)
		if err != nil {
			s.drop(key, ses)
			return
		}
		header, err := socksaddr.Marshal(from.IP.String(), uint16(from.Port))
		if err != nil {
			continue
		}
		plain := make([]byte, 0, len(header)+n)
		plain = append(plain, header...)
		plain = append(plain, buf[:n]...)
		pkt, err := sealUDP(s.m, s.master, plain)
		if err != nil {
			logx.Debugf("shadowsocks udp: seal reply: %v", err)
			continue
		}
		if s.Gate != nil {
			s.Gate.Wait(ses.client, n)
		}
		if _, err := s.pc.WriteTo(pkt, ses.client); err != nil {
			s.drop(key, ses)
			return
		}
		s.mu.Lock()
		ses.last = time.Now()
		s.stats.Out += int64(n)
		s.mu.Unlock()
	}
}

func (s *UDPServer) drop(key string, ses *udpSession) {
	s.mu.Lock()
	cur, ok := s.sessions[key]
	if ok && cur == ses {
		delete(s.sessions, key)
		s.release(ses)
	}
	s.mu.Unlock()
	_ = ses.conn.Close()
}

func (s *UDPServer) reap() {
	tick := time.NewTicker(s.idle() / 2)
	defer tick.Stop()
	for range tick.C {
		now := time.Now()
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		var stale []*udpSession
		for key, ses := range s.sessions {
			if now.Sub(ses.last) > s.idle() {
				stale = append(stale, ses)
				delete(s.sessions, key)
				s.release(ses)
			}
		}
		s.mu.Unlock()
		for _, ses := range stale {
			_ = ses.conn.Close()
		}
	}
}

// PackUDP encrypts one shadowsocks AEAD UDP datagram.
func PackUDP(methodName, password string, dst socksaddr.Addr, payload []byte) ([]byte, error) {
	m, master, err := udpKey(methodName, password)
	if err != nil {
		return nil, err
	}
	header, err := socksaddr.Marshal(dst.Host, dst.Port)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, 0, len(header)+len(payload))
	plain = append(plain, header...)
	plain = append(plain, payload...)
	return sealUDP(m, master, plain)
}

// UnpackUDP decrypts one shadowsocks AEAD UDP datagram.
func UnpackUDP(methodName, password string, packet []byte) (socksaddr.Addr, []byte, error) {
	m, master, err := udpKey(methodName, password)
	if err != nil {
		return socksaddr.Addr{}, nil, err
	}
	plain, err := openUDP(m, master, packet)
	if err != nil {
		return socksaddr.Addr{}, nil, err
	}
	dst, used, err := socksaddr.Parse(plain)
	if err != nil {
		return socksaddr.Addr{}, nil, err
	}
	return dst, append([]byte(nil), plain[used:]...), nil
}

func udpKey(methodName, password string) (method, []byte, error) {
	m, ok := methods[methodName]
	if !ok {
		return method{}, nil, fmt.Errorf("shadowsocks: unsupported method %q", methodName)
	}
	if password == "" && m.keySize != 0 {
		return method{}, nil, errors.New("shadowsocks: empty password")
	}
	if m.keySize == 0 {
		return m, nil, nil
	}
	return m, MasterKey(password, m.keySize), nil
}

func sealUDP(m method, master, plain []byte) ([]byte, error) {
	salt := make([]byte, m.saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	aead, err := udpAEAD(m, master, salt)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(salt)+len(plain)+aead.Overhead())
	out = append(out, salt...)
	return aead.Seal(out, make([]byte, aead.NonceSize()), plain, nil), nil
}

func openUDP(m method, master, packet []byte) ([]byte, error) {
	min := m.saltSize
	if m.keySize > 0 {
		min += 16 // AEAD tag; "none" has no tag, so a short address must still pass
	}
	if len(packet) < min {
		return nil, errors.New("shadowsocks udp: short packet")
	}
	salt := packet[:m.saltSize]
	aead, err := udpAEAD(m, master, salt)
	if err != nil {
		return nil, err
	}
	plain, err := aead.Open(nil, make([]byte, aead.NonceSize()), packet[m.saltSize:], nil)
	if err != nil {
		return nil, errors.New("shadowsocks udp: decrypt")
	}
	return plain, nil
}

func udpAEAD(m method, master, salt []byte) (interface {
	NonceSize() int
	Overhead() int
	Seal(dst, nonce, plaintext, additionalData []byte) []byte
	Open(dst, nonce, ciphertext, additionalData []byte) ([]byte, error)
}, error) {
	if m.keySize == 0 {
		return m.newAEAD(nil)
	}
	sub, err := SubKey(master, salt, m.keySize)
	if err != nil {
		return nil, err
	}
	return m.newAEAD(sub)
}

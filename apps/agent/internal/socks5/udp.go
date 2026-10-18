package socks5

import (
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/socksaddr"
)

const udpIdle = 60 * time.Second

func (s *UDPServer) idle() time.Duration {
	if s != nil && s.Idle > 0 {
		return s.Idle
	}
	return udpIdle
}

// UDPServer accepts RFC 1928 UDP requests on a datagram socket. This is the
// panel's companion service (`udp-<id>`, handler socks5, listener udp): there
// is no TCP handshake, and each packet carries its own destination.
type UDPServer struct {
	// Allow rejects a remote address that fails the panel admission list.
	Allow func(net.Addr) bool
	// Bypass reports that a datagram's destination must not be dialled.
	Bypass func(addr string) bool
	// Gate counts one client session as a connection and delays payload bytes.
	Gate *limit.Gate
	// Idle is the session lifetime without a packet. Zero keeps udpIdle.
	Idle time.Duration

	pc net.PacketConn

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
	cur := 0
	if s.sessions != nil {
		cur = len(s.sessions)
	}
	if reset {
		s.stats = forward.Stats{}
	}
	return st, cur
}

type udpSession struct {
	client net.Addr
	up     net.PacketConn
	last   time.Time
	held   bool
}

// ListenUDP binds addr and starts serving.
func (s *UDPServer) ListenUDP(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	s.pc = pc
	s.sessions = map[string]*udpSession{}
	go s.readLoop()
	go s.reap()
	return nil
}

// Close stops the listener and its upstream sockets.
func (s *UDPServer) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	pc := s.pc
	sessions := s.sessions
	s.sessions = nil
	s.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
	for _, sess := range sessions {
		s.release(sess)
		_ = sess.up.Close()
	}
	return nil
}

func (s *UDPServer) release(sess *udpSession) {
	if sess == nil || !sess.held {
		return
	}
	sess.held = false
	if s.Gate != nil {
		s.Gate.Leave(sess.client)
	}
}

func (s *UDPServer) readLoop() {
	buf := make([]byte, 64*1024)
	for {
		n, from, err := s.pc.ReadFrom(buf)
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				logx.Warnf("socks5: udp read: %v", err)
			}
			return
		}
		if s.Allow != nil && !s.Allow(from) {
			logx.Debugf("socks5: udp admission rejected %s", from)
			continue
		}
		pkt := append([]byte(nil), buf[:n]...)
		s.dispatch(from, pkt)
	}
}

func (s *UDPServer) dispatch(from net.Addr, pkt []byte) {
	dst, payload, err := DecodeUDP(pkt)
	if err != nil {
		return
	}
	if s.Bypass != nil && s.Bypass(dst.String()) {
		logx.Debugf("socks5: udp bypass %s", dst)
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	key := from.String()
	sess := s.sessions[key]
	if sess == nil {
		if s.Gate != nil && !s.Gate.Enter(from) {
			s.mu.Unlock()
			logx.Debugf("socks5: udp limit rejected %s", from)
			return
		}
		up, err := net.ListenPacket("udp", "")
		if err != nil {
			if s.Gate != nil {
				s.Gate.Leave(from)
			}
			s.mu.Unlock()
			return
		}
		sess = &udpSession{client: from, up: up, last: time.Now(), held: s.Gate != nil}
		s.sessions[key] = sess
		s.stats.Conns++
		go s.replyLoop(sess)
	}
	sess.last = time.Now()
	up := sess.up
	s.mu.Unlock()
	if addr, err := net.ResolveUDPAddr("udp", dst.String()); err == nil {
		if s.Gate != nil {
			s.Gate.Wait(from, len(payload))
		}
		if _, err := up.WriteTo(payload, addr); err == nil {
			s.add(int64(len(payload)), 0)
		}
	}
}

func (s *UDPServer) add(in, out int64) {
	s.mu.Lock()
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

func (s *UDPServer) replyLoop(sess *udpSession) {
	buf := make([]byte, 64*1024)
	for {
		n, from, err := sess.up.ReadFrom(buf)
		if err != nil {
			return
		}
		host, portStr, err := net.SplitHostPort(from.String())
		if err != nil {
			continue
		}
		port, err := parsePort(portStr)
		if err != nil {
			continue
		}
		out, err := EncodeUDP(addrFrom(host, port), append([]byte(nil), buf[:n]...))
		if err != nil {
			continue
		}
		s.mu.Lock()
		pc := s.pc
		client := sess.client
		s.mu.Unlock()
		if pc == nil {
			return
		}
		if s.Gate != nil {
			s.Gate.Wait(client, n)
		}
		if _, err := pc.WriteTo(out, client); err == nil {
			s.add(0, int64(n))
		}
	}
}

func (s *UDPServer) reap() {
	tick := time.NewTicker(s.idle() / 2)
	defer tick.Stop()
	for range tick.C {
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		now := time.Now()
		for k, sess := range s.sessions {
			if now.Sub(sess.last) > s.idle() {
				s.release(sess)
				_ = sess.up.Close()
				delete(s.sessions, k)
			}
		}
		s.mu.Unlock()
	}
}

// relayAssociate serves one UDP ASSOCIATE session. Packets whose source IP is
// not the TCP client's are dropped (RFC 1928). done is closed when the TCP
// control connection ends.
func relayAssociate(pc net.PacketConn, clientIP net.IP, done <-chan struct{}, add func(in, out int64)) {
	up, err := net.ListenPacket("udp", "")
	if err != nil {
		return
	}
	defer up.Close()

	var mu sync.Mutex
	var clientAddr net.Addr

	go func() {
		buf := make([]byte, 64*1024)
		for {
			n, from, err := up.ReadFrom(buf)
			if err != nil {
				return
			}
			mu.Lock()
			dst := clientAddr
			mu.Unlock()
			if dst == nil {
				continue
			}
			host, portStr, err := net.SplitHostPort(from.String())
			if err != nil {
				continue
			}
			port, err := parsePort(portStr)
			if err != nil {
				continue
			}
			out, err := EncodeUDP(addrFrom(host, port), append([]byte(nil), buf[:n]...))
			if err != nil {
				continue
			}
			if _, err := pc.WriteTo(out, dst); err == nil && add != nil {
				add(0, int64(n))
			}
		}
	}()

	buf := make([]byte, 64*1024)
	for {
		_ = pc.SetReadDeadline(time.Now().Add(time.Second))
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			select {
			case <-done:
				return
			default:
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return
		}
		if clientIP != nil && !clientIP.Equal(ipOf(from)) {
			continue
		}
		dst, payload, err := DecodeUDP(buf[:n])
		if err != nil {
			continue
		}
		mu.Lock()
		clientAddr = from
		mu.Unlock()
		if addr, err := net.ResolveUDPAddr("udp", dst.String()); err == nil {
			if _, err := up.WriteTo(payload, addr); err == nil && add != nil {
				add(int64(len(payload)), 0)
			}
		}
	}
}

func addrFrom(host string, port uint16) socksaddr.Addr {
	return socksaddr.Addr{Host: host, Port: port}
}

func parsePort(s string) (uint16, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 || n > 65535 {
		return 0, err
	}
	return uint16(n), nil
}

// Package forward implements the plain tcp/udp port-forwarding listeners the
// panel pushes through the `config`/`listen` events.
package forward

import (
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
)

// dialFail is what a failed dial costs a least-latency node.
const dialFail = 30 * time.Second

// Stats is reported by a running forwarder.
type Stats struct {
	Conns int64
	In    int64
	Out   int64
}

// TCPServer forwards a local TCP port to one fixed target (or, when Target is
// empty, acts as a transparent relay whose destination is chosen per chain).
type TCPServer struct {
	ListenAddr string
	Target     string
	OnAccept   func(remote, target string)
	// ProxyV1, when set, requires a HAProxy PROXY v1 header and strips it
	// before the byte stream is copied to the target.
	ProxyV1 bool
	// Block is the panel's handler metadata "block.protocol". A recognized
	// protocol on that list is closed before the target is dialed.
	Block []string
	// SniffFallback is handler metadata "sniffing.fallback". When false, an
	// unrecognized prefix is closed as well as a blocked protocol.
	SniffFallback bool
	// Allow, when set, rejects connections whose remote address fails the
	// panel admission list. Nil allows every address.
	Allow func(net.Addr) bool
	// Bypass reports that the forward target must not be dialled.
	Bypass func(addr string) bool
	// Gate is the panel connection and bandwidth limit. Nil is unlimited.
	Gate *limit.Gate
	// Pick, when set, chooses the dial target for each connection. The
	// returned function runs when that connection ends (least-connections).
	Pick func(client net.Addr) (target string, done func())
	// Observe records how long the dial took. A failed dial is reported as
	// dialFail so least-latency will try another address.
	Observe func(addr string, d time.Duration)

	ln net.Listener

	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}
	stats  Stats
}

// StartTCP binds listenAddr and forwards every accepted connection to target.
// proxyV1 requires a HAProxy PROXY v1 header on each connection and strips it.
func StartTCP(listenAddr, target string, proxyV1 bool, block []string, allow func(net.Addr) bool, bypass func(string) bool, gate *limit.Gate, pick func(net.Addr) (string, func()), sniffFallback bool) (*TCPServer, error) {
	if target == "" {
		return nil, errors.New("forward: empty target")
	}
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return nil, err
	}
	s := &TCPServer{
		ListenAddr:    listenAddr,
		Target:        target,
		ProxyV1:       proxyV1,
		Block:         block,
		SniffFallback: sniffFallback,
		Allow:         allow,
		Bypass:        bypass,
		Gate:          gate,
		Pick:          pick,
		ln:            ln,
		conns:         map[net.Conn]struct{}{},
	}
	go s.acceptLoop()
	return s, nil
}

// Addr returns the bound address.
func (s *TCPServer) Addr() net.Addr { return s.ln.Addr() }

// Stats returns a snapshot of the counters.
func (s *TCPServer) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats
}

// TakeStats returns completed-connection bytes and the live connection count.
// reset clears the completed counters so the next call is a delta. Live
// connections are not cleared.
func (s *TCPServer) TakeStats(reset bool) (stats Stats, current int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats = s.stats
	current = len(s.conns) / 2
	if reset {
		s.stats = Stats{}
	}
	return stats, current
}

// Close stops the listener and every live connection.
func (s *TCPServer) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]net.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	err := s.ln.Close()
	for _, c := range conns {
		_ = c.Close()
	}
	return err
}

func (s *TCPServer) acceptLoop() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				logx.Warnf("forward: tcp accept on %s: %v", s.ListenAddr, err)
			}
			return
		}
		go s.handle(c)
	}
}

func (s *TCPServer) handle(c net.Conn) {
	if s.Allow != nil && !s.Allow(c.RemoteAddr()) {
		logx.Warnf("forward: admission rejected %s", c.RemoteAddr())
		_ = c.Close()
		return
	}
	target := s.Target
	var done func()
	if s.Pick != nil {
		if picked, end := s.Pick(c.RemoteAddr()); picked != "" {
			target = picked
			done = end
		}
	}
	if done != nil {
		defer done()
	}
	if s.OnAccept != nil {
		s.OnAccept(c.RemoteAddr().String(), target)
	}
	if s.ProxyV1 {
		wrapped, err := consumeProxyV1(c)
		if err != nil {
			logx.Warnf("forward: proxy protocol on %s: %v", s.ListenAddr, err)
			_ = c.Close()
			return
		}
		c = wrapped
	}
	if len(s.Block) > 0 {
		peeked, name, err := peekProtocol(c)
		if err != nil {
			logx.Warnf("forward: sniff on %s: %v", s.ListenAddr, err)
			_ = c.Close()
			return
		}
		if sniff.Reject(s.Block, s.SniffFallback, name) {
			logx.Warnf("forward: blocked %s on %s", name, s.ListenAddr)
			_ = c.Close()
			return
		}
		c = peeked
	}
	if s.Bypass != nil && s.Bypass(target) {
		logx.Warnf("forward: bypass %s", target)
		_ = c.Close()
		return
	}
	if s.Gate != nil && !s.Gate.Enter(c.RemoteAddr()) {
		logx.Warnf("forward: limit rejected %s", c.RemoteAddr())
		_ = c.Close()
		return
	}
	if s.Gate != nil {
		defer s.Gate.Leave(c.RemoteAddr())
	}
	start := time.Now()
	up, err := net.DialTimeout("tcp", target, 15*time.Second)
	if s.Observe != nil && s.Pick != nil {
		d := time.Since(start)
		if err != nil {
			d = dialFail
		}
		s.Observe(target, d)
	}
	if err != nil {
		logx.Warnf("forward: tcp dial %s: %v", target, err)
		_ = c.Close()
		return
	}
	s.mu.Lock()
	s.stats.Conns++
	s.conns[c] = struct{}{}
	s.conns[up] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.conns, c)
		delete(s.conns, up)
		s.mu.Unlock()
		_ = c.Close()
		_ = up.Close()
	}()

	var in, out int64
	finished := make(chan struct{}, 2)
	go func() {
		n, _ := io.Copy(up, limit.NewReader(c, s.Gate, c.RemoteAddr()))
		in = n
		if tc, ok := up.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		finished <- struct{}{}
	}()
	go func() {
		n, _ := io.Copy(c, limit.NewReader(up, s.Gate, c.RemoteAddr()))
		out = n
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		finished <- struct{}{}
	}()
	<-finished
	<-finished

	s.mu.Lock()
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

// UDPServer forwards a local UDP port to one fixed target, keeping a
// per-client session so replies find their way back.
type UDPServer struct {
	ListenAddr string
	Target     string
	// Allow rejects a remote address that fails the panel admission list.
	Allow func(net.Addr) bool
	// Bypass reports that the forward target must not be dialled.
	Bypass func(addr string) bool
	// Gate counts one session as a connection and delays payload bytes.
	Gate *limit.Gate
	// Pick chooses the dial target for a new session. Nil uses Target.
	Pick func(client net.Addr) (target string, done func())
	// Observe records how long the dial took.
	Observe func(addr string, d time.Duration)
	// Idle is how long a client session lives without a packet. Zero uses
	// udpSessionIdle. The panel's keepalive listener uses gost's 5s default.
	Idle time.Duration

	conn *net.UDPConn

	mu      sync.Mutex
	closed  bool
	clients map[string]*udpSession
	stats   Stats
}

type udpSession struct {
	conn     *net.UDPConn
	client   *net.UDPAddr
	lastSeen time.Time
	held     bool
	done     func()
}

const udpSessionIdle = 60 * time.Second

func (s *UDPServer) idle() time.Duration {
	if s != nil && s.Idle > 0 {
		return s.Idle
	}
	return udpSessionIdle
}

// StartUDP binds listenAddr and forwards datagrams to target.
func StartUDP(listenAddr, target string, allow func(net.Addr) bool, bypass func(string) bool, gate *limit.Gate, pick func(net.Addr) (string, func())) (*UDPServer, error) {
	if target == "" {
		return nil, errors.New("forward: empty target")
	}
	laddr, err := net.ResolveUDPAddr("udp", listenAddr)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", laddr)
	if err != nil {
		return nil, err
	}
	s := &UDPServer{
		ListenAddr: listenAddr,
		Target:     target,
		Allow:      allow,
		Bypass:     bypass,
		Gate:       gate,
		Pick:       pick,
		conn:       conn,
		clients:    map[string]*udpSession{},
	}
	go s.readLoop()
	go s.reapLoop()
	return s, nil
}

// Addr returns the bound address.
func (s *UDPServer) Addr() net.Addr { return s.conn.LocalAddr() }

// Close stops the listener and all sessions.
func (s *UDPServer) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	sessions := make([]*udpSession, 0, len(s.clients))
	for _, sess := range s.clients {
		sessions = append(sessions, sess)
	}
	s.clients = map[string]*udpSession{}
	s.mu.Unlock()
	err := s.conn.Close()
	for _, sess := range sessions {
		s.release(sess)
		_ = sess.conn.Close()
	}
	return err
}

func (s *UDPServer) release(sess *udpSession) {
	if sess == nil {
		return
	}
	if sess.done != nil {
		sess.done()
		sess.done = nil
	}
	if !sess.held {
		return
	}
	sess.held = false
	if s.Gate != nil {
		s.Gate.Leave(sess.client)
	}
}

// Stats returns a snapshot of the counters.
func (s *UDPServer) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats
}

// TakeStats returns byte counters and the live session count. reset clears
// the byte counters so the next call is a delta.
func (s *UDPServer) TakeStats(reset bool) (stats Stats, current int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stats = s.stats
	current = len(s.clients)
	if reset {
		s.stats = Stats{}
	}
	return stats, current
}

func (s *UDPServer) readLoop() {
	buf := make([]byte, 65535)
	for {
		n, addr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				logx.Warnf("forward: udp read on %s: %v", s.ListenAddr, err)
			}
			return
		}
		if s.Allow != nil && !s.Allow(addr) {
			logx.Debugf("forward: udp admission rejected %s", addr)
			continue
		}
		if s.Gate != nil {
			s.Gate.Wait(addr, n)
		}
		sess, err := s.session(addr)
		if err != nil {
			logx.Warnf("forward: udp session for %s -> %s: %v", addr, s.Target, err)
			continue
		}
		if _, err := sess.conn.Write(buf[:n]); err != nil {
			logx.Debugf("forward: udp write to %s: %v", s.Target, err)
			continue
		}
		s.mu.Lock()
		s.stats.In += int64(n)
		s.stats.Conns = int64(len(s.clients))
		s.mu.Unlock()
	}
}

func (s *UDPServer) session(client *net.UDPAddr) (*udpSession, error) {
	key := client.String()
	s.mu.Lock()
	if sess, ok := s.clients[key]; ok {
		sess.lastSeen = time.Now()
		s.mu.Unlock()
		return sess, nil
	}
	s.mu.Unlock()

	if s.Gate != nil && !s.Gate.Enter(client) {
		logx.Debugf("forward: udp limit rejected %s", client)
		return nil, errors.New("forward: connection limit")
	}
	abandon := func() {
		if s.Gate != nil {
			s.Gate.Leave(client)
		}
	}
	target := s.Target
	var done func()
	if s.Pick != nil {
		if picked, end := s.Pick(client); picked != "" {
			target = picked
			done = end
		}
	}
	if s.Bypass != nil && s.Bypass(target) {
		if done != nil {
			done()
		}
		logx.Debugf("forward: udp bypass %s", target)
		return nil, errors.New("forward: bypass")
	}
	raddr, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		abandon()
		if done != nil {
			done()
		}
		return nil, err
	}
	start := time.Now()
	conn, err := net.DialUDP("udp", nil, raddr)
	if s.Observe != nil && s.Pick != nil {
		d := time.Since(start)
		if err != nil {
			d = dialFail
		}
		s.Observe(target, d)
	}
	if err != nil {
		abandon()
		if done != nil {
			done()
		}
		return nil, err
	}
	sess := &udpSession{conn: conn, client: client, lastSeen: time.Now(), held: s.Gate != nil, done: done}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		s.release(sess)
		_ = conn.Close()
		return nil, errors.New("forward: server closed")
	}
	if old, ok := s.clients[key]; ok {
		s.mu.Unlock()
		s.release(sess)
		_ = conn.Close()
		return old, nil
	}
	s.clients[key] = sess
	s.mu.Unlock()

	go s.relayBack(sess, key)
	return sess, nil
}

func (s *UDPServer) relayBack(sess *udpSession, key string) {
	buf := make([]byte, 65535)
	for {
		_ = sess.conn.SetReadDeadline(time.Now().Add(s.idle()))
		n, err := sess.conn.Read(buf)
		if err != nil {
			return
		}
		if s.Gate != nil {
			s.Gate.Wait(sess.client, n)
		}
		if _, err := s.conn.WriteToUDP(buf[:n], sess.client); err != nil {
			return
		}
		s.mu.Lock()
		s.stats.Out += int64(n)
		s.mu.Unlock()
	}
}

func (s *UDPServer) reapLoop() {
	for {
		idle := s.idle()
		tick := 30 * time.Second
		if half := idle / 2; half < tick {
			tick = half
		}
		if tick < time.Second {
			tick = time.Second
		}
		timer := time.NewTimer(tick)
		<-timer.C
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()
		s.reapOnce(time.Now())
	}
}

func (s *UDPServer) reapOnce(now time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k, sess := range s.clients {
		if now.Sub(sess.lastSeen) > s.idle() {
			s.release(sess)
			_ = sess.conn.Close()
			delete(s.clients, k)
			n++
		}
	}
	return n
}

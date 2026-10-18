package relay

import (
	"io"
	"net"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
)

// Server accepts gost-relay CONNECT requests and dials the address feature.
// Username/password are required only when at least one of them is set.
// AllowBind turns on CmdBind, used by the entrance side of a remote port-forward.
type Server struct {
	Username  string
	Password  string
	AllowBind bool
	// Bypass reports that a CONNECT target must not be dialled.
	Bypass func(addr string) bool
	// Block is handler metadata "block.protocol". After CONNECT succeeds the
	// first payload bytes are named and a match is closed instead of spliced.
	Block []string
	// SniffFallback is metadata "sniffing.fallback".
	SniffFallback bool

	ln    net.Listener
	binds []net.Listener
	pcs   []net.PacketConn

	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}
	stats  forward.Stats
}

// TakeStats reports bytes copied for the panel observer.
func (s *Server) TakeStats(reset bool) (forward.Stats, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stats
	cur := len(s.conns)
	if reset {
		s.stats = forward.Stats{}
	}
	return st, cur
}

// Listen binds addr and starts accepting.
func (s *Server) Listen(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln
	s.mu.Lock()
	if s.conns == nil {
		s.conns = map[net.Conn]struct{}{}
	}
	s.mu.Unlock()
	go s.acceptLoop()
	return nil
}

// Addr returns the bound address.
func (s *Server) Addr() net.Addr {
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

// Close stops accepting and closes live connections.
func (s *Server) Close() error {
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
	ln := s.ln
	binds := append([]net.Listener(nil), s.binds...)
	pcs := append([]net.PacketConn(nil), s.pcs...)
	s.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	for _, c := range conns {
		_ = c.Close()
	}
	for _, b := range binds {
		_ = b.Close()
	}
	for _, pc := range pcs {
		_ = pc.Close()
	}
	return nil
}

func (s *Server) acceptLoop() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				logx.Warnf("relay: accept on %s: %v", s.ln.Addr(), err)
			}
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = c.Close()
			return
		}
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		go s.serve(c)
	}
}

func (s *Server) drop(c net.Conn) {
	_ = c.Close()
	s.mu.Lock()
	delete(s.conns, c)
	s.mu.Unlock()
}

func (s *Server) authRequired() bool {
	return s.Username != "" || s.Password != ""
}

// ServeConn runs the relay handshake on an already-accepted connection. The
// relayx listener uses it for each smux stream.
func (s *Server) ServeConn(c net.Conn) {
	s.mu.Lock()
	if s.conns == nil {
		s.conns = map[net.Conn]struct{}{}
	}
	if s.closed {
		s.mu.Unlock()
		_ = c.Close()
		return
	}
	s.conns[c] = struct{}{}
	s.mu.Unlock()
	s.serve(c)
}

func (s *Server) serve(c net.Conn) {
	defer s.drop(c)
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	second, feats, err := readMsg(c)
	if err != nil {
		return
	}
	cmd := second & cmdMask
	if cmd != cmdConnect && cmd != cmdBind {
		_ = writeMsg(c, statusBadRequest, nil)
		return
	}
	if s.authRequired() {
		user, pass, ok := findAuth(feats)
		if !ok || user != s.Username || pass != s.Password {
			_ = writeMsg(c, statusUnauthorized, nil)
			return
		}
	}
	if wantsUDP(feats) || second&cmdFUDP != 0 {
		if cmd == cmdBind && s.AllowBind {
			s.serveBindUDP(c, feats)
			return
		}
		_ = writeMsg(c, statusBadRequest, nil)
		return
	}
	if cmd == cmdBind {
		if !s.AllowBind {
			_ = writeMsg(c, statusBadRequest, nil)
			return
		}
		s.serveBind(c, feats)
		return
	}
	addr, err := findAddr(feats)
	if err != nil {
		_ = writeMsg(c, statusBadRequest, nil)
		return
	}
	if s.Bypass != nil && s.Bypass(addr) {
		logx.Warnf("relay: bypass %s", addr)
		_ = writeMsg(c, statusHostUnreach, nil)
		return
	}
	dst, err := (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", addr)
	if err != nil {
		_ = writeMsg(c, statusHostUnreach, nil)
		return
	}
	defer dst.Close()
	_ = c.SetDeadline(time.Time{})
	if err := writeMsg(c, statusOK, nil); err != nil {
		return
	}
	if len(s.Block) > 0 {
		peeked, name, err := sniff.Peek(c)
		if err != nil {
			logx.Warnf("relay: sniff: %v", err)
			return
		}
		if sniff.Reject(s.Block, s.SniffFallback, name) {
			logx.Warnf("relay: blocked %s to %s", name, addr)
			return
		}
		c = peeked
	}
	in, out := splice(c, dst)
	s.mu.Lock()
	s.stats.Conns++
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

// Handshake sends CONNECT for addr on an already-dialed relay connection.
func Handshake(conn net.Conn, addr, user, pass string) error {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	defer conn.SetDeadline(time.Time{})
	var feats []feature
	if user != "" || pass != "" {
		af, err := userAuthFeature(user, pass)
		if err != nil {
			return err
		}
		feats = append(feats, af)
	}
	af, err := addrFeature(addr)
	if err != nil {
		return err
	}
	feats = append(feats, af)
	if err := writeMsg(conn, cmdConnect, feats); err != nil {
		return err
	}
	status, _, err := readMsg(conn)
	if err != nil {
		return err
	}
	if status != statusOK {
		return fmtStatus(status)
	}
	return nil
}

func fmtStatus(status byte) error {
	switch status {
	case statusBadRequest:
		return errStatus("bad request")
	case statusUnauthorized:
		return errStatus("unauthorized")
	case statusServiceUnavail:
		return errStatus("service unavailable")
	case statusHostUnreach:
		return errStatus("host unreachable")
	default:
		return errStatus("rejected")
	}
}

type statusError string

func (e statusError) Error() string { return "relay: " + string(e) }

func errStatus(s string) error { return statusError(s) }

func splice(a, b net.Conn) (in, out int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		n, _ := io.Copy(b, a)
		in = n
		closeWrite(b)
	}()
	go func() {
		defer wg.Done()
		n, _ := io.Copy(a, b)
		out = n
		closeWrite(a)
	}()
	wg.Wait()
	return in, out
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
	}
}

// Package socks5 implements the SOCKS5 server the panel asks for when a tunnel's
// listen_protocol.type is "socks5" (handler type socks5, metadata.udp=true).
//
// The replica speaks RFC 1928 CONNECT and UDP ASSOCIATE, plus RFC 1929
// username/password when the handler carries auth. BIND is rejected. The
// destination is the address inside the request, not the forwarder target —
// same as gost's handler/socks/v5. A separate UDP listener with handler socks5
// is served by UDPServer (udp.go): datagrams are already in the RFC 1928 UDP
// request layout, with no TCP handshake.
package socks5

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
	"github.com/relayx/agent/internal/socksaddr"
)

const (
	version          = 0x05
	authNone         = 0x00
	authUserPass     = 0x02
	authNoAcceptable = 0xff

	cmdConnect = 0x01
	cmdBind    = 0x02
	cmdUDP     = 0x03

	repOK           = 0x00
	repFailure      = 0x01
	repNotAllowed   = 0x02
	repHostUnreach  = 0x04
	repConnRefused  = 0x05
	repCmdUnsupport = 0x07
	repAtypUnsup    = 0x08

	userPassVersion = 0x01
)

// Server is a SOCKS5 TCP listener.
type Server struct {
	Username string
	Password string
	// AllowUDP accepts UDP ASSOCIATE. The panel always sets metadata.udp=true
	// on a socks5 handler; the manager turns that into this flag.
	AllowUDP bool
	// Block is handler metadata "block.protocol". A recognized protocol on
	// that list is not copied to the CONNECT target.
	Block []string
	// SniffFallback is metadata "sniffing.fallback".
	SniffFallback bool
	// Allow rejects a remote address that fails the panel admission list.
	Allow func(net.Addr) bool
	// Bypass reports that a CONNECT target must not be dialled.
	Bypass func(addr string) bool
	// Gate is the panel connection and bandwidth limit.
	Gate *limit.Gate
	// ProxyV1 requires a HAProxy PROXY v1 header before the SOCKS greeting.
	ProxyV1 bool
	// Dial, when set, reaches the CONNECT target (through a chain). Nil dials
	// the address directly. client is the accepted connection's remote address.
	Dial func(client net.Addr, target string) (net.Conn, error)

	ln net.Listener

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
	s.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	for _, c := range conns {
		_ = c.Close()
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
				logx.Warnf("socks5: accept on %s: %v", s.ln.Addr(), err)
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

func (s *Server) serve(c net.Conn) {
	defer s.drop(c)
	if s.Allow != nil && !s.Allow(c.RemoteAddr()) {
		logx.Warnf("socks5: admission rejected %s", c.RemoteAddr())
		return
	}
	if s.Gate != nil && !s.Gate.Enter(c.RemoteAddr()) {
		logx.Warnf("socks5: limit rejected %s", c.RemoteAddr())
		return
	}
	if s.Gate != nil {
		defer s.Gate.Leave(c.RemoteAddr())
	}
	if s.ProxyV1 {
		wrapped, err := forward.ConsumeProxyV1(c)
		if err != nil {
			logx.Warnf("socks5: proxy protocol: %v", err)
			return
		}
		c = wrapped
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	if err := s.handshake(c); err != nil {
		return
	}
	cmd, addr, err := readRequest(c)
	if err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	switch cmd {
	case cmdConnect:
		s.connect(c, addr)
	case cmdUDP:
		if !s.AllowUDP {
			_ = writeReply(c, repCmdUnsupport, nil)
			return
		}
		s.associate(c)
	default:
		_ = writeReply(c, repCmdUnsupport, nil)
	}
}

func (s *Server) handshake(c net.Conn) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(c, head); err != nil {
		return err
	}
	if head[0] != version {
		return fmt.Errorf("socks5: version %d", head[0])
	}
	nmethods := int(head[1])
	methods := make([]byte, nmethods)
	if _, err := io.ReadFull(c, methods); err != nil {
		return err
	}
	want := byte(authNone)
	if s.authRequired() {
		want = authUserPass
	}
	offered := false
	for _, m := range methods {
		if m == want {
			offered = true
			break
		}
	}
	if !offered {
		_, _ = c.Write([]byte{version, authNoAcceptable})
		return errors.New("socks5: no acceptable method")
	}
	if _, err := c.Write([]byte{version, want}); err != nil {
		return err
	}
	if want == authNone {
		return nil
	}
	return s.userPass(c)
}

func (s *Server) userPass(c net.Conn) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(c, head); err != nil {
		return err
	}
	if head[0] != userPassVersion {
		_, _ = c.Write([]byte{userPassVersion, 0x01})
		return fmt.Errorf("socks5: user/pass version %d", head[0])
	}
	ulen := int(head[1])
	user := make([]byte, ulen)
	if _, err := io.ReadFull(c, user); err != nil {
		return err
	}
	var plen [1]byte
	if _, err := io.ReadFull(c, plen[:]); err != nil {
		return err
	}
	pass := make([]byte, int(plen[0]))
	if _, err := io.ReadFull(c, pass); err != nil {
		return err
	}
	if string(user) != s.Username || string(pass) != s.Password {
		_, _ = c.Write([]byte{userPassVersion, 0x01})
		return errors.New("socks5: authentication failed")
	}
	_, err := c.Write([]byte{userPassVersion, 0x00})
	return err
}

func readRequest(r io.Reader) (byte, socksaddr.Addr, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, socksaddr.Addr{}, err
	}
	if head[0] != version {
		return 0, socksaddr.Addr{}, fmt.Errorf("socks5: request version %d", head[0])
	}
	rest, err := readAddrRest(r, head[3])
	if err != nil {
		return head[1], socksaddr.Addr{}, err
	}
	buf := append([]byte{head[3]}, rest...)
	addr, _, err := socksaddr.Parse(buf)
	if err != nil {
		return head[1], socksaddr.Addr{}, err
	}
	return head[1], addr, nil
}

func readAddrRest(r io.Reader, atyp byte) ([]byte, error) {
	switch atyp {
	case socksaddr.ATYPIPv4:
		b := make([]byte, 4+2)
		_, err := io.ReadFull(r, b)
		return b, err
	case socksaddr.ATYPIPv6:
		b := make([]byte, 16+2)
		_, err := io.ReadFull(r, b)
		return b, err
	case socksaddr.ATYPDomain:
		var n [1]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return nil, err
		}
		b := make([]byte, int(n[0])+2)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, err
		}
		return append(n[:], b...), nil
	default:
		return nil, fmt.Errorf("socks5: unsupported ATYP 0x%02x", atyp)
	}
}

func (s *Server) connect(c net.Conn, addr socksaddr.Addr) {
	if s.Bypass != nil && s.Bypass(addr.String()) {
		logx.Warnf("socks5: bypass %s", addr)
		_ = writeReply(c, repNotAllowed, nil)
		return
	}
	var dst net.Conn
	var err error
	if s.Dial != nil {
		dst, err = s.Dial(c.RemoteAddr(), addr.String())
	} else {
		d := net.Dialer{Timeout: 15 * time.Second}
		dst, err = d.Dial("tcp", addr.String())
	}
	if err != nil {
		_ = writeReply(c, dialRep(err), nil)
		return
	}
	defer dst.Close()
	if err := writeReply(c, repOK, dst.LocalAddr()); err != nil {
		return
	}
	if len(s.Block) > 0 {
		peeked, name, err := sniff.Peek(c)
		if err != nil {
			logx.Warnf("socks5: sniff: %v", err)
			return
		}
		if sniff.Reject(s.Block, s.SniffFallback, name) {
			logx.Warnf("socks5: blocked %s", name)
			return
		}
		c = peeked
	}
	in, out := splice(c, dst, s.Gate)
	s.mu.Lock()
	s.stats.Conns++
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

func (s *Server) associate(c net.Conn) {
	host, _, err := net.SplitHostPort(c.LocalAddr().String())
	if err != nil || host == "" {
		host = "0.0.0.0"
	}
	pc, err := net.ListenPacket("udp", net.JoinHostPort(host, "0"))
	if err != nil {
		_ = writeReply(c, repFailure, nil)
		return
	}
	defer pc.Close()
	if err := writeReply(c, repOK, pc.LocalAddr()); err != nil {
		return
	}
	clientIP := ipOf(c.RemoteAddr())
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, c)
		close(done)
		_ = pc.Close()
	}()
	s.mu.Lock()
	s.stats.Conns++
	s.mu.Unlock()
	relayAssociate(pc, clientIP, done, s.addUDP)
}

func (s *Server) addUDP(in, out int64) {
	s.mu.Lock()
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

func splice(a, b net.Conn, gate *limit.Gate) (in, out int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		n, _ := io.Copy(b, limit.NewReader(a, gate, a.RemoteAddr()))
		in = n
		closeWrite(b)
	}()
	go func() {
		defer wg.Done()
		n, _ := io.Copy(a, limit.NewReader(b, gate, a.RemoteAddr()))
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

func writeReply(w io.Writer, rep byte, addr net.Addr) error {
	host := "0.0.0.0"
	var port uint16
	if addr != nil {
		h, p, err := net.SplitHostPort(addr.String())
		if err == nil {
			host = h
			n, _ := strconv.Atoi(p)
			port = uint16(n)
		}
	}
	body, err := socksaddr.Marshal(host, port)
	if err != nil {
		body = []byte{socksaddr.ATYPIPv4, 0, 0, 0, 0, 0, 0}
	}
	buf := make([]byte, 0, 3+len(body))
	buf = append(buf, version, rep, 0x00)
	buf = append(buf, body...)
	_, err = w.Write(buf)
	return err
}

func dialRep(err error) byte {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return repHostUnreach
	}
	var op *net.OpError
	if errors.As(err, &op) {
		msg := op.Err.Error()
		if msg == "connect: connection refused" || msg == "connection refused" {
			return repConnRefused
		}
	}
	if errors.Is(err, errors.ErrUnsupported) {
		return repAtypUnsup
	}
	return repFailure
}

func ipOf(addr net.Addr) net.IP {
	if addr == nil {
		return nil
	}
	h, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return net.ParseIP(addr.String())
	}
	return net.ParseIP(h)
}

// EncodeUDP builds an RFC 1928 UDP request: RSV(2) FRAG(0) ATYP ADDR PORT DATA.
func EncodeUDP(dst socksaddr.Addr, payload []byte) ([]byte, error) {
	hdr, err := socksaddr.Marshal(dst.Host, dst.Port)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, 3+len(hdr)+len(payload))
	out = append(out, 0, 0, 0)
	out = append(out, hdr...)
	out = append(out, payload...)
	return out, nil
}

// DecodeUDP parses an RFC 1928 UDP request. Non-zero FRAG is rejected; the
// replica does not reassemble fragments.
func DecodeUDP(packet []byte) (socksaddr.Addr, []byte, error) {
	if len(packet) < 4 {
		return socksaddr.Addr{}, nil, io.ErrUnexpectedEOF
	}
	if packet[2] != 0 {
		return socksaddr.Addr{}, nil, errors.New("socks5: fragmented udp packet")
	}
	addr, n, err := socksaddr.Parse(packet[3:])
	if err != nil {
		return socksaddr.Addr{}, nil, err
	}
	return addr, packet[3+n:], nil
}

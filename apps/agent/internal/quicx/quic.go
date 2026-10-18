// Package quicx is the gost QUIC transport used when a tunnel's type is quic.
// Each accepted stream is a plain connection the relay handler can serve.
// The panel only sends commonName, so the listener mints a fresh self-signed
// certificate and the dialer skips verification, same as a gost node that has
// no CA to pin.
package quicx

import (
	"context"
	"crypto/tls"
	"net"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/selfsign"
)

// quicNextProtos matches go-gost/x listener/quic and dialer/quic when metadata
// does not set an ALPN. Both sides must advertise the same list.
var quicNextProtos = []string{"h3", "quic/v1"}

// Server accepts QUIC streams and hands each one to Serve.
type Server struct {
	// Name is the certificate common name (the panel's tls.commonName).
	Name  string
	Serve func(net.Conn)

	pc  net.PacketConn
	ln  *quic.EarlyListener
	tls *tls.Config
}

// Listen binds a UDP socket and starts accepting.
func (s *Server) Listen(addr string) error {
	ua, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	pc, err := net.ListenUDP("udp", ua)
	if err != nil {
		return err
	}
	tlsCfg, err := selfsign.Server(s.Name, quicNextProtos)
	if err != nil {
		_ = pc.Close()
		return err
	}
	ln, err := quic.ListenEarly(pc, tlsCfg, quicConfig())
	if err != nil {
		_ = pc.Close()
		return err
	}
	s.pc = pc
	s.ln = ln
	s.tls = tlsCfg
	go s.acceptLoop()
	return nil
}

// Addr is the bound UDP address.
func (s *Server) Addr() net.Addr {
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

// Close stops the listener.
func (s *Server) Close() error {
	var err error
	if s.ln != nil {
		err = s.ln.Close()
	}
	if s.pc != nil {
		_ = s.pc.Close()
	}
	return err
}

func (s *Server) acceptLoop() {
	for {
		sess, err := s.ln.Accept(context.Background())
		if err != nil {
			return
		}
		go s.mux(sess)
	}
}

func (s *Server) mux(sess *quic.Conn) {
	defer sess.CloseWithError(0, "closed")
	for {
		stream, err := sess.AcceptStream(context.Background())
		if err != nil {
			return
		}
		conn := &streamConn{Stream: stream, laddr: sess.LocalAddr(), raddr: sess.RemoteAddr()}
		if s.Serve != nil {
			go s.Serve(conn)
		} else {
			_ = stream.Close()
		}
	}
}

func quicConfig() *quic.Config {
	return &quic.Config{
		KeepAlivePeriod:      10 * time.Second,
		HandshakeIdleTimeout: 15 * time.Second,
		MaxIdleTimeout:       30 * time.Second,
		Versions:             []quic.Version{quic.Version1, quic.Version2},
	}
}

type shared struct {
	pc   net.PacketConn
	conn *quic.Conn
}

var (
	sessMu sync.Mutex
	sess   = map[string]*shared{}
)

// Dial opens one stream on a shared QUIC session to addr. name is the SNI
// (tls.commonName). Verification is skipped: the listener's key is generated
// per process and the panel does not distribute it.
func Dial(addr, name string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	sessMu.Lock()
	sh := sess[addr]
	if sh != nil && sh.conn.Context().Err() != nil {
		delete(sess, addr)
		sh = nil
	}
	if sh == nil {
		pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			sessMu.Unlock()
			return nil, err
		}
		ua, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			_ = pc.Close()
			sessMu.Unlock()
			return nil, err
		}
		conn, err := quic.DialEarly(ctx, pc, ua, selfsign.Client(name, quicNextProtos), quicConfig())
		if err != nil {
			_ = pc.Close()
			sessMu.Unlock()
			logx.Warnf("quic: dial %s: %v", addr, err)
			return nil, err
		}
		sh = &shared{pc: pc, conn: conn}
		sess[addr] = sh
	}
	c := sh.conn
	sessMu.Unlock()

	stream, err := c.OpenStreamSync(ctx)
	if err != nil {
		sessMu.Lock()
		if sess[addr] != nil && sess[addr].conn == c {
			delete(sess, addr)
		}
		sessMu.Unlock()
		_ = c.CloseWithError(0, "open stream")
		return nil, err
	}
	return &streamConn{Stream: stream, laddr: c.LocalAddr(), raddr: c.RemoteAddr()}, nil
}

// streamConn adapts a QUIC stream to net.Conn.
type streamConn struct {
	*quic.Stream
	laddr net.Addr
	raddr net.Addr
}

func (c *streamConn) LocalAddr() net.Addr  { return c.laddr }
func (c *streamConn) RemoteAddr() net.Addr { return c.raddr }

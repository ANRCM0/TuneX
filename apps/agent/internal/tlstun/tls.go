// Package tlstun is the gost tls and mtls transport. tls is one relay
// connection per TLS session. mtls is smux v1 over that TLS session, which is
// what the panel emits when the tunnel type is mtls.
package tlstun

import (
	"crypto/tls"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/relayx/agent/internal/selfsign"
	"github.com/xtaci/smux"
)

// Server accepts TLS connections. Mux wraps each one in an smux server and
// hands streams to Serve; otherwise Serve gets the TLS connection itself.
type Server struct {
	Name  string
	Mux   bool
	Serve func(net.Conn)

	ln net.Listener

	mu       sync.Mutex
	sessions []*smux.Session
}

// Listen binds addr.
func (s *Server) Listen(addr string) error {
	raw, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	cfg, err := selfsign.Server(s.Name, nil)
	if err != nil {
		_ = raw.Close()
		return err
	}
	s.ln = tls.NewListener(raw, cfg)
	go s.acceptLoop()
	return nil
}

// Addr is the bound address.
func (s *Server) Addr() net.Addr {
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

// Close stops the listener and open mux sessions.
func (s *Server) Close() error {
	var err error
	if s.ln != nil {
		err = s.ln.Close()
	}
	s.mu.Lock()
	sessions := s.sessions
	s.sessions = nil
	s.mu.Unlock()
	for _, sess := range sessions {
		_ = sess.Close()
	}
	return err
}

func (s *Server) acceptLoop() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		if !s.Mux {
			if s.Serve != nil {
				go s.Serve(c)
			} else {
				_ = c.Close()
			}
			continue
		}
		go s.mux(c)
	}
}

func (s *Server) mux(c net.Conn) {
	session, err := smux.Server(c, smuxConfig())
	if err != nil {
		_ = c.Close()
		return
	}
	s.mu.Lock()
	s.sessions = append(s.sessions, session)
	s.mu.Unlock()
	for {
		stream, err := session.AcceptStream()
		if err != nil {
			return
		}
		if s.Serve != nil {
			go s.Serve(stream)
		} else {
			_ = stream.Close()
		}
	}
}

func smuxConfig() *smux.Config {
	cfg := smux.DefaultConfig()
	cfg.Version = 1
	return cfg
}

type shared struct {
	session *smux.Session
}

var (
	sessMu sync.Mutex
	sess   = map[string]*shared{}
)

// Dial speaks TLS to addr. kind "mtls" opens one smux stream on a session
// cached per address. Any other kind returns the TLS connection itself.
func Dial(kind, addr, name string) (net.Conn, error) {
	if kind != "mtls" {
		return dialTLS(addr, name)
	}
	sessMu.Lock()
	sh := sess[addr]
	if sh != nil && sh.session.IsClosed() {
		delete(sess, addr)
		sh = nil
	}
	if sh == nil {
		conn, err := dialTLS(addr, name)
		if err != nil {
			sessMu.Unlock()
			return nil, err
		}
		session, err := smux.Client(conn, smuxConfig())
		if err != nil {
			_ = conn.Close()
			sessMu.Unlock()
			return nil, err
		}
		sh = &shared{session: session}
		sess[addr] = sh
	}
	session := sh.session
	sessMu.Unlock()
	stream, err := session.OpenStream()
	if err != nil {
		sessMu.Lock()
		if cur := sess[addr]; cur != nil && cur.session == session {
			delete(sess, addr)
		}
		sessMu.Unlock()
		_ = session.Close()
		return nil, err
	}
	return stream, nil
}

func dialTLS(addr, name string) (net.Conn, error) {
	raw, err := net.DialTimeout("tcp", addr, 15*time.Second)
	if err != nil {
		return nil, err
	}
	conn := tls.Client(raw, selfsign.Client(name, nil))
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	err = conn.Handshake()
	_ = conn.SetDeadline(time.Time{})
	if err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("tls: handshake: %w", err)
	}
	return conn, nil
}

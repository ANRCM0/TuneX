// Package mtcp is the gost mtcp transport: smux v1 over a plain TCP
// connection, with the session reused per address. The panel emits it when
// the tunnel type is mtcp.
package mtcp

import (
	"net"
	"sync"
	"time"

	"github.com/xtaci/smux"
)

// Server accepts TCP connections, wraps each in an smux server, and hands
// every stream to Serve.
type Server struct {
	Serve func(net.Conn)

	ln net.Listener

	mu       sync.Mutex
	sessions []*smux.Session
}

// Listen binds addr.
func (s *Server) Listen(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln
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

type shared struct {
	session *smux.Session
}

var (
	sessMu sync.Mutex
	sess   = map[string]*shared{}
)

// Dial opens one smux stream on a session cached for addr.
func Dial(addr string) (net.Conn, error) {
	sessMu.Lock()
	sh := sess[addr]
	if sh != nil && sh.session.IsClosed() {
		delete(sess, addr)
		sh = nil
	}
	if sh == nil {
		conn, err := (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", addr)
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

func smuxConfig() *smux.Config {
	cfg := smux.DefaultConfig()
	cfg.Version = 1
	return cfg
}

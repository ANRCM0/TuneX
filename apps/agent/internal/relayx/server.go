package relayx

import (
	"crypto/rand"
	"crypto/tls"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/selfsign"
	"github.com/xtaci/smux"
)

// Server is the out-node listener. It upgrades HTTP to websocket, checks the
// Bearer token, writes the mux-signal message, and hands each smux stream to
// Serve. An empty Path accepts every request path, because the panel only
// sends the key.
type Server struct {
	Key   string
	Path  string
	Skew  time.Duration
	Serve func(net.Conn)

	ln     net.Listener
	http   *http.Server
	replay Replay

	mu       sync.Mutex
	sessions []*smux.Session
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

// Listen binds addr and serves the upgrade handler.
func (s *Server) Listen(addr string) error {
	tcpLn, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	tlsCfg, err := selfsign.Server("relayx", nil)
	if err != nil {
		_ = tcpLn.Close()
		return err
	}
	ln := tls.NewListener(tcpLn, tlsCfg)
	s.ln = ln
	s.http = &http.Server{Handler: http.HandlerFunc(s.upgrade)}
	go func() {
		if err := s.http.Serve(ln); err != nil && err != http.ErrServerClosed {
			logx.Warnf("relayx: %s: %v", addr, err)
		}
	}()
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
	if s.http != nil {
		err = s.http.Close()
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

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request) {
	if s.Path != "" && r.URL.Path != s.Path {
		http.NotFound(w, r)
		return
	}
	token, err := ParseAuthorization(r.Header.Get("Authorization"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	mux, err := Validate(s.Key, token, time.Now(), s.Skew, &s.replay)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	signal := make([]byte, 64)
	if _, err := rand.Read(signal); err != nil {
		_ = ws.Close()
		return
	}
	signal[0] &^= 0x01
	if mux {
		signal[0] |= 0x01
	}
	if err := ws.WriteMessage(websocket.BinaryMessage, signal); err != nil {
		_ = ws.Close()
		return
	}
	conn := &wsConn{ws: ws}
	if !mux {
		if s.Serve != nil {
			s.Serve(conn)
		} else {
			_ = conn.Close()
		}
		return
	}
	session, err := smux.Server(conn, smuxConfig())
	if err != nil {
		_ = conn.Close()
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

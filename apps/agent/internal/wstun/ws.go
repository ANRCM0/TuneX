// Package wstun is the gost ws, wss, mws and mwss transport. wss is one
// relay connection per websocket. mwss is smux v1 over that websocket.
// ws and mws are the same two shapes without TLS. TLS uses the same
// self-signed certificate as the tls listener: the panel does not ship a key.
package wstun

import (
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/relayx/agent/internal/selfsign"
	"github.com/xtaci/smux"
)

// DefaultPath is gost's ws.path when the panel leaves it empty.
const DefaultPath = "/ws"

// Server accepts connections and upgrades /path to a websocket.
// Mux wraps each websocket in an smux server. Plain skips TLS.
type Server struct {
	Name  string
	Path  string
	Mux   bool
	Plain bool
	Serve func(net.Conn)

	ln  net.Listener
	srv *http.Server

	mu       sync.Mutex
	sessions []*smux.Session
}

// Listen binds addr.
func (s *Server) Listen(addr string) error {
	raw, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	ln := raw
	if !s.Plain {
		cfg, err := selfsign.Server(s.Name, nil)
		if err != nil {
			_ = raw.Close()
			return err
		}
		ln = tls.NewListener(raw, cfg)
	}
	path := s.Path
	if path == "" {
		path = DefaultPath
	}
	if path[0] != '/' {
		path = "/" + path
	}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		c := &wsConn{ws: ws}
		if !s.Mux {
			if s.Serve != nil {
				go s.Serve(c)
			} else {
				_ = c.Close()
			}
			return
		}
		go s.mux(c)
	})
	s.ln = ln
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second}
	go func() { _ = s.srv.Serve(s.ln) }()
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
	if s.srv != nil {
		err = s.srv.Close()
	} else if s.ln != nil {
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

// Dial opens a websocket to addr. kind "mwss" or "mws" opens one smux
// stream on a session cached per address and kind. "ws" and "wss" return
// the websocket itself. "ws" and "mws" do not use TLS.
func Dial(kind, addr, name, path string) (net.Conn, error) {
	if kind != "mwss" && kind != "mws" {
		return dialWS(kind, addr, name, path)
	}
	key := kind + " " + addr + " " + path
	sessMu.Lock()
	sh := sess[key]
	if sh != nil && sh.session.IsClosed() {
		delete(sess, key)
		sh = nil
	}
	if sh == nil {
		conn, err := dialWS(kind, addr, name, path)
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
		sess[key] = sh
	}
	session := sh.session
	sessMu.Unlock()
	stream, err := session.OpenStream()
	if err != nil {
		sessMu.Lock()
		if cur := sess[key]; cur != nil && cur.session == session {
			delete(sess, key)
		}
		sessMu.Unlock()
		_ = session.Close()
		return nil, err
	}
	return stream, nil
}

func dialWS(kind, addr, name, path string) (net.Conn, error) {
	if path == "" {
		path = DefaultPath
	}
	if path[0] != '/' {
		path = "/" + path
	}
	host := name
	if host == "" {
		host = addr
	}
	scheme := "wss"
	var tlsConfig = selfsign.Client(name, nil)
	if kind == "ws" || kind == "mws" {
		scheme = "ws"
		tlsConfig = nil
	}
	u := url.URL{Scheme: scheme, Host: host, Path: path}
	d := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		TLSClientConfig:  tlsConfig,
		NetDial: func(network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", addr)
		},
	}
	ws, resp, err := d.Dial(u.String(), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("wss: %w", err)
	}
	return &wsConn{ws: ws}, nil
}

type shared struct {
	session *smux.Session
}

var (
	sessMu sync.Mutex
	sess   = map[string]*shared{}
)

func smuxConfig() *smux.Config {
	cfg := smux.DefaultConfig()
	cfg.Version = 1
	return cfg
}

// wsConn presents one websocket as a stream. Each Write is one binary message.
type wsConn struct {
	ws *websocket.Conn
	r  io.Reader
}

func (c *wsConn) Read(p []byte) (int, error) {
	for {
		if c.r == nil {
			_, r, err := c.ws.NextReader()
			if err != nil {
				return 0, err
			}
			c.r = r
		}
		n, err := c.r.Read(p)
		if err == io.EOF {
			c.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *wsConn) Close() error         { return c.ws.Close() }
func (c *wsConn) LocalAddr() net.Addr  { return c.ws.LocalAddr() }
func (c *wsConn) RemoteAddr() net.Addr { return c.ws.RemoteAddr() }
func (c *wsConn) SetDeadline(t time.Time) error {
	_ = c.ws.SetReadDeadline(t)
	return c.ws.SetWriteDeadline(t)
}
func (c *wsConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

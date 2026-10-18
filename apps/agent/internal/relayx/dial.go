package relayx

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	utls "github.com/refraction-networking/utls"
	"github.com/xtaci/smux"
)

// userAgent is a fixed Chrome string. Upstream picks from an 11-entry table
// when metadata does not set one; the value is not authenticated.
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"

// DialOptions describes one relayx hop.
type DialOptions struct {
	Addr string
	Key  string
	Host string
	Path string
	// Mux is the token's high bit. The zero value is true: that is the
	// upstream default, and the panel does not send a mux flag.
	Mux *bool
}

var (
	sessionMu    sync.Mutex
	sessionCache = map[string]*smux.Session{}
)

// Dial upgrades to the listener and returns one stream (or the raw websocket
// when Mux is explicitly false). Mux dials reuse one smux session per
// address, key, host and path.
func Dial(opt DialOptions) (net.Conn, error) {
	mux := true
	if opt.Mux != nil {
		mux = *opt.Mux
	}
	if opt.Addr == "" {
		return nil, fmt.Errorf("relayx: empty address")
	}
	path := opt.Path
	if path == "" {
		path = DefaultPath
	}
	if path[0] != '/' {
		path = "/" + path
	}
	host := opt.Host
	if host == "" {
		if h, _, err := net.SplitHostPort(opt.Addr); err == nil {
			host = h
		} else {
			host = opt.Addr
		}
	}
	if !mux {
		return dialSession(opt, host, path, false)
	}
	key := opt.Addr + "\n" + opt.Key + "\n" + host + "\n" + path
	sessionMu.Lock()
	defer sessionMu.Unlock()
	if sess := sessionCache[key]; sess != nil && !sess.IsClosed() {
		stream, err := sess.OpenStream()
		if err == nil {
			return &streamConn{Stream: stream, session: sess, shared: true}, nil
		}
		delete(sessionCache, key)
		_ = sess.Close()
	}
	conn, err := dialSession(opt, host, path, true)
	if err != nil {
		return nil, err
	}
	sc := conn.(*streamConn)
	sc.shared = true
	sessionCache[key] = sc.session
	return sc, nil
}

func dialSession(opt DialOptions, host, path string, mux bool) (net.Conn, error) {
	token, err := BuildToken(opt.Key, mux, time.Now())
	if err != nil {
		return nil, err
	}
	raw, err := net.DialTimeout("tcp", opt.Addr, 15*time.Second)
	if err != nil {
		return nil, err
	}
	uconn := utls.UClient(raw, &utls.Config{
		ServerName:         host,
		InsecureSkipVerify: true,
	}, utls.HelloChrome_Auto)
	if err := uconn.Handshake(); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("relayx: tls: %w", err)
	}
	u := url.URL{Scheme: "ws", Host: opt.Addr, Path: path}
	header := http.Header{}
	header.Set("Authorization", bearerPrefix+token)
	header.Set("User-Agent", userAgent)
	header.Set("Origin", "https://"+host)
	header.Set("Cache-Control", "no-cache")
	header.Set("Pragma", "no-cache")
	header.Set("Accept-Language", "en-US,en;q=0.9")
	d := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		NetDial: func(string, string) (net.Conn, error) {
			return uconn, nil
		},
	}
	ws, resp, err := d.Dial(u.String(), header)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("relayx: dial %s: %w", resp.Status, err)
		}
		return nil, err
	}
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	_, _, err = ws.ReadMessage()
	_ = ws.SetReadDeadline(time.Time{})
	if err != nil {
		_ = ws.Close()
		return nil, fmt.Errorf("relayx: mux signal: %w", err)
	}
	conn := &wsConn{ws: ws}
	if !mux {
		return conn, nil
	}
	session, err := smux.Client(conn, smuxConfig())
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	stream, err := session.OpenStream()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	return &streamConn{Stream: stream, session: session}, nil
}

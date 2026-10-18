package httpproxy

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
)

// Server is an HTTP proxy entrance. The panel sets handler type "http"
// when listen_protocol.type is http. CONNECT is a tunnel. An absolute-form
// request is forwarded to the origin.
type Server struct {
	Username      string
	Password      string
	Allow         func(net.Addr) bool
	Bypass        func(addr string) bool
	Gate          *limit.Gate
	Block         []string
	SniffFallback bool
	// ProxyV1 requires a HAProxy PROXY v1 header before the HTTP request.
	ProxyV1 bool
	Dial    func(client net.Addr, target string) (net.Conn, error)

	ln    net.Listener
	mu    sync.Mutex
	live  int
	stats forward.Stats
}

// TakeStats reports bytes copied for the panel observer. Input is client
// to origin. reset zeroes the counters but not the live connection count.
func (s *Server) TakeStats(reset bool) (forward.Stats, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stats
	cur := s.live
	if reset {
		s.stats = forward.Stats{}
	}
	return st, cur
}

func (s *Server) add(in, out int64) {
	s.mu.Lock()
	s.stats.Conns++
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

// Listen binds addr and serves until Close.
func (s *Server) Listen(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln
	go s.accept()
	return nil
}

// Addr is the bound address.
func (s *Server) Addr() net.Addr {
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

// Close stops the listener.
func (s *Server) Close() error {
	if s.ln == nil {
		return nil
	}
	return s.ln.Close()
}

func (s *Server) accept() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		if s.Allow != nil && !s.Allow(c.RemoteAddr()) {
			_ = c.Close()
			continue
		}
		go s.serve(c)
	}
}

func (s *Server) serve(c net.Conn) {
	defer c.Close()
	s.mu.Lock()
	s.live++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.live--
		s.mu.Unlock()
	}()
	if s.ProxyV1 {
		wrapped, err := forward.ConsumeProxyV1(c)
		if err != nil {
			logx.Warnf("http: proxy protocol: %v", err)
			return
		}
		c = wrapped
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	if !s.authOK(req) {
		_ = writeStatus(c, http.StatusProxyAuthRequired, "Proxy-Authenticate: Basic realm=\"relayx\"\r\n")
		return
	}
	if req.Method != http.MethodConnect {
		s.forward(c, req)
		return
	}
	target := req.Host
	if target == "" {
		_ = writeStatus(c, http.StatusBadRequest, "")
		return
	}
	if s.Bypass != nil && s.Bypass(target) {
		logx.Warnf("http: bypass %s", target)
		_ = writeStatus(c, http.StatusForbidden, "")
		return
	}
	if s.Gate != nil {
		if !s.Gate.Enter(c.RemoteAddr()) {
			_ = writeStatus(c, http.StatusServiceUnavailable, "")
			return
		}
		defer s.Gate.Leave(c.RemoteAddr())
	}
	var dst net.Conn
	if s.Dial != nil {
		dst, err = s.Dial(c.RemoteAddr(), target)
	} else {
		dst, err = (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", target)
	}
	if err != nil {
		logx.Warnf("http: dial %s: %v", target, err)
		_ = writeStatus(c, http.StatusBadGateway, "")
		return
	}
	defer dst.Close()
	if err := writeStatus(c, http.StatusOK, ""); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	var client net.Conn = &prefixConn{Conn: c, buf: br}
	if len(s.Block) > 0 {
		peeked, name, err := sniff.Peek(client)
		if err != nil {
			logx.Warnf("http: sniff: %v", err)
			return
		}
		if sniff.Reject(s.Block, s.SniffFallback, name) {
			logx.Warnf("http: blocked %s", name)
			return
		}
		client = peeked
	}
	in, out := splice(client, dst, s.Gate)
	s.add(in, out)
}

// forward sends an absolute-form request (GET http://host/path) to the origin
// and copies the response back. Proxy-Authorization is not forwarded.
func (s *Server) forward(c net.Conn, req *http.Request) {
	if req.URL == nil || !req.URL.IsAbs() {
		_ = writeStatus(c, http.StatusBadRequest, "")
		return
	}
	target := originAddr(req)
	if target == "" {
		_ = writeStatus(c, http.StatusBadRequest, "")
		return
	}
	if sniff.Reject(s.Block, s.SniffFallback, "http") {
		logx.Warnf("http: blocked http")
		_ = writeStatus(c, http.StatusForbidden, "")
		return
	}
	if s.Bypass != nil && s.Bypass(target) {
		logx.Warnf("http: bypass %s", target)
		_ = writeStatus(c, http.StatusForbidden, "")
		return
	}
	if s.Gate != nil {
		if !s.Gate.Enter(c.RemoteAddr()) {
			_ = writeStatus(c, http.StatusServiceUnavailable, "")
			return
		}
		defer s.Gate.Leave(c.RemoteAddr())
	}
	var dst net.Conn
	var err error
	if s.Dial != nil {
		dst, err = s.Dial(c.RemoteAddr(), target)
	} else {
		dst, err = (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", target)
	}
	if err != nil {
		logx.Warnf("http: dial %s: %v", target, err)
		_ = writeStatus(c, http.StatusBadGateway, "")
		return
	}
	defer dst.Close()
	req.RequestURI = ""
	req.Header.Del("Proxy-Authorization")
	req.Header.Del("Proxy-Connection")
	var sent int64
	if err := req.Write(countWriter{w: dst, n: &sent}); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	out, _ := io.Copy(c, limit.NewReader(dst, s.Gate, c.RemoteAddr()))
	s.add(sent, out)
}

type countWriter struct {
	w io.Writer
	n *int64
}

func (c countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	*c.n += int64(n)
	return n, err
}

func originAddr(req *http.Request) string {
	host := ""
	if req.URL != nil {
		host = req.URL.Host
	}
	if host == "" {
		host = req.Host
	}
	if host == "" {
		return ""
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(host, "80")
	}
	return host
}

func (s *Server) authOK(req *http.Request) bool {
	if s.Username == "" && s.Password == "" {
		return true
	}
	h := req.Header.Get("Proxy-Authorization")
	const prefix = "Basic "
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(h[len(prefix):]))
	if err != nil {
		return false
	}
	user, pass, ok := strings.Cut(string(raw), ":")
	return ok && user == s.Username && pass == s.Password
}

func writeStatus(w io.Writer, code int, extra string) error {
	reason := http.StatusText(code)
	if code == http.StatusOK {
		reason = "Connection Established"
	}
	_, err := io.WriteString(w, fmt.Sprintf("HTTP/1.1 %d %s\r\n%s\r\n", code, reason, extra))
	return err
}

func splice(a, b net.Conn, gate *limit.Gate) (in, out int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		n, _ := io.Copy(b, limit.NewReader(a, gate, a.RemoteAddr()))
		in = n
		_ = b.Close()
	}()
	go func() {
		defer wg.Done()
		n, _ := io.Copy(a, limit.NewReader(b, gate, a.RemoteAddr()))
		out = n
		_ = a.Close()
	}()
	wg.Wait()
	return in, out
}

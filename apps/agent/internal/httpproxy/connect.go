// Package httpproxy is the HTTP CONNECT hop the panel can store in
// forward_addresses_protocol.type. The connector name is "http".
package httpproxy

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// Connect asks an HTTP proxy on conn to open a TCP tunnel to addr.
// user and pass are optional Proxy-Authorization credentials.
// Extra bytes read past the response headers stay readable on the
// returned connection.
func Connect(conn net.Conn, addr, user, pass string) (net.Conn, error) {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	var b strings.Builder
	fmt.Fprintf(&b, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
	if user != "" || pass != "" {
		token := base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
		fmt.Fprintf(&b, "Proxy-Authorization: Basic %s\r\n", token)
	}
	b.WriteString("\r\n")
	if _, err := io.WriteString(conn, b.String()); err != nil {
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return nil, err
	}
	if resp.Body != nil {
		_ = resp.Body.Close()
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http: CONNECT %s", resp.Status)
	}
	_ = conn.SetDeadline(time.Time{})
	return &prefixConn{Conn: conn, buf: br}, nil
}

// prefixConn replays bytes the response reader buffered past the headers.
type prefixConn struct {
	net.Conn
	buf *bufio.Reader
}

func (p *prefixConn) Read(b []byte) (int, error) {
	if p.buf != nil && p.buf.Buffered() > 0 {
		return p.buf.Read(b)
	}
	return p.Conn.Read(b)
}

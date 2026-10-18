package shadowsocks

import (
	"io"
	"net"
	"strconv"

	"github.com/relayx/agent/internal/socksaddr"
)

// Client wraps conn as a shadowsocks AEAD client to addr. method is the
// cipher name (the panel stores it in the connector username) and password
// is the secret. The returned conn's first write carries the SOCKS address.
func Client(conn net.Conn, method, password, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 0 || port > 65535 {
		return nil, err
	}
	raw, err := socksaddr.Marshal(host, uint16(port))
	if err != nil {
		return nil, err
	}
	w, err := NewWriter(conn, method, password)
	if err != nil {
		return nil, err
	}
	return &clientConn{Conn: conn, w: w, method: method, password: password, addr: raw}, nil
}

type clientConn struct {
	net.Conn
	w        io.Writer
	r        io.Reader
	method   string
	password string
	addr     []byte
}

func (c *clientConn) Write(p []byte) (int, error) {
	if c.addr != nil {
		payload := append(append([]byte{}, c.addr...), p...)
		c.addr = nil
		if _, err := c.w.Write(payload); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	return c.w.Write(p)
}

func (c *clientConn) Read(p []byte) (int, error) {
	if c.r == nil {
		r, err := NewReader(c.Conn, c.method, c.password)
		if err != nil {
			return 0, err
		}
		c.r = r
	}
	return c.r.Read(p)
}

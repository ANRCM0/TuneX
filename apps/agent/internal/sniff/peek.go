package sniff

import (
	"net"
	"time"
)

// peekConn replays bytes that were read to name the protocol.
type peekConn struct {
	net.Conn
	buf []byte
}

func (p *peekConn) Read(b []byte) (int, error) {
	if len(p.buf) > 0 {
		n := copy(b, p.buf)
		p.buf = p.buf[n:]
		return n, nil
	}
	return p.Conn.Read(b)
}

// Peek reads the first bytes, names them, and returns a conn that still
// delivers those bytes. A timeout with no data is not an error.
func Peek(c net.Conn) (net.Conn, string, error) {
	_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	_ = c.SetReadDeadline(time.Time{})
	if n == 0 {
		if err != nil && !isTimeout(err) {
			return c, "", err
		}
		return c, "", nil
	}
	return &peekConn{Conn: c, buf: append([]byte(nil), buf[:n]...)}, Detect(buf[:n]), nil
}

func isTimeout(err error) bool {
	ne, ok := err.(net.Error)
	return ok && ne.Timeout()
}

package forward

import (
	"bufio"
	"errors"
	"net"
	"strconv"
	"strings"
	"time"
)

// ConsumeProxyV1 reads one PROXY v1 header and returns a conn whose Read
// starts at the byte after the header. The header is not forwarded.
func ConsumeProxyV1(c net.Conn) (net.Conn, error) {
	return consumeProxyV1(c)
}

// consumeProxyV1 reads one PROXY v1 header and returns a conn whose Read
// starts at the byte after the header. The header is not forwarded.
func consumeProxyV1(c net.Conn) (net.Conn, error) {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReaderSize(c, 256)
	line, err := br.ReadSlice('\n')
	_ = c.SetReadDeadline(time.Time{})
	if err != nil {
		return nil, err
	}
	if err := parseProxyV1(line); err != nil {
		return nil, err
	}
	return &prefixConn{Conn: c, r: br}, nil
}

func parseProxyV1(line []byte) error {
	if len(line) < 2 || line[len(line)-2] != '\r' || line[len(line)-1] != '\n' {
		return errors.New("proxyproto: missing CRLF")
	}
	// The spec caps a v1 header at 107 bytes, including CRLF.
	if len(line) > 107 {
		return errors.New("proxyproto: header too long")
	}
	fields := strings.Fields(string(line[:len(line)-2]))
	if len(fields) < 2 || fields[0] != "PROXY" {
		return errors.New("proxyproto: not a PROXY header")
	}
	switch fields[1] {
	case "UNKNOWN":
		return nil
	case "TCP4":
		return parseProxyAddrs(fields, true)
	case "TCP6":
		return parseProxyAddrs(fields, false)
	default:
		return errors.New("proxyproto: bad family")
	}
}

func parseProxyAddrs(fields []string, v4 bool) error {
	if len(fields) != 6 {
		return errors.New("proxyproto: bad field count")
	}
	src, dst := net.ParseIP(fields[2]), net.ParseIP(fields[3])
	if src == nil || dst == nil {
		return errors.New("proxyproto: bad address")
	}
	if v4 {
		if src.To4() == nil || dst.To4() == nil {
			return errors.New("proxyproto: not ipv4")
		}
	} else if src.To4() != nil || dst.To4() != nil {
		return errors.New("proxyproto: not ipv6")
	}
	for _, p := range fields[4:6] {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 65535 {
			return errors.New("proxyproto: bad port")
		}
	}
	return nil
}

type prefixConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *prefixConn) Read(p []byte) (int, error) { return c.r.Read(p) }

package socks5

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"

	"github.com/relayx/agent/internal/socksaddr"
)

// Connect sends a SOCKS5 CONNECT for addr on an already-dialed connection.
// user and pass are optional. On success the connection carries the target
// byte stream.
func Connect(conn net.Conn, addr, user, pass string) error {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	defer conn.SetDeadline(time.Time{})
	if err := greet(conn, user, pass); err != nil {
		return err
	}
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 0 || port > 65535 {
		return fmt.Errorf("socks5: bad port %q", portStr)
	}
	atyp, err := socksaddr.Marshal(host, uint16(port))
	if err != nil {
		return err
	}
	req := append([]byte{version, cmdConnect, 0x00}, atyp...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	var hdr [4]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		return err
	}
	if hdr[1] != repOK {
		return fmt.Errorf("socks5: reply %d", hdr[1])
	}
	return discardBindAddr(conn, hdr[3])
}

// Associate asks for a UDP relay. The returned address is where datagrams
// go. An unspecified bind address is replaced with the TCP peer's IP.
func Associate(conn net.Conn, user, pass string) (string, error) {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	defer conn.SetDeadline(time.Time{})
	if err := greet(conn, user, pass); err != nil {
		return "", err
	}
	req := []byte{version, cmdUDP, 0x00, socksaddr.ATYPIPv4, 0, 0, 0, 0, 0, 0}
	if _, err := conn.Write(req); err != nil {
		return "", err
	}
	var hdr [4]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		return "", err
	}
	if hdr[1] != repOK {
		return "", fmt.Errorf("socks5: reply %d", hdr[1])
	}
	bind, err := readBindAddr(conn, hdr[3])
	if err != nil {
		return "", err
	}
	host, port, err := net.SplitHostPort(bind)
	if err != nil {
		return "", err
	}
	if ip := net.ParseIP(host); ip == nil || ip.IsUnspecified() {
		if ra, ok := conn.RemoteAddr().(*net.TCPAddr); ok && ra.IP != nil {
			host = ra.IP.String()
		}
	}
	return net.JoinHostPort(host, port), nil
}

func greet(conn net.Conn, user, pass string) error {
	method := byte(authNone)
	if user != "" || pass != "" {
		method = authUserPass
	}
	if _, err := conn.Write([]byte{version, 1, method}); err != nil {
		return err
	}
	var sel [2]byte
	if _, err := io.ReadFull(conn, sel[:]); err != nil {
		return err
	}
	if sel[0] != version || sel[1] != method {
		return errors.New("socks5: auth rejected")
	}
	if method != authUserPass {
		return nil
	}
	if len(user) > 255 || len(pass) > 255 {
		return errors.New("socks5: auth is too long")
	}
	buf := make([]byte, 0, 3+len(user)+len(pass))
	buf = append(buf, 0x01, byte(len(user)))
	buf = append(buf, user...)
	buf = append(buf, byte(len(pass)))
	buf = append(buf, pass...)
	if _, err := conn.Write(buf); err != nil {
		return err
	}
	var st [2]byte
	if _, err := io.ReadFull(conn, st[:]); err != nil {
		return err
	}
	if st[1] != 0x00 {
		return errors.New("socks5: auth failed")
	}
	return nil
}

func readBindAddr(r io.Reader, atyp byte) (string, error) {
	switch atyp {
	case socksaddr.ATYPIPv4:
		var b [6]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		return net.JoinHostPort(net.IP(b[:4]).String(), strconv.Itoa(int(b[4])<<8|int(b[5]))), nil
	case socksaddr.ATYPIPv6:
		var b [18]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		return net.JoinHostPort(net.IP(b[:16]).String(), strconv.Itoa(int(b[16])<<8|int(b[17]))), nil
	case socksaddr.ATYPDomain:
		var n [1]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return "", err
		}
		b := make([]byte, int(n[0])+2)
		if _, err := io.ReadFull(r, b); err != nil {
			return "", err
		}
		host := string(b[:n[0]])
		return net.JoinHostPort(host, strconv.Itoa(int(b[n[0]])<<8|int(b[n[0]+1]))), nil
	default:
		return "", fmt.Errorf("socks5: bind address type %d", atyp)
	}
}

func discardBindAddr(r io.Reader, atyp byte) error {
	switch atyp {
	case socksaddr.ATYPIPv4:
		_, err := io.CopyN(io.Discard, r, 4+2)
		return err
	case socksaddr.ATYPIPv6:
		_, err := io.CopyN(io.Discard, r, 16+2)
		return err
	case socksaddr.ATYPDomain:
		var n [1]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return err
		}
		_, err := io.CopyN(io.Discard, r, int64(n[0])+2)
		return err
	default:
		return fmt.Errorf("socks5: bind address type %d", atyp)
	}
}

// Package socksaddr implements the SOCKS5 address encoding used by the
// shadowsocks AEAD protocol (and by the panel's tunnel metadata).
package socksaddr

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
)

// Address types from RFC 1928.
const (
	ATYPIPv4   = 0x01
	ATYPDomain = 0x03
	ATYPIPv6   = 0x04
)

// Addr is a decoded SOCKS5 address.
type Addr struct {
	Type byte
	Host string
	Port uint16
}

// String renders the address in the usual host:port form.
func (a Addr) String() string {
	return net.JoinHostPort(a.Host, strconv.Itoa(int(a.Port)))
}

// Parse decodes a SOCKS5 address from the head of b, returning the address and
// the number of bytes consumed.
func Parse(b []byte) (Addr, int, error) {
	if len(b) < 1 {
		return Addr{}, 0, io.ErrUnexpectedEOF
	}
	switch b[0] {
	case ATYPIPv4:
		if len(b) < 1+4+2 {
			return Addr{}, 0, io.ErrUnexpectedEOF
		}
		host := net.IP(b[1:5]).String()
		port := binary.BigEndian.Uint16(b[5:7])
		return Addr{Type: ATYPIPv4, Host: host, Port: port}, 7, nil
	case ATYPIPv6:
		if len(b) < 1+16+2 {
			return Addr{}, 0, io.ErrUnexpectedEOF
		}
		host := net.IP(b[1:17]).String()
		port := binary.BigEndian.Uint16(b[17:19])
		return Addr{Type: ATYPIPv6, Host: host, Port: port}, 19, nil
	case ATYPDomain:
		if len(b) < 2 {
			return Addr{}, 0, io.ErrUnexpectedEOF
		}
		n := int(b[1])
		if len(b) < 2+n+2 {
			return Addr{}, 0, io.ErrUnexpectedEOF
		}
		host := string(b[2 : 2+n])
		port := binary.BigEndian.Uint16(b[2+n : 2+n+2])
		return Addr{Type: ATYPDomain, Host: host, Port: port}, 2 + n + 2, nil
	default:
		return Addr{}, 0, fmt.Errorf("socksaddr: unsupported ATYP 0x%02x", b[0])
	}
}

// Marshal encodes a host:port string as a SOCKS5 address, preferring the
// numeric form (IPv4/IPv6) and falling back to a domain name.
func Marshal(host string, port uint16) ([]byte, error) {
	var out []byte
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			out = append(out, ATYPIPv4)
			out = append(out, v4...)
		} else {
			out = append(out, ATYPIPv6)
			out = append(out, ip.To16()...)
		}
	} else {
		if len(host) > 255 {
			return nil, errors.New("socksaddr: domain name too long")
		}
		out = append(out, ATYPDomain, byte(len(host)))
		out = append(out, host...)
	}
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], port)
	out = append(out, p[:]...)
	return out, nil
}

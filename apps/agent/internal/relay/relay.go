// Package relay speaks the go-gost/relay v0.5 CONNECT framing the panel uses
// between an entrance node and an exit node.
//
// A request is version, command, and a feature list. CONNECT carries an address
// feature (the next hop or the real target) and, when the connector has auth,
// a username/password feature. BIND (remote port-forward) is accepted only when
// the server has AllowBind set; after the bound-address reply the two sides
// multiplex accepted connections with smux v1 (the binder is the smux client,
// the connector is the smux server), matching go-gost/x. UDP BIND (command
// byte CmdBind|FUDP, network feature UDP) does not use smux: after the bound
// address reply, datagrams are SOCKS5 UDP frames whose reserved field is the
// payload length and whose fragment byte is 0xff.
//
//	request:  VER CMD  FEALEN FEATURES
//	response: VER STAT FEALEN FEATURES
//	feature:  TYPE LEN DATA
package relay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"

	"github.com/relayx/agent/internal/socksaddr"
)

const (
	version = 0x01

	cmdConnect = 0x01
	cmdBind    = 0x02
	cmdFUDP    = 0x80 // deprecated flag still set by go-gost bindUDP
	cmdMask    = 0x0F

	statusOK             = 0x00
	statusBadRequest     = 0x01
	statusUnauthorized   = 0x02
	statusServiceUnavail = 0x05
	statusHostUnreach    = 0x06

	featureUserAuth = 0x01
	featureAddr     = 0x02
	featureTunnel   = 0x03
	featureNetwork  = 0x04

	networkUDP = 0x0001
)

type feature struct {
	typ  byte
	data []byte
}

func writeMsg(w io.Writer, second byte, feats []feature) error {
	body := make([]byte, 0, 64)
	for _, f := range feats {
		if len(f.data) > 0xFFFF {
			return errors.New("relay: feature too long")
		}
		body = append(body, f.typ, byte(len(f.data)>>8), byte(len(f.data)))
		body = append(body, f.data...)
	}
	if len(body) > 0xFFFF {
		return errors.New("relay: features too long")
	}
	hdr := []byte{version, second, byte(len(body) >> 8), byte(len(body))}
	if _, err := w.Write(append(hdr, body...)); err != nil {
		return err
	}
	return nil
}

func readMsg(r io.Reader) (byte, []feature, error) {
	hdr := make([]byte, 4)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return 0, nil, err
	}
	if hdr[0] != version {
		return 0, nil, fmt.Errorf("relay: bad version %d", hdr[0])
	}
	n := int(binary.BigEndian.Uint16(hdr[2:4]))
	if n == 0 {
		return hdr[1], nil, nil
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	var feats []feature
	for len(buf) > 0 {
		if len(buf) < 3 {
			return 0, nil, io.ErrUnexpectedEOF
		}
		ln := int(binary.BigEndian.Uint16(buf[1:3]))
		if len(buf) < 3+ln {
			return 0, nil, io.ErrUnexpectedEOF
		}
		feats = append(feats, feature{typ: buf[0], data: append([]byte(nil), buf[3:3+ln]...)})
		buf = buf[3+ln:]
	}
	return hdr[1], feats, nil
}

func userAuthFeature(user, pass string) (feature, error) {
	if len(user) > 255 || len(pass) > 255 {
		return feature{}, errors.New("relay: auth field too long")
	}
	data := make([]byte, 0, 2+len(user)+len(pass))
	data = append(data, byte(len(user)))
	data = append(data, user...)
	data = append(data, byte(len(pass)))
	data = append(data, pass...)
	return feature{typ: featureUserAuth, data: data}, nil
}

func parseUserAuth(data []byte) (string, string, error) {
	if len(data) < 2 {
		return "", "", io.ErrUnexpectedEOF
	}
	ul := int(data[0])
	if len(data) < 2+ul {
		return "", "", io.ErrUnexpectedEOF
	}
	user := string(data[1 : 1+ul])
	pl := int(data[1+ul])
	rest := data[2+ul:]
	if len(rest) < pl {
		return "", "", io.ErrUnexpectedEOF
	}
	return user, string(rest[:pl]), nil
}

func addrFeature(hostport string) (feature, error) {
	host, portStr, err := net.SplitHostPort(hostport)
	if err != nil {
		return feature{}, err
	}
	port, err := parsePort(portStr)
	if err != nil {
		return feature{}, err
	}
	body, err := socksaddr.Marshal(host, port)
	if err != nil {
		return feature{}, err
	}
	return feature{typ: featureAddr, data: body}, nil
}

func parseAddr(data []byte) (string, error) {
	addr, _, err := socksaddr.Parse(data)
	if err != nil {
		return "", err
	}
	return addr.String(), nil
}

func parsePort(s string) (uint16, error) {
	n := 0
	if s == "" {
		return 0, errors.New("relay: empty port")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("relay: bad port %q", s)
		}
		n = n*10 + int(c-'0')
		if n > 65535 {
			return 0, fmt.Errorf("relay: bad port %q", s)
		}
	}
	return uint16(n), nil
}

func findAuth(feats []feature) (string, string, bool) {
	for _, f := range feats {
		if f.typ == featureUserAuth {
			u, p, err := parseUserAuth(f.data)
			if err != nil {
				return "", "", false
			}
			return u, p, true
		}
	}
	return "", "", false
}

func findAddr(feats []feature) (string, error) {
	for _, f := range feats {
		if f.typ == featureAddr {
			return parseAddr(f.data)
		}
	}
	return "", errors.New("relay: missing address")
}

func wantsUDP(feats []feature) bool {
	for _, f := range feats {
		if f.typ == featureNetwork && len(f.data) >= 2 {
			id := binary.BigEndian.Uint16(f.data[:2])
			return id == networkUDP
		}
	}
	return false
}

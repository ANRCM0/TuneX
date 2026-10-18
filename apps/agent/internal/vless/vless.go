// Package vless speaks the VLESS header the panel puts on a REALITY listener.
//
// A request is version 0, a 16-byte UUID, one add-on length, the command, then
// a SOCKS-style address. The response is version 0 and an empty add-on.
// Command TCP (1) is a byte stream. Command UDP (2) is uint16-BE datagrams to
// the header address. An add-on whose protobuf field 1 is xtls-rprx-vision
// makes Accept return a conn that strips that padding. UDP is not vision-padded.
package vless

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// ParseUsers reads handler.metadata.users, a map of name to UUID.
func ParseUsers(raw any) (map[[16]byte]struct{}, error) {
	obj, ok := raw.(map[string]any)
	if !ok || len(obj) == 0 {
		return nil, fmt.Errorf("vless: users metadata is empty")
	}
	out := make(map[[16]byte]struct{}, len(obj))
	for name, v := range obj {
		s, _ := v.(string)
		id, err := ParseUUID(s)
		if err != nil {
			return nil, fmt.Errorf("vless: user %s: %w", name, err)
		}
		out[id] = struct{}{}
	}
	return out, nil
}

// ParseUUID accepts a canonical UUID or 32 hex digits.
func ParseUUID(s string) ([16]byte, error) {
	var out [16]byte
	s = strings.TrimSpace(strings.ReplaceAll(s, "-", ""))
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 16 {
		return out, fmt.Errorf("uuid %q", s)
	}
	copy(out[:], b)
	return out, nil
}

// Accept reads one request, checks the UUID and writes the response.
// The returned conn is the byte stream to target. Vision padding is removed
// when the add-on asks for it. udp is true for command 2: the body is
// uint16-BE lengths and datagrams, not a byte stream and not vision.
func Accept(conn net.Conn, users map[[16]byte]struct{}) (target string, plain net.Conn, udp bool, err error) {
	var head [18]byte
	if _, err = io.ReadFull(conn, head[:]); err != nil {
		return "", nil, false, err
	}
	if head[0] != 0 {
		return "", nil, false, fmt.Errorf("vless: version %d", head[0])
	}
	var id [16]byte
	copy(id[:], head[1:17])
	if _, ok := users[id]; !ok {
		return "", nil, false, fmt.Errorf("vless: unknown user")
	}
	var addon []byte
	if n := int(head[17]); n > 0 {
		addon = make([]byte, n)
		if _, err = io.ReadFull(conn, addon); err != nil {
			return "", nil, false, err
		}
	}
	var cmd [1]byte
	if _, err = io.ReadFull(conn, cmd[:]); err != nil {
		return "", nil, false, err
	}
	if cmd[0] != 1 && cmd[0] != 2 {
		return "", nil, false, fmt.Errorf("vless: command %d is not TCP or UDP", cmd[0])
	}
	target, err = readAddr(conn)
	if err != nil {
		return "", nil, false, err
	}
	if _, err = conn.Write([]byte{0, 0}); err != nil {
		return "", nil, false, err
	}
	if cmd[0] == 2 {
		return target, conn, true, nil
	}
	if isVision(addon) {
		return target, newVision(conn, id), false, nil
	}
	return target, conn, false, nil
}

// RelayUDP copies length-prefixed datagrams between conn and target.
// It returns the number of payload bytes read from the client.
func RelayUDP(conn net.Conn, target string) (int64, error) {
	raddr, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		return 0, err
	}
	pc, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		return 0, err
	}
	defer pc.Close()
	go func() {
		buf := make([]byte, 65535)
		for {
			_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
			n, err := pc.Read(buf)
			if err != nil {
				return
			}
			if writePacket(conn, buf[:n]) != nil {
				return
			}
		}
	}()
	var total int64
	for {
		pkt, err := readPacket(conn)
		if err != nil {
			return total, err
		}
		total += int64(len(pkt))
		if _, err := pc.Write(pkt); err != nil {
			return total, err
		}
	}
}

func readPacket(r io.Reader) ([]byte, error) {
	var nbuf [2]byte
	if _, err := io.ReadFull(r, nbuf[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(nbuf[:]))
	if n == 0 {
		return []byte{}, nil
	}
	buf := make([]byte, n)
	_, err := io.ReadFull(r, buf)
	return buf, err
}

func writePacket(w io.Writer, payload []byte) error {
	var nbuf [2]byte
	binary.BigEndian.PutUint16(nbuf[:], uint16(len(payload)))
	if _, err := w.Write(nbuf[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// Write sends a TCP request for addr (host:port) and reads the response header.
func Write(conn net.Conn, id [16]byte, addr string) error {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	port, err := net.LookupPort("tcp", portStr)
	if err != nil {
		return err
	}
	buf := make([]byte, 0, 64)
	buf = append(buf, 0)
	buf = append(buf, id[:]...)
	buf = append(buf, 0, 1)
	var portb [2]byte
	binary.BigEndian.PutUint16(portb[:], uint16(port))
	buf = append(buf, portb[:]...)
	ip := net.ParseIP(host)
	switch {
	case ip.To4() != nil:
		buf = append(buf, 1)
		buf = append(buf, ip.To4()...)
	case ip.To16() != nil:
		buf = append(buf, 3)
		buf = append(buf, ip.To16()...)
	default:
		if len(host) > 255 {
			return fmt.Errorf("vless: domain too long")
		}
		buf = append(buf, 2, byte(len(host)))
		buf = append(buf, host...)
	}
	if _, err := conn.Write(buf); err != nil {
		return err
	}
	var resp [2]byte
	if _, err := io.ReadFull(conn, resp[:]); err != nil {
		return err
	}
	if resp[0] != 0 {
		return fmt.Errorf("vless: response version %d", resp[0])
	}
	if resp[1] > 0 {
		if _, err := io.CopyN(io.Discard, conn, int64(resp[1])); err != nil {
			return err
		}
	}
	return nil
}

// WriteVision sends a request whose add-on is xtls-rprx-vision and returns the
// conn to use for the body. Later writes are padded and reads are unpadded.
func WriteVision(conn net.Conn, id [16]byte, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := net.LookupPort("tcp", portStr)
	if err != nil {
		return nil, err
	}
	addon := visionAddon()
	buf := make([]byte, 0, 64+len(addon))
	buf = append(buf, 0)
	buf = append(buf, id[:]...)
	buf = append(buf, byte(len(addon)))
	buf = append(buf, addon...)
	buf = append(buf, 1)
	var portb [2]byte
	binary.BigEndian.PutUint16(portb[:], uint16(port))
	buf = append(buf, portb[:]...)
	ip := net.ParseIP(host)
	switch {
	case ip.To4() != nil:
		buf = append(buf, 1)
		buf = append(buf, ip.To4()...)
	case ip.To16() != nil:
		buf = append(buf, 3)
		buf = append(buf, ip.To16()...)
	default:
		if len(host) > 255 {
			return nil, fmt.Errorf("vless: domain too long")
		}
		buf = append(buf, 2, byte(len(host)))
		buf = append(buf, host...)
	}
	if _, err := conn.Write(buf); err != nil {
		return nil, err
	}
	var resp [2]byte
	if _, err := io.ReadFull(conn, resp[:]); err != nil {
		return nil, err
	}
	if resp[0] != 0 {
		return nil, fmt.Errorf("vless: response version %d", resp[0])
	}
	if resp[1] > 0 {
		if _, err := io.CopyN(io.Discard, conn, int64(resp[1])); err != nil {
			return nil, err
		}
	}
	return newVision(conn, id), nil
}

func readAddr(r io.Reader) (string, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return "", err
	}
	port := binary.BigEndian.Uint16(hdr[:])
	var atyp [1]byte
	if _, err := io.ReadFull(r, atyp[:]); err != nil {
		return "", err
	}
	var host string
	switch atyp[0] {
	case 1:
		var ip [4]byte
		if _, err := io.ReadFull(r, ip[:]); err != nil {
			return "", err
		}
		host = net.IP(ip[:]).String()
	case 3:
		var ip [16]byte
		if _, err := io.ReadFull(r, ip[:]); err != nil {
			return "", err
		}
		host = net.IP(ip[:]).String()
	case 2:
		var n [1]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return "", err
		}
		dom := make([]byte, n[0])
		if _, err := io.ReadFull(r, dom); err != nil {
			return "", err
		}
		host = string(dom)
	default:
		return "", fmt.Errorf("vless: address type %d", atyp[0])
	}
	return net.JoinHostPort(host, fmt.Sprintf("%d", port)), nil
}

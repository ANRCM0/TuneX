package openvpn

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
)

// pushRequest is what a client writes on the TLS control channel after key method 2.
func pushRequest() []byte { return []byte("PUSH_REQUEST\x00") }

// pushReply is the server's answer. peer-id is the 24-bit value carried in P_DATA_V2.
// cidr is the panel's server network (default 10.8.0.0/24); the client is given .2.
// CipherKeyLen maps the panel cipher name to an AES-GCM key length.
// An empty name is the panel default, AES-256-GCM.
func CipherKeyLen(name string) (int, string, error) {
	switch strings.ToUpper(strings.TrimSpace(name)) {
	case "", "AES-256-GCM":
		return 32, "AES-256-GCM", nil
	case "AES-128-GCM":
		return 16, "AES-128-GCM", nil
	default:
		return 0, "", fmt.Errorf("openvpn: cipher %q is not implemented", name)
	}
}

func pushReply(peerID uint32, cidr, cipher string, mtu int) []byte {
	ip, mask := "10.8.0.2", "255.255.255.0"
	if _, network, err := net.ParseCIDR(cidr); err == nil && network.IP.To4() != nil {
		client := network.IP.To4()
		client = append(net.IP(nil), client...)
		client[3] += 2
		ip = client.String()
		mask = net.IP(network.Mask).String()
	}
	if cipher == "" {
		cipher = "AES-256-GCM"
	}
	extra := ""
	if mtu > 0 {
		extra = fmt.Sprintf(",tun-mtu %d", mtu)
	}
	return []byte(fmt.Sprintf("PUSH_REPLY,topology subnet,ifconfig %s %s,peer-id %d,cipher %s%s\x00", ip, mask, peerID, cipher, extra))
}

// readControlString reads one NUL-terminated string from the TLS control channel.
func readControlString(r io.Reader) (string, error) {
	var buf []byte
	tmp := make([]byte, 256)
	for len(buf) < 2048 {
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if i := bytes.IndexByte(buf, 0); i >= 0 {
				return string(buf[:i]), nil
			}
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("openvpn: control string too long")
}

// parsePeerID reads the peer-id token from a PUSH_REPLY string.
func parsePeerID(msg string) (uint32, error) {
	if !strings.HasPrefix(msg, "PUSH_REPLY") {
		return 0, fmt.Errorf("openvpn: expected PUSH_REPLY, got %q", msg)
	}
	for _, part := range strings.Split(msg, ",") {
		part = strings.TrimSpace(part)
		if !strings.HasPrefix(part, "peer-id ") {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimPrefix(part, "peer-id "), 10, 24)
		if err != nil {
			return 0, fmt.Errorf("openvpn: peer-id: %w", err)
		}
		return uint32(n), nil
	}
	return 0, errors.New("openvpn: PUSH_REPLY has no peer-id")
}

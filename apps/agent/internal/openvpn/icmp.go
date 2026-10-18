package openvpn

import (
	"encoding/binary"
	"errors"
	"net"
)

// GatewayIP is the first host of cidr, which is the address this listener
// answers pings for. 10.8.0.0/24 becomes 10.8.0.1. A bad cidr uses that default.
func GatewayIP(cidr string) net.IP {
	_, n, err := net.ParseCIDR(cidr)
	if err != nil || n.IP.To4() == nil {
		return net.IPv4(10, 8, 0, 1).To4()
	}
	out := make(net.IP, 4)
	copy(out, n.IP.To4())
	out[3]++
	if out[3] == 0 {
		return net.IPv4(10, 8, 0, 1).To4()
	}
	return out
}

// BuildICMPEcho builds an IPv4 ICMP echo request (type 8) or reply (type 0).
func BuildICMPEcho(src, dst net.IP, typ byte, id, seq uint16, payload []byte) ([]byte, error) {
	src4, dst4 := src.To4(), dst.To4()
	if src4 == nil || dst4 == nil {
		return nil, errors.New("openvpn: only IPv4")
	}
	total := 20 + 8 + len(payload)
	if total > 65535 {
		return nil, errors.New("openvpn: icmp packet too large")
	}
	pkt := make([]byte, total)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:], uint16(total))
	pkt[8] = 64
	pkt[9] = 1
	copy(pkt[12:16], src4)
	copy(pkt[16:20], dst4)
	binary.BigEndian.PutUint16(pkt[10:], ipChecksum(pkt[:20]))
	pkt[20] = typ
	binary.BigEndian.PutUint16(pkt[24:], id)
	binary.BigEndian.PutUint16(pkt[26:], seq)
	copy(pkt[28:], payload)
	binary.BigEndian.PutUint16(pkt[22:], icmpChecksum(pkt[20:]))
	return pkt, nil
}

// ReplyICMP answers an echo request whose destination is gateway. Anything
// else returns an error so the caller can try another protocol.
func ReplyICMP(pkt []byte, gateway net.IP) ([]byte, error) {
	src, dst, typ, id, seq, payload, err := ParseICMPEcho(pkt)
	if err != nil {
		return nil, err
	}
	gw := gateway.To4()
	if gw == nil || !dst.Equal(gw) {
		return nil, errors.New("openvpn: icmp is not for the tunnel gateway")
	}
	if typ != 8 {
		return nil, errors.New("openvpn: not an icmp echo request")
	}
	return BuildICMPEcho(dst, src, 0, id, seq, payload)
}

// ParseICMPEcho checks both checksums and returns the echo fields.
func ParseICMPEcho(pkt []byte) (src, dst net.IP, typ byte, id, seq uint16, payload []byte, err error) {
	if len(pkt) < 28 || pkt[0]>>4 != 4 || int(pkt[0]&0x0f) != 5 {
		return nil, nil, 0, 0, 0, nil, errors.New("openvpn: not a bare IPv4 packet")
	}
	if pkt[9] != 1 {
		return nil, nil, 0, 0, 0, nil, errors.New("openvpn: not ICMP")
	}
	total := int(binary.BigEndian.Uint16(pkt[2:]))
	if total < 28 || total > len(pkt) {
		return nil, nil, 0, 0, 0, nil, errors.New("openvpn: bad ip length")
	}
	if ipChecksum(pkt[:20]) != 0 {
		return nil, nil, 0, 0, 0, nil, errors.New("openvpn: bad ip checksum")
	}
	if icmpChecksum(pkt[20:total]) != 0 {
		return nil, nil, 0, 0, 0, nil, errors.New("openvpn: bad icmp checksum")
	}
	src = append(net.IP(nil), pkt[12:16]...)
	dst = append(net.IP(nil), pkt[16:20]...)
	typ = pkt[20]
	id = binary.BigEndian.Uint16(pkt[24:])
	seq = binary.BigEndian.Uint16(pkt[26:])
	payload = append([]byte(nil), pkt[28:total]...)
	return src, dst, typ, id, seq, payload, nil
}

func icmpChecksum(msg []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(msg); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(msg[i:]))
	}
	if len(msg)%2 == 1 {
		sum += uint32(msg[len(msg)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

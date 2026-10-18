package openvpn

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/relayx/agent/internal/sniff"
)

// BuildIPv4UDP builds a 20-byte IPv4 header plus a UDP header and payload.
// The UDP checksum is left at 0, which IPv4 allows.
func BuildIPv4UDP(src net.IP, srcPort int, dst net.IP, dstPort int, payload []byte) ([]byte, error) {
	src4, dst4 := src.To4(), dst.To4()
	if src4 == nil || dst4 == nil {
		return nil, errors.New("openvpn: only IPv4")
	}
	if srcPort < 0 || srcPort > 65535 || dstPort < 0 || dstPort > 65535 {
		return nil, errors.New("openvpn: port out of range")
	}
	total := 20 + 8 + len(payload)
	if total > 65535 {
		return nil, fmt.Errorf("openvpn: ip packet is %d bytes", total)
	}
	pkt := make([]byte, total)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:], uint16(total))
	pkt[8] = 64
	pkt[9] = 17
	copy(pkt[12:16], src4)
	copy(pkt[16:20], dst4)
	binary.BigEndian.PutUint16(pkt[10:], ipChecksum(pkt[:20]))
	binary.BigEndian.PutUint16(pkt[20:], uint16(srcPort))
	binary.BigEndian.PutUint16(pkt[22:], uint16(dstPort))
	binary.BigEndian.PutUint16(pkt[24:], uint16(8+len(payload)))
	copy(pkt[28:], payload)
	return pkt, nil
}

// ParseIPv4UDP returns the addresses and UDP payload of a packet with no IP options.
func ParseIPv4UDP(pkt []byte) (src net.IP, srcPort int, dst net.IP, dstPort int, payload []byte, err error) {
	if len(pkt) < 28 || pkt[0]>>4 != 4 || int(pkt[0]&0x0f) != 5 {
		return nil, 0, nil, 0, nil, errors.New("openvpn: not a bare IPv4 packet")
	}
	if pkt[9] != 17 {
		return nil, 0, nil, 0, nil, errors.New("openvpn: not UDP")
	}
	total := int(binary.BigEndian.Uint16(pkt[2:]))
	if total < 28 || total > len(pkt) {
		return nil, 0, nil, 0, nil, errors.New("openvpn: bad ip length")
	}
	if ipChecksum(pkt[:20]) != 0 {
		return nil, 0, nil, 0, nil, errors.New("openvpn: bad ip checksum")
	}
	udpLen := int(binary.BigEndian.Uint16(pkt[24:]))
	if udpLen < 8 || 20+udpLen > total {
		return nil, 0, nil, 0, nil, errors.New("openvpn: bad udp length")
	}
	src = append(net.IP(nil), pkt[12:16]...)
	dst = append(net.IP(nil), pkt[16:20]...)
	srcPort = int(binary.BigEndian.Uint16(pkt[20:]))
	dstPort = int(binary.BigEndian.Uint16(pkt[22:]))
	payload = append([]byte(nil), pkt[28:20+udpLen]...)
	return src, srcPort, dst, dstPort, payload, nil
}

// IPv4Dest is the packet's destination as host or host:port. TCP and UDP
// include the port. Other protocols are just the address. ok is false when
// the header is too short to read.
func IPv4Dest(pkt []byte) (string, bool) {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return "", false
	}
	ihl := int(pkt[0]&0x0f) * 4
	if ihl < 20 || len(pkt) < ihl {
		return "", false
	}
	ip := net.IP(pkt[16:20]).String()
	if (pkt[9] == 6 || pkt[9] == 17) && len(pkt) >= ihl+4 {
		port := int(binary.BigEndian.Uint16(pkt[ihl+2 : ihl+4]))
		return net.JoinHostPort(ip, strconv.Itoa(port)), true
	}
	return ip, true
}

// ForwardIPv4UDP dials the packet's destination, writes the UDP payload, and
// returns one reply packet with the addresses swapped. The wait is one second.
func ForwardIPv4UDP(pkt []byte) ([]byte, error) {
	src, sport, dst, dport, payload, err := ParseIPv4UDP(pkt)
	if err != nil {
		return nil, err
	}
	conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: dst, Port: dport})
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	if _, err := conn.Write(payload); err != nil {
		return nil, err
	}
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	return BuildIPv4UDP(dst, dport, src, sport, buf[:n])
}

// IPv4L4Payload is the TCP or UDP payload inside an IPv4 packet. An empty
// slice means there is nothing to name (a SYN, or not TCP/UDP).
func IPv4L4Payload(pkt []byte) []byte {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return nil
	}
	ihl := int(pkt[0]&0x0f) * 4
	if ihl < 20 || len(pkt) < ihl {
		return nil
	}
	switch pkt[9] {
	case 6:
		if len(pkt) < ihl+20 {
			return nil
		}
		off := int(pkt[ihl+12]>>4) * 4
		if off < 20 || len(pkt) < ihl+off {
			return nil
		}
		return pkt[ihl+off:]
	case 17:
		if len(pkt) < ihl+8 {
			return nil
		}
		return pkt[ihl+8:]
	default:
		return nil
	}
}

// L4Blocked reports that the inner TCP or UDP payload is a blocked protocol.
// An empty payload is never blocked, so a TCP SYN still opens the connection.
// sniffing.fallback false drops an unrecognized payload.
func L4Blocked(pkt []byte, block []string, fallback bool) bool {
	payload := IPv4L4Payload(pkt)
	if len(payload) == 0 || len(block) == 0 {
		return false
	}
	return sniff.Reject(block, fallback, sniff.Detect(payload))
}

func ipChecksum(h []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(h); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(h[i:]))
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

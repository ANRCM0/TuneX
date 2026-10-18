package openvpn

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

const (
	tcpFIN = 0x01
	tcpSYN = 0x02
	tcpRST = 0x04
	tcpPSH = 0x08
	tcpACK = 0x10
)

// IPv4TCP is one TCP segment inside an IPv4 packet with no options.
type IPv4TCP struct {
	Src     net.IP
	Dst     net.IP
	SrcPort int
	DstPort int
	Seq     uint32
	Ack     uint32
	Flags   byte
	Payload []byte
}

// BuildIPv4TCP builds a 20-byte IPv4 header plus a 20-byte TCP header and payload.
func BuildIPv4TCP(p IPv4TCP) ([]byte, error) {
	src4, dst4 := p.Src.To4(), p.Dst.To4()
	if src4 == nil || dst4 == nil {
		return nil, errors.New("openvpn: only IPv4")
	}
	if p.SrcPort < 0 || p.SrcPort > 65535 || p.DstPort < 0 || p.DstPort > 65535 {
		return nil, errors.New("openvpn: port out of range")
	}
	total := 20 + 20 + len(p.Payload)
	if total > 65535 {
		return nil, fmt.Errorf("openvpn: ip packet is %d bytes", total)
	}
	pkt := make([]byte, total)
	pkt[0] = 0x45
	binary.BigEndian.PutUint16(pkt[2:], uint16(total))
	pkt[8] = 64
	pkt[9] = 6
	copy(pkt[12:16], src4)
	copy(pkt[16:20], dst4)
	binary.BigEndian.PutUint16(pkt[10:], ipChecksum(pkt[:20]))
	binary.BigEndian.PutUint16(pkt[20:], uint16(p.SrcPort))
	binary.BigEndian.PutUint16(pkt[22:], uint16(p.DstPort))
	binary.BigEndian.PutUint32(pkt[24:], p.Seq)
	binary.BigEndian.PutUint32(pkt[28:], p.Ack)
	pkt[32] = 5 << 4
	pkt[33] = p.Flags
	binary.BigEndian.PutUint16(pkt[34:], 65535)
	copy(pkt[40:], p.Payload)
	binary.BigEndian.PutUint16(pkt[36:], tcpChecksum(src4, dst4, pkt[20:]))
	return pkt, nil
}

// ParseIPv4TCP parses a bare IPv4 TCP packet.
func ParseIPv4TCP(pkt []byte) (IPv4TCP, error) {
	var p IPv4TCP
	if len(pkt) < 40 || pkt[0]>>4 != 4 || int(pkt[0]&0x0f) != 5 {
		return p, errors.New("openvpn: not a bare IPv4 packet")
	}
	if pkt[9] != 6 {
		return p, errors.New("openvpn: not TCP")
	}
	total := int(binary.BigEndian.Uint16(pkt[2:]))
	if total < 40 || total > len(pkt) {
		return p, errors.New("openvpn: bad ip length")
	}
	if ipChecksum(pkt[:20]) != 0 {
		return p, errors.New("openvpn: bad ip checksum")
	}
	hdrLen := int(pkt[32]>>4) * 4
	if hdrLen < 20 || 20+hdrLen > total {
		return p, errors.New("openvpn: bad tcp header")
	}
	summed := append([]byte(nil), pkt[20:total]...)
	binary.BigEndian.PutUint16(summed[16:], 0)
	if tcpChecksum(pkt[12:16], pkt[16:20], summed) != binary.BigEndian.Uint16(pkt[36:38]) {
		return p, errors.New("openvpn: bad tcp checksum")
	}
	p.Src = append(net.IP(nil), pkt[12:16]...)
	p.Dst = append(net.IP(nil), pkt[16:20]...)
	p.SrcPort = int(binary.BigEndian.Uint16(pkt[20:]))
	p.DstPort = int(binary.BigEndian.Uint16(pkt[22:]))
	p.Seq = binary.BigEndian.Uint32(pkt[24:])
	p.Ack = binary.BigEndian.Uint32(pkt[28:])
	p.Flags = pkt[33]
	p.Payload = append([]byte(nil), pkt[20+hdrLen:total]...)
	return p, nil
}

// TCPNat dials the destination of an inner TCP SYN and splices later payloads.
// It is a userspace stand-in for a TUN device, not a full TCP stack.
type TCPNat struct {
	mu     sync.Mutex
	flows  map[string]*tcpFlow
	out    chan []byte
	closed bool
}

type tcpFlow struct {
	conn      net.Conn
	src       net.IP
	dst       net.IP
	sport     int
	dport     int
	clientSeq uint32
	serverSeq uint32
}

// NewTCPNat returns an empty translator. Replies carries segments the dialed
// connection produced after Handle returned.
func NewTCPNat() *TCPNat {
	return &TCPNat{flows: map[string]*tcpFlow{}, out: make(chan []byte, 16)}
}

// Replies receives IPv4 TCP segments from dialed connections.
func (n *TCPNat) Replies() <-chan []byte { return n.out }

// Close closes every dialed connection.
func (n *TCPNat) Close() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	for k, f := range n.flows {
		f.conn.Close()
		delete(n.flows, k)
	}
}

func (n *TCPNat) emit(pkt []byte) {
	n.mu.Lock()
	closed := n.closed
	n.mu.Unlock()
	if closed || pkt == nil {
		return
	}
	select {
	case n.out <- pkt:
	default:
	}
}

// Handle answers a SYN with SYN-ACK, writes a later payload to the dialed
// connection, and returns at most one reply segment. A pure ACK returns
// (nil, nil). A packet that is not IPv4 TCP returns an error.
func (n *TCPNat) Handle(pkt []byte) ([]byte, error) {
	p, err := ParseIPv4TCP(pkt)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("%s:%d-%s:%d", p.Src, p.SrcPort, p.Dst, p.DstPort)
	if p.Flags&tcpSYN != 0 && p.Flags&tcpACK == 0 {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(p.Dst.String(), fmt.Sprintf("%d", p.DstPort)), time.Second)
		if err != nil {
			return nil, err
		}
		var isn [4]byte
		if _, err := rand.Read(isn[:]); err != nil {
			conn.Close()
			return nil, err
		}
		flow := &tcpFlow{
			conn: conn, src: p.Src, dst: p.Dst, sport: p.SrcPort, dport: p.DstPort,
			clientSeq: p.Seq + 1, serverSeq: binary.BigEndian.Uint32(isn[:]) + 1,
		}
		n.mu.Lock()
		if old, ok := n.flows[key]; ok {
			old.conn.Close()
		}
		n.flows[key] = flow
		n.mu.Unlock()
		go n.readLoop(flow)
		return BuildIPv4TCP(IPv4TCP{
			Src: p.Dst, Dst: p.Src, SrcPort: p.DstPort, DstPort: p.SrcPort,
			Seq: flow.serverSeq - 1, Ack: flow.clientSeq, Flags: tcpSYN | tcpACK,
		})
	}
	n.mu.Lock()
	flow := n.flows[key]
	n.mu.Unlock()
	if flow == nil {
		return nil, errors.New("openvpn: tcp flow not found")
	}
	if p.Flags&tcpFIN != 0 {
		flow.conn.Close()
		n.mu.Lock()
		delete(n.flows, key)
		n.mu.Unlock()
		return BuildIPv4TCP(IPv4TCP{
			Src: p.Dst, Dst: p.Src, SrcPort: p.DstPort, DstPort: p.SrcPort,
			Seq: flow.serverSeq, Ack: p.Seq + 1, Flags: tcpFIN | tcpACK,
		})
	}
	if len(p.Payload) == 0 {
		return nil, nil
	}
	n.mu.Lock()
	if p.Seq != flow.clientSeq {
		want := flow.clientSeq
		n.mu.Unlock()
		return nil, fmt.Errorf("openvpn: tcp seq %d, want %d", p.Seq, want)
	}
	flow.clientSeq += uint32(len(p.Payload))
	ack := flow.clientSeq
	seq := flow.serverSeq
	n.mu.Unlock()
	_ = flow.conn.SetWriteDeadline(time.Now().Add(time.Second))
	if _, err := flow.conn.Write(p.Payload); err != nil {
		return nil, err
	}
	return BuildIPv4TCP(IPv4TCP{
		Src: p.Dst, Dst: p.Src, SrcPort: p.DstPort, DstPort: p.SrcPort,
		Seq: seq, Ack: ack, Flags: tcpACK,
	})
}

func (n *TCPNat) readLoop(flow *tcpFlow) {
	buf := make([]byte, 2048)
	for {
		nread, err := flow.conn.Read(buf)
		if nread > 0 {
			payload := append([]byte(nil), buf[:nread]...)
			n.mu.Lock()
			seq := flow.serverSeq
			ack := flow.clientSeq
			flow.serverSeq += uint32(nread)
			n.mu.Unlock()
			pkt, berr := BuildIPv4TCP(IPv4TCP{
				Src: flow.dst, Dst: flow.src, SrcPort: flow.dport, DstPort: flow.sport,
				Seq: seq, Ack: ack, Flags: tcpPSH | tcpACK, Payload: payload,
			})
			if berr == nil {
				n.emit(pkt)
			}
		}
		if err != nil {
			return
		}
	}
}

func tcpChecksum(src, dst net.IP, tcp []byte) uint16 {
	var sum uint32
	sum += uint32(binary.BigEndian.Uint16(src[:2]))
	sum += uint32(binary.BigEndian.Uint16(src[2:4]))
	sum += uint32(binary.BigEndian.Uint16(dst[:2]))
	sum += uint32(binary.BigEndian.Uint16(dst[2:4]))
	sum += 6
	sum += uint32(len(tcp))
	for i := 0; i+1 < len(tcp); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(tcp[i:]))
	}
	if len(tcp)%2 == 1 {
		sum += uint32(tcp[len(tcp)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

package relay

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/socksaddr"
)

// udpTunFrag is the fragment byte go-gost writes on every relay UDP-tun frame
// (reserved field carries the payload length, so a stream can be framed).
const udpTunFrag = 0xff

func (s *Server) addPacket(pc net.PacketConn) {
	s.mu.Lock()
	s.pcs = append(s.pcs, pc)
	s.mu.Unlock()
}

// serveBindUDP is the entrance half of a remote UDP forward. After the bound
// address is acknowledged, datagrams move on the same TCP connection as SOCKS5
// UDP frames. No smux.
func (s *Server) serveBindUDP(c net.Conn, feats []feature) {
	raw, err := findAddr(feats)
	if err != nil || raw == "" {
		raw = "0.0.0.0:0"
	}
	pc, err := net.ListenPacket("udp", normalizeBindAddr(raw))
	if err != nil {
		_ = writeMsg(c, statusServiceUnavail, nil)
		return
	}
	s.addPacket(pc)
	defer pc.Close()

	bound, err := addrFeature(pc.LocalAddr().String())
	if err != nil {
		_ = writeMsg(c, statusServiceUnavail, nil)
		return
	}
	if err := writeMsg(c, statusOK, []feature{bound}); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	logx.Infof("relay: udp bind on %s", pc.LocalAddr())

	var writeMu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 64*1024)
		for {
			n, peer, rerr := pc.ReadFrom(buf)
			if rerr != nil {
				return
			}
			writeMu.Lock()
			werr := writeUDPTun(c, peer.String(), buf[:n])
			writeMu.Unlock()
			if werr != nil {
				return
			}
		}
	}()

	for {
		addr, payload, rerr := readUDPTun(c)
		if rerr != nil {
			break
		}
		dst, rerr := net.ResolveUDPAddr("udp", addr)
		if rerr != nil {
			continue
		}
		if _, werr := pc.WriteTo(payload, dst); werr != nil {
			break
		}
	}
	_ = pc.Close()
	<-done
}

// UDPTun is the connector half of a UDP BIND. ReadFrom yields public datagrams;
// WriteTo sends one back to the peer address carried in the frame.
type UDPTun struct {
	conn  net.Conn
	bound string
	mu    sync.Mutex
}

// LocalAddr is the address the entrance actually bound.
func (u *UDPTun) LocalAddr() net.Addr { return stringAddr(u.bound) }

// Close closes the control connection.
func (u *UDPTun) Close() error {
	if u.conn != nil {
		return u.conn.Close()
	}
	return nil
}

// ReadFrom reads one framed datagram. The address is the public peer.
func (u *UDPTun) ReadFrom(b []byte) (int, net.Addr, error) {
	addr, payload, err := readUDPTun(u.conn)
	if err != nil {
		return 0, nil, err
	}
	n := copy(b, payload)
	ua, rerr := net.ResolveUDPAddr("udp", addr)
	if rerr != nil {
		return n, stringAddr(addr), nil
	}
	return n, ua, nil
}

// WriteTo frames payload back to addr.
func (u *UDPTun) WriteTo(b []byte, addr net.Addr) (int, error) {
	if addr == nil {
		return 0, fmt.Errorf("relay: nil udp address")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if err := writeUDPTun(u.conn, addr.String(), b); err != nil {
		return 0, err
	}
	return len(b), nil
}

// BindUDP sends CmdBind|FUDP on an already-dialed relay connection.
func BindUDP(conn net.Conn, addr, user, pass string) (*UDPTun, error) {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	var feats []feature
	if user != "" || pass != "" {
		af, err := userAuthFeature(user, pass)
		if err != nil {
			return nil, err
		}
		feats = append(feats, af)
	}
	feats = append(feats, networkFeature(networkUDP))
	af, err := addrFeature(normalizeBindAddr(addr))
	if err != nil {
		return nil, err
	}
	feats = append(feats, af)
	if err := writeMsg(conn, cmdBind|cmdFUDP, feats); err != nil {
		return nil, err
	}
	status, rfeats, err := readMsg(conn)
	if err != nil {
		return nil, err
	}
	if status != statusOK {
		return nil, fmtStatus(status)
	}
	bound, err := findAddr(rfeats)
	if err != nil {
		bound = normalizeBindAddr(addr)
	}
	_ = conn.SetDeadline(time.Time{})
	return &UDPTun{conn: conn, bound: bound}, nil
}

// DialBindUDP dials the first hop, CONNECTs through any earlier hops, then
// UDP-BINDs on the last hop.
func DialBindUDP(hops []Hop, bindAddr string) (*UDPTun, error) {
	if len(hops) == 0 {
		return nil, fmt.Errorf("relay: no hop")
	}
	conn, err := (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", hops[0].Addr)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	for i, hop := range hops {
		if hop.Connector != "" && hop.Connector != "relay" {
			return nil, fmt.Errorf("relay: connector %q is not implemented", hop.Connector)
		}
		if i+1 < len(hops) {
			if err := Handshake(conn, hops[i+1].Addr, hop.Username, hop.Password); err != nil {
				return nil, err
			}
		}
	}
	last := hops[len(hops)-1]
	tun, err := BindUDP(conn, bindAddr, last.Username, last.Password)
	if err != nil {
		return nil, err
	}
	ok = true
	return tun, nil
}

func writeUDPTun(w io.Writer, addr string, payload []byte) error {
	if len(payload) > 0xFFFF {
		return fmt.Errorf("relay: udp payload too long")
	}
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	port, err := parsePort(portStr)
	if err != nil {
		return err
	}
	body, err := socksaddr.Marshal(host, port)
	if err != nil {
		return err
	}
	buf := make([]byte, 3+len(body)+len(payload))
	binary.BigEndian.PutUint16(buf[:2], uint16(len(payload)))
	buf[2] = udpTunFrag
	copy(buf[3:], body)
	copy(buf[3+len(body):], payload)
	_, err = w.Write(buf)
	return err
}

func readUDPTun(r io.Reader) (string, []byte, error) {
	var hdr [3]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return "", nil, err
	}
	dlen := int(binary.BigEndian.Uint16(hdr[:2]))
	var atyp [1]byte
	if _, err := io.ReadFull(r, atyp[:]); err != nil {
		return "", nil, err
	}
	var addrBuf []byte
	switch atyp[0] {
	case socksaddr.ATYPIPv4:
		addrBuf = make([]byte, 1+4+2)
	case socksaddr.ATYPIPv6:
		addrBuf = make([]byte, 1+16+2)
	case socksaddr.ATYPDomain:
		var n [1]byte
		if _, err := io.ReadFull(r, n[:]); err != nil {
			return "", nil, err
		}
		addrBuf = make([]byte, 2+int(n[0])+2)
		addrBuf[0] = atyp[0]
		addrBuf[1] = n[0]
		if _, err := io.ReadFull(r, addrBuf[2:]); err != nil {
			return "", nil, err
		}
		a, _, err := socksaddr.Parse(addrBuf)
		if err != nil {
			return "", nil, err
		}
		payload, err := readUDPPayload(r, dlen)
		if err != nil {
			return "", nil, err
		}
		return a.String(), payload, nil
	default:
		return "", nil, fmt.Errorf("relay: bad udp atyp 0x%02x", atyp[0])
	}
	addrBuf[0] = atyp[0]
	if _, err := io.ReadFull(r, addrBuf[1:]); err != nil {
		return "", nil, err
	}
	a, _, err := socksaddr.Parse(addrBuf)
	if err != nil {
		return "", nil, err
	}
	payload, err := readUDPPayload(r, dlen)
	if err != nil {
		return "", nil, err
	}
	return a.String(), payload, nil
}

func readUDPPayload(r io.Reader, dlen int) ([]byte, error) {
	if dlen == 0 {
		// Standard SOCKS5 UDP: the reserved field is zero and the payload is
		// whatever remains of this read. A stream has no boundary, so take one
		// Read up to 64KiB.
		buf := make([]byte, 64*1024)
		n, err := r.Read(buf)
		if n == 0 && err != nil {
			return nil, err
		}
		return buf[:n], nil
	}
	buf := make([]byte, dlen)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

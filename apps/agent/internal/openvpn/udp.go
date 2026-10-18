package openvpn

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
	"time"
)

// udpConn presents OpenVPN's UDP datagrams as the length-prefixed stream that
// ReadTCP and WriteTCP already speak. One datagram is one packet. There is no
// length on the wire.
type udpConn struct {
	send   func([]byte) error
	local  net.Addr
	remote net.Addr
	close  func() error

	mu      sync.Mutex
	cond    *sync.Cond
	in      [][]byte
	pending []byte
	closed  bool

	wmu  sync.Mutex
	wbuf []byte
	need int
}

func newUDPConn(send func([]byte) error, local, remote net.Addr, closeFn func() error) *udpConn {
	u := &udpConn{send: send, local: local, remote: remote, close: closeFn, need: -1}
	u.cond = sync.NewCond(&u.mu)
	return u
}

func (u *udpConn) push(pkt []byte) {
	cp := append([]byte(nil), pkt...)
	u.mu.Lock()
	if !u.closed {
		u.in = append(u.in, cp)
		u.cond.Signal()
	}
	u.mu.Unlock()
}

func (u *udpConn) Read(p []byte) (int, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	for len(u.pending) == 0 {
		if u.closed && len(u.in) == 0 {
			return 0, io.EOF
		}
		if len(u.in) == 0 {
			u.cond.Wait()
			continue
		}
		pkt := u.in[0]
		u.in = u.in[1:]
		hdr := []byte{byte(len(pkt) >> 8), byte(len(pkt))}
		u.pending = append(hdr, pkt...)
	}
	n := copy(p, u.pending)
	u.pending = u.pending[n:]
	return n, nil
}

func (u *udpConn) Write(p []byte) (int, error) {
	u.wmu.Lock()
	defer u.wmu.Unlock()
	u.wbuf = append(u.wbuf, p...)
	for {
		if u.need < 0 {
			if len(u.wbuf) < 2 {
				return len(p), nil
			}
			u.need = int(binary.BigEndian.Uint16(u.wbuf[:2]))
			u.wbuf = append([]byte(nil), u.wbuf[2:]...)
			if u.need == 0 {
				u.need = -1
				continue
			}
		}
		if len(u.wbuf) < u.need {
			return len(p), nil
		}
		pkt := append([]byte(nil), u.wbuf[:u.need]...)
		u.wbuf = append([]byte(nil), u.wbuf[u.need:]...)
		u.need = -1
		if err := u.send(pkt); err != nil {
			return 0, err
		}
	}
}

func (u *udpConn) Close() error {
	u.mu.Lock()
	u.closed = true
	u.cond.Broadcast()
	u.mu.Unlock()
	if u.close != nil {
		return u.close()
	}
	return nil
}

func (u *udpConn) LocalAddr() net.Addr  { return u.local }
func (u *udpConn) RemoteAddr() net.Addr { return u.remote }

func (u *udpConn) SetDeadline(time.Time) error      { return nil }
func (u *udpConn) SetReadDeadline(time.Time) error  { return nil }
func (u *udpConn) SetWriteDeadline(time.Time) error { return nil }

// UDPListener accepts one framed conn per remote address. The first datagram
// is queued before Accept returns, so Serve reads the hard reset.
type UDPListener struct {
	pc    net.PacketConn
	mu    sync.Mutex
	peers map[string]*udpConn
	acc   chan *udpConn
	done  chan struct{}
}

// ListenUDP listens for OpenVPN's UDP transport.
func ListenUDP(addr string) (*UDPListener, error) {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, err
	}
	l := &UDPListener{
		pc: pc, peers: map[string]*udpConn{},
		acc: make(chan *udpConn, 16), done: make(chan struct{}),
	}
	go l.loop()
	return l, nil
}

func (l *UDPListener) loop() {
	buf := make([]byte, 65535)
	for {
		n, addr, err := l.pc.ReadFrom(buf)
		if err != nil {
			close(l.acc)
			return
		}
		if n == 0 || addr == nil {
			continue
		}
		key := addr.String()
		l.mu.Lock()
		peer := l.peers[key]
		fresh := peer == nil
		if fresh {
			remote := addr
			peer = newUDPConn(func(p []byte) error {
				_, err := l.pc.WriteTo(p, remote)
				return err
			}, l.pc.LocalAddr(), remote, func() error { return nil })
			l.peers[key] = peer
		}
		l.mu.Unlock()
		peer.push(buf[:n])
		if fresh {
			select {
			case l.acc <- peer:
			case <-l.done:
				return
			}
		}
	}
}

func (l *UDPListener) Accept() (net.Conn, error) {
	p, ok := <-l.acc
	if !ok {
		return nil, io.EOF
	}
	return p, nil
}

func (l *UDPListener) Close() error {
	select {
	case <-l.done:
	default:
		close(l.done)
	}
	return l.pc.Close()
}

func (l *UDPListener) Addr() net.Addr { return l.pc.LocalAddr() }

// DialUDP dials addr and returns a conn that speaks the length-prefixed
// stream over UDP datagrams.
func DialUDP(addr string) (net.Conn, error) {
	c, err := net.Dial("udp", addr)
	if err != nil {
		return nil, err
	}
	u := newUDPConn(func(p []byte) error {
		_, err := c.Write(p)
		return err
	}, c.LocalAddr(), c.RemoteAddr(), c.Close)
	go func() {
		buf := make([]byte, 65535)
		for {
			n, err := c.Read(buf)
			if n > 0 {
				u.push(buf[:n])
			}
			if err != nil {
				_ = u.Close()
				return
			}
		}
	}()
	return u, nil
}

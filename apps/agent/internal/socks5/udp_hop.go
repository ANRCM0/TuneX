package socks5

import (
	"net"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/socksaddr"
)

// UDPForward sends each client datagram to Target through a SOCKS5 UDP
// ASSOCIATE on Proxy. The TCP control connection stays open.
type UDPForward struct {
	Proxy  string
	User   string
	Pass   string
	Target string

	pc     net.PacketConn
	mu     sync.Mutex
	closed bool
	sess   map[string]*udpHop
	stats  forward.Stats
}

// TakeStats reports payload bytes sent through the SOCKS5 UDP relay.
func (f *UDPForward) TakeStats(reset bool) (forward.Stats, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := f.stats
	cur := len(f.sess)
	if reset {
		f.stats = forward.Stats{}
	}
	return st, cur
}

type udpHop struct {
	tcp net.Conn
	udp *net.UDPConn
}

// Listen binds addr and serves until Close.
func (f *UDPForward) Listen(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	f.pc = pc
	f.sess = map[string]*udpHop{}
	go f.loop()
	return nil
}

// Close stops the listener and the relay sessions.
func (f *UDPForward) Close() error {
	f.mu.Lock()
	f.closed = true
	sessions := f.sess
	f.sess = nil
	pc := f.pc
	f.mu.Unlock()
	var err error
	if pc != nil {
		err = pc.Close()
	}
	for _, s := range sessions {
		s.close()
	}
	return err
}

func (f *UDPForward) loop() {
	buf := make([]byte, 64*1024)
	for {
		n, client, err := f.pc.ReadFrom(buf)
		if err != nil {
			return
		}
		payload := append([]byte(nil), buf[:n]...)
		s, err := f.session(client)
		if err != nil {
			continue
		}
		pkt, err := EncodeUDP(addrOf(f.Target), payload)
		if err != nil {
			continue
		}
		if _, err := s.udp.Write(pkt); err != nil {
			continue
		}
		f.mu.Lock()
		f.stats.In += int64(len(payload))
		f.mu.Unlock()
	}
}

func (f *UDPForward) session(client net.Addr) (*udpHop, error) {
	key := client.String()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil, net.ErrClosed
	}
	if s, ok := f.sess[key]; ok {
		return s, nil
	}
	tcp, err := net.DialTimeout("tcp", f.Proxy, 15*time.Second)
	if err != nil {
		return nil, err
	}
	relay, err := Associate(tcp, f.User, f.Pass)
	if err != nil {
		_ = tcp.Close()
		return nil, err
	}
	dst, err := net.ResolveUDPAddr("udp", relay)
	if err != nil {
		_ = tcp.Close()
		return nil, err
	}
	udp, err := net.DialUDP("udp", nil, dst)
	if err != nil {
		_ = tcp.Close()
		return nil, err
	}
	s := &udpHop{tcp: tcp, udp: udp}
	f.sess[key] = s
	f.stats.Conns++
	go f.reply(client, s)
	return s, nil
}

func (f *UDPForward) reply(client net.Addr, s *udpHop) {
	buf := make([]byte, 64*1024)
	for {
		_ = s.udp.SetReadDeadline(time.Now().Add(60 * time.Second))
		n, err := s.udp.Read(buf)
		if err != nil {
			break
		}
		_, payload, err := DecodeUDP(buf[:n])
		if err != nil || f.pc == nil {
			continue
		}
		if _, err := f.pc.WriteTo(payload, client); err != nil {
			break
		}
		f.mu.Lock()
		f.stats.Out += int64(len(payload))
		f.mu.Unlock()
	}
	f.mu.Lock()
	if f.sess != nil && f.sess[client.String()] == s {
		delete(f.sess, client.String())
	}
	f.mu.Unlock()
	s.close()
}

func (s *udpHop) close() {
	if s.tcp != nil {
		_ = s.tcp.Close()
	}
	if s.udp != nil {
		_ = s.udp.Close()
	}
}

func addrOf(target string) socksaddr.Addr {
	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		return socksaddr.Addr{Host: target}
	}
	port := 0
	for _, c := range portStr {
		if c < '0' || c > '9' {
			return socksaddr.Addr{Host: host}
		}
		port = port*10 + int(c-'0')
	}
	return socksaddr.Addr{Host: host, Port: uint16(port)}
}

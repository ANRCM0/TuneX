package shadowsocks

import (
	"errors"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/socksaddr"
)

// UDPClient is the entrance half of a UDP port-forward whose first hop speaks
// shadowsocks UDP (panel connector type "ssu"). Datagrams from local clients
// are packed toward one fixed destination and sent to the hop. Replies are
// unpacked and written back to the client that sent them.
type UDPClient struct {
	Hop      string
	Method   string
	Password string
	Target   socksaddr.Addr
	// Allow rejects a remote address that fails the panel admission list.
	Allow func(net.Addr) bool
	// Bypass reports that the fixed forward target must not be sent.
	Bypass func(addr string) bool
	// Gate counts one client session as a connection and delays payload bytes.
	Gate *limit.Gate
	// Pick, when set, chooses the hop and the packed target for each client.
	// done runs when that session ends.
	Pick func(client net.Addr) (hop, method, password string, target socksaddr.Addr, done func())

	pc       net.PacketConn
	mu       sync.Mutex
	closed   bool
	sessions map[string]*udpClientSession
	stats    forward.Stats
}

// TakeStats reports payload bytes sent through the hop. Input is the client.
func (c *UDPClient) TakeStats(reset bool) (forward.Stats, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.stats
	cur := len(c.sessions)
	if reset {
		c.stats = forward.Stats{}
	}
	return st, cur
}

type udpClientSession struct {
	client   net.Addr
	conn     *net.UDPConn
	last     time.Time
	held     bool
	method   string
	password string
	target   socksaddr.Addr
	done     func()
}

// ListenUDP binds addr and starts forwarding to the hop.
func (c *UDPClient) ListenUDP(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	c.pc = pc
	if c.sessions == nil {
		c.sessions = map[string]*udpClientSession{}
	}
	go c.readLoop()
	go c.reap()
	return nil
}

// Addr returns the bound address.
func (c *UDPClient) Addr() net.Addr {
	if c.pc == nil {
		return nil
	}
	return c.pc.LocalAddr()
}

// Close stops the listener and the per-client hop sockets.
func (c *UDPClient) Close() error {
	c.mu.Lock()
	c.closed = true
	pc := c.pc
	var sessions []*udpClientSession
	for _, ses := range c.sessions {
		sessions = append(sessions, ses)
		c.release(ses)
	}
	c.sessions = nil
	c.mu.Unlock()
	var err error
	if pc != nil {
		err = pc.Close()
	}
	for _, ses := range sessions {
		_ = ses.conn.Close()
	}
	return err
}

func (c *UDPClient) readLoop() {
	buf := make([]byte, 64*1024)
	for {
		n, from, err := c.pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if c.Allow != nil && !c.Allow(from) {
			logx.Debugf("shadowsocks udp client: admission rejected %s", from)
			continue
		}
		if c.Pick == nil && c.Bypass != nil && c.Bypass(c.Target.String()) {
			logx.Debugf("shadowsocks udp client: bypass %s", c.Target)
			continue
		}
		if c.Gate != nil {
			c.Gate.Wait(from, n)
		}
		payload := append([]byte(nil), buf[:n]...)
		ses, err := c.session(from)
		if err != nil {
			logx.Warnf("shadowsocks udp client: %v", err)
			continue
		}
		pkt, err := PackUDP(ses.method, ses.password, ses.target, payload)
		if err != nil {
			logx.Warnf("shadowsocks udp client: pack: %v", err)
			continue
		}
		if _, err := ses.conn.Write(pkt); err != nil {
			logx.Warnf("shadowsocks udp client: write hop: %v", err)
			continue
		}
		c.mu.Lock()
		c.stats.In += int64(len(payload))
		c.mu.Unlock()
	}
}

func (c *UDPClient) session(from net.Addr) (*udpClientSession, error) {
	key := from.String()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, net.ErrClosed
	}
	if ses, ok := c.sessions[key]; ok {
		ses.last = time.Now()
		return ses, nil
	}
	hop, method, password, target := c.Hop, c.Method, c.Password, c.Target
	var done func()
	if c.Pick != nil {
		h, m, p, t, end := c.Pick(from)
		if h != "" {
			hop, method, password, target, done = h, m, p, t, end
		}
	}
	if c.Bypass != nil && c.Bypass(target.String()) {
		if done != nil {
			done()
		}
		logx.Debugf("shadowsocks udp client: bypass %s", target)
		return nil, errors.New("shadowsocks udp client: bypass")
	}
	if c.Gate != nil && !c.Gate.Enter(from) {
		if done != nil {
			done()
		}
		return nil, errors.New("shadowsocks udp client: connection limit")
	}
	fail := func(err error) (*udpClientSession, error) {
		if c.Gate != nil {
			c.Gate.Leave(from)
		}
		if done != nil {
			done()
		}
		return nil, err
	}
	raddr, err := net.ResolveUDPAddr("udp", hop)
	if err != nil {
		return fail(err)
	}
	conn, err := net.DialUDP("udp", nil, raddr)
	if err != nil {
		return fail(err)
	}
	ses := &udpClientSession{
		client: from, conn: conn, last: time.Now(), held: c.Gate != nil,
		method: method, password: password, target: target, done: done,
	}
	c.sessions[key] = ses
	c.stats.Conns++
	go c.replyLoop(key, ses)
	return ses, nil
}

func (c *UDPClient) replyLoop(key string, ses *udpClientSession) {
	buf := make([]byte, 64*1024)
	for {
		_ = ses.conn.SetReadDeadline(time.Now().Add(udpIdle))
		n, err := ses.conn.Read(buf)
		if err != nil {
			c.drop(key, ses)
			return
		}
		_, payload, err := UnpackUDP(ses.method, ses.password, buf[:n])
		if err != nil {
			continue
		}
		if c.Gate != nil {
			c.Gate.Wait(ses.client, len(payload))
		}
		c.mu.Lock()
		ses.last = time.Now()
		c.mu.Unlock()
		if _, err := c.pc.WriteTo(payload, ses.client); err != nil {
			return
		}
		c.mu.Lock()
		c.stats.Out += int64(len(payload))
		c.mu.Unlock()
	}
}

func (c *UDPClient) drop(key string, ses *udpClientSession) {
	c.mu.Lock()
	cur, ok := c.sessions[key]
	if ok && cur == ses {
		delete(c.sessions, key)
		c.release(ses)
	}
	c.mu.Unlock()
	_ = ses.conn.Close()
}

func (c *UDPClient) release(ses *udpClientSession) {
	if ses == nil {
		return
	}
	if ses.done != nil {
		ses.done()
		ses.done = nil
	}
	if !ses.held {
		return
	}
	ses.held = false
	if c.Gate != nil {
		c.Gate.Leave(ses.client)
	}
}

func (c *UDPClient) reap() {
	tick := time.NewTicker(udpIdle / 2)
	defer tick.Stop()
	for range tick.C {
		now := time.Now()
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		var stale []struct {
			key string
			ses *udpClientSession
		}
		for key, ses := range c.sessions {
			if now.Sub(ses.last) > udpIdle {
				stale = append(stale, struct {
					key string
					ses *udpClientSession
				}{key, ses})
				delete(c.sessions, key)
				c.release(ses)
			}
		}
		c.mu.Unlock()
		for _, item := range stale {
			_ = item.ses.conn.Close()
		}
	}
}

// TargetAddr parses a host:port forwarder into the SOCKS address packed into
// each datagram.
func TargetAddr(hostport string) (socksaddr.Addr, error) {
	host, portStr, err := net.SplitHostPort(hostport)
	if err != nil {
		return socksaddr.Addr{}, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 0 || port > 65535 {
		return socksaddr.Addr{}, err
	}
	return socksaddr.Addr{Host: host, Port: uint16(port)}, nil
}

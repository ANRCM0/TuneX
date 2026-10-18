package relay

import (
	"fmt"
	"net"
	"time"

	"sync"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/httpproxy"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/mtcp"
	"github.com/relayx/agent/internal/quicx"
	"github.com/relayx/agent/internal/relayx"
	"github.com/relayx/agent/internal/shadowsocks"
	"github.com/relayx/agent/internal/socks5"
	"github.com/relayx/agent/internal/tlstun"
	"github.com/relayx/agent/internal/wstun"
)

// Hop is one chain node the entrance dials before the real target.
type Hop struct {
	Addr      string
	Connector string
	Username  string
	Password  string
	// Dialer is "relayx" when the hop is the fork's websocket listener rather
	// than a plain TCP relay. Key/Host/Path are that dialer's metadata.
	Dialer string
	Key    string
	Host   string
	Path   string
}

// Dial connects to the first hop and sends a CONNECT for each following hop,
// ending at target. Every hop must speak relay (the panel's out-node connector).
func Dial(hops []Hop, target string) (net.Conn, error) {
	if target == "" {
		return nil, fmt.Errorf("relay: empty target")
	}
	if len(hops) == 0 {
		return (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", target)
	}
	conn, err := dialFirst(hops[0])
	if err != nil {
		return nil, err
	}
	for i, hop := range hops {
		next := target
		if i+1 < len(hops) {
			next = hops[i+1].Addr
		}
		var err error
		switch hop.Connector {
		case "", "relay":
			err = Handshake(conn, next, hop.Username, hop.Password)
		case "socks5":
			err = socks5.Connect(conn, next, hop.Username, hop.Password)
		case "ss":
			var wrapped net.Conn
			wrapped, err = shadowsocks.Client(conn, hop.Username, hop.Password, next)
			if err == nil {
				conn = wrapped
			}
		case "http":
			var wrapped net.Conn
			wrapped, err = httpproxy.Connect(conn, next, hop.Username, hop.Password)
			if err == nil {
				conn = wrapped
			}
		default:
			err = fmt.Errorf("relay: connector %q is not implemented", hop.Connector)
		}
		if err != nil {
			_ = conn.Close()
			return nil, err
		}
	}
	return conn, nil
}

// Forward is a plain TCP listener that reaches its target through Dial.
type Forward struct {
	Hops   []Hop
	Target string
	// Pick, when set, chooses the hops and target for each accepted
	// connection. done runs when that connection ends.
	Pick func(client net.Addr) (hops []Hop, target string, done func())
	// Observe records how long the dial to the first hop took.
	Observe func(addr string, d time.Duration)

	ln    net.Listener
	mu    sync.Mutex
	live  int
	stats forward.Stats
}

// TakeStats reports bytes copied through the chain for the panel observer.
// Input is the client. reset zeroes the counters but not the live count.
func (f *Forward) TakeStats(reset bool) (forward.Stats, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := f.stats
	cur := f.live
	if reset {
		f.stats = forward.Stats{}
	}
	return st, cur
}

// Listen binds addr. The zero Forward is usable.
func (f *Forward) Listen(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	f.ln = ln
	go f.acceptLoop()
	return nil
}

// Close stops the listener.
func (f *Forward) Close() error {
	if f.ln != nil {
		return f.ln.Close()
	}
	return nil
}

func (f *Forward) acceptLoop() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.serve(c)
	}
}

func (f *Forward) serve(c net.Conn) {
	defer c.Close()
	f.mu.Lock()
	f.live++
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.live--
		f.mu.Unlock()
	}()
	hops, target := f.Hops, f.Target
	var done func()
	if f.Pick != nil {
		if picked, tgt, end := f.Pick(c.RemoteAddr()); len(picked) > 0 {
			hops, target, done = picked, tgt, end
		}
	}
	if done != nil {
		defer done()
	}
	start := time.Now()
	dst, err := Dial(hops, target)
	if f.Observe != nil && len(hops) > 0 {
		d := time.Since(start)
		if err != nil {
			d = 30 * time.Second
		}
		f.Observe(hops[0].Addr, d)
	}
	if err != nil {
		logFail(err)
		return
	}
	defer dst.Close()
	in, out := splice(c, dst)
	f.mu.Lock()
	f.stats.Conns++
	f.stats.In += in
	f.stats.Out += out
	f.mu.Unlock()
}

func dialFirst(hop Hop) (net.Conn, error) {
	if hop.Dialer == "relayx" {
		return relayx.Dial(relayx.DialOptions{
			Addr: hop.Addr,
			Key:  hop.Key,
			Host: hop.Host,
			Path: hop.Path,
		})
	}
	if hop.Dialer == "quic" {
		return quicx.Dial(hop.Addr, hop.Host)
	}
	if hop.Dialer == "mtcp" {
		return mtcp.Dial(hop.Addr)
	}
	if hop.Dialer == "tls" || hop.Dialer == "mtls" {
		return tlstun.Dial(hop.Dialer, hop.Addr, hop.Host)
	}
	if hop.Dialer == "wss" || hop.Dialer == "mwss" {
		return wstun.Dial(hop.Dialer, hop.Addr, hop.Host, hop.Path)
	}
	return (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", hop.Addr)
}

func logFail(err error) {
	logx.Warnf("relay: dial: %v", err)
}

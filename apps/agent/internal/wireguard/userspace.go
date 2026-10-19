package wireguard

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/relayx/agent/internal/limit"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"

	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/openvpn"
)

// userspaceWG is a WireGuard device that does not need a kernel module or
// CAP_NET_ADMIN. Decrypted IPv4 packets are forwarded the same way as an
// OpenVPN data packet: UDP is dialed, ICMP echo to the interface address is
// answered, and TCP is a small NAT.
type userspaceWG struct {
	dev      *device.Device
	tun      *chanTUN
	nat      *openvpn.TCPNat
	stop     chan struct{}
	bypass   func(string) bool
	block    []string
	fallback bool
	gate     *limit.Gate
	mu       sync.Mutex
	held     map[string]net.Addr
	once     sync.Once
	rx       atomic.Int64
	tx       atomic.Int64
}

func (m *Manager) upUserspace() error {
	mtu := m.conf.MTU
	if mtu <= 0 {
		mtu = 1420
	}
	ct := newChanTUN(m.conf.Interface, mtu)
	dev := device.NewDevice(ct, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wireguard: "))
	ipc := ipcConfig(m.conf)
	if ipc == "" {
		// ipcConfig only returns "" when a key does not decode; without this the
		// device would come up with no private key at all.
		dev.Close()
		_ = ct.Close()
		return errors.New("wireguard: userspace config: invalid private or peer key")
	}
	if err := dev.IpcSet(ipc); err != nil {
		dev.Close()
		_ = ct.Close()
		return fmt.Errorf("wireguard: userspace config: %w", err)
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		_ = ct.Close()
		return fmt.Errorf("wireguard: userspace up: %w", err)
	}
	u := &userspaceWG{
		dev: dev, tun: ct, nat: openvpn.NewTCPNat(), stop: make(chan struct{}),
		bypass: m.bypass, block: m.block, fallback: m.fallback, gate: m.gate,
	}
	m.user = u
	m.up = true
	go u.loop(gatewayOf(m.conf.Address))
	logx.Infof("wireguard: userspace %s up (listen-port=%d peers=%d)", m.conf.Interface, m.conf.ListenPort, len(m.conf.Peers))
	return nil
}

func (u *userspaceWG) Close() {
	u.once.Do(func() {
		close(u.stop)
		if u.dev != nil {
			u.dev.Close()
		}
		if u.tun != nil {
			_ = u.tun.Close()
		}
		if u.nat != nil {
			u.nat.Close()
		}
		if u.gate != nil {
			u.mu.Lock()
			for _, addr := range u.held {
				u.gate.Leave(addr)
			}
			u.held = nil
			u.mu.Unlock()
		}
	})
}

func (u *userspaceWG) loop(gw net.IP) {
	for {
		select {
		case <-u.stop:
			return
		case pkt, ok := <-u.tun.out:
			if !ok {
				return
			}
			u.rx.Add(int64(len(pkt)))
			if dest, ok := openvpn.IPv4Dest(pkt); ok && u.bypass != nil && u.bypass(dest) {
				continue
			}
			if openvpn.L4Blocked(pkt, u.block, u.fallback) {
				continue
			}
			if !u.admit(pkt) {
				continue
			}
			reply, err := openvpn.ForwardIPv4UDP(pkt)
			if err != nil {
				reply, err = openvpn.ReplyICMP(pkt, gw)
			}
			if err != nil && u.nat != nil {
				reply, err = u.nat.Handle(pkt)
			}
			if err != nil || reply == nil {
				continue
			}
			u.tx.Add(int64(len(reply)))
			u.tun.inject(reply)
		case reply := <-u.nat.Replies():
			if len(reply) == 0 {
				continue
			}
			u.tx.Add(int64(len(reply)))
			u.tun.inject(reply)
		}
	}
}

// admit counts one inner IPv4 source against the panel climiter and waits
// for the bandwidth limit. Packets that are not IPv4 are allowed through.
func (u *userspaceWG) admit(pkt []byte) bool {
	if u.gate == nil {
		return true
	}
	src := innerSrc(pkt)
	if src == nil {
		return true
	}
	key := src.String()
	u.mu.Lock()
	if u.held == nil {
		u.held = map[string]net.Addr{}
	}
	_, ok := u.held[key]
	if !ok {
		if !u.gate.Enter(src) {
			u.mu.Unlock()
			return false
		}
		u.held[key] = src
	}
	u.mu.Unlock()
	u.gate.Wait(src, len(pkt))
	return true
}

func innerSrc(pkt []byte) net.Addr {
	if len(pkt) < 20 || pkt[0]>>4 != 4 {
		return nil
	}
	return &net.IPAddr{IP: append(net.IP(nil), pkt[12:16]...)}
}

func gatewayOf(addrs []string) net.IP {
	if len(addrs) == 0 {
		return nil
	}
	ip, _, err := net.ParseCIDR(addrs[0])
	if err != nil {
		return net.ParseIP(addrs[0])
	}
	return ip
}

func ipcConfig(cfg Config) string {
	var b strings.Builder
	priv, err := keyHex(cfg.PrivateKey)
	if err != nil {
		return ""
	}
	fmt.Fprintf(&b, "private_key=%s\n", priv)
	if cfg.ListenPort > 0 {
		fmt.Fprintf(&b, "listen_port=%d\n", cfg.ListenPort)
	}
	for _, p := range cfg.Peers {
		pub, err := keyHex(p.PublicKey)
		if err != nil {
			continue
		}
		fmt.Fprintf(&b, "public_key=%s\n", pub)
		if p.PresharedKey != "" {
			if psk, err := keyHex(p.PresharedKey); err == nil {
				fmt.Fprintf(&b, "preshared_key=%s\n", psk)
			}
		}
		if p.Endpoint != "" {
			fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint)
		}
		ips := p.AllowedIPs
		if len(ips) == 0 {
			ips = []string{"0.0.0.0/0"}
		}
		for _, ip := range ips {
			if ip = strings.TrimSpace(ip); ip != "" {
				fmt.Fprintf(&b, "allowed_ip=%s\n", ip)
			}
		}
		if p.PersistentKeepalive != nil {
			fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", *p.PersistentKeepalive)
		}
	}
	return b.String()
}

func keyHex(s string) (string, error) {
	s = strings.TrimSpace(s)
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		b, err = base64.RawStdEncoding.DecodeString(s)
	}
	if err != nil || len(b) != 32 {
		return "", fmt.Errorf("wireguard: key %q", s)
	}
	return hex.EncodeToString(b), nil
}

type chanTUN struct {
	name   string
	mtu    int
	in     chan []byte
	out    chan []byte
	events chan tun.Event
	closed chan struct{}
	once   sync.Once
}

func newChanTUN(name string, mtu int) *chanTUN {
	t := &chanTUN{
		name:   name,
		mtu:    mtu,
		in:     make(chan []byte, 32),
		out:    make(chan []byte, 32),
		events: make(chan tun.Event, 1),
		closed: make(chan struct{}),
	}
	t.events <- tun.EventUp
	return t
}

func (t *chanTUN) inject(pkt []byte) {
	select {
	case <-t.closed:
	case t.in <- append([]byte(nil), pkt...):
	}
}

func (t *chanTUN) File() *os.File { return nil }

func (t *chanTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	select {
	case <-t.closed:
		return 0, os.ErrClosed
	case pkt := <-t.in:
		if len(bufs) == 0 {
			return 0, nil
		}
		n := copy(bufs[0][offset:], pkt)
		sizes[0] = n
		return 1, nil
	}
}

func (t *chanTUN) Write(bufs [][]byte, offset int) (int, error) {
	for i, buf := range bufs {
		if offset > len(buf) {
			return i, nil
		}
		pkt := append([]byte(nil), buf[offset:]...)
		select {
		case <-t.closed:
			return i, os.ErrClosed
		case t.out <- pkt:
		}
	}
	return len(bufs), nil
}

func (t *chanTUN) MTU() (int, error)        { return t.mtu, nil }
func (t *chanTUN) Name() (string, error)    { return t.name, nil }
func (t *chanTUN) Events() <-chan tun.Event { return t.events }
func (t *chanTUN) BatchSize() int           { return 1 }
func (t *chanTUN) Close() error {
	t.once.Do(func() {
		close(t.closed)
		close(t.events)
	})
	return nil
}

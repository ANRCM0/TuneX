// Package wireguard drives WireGuard interfaces for the node's `wg` tunnels.
//
// Upstream links a WireGuard control library through go-gost/x. The replica
// drives the standard kernel interface through the `wg` and `ip` binaries
// instead, which produces exactly the same kernel state without vendoring a
// netlink library. When those tools (or the wireguard kernel module) are
// missing, Apply returns a descriptive error rather than pretending to work —
// see docs/AGENT.md.
package wireguard

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
)

// ErrUnavailable means the host cannot host WireGuard interfaces.
var ErrUnavailable = errors.New("wireguard: `wg`/`ip` tools or the wireguard kernel module are unavailable on this host")

// Peer is one WireGuard peer.
type Peer struct {
	PublicKey           string   `json:"publicKey"`
	PresharedKey        string   `json:"presharedKey,omitempty"`
	AllowedIPs          []string `json:"allowedIPs,omitempty"`
	PersistentKeepalive *int     `json:"persistentKeepalive,omitempty"`
	// Endpoint is optional. The panel's peers omit it; a client sets it to
	// host:port of the peer it dials.
	Endpoint string `json:"endpoint,omitempty"`
}

// Config describes a WireGuard interface to bring up.
type Config struct {
	Interface  string
	PrivateKey string
	Address    []string
	ListenPort int
	MTU        int
	Peers      []Peer
}

// Available reports whether the host can host WireGuard interfaces.
func Available() bool {
	_, errWG := exec.LookPath("wg")
	_, errIP := exec.LookPath("ip")
	if errWG != nil || errIP != nil {
		return false
	}
	return moduleLoaded()
}

func moduleLoaded() bool {
	if _, err := os.Stat("/sys/module/wireguard"); err == nil {
		return true
	}
	// A userspace implementation (wireguard-go) also creates the control socket.
	if _, err := os.Stat("/var/run/wireguard"); err == nil {
		return true
	}
	return false
}

// Manager owns one WireGuard interface for the lifetime of a tunnel.
type Manager struct {
	mu       sync.Mutex
	conf     Config
	up       bool
	user     *userspaceWG
	bypass   func(string) bool
	block    []string
	fallback bool
	gate     *limit.Gate
}

// SetPolicy attaches the panel bypass list and block.protocol. It is used by
// the userspace device, which can see decrypted packets. Call it before Up.
func (m *Manager) SetPolicy(bypass func(string) bool, block []string, fallback bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bypass = bypass
	m.block = block
	m.fallback = fallback
}

// SetGate attaches the panel connection and bandwidth limit. Call it before Up.
// The userspace device counts one inner IPv4 source as one connection.
func (m *Manager) SetGate(g *limit.Gate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gate = g
}

// New validates cfg without touching the system.
func New(cfg Config) (*Manager, error) {
	if cfg.Interface == "" {
		return nil, errors.New("wireguard: empty interface name")
	}
	if cfg.PrivateKey == "" {
		return nil, errors.New("wireguard: empty private key")
	}
	if cfg.ListenPort < 0 || cfg.ListenPort > 65535 {
		return nil, fmt.Errorf("wireguard: invalid listen port %d", cfg.ListenPort)
	}
	for _, p := range cfg.Peers {
		if p.PublicKey == "" {
			return nil, errors.New("wireguard: peer without public key")
		}
		for _, ip := range p.AllowedIPs {
			if _, _, err := net.ParseCIDR(ip); err != nil {
				if net.ParseIP(ip) == nil {
					return nil, fmt.Errorf("wireguard: peer %s has bad allowed IP %q", p.PublicKey, ip)
				}
			}
		}
	}
	return &Manager{conf: cfg}, nil
}

// Up creates (or reconfigures) the interface and brings it up.
func (m *Manager) Up() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !Available() {
		return m.upUserspace()
	}
	iface := m.conf.Interface

	if !m.exists() {
		if out, err := run("ip", "link", "add", "dev", iface, "type", "wireguard"); err != nil {
			return fmt.Errorf("wireguard: create %s: %v: %s", iface, err, out)
		}
	}

	keyFile, cleanup, err := writeTempSecret(m.conf.PrivateKey)
	if err != nil {
		return err
	}
	defer cleanup()

	args := []string{"set", iface, "private-key", keyFile}
	if m.conf.ListenPort > 0 {
		args = append(args, "listen-port", strconv.Itoa(m.conf.ListenPort))
	}
	for _, p := range m.conf.Peers {
		args = append(args, "peer", p.PublicKey)
		if len(p.AllowedIPs) > 0 {
			args = append(args, "allowed-ips", strings.Join(p.AllowedIPs, ","))
		}
		if p.PresharedKey != "" {
			pskFile, pskCleanup, err := writeTempSecret(p.PresharedKey)
			if err != nil {
				return err
			}
			defer pskCleanup()
			args = append(args, "preshared-key", pskFile)
		}
		if p.PersistentKeepalive != nil {
			args = append(args, "persistent-keepalive", strconv.Itoa(*p.PersistentKeepalive))
		}
	}
	if out, err := run("wg", args...); err != nil {
		return fmt.Errorf("wireguard: wg set %s: %v: %s", iface, err, out)
	}

	for _, a := range m.conf.Address {
		cidr := a
		if !strings.Contains(cidr, "/") {
			if ip := net.ParseIP(a); ip != nil {
				if ip.To4() != nil {
					cidr = a + "/32"
				} else {
					cidr = a + "/128"
				}
			}
		}
		if out, err := run("ip", "address", "add", cidr, "dev", iface); err != nil {
			if !strings.Contains(out, "File exists") {
				logx.Warnf("wireguard: ip address add %s dev %s: %v: %s", cidr, iface, err, out)
			}
		}
	}
	if m.conf.MTU > 0 {
		if out, err := run("ip", "link", "set", "mtu", strconv.Itoa(m.conf.MTU), "dev", iface); err != nil {
			logx.Warnf("wireguard: set mtu on %s: %v: %s", iface, err, out)
		}
	}
	if out, err := run("ip", "link", "set", "up", "dev", iface); err != nil {
		return fmt.Errorf("wireguard: bring up %s: %v: %s", iface, err, out)
	}
	m.up = true
	logx.Infof("wireguard: interface %s up (listen-port=%d peers=%d)", iface, m.conf.ListenPort, len(m.conf.Peers))
	return nil
}

// Down tears the interface down.
func (m *Manager) Down() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	iface := m.conf.Interface
	if m.user != nil {
		m.user.Close()
		m.user = nil
		m.up = false
		logx.Infof("wireguard: userspace %s down", iface)
		return nil
	}
	if !Available() {
		m.up = false
		return nil
	}
	if !m.exists() {
		m.up = false
		return nil
	}
	if out, err := run("ip", "link", "del", "dev", iface); err != nil {
		return fmt.Errorf("wireguard: delete %s: %v: %s", iface, err, out)
	}
	m.up = false
	logx.Infof("wireguard: interface %s down", iface)
	return nil
}

// Transfer sums peer receive and transmit counters from `wg show <iface> transfer`.
// Receive is bytes the peers sent (input). Transmit is bytes sent to the peers (output).
func (m *Manager) Transfer() (rx, tx int64, peers int, err error) {
	m.mu.Lock()
	if m.user != nil {
		rx, tx = m.user.rx.Load(), m.user.tx.Load()
		peers = len(m.conf.Peers)
		m.mu.Unlock()
		return rx, tx, peers, nil
	}
	iface := m.conf.Interface
	m.mu.Unlock()
	out, err := run("wg", "show", iface, "transfer")
	if err != nil {
		return 0, 0, 0, fmt.Errorf("wireguard: wg show %s transfer: %v: %s", iface, err, out)
	}
	rx, tx, peers = parseTransfer(out)
	return rx, tx, peers, nil
}

// parseTransfer reads `wg show transfer` lines: publicKey, rx bytes, tx bytes.
func parseTransfer(out string) (rx, tx int64, peers int) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		rin, err1 := strconv.ParseInt(fields[1], 10, 64)
		rout, err2 := strconv.ParseInt(fields[2], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rx += rin
		tx += rout
		peers++
	}
	return rx, tx, peers
}

// Up2 reports whether the interface is currently up.
func (m *Manager) IsUp() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.up
}

func (m *Manager) exists() bool {
	_, err := net.InterfaceByName(m.conf.Interface)
	return err == nil
}

func run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func writeTempSecret(secret string) (string, func(), error) {
	f, err := os.CreateTemp("", "relayx-wg-*.key")
	if err != nil {
		return "", func() {}, err
	}
	if _, err := f.WriteString(strings.TrimSpace(secret) + "\n"); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", func() {}, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(f.Name())
		return "", func() {}, err
	}
	if err := os.Chmod(f.Name(), 0o600); err != nil {
		_ = os.Remove(f.Name())
		return "", func() {}, err
	}
	return f.Name(), func() { _ = os.Remove(f.Name()) }, nil
}

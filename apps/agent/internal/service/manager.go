// Package service turns a panel `config` document into running listeners.
//
// Upstream hands the decrypted document to go-gost/x (`reload.Reload` →
// `config.Set` + `loader.Load`) and lets gost build the whole chain/service
// graph. The replica implements the subset a RelayX node actually needs:
// plain TCP/UDP port forwarding, Shadowsocks TCP and UDP (three AEAD ciphers),
// SOCKS5 (CONNECT and UDP ASSOCIATE), gost relay CONNECT (the out-node hop),
// gost relay BIND (remote TCP port-forward over smux, remote UDP over SOCKS frames),
// the relayx websocket listener (token + smux, no uTLS), QUIC, TLS, mTLS,
// WSS, MWSS, MTCP, VLESS over REALITY, mieru, OpenVPN (control channel and
// data packets, no TUN), and WireGuard. Everything else is reported
// as an explicit "not implemented in
// replica" result instead of silently doing nothing, so the panel operator can
// see exactly which tunnels are not served.
package service

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/relayx/agent/internal/admit"
	"github.com/relayx/agent/internal/bypass"
	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/gostcfg"
	"github.com/relayx/agent/internal/httpproxy"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/mierux"
	"github.com/relayx/agent/internal/mtcp"
	"github.com/relayx/agent/internal/observe"
	"github.com/relayx/agent/internal/openvpn"
	"github.com/relayx/agent/internal/quicx"
	"github.com/relayx/agent/internal/realityx"
	"github.com/relayx/agent/internal/relay"
	"github.com/relayx/agent/internal/relayx"
	"github.com/relayx/agent/internal/selfsign"
	"github.com/relayx/agent/internal/shadowsocks"
	"github.com/relayx/agent/internal/sniff"
	"github.com/relayx/agent/internal/socks5"
	"github.com/relayx/agent/internal/socksaddr"
	"github.com/relayx/agent/internal/tlstun"
	"github.com/relayx/agent/internal/vless"
	"github.com/relayx/agent/internal/wireguard"
	"github.com/relayx/agent/internal/wstun"
)

// ErrNotImplemented is the marker error for stubbed service types.
var ErrNotImplemented = errors.New("not implemented in replica")

// Options configures the manager from the agent's CLI config.
type Options struct {
	// ListenIP forces every listener onto this host (upstream `-l/--listen-ip`).
	ListenIP string
	// PortRange is the agent-level fallback port pool (upstream `-r/--port-range`).
	PortRange string
}

// Result is the outcome of applying one service.
type Result struct {
	Name string
	Type string
	Port int
	// Stub marks a service the replica deliberately does not implement.
	Stub   bool
	Reason string
	Err    error
}

// OK reports whether the service is running.
func (r Result) OK() bool { return r.Err == nil && !r.Stub }

// IsPortInUse reports whether the failure was an address conflict. Upstream
// only reports `ERR_PORT_IN_USE` to the panel for exactly this case
// (reports/AGENT_CONTROL.md C-B).
func (r Result) IsPortInUse() bool {
	if r.Err == nil {
		return false
	}
	var opErr *net.OpError
	if errors.As(r.Err, &opErr) {
		return errors.Is(opErr.Err, errnoAddrInUse)
	}
	return strings.Contains(strings.ToLower(r.Err.Error()), "address already in use")
}

type running struct {
	res     Result
	closer  io.Closer
	observe bool
	reset   bool
}

// sampler is implemented by listeners that can report gost-style byte counters.
type sampler interface {
	TakeStats(reset bool) (stats forward.Stats, current int)
}

// Manager owns every listener started from the current config.
type Manager struct {
	opts Options

	mu      sync.Mutex
	active  map[string]*running
	started bool
}

// New creates a manager.
func New(opts Options) *Manager {
	return &Manager{opts: opts, active: map[string]*running{}}
}

// Active returns the currently running services (by name).
func (m *Manager) Active() map[string]Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]Result, len(m.active))
	for k, v := range m.active {
		out[k] = v.res
	}
	return out
}

// Close stops every listener.
func (m *Manager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var firstErr error
	for name, r := range m.active {
		if err := r.closer.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(m.active, name)
	}
	return firstErr
}

// Apply reconciles the running listeners with cfg. Services that disappeared
// from the document are stopped; unchanged ones are left alone.
func (m *Manager) Apply(cfg *gostcfg.Config) []Result {
	want := map[string]gostcfg.Service{}
	for _, s := range cfg.Services {
		if s.Name != "" {
			want[s.Name] = s
		}
	}

	// Stop services that are gone or whose definition changed.
	m.mu.Lock()
	for name, r := range m.active {
		s, ok := want[name]
		if !ok || !sameDefinition(r.res, s) {
			logx.Infof("service: stopping %s", name)
			_ = r.closer.Close()
			delete(m.active, name)
		}
	}
	already := map[string]bool{}
	for name := range m.active {
		already[name] = true
	}
	m.mu.Unlock()

	results := make([]Result, 0, len(cfg.Services))
	for _, s := range cfg.Services {
		if already[s.Name] {
			m.mu.Lock()
			results = append(results, m.active[s.Name].res)
			m.mu.Unlock()
			continue
		}
		res, closer := m.start(cfg, s)
		results = append(results, res)
		if closer != nil {
			m.mu.Lock()
			m.active[s.Name] = &running{
				res:     res,
				closer:  closer,
				observe: s.Observer != "" || s.MetaBool("enableStats"),
				reset:   s.ResetTraffic(),
			}
			m.mu.Unlock()
		}
	}
	return results
}

// ObserveEvents snapshots every stats-enabled listener. When the service
// asked for resetTraffic, the counters are zeroed so the next event is a delta.
func (m *Manager) ObserveEvents() []observe.Event {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []observe.Event
	for name, r := range m.active {
		if !r.observe {
			continue
		}
		sm, ok := r.closer.(sampler)
		if !ok {
			continue
		}
		st, current := sm.TakeStats(r.reset)
		out = append(out, observe.Event{
			Kind:    "service",
			Service: name,
			Type:    "stats",
			Stats: &observe.Stats{
				TotalConns:   uint64(st.Conns),
				CurrentConns: uint64(current),
				InputBytes:   uint64(st.In),
				OutputBytes:  uint64(st.Out),
			},
		})
	}
	return out
}

func sameDefinition(res Result, s gostcfg.Service) bool {
	return res.Type != "" && res.Type == s.Kind()+"/"+s.HandlerType() && res.Port == gostcfg.ListenPort(s.Addr)
}

// start brings up one service, retrying the next candidate port when the
// address is already in use.
func (m *Manager) start(cfg *gostcfg.Config, s gostcfg.Service) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	fail := func(err error) (Result, io.Closer) {
		res.Err = err
		return res, nil
	}

	// Remote port-forward does not listen locally. The address is the port the
	// entrance is asked to bind, and `WAIT_LISTEN` means "let that side pick".
	if s.HandlerType() == "rtcp" || s.Kind() == "rtcp" {
		return m.startRemoteTCP(cfg, s)
	}
	if s.HandlerType() == "rudp" || s.Kind() == "rudp" {
		return m.startRemoteUDP(cfg, s)
	}

	host, candidates := m.resolveAddr(s.Addr)
	if len(candidates) == 0 {
		return fail(fmt.Errorf("service %s: no usable port in address %q", s.Name, s.Addr))
	}

	targets := cfg.Targets(&s)
	handlerType := s.HandlerType()
	kind := s.Kind()

	switch {
	case isWireGuard(kind, handlerType):
		return m.startWireGuard(cfg, s)

	case kind == "quic" && handlerType == "relay":
		return m.startQuic(cfg, s, host, candidates)

	case kind == "reality" && handlerType == "vless":
		return m.startVLESS(cfg, s, host, candidates)

	case kind == "mieru" && handlerType == "mieru":
		return m.startMieru(cfg, s)

	case kind == "openvpn":
		return m.startOpenVPN(cfg, s, host, candidates)

	case isStub(kind, handlerType):
		res.Stub = true
		res.Reason = fmt.Sprintf("%s/%s: %v", kind, handlerType, ErrNotImplemented)
		logx.Warnf("service %s: %s", s.Name, res.Reason)
		return res, nil

	case handlerType == "ss" && (kind == "tcp" || kind == "tls" || kind == "mtls"):
		return m.startShadowsocks(cfg, s, host, candidates)

	case handlerType == "ssu":
		// A cipher in auth.username is gost handler/ss/udp. No credentials is
		// the same handler with method "none": the panel's UDP out-node hop.
		return m.startShadowsocksUDP(cfg, s, host, candidates)

	case kind == "udp" && udpShadowsocksHop(cfg.FirstHopConnectorType(&s)):
		return m.startShadowsocksUDPHop(cfg, s, host, candidates)

	case kind == "udp" && cfg.FirstHopConnectorType(&s) == "socks5":
		if _, target := cfg.Route(&s); target != "" {
			return m.startSocks5UDPHop(cfg, s, host, candidates)
		}
		return m.startUDP(cfg, s, host, candidates, targets)

	case handlerType == "socks5" && kind == "udp":
		return m.startSocksUDP(cfg, s, host, candidates)

	case handlerType == "socks5":
		return m.startSocksTCP(cfg, s, host, candidates)

	case kind == "mtcp" && handlerType == "relay":
		return m.startMTCP(s, host, candidates)

	case (kind == "tls" || kind == "mtls") && handlerType == "relay":
		return m.startTLS(cfg, s, host, candidates)

	case (kind == "wss" || kind == "mwss") && handlerType == "relay":
		return m.startWSS(cfg, s, host, candidates)

	case kind == "relayx" && handlerType == "relay":
		return m.startRelayx(s, host, candidates)

	case kind == "relayx":
		res.Stub = true
		res.Reason = "relayx listener: handler " + handlerType + " is not implemented in replica"
		logx.Warnf("service %s: %s", s.Name, res.Reason)
		return res, nil

	case handlerType == "relay" && kind != "udp":
		return m.startRelayServer(cfg, s, host, candidates)

	case isPlainForward(kind, handlerType) && hopProtocol(cfg.FirstHopConnectorType(&s)):
		return m.startRelayForward(cfg, s, host, candidates)

	case handlerType == "http" && kind == "tcp":
		return m.startHTTPProxy(cfg, s, host, candidates)

	case kind == "udp":
		return m.startUDP(cfg, s, host, candidates, targets)

	case kind == "tcp" || kind == "tls" || kind == "ws" || kind == "wss" || kind == "mwss" || kind == "mtls":
		if len(targets) == 0 {
			return fail(fmt.Errorf("service %s: %s/%s has no forward target", s.Name, kind, handlerType))
		}
		return m.startTCP(cfg, s, host, candidates, targets)

	default:
		res.Stub = true
		res.Reason = fmt.Sprintf("%s/%s: %v", kind, handlerType, ErrNotImplemented)
		logx.Warnf("service %s: %s", s.Name, res.Reason)
		return res, nil
	}
}

func (m *Manager) startHTTPProxy(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	srv := &httpproxy.Server{
		Allow:         serviceAllow(cfg, s),
		Bypass:        serviceBypass(cfg, s),
		Gate:          serviceGate(cfg, s),
		Dial:          chainDialer(cfg, s),
		SniffFallback: sniffFallback(s),
		ProxyV1:       s.Handler != nil && s.Handler.MetaString("proxyProtocol") == "1",
	}
	if s.Handler != nil {
		srv.Block = s.Handler.MetaStrings("block.protocol")
		if s.Handler.Auth != nil {
			srv.Username = s.Handler.Auth.Username
			srv.Password = s.Handler.Auth.Password
		}
	}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: http proxy listening on %s", s.Name, addr)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startTCP(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int, targets []string) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		proxyV1 := s.Handler != nil && s.Handler.MetaString("proxyProtocol") == "1"
		var block []string
		fallback := false
		if s.Handler != nil {
			block = s.Handler.MetaStrings("block.protocol")
			fallback = s.Handler.MetaBool("sniffing.fallback")
		}
		var choose func(net.Addr) (string, func())
		var observe func(string, time.Duration)
		if b := cfg.NewBalancer(&s); b != nil {
			choose = b.Next
			observe = b.Observe
		}
		srv, err := forward.StartTCP(addr, pick(targets, 0), proxyV1, block, serviceAllow(cfg, s), serviceBypass(cfg, s), serviceGate(cfg, s), choose, fallback)
		if err != nil {
			lastErr = err
			continue
		}
		srv.Observe = observe
		res.Port = port
		logx.Infof("service %s: tcp %s -> %v", s.Name, addr, targets)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startSocks5UDPHop(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	route, target := cfg.Route(&s)
	if target == "" || len(route) == 0 {
		res.Err = fmt.Errorf("service %s: socks5 udp hop has no target", s.Name)
		return res, nil
	}
	hop := route[0]
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		fwd := &socks5.UDPForward{Proxy: hop.Addr, User: hop.Username, Pass: hop.Password, Target: target}
		if err := fwd.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: udp %s -> %s via socks5 %s", s.Name, addr, target, hop.Addr)
		return res, fwd
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startUDP(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int, targets []string) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	if len(targets) == 0 {
		res.Err = fmt.Errorf("service %s: udp/%s has no forward target", s.Name, s.HandlerType())
		return res, nil
	}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		var choose func(net.Addr) (string, func())
		var observe func(string, time.Duration)
		if b := cfg.NewBalancer(&s); b != nil {
			choose = b.Next
			observe = b.Observe
		}
		srv, err := forward.StartUDP(addr, pick(targets, 0), serviceAllow(cfg, s), serviceBypass(cfg, s), serviceGate(cfg, s), choose)
		if err != nil {
			lastErr = err
			continue
		}
		srv.Observe = observe
		srv.Idle = listenerKeepaliveTTL(s)
		res.Port = port
		logx.Infof("service %s: udp %s -> %v", s.Name, addr, targets)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startSocksTCP(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	var block []string
	if s.Handler != nil {
		block = s.Handler.MetaStrings("block.protocol")
	}
	srv := &socks5.Server{Username: user, Password: pass, AllowUDP: socksUDPAllowed(s), Block: block, SniffFallback: sniffFallback(s), Allow: serviceAllow(cfg, s), Bypass: serviceBypass(cfg, s), Gate: serviceGate(cfg, s), Dial: chainDialer(cfg, s), ProxyV1: s.Handler != nil && s.Handler.MetaString("proxyProtocol") == "1"}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: socks5 listening on %s (udp=%v)", s.Name, addr, srv.AllowUDP)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

// startRelayx is the out-node listener for tunnel type relayx: websocket
// upgrade, HKDF bearer token, then smux streams served as gost-relay.
func (m *Manager) startRelayx(s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	key := ""
	path := ""
	if s.Listener != nil {
		key = s.Listener.MetaString("key")
		path = s.Listener.MetaString("path")
	}
	if key == "" {
		res.Err = fmt.Errorf("service %s: relayx listener has no metadata key", s.Name)
		return res, nil
	}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	inner := &relay.Server{
		Username:  user,
		Password:  pass,
		AllowBind: s.Handler != nil && s.Handler.MetaBool("bind"),
	}
	rx := &relayx.Server{Key: key, Path: path, Serve: inner.ServeConn}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := rx.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: relayx listening on %s", s.Name, addr)
		return res, closerFunc(func() error {
			_ = rx.Close()
			return inner.Close()
		})
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startQuic(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	inner := &relay.Server{
		Username:  user,
		Password:  pass,
		AllowBind: s.Handler != nil && s.Handler.MetaBool("bind"),
	}
	q := &quicx.Server{Name: cfg.TLSName(), Serve: inner.ServeConn}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := q.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: quic listening on %s", s.Name, addr)
		return res, closerFunc(func() error {
			_ = q.Close()
			return inner.Close()
		})
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startMTCP(s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	inner := &relay.Server{
		Username:  user,
		Password:  pass,
		AllowBind: s.Handler != nil && s.Handler.MetaBool("bind"),
	}
	srv := &mtcp.Server{Serve: inner.ServeConn}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: mtcp listening on %s", s.Name, addr)
		return res, closerFunc(func() error {
			_ = srv.Close()
			return inner.Close()
		})
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startTLS(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	inner := &relay.Server{
		Username:  user,
		Password:  pass,
		AllowBind: s.Handler != nil && s.Handler.MetaBool("bind"),
	}
	srv := &tlstun.Server{Name: cfg.TLSName(), Mux: s.Kind() == "mtls", Serve: inner.ServeConn}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: %s listening on %s", s.Name, s.Kind(), addr)
		return res, closerFunc(func() error {
			_ = srv.Close()
			return inner.Close()
		})
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startWSS(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	inner := &relay.Server{
		Username:  user,
		Password:  pass,
		AllowBind: s.Handler != nil && s.Handler.MetaBool("bind"),
	}
	path := ""
	if s.Listener != nil {
		path = s.Listener.MetaString("path")
	}
	srv := &wstun.Server{
		Name:  cfg.TLSName(),
		Path:  path,
		Mux:   s.Kind() == "mwss",
		Serve: inner.ServeConn,
	}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: %s listening on %s", s.Name, s.Kind(), addr)
		return res, closerFunc(func() error {
			_ = srv.Close()
			return inner.Close()
		})
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startRelayServer(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	user, pass := "", ""
	if s.Handler != nil && s.Handler.Auth != nil {
		user = s.Handler.Auth.Username
		pass = s.Handler.Auth.Password
	}
	allowBind := s.Handler != nil && s.Handler.MetaBool("bind")
	block := []string(nil)
	if s.Handler != nil {
		block = s.Handler.MetaStrings("block.protocol")
	}
	srv := &relay.Server{Username: user, Password: pass, AllowBind: allowBind, Bypass: serviceBypass(cfg, s), Block: block, SniffFallback: sniffFallback(s)}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: relay listening on %s (bind=%v)", s.Name, addr, allowBind)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startRelayForward(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	route, target := cfg.Route(&s)
	if target == "" {
		res.Err = fmt.Errorf("service %s: relay chain has no forwarder target", s.Name)
		return res, nil
	}
	if len(route) == 0 {
		res.Err = fmt.Errorf("service %s: relay chain has no hop", s.Name)
		return res, nil
	}
	hops := make([]relay.Hop, len(route))
	for i, h := range route {
		hops[i] = relay.Hop{
			Addr: h.Addr, Connector: h.Connector, Username: h.Username, Password: h.Password,
			Dialer: h.Dialer, Key: h.Key, Host: h.Host, Path: h.Path,
		}
	}
	var pick func(net.Addr) ([]relay.Hop, string, func())
	var observe func(string, time.Duration)
	if cr := cfg.NewChainRoute(&s); cr != nil {
		observe = cr.Observe
		pick = func(client net.Addr) ([]relay.Hop, string, func()) {
			chosen, tgt, done := cr.Next(client, "")
			if len(chosen) == 0 {
				return nil, "", done
			}
			out := make([]relay.Hop, len(chosen))
			for i, h := range chosen {
				out[i] = relay.Hop{
					Addr: h.Addr, Connector: h.Connector, Username: h.Username, Password: h.Password,
					Dialer: h.Dialer, Key: h.Key, Host: h.Host, Path: h.Path,
				}
			}
			if tgt == "" {
				tgt = target
			}
			return out, tgt, done
		}
	}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		fwd := &relay.Forward{Hops: hops, Target: target, Pick: pick, Observe: observe}
		if err := fwd.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		via := hops[0].Connector
		if via == "" {
			via = "relay"
		}
		logx.Infof("service %s: tcp %s -> %s via %s %s", s.Name, addr, target, via, hops[0].Addr)
		return res, fwd
	}
	res.Err = lastErr
	return res, nil
}

// startRemoteTCP is the out-node half of a remote port-forward: dial the
// entrance's relay handler (metadata.bind) and ask it to listen, then splice
// each accepted public connection to the forwarder.
func (m *Manager) startRemoteTCP(cfg *gostcfg.Config, s gostcfg.Service) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	route, target := cfg.Route(&s)
	if target == "" {
		res.Err = fmt.Errorf("service %s: remote forward has no forwarder target", s.Name)
		return res, nil
	}
	if len(route) == 0 {
		res.Err = fmt.Errorf("service %s: remote forward has no relay hop", s.Name)
		return res, nil
	}
	hops := make([]relay.Hop, len(route))
	for i, h := range route {
		hops[i] = relay.Hop{
			Addr: h.Addr, Connector: h.Connector, Username: h.Username, Password: h.Password,
			Dialer: h.Dialer, Key: h.Key, Host: h.Host, Path: h.Path,
		}
	}
	ln, err := relay.DialBind(hops, s.Addr)
	if err != nil {
		res.Err = err
		return res, nil
	}
	var choose func(net.Addr) (string, func())
	if b := cfg.NewBalancer(&s); b != nil {
		choose = b.Next
	}
	fwd := &remoteForward{ln: ln, target: target, gate: serviceGate(cfg, s), pick: choose}
	go fwd.loop()
	res.Port = gostcfg.ListenPort(ln.Addr().String())
	logx.Infof("service %s: remote tcp %s -> %s via relay %s", s.Name, ln.Addr(), target, hops[0].Addr)
	return res, fwd
}

// startRemoteUDP is the out-node half of a remote UDP forward. The entrance
// (relay handler, metadata.bind) listens for UDP; datagrams come back framed
// on the TCP control connection and are written to the forwarder.
func (m *Manager) startRemoteUDP(cfg *gostcfg.Config, s gostcfg.Service) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	route, target := cfg.Route(&s)
	if target == "" {
		res.Err = fmt.Errorf("service %s: remote udp forward has no forwarder target", s.Name)
		return res, nil
	}
	if len(route) == 0 {
		res.Err = fmt.Errorf("service %s: remote udp forward has no relay hop", s.Name)
		return res, nil
	}
	hops := make([]relay.Hop, len(route))
	for i, h := range route {
		hops[i] = relay.Hop{
			Addr: h.Addr, Connector: h.Connector, Username: h.Username, Password: h.Password,
			Dialer: h.Dialer, Key: h.Key, Host: h.Host, Path: h.Path,
		}
	}
	tun, err := relay.DialBindUDP(hops, s.Addr)
	if err != nil {
		res.Err = err
		return res, nil
	}
	var choose func(net.Addr) (string, func())
	if b := cfg.NewBalancer(&s); b != nil {
		choose = b.Next
	}
	fwd := &remoteUDP{tun: tun, target: target, peers: map[string]*net.UDPConn{}, dones: map[string]func(){}, gate: serviceGate(cfg, s), pick: choose}
	go fwd.loop()
	res.Port = gostcfg.ListenPort(tun.LocalAddr().String())
	logx.Infof("service %s: remote udp %s -> %s via relay %s", s.Name, tun.LocalAddr(), target, hops[0].Addr)
	return res, fwd
}

// remoteUDP forwards framed public datagrams to one UDP target. Each public
// peer gets its own connected socket so replies can be routed back.
type remoteUDP struct {
	tun    *relay.UDPTun
	target string
	pick   func(net.Addr) (string, func())
	mu     sync.Mutex
	peers  map[string]*net.UDPConn
	dones  map[string]func()
	closed bool
	gate   *limit.Gate
}

func (f *remoteUDP) Close() error {
	f.mu.Lock()
	f.closed = true
	peers := f.peers
	dones := f.dones
	f.peers = nil
	f.dones = nil
	f.mu.Unlock()
	for _, c := range peers {
		_ = c.Close()
	}
	for _, done := range dones {
		done()
	}
	if f.tun != nil {
		return f.tun.Close()
	}
	return nil
}

func (f *remoteUDP) loop() {
	buf := make([]byte, 64*1024)
	for {
		n, peer, err := f.tun.ReadFrom(buf)
		if err != nil {
			return
		}
		if peer == nil {
			continue
		}
		payload := append([]byte(nil), buf[:n]...)
		c, err := f.session(peer)
		if err != nil {
			logx.Warnf("relay: remote udp dial %s: %v", f.target, err)
			continue
		}
		if f.gate != nil {
			f.gate.Wait(peer, len(payload))
		}
		if _, err := c.Write(payload); err != nil {
			logx.Warnf("relay: remote udp write %s: %v", f.target, err)
		}
	}
}

func (f *remoteUDP) session(peer net.Addr) (*net.UDPConn, error) {
	key := peer.String()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil, net.ErrClosed
	}
	if c, ok := f.peers[key]; ok {
		return c, nil
	}
	if f.gate != nil && !f.gate.Enter(peer) {
		return nil, errors.New("relay: remote udp connection limit")
	}
	target := f.target
	var done func()
	if f.pick != nil {
		if addr, end := f.pick(peer); addr != "" {
			target, done = addr, end
		}
	}
	fail := func(err error) (*net.UDPConn, error) {
		if f.gate != nil {
			f.gate.Leave(peer)
		}
		if done != nil {
			done()
		}
		return nil, err
	}
	dst, err := net.ResolveUDPAddr("udp", target)
	if err != nil {
		return fail(err)
	}
	c, err := net.DialUDP("udp", nil, dst)
	if err != nil {
		return fail(err)
	}
	f.peers[key] = c
	if done != nil {
		if f.dones == nil {
			f.dones = map[string]func(){}
		}
		f.dones[key] = done
	}
	go f.reply(peer, c)
	return c, nil
}

func (f *remoteUDP) reply(peer net.Addr, c *net.UDPConn) {
	defer func() {
		f.mu.Lock()
		if f.peers != nil && f.peers[peer.String()] == c {
			delete(f.peers, peer.String())
		}
		var done func()
		if f.dones != nil {
			done = f.dones[peer.String()]
			delete(f.dones, peer.String())
		}
		f.mu.Unlock()
		if done != nil {
			done()
		}
		_ = c.Close()
		if f.gate != nil {
			f.gate.Leave(peer)
		}
	}()
	buf := make([]byte, 64*1024)
	for {
		_ = c.SetReadDeadline(time.Now().Add(60 * time.Second))
		n, err := c.Read(buf)
		if err != nil {
			return
		}
		if f.gate != nil {
			f.gate.Wait(peer, n)
		}
		if _, err := f.tun.WriteTo(buf[:n], peer); err != nil {
			return
		}
	}
}

// remoteForward accepts smux streams from a relay BIND and dials the forwarder.
type remoteForward struct {
	ln     *relay.Listener
	target string
	pick   func(net.Addr) (string, func())
	gate   *limit.Gate

	mu    sync.Mutex
	live  int
	stats forward.Stats
}

func (f *remoteForward) TakeStats(reset bool) (forward.Stats, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st := f.stats
	cur := f.live
	if reset {
		f.stats = forward.Stats{}
	}
	return st, cur
}

func (f *remoteForward) Close() error {
	if f.ln != nil {
		return f.ln.Close()
	}
	return nil
}

func (f *remoteForward) loop() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.serve(c)
	}
}

func (f *remoteForward) serve(c net.Conn) {
	defer c.Close()
	if f.gate != nil && !f.gate.Enter(c.RemoteAddr()) {
		logx.Warnf("relay: remote tcp limit rejected %s", c.RemoteAddr())
		return
	}
	if f.gate != nil {
		defer f.gate.Leave(c.RemoteAddr())
	}
	target := f.target
	var done func()
	if f.pick != nil {
		if addr, end := f.pick(c.RemoteAddr()); addr != "" {
			target, done = addr, end
		}
	}
	if done != nil {
		defer done()
	}
	dst, err := net.DialTimeout("tcp", target, 15*time.Second)
	if err != nil {
		logx.Warnf("relay: remote dial %s: %v", f.target, err)
		return
	}
	defer dst.Close()
	f.mu.Lock()
	f.live++
	f.stats.Conns++
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.live--
		f.mu.Unlock()
	}()
	fromClient := io.Reader(c)
	fromTarget := io.Reader(dst)
	if f.gate != nil {
		fromClient = limit.NewReader(c, f.gate, c.RemoteAddr())
		fromTarget = limit.NewReader(dst, f.gate, c.RemoteAddr())
	}
	go func() {
		n, _ := io.Copy(dst, fromClient)
		f.mu.Lock()
		f.stats.In += n
		f.mu.Unlock()
	}()
	n, _ := io.Copy(c, fromTarget)
	f.mu.Lock()
	f.stats.Out += n
	f.mu.Unlock()
}

// hopProtocol is a connector the entrance can speak on the way to the
// forwarder. relay is the out-node hop; socks5, ss and http are the
// forward-address protocols the panel puts on hop-forwarder.
func udpShadowsocksHop(connector string) bool {
	return connector == "ssu" || connector == "ss"
}

func hopProtocol(connector string) bool {
	switch connector {
	case "relay", "socks5", "ss", "http":
		return true
	default:
		return false
	}
}

func isPlainForward(kind, handler string) bool {
	switch kind {
	case "tcp", "tls", "ws", "wss", "mwss", "mtls":
	default:
		return false
	}
	return handler == "" || handler == "tcp" || handler == "forward"
}

func (m *Manager) startSocksUDP(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	srv := &socks5.UDPServer{Allow: serviceAllow(cfg, s), Bypass: serviceBypass(cfg, s), Gate: serviceGate(cfg, s), Idle: listenerKeepaliveTTL(s)}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.ListenUDP(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: socks5-udp listening on %s", s.Name, addr)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

// socksUDPAllowed reports whether UDP ASSOCIATE is enabled. The panel always
// sets metadata.udp=true for a socks5 handler; a missing key still allows it,
// and an explicit false rejects the command.
func socksUDPAllowed(s gostcfg.Service) bool {
	if s.Handler == nil || s.Handler.Metadata == nil {
		return true
	}
	if _, ok := s.Handler.Metadata["udp"]; !ok {
		return true
	}
	return s.Handler.MetaBool("udp")
}

func (m *Manager) startShadowsocks(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}

	method, password := shadowsocksCreds(s)
	if method == "" || password == "" {
		res.Err = fmt.Errorf("service %s: shadowsocks handler without method/password (auth=%v metadata=%v)", s.Name, s.Auth, s.Handler.Metadata)
		return res, nil
	}
	if !shadowsocks.Supported(method) {
		res.Stub = true
		res.Reason = fmt.Sprintf("shadowsocks cipher %q is not one of the replica's supported ciphers %v", method, shadowsocks.AllowedMethods)
		logx.Warnf("service %s: %s", s.Name, res.Reason)
		return res, nil
	}
	srv, err := shadowsocks.New(method, password)
	if err != nil {
		res.Err = err
		return res, nil
	}
	if s.Handler != nil {
		srv.Block = s.Handler.MetaStrings("block.protocol")
		srv.SniffFallback = s.Handler.MetaBool("sniffing.fallback")
		srv.ProxyV1 = s.Handler.MetaString("proxyProtocol") == "1"
	}
	srv.Allow = serviceAllow(cfg, s)
	srv.Bypass = serviceBypass(cfg, s)
	srv.Gate = serviceGate(cfg, s)
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.Listen(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: shadowsocks(%s) listening on %s", s.Name, method, addr)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

func (m *Manager) startShadowsocksUDP(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	method, password := shadowsocksCreds(s)
	if method == "" && password == "" {
		method = "none"
	}
	if !shadowsocks.Supported(method) {
		res.Stub = true
		res.Reason = fmt.Sprintf("shadowsocks cipher %q is not one of the replica's supported ciphers %v", method, shadowsocks.AllowedMethods)
		logx.Warnf("service %s: %s", s.Name, res.Reason)
		return res, nil
	}
	srv, err := shadowsocks.NewUDP(method, password)
	if err != nil {
		res.Err = err
		return res, nil
	}
	srv.Allow = serviceAllow(cfg, s)
	srv.Bypass = serviceBypass(cfg, s)
	srv.Gate = serviceGate(cfg, s)
	srv.Block = blockProtocols(s)
	srv.SniffFallback = sniffFallback(s)
	srv.Idle = listenerKeepaliveTTL(s)
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := srv.ListenUDP(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		logx.Infof("service %s: shadowsocks-udp(%s) listening on %s", s.Name, method, addr)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

// startShadowsocksUDPHop is the entrance of a UDP port-forward. The panel's
// out-node connector is "ssu" with no cipher, so the default method is "none".
func (m *Manager) startShadowsocksUDPHop(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	route, target := cfg.Route(&s)
	if target == "" {
		res.Err = fmt.Errorf("service %s: udp hop has no forwarder target", s.Name)
		return res, nil
	}
	if len(route) == 0 {
		res.Err = fmt.Errorf("service %s: udp hop has no ssu connector", s.Name)
		return res, nil
	}
	hop := route[0]
	method, password := hop.Username, hop.Password
	if method == "" && password == "" {
		method = "none"
	}
	if !shadowsocks.Supported(method) {
		res.Stub = true
		res.Reason = fmt.Sprintf("shadowsocks cipher %q is not one of the replica's supported ciphers %v", method, shadowsocks.AllowedMethods)
		return res, nil
	}
	dst, err := shadowsocks.TargetAddr(target)
	if err != nil {
		res.Err = err
		return res, nil
	}
	cli := &shadowsocks.UDPClient{Hop: hop.Addr, Method: method, Password: password, Target: dst, Allow: serviceAllow(cfg, s), Bypass: serviceBypass(cfg, s), Gate: serviceGate(cfg, s)}
	if cr := cfg.NewChainRoute(&s); cr != nil {
		fallback := target
		cli.Pick = func(client net.Addr) (string, string, string, socksaddr.Addr, func()) {
			chosen, tgt, done := cr.Next(client, "")
			if len(chosen) == 0 {
				if done != nil {
					done()
				}
				return "", "", "", socksaddr.Addr{}, nil
			}
			h := chosen[0]
			m, p := h.Username, h.Password
			if m == "" && p == "" {
				m = "none"
			}
			addr := tgt
			if addr == "" {
				addr = fallback
			}
			packed, err := shadowsocks.TargetAddr(addr)
			if err != nil {
				if done != nil {
					done()
				}
				return "", "", "", socksaddr.Addr{}, nil
			}
			return h.Addr, m, p, packed, done
		}
	}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		if err := cli.ListenUDP(addr); err != nil {
			lastErr = err
			continue
		}
		res.Port = port
		via := cfg.FirstHopConnectorType(&s)
		if via == "" {
			via = "ssu"
		}
		logx.Infof("service %s: udp %s -> %s via %s %s (%s)", s.Name, addr, target, via, hop.Addr, method)
		return res, cli
	}
	res.Err = lastErr
	return res, nil
}

func relayHops(hops []gostcfg.RouteHop) []relay.Hop {
	out := make([]relay.Hop, len(hops))
	for i, h := range hops {
		out[i] = relay.Hop{
			Addr: h.Addr, Connector: h.Connector, Username: h.Username, Password: h.Password,
			Dialer: h.Dialer, Key: h.Key, Host: h.Host, Path: h.Path,
		}
	}
	return out
}

// chainDialer reaches a user target through the service chain. Each call picks
// the hop. The forwarder address is not used: SOCKS, VLESS and mieru carry the
// destination in the request. A least-connection count is released when the
// returned connection is closed.
func hostOnly(target string) string {
	host, _, err := net.SplitHostPort(target)
	if err != nil {
		return target
	}
	return host
}

func chainDialer(cfg *gostcfg.Config, s gostcfg.Service) func(client net.Addr, target string) (net.Conn, error) {
	route, _ := cfg.Route(&s)
	fallback := relayHops(route)
	cr := cfg.NewChainRoute(&s)
	return func(client net.Addr, target string) (net.Conn, error) {
		hops := fallback
		var done func()
		if cr != nil {
			chosen, _, end := cr.Next(client, hostOnly(target))
			if len(chosen) > 0 {
				hops = relayHops(chosen)
				done = end
			}
		}
		c, err := relay.Dial(hops, target)
		if err != nil {
			if done != nil {
				done()
			}
			return nil, err
		}
		if done == nil {
			return c, nil
		}
		return &releaseConn{Conn: c, done: done}, nil
	}
}

type releaseConn struct {
	net.Conn
	once sync.Once
	done func()
}

func (c *releaseConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		if c.done != nil {
			c.done()
		}
	})
	return err
}

// startMieru is the panel's mieru entrance. The library binds the port.
func (m *Manager) startMieru(cfg *gostcfg.Config, s gostcfg.Service) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	if s.Listener == nil {
		res.Err = fmt.Errorf("service %s: mieru listener is missing", s.Name)
		return res, nil
	}
	users, err := mierux.ParseUsers(s.Listener.Metadata["users"])
	if err != nil {
		res.Err = err
		return res, nil
	}
	port := gostcfg.ListenPort(s.Addr)
	if port == 0 {
		res.Err = fmt.Errorf("service %s: mieru address %q has no port", s.Name, s.Addr)
		return res, nil
	}
	srv := &mierux.Server{
		Port:          port,
		MTU:           s.Listener.MetaInt("mtu"),
		Protocol:      s.Listener.MetaString("protocol"),
		Users:         users,
		Allow:         serviceAllow(cfg, s),
		Bypass:        serviceBypass(cfg, s),
		Dial:          chainDialer(cfg, s),
		Block:         blockProtocols(s),
		SniffFallback: sniffFallback(s),
		Gate:          serviceGate(cfg, s),
	}
	if err := srv.Listen(); err != nil {
		res.Err = err
		return res, nil
	}
	res.Port = port
	logx.Infof("service %s: mieru %s port %d", s.Name, srv.Protocol, port)
	return res, srv
}

// startVLESS is the panel's VLESS entrance: listener type reality, handler
// type vless. The request address is dialled directly, or through the
// service chain when one is set.
func (m *Manager) startVLESS(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	if s.Handler == nil || s.Listener == nil {
		res.Err = fmt.Errorf("service %s: vless/reality is missing handler or listener", s.Name)
		return res, nil
	}
	users, err := vless.ParseUsers(s.Handler.Metadata["users"])
	if err != nil {
		res.Err = err
		return res, nil
	}
	rcfg := realityx.ServerConfig{
		PrivateKey: s.Listener.MetaString("privateKey"),
		Dest:       s.Listener.MetaString("dest"),
		ShortID:    s.Listener.MetaString("shortId"),
	}
	var lastErr error
	for _, port := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		ln, err := realityx.Listen(addr, rcfg)
		if err != nil {
			lastErr = err
			continue
		}
		srv := &vlessEntrance{ln: ln, users: users, dial: chainDialer(cfg, s), block: s.Handler.MetaStrings("block.protocol"), fallback: sniffFallback(s), allow: serviceAllow(cfg, s), bypass: serviceBypass(cfg, s), gate: serviceGate(cfg, s)}
		go srv.loop()
		res.Port = port
		logx.Infof("service %s: vless/reality %s dest %s", s.Name, addr, rcfg.Dest)
		return res, srv
	}
	res.Err = lastErr
	return res, nil
}

type vlessEntrance struct {
	ln       net.Listener
	users    map[[16]byte]struct{}
	dial     func(client net.Addr, target string) (net.Conn, error)
	block    []string
	fallback bool
	allow    func(net.Addr) bool
	bypass   func(string) bool
	gate     *limit.Gate

	mu    sync.Mutex
	live  int
	stats forward.Stats
}

func (v *vlessEntrance) Close() error { return v.ln.Close() }

// TakeStats reports bytes copied for the panel observer. reset zeroes the
// completed counters; live connections stay.
func (v *vlessEntrance) TakeStats(reset bool) (forward.Stats, int) {
	v.mu.Lock()
	defer v.mu.Unlock()
	st := v.stats
	cur := v.live
	if reset {
		v.stats = forward.Stats{}
	}
	return st, cur
}

func (v *vlessEntrance) loop() {
	for {
		c, err := v.ln.Accept()
		if err != nil {
			return
		}
		go v.serve(c)
	}
}

func (v *vlessEntrance) serve(c net.Conn) {
	defer c.Close()
	if v.allow != nil && !v.allow(c.RemoteAddr()) {
		logx.Warnf("vless: admission rejected %s", c.RemoteAddr())
		return
	}
	target, plain, udp, err := vless.Accept(c, v.users)
	if err != nil {
		logx.Warnf("vless: %v", err)
		return
	}
	if udp {
		n, err := vless.RelayUDP(plain, target)
		if err != nil {
			logx.Warnf("vless: udp %s: %v", target, err)
		}
		v.addBytes(n, 0)
		return
	}
	if len(v.block) > 0 {
		peeked, name, err := sniff.Peek(plain)
		if err != nil {
			logx.Warnf("vless: sniff: %v", err)
			return
		}
		if sniff.Reject(v.block, v.fallback, name) {
			logx.Warnf("vless: blocked %s", name)
			return
		}
		plain = peeked
	}
	if v.bypass != nil && v.bypass(target) {
		logx.Warnf("vless: bypass %s", target)
		return
	}
	if v.gate != nil && !v.gate.Enter(c.RemoteAddr()) {
		logx.Warnf("vless: limit rejected %s", c.RemoteAddr())
		return
	}
	if v.gate != nil {
		defer v.gate.Leave(c.RemoteAddr())
	}
	up, err := v.dial(c.RemoteAddr(), target)
	if err != nil {
		logx.Warnf("vless: dial %s: %v", target, err)
		return
	}
	defer up.Close()
	v.mu.Lock()
	v.live++
	v.stats.Conns++
	v.mu.Unlock()
	defer func() {
		v.mu.Lock()
		v.live--
		v.mu.Unlock()
	}()
	go func() {
		n, _ := io.Copy(up, limit.NewReader(plain, v.gate, c.RemoteAddr()))
		v.addBytes(n, 0)
	}()
	n, _ := io.Copy(plain, limit.NewReader(up, v.gate, c.RemoteAddr()))
	v.addBytes(0, n)
}

func (v *vlessEntrance) addBytes(in, out int64) {
	v.mu.Lock()
	v.stats.In += in
	v.stats.Out += out
	v.mu.Unlock()
}

func (m *Manager) startWireGuard(cfg *gostcfg.Config, s gostcfg.Service) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	md := s.Listener
	if md == nil {
		res.Err = errors.New("service: wireguard listener without metadata")
		return res, nil
	}
	iface := "wg-" + sanitizeIface(s.Name)
	wcfg := wireguard.Config{
		Interface:  iface,
		PrivateKey: md.MetaString("privateKey"),
		ListenPort: gostcfg.ListenPort(s.Addr),
		MTU:        md.MetaInt("mtu"),
	}
	for _, a := range strings.Split(md.MetaString("address"), ",") {
		if a = strings.TrimSpace(a); a != "" {
			wcfg.Address = append(wcfg.Address, a)
		}
	}
	peers, ok := md.Metadata["peers"].([]any)
	if !ok && md.Metadata["peers"] != nil {
		res.Err = errors.New("service: wireguard peers metadata is not a list")
		return res, nil
	}
	for _, raw := range peers {
		pm, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		p := wireguard.Peer{PublicKey: str(pm["publicKey"]), PresharedKey: str(pm["presharedKey"])}
		switch v := pm["allowedIPs"].(type) {
		case []any:
			for _, ip := range v {
				if s := str(ip); s != "" {
					p.AllowedIPs = append(p.AllowedIPs, s)
				}
			}
		case string:
			p.AllowedIPs = strings.Split(v, ",")
		}
		if ka := str(pm["persistentKeepalive"]); ka != "" {
			if n, err := strconv.Atoi(ka); err == nil {
				p.PersistentKeepalive = &n
			}
		}
		wcfg.Peers = append(wcfg.Peers, p)
	}

	wm, err := wireguard.New(wcfg)
	if err != nil {
		res.Err = err
		return res, nil
	}
	wm.SetPolicy(serviceBypass(cfg, s), blockProtocols(s), sniffFallback(s))
	wm.SetGate(serviceGate(cfg, s))
	if err := wm.Up(); err != nil {
		if errors.Is(err, wireguard.ErrUnavailable) {
			res.Stub = true
			res.Reason = err.Error()
			logx.Warnf("service %s: %s", s.Name, res.Reason)
			return res, nil
		}
		res.Err = err
		return res, nil
	}
	res.Port = wcfg.ListenPort
	logx.Infof("service %s: wireguard interface %s up", s.Name, iface)
	return res, &wgService{m: wm}
}

// wgService is the WireGuard closer. TakeStats reads `wg show transfer` and
// reports the delta since the previous reset, because the kernel counters
// are cumulative and the panel increments.
type wgService struct {
	m               *wireguard.Manager
	mu              sync.Mutex
	baseIn, baseOut int64
}

func (w *wgService) Close() error { return w.m.Down() }

func (w *wgService) TakeStats(reset bool) (forward.Stats, int) {
	rx, tx, peers, err := w.m.Transfer()
	if err != nil {
		logx.Debugf("wireguard: transfer: %v", err)
		return forward.Stats{}, 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	in, out := rx-w.baseIn, tx-w.baseOut
	if in < 0 {
		in = 0
	}
	if out < 0 {
		out = 0
	}
	if reset {
		w.baseIn, w.baseOut = rx, tx
	}
	return forward.Stats{Conns: int64(peers), In: in, Out: out}, peers
}

// resolveAddr turns a gost listen address into a bind host plus the ordered
// list of ports to try. `WAIT_LISTEN` in the port position means "pick a free
// port from the range that follows".
func (m *Manager) resolveAddr(addr string) (string, []int) {
	host := gostcfg.ListenHost(addr)
	if m.opts.ListenIP != "" {
		host = m.opts.ListenIP
	}
	portSpec := addr[strings.LastIndexByte(addr, ':')+1:]

	if idx := strings.Index(portSpec, "WAIT_LISTEN"); idx >= 0 {
		spec := portSpec[idx+len("WAIT_LISTEN"):]
		if spec == "" {
			spec = m.opts.PortRange
		}
		return host, ParsePortRange(spec)
	}
	if n, err := strconv.Atoi(portSpec); err == nil && n > 0 {
		return host, []int{n}
	}
	// Port 0/absent: fall back to the agent range, else let the kernel choose.
	if ports := ParsePortRange(m.opts.PortRange); len(ports) > 0 {
		return host, ports
	}
	return host, []int{0}
}

// ParsePortRange expands "80,443,30000-30010" into an ordered port list.
func ParsePortRange(spec string) []int {
	var out []int
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if lo, hi, ok := strings.Cut(part, "-"); ok {
			a, err1 := strconv.Atoi(strings.TrimSpace(lo))
			b, err2 := strconv.Atoi(strings.TrimSpace(hi))
			if err1 != nil || err2 != nil || a <= 0 || b < a || b > 65535 {
				continue
			}
			if b-a > 4096 {
				b = a + 4096
			}
			for p := a; p <= b; p++ {
				out = append(out, p)
			}
			continue
		}
		if n, err := strconv.Atoi(part); err == nil && n > 0 && n <= 65535 {
			out = append(out, n)
		}
	}
	return out
}

func isWireGuard(kind, handler string) bool {
	// OpenVPN also uses handler type tungo. Only the wireguard listener is wg.
	if kind == "openvpn" {
		return false
	}
	return kind == "wireguard" || handler == "tungo" || handler == "wireguard"
}

func isStub(kind, handler string) bool {
	switch kind {
	case "reality", "h2", "h3", "http3", "obfs4":
		return true
	}
	switch handler {
	case "vless", "vmess", "vless-xtls", "reality", "tun", "tun2socks":
		return true
	}
	return false
}

// listenerKeepaliveTTL is gost's UDP session lifetime. keepalive defaults
// the TTL to 5s. An explicit ttl or keepalive.ttl overrides it. Zero means
// the listener did not ask, and the session keeps the 60s idle.
func listenerKeepaliveTTL(s gostcfg.Service) time.Duration {
	if s.Listener == nil || !s.Listener.MetaBool("keepalive") {
		return 0
	}
	for _, key := range []string{"ttl", "keepalive.ttl"} {
		raw := s.Listener.MetaString(key)
		if raw == "" {
			continue
		}
		d, err := time.ParseDuration(raw)
		if err == nil && d > 0 {
			return d
		}
	}
	return 5 * time.Second
}

func sniffFallback(s gostcfg.Service) bool {
	return s.Handler != nil && s.Handler.MetaBool("sniffing.fallback")
}

func blockProtocols(s gostcfg.Service) []string {
	if s.Handler == nil {
		return nil
	}
	return s.Handler.MetaStrings("block.protocol")
}

// serviceGate is the panel climiter, traffic limiter, and metadata maxClients.
func serviceGate(cfg *gostcfg.Config, s gostcfg.Service) *limit.Gate {
	var perIP, global int
	var perRate, globalRate int64
	if cfg != nil && s.Climiter != "" {
		for i := range cfg.Climiters {
			c := &cfg.Climiters[i]
			if c.Name == s.Climiter {
				perIP, global = limit.ParseConn(c.Limits)
				break
			}
		}
	}
	if n := s.MetaInt("maxClients"); n > 0 && (global == 0 || n < global) {
		global = n
	}
	if cfg != nil && s.Limiter != "" {
		for i := range cfg.Limiters {
			l := &cfg.Limiters[i]
			if l.Name == s.Limiter {
				perRate, globalRate = limit.ParseRate(l.Limits)
				break
			}
		}
	}
	return limit.New(perIP, global, perRate, globalRate)
}

// serviceBypass is the panel bypass named by the service. The function
// reports that a destination must not be dialled. Nil proxies every address.
func serviceBypass(cfg *gostcfg.Config, s gostcfg.Service) func(string) bool {
	if cfg == nil || s.Bypass == "" {
		return nil
	}
	for i := range cfg.Bypasses {
		b := &cfg.Bypasses[i]
		if b.Name != s.Bypass {
			continue
		}
		list := bypass.Parse(b.Matchers, b.Whitelist)
		if list == nil {
			return nil
		}
		return list.Contains
	}
	return nil
}

// serviceAllow is the panel admission named by the service. Nil means the
// service has no list, so every remote address is accepted.
func serviceAllow(cfg *gostcfg.Config, s gostcfg.Service) func(net.Addr) bool {
	if cfg == nil || s.Admission == "" {
		return nil
	}
	for i := range cfg.Admissions {
		a := &cfg.Admissions[i]
		if a.Name != s.Admission {
			continue
		}
		list := admit.Parse(a.Matchers, a.Whitelist)
		if list == nil {
			return nil
		}
		return list.Allow
	}
	return nil
}

func shadowsocksCreds(s gostcfg.Service) (method, password string) {
	if s.Handler != nil {
		if m := s.Handler.MetaString("method"); m != "" {
			method = m
		}
		if p := s.Handler.MetaString("password"); p != "" {
			password = p
		}
		if s.Handler.Auth != nil {
			// gost's ss handler keeps the cipher in auth.username and the
			// secret in auth.password (see handler/ss in go-gost/x).
			if method == "" {
				method = s.Handler.Auth.Username
			}
			if password == "" {
				password = s.Handler.Auth.Password
			}
		}
	}
	return method, password
}

// startOpenVPN listens for the panel's openvpn listener. The control channel
// finishes key method 2, answers PUSH_REQUEST with a peer-id, and counts
// decrypted P_DATA_V2 payloads. They are not written to a TUN device.
func (m *Manager) startOpenVPN(cfg *gostcfg.Config, s gostcfg.Service, host string, candidates []int) (Result, io.Closer) {
	res := Result{Name: s.Name, Type: s.Kind() + "/" + s.HandlerType()}
	if s.Listener == nil {
		res.Err = fmt.Errorf("service %s: openvpn listener is missing", s.Name)
		return res, nil
	}
	udp := s.Listener.MetaBool("udp")
	if _, _, err := openvpn.CipherKeyLen(s.Listener.MetaString("cipher")); err != nil {
		res.Stub = true
		res.Reason = err.Error()
		logx.Warnf("service %s: %s", s.Name, res.Reason)
		return res, nil
	}
	rawKey, err := openvpn.ParseStaticKey(s.Listener.MetaString("tlsCrypt"))
	if err != nil {
		res.Err = fmt.Errorf("service %s: %w", s.Name, err)
		return res, nil
	}
	crypt, err := openvpn.NewTLSCrypt(rawKey, false)
	if err != nil {
		res.Err = err
		return res, nil
	}
	var tlsCfg *tls.Config
	certPEM, keyPEM := s.Listener.MetaString("cert"), s.Listener.MetaString("key")
	if certPEM != "" && keyPEM != "" {
		cert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
		if err != nil {
			res.Err = fmt.Errorf("service %s: openvpn cert: %w", s.Name, err)
			return res, nil
		}
		tlsCfg = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	} else {
		tlsCfg, err = selfsign.Server("relayx", nil)
		if err != nil {
			res.Err = err
			return res, nil
		}
	}
	var ln net.Listener
	var lastErr error
	var port int
	for _, p := range candidates {
		addr := net.JoinHostPort(host, strconv.Itoa(p))
		if udp {
			ln, lastErr = openvpn.ListenUDP(addr)
		} else {
			ln, lastErr = net.Listen("tcp", addr)
		}
		if lastErr == nil {
			port = p
			break
		}
	}
	if ln == nil {
		res.Err = lastErr
		return res, nil
	}
	ln = admit.Wrap(ln, serviceAllow(cfg, s))
	network := "10.8.0.0/24"
	if s.Listener.MetaString("server") != "" {
		network = s.Listener.MetaString("server")
	}
	ov := &ovpnListener{
		ln: ln, crypt: crypt, tls: tlsCfg, network: network,
		gateway: openvpn.GatewayIP(network), bypass: serviceBypass(cfg, s),
		block: blockProtocols(s), fallback: sniffFallback(s), gate: serviceGate(cfg, s),
		cipher: s.Listener.MetaString("cipher"),
		mtu:    s.Listener.MetaInt("mtu"),
	}
	go ov.loop()
	res.Port = port
	mode := "tcp"
	if udp {
		mode = "udp"
	}
	logx.Infof("service %s: openvpn %s %s (no tun)", s.Name, mode, ln.Addr())
	return res, ov
}

type ovpnListener struct {
	ln       net.Listener
	crypt    *openvpn.TLSCrypt
	tls      *tls.Config
	network  string
	gateway  net.IP
	bypass   func(string) bool
	block    []string
	fallback bool
	gate     *limit.Gate
	cipher   string
	mtu      int

	mu       sync.Mutex
	live     int
	nextPeer uint32
	stats    forward.Stats
}

func (o *ovpnListener) Close() error { return o.ln.Close() }

func (o *ovpnListener) TakeStats(reset bool) (forward.Stats, int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	st := o.stats
	cur := o.live
	if reset {
		o.stats = forward.Stats{}
	}
	return st, cur
}

func (o *ovpnListener) loop() {
	for {
		c, err := o.ln.Accept()
		if err != nil {
			return
		}
		go o.serve(c)
	}
}

func (o *ovpnListener) serve(c net.Conn) {
	defer c.Close()
	if o.gate != nil && !o.gate.Enter(c.RemoteAddr()) {
		logx.Warnf("openvpn: limit rejected %s", c.RemoteAddr())
		return
	}
	if o.gate != nil {
		defer o.gate.Leave(c.RemoteAddr())
	}
	o.mu.Lock()
	peer := o.nextPeer
	o.nextPeer++
	o.mu.Unlock()
	stream, keys, err := openvpn.Serve(c, o.crypt, o.tls, peer, o.network, o.cipher, o.mtu)
	if err != nil {
		logx.Warnf("openvpn: %v", err)
		return
	}
	ch, err := openvpn.NewDataChannel(keys, peer, 0)
	if err != nil {
		logx.Warnf("openvpn: %v", err)
		return
	}
	o.mu.Lock()
	o.live++
	o.stats.Conns++
	o.mu.Unlock()
	defer func() {
		o.mu.Lock()
		o.live--
		o.mu.Unlock()
	}()
	nat := openvpn.NewTCPNat()
	defer nat.Close()
	writeReply := func(reply []byte) bool {
		sealed, err := ch.Seal(reply)
		if err != nil {
			return true
		}
		if o.gate != nil {
			o.gate.Wait(c.RemoteAddr(), len(reply))
		}
		if err := openvpn.WriteTCP(c, sealed); err != nil {
			return false
		}
		o.mu.Lock()
		o.stats.Out += int64(len(reply))
		o.mu.Unlock()
		return true
	}
	incoming := stream.Data()
	for {
		select {
		case pkt, ok := <-incoming:
			if !ok {
				return
			}
			plain, err := ch.Open(pkt)
			if err != nil {
				continue
			}
			o.mu.Lock()
			o.stats.In += int64(len(plain))
			o.mu.Unlock()
			if o.gate != nil {
				o.gate.Wait(c.RemoteAddr(), len(plain))
			}
			if dest, ok := openvpn.IPv4Dest(plain); ok && o.bypass != nil && o.bypass(dest) {
				logx.Debugf("openvpn: bypass %s", dest)
				continue
			}
			if openvpn.L4Blocked(plain, o.block, o.fallback) {
				logx.Debugf("openvpn: blocked payload")
				continue
			}
			reply, err := openvpn.ForwardIPv4UDP(plain)
			if err != nil {
				reply, err = openvpn.ReplyICMP(plain, o.gateway)
			}
			if err != nil {
				reply, err = nat.Handle(plain)
			}
			if err != nil || reply == nil {
				continue
			}
			if !writeReply(reply) {
				return
			}
		case reply := <-nat.Replies():
			if !writeReply(reply) {
				return
			}
		}
	}
}

// closerFunc adapts a plain teardown function to io.Closer.
type closerFunc func() error

func (f closerFunc) Close() error { return f() }

func pick(targets []string, i int) string {
	if len(targets) == 0 {
		return ""
	}
	if i >= len(targets) {
		i = 0
	}
	return targets[i]
}

func sanitizeIface(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			b.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + 32)
		case r == '_' || r == '.':
			b.WriteByte('-')
		}
		if b.Len() >= 12 {
			break
		}
	}
	if b.Len() == 0 {
		return "0"
	}
	return b.String()
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

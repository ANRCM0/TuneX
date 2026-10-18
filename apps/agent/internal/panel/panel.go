// Package panel implements the agent half of the RelayX control plane: one
// Socket.IO connection to the panel carrying register / config / sysinfo /
// listen / listen_error / ping / test / upgrade.
//
// The wire contract is recovered from the upstream binary and mirrored by the
// panel replica; see docs/AGENT.md §Protocol and
// apps/backend/src/socket-io/handlers/{register,listen,sysinfo,disconnect}.ts.
package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/relayx/agent/internal/config"
	"github.com/relayx/agent/internal/fernet"
	"github.com/relayx/agent/internal/gostcfg"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/observe"
	"github.com/relayx/agent/internal/ping"
	"github.com/relayx/agent/internal/service"
	"github.com/relayx/agent/internal/socketio"
	"github.com/relayx/agent/internal/sysinfo"
)

const (
	// sysinfoInterval mirrors the upstream ticker (10 s, @0x1035939).
	sysinfoInterval = 10 * time.Second
	// registerTimeout bounds the register ack.
	registerTimeout = 30 * time.Second
	// licenseWait bounds how long a `config` that races ahead of the register
	// ack waits for the license to be decrypted.
	licenseWait = 3 * time.Second
	// testTimeout / testAttempts mirror the upstream `test` handler.
	testTimeout  = 10 * time.Second
	testAttempts = 5
	// publicIPTimeout bounds the connect_ip lookups.
	publicIPTimeout = 5 * time.Second
)

// publicIPServices are the endpoints upstream's utils.GetPublicIPs queries.
var publicIPServices = []string{
	"https://ipv4.ip.sb",
	"https://ipv6.ip.sb",
}

// Agent is one running node agent.
type Agent struct {
	cfg     *config.Config
	nodeID  string
	version string

	keys    [][]byte // config-key candidates (upstream key1)
	licKeys [][]byte // license-key candidates (upstream key2)

	svc  *service.Manager
	http *http.Client

	mu              sync.Mutex
	license         []byte
	siteURL         string
	licenseType     string
	licensed        bool
	allowUnlicensed bool

	localIPsOnce sync.Once
	localIPs     []string

	obsCancel context.CancelFunc
}

// New builds an agent from a resolved configuration.
func New(cfg *config.Config, version string) (*Agent, error) {
	nodeID, err := cfg.LocalNodeID()
	if err != nil {
		return nil, err
	}
	a := &Agent{
		cfg:     cfg,
		nodeID:  nodeID,
		version: version,
		keys:    dedupeKeys(append([]string{cfg.ConfigSecret}, config.DefaultConfigSecret)),
		licKeys: dedupeKeys(append([]string{cfg.LicenseSecret}, config.DefaultLicenseSecret)),
		svc: service.New(service.Options{
			ListenIP:  cfg.ListenIP,
			PortRange: cfg.PortRange,
		}),
		http: &http.Client{Timeout: publicIPTimeout},
	}
	a.allowUnlicensed = envTruthy(os.Getenv("RELAYX_AGENT_ALLOW_UNLICENSED"))
	return a, nil
}

// NodeID returns the resolved node identity.
func (a *Agent) NodeID() string { return a.nodeID }

// Close stops every listener the agent started and the stats reporter.
func (a *Agent) Close() error {
	a.mu.Lock()
	if a.obsCancel != nil {
		a.obsCancel()
		a.obsCancel = nil
	}
	a.mu.Unlock()
	return a.svc.Close()
}

func dedupeKeys(ss []string) [][]byte {
	seen := map[string]bool{}
	var out [][]byte
	for _, s := range ss {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, fernet.DecodeKeys(s)...)
	}
	return out
}

// Run keeps one panel session alive, reconnecting with the library's backoff.
// Every reconnect re-emits `register`, which is exactly what the upstream
// client does (the panel re-pushes `config` after each register).
func (a *Agent) Run(ctx context.Context) error {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := a.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		attempt++
		delay := socketio.Backoff(attempt)
		if err != nil {
			logx.Warnf("panel: session ended: %v (reconnect in %s)", err, delay.Truncate(time.Millisecond))
		} else {
			logx.Warnf("panel: session closed by server (reconnect in %s)", delay.Truncate(time.Millisecond))
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// session is the per-connection state. Handlers capture it so that a reconnect
// never mixes licenses or in-flight acks between connections.
type session struct {
	a   *Agent
	c   *socketio.Client
	url string

	licOnce  sync.Once
	licReady chan struct{}
}

func (a *Agent) session(parent context.Context) error {
	url := strings.TrimRight(a.cfg.Server, "/") + "/socket.io/"
	dialCtx, cancel := context.WithTimeout(parent, 20*time.Second)
	c, err := socketio.Dial(dialCtx, socketio.Config{
		URL:         url,
		Auth:        map[string]any{"token": a.cfg.Token},
		DialTimeout: 15 * time.Second,
	})
	cancel()
	if err != nil {
		return err
	}
	defer c.Close()

	s := &session{a: a, c: c, url: url, licReady: make(chan struct{})}

	// Handler registration order mirrors the upstream client. `connect` is not
	// dispatched by the replica's socket.io client: Dial() only returns once the
	// namespace CONNECT is acknowledged, so registering right here is the same
	// point in the dialogue.
	c.On("config", s.handleConfig)
	c.On("test", s.handleTest)
	c.On("ping", s.handlePing)
	c.On("upgrade", s.handleUpgrade)
	c.On("disconnect", func([]json.RawMessage) (any, error) {
		logx.Infof("panel: server sent disconnect")
		return nil, nil
	})
	c.On("error", func(args []json.RawMessage) (any, error) {
		logx.Warnf("panel: server error event: %s", joinArgs(args))
		return nil, nil
	})
	c.On("reconnect", func([]json.RawMessage) (any, error) {
		logx.Infof("panel: reconnected")
		return nil, nil
	})

	if err := s.register(parent); err != nil {
		return err
	}

	sysCtx, stopSys := context.WithCancel(parent)
	defer stopSys()
	go s.scheduler(sysCtx)

	<-c.Done()
	return c.Err()
}

func (s *session) closeLicReady() { s.licOnce.Do(func() { close(s.licReady) }) }

// register emits the `register` event and processes its ack.
func (s *session) register(parent context.Context) error {
	a := s.a
	payload := map[string]any{
		"node_id":    a.nodeID,
		"version":    a.version,
		"sysinfo":    basicSysInfo(),
		"ports":      a.cfg.Ports(),
		"connect_ip": a.connectIPs(parent),
	}
	logx.Infof("panel: connecting to %s as node %s (version %s)", s.url, a.nodeID, a.version)

	ctx, cancel := context.WithTimeout(parent, registerTimeout)
	defer cancel()
	body, err := s.c.EmitWithAck(ctx, "register", payload)
	// Upstream logs this right after the emit, before the ack is processed.
	logx.Infof("Connected to server successfully (version=%s)", a.version)
	if err != nil {
		s.closeLicReady()
		return fmt.Errorf("panel: register: %w", err)
	}
	defer s.closeLicReady()

	if len(body) == 0 {
		logx.Warnf("panel: register ack was empty")
		return nil
	}
	var ack map[string]any
	if err := json.Unmarshal(body[0], &ack); err != nil {
		logx.Warnf("panel: register ack is not an object: %s", truncate(string(body[0]), 200))
		return nil
	}
	if msg, ok := ack["error"].(string); ok && msg != "" {
		logx.Errorf("panel: register rejected: %s", msg)
		return fmt.Errorf("panel: register rejected: %s", msg)
	}
	if site, ok := ack["site_url"].(string); ok {
		a.mu.Lock()
		a.siteURL = site
		a.mu.Unlock()
	}
	if typ, ok := ack["type"].(string); ok {
		a.mu.Lock()
		a.licenseType = typ
		a.mu.Unlock()
	}
	token, _ := ack["license"].(string)
	if token == "" {
		logx.Warnf("panel: register ack carried no license")
		return nil
	}
	plain, err := fernet.VerifyAndDecrypt(a.licKeys, token, 0)
	if err != nil {
		logx.Errorf("panel: cannot decrypt license: %v", err)
		return nil
	}
	ackSite, _ := ack["site_url"].(string)
	report, err := inspectLicense(plain, ackSite, ackNow(ack))
	if err != nil {
		logx.Errorf("panel: license decrypted but is not a document: %v", err)
		return nil
	}
	// Upstream writes the decrypted document before the checks and does not
	// abort on a mismatch or an expiry — those only log. onConfig refuses
	// work only when the license never decrypted.
	a.mu.Lock()
	a.license = plain
	a.licensed = true
	if report.Doc.Type != "" {
		a.licenseType = report.Doc.Type
	}
	a.mu.Unlock()
	if !report.SiteOK {
		logx.Warnf("License site_url %s does not match server %s", report.Doc.SiteURL, ackSite)
	}
	if report.Expired {
		logx.Warnf("License is expired at %s, please renew your license", formatLicenseExpiry(report.Doc.ExpiredAt))
	}
	if report.SiteOK && !report.Expired {
		logx.Infof("License loaded successfully")
	}
	logx.Infof("panel: license accepted (%d bytes, site_url=%q)", len(plain), report.Doc.SiteURL)
	return nil
}

// scheduler emits the 10 s `sysinfo` heartbeat.
func (s *session) scheduler(ctx context.Context) {
	t := time.NewTicker(sysinfoInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			payload := map[string]any{
				"node_id": s.a.nodeID,
				"sysinfo": sysinfo.Get10SecSysInfo(),
			}
			if err := s.c.Emit("sysinfo", payload); err != nil {
				logx.Warnf("panel: sysinfo emit failed: %v", err)
				return
			}
			logx.Debugf("panel: sysinfo sent")
		}
	}
}

// handleConfig decrypts and applies a pushed gost config document.
func (s *session) handleConfig(args []json.RawMessage) (any, error) {
	a := s.a
	if len(args) == 0 {
		return nil, errors.New("config: missing payload")
	}
	var token string
	if err := json.Unmarshal(args[0], &token); err != nil {
		// Some panel builds push the document as an object; accept it verbatim.
		var obj json.RawMessage = args[0]
		return nil, s.applyConfig(obj, "unencrypted")
	}
	plain, err := fernet.VerifyAndDecrypt(a.keys, token, 0)
	if err != nil {
		logx.Errorf("panel: cannot decrypt config: %v", err)
		return nil, err
	}
	return nil, s.applyConfig(plain, "fernet")
}

func (s *session) applyConfig(doc []byte, source string) error {
	a := s.a
	if !s.waitLicense() {
		err := errors.New("License not loaded, please check your license")
		logx.Errorf("panel: %v", err)
		return err
	}
	cfg, err := gostcfg.Parse(doc)
	if err != nil {
		logx.Errorf("panel: bad config: %v", err)
		return err
	}
	logx.Infof("panel: config received (%s): %d service(s), %d chain(s)%s",
		source, len(cfg.Services), len(cfg.Chains), extraKeys(cfg))

	results := a.svc.Apply(cfg)
	started := 0
	for _, r := range results {
		switch {
		case r.OK():
			started++
			// `listen` = {name, port, node_id, type}; the type is the gost
			// listener discriminator (tcp/udp/tls/wss/...).
			kind := r.Type
			if i := strings.IndexByte(kind, '/'); i >= 0 {
				kind = kind[:i]
			}
			if err := s.c.Emit("listen", map[string]any{
				"name":    r.Name,
				"port":    r.Port,
				"node_id": a.nodeID,
				"type":    kind,
			}); err != nil {
				logx.Errorf("panel: listen emit failed for %s: %v", r.Name, err)
			}
		case r.Stub:
			logx.Warnf("service %s is not served by the replica: %s", r.Name, r.Reason)
		case r.IsPortInUse():
			logx.Warnf("service %s: port %d already in use", r.Name, r.Port)
			if err := s.c.Emit("listen_error", map[string]any{
				"name":  r.Name,
				"error": "ERR_PORT_IN_USE",
			}); err != nil {
				logx.Errorf("panel: listen_error emit failed for %s: %v", r.Name, err)
			}
		default:
			logx.Errorf("service %s could not start: %v", r.Name, r.Err)
		}
	}
	logx.Infof("panel: config applied: %d/%d service(s) listening", started, len(results))
	a.restartObserver(cfg)
	return nil
}

// restartObserver posts service stats to the panel HTTP observer. The panel
// increments traffic by the bytes in each event, and it sets resetTraffic,
// so the manager zeroes counters after each sample.
func (a *Agent) restartObserver(cfg *gostcfg.Config) {
	a.mu.Lock()
	if a.obsCancel != nil {
		a.obsCancel()
		a.obsCancel = nil
	}
	observers := cfg.HTTPObservers()
	period := statsPeriod(cfg)
	if len(observers) == 0 || period <= 0 {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.obsCancel = cancel
	a.mu.Unlock()
	urls := make([]string, len(observers))
	for i, o := range observers {
		urls[i] = o.URL
	}
	go a.observeLoop(ctx, urls, period)
}

func (a *Agent) observeLoop(ctx context.Context, urls []string, period time.Duration) {
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			events := a.svc.ObserveEvents()
			if len(events) == 0 {
				continue
			}
			for _, url := range urls {
				if err := observe.Post(ctx, url, events); err != nil {
					logx.Warnf("panel: observer post %s: %v", url, err)
				}
			}
		}
	}
}

func statsPeriod(cfg *gostcfg.Config) time.Duration {
	var min time.Duration
	for i := range cfg.Services {
		d := cfg.Services[i].StatsPeriod()
		if d <= 0 {
			continue
		}
		if min == 0 || d < min {
			min = d
		}
	}
	return min
}

// waitLicense blocks until the register ack has been processed (or the grace
// period expires), because the panel emits `config` immediately after acking.
func (s *session) waitLicense() bool {
	a := s.a
	if a.isLicensed() {
		return true
	}
	select {
	case <-s.licReady:
	case <-time.After(licenseWait):
	case <-s.c.Done():
	}
	return a.isLicensed()
}

func (a *Agent) isLicensed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.licensed || a.allowUnlicensed
}

// handlePing answers the tunnel-test `ping` event.
func (s *session) handlePing(args []json.RawMessage) (any, error) {
	if len(args) == 0 {
		return nil, errors.New("ping: missing host")
	}
	var host string
	if err := json.Unmarshal(args[0], &host); err != nil {
		logx.Warnf("ping: bad host argument: %s", truncate(string(args[0]), 120))
		return nil, err
	}
	results := map[string]any{}
	res, err := ping.Ping(context.Background(), host, 5*time.Second)
	if err != nil {
		results[host] = err.Error()
		logx.Warnf("ping %s failed: %v", host, err)
	} else {
		results[host] = res.Milliseconds
		logx.Infof("ping %s = %.2f ms (%s)", host, res.Milliseconds, res.Method)
	}
	return map[string]any{"node_id": s.a.nodeID, "results": results}, nil
}

// handleTest answers the `test` event: dial every requested address over TCP.
func (s *session) handleTest(args []json.RawMessage) (any, error) {
	results := map[string]any{}
	if len(args) == 0 {
		return map[string]any{"node_id": s.a.nodeID, "results": results}, nil
	}
	var req map[string]any
	if err := json.Unmarshal(args[0], &req); err != nil {
		return nil, fmt.Errorf("test: bad payload: %w", err)
	}
	for key, raw := range req {
		addr := testAddr(key, raw)
		if addr == "" {
			results[key] = "invalid target"
			continue
		}
		ms, err := s.a.dialTest(addr)
		if err != nil {
			results[key] = err.Error()
			logx.Warnf("test %s (%s) failed: %v", key, addr, err)
			continue
		}
		results[key] = ms
	}
	return map[string]any{"node_id": s.a.nodeID, "results": results}, nil
}

// dialTest dials addr over TCP, retrying up to testAttempts and fanning out over
// the node's own addresses so the panel sees which source IP can reach it.
func (a *Agent) dialTest(addr string) (float64, error) {
	var lastErr error
	sources := a.sourceIPs()
	for attempt := 0; attempt < testAttempts; attempt++ {
		for _, src := range sources {
			d := net.Dialer{Timeout: testTimeout}
			if src != "" {
				ip := net.ParseIP(src)
				if ip == nil {
					continue
				}
				d.LocalAddr = &net.TCPAddr{IP: ip}
			}
			start := time.Now()
			conn, err := d.Dial("tcp", addr)
			if err != nil {
				lastErr = err
				continue
			}
			ms := float64(time.Since(start).Microseconds()) / 1000.0
			_ = conn.Close()
			return ms, nil
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no usable source address")
	}
	return 0, lastErr
}

// sourceIPs lists the addresses the test dial should fan out from: the
// configured connect-ip entries when present, else every non-loopback address.
func (a *Agent) sourceIPs() []string {
	if len(a.cfg.ConnectIP) > 0 {
		return append([]string{""}, a.cfg.ConnectIP...)
	}
	a.localIPsOnce.Do(func() {
		addrs, err := net.InterfaceAddrs()
		if err != nil {
			return
		}
		for _, ad := range addrs {
			ipnet, ok := ad.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() {
				continue
			}
			a.localIPs = append(a.localIPs, ipnet.IP.String())
		}
	})
	return append([]string{""}, a.localIPs...)
}

// connectIPs resolves the `connect_ip` list: the -i values, else public IP
// discovery, else this host's outbound address.
func (a *Agent) connectIPs(ctx context.Context) []string {
	if len(a.cfg.ConnectIP) > 0 {
		return a.cfg.ConnectIP
	}
	var out []string
	seen := map[string]bool{}
	for _, svc := range publicIPServices {
		ip, err := a.fetchIP(ctx, svc)
		if err != nil || ip == "" || seen[ip] {
			continue
		}
		seen[ip] = true
		out = append(out, ip)
	}
	if len(out) == 0 {
		// Offline deployments: fall back to the outbound interface address so
		// the node is still addressable (documented replica extension).
		if ip := outboundIP(); ip != "" {
			out = append(out, ip)
		}
	}
	return out
}

func (a *Agent) fetchIP(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	// Upstream's publicIPResolver sends this literal user agent.
	req.Header.Set("User-Agent", "curl/8.4.0")
	resp, err := a.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	buf := make([]byte, 64)
	n, _ := resp.Body.Read(buf)
	ip := strings.TrimSpace(string(buf[:n]))
	if net.ParseIP(ip) == nil {
		return "", fmt.Errorf("not an IP: %q", ip)
	}
	return ip, nil
}

func outboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if ua, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return ua.IP.String()
	}
	return ""
}

// basicSysInfo is the five-key subset carried by `register`.
func basicSysInfo() map[string]any {
	full := sysinfo.GetBasicSysInfo()
	out := map[string]any{}
	for _, k := range []string{"cpu_num", "boot_time", "hostname", "os", "arch"} {
		if v, ok := full[k]; ok {
			out[k] = v
		}
	}
	return out
}

// testAddr normalises a `test` request entry into host:port.
func testAddr(key string, raw any) string {
	switch v := raw.(type) {
	case float64:
		return net.JoinHostPort(key, fmt.Sprintf("%d", int(v)))
	case string:
		if strings.Contains(v, ":") {
			return v
		}
		if _, err := fmt.Sscanf(v, "%d", new(int)); err == nil && v != "" {
			return net.JoinHostPort(key, v)
		}
		return net.JoinHostPort(v, "80")
	case json.Number:
		return net.JoinHostPort(key, v.String())
	default:
		return ""
	}
}

func extraKeys(cfg *gostcfg.Config) string {
	if len(cfg.Extra) == 0 {
		return ""
	}
	keys := make([]string, 0, len(cfg.Extra))
	for k := range cfg.Extra {
		keys = append(keys, k)
	}
	return " (ignored keys: " + strings.Join(keys, ",") + ")"
}

func joinArgs(args []json.RawMessage) string {
	parts := make([]string, 0, len(args))
	for _, a := range args {
		parts = append(parts, string(a))
	}
	return truncate(strings.Join(parts, " "), 200)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func envTruthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

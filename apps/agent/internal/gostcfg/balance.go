package gostcfg

import (
	"encoding/json"
	"hash/fnv"
	"math/rand/v2"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Balancer picks a forwarder address per connection. The panel's
// load_balance_type is written as selector.strategy: round, rand, fifo, hash,
// lc (least connections), ll (least observed dial time).
// A node marked backup is used only when every node is a backup. Weight
// (metadata.weight, default 1, capped at 64) repeats an address in the ring
// used by round, rand and hash. fifo always returns the first candidate.
type Balancer struct {
	strategy string
	order    []string
	ring     []string
	n        atomic.Uint64
	mu       sync.Mutex
	live     map[string]int
	lat      map[string]time.Duration
}

// NewBalancer builds a picker from the service forwarder. Nil means there is
// nothing to choose between.
func (c *Config) NewBalancer(s *Service) *Balancer {
	if s == nil || s.Forwarder == nil {
		return nil
	}
	return newBalancer(s.Forwarder.Selector, plainForwardNodes(s.Forwarder.Nodes))
}

func newBalancer(selector json.RawMessage, nodes []Node) *Balancer {
	nodes = candidates(nodes)
	if len(nodes) == 0 {
		return nil
	}
	b := &Balancer{
		strategy: strategyOf(selector),
		live:     map[string]int{},
	}
	for _, n := range nodes {
		b.order = append(b.order, n.Addr)
		w := nodeWeight(n)
		for i := 0; i < w; i++ {
			b.ring = append(b.ring, n.Addr)
		}
	}
	if len(b.order) < 2 && b.strategy != "lc" {
		return nil
	}
	return b
}

// ChainRoute picks one node from each chain hop, and a forwarder address,
// for a single client connection.
type ChainRoute struct {
	hops     []hopChoice
	targets  *Balancer
	fallback string
}

type hopChoice struct {
	bal    *Balancer
	one    RouteHop
	byAddr map[string]RouteHop
	nodes  []hopNode
	n      *atomic.Uint64
}

type hopNode struct {
	hop  RouteHop
	host string
}

// NewChainRoute returns nil when every hop and the forwarder have only one
// candidate, so callers can keep the fixed route.
func (c *Config) NewChainRoute(s *Service) *ChainRoute {
	if s == nil {
		return nil
	}
	r := &ChainRoute{}
	choice := false
	if name := s.ChainName(); name != "" {
		if ch := c.ChainByName(name); ch != nil {
			for _, hop := range ch.Hops {
				nodes := candidates(hop.Nodes)
				if len(nodes) == 0 {
					continue
				}
				hc := hopChoice{one: c.routeHop(nodes[0]), byAddr: map[string]RouteHop{}, n: new(atomic.Uint64)}
				for _, n := range nodes {
					rh := c.routeHop(n)
					hc.byAddr[n.Addr] = rh
					hc.nodes = append(hc.nodes, hopNode{hop: rh, host: nodeFilterHost(n)})
				}
				hc.bal = newBalancer(hop.Selector, hop.Nodes)
				if hc.bal != nil {
					choice = true
				}
				r.hops = append(r.hops, hc)
			}
		}
	}
	if s.Forwarder != nil {
		r.targets = newBalancer(s.Forwarder.Selector, plainForwardNodes(s.Forwarder.Nodes))
		if r.targets != nil {
			choice = true
		}
		for _, n := range plainForwardNodes(s.Forwarder.Nodes) {
			r.fallback = n.Addr
			break
		}
	}
	if !choice {
		return nil
	}
	return r
}

// Next returns the hops and forwarder target for this client. done releases
// least-connection counts and is nil otherwise.
func (r *ChainRoute) Next(client net.Addr, dest string) (hops []RouteHop, target string, done func()) {
	if r == nil {
		return nil, "", nil
	}
	var ends []func()
	for i := range r.hops {
		h := &r.hops[i]
		rh, end := h.pick(client, dest)
		if end != nil {
			ends = append(ends, end)
		}
		hops = append(hops, rh)
	}
	target = r.fallback
	if r.targets != nil {
		addr, end := r.targets.Next(client)
		if end != nil {
			ends = append(ends, end)
		}
		if addr != "" {
			target = addr
		}
	}
	if len(ends) == 0 {
		return hops, target, nil
	}
	return hops, target, func() {
		for _, end := range ends {
			end()
		}
	}
}

func (h *hopChoice) pick(client net.Addr, dest string) (RouteHop, func()) {
	elig := h.eligible(dest)
	if len(elig) == 0 {
		return h.one, nil
	}
	if len(elig) == 1 || h.bal == nil {
		return elig[0].hop, nil
	}
	allowed := make([]string, len(elig))
	for i, n := range elig {
		allowed[i] = n.hop.Addr
	}
	addr, end := h.bal.NextAmong(client, dest, allowed)
	if rh, ok := h.byAddr[addr]; ok {
		return rh, end
	}
	return elig[0].hop, nil
}

// eligible prefers nodes whose filter.host matches dest. Nodes with no filter
// are the fallback. If every node is filtered and none match, all of them
// remain usable so the hop is not dropped.
func (h *hopChoice) eligible(dest string) []hopNode {
	var matched, open []hopNode
	for _, n := range h.nodes {
		if n.host == "" {
			open = append(open, n)
			continue
		}
		if hostMatch(n.host, dest) {
			matched = append(matched, n)
		}
	}
	if len(matched) > 0 {
		return matched
	}
	if len(open) > 0 {
		return open
	}
	return h.nodes
}

// plainForwardNodes drops forwarder nodes that only apply to a request host.
// A TCP port-forward has no request host, so those nodes would never match.
// If every node has a filter, they are all kept.
func plainForwardNodes(nodes []Node) []Node {
	var open, all []Node
	for _, n := range nodes {
		if n.Addr == "" {
			continue
		}
		all = append(all, n)
		if nodeFilterHost(n) == "" {
			open = append(open, n)
		}
	}
	if len(open) > 0 {
		return open
	}
	return all
}

func nodeFilterHost(n Node) string {
	if len(n.Filter) == 0 {
		return ""
	}
	var f struct {
		Host string `json:"host"`
	}
	if err := json.Unmarshal(n.Filter, &f); err != nil {
		return ""
	}
	return strings.TrimSpace(f.Host)
}

func hostMatch(filter, host string) bool {
	if filter == "" {
		return true
	}
	if host == "" {
		return false
	}
	filter = strings.ToLower(filter)
	host = strings.ToLower(host)
	if filter == "*" || filter == host {
		return true
	}
	if strings.HasPrefix(filter, "*.") {
		suf := filter[1:]
		return strings.HasSuffix(host, suf) && len(host) > len(suf)
	}
	return false
}

func (c *Config) routeHop(n Node) RouteHop {
	h := RouteHop{Addr: n.Addr}
	if n.Connector != nil {
		h.Connector = n.Connector.Type
		if n.Connector.Auth != nil {
			h.Username = n.Connector.Auth.Username
			h.Password = n.Connector.Auth.Password
		}
	}
	if n.Dialer != nil {
		h.Dialer = n.Dialer.Type
		h.Key = n.Dialer.MetaString("key")
		h.Host = n.Dialer.MetaString("host")
		h.Path = n.Dialer.MetaString("path")
		if (h.Dialer == "quic" || h.Dialer == "tls" || h.Dialer == "mtls" || h.Dialer == "wss" || h.Dialer == "mwss") && h.Host == "" && c != nil {
			h.Host = c.TLSName()
		}
	}
	return h
}

// Next returns the address for this client and a function the caller must run
// when the connection ends. The function is nil except for least-connections.
func (b *Balancer) Next(client net.Addr) (string, func()) {
	if b == nil || len(b.order) == 0 {
		return "", nil
	}
	return b.NextAmong(client, "", b.order)
}

// NextAmong applies the strategy to allowed. A filter.host match uses this so
// the strategy still holds inside the matching set. fifo is the first allowed
// address. round, rand and hash still honour weight. hash uses the request
// host when dest is set, and the client IP otherwise.
func (b *Balancer) NextAmong(client net.Addr, dest string, allowed []string) (string, func()) {
	if b == nil || len(allowed) == 0 {
		return "", nil
	}
	if len(allowed) == 1 {
		return allowed[0], nil
	}
	switch b.strategy {
	case "ll":
		return b.leastLatency(allowed), nil
	case "round", "rand", "hash":
		ring := filterAddrs(b.ring, allowed)
		if len(ring) == 0 {
			return allowed[0], nil
		}
		switch b.strategy {
		case "rand":
			return ring[rand.IntN(len(ring))], nil
		case "hash":
			h := fnv.New32a()
			_, _ = h.Write([]byte(hashKey(client, dest)))
			return ring[h.Sum32()%uint32(len(ring))], nil
		default:
			i := b.n.Add(1) - 1
			return ring[i%uint64(len(ring))], nil
		}
	case "lc":
		return b.least(allowed)
	default:
		return allowed[0], nil
	}
}

func filterAddrs(ring, allowed []string) []string {
	ok := map[string]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	var out []string
	for _, a := range ring {
		if ok[a] {
			out = append(out, a)
		}
	}
	return out
}

// Observe records a dial. The first sample is kept as-is; later samples are
// averaged with it. An unmeasured address is still preferred by leastLatency.
func (b *Balancer) Observe(addr string, d time.Duration) {
	if b == nil || addr == "" || d <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.lat == nil {
		b.lat = map[string]time.Duration{}
	}
	if old := b.lat[addr]; old > 0 {
		b.lat[addr] = (old + d) / 2
	} else {
		b.lat[addr] = d
	}
}

func (b *Balancer) has(addr string) bool {
	for _, a := range b.order {
		if a == addr {
			return true
		}
	}
	return false
}

// leastLatency returns the first address that has never been dialled, then
// the one with the smallest sample. Weight is not applied.
func (b *Balancer) leastLatency(allowed []string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	best := ""
	var bestD time.Duration
	for _, addr := range allowed {
		d := b.lat[addr]
		if d == 0 {
			return addr
		}
		if best == "" || d < bestD {
			best = addr
			bestD = d
		}
	}
	if best == "" {
		return allowed[0]
	}
	return best
}

// Observe updates the hop or forwarder that owns addr. A failed dial should
// pass a large duration so the next connection tries something else.
func (r *ChainRoute) Observe(addr string, d time.Duration) {
	if r == nil || addr == "" {
		return
	}
	for i := range r.hops {
		if r.hops[i].bal != nil && r.hops[i].bal.has(addr) {
			r.hops[i].bal.Observe(addr, d)
			return
		}
	}
	if r.targets != nil && r.targets.has(addr) {
		r.targets.Observe(addr, d)
	}
}

func (b *Balancer) least(allowed []string) (string, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	best := allowed[0]
	bestN := b.live[best]
	for _, addr := range allowed[1:] {
		if n := b.live[addr]; n < bestN {
			best = addr
			bestN = n
		}
	}
	b.live[best]++
	return best, func() {
		b.mu.Lock()
		if b.live[best] > 0 {
			b.live[best]--
		}
		b.mu.Unlock()
	}
}

func candidates(nodes []Node) []Node {
	var primary, backup []Node
	for _, n := range nodes {
		if n.Addr == "" {
			continue
		}
		if metaTrue(n.Metadata, "backup") {
			backup = append(backup, n)
			continue
		}
		primary = append(primary, n)
	}
	if len(primary) > 0 {
		return primary
	}
	return backup
}

func strategyOf(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "fifo"
	}
	var sel struct {
		Strategy string `json:"strategy"`
	}
	if err := json.Unmarshal(raw, &sel); err != nil || sel.Strategy == "" {
		return "fifo"
	}
	return sel.Strategy
}

func nodeWeight(n Node) int {
	w := 1
	if n.Metadata != nil {
		switch v := n.Metadata["weight"].(type) {
		case string:
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				w = n
			}
		case float64:
			if v > 0 {
				w = int(v)
			}
		}
	}
	if w > 64 {
		w = 64
	}
	return w
}

func hashKey(client net.Addr, dest string) string {
	if host := hostOf(dest); host != "" {
		return host
	}
	return clientIP(client)
}

func hostOf(dest string) string {
	dest = strings.TrimSpace(dest)
	if dest == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(dest); err == nil && host != "" {
		return host
	}
	return dest
}

func clientIP(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	switch a := addr.(type) {
	case *net.TCPAddr:
		return a.IP.String()
	case *net.UDPAddr:
		return a.IP.String()
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

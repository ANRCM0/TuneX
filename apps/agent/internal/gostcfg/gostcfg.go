// Package gostcfg models the configuration document the panel pushes in the
// `config` Socket.IO event.
//
// The panel builds it with `tunnelService.getNodeConfig(...)` and serialises it
// as JSON before Fernet-encrypting it
// (`work/modules/119__src__socket-io__handlers__register.ts:172-173`). The
// document is a go-gost/x `config.Config`: `{log, tls, services, chains,
// limiters, climiters, bypasses, admissions, observers, ...}`. The replica only
// needs the parts that describe listeners, so the model below is an explicit
// subset; unknown top-level keys are preserved in Extra.
//
// Every `metadata` map is `map[string]any` because the panel writes booleans
// and numbers in there (`nodelay: true`, `enableStats: true`,
// `"observer.period": "30s"`, `weight: "1"`), not just strings.
package gostcfg

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Auth is gost's `config.Auth`.
type Auth struct {
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// Parent mirrors gost's `config.Parent`: the fields shared by every object.
type Parent struct {
	Name      string         `json:"name,omitempty"`
	Type      string         `json:"type,omitempty"`
	Addr      string         `json:"addr,omitempty"`
	Chain     string         `json:"chain,omitempty"`
	Auth      *Auth          `json:"auth,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
	Matchers  []string       `json:"matchers,omitempty"`
	Whitelist bool           `json:"whitelist,omitempty"`
	Limits    []string       `json:"limits,omitempty"`
}

// MetaString reads a metadata value as a string.
func (p *Parent) MetaString(key string) string {
	if p == nil || p.Metadata == nil {
		return ""
	}
	v, ok := p.Metadata[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}

// MetaStrings reads a metadata value as a list of strings. A JSON array
// arrives as []any. A single string is one element.
func (p *Parent) MetaStrings(key string) []string {
	if p == nil || p.Metadata == nil {
		return nil
	}
	switch t := p.Metadata[key].(type) {
	case []string:
		return t
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	case []any:
		var out []string
		for _, item := range t {
			s, ok := item.(string)
			if ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// MetaBool reads a metadata value as a boolean.
func (p *Parent) MetaBool(key string) bool {
	s := strings.ToLower(p.MetaString(key))
	return s == "true" || s == "1" || s == "yes"
}

// MetaInt reads a metadata value as an int.
func (p *Parent) MetaInt(key string) int {
	n, err := strconv.Atoi(p.MetaString(key))
	if err != nil {
		return 0
	}
	return n
}

// Node is one chain hop node (an outbound relay endpoint).
type Node struct {
	Name      string          `json:"name,omitempty"`
	Addr      string          `json:"addr,omitempty"`
	Handler   *Parent         `json:"handler,omitempty"`
	Dialer    *Parent         `json:"dialer,omitempty"`
	Connector *Parent         `json:"connector,omitempty"`
	Filter    json.RawMessage `json:"filter,omitempty"`
	Metadata  map[string]any  `json:"metadata,omitempty"`
}

// Hop is a chain hop.
type Hop struct {
	Name     string          `json:"name,omitempty"`
	Selector json.RawMessage `json:"selector,omitempty"`
	Nodes    []Node          `json:"nodes,omitempty"`
	Metadata map[string]any  `json:"metadata,omitempty"`
}

// Chain is a gost chain (the routing decision tree for a tunnel).
type Chain struct {
	Parent
	Hops []Hop `json:"hops,omitempty"`
}

// Forwarder is a service's direct forwarder: `{nodes: [...], selector: {...}}`.
type Forwarder struct {
	Nodes    []Node          `json:"nodes,omitempty"`
	Selector json.RawMessage `json:"selector,omitempty"`
}

// Service is a listener plus the handler that serves it.
type Service struct {
	Parent
	Handler   *Parent    `json:"handler,omitempty"`
	Listener  *Parent    `json:"listener,omitempty"`
	Forwarder *Forwarder `json:"forwarder,omitempty"`
	Bypass    string     `json:"bypass,omitempty"`
	Admission string     `json:"admission,omitempty"`
	Observer  string     `json:"observer,omitempty"`
	Limiter   string     `json:"limiter,omitempty"`
	Climiter  string     `json:"climiter,omitempty"`
}

// TLS is the panel's auto-certificate block. Both the in-node and the out-node
// documents carry the same commonName (the site hostname).
type TLS struct {
	Validity     string `json:"validity,omitempty"`
	CommonName   string `json:"commonName,omitempty"`
	Organization string `json:"organization,omitempty"`
}

// TLSName is the certificate common name, or empty when the document has none.
func (c *Config) TLSName() string {
	if c == nil || c.TLS == nil {
		return ""
	}
	return c.TLS.CommonName
}

// Config is the pushed document.
type Config struct {
	Log        json.RawMessage            `json:"log,omitempty"`
	TLS        *TLS                       `json:"tls,omitempty"`
	Services   []Service                  `json:"services,omitempty"`
	Chains     []Chain                    `json:"chains,omitempty"`
	Limiters   []Parent                   `json:"limiters,omitempty"`
	Climiters  []Parent                   `json:"climiters,omitempty"`
	Bypasses   []Parent                   `json:"bypasses,omitempty"`
	Admissions []Parent                   `json:"admissions,omitempty"`
	Observers  json.RawMessage            `json:"observers,omitempty"`
	Extra      map[string]json.RawMessage `json:"-"`
}

// Parse decodes a panel config document. Unknown top-level keys are kept in
// Extra so the replica can log exactly what it did not understand.
func Parse(b []byte) (*Config, error) {
	if len(b) == 0 {
		return nil, errors.New("gostcfg: empty config")
	}
	c := &Config{}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("gostcfg: parse: %w", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err == nil {
		for _, k := range []string{"log", "tls", "services", "chains", "limiters", "climiters", "bypasses", "admissions", "observers"} {
			delete(all, k)
		}
		if len(all) > 0 {
			c.Extra = all
		}
	}
	return c, nil
}

// HandlerType returns the handler discriminator ("tcp", "udp", "ss", "ssu",
// "relay", "tungo", "vless", "mieru", "openvpn", ...).
func (s *Service) HandlerType() string {
	if s.Handler != nil {
		return s.Handler.Type
	}
	return ""
}

// ListenerType returns the listener discriminator ("tcp", "udp", "wireguard",
// "reality", "mieru", "relayx", ...).
func (s *Service) ListenerType() string {
	if s.Listener != nil {
		return s.Listener.Type
	}
	return ""
}

// Kind is the dispatcher shorthand: the listener type, defaulting to "tcp".
func (s *Service) Kind() string {
	if lt := s.ListenerType(); lt != "" {
		return lt
	}
	return "tcp"
}

// ListenPort parses the port out of Addr ("host:port"), 0 when absent.
func ListenPort(addr string) int {
	i := strings.LastIndexByte(addr, ':')
	if i < 0 {
		return 0
	}
	n, err := strconv.Atoi(addr[i+1:])
	if err != nil {
		return 0
	}
	return n
}

// ListenHost returns the host part of Addr.
func ListenHost(addr string) string {
	i := strings.LastIndexByte(addr, ':')
	if i < 0 {
		return addr
	}
	return addr[:i]
}

// WithPort rewrites the port of addr, preserving the host.
func WithPort(addr string, port int) string {
	i := strings.LastIndexByte(addr, ':')
	if i < 0 {
		return fmt.Sprintf("%s:%d", addr, port)
	}
	return fmt.Sprintf("%s:%d", addr[:i], port)
}

// ChainByName looks up a chain by name.
func (c *Config) ChainByName(name string) *Chain {
	for i := range c.Chains {
		if c.Chains[i].Name == name {
			return &c.Chains[i]
		}
	}
	return nil
}

// ChainName is the chain the panel attached. Port-forwards put it on the
// handler (`handler.chain`); remote port-forwards put it on the listener
// (`listener.chain`). Some documents put it on the service itself.
func (s *Service) ChainName() string {
	if s == nil {
		return ""
	}
	if s.Chain != "" {
		return s.Chain
	}
	if s.Handler != nil && s.Handler.Chain != "" {
		return s.Handler.Chain
	}
	if s.Listener != nil {
		return s.Listener.Chain
	}
	return ""
}

// Targets resolves the outbound dial addresses for a service, hoisted out of
// the service's chain (first hop that carries nodes, matching the panel's
// ordering) or, failing that, straight out of the forwarder.
func (c *Config) Targets(s *Service) []string {
	if name := s.ChainName(); name != "" {
		if ch := c.ChainByName(name); ch != nil {
			for _, hop := range ch.Hops {
				out := make([]string, 0, len(hop.Nodes))
				for _, n := range hop.Nodes {
					if n.Addr != "" {
						out = append(out, n.Addr)
					}
				}
				if len(out) > 0 {
					return out
				}
			}
		}
	}
	if s.Forwarder != nil {
		out := make([]string, 0, len(s.Forwarder.Nodes))
		for _, n := range plainForwardNodes(s.Forwarder.Nodes) {
			out = append(out, n.Addr)
		}
		return out
	}
	return nil
}

// FirstHopConnectorType reports the connector type of the first chain node
// ("relay", "ssu", "socks5", ...) which tells the replica what the upstream of
// a tunnel speaks.
func (c *Config) FirstHopConnectorType(s *Service) string {
	name := s.ChainName()
	if name == "" {
		return ""
	}
	ch := c.ChainByName(name)
	if ch == nil {
		return ""
	}
	for _, hop := range ch.Hops {
		for _, n := range hop.Nodes {
			if n.Connector != nil && n.Connector.Type != "" {
				return n.Connector.Type
			}
		}
	}
	return ""
}

// RouteHop is one chain node on the way to a forwarder target.
type RouteHop struct {
	Addr      string
	Connector string
	Username  string
	Password  string
	// Dialer is set when the hop is not a plain TCP connector. The relayx
	// listener carries its HKDF key, and optionally host and path, here.
	Dialer string
	Key    string
	Host   string
	Path   string
}

// Route returns the chain hops (skipping nodes marked backup when a primary
// exists) and the first forwarder address. The forwarder is the real target;
// the hops are only the relays in front of it.
func (c *Config) Route(s *Service) (hops []RouteHop, target string) {
	if s == nil {
		return nil, ""
	}
	if name := s.ChainName(); name != "" {
		if ch := c.ChainByName(name); ch != nil {
			for _, hop := range ch.Hops {
				n := pickNode(hop)
				if n == nil || n.Addr == "" {
					continue
				}
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
					if (h.Dialer == "quic" || h.Dialer == "tls" || h.Dialer == "mtls" || h.Dialer == "wss" || h.Dialer == "mwss") && h.Host == "" {
						h.Host = c.TLSName()
					}
				}
				hops = append(hops, h)
			}
		}
	}
	if s.Forwarder != nil {
		for _, n := range s.Forwarder.Nodes {
			if n.Addr != "" {
				target = n.Addr
				break
			}
		}
	}
	return hops, target
}

func pickNode(hop Hop) *Node {
	var backup *Node
	for i := range hop.Nodes {
		n := &hop.Nodes[i]
		if n.Addr == "" {
			continue
		}
		if !metaTrue(n.Metadata, "backup") {
			return n
		}
		if backup == nil {
			backup = n
		}
	}
	return backup
}

func metaTrue(md map[string]any, key string) bool {
	if md == nil {
		return false
	}
	v, ok := md[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b
}

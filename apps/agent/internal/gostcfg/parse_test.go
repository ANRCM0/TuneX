package gostcfg

import (
	"encoding/json"
	"testing"
)

const sampleDoc = `{
  "log": {"level": "fatal"},
  "tls": {"validity": "8760h", "commonName": "panel.test", "organization": "panel.test"},
  "services": [
    {
      "name": "tcp-1",
      "addr": "0.0.0.0:1234",
      "handler": {"type": "tcp", "chain": "chain-1", "metadata": {"sniffing": true, "block.protocol": ["http", "tls"], "maxClients": 10}},
      "listener": {"type": "tcp"},
      "forwarder": {"nodes": [{"name": "n1", "addr": "10.0.0.1:80", "metadata": {"weight": "2"}}]}
    },
    {"name": "udp-1", "addr": "[::1]:5353", "handler": {"type": "ssu"}, "listener": {"type": "udp"}}
  ],
  "chains": [
    {"name": "chain-1", "hops": [
      {"name": "h1", "nodes": [{"name": "c1", "addr": "1.2.3.4:9000", "connector": {"type": "relay"}}]},
      {"name": "h2", "nodes": [{"name": "c2", "addr": "5.6.7.8:9001", "connector": {"type": "socks5"}}]}
    ]}
  ],
  "unknown_top": {"a": 1}
}`

func parseSample(t *testing.T) *Config {
	t.Helper()
	cfg, err := Parse([]byte(sampleDoc))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return cfg
}

func TestParseDocument(t *testing.T) {
	cfg := parseSample(t)
	if len(cfg.Services) != 2 || len(cfg.Chains) != 1 {
		t.Fatalf("services=%d chains=%d", len(cfg.Services), len(cfg.Chains))
	}
	if cfg.TLS == nil || cfg.TLSName() != "panel.test" {
		t.Fatalf("tls name = %q", cfg.TLSName())
	}
	if _, ok := cfg.Extra["unknown_top"]; !ok {
		t.Fatalf("unknown key not kept: %v", cfg.Extra)
	}
	if len(cfg.Extra) != 1 {
		t.Fatalf("extra = %v", cfg.Extra)
	}

	if _, err := Parse(nil); err == nil {
		t.Fatal("empty document accepted")
	}
	if _, err := Parse([]byte("{")); err == nil {
		t.Fatal("malformed document accepted")
	}
}

func TestTLSNameDefault(t *testing.T) {
	cfg, err := Parse([]byte(`{"services":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	// No tls block means an empty name (callers fall back to "relayx").
	if cfg.TLSName() != "" {
		t.Fatalf("default tls name = %q", cfg.TLSName())
	}
	var nilCfg *Config
	if nilCfg.TLSName() != "" {
		t.Fatal("nil config tls name")
	}
}

func TestServiceAccessors(t *testing.T) {
	cfg := parseSample(t)
	tcp := cfg.Services[0]
	if tcp.Kind() != "tcp" || tcp.HandlerType() != "tcp" || tcp.ListenerType() != "tcp" {
		t.Fatalf("accessors = %q %q %q", tcp.Kind(), tcp.HandlerType(), tcp.ListenerType())
	}
	if tcp.ChainName() != "chain-1" {
		t.Fatalf("chain name = %q", tcp.ChainName())
	}

	// A service with no listener defaults to tcp and no handler.
	bare := Service{}
	if bare.Kind() != "tcp" || bare.HandlerType() != "" || bare.ListenerType() != "" {
		t.Fatalf("bare accessors = %q %q %q", bare.Kind(), bare.HandlerType(), bare.ListenerType())
	}

	// Chain name precedence: service, then handler, then listener.
	s := Service{Parent: Parent{Chain: "svc"}}
	s.Handler = &Parent{Chain: "handler"}
	s.Listener = &Parent{Chain: "listener"}
	if s.ChainName() != "svc" {
		t.Fatalf("service chain = %q", s.ChainName())
	}
	s.Chain = ""
	if s.ChainName() != "handler" {
		t.Fatalf("handler chain = %q", s.ChainName())
	}
	s.Handler.Chain = ""
	if s.ChainName() != "listener" {
		t.Fatalf("listener chain = %q", s.ChainName())
	}
}

func TestListenAddressHelpers(t *testing.T) {
	cases := []struct {
		addr string
		port int
		host string
	}{
		{"0.0.0.0:1234", 1234, "0.0.0.0"},
		{"[::1]:5353", 5353, "[::1]"},
		{"example.test:443", 443, "example.test"},
		{":WAIT_LISTEN:1000-2000", 0, ":WAIT_LISTEN"},
		{"nohost", 0, "nohost"},
	}
	for _, c := range cases {
		if got := ListenPort(c.addr); got != c.port {
			t.Fatalf("ListenPort(%q) = %d, want %d", c.addr, got, c.port)
		}
		if got := ListenHost(c.addr); got != c.host {
			t.Fatalf("ListenHost(%q) = %q, want %q", c.addr, got, c.host)
		}
	}

	if got := WithPort("1.2.3.4:80", 8080); got != "1.2.3.4:8080" {
		t.Fatalf("WithPort ipv4 = %q", got)
	}
	if got := WithPort("[::1]:80", 8080); got != "[::1]:8080" {
		t.Fatalf("WithPort ipv6 = %q", got)
	}
	if got := WithPort("hostonly", 9000); got != "hostonly:9000" {
		t.Fatalf("WithPort no port = %q", got)
	}
}

func TestMetaHelpers(t *testing.T) {
	p := &Parent{Metadata: map[string]any{
		"string":  "value",
		"number":  float64(42),
		"bool":    true,
		"boolstr": "true",
		"list":    []any{"a", "b"},
		"liststr": "only",
	}}
	if p.MetaString("string") != "value" || p.MetaString("number") != "42" {
		t.Fatalf("MetaString = %q %q", p.MetaString("string"), p.MetaString("number"))
	}
	if !p.MetaBool("bool") || !p.MetaBool("boolstr") || p.MetaBool("missing") {
		t.Fatal("MetaBool")
	}
	if p.MetaInt("number") != 42 || p.MetaInt("string") != 0 {
		t.Fatalf("MetaInt = %d %d", p.MetaInt("number"), p.MetaInt("string"))
	}
	if got := p.MetaStrings("list"); len(got) != 2 || got[0] != "a" {
		t.Fatalf("MetaStrings list = %v", got)
	}
	if got := p.MetaStrings("liststr"); len(got) != 1 || got[0] != "only" {
		t.Fatalf("MetaStrings string = %v", got)
	}

	var nilParent *Parent
	if nilParent.MetaString("x") != "" || nilParent.MetaBool("x") || nilParent.MetaInt("x") != 0 {
		t.Fatal("nil parent helpers")
	}
}

func TestTargetsAndConnector(t *testing.T) {
	cfg := parseSample(t)
	tcp := cfg.Services[0]

	// The chain's first hop wins over the forwarder.
	if got := cfg.Targets(&tcp); len(got) != 1 || got[0] != "1.2.3.4:9000" {
		t.Fatalf("chain targets = %v", got)
	}
	if got := cfg.FirstHopConnectorType(&tcp); got != "relay" {
		t.Fatalf("connector = %q", got)
	}

	// Without a chain the forwarder's nodes are used as-is (host filters only
	// affect the balancer, not Targets).
	noChain := Service{
		Forwarder: &Forwarder{Nodes: []Node{
			{Name: "plain", Addr: "10.1.1.1:80"},
			{Name: "filtered", Addr: "10.1.1.2:80", Metadata: map[string]any{"host": "example.test"}},
		}},
	}
	if got := cfg.Targets(&noChain); len(got) != 2 || got[0] != "10.1.1.1:80" || got[1] != "10.1.1.2:80" {
		t.Fatalf("forwarder targets = %v", got)
	}
	if got := cfg.FirstHopConnectorType(&noChain); got != "" {
		t.Fatalf("connector without chain = %q", got)
	}

	// A missing chain name or a missing chain yields no targets.
	missing := Service{Parent: Parent{Chain: "nope"}}
	if got := cfg.Targets(&missing); got != nil {
		t.Fatalf("missing chain targets = %v", got)
	}
}

func TestChainLookup(t *testing.T) {
	cfg := parseSample(t)
	chain := cfg.ChainByName("chain-1")
	if chain == nil || chain.Name != "chain-1" || len(chain.Hops) != 2 {
		t.Fatalf("chain = %+v", chain)
	}
	if cfg.ChainByName("missing") != nil {
		t.Fatal("missing chain found")
	}

	// A hop with no nodes is skipped when collecting targets.
	empty := &Config{Chains: []Chain{{Name: "c", Hops: []Hop{
		{Name: "empty"},
		{Name: "full", Nodes: []Node{{Addr: "9.9.9.9:1"}}},
	}}}}
	s := Service{Parent: Parent{Chain: "c"}}
	if got := empty.Targets(&s); len(got) != 1 || got[0] != "9.9.9.9:1" {
		t.Fatalf("targets = %v", got)
	}
}

func TestExtraKeysRoundTrip(t *testing.T) {
	cfg := parseSample(t)
	raw, ok := cfg.Extra["unknown_top"]
	if !ok {
		t.Fatal("missing extra")
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil || decoded["a"].(float64) != 1 {
		t.Fatalf("extra = %s (%v)", raw, err)
	}
}

package service

import (
	"strings"
	"testing"

	"github.com/relayx/agent/internal/gostcfg"
)

// applyDoc parses a panel document and applies it to a fresh manager.
func applyDoc(t *testing.T, doc string) ([]Result, *Manager) {
	t.Helper()
	cfg, err := gostcfg.Parse([]byte(doc))
	if err != nil {
		t.Fatalf("gostcfg.Parse: %v", err)
	}
	m := New(Options{})
	t.Cleanup(func() { _ = m.Close() })
	return m.Apply(cfg), m
}

func tcpForwardDoc(name, addr string, forwarder bool) string {
	fwd := ""
	if forwarder {
		fwd = `,"forwarder":{"nodes":[{"name":"n","addr":"127.0.0.1:9","metadata":{"weight":"1"}}],"selector":{"strategy":"round"}}`
	}
	return `{"services":[{"name":"` + name + `","addr":"` + addr + `",
		"handler":{"type":"tcp"},"listener":{"type":"tcp"}` + fwd + `}]}`
}

func TestApplyPlainTCPForward(t *testing.T) {
	results, m := applyDoc(t, tcpForwardDoc("tcp-1", "127.0.0.1:0", true))
	if len(results) != 1 {
		t.Fatalf("results = %d", len(results))
	}
	res := results[0]
	if !res.OK() || res.Type != "tcp/tcp" {
		t.Fatalf("result = %+v", res)
	}
	if active := m.Active(); len(active) != 1 || !active["tcp-1"].OK() {
		t.Fatalf("active = %+v", active)
	}
}

func TestApplyTCPWithoutTargetFails(t *testing.T) {
	results, _ := applyDoc(t, tcpForwardDoc("tcp-1", "127.0.0.1:0", false))
	if results[0].Err == nil || !strings.Contains(results[0].Err.Error(), "has no forward target") {
		t.Fatalf("result = %+v", results[0])
	}
}

func TestApplyProtocolHandlers(t *testing.T) {
	cases := []struct {
		name    string
		doc     string
		wantTyp string
	}{
		{
			name:    "http proxy",
			doc:     `{"services":[{"name":"http-1","addr":"127.0.0.1:0","handler":{"type":"http"},"listener":{"type":"tcp"}}]}`,
			wantTyp: "tcp/http",
		},
		{
			name:    "socks5",
			doc:     `{"services":[{"name":"socks-1","addr":"127.0.0.1:0","handler":{"type":"socks5","metadata":{"udp":true}},"listener":{"type":"tcp"}}]}`,
			wantTyp: "tcp/socks5",
		},
		{
			name:    "shadowsocks tcp",
			doc:     `{"services":[{"name":"ss-1","addr":"127.0.0.1:0","handler":{"type":"ss","auth":{"username":"aes-256-gcm","password":"pw"}},"listener":{"type":"tcp"}}]}`,
			wantTyp: "tcp/ss",
		},
		{
			name:    "shadowsocks udp",
			doc:     `{"services":[{"name":"ssu-1","addr":"127.0.0.1:0","handler":{"type":"ssu","auth":{"username":"aes-256-gcm","password":"pw"}},"listener":{"type":"udp"}}]}`,
			wantTyp: "udp/ssu",
		},
		{
			name:    "cipher-less ssu (panel udp hop)",
			doc:     `{"services":[{"name":"ssu-2","addr":"127.0.0.1:0","handler":{"type":"ssu"},"listener":{"type":"udp"}}]}`,
			wantTyp: "udp/ssu",
		},
		{
			name:    "relay over tls",
			doc:     `{"services":[{"name":"tls-1","addr":"127.0.0.1:0","handler":{"type":"relay"},"listener":{"type":"tls"}}]}`,
			wantTyp: "tls/relay",
		},
		{
			name:    "relay over wss",
			doc:     `{"services":[{"name":"wss-1","addr":"127.0.0.1:0","handler":{"type":"relay"},"listener":{"type":"wss"}}]}`,
			wantTyp: "wss/relay",
		},
		{
			name:    "relay over mtcp",
			doc:     `{"services":[{"name":"mtcp-1","addr":"127.0.0.1:0","handler":{"type":"relay"},"listener":{"type":"mtcp"}}]}`,
			wantTyp: "mtcp/relay",
		},
		{
			name:    "relayx listener",
			doc:     `{"services":[{"name":"relayx-1","addr":"127.0.0.1:0","handler":{"type":"relay"},"listener":{"type":"relayx","metadata":{"key":"k1"}}}]}`,
			wantTyp: "relayx/relay",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			results, _ := applyDoc(t, c.doc)
			res := results[0]
			if res.Stub {
				t.Fatalf("stubbed: %s", res.Reason)
			}
			if res.Err != nil {
				t.Fatalf("error: %v", res.Err)
			}
			if res.Type != c.wantTyp {
				t.Fatalf("type = %q, want %q", res.Type, c.wantTyp)
			}
		})
	}
}

func TestApplyStubsUnsupportedTypes(t *testing.T) {
	cases := []struct {
		name   string
		doc    string
		reason string
	}{
		{
			name:   "vless handler on tcp",
			doc:    `{"services":[{"name":"v-1","addr":"127.0.0.1:0","handler":{"type":"vless"},"listener":{"type":"tcp"}}]}`,
			reason: "not implemented in replica",
		},
		{
			name:   "reality listener with a non-vless handler",
			doc:    `{"services":[{"name":"r-1","addr":"127.0.0.1:0","handler":{"type":"tcp"},"listener":{"type":"reality"}}]}`,
			reason: "not implemented in replica",
		},
		{
			name:   "relayx listener with a tcp handler",
			doc:    `{"services":[{"name":"rx-1","addr":"127.0.0.1:0","handler":{"type":"tcp"},"listener":{"type":"relayx"}}]}`,
			reason: "relayx listener: handler tcp is not implemented in replica",
		},
		{
			name:   "h2 listener",
			doc:    `{"services":[{"name":"h2-1","addr":"127.0.0.1:0","handler":{"type":"tcp"},"listener":{"type":"h2"}}]}`,
			reason: "not implemented in replica",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			results, m := applyDoc(t, c.doc)
			res := results[0]
			if !res.Stub || !strings.Contains(res.Reason, c.reason) {
				t.Fatalf("result = %+v", res)
			}
			if len(m.Active()) != 0 {
				t.Fatalf("stubbed service is active: %+v", m.Active())
			}
		})
	}
}

func TestApplyReconcilesServices(t *testing.T) {
	cfg, err := gostcfg.Parse([]byte(tcpForwardDoc("tcp-1", "127.0.0.1:0", true)))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()

	first := m.Apply(cfg)
	if !first[0].OK() {
		t.Fatalf("first = %+v", first[0])
	}

	// Re-applying the same document keeps the running instance.
	second := m.Apply(cfg)
	if second[0].Port != first[0].Port || !second[0].OK() {
		t.Fatalf("second = %+v, first port = %d", second[0], first[0].Port)
	}

	// A changed definition restarts the service and the old port is released.
	changed, err := gostcfg.Parse([]byte(tcpForwardDoc("tcp-1", "127.0.0.1:0", true)))
	if err != nil {
		t.Fatal(err)
	}
	changed.Services[0].Forwarder.Nodes[0].Addr = "127.0.0.1:10"
	third := m.Apply(changed)
	if !third[0].OK() {
		t.Fatalf("third = %+v", third[0])
	}
	if len(m.Active()) != 1 {
		t.Fatalf("active = %+v", m.Active())
	}

	// Removing the service stops it.
	empty, _ := gostcfg.Parse([]byte(`{"services":[]}`))
	m.Apply(empty)
	if len(m.Active()) != 0 {
		t.Fatalf("active after removal = %+v", m.Active())
	}
}

func TestParsePortRange(t *testing.T) {
	if got := ParsePortRange("1000-1002,2000"); len(got) != 4 || got[0] != 1000 || got[3] != 2000 {
		t.Fatalf("range = %v", got)
	}
	if got := ParsePortRange("80"); len(got) != 1 || got[0] != 80 {
		t.Fatalf("single = %v", got)
	}
	if got := ParsePortRange("0-5"); len(got) != 0 {
		t.Fatalf("invalid low bound = %v", got)
	}
	if got := ParsePortRange("abc, ,-5"); len(got) != 0 {
		t.Fatalf("garbage = %v", got)
	}
	if got := ParsePortRange("1000-6000"); len(got) != 4097 {
		t.Fatalf("clamped = %d", len(got))
	}
}

func TestObserveEventsOnlyForStatsServices(t *testing.T) {
	doc := `{"services":[
		{"name":"ss-1","addr":"127.0.0.1:0",
		 "handler":{"type":"ss","auth":{"username":"aes-256-gcm","password":"pw"}},
		 "listener":{"type":"tcp"},
		 "metadata":{"enableStats":true,"observer.resetTraffic":true}},
		{"name":"tcp-1","addr":"127.0.0.1:0","handler":{"type":"tcp"},"listener":{"type":"tcp"},
		 "forwarder":{"nodes":[{"name":"n","addr":"127.0.0.1:9","metadata":{"weight":"1"}}],"selector":{"strategy":"round"}}}
	]}`
	results, m := applyDoc(t, doc)
	for _, res := range results {
		if !res.OK() {
			t.Fatalf("result = %+v", res)
		}
	}

	events := m.ObserveEvents()
	if len(events) != 1 {
		t.Fatalf("events = %+v", events)
	}
	if events[0].Service != "ss-1" || events[0].Kind != "service" || events[0].Stats == nil {
		t.Fatalf("event = %+v", events[0])
	}
}

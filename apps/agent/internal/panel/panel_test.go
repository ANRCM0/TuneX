package panel

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/config"
	"github.com/relayx/agent/internal/gostcfg"
)

func TestDedupeKeys(t *testing.T) {
	custom := config.DefaultConfigSecret
	got := dedupeKeys([]string{custom, custom, "", "not-a-key", config.DefaultLicenseSecret})
	if len(got) != 2 {
		t.Fatalf("dedupeKeys returned %d keys, want 2", len(got))
	}
	if len(got[0]) != 32 || len(got[1]) != 32 {
		t.Fatalf("decoded key lengths = %d, %d", len(got[0]), len(got[1]))
	}
}

func TestStatsPeriod(t *testing.T) {
	if got := statsPeriod(&gostcfg.Config{}); got != 0 {
		t.Fatalf("empty config period = %v", got)
	}

	idle := gostcfg.Service{}
	reporting := gostcfg.Service{Observer: "http://panel/observer"}
	reporting.Metadata = nil
	if got := statsPeriod(&gostcfg.Config{Services: []gostcfg.Service{idle}}); got != 0 {
		t.Fatalf("idle service period = %v", got)
	}
	if got := statsPeriod(&gostcfg.Config{Services: []gostcfg.Service{reporting}}); got != 30*time.Second {
		t.Fatalf("default period = %v", got)
	}

	fast := gostcfg.Service{Observer: "http://panel/observer"}
	fast.Metadata = map[string]any{"observer.period": "5s"}
	slow := gostcfg.Service{Observer: "http://panel/observer"}
	slow.Metadata = map[string]any{"observer.period": "10s"}
	if got := statsPeriod(&gostcfg.Config{Services: []gostcfg.Service{slow, fast}}); got != 5*time.Second {
		t.Fatalf("minimum period = %v", got)
	}

	invalid := gostcfg.Service{Observer: "http://panel/observer"}
	invalid.Metadata = map[string]any{"observer.period": "soon"}
	if got := statsPeriod(&gostcfg.Config{Services: []gostcfg.Service{invalid}}); got != 30*time.Second {
		t.Fatalf("invalid period fallback = %v", got)
	}

	enabled := gostcfg.Service{Metadata: map[string]any{"enableStats": true}}
	if got := statsPeriod(&gostcfg.Config{Services: []gostcfg.Service{enabled}}); got != 30*time.Second {
		t.Fatalf("enableStats period = %v", got)
	}
}

func TestTestAddr(t *testing.T) {
	cases := []struct {
		key  string
		raw  any
		want string
	}{
		{"1.2.3.4", float64(80), "1.2.3.4:80"},
		{"1.2.3.4", "8080", "1.2.3.4:8080"},
		{"example.test", "example.test:443", "example.test:443"},
		{"example.test", "example.test", "example.test:80"},
		{"::1", "[::1]:53", "[::1]:53"},
		{"1.2.3.4", json.Number("9000"), "1.2.3.4:9000"},
		{"1.2.3.4", map[string]any{}, ""},
		{"1.2.3.4", nil, ""},
	}
	for _, c := range cases {
		if got := testAddr(c.key, c.raw); got != c.want {
			t.Fatalf("testAddr(%q, %v) = %q, want %q", c.key, c.raw, got, c.want)
		}
	}
}

func TestExtraKeys(t *testing.T) {
	if got := extraKeys(&gostcfg.Config{}); got != "" {
		t.Fatalf("extraKeys(empty) = %q", got)
	}
	cfg := &gostcfg.Config{Extra: map[string]json.RawMessage{
		"alpha": json.RawMessage("1"),
		"beta":  json.RawMessage("2"),
	}}
	got := extraKeys(cfg)
	if !strings.HasPrefix(got, " (ignored keys: ") || !strings.HasSuffix(got, ")") {
		t.Fatalf("extraKeys = %q", got)
	}
	if !strings.Contains(got, "alpha") || !strings.Contains(got, "beta") {
		t.Fatalf("extraKeys = %q", got)
	}
}

func TestEnvTruthy(t *testing.T) {
	for _, value := range []string{"1", "true", "TRUE", " yes ", "on"} {
		if !envTruthy(value) {
			t.Fatalf("envTruthy(%q) = false", value)
		}
	}
	for _, value := range []string{"", "0", "off", "no", "maybe"} {
		if envTruthy(value) {
			t.Fatalf("envTruthy(%q) = true", value)
		}
	}
}

func TestJoinArgsAndTruncate(t *testing.T) {
	got := joinArgs([]json.RawMessage{json.RawMessage(`{"a":1}`), json.RawMessage(`7`)})
	if got != `{"a":1} 7` {
		t.Fatalf("joinArgs = %q", got)
	}
	long := strings.Repeat("x", 250)
	got = joinArgs([]json.RawMessage{json.RawMessage(`"` + long + `"`)})
	if !strings.HasSuffix(got, "…") || len([]rune(got)) != 201 {
		t.Fatalf("joinArgs truncation = %d bytes / %d runes", len(got), len([]rune(got)))
	}
	if truncate("short", 10) != "short" {
		t.Fatalf("truncate short = %q", truncate("short", 10))
	}
	if truncate("abcdef", 3) != "abc…" {
		t.Fatalf("truncate long = %q", truncate("abcdef", 3))
	}
}

func TestBasicSysInfo(t *testing.T) {
	info := basicSysInfo()
	if len(info) != 5 {
		t.Fatalf("basicSysInfo keys = %v", info)
	}
	for _, key := range []string{"cpu_num", "boot_time", "hostname", "os", "arch"} {
		if _, ok := info[key]; !ok {
			t.Fatalf("missing %s in %v", key, info)
		}
	}
}

func TestNewResolvesNodeID(t *testing.T) {
	cfg := config.New()
	cfg.Server = "http://panel:3003"
	cfg.Token = "token"
	cfg.NodeID = "node-42"
	agent, err := New(cfg, "test-version")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if agent.NodeID() != "node-42" {
		t.Fatalf("NodeID = %q", agent.NodeID())
	}
	if err := agent.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	cfg.NodeID = ""
	agent, err = New(cfg, "test-version")
	if err != nil {
		t.Fatalf("New without node-id: %v", err)
	}
	defer agent.Close()
	if strings.TrimSpace(agent.NodeID()) == "" {
		t.Fatal("hostname fallback produced an empty node id")
	}
}

package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hermetic points $HOME at an empty directory so the viper-style search path
// cannot pick up a real ~/.relayx-agent/config.* during a test.
func hermetic(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func TestNewDefaults(t *testing.T) {
	cfg := New()
	if cfg.ConfigSecret != DefaultConfigSecret {
		t.Fatalf("ConfigSecret = %q", cfg.ConfigSecret)
	}
	if cfg.LicenseSecret != DefaultLicenseSecret {
		t.Fatalf("LicenseSecret = %q", cfg.LicenseSecret)
	}
	if cfg.PprofPort != 0 {
		t.Fatalf("PprofPort default = %d, want 0", cfg.PprofPort)
	}
	if len(cfg.Ports()) != 9 {
		t.Fatalf("Ports() = %v", cfg.Ports())
	}
	for name, port := range cfg.Ports() {
		if port != 0 {
			t.Fatalf("default port %s = %d", name, port)
		}
	}
}

func TestValidate(t *testing.T) {
	if err := New().Validate(); err == nil || !strings.Contains(err.Error(), `"server", "token"`) {
		t.Fatalf("Validate() = %v, want both flags missing in cobra order", err)
	}
	cfg := New()
	cfg.Server = "http://panel:3003"
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), `"token"`) {
		t.Fatalf("Validate() = %v", err)
	}
	cfg.Token = "t"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
	cfg.Token = "   "
	if err := cfg.Validate(); err == nil {
		t.Fatal("whitespace token should be rejected")
	}
}

func TestParseFlags(t *testing.T) {
	hermetic(t)

	t.Run("short and long forms", func(t *testing.T) {
		cfg, err := Parse([]string{"-t", "tok", "--server", "http://p:1", "-n", "node-7"})
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if cfg.Token != "tok" || cfg.Server != "http://p:1" || cfg.NodeID != "node-7" {
			t.Fatalf("cfg = %+v", cfg)
		}
	})

	t.Run("inline values", func(t *testing.T) {
		cfg, err := Parse([]string{"--token=tok", "--server=http://p:1", "--tcp-port=1234"})
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if cfg.Token != "tok" || cfg.TCPPort != 1234 {
			t.Fatalf("cfg = %+v", cfg)
		}
	})

	t.Run("bool flags", func(t *testing.T) {
		cfg, err := Parse([]string{"-t", "tok", "-s", "s", "--debug"})
		if err != nil || !cfg.Debug {
			t.Fatalf("--debug: %v %+v", err, cfg)
		}
		cfg, err = Parse([]string{"-t", "tok", "-s", "s", "--debug=false"})
		if err != nil || cfg.Debug {
			t.Fatalf("--debug=false: %v %+v", err, cfg)
		}
		cfg, err = Parse([]string{"-t", "tok", "-s", "s", "--debug=yes"})
		if err != nil || !cfg.Debug {
			t.Fatalf("--debug=yes: %v %+v", err, cfg)
		}
		if _, err := Parse([]string{"-t", "tok", "-s", "s", "--debug=maybe"}); err == nil {
			t.Fatal("invalid bool accepted")
		}
	})

	t.Run("connect-ip accumulates and splits", func(t *testing.T) {
		cfg, err := Parse([]string{"-t", "t", "-s", "s", "-i", "1.2.3.4,5.6.7.8", "--connect-ip", "9.9.9.9"})
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		want := []string{"1.2.3.4", "5.6.7.8", "9.9.9.9"}
		if strings.Join(cfg.ConnectIP, ",") != strings.Join(want, ",") {
			t.Fatalf("ConnectIP = %v", cfg.ConnectIP)
		}
	})

	t.Run("numeric flags", func(t *testing.T) {
		cfg, err := Parse([]string{"-t", "t", "-s", "s", "--mtcp-port=2", "--udp-port", "3",
			"--relayx-port=4", "--wss-port=5", "--mwss-port=6", "--tls-port=7", "--mtls-port=8",
			"--quic-port=9", "--pprof-port=0"})
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		ports := cfg.Ports()
		want := map[string]int{"tcp": 0, "mtcp": 2, "udp": 3, "relayx": 4, "wss": 5, "mwss": 6, "tls": 7, "mtls": 8, "quic": 9}
		for name, value := range want {
			if ports[name] != value {
				t.Fatalf("port %s = %d, want %d", name, ports[name], value)
			}
		}
		if cfg.PprofPort != 0 {
			t.Fatalf("PprofPort = %d", cfg.PprofPort)
		}
	})

	t.Run("errors", func(t *testing.T) {
		cases := [][]string{
			{"-t"},                                   // missing value
			{"--unknown", "x"},                       // unknown flag
			{"positional"},                           // bare argument
			{"-t", "t", "-s", "s", "--tcp-port=abc"}, // bad number
			{"-t", "t", "-s", "s", "--tcp-port"},     // missing numeric value
		}
		for _, args := range cases {
			if _, err := Parse(args); err == nil {
				t.Fatalf("Parse(%v) accepted", args)
			}
		}
	})

	t.Run("help", func(t *testing.T) {
		for _, flag := range []string{"-h", "--help"} {
			if _, err := Parse([]string{flag}); !errors.Is(err, ErrHelp) {
				t.Fatalf("Parse(%s) = %v, want ErrHelp", flag, err)
			}
		}
	})

	t.Run("double dash terminates flags", func(t *testing.T) {
		cfg, err := Parse([]string{"-t", "t", "-s", "s", "--", "--debug"})
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if cfg.Debug {
			t.Fatal("--debug after -- should be ignored")
		}
	})
}

func TestParseConfigFile(t *testing.T) {
	hermetic(t)
	dir := t.TempDir()
	yaml := filepath.Join(dir, "agent.yaml")
	body := strings.Join([]string{
		"# agent config",
		"token: file-token   # inline comment",
		"server: \"http://file:3003\"",
		"node-id: file-node",
		"debug: true",
		"tcp-port: 1111",
		"connect-ip:",
		"  - 10.0.0.1",
		"  - '10.0.0.2'",
		"out-interface: eth9",
	}, "\n")
	if err := os.WriteFile(yaml, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Parse([]string{"-c", yaml})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Token != "file-token" || cfg.Server != "http://file:3003" || cfg.NodeID != "file-node" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if !cfg.Debug || cfg.TCPPort != 1111 || cfg.OutInterface != "eth9" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if strings.Join(cfg.ConnectIP, ",") != "10.0.0.1,10.0.0.2" {
		t.Fatalf("ConnectIP = %v", cfg.ConnectIP)
	}
	if cfg.ConfigFile != yaml {
		t.Fatalf("ConfigFile = %q", cfg.ConfigFile)
	}

	// A flag wins over the file.
	cfg, err = Parse([]string{"-c", yaml, "--tcp-port=2222"})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.TCPPort != 2222 {
		t.Fatalf("TCPPort = %d", cfg.TCPPort)
	}

	// The environment wins for the config secret.
	t.Setenv(EnvConfigSecret, "env-secret")
	cfg, err = Parse([]string{"-c", yaml})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.ConfigSecret != "env-secret" {
		t.Fatalf("ConfigSecret = %q", cfg.ConfigSecret)
	}

	// A missing explicit file is an error, not a silent fallback.
	if _, err := Parse([]string{"-c", filepath.Join(dir, "nope.yaml"), "-t", "t", "-s", "s"}); err == nil {
		t.Fatal("missing config file accepted")
	}

	// A malformed YAML line is an error.
	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(bad, []byte("this-is-not-yaml\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse([]string{"-c", bad}); err == nil {
		t.Fatal("malformed config accepted")
	}
}

func TestLoadFileJSON(t *testing.T) {
	hermetic(t)
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(`{"token":"json-token","server":"http://j:1","connect-ip":["1.1.1.1"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Parse([]string{"-c", path})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if cfg.Token != "json-token" || cfg.Server != "http://j:1" || len(cfg.ConnectIP) != 1 {
		t.Fatalf("cfg = %+v", cfg)
	}
}

func TestLocalNodeID(t *testing.T) {
	cfg := New()
	cfg.NodeID = "explicit"
	if got, err := cfg.LocalNodeID(); err != nil || got != "explicit" {
		t.Fatalf("LocalNodeID = %q, %v", got, err)
	}
	cfg.NodeID = ""
	got, err := cfg.LocalNodeID()
	if err != nil || strings.TrimSpace(got) == "" {
		t.Fatalf("hostname fallback = %q, %v", got, err)
	}
}

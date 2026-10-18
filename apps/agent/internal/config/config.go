// Package config holds the agent's command-line / config-file surface.
//
// The flag names, short forms, defaults and meanings were recovered from the
// upstream binary (reports/AGENT_CONTROL.md:55-76 "flag table") and every
// persistent flag is also a config-file key (viper binds each flag). Upstream
// looks the file up as `$HOME/.relayx-agent/config.<ext>` via
// `viper.SetConfigName("config")`; `-c/--config` is registered but never
// honoured (reports/AGENT_CONTROL.md:82-95), which this replica deliberately
// fixes: `-c` selects an explicit file when given.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Defaults for values that the replica has to invent because upstream keeps
// them as compile-time constants.
const (
	// DefaultConfigSecret is the panel<->agent Fernet key. Upstream hardcodes
	// it as key1 at VA 0x18d9ef4 and the same literal is used by the panel in
	// work/modules/006__src__services__fernet.ts:2.
	DefaultConfigSecret = "KV/JjKrj8g6nNnvpQoViRs4QLLap5d9cRSwmMBOEdP4="

	// DefaultLicenseSecret is the agent-only Fernet key (upstream key2 at
	// VA 0x18d9f20) used for the `license` field of the register ack.
	DefaultLicenseSecret = "ejNiBvHNYvHSJ307kwKzdFn70XYgnJR8eIzbApWF8Vg="

	// ConfigDirName / ConfigFileName mirror viper's SetConfigName("config").
	ConfigDirName  = ".relayx-agent"
	ConfigFileName = "config"

	// DefaultPprofPort mirrors the upstream --pprof-port default (6060).
	DefaultPprofPort = 6060

	// EnvConfigSecret / EnvConfigSecretAlt let the deployment override the
	// Fernet key without a flag.
	EnvConfigSecret    = "RELAYX_AGENT_CONFIG_SECRET"
	EnvConfigSecretAlt = "CONFIG_SECRET"
)

// Config is the fully resolved agent configuration.
type Config struct {
	Token           string   `json:"token"`
	Server          string   `json:"server"`
	NodeID          string   `json:"node-id"`
	ConnectIP       []string `json:"connect-ip"`
	Debug           bool     `json:"debug"`
	OutInterface    string   `json:"out-interface"`
	VnstatInterface string   `json:"vnstat-interface"`
	ListenIP        string   `json:"listen-ip"`
	PortRange       string   `json:"port-range"`

	TCPPort    int `json:"tcp-port"`
	MTCPPort   int `json:"mtcp-port"`
	UDPPort    int `json:"udp-port"`
	RelayxPort int `json:"relayx-port"`
	WSSPort    int `json:"wss-port"`
	MWSSPort   int `json:"mwss-port"`
	TLSPort    int `json:"tls-port"`
	MTLSPort   int `json:"mtls-port"`
	QUICPort   int `json:"quic-port"`

	// PprofPort is not viper-bound upstream: it is flag/env only.
	PprofPort int `json:"-"`

	// ConfigSecret is a replica-only extension: the Fernet key used to decrypt
	// the panel's `config` event (upstream key1). Never read from the config
	// file — upstream keeps it as a compiled-in constant.
	ConfigSecret string `json:"-"`

	// LicenseSecret is the Fernet key for the register ack's `license` field
	// (upstream key2).
	LicenseSecret string `json:"-"`

	// ConfigFile records the file that was actually loaded, if any.
	ConfigFile string `json:"-"`
}

// New returns the defaults.
func New() *Config {
	return &Config{
		ConfigSecret:  DefaultConfigSecret,
		LicenseSecret: DefaultLicenseSecret,
		// Upstream's cobra flag defaults --pprof-port to 6060, so a default
		// start does expose the pprof endpoint on 127.0.0.1:6060.
		PprofPort: DefaultPprofPort,
	}
}

// Ports is the `ports` object of the register payload. Upstream always sends
// all nine keys, using 0 for unset flags.
func (c *Config) Ports() map[string]int {
	return map[string]int{
		"tcp":    c.TCPPort,
		"mtcp":   c.MTCPPort,
		"udp":    c.UDPPort,
		"relayx": c.RelayxPort,
		"wss":    c.WSSPort,
		"mwss":   c.MWSSPort,
		"tls":    c.TLSPort,
		"mtls":   c.MTLSPort,
		"quic":   c.QUICPort,
	}
}

// LocalNodeID resolves the node identity: `-n` when set, else os.Hostname()
// (upstream reports/AGENT_CONTROL.md:58).
func (c *Config) LocalNodeID() (string, error) {
	if c.NodeID != "" {
		return c.NodeID, nil
	}
	h, err := os.Hostname()
	if err != nil {
		return "", fmt.Errorf("config: cannot determine hostname for node-id: %w", err)
	}
	return h, nil
}

// Validate enforces the same requirements as the upstream cobra command:
// token and server are mandatory.
func (c *Config) Validate() error {
	missing := make([]string, 0, 2)
	if strings.TrimSpace(c.Server) == "" {
		missing = append(missing, `"server"`)
	}
	if strings.TrimSpace(c.Token) == "" {
		missing = append(missing, `"token"`)
	}
	if len(missing) > 0 {
		// cobra's exact wording and ordering.
		return fmt.Errorf("required flag(s) %s not set", strings.Join(missing, ", "))
	}
	return nil
}

// Usage is the --help text.
func Usage() string {
	return `RelayX node agent (replica)

Usage:
  relayx-agent [flags]

Flags:
  -t, --token string              node group token (required)
  -s, --server string             panel origin, e.g. http://127.0.0.1:3003 (required)
  -n, --node-id string            node id (default: hostname)
  -i, --connect-ip stringArray    public IP(s) to advertise (default: auto-detect)
  -d, --debug                     enable debug logging
  -o, --out-interface string      outbound interface
  -I, --vnstat-interface string   vnstat interface for traffic accounting
  -l, --listen-ip string          force services to listen on this IP
  -r, --port-range string         candidate ports for WAIT_LISTEN, e.g. 80,443,30000-30010
      --tcp-port int              advertised tcp out-listen port
      --mtcp-port int             advertised mtcp out-listen port
      --udp-port int              advertised udp out-listen port
      --relayx-port int           advertised relayx out-listen port
      --wss-port int              advertised wss out-listen port
      --mwss-port int             advertised mwss out-listen port
      --tls-port int              advertised tls out-listen port
      --mtls-port int             advertised mtls out-listen port
      --quic-port int             advertised quic out-listen port
      --pprof-port int            pprof on 127.0.0.1 (0 disables)
      --config-secret string      panel Fernet key (default: upstream key1)
      --license-secret string     license Fernet key (default: upstream key2)
  -c, --config string             config file (default is $HOME/` + ConfigDirName + `/` + ConfigFileName + `.<ext>)
  -h, --help                      help for relayx-agent

Config file keys are the kebab-case flag names, e.g.:
  token: xxx
  server: http://panel:3003
  connect-ip:
    - 1.2.3.4
`
}

// Parse resolves configuration from args (without the program name). Order of
// precedence, lowest first: defaults, config file, environment, flags.
func Parse(args []string) (*Config, error) {
	cfg := New()

	// First pass: only to find -c/--config so the file can be loaded first.
	explicitFile, rest, err := extractConfigFile(args)
	if err != nil {
		return nil, err
	}
	file, err := LoadFile(explicitFile)
	if err != nil {
		return nil, err
	}
	if file != nil {
		cfg.mergeFile(file)
	}

	if v := os.Getenv(EnvConfigSecret); v != "" {
		cfg.ConfigSecret = v
	} else if v := os.Getenv(EnvConfigSecretAlt); v != "" {
		cfg.ConfigSecret = v
	}
	if v := os.Getenv("RELAYX_AGENT_LICENSE_SECRET"); v != "" {
		cfg.LicenseSecret = v
	}

	if err := cfg.parseFlags(rest); err != nil {
		return nil, err
	}
	if cfg.ConfigFile == "" && explicitFile != "" {
		cfg.ConfigFile = explicitFile
	}
	// cobra enforces the required flags before RunE runs; do the same here so a
	// bare `relayx-agent` exits 1 without touching the network.
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func extractConfigFile(args []string) (string, []string, error) {
	var file string
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-c" || a == "--config":
			if i+1 >= len(args) {
				return "", nil, fmt.Errorf("flag needs an argument: %s", a)
			}
			file = args[i+1]
			i++
		case strings.HasPrefix(a, "--config="):
			file = strings.TrimPrefix(a, "--config=")
		case strings.HasPrefix(a, "-c="):
			file = strings.TrimPrefix(a, "-c=")
		default:
			out = append(out, a)
		}
	}
	return file, out, nil
}

// parseFlags applies the upstream flag set.
func (c *Config) parseFlags(args []string) error {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "" {
			continue
		}
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") {
			return fmt.Errorf("unknown argument %q", arg)
		}
		name := strings.TrimLeft(arg, "-")
		var inline string
		hasInline := false
		if j := strings.IndexByte(name, '='); j >= 0 {
			inline, hasInline = name[j+1:], true
			name = name[:j]
		}
		canonical, isBool, err := canonicalFlag(name)
		if err != nil {
			return err
		}
		if canonical == "help" {
			return ErrHelp
		}
		value := inline
		if !hasInline {
			if isBool {
				value = "true"
			} else {
				if i+1 >= len(args) {
					return fmt.Errorf("flag needs an argument: %s", arg)
				}
				value = args[i+1]
				i++
			}
		}
		if err := c.set(canonical, value); err != nil {
			return err
		}
	}
	return nil
}

// ErrHelp is returned when -h/--help was requested.
var ErrHelp = errors.New("help requested")

func canonicalFlag(name string) (canonical string, isBool bool, err error) {
	switch name {
	case "t", "token":
		return "token", false, nil
	case "s", "server":
		return "server", false, nil
	case "n", "node-id":
		return "node-id", false, nil
	case "i", "connect-ip":
		return "connect-ip", false, nil
	case "d", "debug":
		return "debug", true, nil
	case "o", "out-interface":
		return "out-interface", false, nil
	case "I", "vnstat-interface":
		return "vnstat-interface", false, nil
	case "l", "listen-ip":
		return "listen-ip", false, nil
	case "r", "port-range":
		return "port-range", false, nil
	case "tcp-port", "mtcp-port", "udp-port", "relayx-port", "wss-port",
		"mwss-port", "tls-port", "mtls-port", "quic-port", "pprof-port":
		return name, false, nil
	case "config-secret":
		return "config-secret", false, nil
	case "license-secret":
		return "license-secret", false, nil
	case "h", "help":
		return "help", true, nil
	default:
		return "", false, fmt.Errorf("unknown flag: --%s", name)
	}
}

func (c *Config) set(name, value string) error {
	switch name {
	case "token":
		c.Token = value
	case "server":
		c.Server = value
	case "node-id":
		c.NodeID = value
	case "connect-ip":
		c.ConnectIP = append(c.ConnectIP, splitList(value)...)
	case "debug":
		b, err := parseBool(value)
		if err != nil {
			return fmt.Errorf("invalid argument %q for --debug", value)
		}
		c.Debug = b
	case "out-interface":
		c.OutInterface = value
	case "vnstat-interface":
		c.VnstatInterface = value
	case "listen-ip":
		c.ListenIP = value
	case "port-range":
		c.PortRange = value
	case "config-secret":
		c.ConfigSecret = value
	case "license-secret":
		c.LicenseSecret = value
	default:
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("invalid argument %q for --%s", value, name)
		}
		switch name {
		case "tcp-port":
			c.TCPPort = n
		case "mtcp-port":
			c.MTCPPort = n
		case "udp-port":
			c.UDPPort = n
		case "relayx-port":
			c.RelayxPort = n
		case "wss-port":
			c.WSSPort = n
		case "mwss-port":
			c.MWSSPort = n
		case "tls-port":
			c.TLSPort = n
		case "mtls-port":
			c.MTLSPort = n
		case "quic-port":
			c.QUICPort = n
		case "pprof-port":
			c.PprofPort = n
		}
	}
	return nil
}

func parseBool(s string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "t", "true", "yes", "y", "on":
		return true, nil
	case "0", "f", "false", "no", "n", "off":
		return false, nil
	}
	return false, fmt.Errorf("not a boolean: %q", s)
}

func splitList(s string) []string {
	if strings.ContainsAny(s, ",") {
		parts := strings.Split(s, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return []string{s}
}

// SearchPaths returns the candidate config files in viper's order.
func SearchPaths() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	dir := filepath.Join(home, ConfigDirName)
	exts := []string{"json", "yaml", "yml", "toml", "properties", "props", "prop", "env", "ini", "hcl", "tfvars", "dotenv"}
	paths := make([]string, 0, len(exts))
	for _, e := range exts {
		paths = append(paths, filepath.Join(dir, ConfigFileName+"."+e))
	}
	return paths
}

// LoadFile reads a config file. When explicit is empty the viper-style search
// path under $HOME/.relayx-agent is used. It returns (nil, nil) when no file
// exists.
func LoadFile(explicit string) (map[string]any, error) {
	if explicit != "" {
		vals, err := readFile(explicit)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(os.Stderr, "Using config file: %s\n", explicit)
		return vals, nil
	}
	for _, p := range SearchPaths() {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		vals, err := readFile(p)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(os.Stderr, "Using config file: %s\n", p)
		return vals, nil
	}
	return nil, nil
}

func readFile(path string) (map[string]any, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	if strings.HasSuffix(path, ".json") {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, fmt.Errorf("config: parse %s: %w", path, err)
		}
		return m, nil
	}
	m, err := parseFlatYAML(string(b))
	if err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	return m, nil
}

// parseFlatYAML understands the subset viper users actually write for this
// agent: comments, `key: value` scalars, quoted strings, and `- item` lists
// under the preceding key. It is intentionally small — the full YAML spec is
// out of scope and unmarshalling uses encoding/json once the subset has been
// normalised.
func parseFlatYAML(src string) (map[string]any, error) {
	out := map[string]any{}
	lines := strings.Split(src, "\n")
	var listKey string
	for _, line := range lines {
		raw := line
		if i := strings.IndexByte(raw, '#'); i >= 0 {
			raw = raw[:i]
		}
		if strings.TrimSpace(raw) == "" {
			continue
		}
		trimmed := strings.TrimSpace(raw)
		if strings.HasPrefix(trimmed, "- ") || trimmed == "-" {
			if listKey == "" {
				return nil, fmt.Errorf("list item %q without a key", trimmed)
			}
			item := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
			out[listKey] = append(asSlice(out[listKey]), unquote(item))
			continue
		}
		idx := strings.IndexByte(trimmed, ':')
		if idx < 0 {
			return nil, fmt.Errorf("unsupported line %q", trimmed)
		}
		key := strings.TrimSpace(trimmed[:idx])
		val := strings.TrimSpace(trimmed[idx+1:])
		if val == "" {
			listKey = key
			if _, ok := out[key]; !ok {
				out[key] = nil
			}
			continue
		}
		listKey = ""
		out[key] = unquote(val)
	}
	// Drop empty placeholders that never got a list.
	for k, v := range out {
		if v == nil {
			delete(out, k)
		}
	}
	return out, nil
}

func asSlice(v any) []string {
	if v == nil {
		return nil
	}
	if s, ok := v.([]string); ok {
		return s
	}
	if s, ok := v.([]any); ok {
		out := make([]string, 0, len(s))
		for _, e := range s {
			out = append(out, fmt.Sprint(e))
		}
		return out
	}
	return []string{fmt.Sprint(v)}
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			if unq, err := strconv.Unquote(s); err == nil {
				return unq
			}
			return s[1 : len(s)-1]
		}
	}
	return s
}

// mergeFile applies config-file keys (kebab-case flag names) onto cfg.
func (c *Config) mergeFile(m map[string]any) {
	str := func(k string) (string, bool) {
		v, ok := m[k]
		if !ok || v == nil {
			return "", false
		}
		return fmt.Sprint(v), true
	}
	num := func(k string) (int, bool) {
		v, ok := m[k]
		if !ok || v == nil {
			return 0, false
		}
		n, err := strconv.Atoi(strings.TrimSpace(fmt.Sprint(v)))
		if err != nil {
			return 0, false
		}
		return n, true
	}
	boolean := func(k string) (bool, bool) {
		v, ok := m[k]
		if !ok || v == nil {
			return false, false
		}
		b, err := parseBool(fmt.Sprint(v))
		if err != nil {
			return false, false
		}
		return b, true
	}

	if v, ok := str("token"); ok {
		c.Token = v
	}
	if v, ok := str("server"); ok {
		c.Server = v
	}
	if v, ok := str("node-id"); ok {
		c.NodeID = v
	}
	if v, ok := m["connect-ip"]; ok {
		c.ConnectIP = asSlice(v)
	}
	if v, ok := boolean("debug"); ok {
		c.Debug = v
	}
	if v, ok := str("out-interface"); ok {
		c.OutInterface = v
	}
	if v, ok := str("vnstat-interface"); ok {
		c.VnstatInterface = v
	}
	if v, ok := str("listen-ip"); ok {
		c.ListenIP = v
	}
	if v, ok := str("port-range"); ok {
		c.PortRange = v
	}
	if n, ok := num("tcp-port"); ok {
		c.TCPPort = n
	}
	if n, ok := num("mtcp-port"); ok {
		c.MTCPPort = n
	}
	if n, ok := num("udp-port"); ok {
		c.UDPPort = n
	}
	if n, ok := num("relayx-port"); ok {
		c.RelayxPort = n
	}
	if n, ok := num("wss-port"); ok {
		c.WSSPort = n
	}
	if n, ok := num("mwss-port"); ok {
		c.MWSSPort = n
	}
	if n, ok := num("tls-port"); ok {
		c.TLSPort = n
	}
	if n, ok := num("mtls-port"); ok {
		c.MTLSPort = n
	}
	if n, ok := num("quic-port"); ok {
		c.QUICPort = n
	}
}

package sysinfo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRound2(t *testing.T) {
	cases := map[float64]float64{1.234: 1.23, 1.236: 1.24, 0: 0, 2.999: 3}
	for in, want := range cases {
		if got := round2(in); got != want {
			t.Fatalf("round2(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestCountNetFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "net")
	body := strings.Join([]string{
		"  sl  local_address rem_address   st",
		"   0: 0100007F:1F90 00000000:0000 0A",
		"   1: 0100007F:1F91 00000000:0000 0A",
		"",
		"   2: 0100007F:1F92 00000000:0000 0A",
	}, "\n")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := countNetFile(path); got != 3 {
		t.Fatalf("countNetFile = %d, want 3", got)
	}
	if got := countNetFile(filepath.Join(t.TempDir(), "missing")); got != 0 {
		t.Fatalf("missing file count = %d", got)
	}
}

func TestDiskUsage(t *testing.T) {
	total, used, percent := diskUsage("/")
	if total == 0 {
		t.Fatal("diskUsage total = 0")
	}
	if used > total {
		t.Fatalf("used %d > total %d", used, total)
	}
	if percent < 0 || percent > 100 {
		t.Fatalf("percent = %v", percent)
	}
}

func TestMemInfo(t *testing.T) {
	total, available := memInfo()
	if total == 0 {
		t.Fatal("memInfo total = 0")
	}
	if available > total {
		t.Fatalf("available %d > total %d", available, total)
	}
}

func TestStaticSources(t *testing.T) {
	if cpuCount() < 1 {
		t.Fatalf("cpuCount = %d", cpuCount())
	}
	if uptime() <= 0 {
		t.Fatalf("uptime = %d", uptime())
	}
	if bootTime() <= 0 {
		t.Fatalf("bootTime = %d", bootTime())
	}
	l1, l5, l15 := loadAvg()
	if l1 < 0 || l5 < 0 || l15 < 0 {
		t.Fatalf("loadAvg = %v %v %v", l1, l5, l15)
	}
	if strings.TrimSpace(osName()) == "" || strings.TrimSpace(kernelVersion()) == "" {
		t.Fatalf("os=%q kernel=%q", osName(), kernelVersion())
	}
	if strings.TrimSpace(goArch()) == "" {
		t.Fatal("goArch is empty")
	}
}

func TestGetBasicSysInfo(t *testing.T) {
	info := GetBasicSysInfo()
	for _, key := range []string{"cpu_num", "os", "platform", "kernel", "arch", "hostname",
		"boot_time", "disk_total", "disk_used", "disk_usage_percent", "mem_total", "mem_used", "mem_usage_percent"} {
		if _, ok := info[key]; !ok {
			t.Fatalf("missing %q in %v", key, info)
		}
	}
	if n, ok := info["cpu_num"].(int); !ok || n < 1 {
		t.Fatalf("cpu_num = %v", info["cpu_num"])
	}
}

func TestGetRealtimeSysInfo(t *testing.T) {
	first := GetRealtimeSysInfo()
	for _, key := range []string{"cpu_usage_percent", "load_1", "load_5", "load_15", "uptime"} {
		if _, ok := first[key]; !ok {
			t.Fatalf("missing %q in %v", key, first)
		}
	}
	if pct, ok := first["cpu_usage_percent"].(float64); !ok || pct < 0 || pct > 100 {
		t.Fatalf("cpu_usage_percent = %v", first["cpu_usage_percent"])
	}

	second := GetRealtimeSysInfo()
	for _, key := range []string{"net_in", "net_out", "traffic_in", "traffic_out",
		"traffic_month_in", "traffic_month_out", "tcp_connections", "udp_connections"} {
		if _, ok := second[key]; !ok {
			t.Fatalf("second sample lacks %q: %v", key, second)
		}
	}
	if first["traffic_in"] != nil && second["traffic_in"].(uint64) < first["traffic_in"].(uint64) {
		t.Fatalf("traffic_in went backwards: %v -> %v", first["traffic_in"], second["traffic_in"])
	}
}

func TestSelfRSSAndTraffic(t *testing.T) {
	if rss, err := selfRSS(); err != nil || rss == 0 {
		t.Fatalf("selfRSS = %d, %v", rss, err)
	}
	if SelfRSS() == 0 {
		t.Fatal("SelfRSS() = 0")
	}
	rx, tx := netTraffic("lo")
	if rx > 1<<60 || tx > 1<<60 {
		t.Fatalf("netTraffic(lo) = %d, %d", rx, tx)
	}
	if tcp, udp := countProcNetConnections(); tcp < 0 || udp < 0 {
		t.Fatalf("connection counts = %d, %d", tcp, udp)
	}
}

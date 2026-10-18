// Package sysinfo reproduces the upstream agent's system-information collectors
// (`app/sysinfo.go`: GetBasicSysInfo, GetRealtimeSysInfo, Get10SecSysInfo).
//
// Upstream uses github.com/shirou/gopsutil/v4; the replica reads the same data
// straight out of /proc and statfs so it stays dependency-free and still reports
// the identical JSON shape. The key names below were recovered from the upstream
// binary's string pool (the cluster
// `cpu_num load_1 load_5 load_15 uptime net_in net_out disk_used disk_total
//
//	disk_usage_percent traffic_in traffic_out boot_time ...`).
//
// The panel treats `sysinfo` as an opaque object and spreads it into Redis
// (`apps/backend/src/socket-io/handlers/sysinfo.ts` → `redisService.setSysinfo`),
// so the shape is agent-defined.
package sysinfo

import (
	"bufio"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Info is the agent-defined sysinfo object sent to the panel.
type Info map[string]any

var (
	mu       sync.Mutex
	lastCPU  cpuSample
	haveLast bool

	mainIfaceOnce sync.Once
	mainIface     string

	bootTimeOnce sync.Once
	bootTimeVal  int64
)

type cpuSample struct {
	idle  uint64
	total uint64
}

// GetBasicSysInfo returns the slow-moving facts: cpu count, OS, kernel,
// hostname, boot time and total disk/memory figures.
func GetBasicSysInfo() Info {
	info := Info{}
	info["cpu_num"] = cpuCount()
	info["os"] = osName()
	info["platform"] = osName()
	info["kernel"] = kernelVersion()
	info["arch"] = goArch()
	if h, err := os.Hostname(); err == nil {
		info["hostname"] = h
	}
	info["boot_time"] = bootTime()
	info["disk_total"], info["disk_used"], info["disk_usage_percent"] = diskUsage("/")
	if total, avail := memInfo(); total > 0 {
		info["mem_total"] = total
		info["mem_used"] = total - avail
		info["mem_usage_percent"] = round2(float64(total-avail) / float64(total) * 100)
	}
	return info
}

// GetRealtimeSysInfo returns the fast-moving counters: CPU%, load averages,
// uptime, per-interval network traffic and connection counts.
// netDelta tracks the previous counter sample so GetRealtimeSysInfo can report
// per-interval traffic the way upstream's realtime collector does.
var (
	netDeltaMu sync.Mutex
	prevRx     uint64
	prevTx     uint64
	prevValid  bool
	sessionRx  uint64
	sessionTx  uint64
)

func GetRealtimeSysInfo() Info {
	info := Info{}
	info["cpu_usage_percent"] = round2(cpuUsage() * 100)
	l1, l5, l15 := loadAvg()
	info["load_1"] = l1
	info["load_5"] = l5
	info["load_15"] = l15
	info["uptime"] = uptime()

	rx, tx := netTraffic(mainInterface())
	netDeltaMu.Lock()
	var dRx, dTx uint64
	if prevValid {
		if rx >= prevRx {
			dRx = rx - prevRx
		}
		if tx >= prevTx {
			dTx = tx - prevTx
		}
	}
	prevRx, prevTx, prevValid = rx, tx, true
	sessionRx += dRx
	sessionTx += dTx
	monthRx, monthTx := sessionRx, sessionTx
	netDeltaMu.Unlock()

	// net_* is the traffic of the last interval, traffic_* the running total.
	// Upstream takes traffic_month_* from vnstat; without vnstat the replica
	// reports the since-start total (see docs/AGENT.md).
	info["net_in"] = dRx
	info["net_out"] = dTx
	info["traffic_in"] = monthRx
	info["traffic_out"] = monthTx
	info["traffic_month_in"] = monthRx
	info["traffic_month_out"] = monthTx

	tcp, udp := countProcNetConnections()
	info["tcp_connections"] = tcp
	info["udp_connections"] = udp

	if total, avail := memInfo(); total > 0 {
		info["memory_total"] = total
		info["memory_used"] = total - avail
		info["memory_usage_percent"] = round2(float64(total-avail) / float64(total) * 100)
	}
	dt, du, dp := diskUsage("/")
	info["disk_total"], info["disk_used"], info["disk_usage_percent"] = dt, du, dp
	info["process_num"] = processCount()
	if rss, err := selfRSS(); err == nil {
		info["program_memory"] = rss
	}
	return info
}

// Get10SecSysInfo is the heartbeat payload the agent emits every 10s in the
// upstream scheduler: realtime counters plus the basic facts the scheduler only
// refreshes occasionally.
func Get10SecSysInfo() Info {
	info := GetBasicSysInfo()
	for k, v := range GetRealtimeSysInfo() {
		info[k] = v
	}
	info["reconnect"] = false
	return info
}

// processCount counts the numeric entries of /proc (upstream reports the same
// figure as `process_num`).
func processCount() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(e.Name()); err == nil {
			n++
		}
	}
	return n
}

// CPUUsage returns the CPU busy ratio in [0,1] since the previous call.
func CPUUsage() float64 { return cpuUsage() }

func cpuUsage() float64 {
	s, err := readCPU()
	if err != nil {
		return 0
	}
	mu.Lock()
	defer mu.Unlock()
	if !haveLast {
		lastCPU = s
		haveLast = true
		return 0
	}
	dTotal := float64(s.total - lastCPU.total)
	dIdle := float64(s.idle - lastCPU.idle)
	lastCPU = s
	if dTotal <= 0 {
		return 0
	}
	u := (dTotal - dIdle) / dTotal
	if u < 0 {
		u = 0
	}
	if u > 1 {
		u = 1
	}
	return round2(u * 100)
}

func readCPU() (cpuSample, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		var total, idle uint64
		for i, f := range fields {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				continue
			}
			total += v
			if i == 3 || i == 4 { // idle + iowait
				idle += v
			}
		}
		return cpuSample{idle: idle, total: total}, sc.Err()
	}
	return cpuSample{}, sc.Err()
}

func cpuCount() int {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "processor") {
			n++
		}
	}
	if n == 0 {
		if v := runtimeNumCPU(); v > 0 {
			return v
		}
	}
	return n
}

func loadAvg() (float64, float64, float64) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0
	}
	f := strings.Fields(string(b))
	parse := func(i int) float64 {
		if i >= len(f) {
			return 0
		}
		v, _ := strconv.ParseFloat(f[i], 64)
		return round2(v)
	}
	return parse(0), parse(1), parse(2)
}

func uptime() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return int64(v)
}

func bootTime() int64 {
	bootTimeOnce.Do(func() {
		b, err := os.ReadFile("/proc/stat")
		if err != nil {
			bootTimeVal = time.Now().Unix() - uptime()
			return
		}
		sc := bufio.NewScanner(strings.NewReader(string(b)))
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "btime ") {
				v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "btime")), 10, 64)
				if err == nil {
					bootTimeVal = v
					return
				}
			}
		}
		bootTimeVal = time.Now().Unix() - uptime()
	})
	return bootTimeVal
}

func memInfo() (totalKB, availableKB uint64) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			totalKB = v
		case "MemAvailable:":
			availableKB = v
		}
	}
	return totalKB * 1024, availableKB * 1024
}

// diskUsage returns total, used bytes and used percentage for the filesystem
// backing path.
func diskUsage(path string) (total, used uint64, percent float64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0
	}
	bs := uint64(st.Bsize)
	total = st.Blocks * bs
	free := st.Bavail * bs
	if total > 0 {
		used = total - free
		percent = round2(float64(used) / float64(total) * 100)
	}
	return total, used, percent
}

// mainInterface picks the interface carrying the default route, falling back to
// the busiest non-loopback interface (upstream caches the same choice in
// `cachedMainInterface`).
func mainInterface() string {
	mainIfaceOnce.Do(func() {
		mainIface = detectMainInterface()
	})
	return mainIface
}

func detectMainInterface() string {
	if b, err := os.ReadFile("/proc/net/route"); err == nil {
		for _, line := range strings.Split(string(b), "\n")[1:] {
			f := strings.Fields(line)
			if len(f) < 4 {
				continue
			}
			// Destination 00000000 == default route.
			if f[1] == "00000000" && f[2] != "00000000" {
				return f[0]
			}
		}
	}
	return busiestInterface()
}

func busiestInterface() string {
	counters := readNetDev()
	best := ""
	var bestBytes uint64
	for name, c := range counters {
		if name == "lo" {
			continue
		}
		if sum := c.rx + c.tx; sum > bestBytes {
			bestBytes = sum
			best = name
		}
	}
	return best
}

// MainInterface reports the cached interface selection.
func MainInterface() string { return mainInterface() }

type netCounter struct{ rx, tx uint64 }

func readNetDev() map[string]netCounter {
	out := map[string]netCounter{}
	b, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		f := strings.Fields(line[i+1:])
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		out[name] = netCounter{rx: rx, tx: tx}
	}
	return out
}

func netTraffic(iface string) (rx, tx uint64) {
	counters := readNetDev()
	if c, ok := counters[iface]; ok {
		return c.rx, c.tx
	}
	for name, c := range counters {
		if name == "lo" {
			continue
		}
		rx += c.rx
		tx += c.tx
	}
	return rx, tx
}

// countProcNetConnections counts sockets in /proc/net/tcp{,6} and
// /proc/net/udp{,6} (upstream `countProcNetConnections`).
func countProcNetConnections() (tcp, udp int) {
	tcp = countNetFile("/proc/net/tcp") + countNetFile("/proc/net/tcp6")
	udp = countNetFile("/proc/net/udp") + countNetFile("/proc/net/udp6")
	return tcp, udp
}

func countNetFile(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		if strings.TrimSpace(sc.Text()) != "" {
			n++
		}
	}
	return n
}

func selfRSS() (uint64, error) {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, err
	}
	f := strings.Fields(string(b))
	if len(f) < 2 {
		return 0, nil
	}
	pages, err := strconv.ParseUint(f[1], 10, 64)
	if err != nil {
		return 0, err
	}
	return pages * uint64(os.Getpagesize()), nil
}

// SelfRSS reports the agent's own resident set size in bytes.
func SelfRSS() uint64 {
	v, _ := selfRSS()
	return v
}

func osName() string {
	if b, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return "linux"
}

func kernelVersion() string {
	if b, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

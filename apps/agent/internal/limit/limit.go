// Package limit enforces the panel's gost connection and traffic limiters.
//
// A climiter entry "$ N" is N concurrent connections from one client IP.
// A limiter entry "$ 1MB 1MB" is a per-IP byte rate; the first size is the
// rate and the panel sets both numbers to bandwidth/8. A missing "$" applies
// the same numbers to the whole service. Zero means unlimited.
package limit

import (
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Gate is safe for concurrent use. A nil Gate allows everything.
type Gate struct {
	perIPConns  int
	globalConns int
	perIPRate   int64
	globalRate  int64

	mu      sync.Mutex
	conns   map[string]int
	total   int
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
	rate   float64
}

// ParseConn reads a climiter list. "$ 10" is per IP. "10" is global.
func ParseConn(limits []string) (perIP, global int) {
	for _, raw := range limits {
		scope, fields := split(raw)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.Atoi(fields[0])
		if err != nil || n <= 0 {
			continue
		}
		if scope == "$" {
			perIP = n
		} else {
			global = n
		}
	}
	return perIP, global
}

// ParseRate reads a traffic limiter list. The first size is bytes per second.
func ParseRate(limits []string) (perIP, global int64) {
	for _, raw := range limits {
		scope, fields := split(raw)
		if len(fields) == 0 {
			continue
		}
		n, ok := parseSize(fields[0])
		if !ok || n <= 0 {
			continue
		}
		if scope == "$" {
			perIP = n
		} else {
			global = n
		}
	}
	return perIP, global
}

// New returns nil when every cap is unlimited.
func New(perIPConns, globalConns int, perIPRate, globalRate int64) *Gate {
	if perIPConns <= 0 && globalConns <= 0 && perIPRate <= 0 && globalRate <= 0 {
		return nil
	}
	return &Gate{
		perIPConns:  perIPConns,
		globalConns: globalConns,
		perIPRate:   perIPRate,
		globalRate:  globalRate,
		conns:       map[string]int{},
		buckets:     map[string]*bucket{},
	}
}

// Enter reports whether addr may open another connection.
func (g *Gate) Enter(addr net.Addr) bool {
	if g == nil {
		return true
	}
	key := ipKey(addr)
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.globalConns > 0 && g.total >= g.globalConns {
		return false
	}
	if g.perIPConns > 0 && g.conns[key] >= g.perIPConns {
		return false
	}
	g.conns[key]++
	g.total++
	return true
}

// Leave releases the connection taken by Enter.
func (g *Gate) Leave(addr net.Addr) {
	if g == nil {
		return
	}
	key := ipKey(addr)
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.conns[key] > 0 {
		g.conns[key]--
		if g.conns[key] == 0 {
			delete(g.conns, key)
		}
	}
	if g.total > 0 {
		g.total--
	}
}

// Wait delays until n bytes are allowed by the rate. It returns immediately
// when there is no rate. now is injectable so tests do not sleep.
func (g *Gate) Wait(addr net.Addr, n int) {
	if g == nil || n <= 0 {
		return
	}
	for {
		d := g.reserve(addr, n, time.Now())
		if d <= 0 {
			return
		}
		time.Sleep(d)
	}
}

func (g *Gate) reserve(addr net.Addr, n int, now time.Time) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	var wait time.Duration
	if g.perIPRate > 0 {
		wait = g.take(ipKey(addr), g.perIPRate, n, now)
	}
	if g.globalRate > 0 {
		if d := g.take("*", g.globalRate, n, now); d > wait {
			wait = d
		}
	}
	return wait
}

func (g *Gate) take(key string, rate int64, n int, now time.Time) time.Duration {
	b := g.buckets[key]
	if b == nil {
		b = &bucket{tokens: float64(rate), last: now, rate: float64(rate)}
		g.buckets[key] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * b.rate
		if b.tokens > b.rate {
			b.tokens = b.rate
		}
		b.last = now
	}
	need := float64(n)
	if b.tokens >= need {
		b.tokens -= need
		return 0
	}
	short := need - b.tokens
	b.tokens = 0
	b.last = now
	return time.Duration(short / b.rate * float64(time.Second))
}

func split(raw string) (scope string, fields []string) {
	f := strings.Fields(strings.TrimSpace(raw))
	if len(f) == 0 {
		return "", nil
	}
	if f[0] == "$" {
		return "$", f[1:]
	}
	return "", f
}

func parseSize(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ToUpper(s))
	mult := int64(1)
	switch {
	case strings.HasSuffix(s, "GB"):
		mult = 1024 * 1024 * 1024
		s = strings.TrimSuffix(s, "GB")
	case strings.HasSuffix(s, "MB"):
		mult = 1024 * 1024
		s = strings.TrimSuffix(s, "MB")
	case strings.HasSuffix(s, "KB"):
		mult = 1024
		s = strings.TrimSuffix(s, "KB")
	case strings.HasSuffix(s, "B"):
		s = strings.TrimSuffix(s, "B")
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return int64(n * float64(mult)), true
}

// NewReader charges bytes read from r against the gate. A nil gate returns r.
func NewReader(r io.Reader, g *Gate, addr net.Addr) io.Reader {
	if g == nil || r == nil {
		return r
	}
	return &limitedReader{r: r, g: g, addr: addr}
}

type limitedReader struct {
	r    io.Reader
	g    *Gate
	addr net.Addr
}

func (l *limitedReader) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	if n > 0 {
		l.g.Wait(l.addr, n)
	}
	return n, err
}

func ipKey(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return addr.String()
	}
	return host
}

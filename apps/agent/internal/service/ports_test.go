package service

import (
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/relayx/agent/internal/gostcfg"
)

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

// freePortAbove returns the first free TCP port above min, so a candidate range
// is always well-formed (start <= end) and the occupied port is first.
func freePortAbove(t *testing.T, min int) int {
	t.Helper()
	for port := min + 1; port < 65535; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			_ = ln.Close()
			return port
		}
	}
	t.Fatalf("no free port above %d", min)
	return 0
}

func TestOccupiedPortIsReportedAndRetried(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	takenPort := occupied.Addr().(*net.TCPAddr).Port
	nextPort := freePortAbove(t, takenPort)

	// A single fixed port that is taken fails with the port-in-use marker.
	doc := fmt.Sprintf(`{"services":[{"name":"tcp-1","addr":"127.0.0.1:%d",
		"handler":{"type":"tcp"},"listener":{"type":"tcp"},
		"forwarder":{"nodes":[{"name":"n","addr":"127.0.0.1:9","metadata":{"weight":"1"}}],"selector":{"strategy":"round"}}}]}`, takenPort)
	cfg, err := gostcfg.Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	res := m.Apply(cfg)[0]
	if res.Err == nil {
		t.Fatalf("occupied port accepted: %+v", res)
	}
	if !res.IsPortInUse() {
		t.Fatalf("IsPortInUse = false for %v", res.Err)
	}

	// With a candidate list the manager moves on to the next free port.
	doc = fmt.Sprintf(`{"services":[{"name":"tcp-1","addr":"127.0.0.1:WAIT_LISTEN%d-%d",
		"handler":{"type":"tcp"},"listener":{"type":"tcp"},
		"forwarder":{"nodes":[{"name":"n","addr":"127.0.0.1:9","metadata":{"weight":"1"}}],"selector":{"strategy":"round"}}}]}`, takenPort, nextPort)
	cfg, err = gostcfg.Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	m2 := New(Options{})
	defer m2.Close()
	res = m2.Apply(cfg)[0]
	if !res.OK() {
		t.Fatalf("retry failed: %+v", res)
	}
	if res.Port == takenPort {
		t.Fatalf("bound the occupied port %d", res.Port)
	}
}

func TestUnusableAddressFails(t *testing.T) {
	doc := `{"services":[{"name":"tcp-1","addr":"127.0.0.1:WAIT_LISTEN",
		"handler":{"type":"tcp"},"listener":{"type":"tcp"},
		"forwarder":{"nodes":[],"selector":{"strategy":"round"}}}]}`
	cfg, err := gostcfg.Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	res := m.Apply(cfg)[0]
	if res.Err == nil || !strings.Contains(res.Err.Error(), "no usable port") {
		t.Fatalf("result = %+v", res)
	}
	if len(m.Active()) != 0 {
		t.Fatalf("active = %+v", m.Active())
	}
}

func TestManagerCloseWithoutServices(t *testing.T) {
	m := New(Options{})
	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(m.Active()) != 0 {
		t.Fatalf("active = %+v", m.Active())
	}
	if events := m.ObserveEvents(); len(events) != 0 {
		t.Fatalf("events = %+v", events)
	}
	// Close is idempotent.
	if err := m.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

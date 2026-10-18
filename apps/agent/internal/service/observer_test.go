package service

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/gostcfg"
)

func TestObserveEventsDelta(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, _ := c.Read(buf)
				_, _ = c.Write(buf[:n])
			}(c)
		}
	}()

	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := probe.Addr().String()
	probe.Close()

	body := `{
		"services": [{
			"name": "tcp-7",
			"addr": "` + addr + `",
			"handler": {"type": "tcp"},
			"listener": {"type": "tcp"},
			"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]},
			"observer": "observer",
			"metadata": {"enableStats": true, "observer.resetTraffic": true, "observer.period": "30s"}
		}, {
			"name": "tcp-8",
			"addr": "127.0.0.1:0",
			"handler": {"type": "tcp"},
			"listener": {"type": "tcp"}
		}]
	}`
	cfg, err := gostcfg.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Services[0].StatsPeriod() != 30*time.Second || !cfg.Services[0].ResetTraffic() {
		t.Fatalf("period/reset: %s %v", cfg.Services[0].StatsPeriod(), cfg.Services[0].ResetTraffic())
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() {
		t.Fatalf("apply: %+v", results)
	}

	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(c, "hello-stats"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(buf); err != nil {
		t.Fatal(err)
	}
	c.Close()

	deadline := time.Now().Add(3 * time.Second)
	var in, out uint64
	for time.Now().Before(deadline) {
		events := m.ObserveEvents()
		if len(events) != 1 || events[0].Service != "tcp-7" || events[0].Stats == nil {
			t.Fatalf("events: %+v", events)
		}
		in, out = events[0].Stats.InputBytes, events[0].Stats.OutputBytes
		if in > 0 && out > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if in == 0 || out == 0 {
		t.Fatalf("expected bytes, got in=%d out=%d", in, out)
	}
	again := m.ObserveEvents()
	if again[0].Stats.InputBytes != 0 || again[0].Stats.OutputBytes != 0 {
		t.Fatalf("reset did not clear counters: %+v", again[0].Stats)
	}
}

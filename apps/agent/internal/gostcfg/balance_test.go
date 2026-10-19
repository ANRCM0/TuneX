package gostcfg

import (
	"fmt"
	"net"
	"testing"
	"time"
)

func balancer(strategy string, nodes ...Node) *Balancer {
	cfg := &Config{Services: []Service{{
		Forwarder: &Forwarder{
			Selector: []byte(`{"strategy":"` + strategy + `"}`),
			Nodes:    nodes,
		},
	}}}
	return cfg.NewBalancer(&cfg.Services[0])
}

func addr(port int) net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: port}
}

func TestRoundRobinWeight(t *testing.T) {
	b := balancer("round",
		Node{Addr: "127.0.0.1:1", Metadata: map[string]any{"weight": "2"}},
		Node{Addr: "127.0.0.1:2", Metadata: map[string]any{"weight": "1"}},
	)
	var got []string
	for i := 0; i < 3; i++ {
		a, _ := b.Next(addr(i))
		got = append(got, a)
	}
	if got[0] != "127.0.0.1:1" || got[1] != "127.0.0.1:1" || got[2] != "127.0.0.1:2" {
		t.Fatalf("round %v", got)
	}
}

func TestStrategyAliases(t *testing.T) {
	nodes := []Node{{Addr: "127.0.0.1:1"}, {Addr: "127.0.0.1:2"}}
	for _, name := range []string{"rr", "ha", "no-such", "parallel"} {
		b := balancer(name, nodes...)
		if b.strategy != "round" {
			t.Fatalf("%s -> %s", name, b.strategy)
		}
		a, _ := b.Next(addr(1))
		c, _ := b.Next(addr(2))
		if a == c {
			t.Fatalf("%s did not rotate: %s", name, a)
		}
	}
	if balancer("random", nodes...).strategy != "rand" {
		t.Fatal("random")
	}
	if balancer("leastconn", nodes...).strategy != "lc" {
		t.Fatal("leastconn")
	}
	if balancer("leastlatency", nodes...).strategy != "ll" {
		t.Fatal("leastlatency")
	}
	lat := balancer("leastlatency", nodes...)
	lat.Observe("127.0.0.1:1", time.Second)
	lat.Observe("127.0.0.1:2", time.Millisecond)
	if got, _ := lat.Next(addr(1)); got != "127.0.0.1:2" {
		t.Fatalf("leastlatency %s", got)
	}
	empty := newBalancer(nil, nodes)
	a, _ := empty.Next(addr(1))
	c, _ := empty.Next(addr(2))
	if empty.strategy != "round" || a == c {
		t.Fatalf("empty %s %s %s", empty.strategy, a, c)
	}
}

func TestFifoSkipsBackup(t *testing.T) {
	b := balancer("fifo",
		Node{Addr: "127.0.0.1:9", Metadata: map[string]any{"backup": true}},
		Node{Addr: "127.0.0.1:1"},
		Node{Addr: "127.0.0.1:2"},
	)
	a, _ := b.Next(addr(1))
	if a != "127.0.0.1:1" {
		t.Fatalf("fifo %s", a)
	}
}

func TestHashSticks(t *testing.T) {
	b := balancer("hash", Node{Addr: "127.0.0.1:1"}, Node{Addr: "127.0.0.1:2"})
	a, _ := b.Next(addr(1))
	b2, _ := b.Next(addr(99))
	if a != b2 {
		t.Fatalf("hash moved %s -> %s", a, b2)
	}
}

func TestChainRound(t *testing.T) {
	cfg := &Config{
		Chains: []Chain{{
			Parent: Parent{Name: "c"},
			Hops: []Hop{{
				Selector: []byte(`{"strategy":"round"}`),
				Nodes: []Node{
					{Addr: "10.0.0.1:1", Connector: &Parent{Type: "relay"}},
					{Addr: "10.0.0.2:1", Connector: &Parent{Type: "relay"}},
				},
			}},
		}},
		Services: []Service{{
			Handler: &Parent{Chain: "c"},
			Forwarder: &Forwarder{
				Selector: []byte(`{"strategy":"fifo"}`),
				Nodes:    []Node{{Addr: "127.0.0.1:9"}, {Addr: "127.0.0.1:8"}},
			},
		}},
	}
	r := cfg.NewChainRoute(&cfg.Services[0])
	if r == nil {
		t.Fatal("expected a chain route")
	}
	client := addr(1)
	a, ta, _ := r.Next(client, "")
	b, tb, _ := r.Next(client, "")
	if len(a) != 1 || len(b) != 1 || a[0].Addr != "10.0.0.1:1" || b[0].Addr != "10.0.0.2:1" {
		t.Fatalf("hops %v %v", a, b)
	}
	if a[0].Connector != "relay" || ta != "127.0.0.1:9" || tb != "127.0.0.1:9" {
		t.Fatalf("connector %s targets %s %s", a[0].Connector, ta, tb)
	}
}

func TestPlainForwardSkipsHostFilter(t *testing.T) {
	cfg := &Config{Services: []Service{{
		Forwarder: &Forwarder{Nodes: []Node{
			{Addr: "10.0.0.1:1", Filter: []byte(`{"host":"a.com"}`)},
			{Addr: "10.0.0.2:1"},
		}},
	}}}
	got := cfg.Targets(&cfg.Services[0])
	if len(got) != 1 || got[0] != "10.0.0.2:1" {
		t.Fatalf("targets %v", got)
	}
	if cfg.NewBalancer(&cfg.Services[0]) != nil {
		t.Fatal("one remaining node should not need a balancer")
	}
}

func TestFilterHost(t *testing.T) {
	cfg := &Config{
		Chains: []Chain{{
			Parent: Parent{Name: "c"},
			Hops: []Hop{{
				Selector: []byte(`{"strategy":"round"}`),
				Nodes: []Node{
					{Addr: "10.0.0.1:1", Connector: &Parent{Type: "relay"}, Filter: []byte(`{"host":"*.example.com"}`)},
					{Addr: "10.0.0.2:1", Connector: &Parent{Type: "relay"}},
					{Addr: "10.0.0.3:1", Connector: &Parent{Type: "relay"}, Filter: []byte(`{"host":"other.test"}`)},
				},
			}},
		}},
		Services: []Service{{Handler: &Parent{Chain: "c"}}},
	}
	r := cfg.NewChainRoute(&cfg.Services[0])
	if r == nil {
		t.Fatal("expected a chain route")
	}
	a, _, _ := r.Next(addr(1), "a.example.com")
	b, _, _ := r.Next(addr(1), "other.test")
	c, _, _ := r.Next(addr(1), "no-match.invalid")
	if len(a) != 1 || a[0].Addr != "10.0.0.1:1" {
		t.Fatalf("wildcard hop %v", a)
	}
	if len(b) != 1 || b[0].Addr != "10.0.0.3:1" {
		t.Fatalf("exact hop %v", b)
	}
	if len(c) != 1 || c[0].Addr != "10.0.0.2:1" {
		t.Fatalf("fallback hop %v", c)
	}
}

func TestHashUsesDestHost(t *testing.T) {
	b := balancer("hash", Node{Addr: "10.0.0.1:1"}, Node{Addr: "10.0.0.2:1"})
	a, _ := b.NextAmong(addr(1), "a.example.com:80", b.order)
	same, _ := b.NextAmong(addr(9), "a.example.com:443", b.order)
	if a != same {
		t.Fatalf("same host should stick: %s %s", a, same)
	}
	moved := false
	for i := 0; i < 64; i++ {
		got, _ := b.NextAmong(addr(1), fmt.Sprintf("h%d.example.com", i), b.order)
		if got != a {
			moved = true
			break
		}
	}
	if !moved {
		t.Fatal("hash never left the first node")
	}
}

func TestFilterHostKeepsStrategy(t *testing.T) {
	cfg := &Config{
		Chains: []Chain{{
			Parent: Parent{Name: "c"},
			Hops: []Hop{{
				Selector: []byte(`{"strategy":"fifo"}`),
				Nodes: []Node{
					{Addr: "10.1.0.1:1", Connector: &Parent{Type: "relay"}, Filter: []byte(`{"host":"*.example.com"}`)},
					{Addr: "10.1.0.2:1", Connector: &Parent{Type: "relay"}, Filter: []byte(`{"host":"*.example.com"}`)},
					{Addr: "10.1.0.3:1", Connector: &Parent{Type: "relay"}},
				},
			}},
		}},
		Services: []Service{{Handler: &Parent{Chain: "c"}}},
	}
	r := cfg.NewChainRoute(&cfg.Services[0])
	a, _, _ := r.Next(addr(1), "a.example.com")
	b, _, _ := r.Next(addr(2), "b.example.com")
	if a[0].Addr != "10.1.0.1:1" || b[0].Addr != "10.1.0.1:1" {
		t.Fatalf("fifo inside the filter %s %s", a[0].Addr, b[0].Addr)
	}
}

func TestLeastConnections(t *testing.T) {
	b := balancer("lc", Node{Addr: "127.0.0.1:1"}, Node{Addr: "127.0.0.1:2"})
	first, done := b.Next(addr(1))
	second, _ := b.Next(addr(2))
	if first != "127.0.0.1:1" || second != "127.0.0.1:2" {
		t.Fatalf("lc %s %s", first, second)
	}
	done()
	third, _ := b.Next(addr(3))
	if third != "127.0.0.1:1" {
		t.Fatalf("lc after release %s", third)
	}
}

func TestLeastLatency(t *testing.T) {
	b := balancer("ll", Node{Addr: "slow:1"}, Node{Addr: "fast:1"})
	if got, _ := b.Next(nil); got != "slow:1" {
		t.Fatalf("unmeasured %s", got)
	}
	b.Observe("slow:1", 50*time.Millisecond)
	if got, _ := b.Next(nil); got != "fast:1" {
		t.Fatalf("probe next %s", got)
	}
	b.Observe("fast:1", 5*time.Millisecond)
	if got, _ := b.Next(nil); got != "fast:1" {
		t.Fatalf("faster %s", got)
	}
	b.Observe("fast:1", 200*time.Millisecond)
	if got, _ := b.Next(nil); got != "slow:1" {
		t.Fatalf("after slowdown %s", got)
	}
}

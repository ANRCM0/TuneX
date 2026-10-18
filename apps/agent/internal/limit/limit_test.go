package limit

import (
	"net"
	"testing"
	"time"
)

func TestPerIPConnections(t *testing.T) {
	perIP, global := ParseConn([]string{"$ 1"})
	g := New(perIP, global, 0, 0)
	a := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 1}
	b := &net.TCPAddr{IP: net.ParseIP("192.0.2.2"), Port: 1}
	if !g.Enter(a) || g.Enter(a) {
		t.Fatal("second connection from the same IP should be refused")
	}
	if !g.Enter(b) {
		t.Fatal("a different IP should be allowed")
	}
	g.Leave(a)
	if !g.Enter(a) {
		t.Fatal("leaving should free the slot")
	}
}

func TestRate(t *testing.T) {
	perIP, global := ParseRate([]string{"$ 1MB 1MB"})
	if perIP != 1024*1024 || global != 0 {
		t.Fatalf("rate perIP=%d global=%d", perIP, global)
	}
	g := New(0, 0, 100, 0)
	addr := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 9}
	start := time.Now()
	g.Wait(addr, 100)
	g.Wait(addr, 100)
	if time.Since(start) < 500*time.Millisecond {
		t.Fatal("the second 100 bytes at 100 B/s returned too soon")
	}
}

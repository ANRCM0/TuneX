package service

import (
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/limit"
)

func TestOpenVPNGateRejects(t *testing.T) {
	g := limit.New(1, 0, 0, 0)
	a, b := net.Pipe()
	defer b.Close()
	if !g.Enter(a.RemoteAddr()) {
		t.Fatal("enter")
	}
	ov := &ovpnListener{gate: g}
	done := make(chan struct{})
	go func() {
		ov.serve(a)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("serve blocked on a full gate")
	}
	g.Leave(a.RemoteAddr())
}

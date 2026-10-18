package forward

import (
	"net"
	"testing"
	"time"
)

func TestUDPReapIdle(t *testing.T) {
	pc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	s := &UDPServer{
		Idle:    50 * time.Millisecond,
		clients: map[string]*udpSession{},
	}
	s.clients["a"] = &udpSession{conn: pc, lastSeen: time.Now().Add(-time.Second)}
	if n := s.reapOnce(time.Now()); n != 1 {
		t.Fatalf("reaped %d", n)
	}
	if len(s.clients) != 0 {
		t.Fatal("session remained")
	}
}

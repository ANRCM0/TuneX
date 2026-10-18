package admit

import (
	"net"
	"testing"
)

func TestWhitelistAndCIDR(t *testing.T) {
	l := Parse([]string{"10.0.0.0/8", "192.0.2.1"}, true)
	if !l.Allow(&net.TCPAddr{IP: net.ParseIP("10.1.2.3"), Port: 1}) {
		t.Fatal("cidr member rejected")
	}
	if !l.Allow(&net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 9}) {
		t.Fatal("exact ip rejected")
	}
	if l.Allow(&net.TCPAddr{IP: net.ParseIP("192.0.2.2"), Port: 9}) {
		t.Fatal("outsider allowed")
	}
	black := Parse([]string{"192.0.2.2"}, false)
	if black.Allow(&net.TCPAddr{IP: net.ParseIP("192.0.2.2"), Port: 1}) {
		t.Fatal("blacklist member allowed")
	}
	if !black.Allow(&net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: 1}) {
		t.Fatal("blacklist outsider rejected")
	}
	if Parse(nil, true) != nil {
		t.Fatal("empty list should be nil")
	}
}

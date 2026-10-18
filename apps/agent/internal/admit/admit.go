// Package admit enforces the panel's gost admission list.
//
// A service names an admission. The list is a whitelist when Whitelist is
// set, otherwise a blacklist. Matchers are IP addresses or CIDRs.
package admit

import (
	"net"
	"strings"
)

// List is a parsed admission.
type List struct {
	whitelist bool
	nets      []*net.IPNet
	ips       []net.IP
}

// Parse builds a list. It returns nil when there is nothing to match, so
// callers can skip the check.
func Parse(matchers []string, whitelist bool) *List {
	if len(matchers) == 0 {
		return nil
	}
	l := &List{whitelist: whitelist}
	for _, raw := range matchers {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if strings.Contains(s, "/") {
			_, n, err := net.ParseCIDR(s)
			if err == nil {
				l.nets = append(l.nets, n)
			}
			continue
		}
		if ip := net.ParseIP(s); ip != nil {
			l.ips = append(l.ips, ip)
		}
	}
	if len(l.nets) == 0 && len(l.ips) == 0 {
		return nil
	}
	return l
}

// Allow reports whether addr may pass. A nil list allows everything.
func (l *List) Allow(addr net.Addr) bool {
	if l == nil {
		return true
	}
	ip := addrIP(addr)
	if ip == nil {
		return !l.whitelist
	}
	hit := l.match(ip)
	if l.whitelist {
		return hit
	}
	return !hit
}

func (l *List) match(ip net.IP) bool {
	for _, known := range l.ips {
		if known.Equal(ip) {
			return true
		}
	}
	for _, n := range l.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func addrIP(addr net.Addr) net.IP {
	if addr == nil {
		return nil
	}
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return net.ParseIP(addr.String())
	}
	return net.ParseIP(host)
}

// Wrap rejects accepted connections that allow refuses. A nil allow returns
// ln unchanged. Rejected connections are closed and not returned.
func Wrap(ln net.Listener, allow func(net.Addr) bool) net.Listener {
	if allow == nil || ln == nil {
		return ln
	}
	return &filter{Listener: ln, allow: allow}
}

type filter struct {
	net.Listener
	allow func(net.Addr) bool
}

func (f *filter) Accept() (net.Conn, error) {
	for {
		c, err := f.Listener.Accept()
		if err != nil || f.allow(c.RemoteAddr()) {
			return c, err
		}
		_ = c.Close()
	}
}

// Package bypass enforces the panel's gost bypass list.
//
// Contains reports that a destination should not be proxied. A blacklist
// matches the listed addresses. A whitelist matches everything else. A nil
// list proxies every destination.
package bypass

import (
	"net"
	"strings"
)

// List is a parsed bypass.
type List struct {
	whitelist bool
	rules     []rule
}

type rule struct {
	cidr   *net.IPNet
	ip     net.IP
	host   string
	port   string
	suffix bool
	glob   bool
}

// Parse builds a list. It returns nil when nothing usable was listed.
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
		host, port := splitHost(s)
		r := rule{host: strings.ToLower(host), port: port}
		if strings.Contains(host, "/") {
			if _, n, err := net.ParseCIDR(host); err == nil {
				r.cidr = n
			}
		} else if ip := net.ParseIP(host); ip != nil {
			r.ip = ip
		} else if strings.HasPrefix(host, ".") {
			r.suffix = true
			r.host = strings.ToLower(host)
		} else if strings.Contains(host, "*") {
			r.glob = true
		}
		if r.cidr == nil && r.ip == nil && r.host == "" {
			continue
		}
		l.rules = append(l.rules, r)
	}
	if len(l.rules) == 0 {
		return nil
	}
	return l
}

// Contains reports whether addr (host or host:port) must not be proxied.
func (l *List) Contains(addr string) bool {
	if l == nil {
		return false
	}
	matched := l.hit(addr)
	if l.whitelist {
		return !matched
	}
	return matched
}

func (l *List) hit(addr string) bool {
	host, port := splitHost(addr)
	host = strings.ToLower(host)
	ip := net.ParseIP(host)
	for _, r := range l.rules {
		if r.port != "" && port != "" && r.port != port {
			continue
		}
		if r.cidr != nil {
			if ip != nil && r.cidr.Contains(ip) {
				return true
			}
			continue
		}
		if r.ip != nil {
			if ip != nil && r.ip.Equal(ip) {
				return true
			}
			continue
		}
		if r.suffix {
			if host == r.host[1:] || strings.HasSuffix(host, r.host) {
				return true
			}
			continue
		}
		if r.glob {
			if glob(r.host, host) {
				return true
			}
			continue
		}
		if host == r.host {
			return true
		}
	}
	return false
}

func splitHost(addr string) (host, port string) {
	if h, p, err := net.SplitHostPort(addr); err == nil {
		return h, p
	}
	return addr, ""
}

func glob(pattern, host string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == host
	}
	if !strings.HasPrefix(host, parts[0]) {
		return false
	}
	host = host[len(parts[0]):]
	for i := 1; i < len(parts)-1; i++ {
		n := strings.Index(host, parts[i])
		if n < 0 {
			return false
		}
		host = host[n+len(parts[i]):]
	}
	return strings.HasSuffix(host, parts[len(parts)-1])
}

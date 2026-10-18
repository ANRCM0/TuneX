package gostcfg

import (
	"encoding/json"
	"strings"
	"time"
)

// HTTPObserver is one gost HTTP observer plugin. The panel points it at
// SITE_URL/api/tunnel/observer.
type HTTPObserver struct {
	Name string
	URL  string
}

type observerDoc struct {
	Name   string `json:"name"`
	Plugin struct {
		Type string `json:"type"`
		Addr string `json:"addr"`
	} `json:"plugin"`
}

// HTTPObservers returns the http observer plugins in the document.
// An address without a scheme gets "http://", matching go-gost.
func (c *Config) HTTPObservers() []HTTPObserver {
	if c == nil || len(c.Observers) == 0 {
		return nil
	}
	var docs []observerDoc
	if err := json.Unmarshal(c.Observers, &docs); err != nil {
		return nil
	}
	var out []HTTPObserver
	for _, d := range docs {
		if !strings.EqualFold(d.Plugin.Type, "http") || d.Plugin.Addr == "" {
			continue
		}
		addr := d.Plugin.Addr
		if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
			addr = "http://" + addr
		}
		out = append(out, HTTPObserver{Name: d.Name, URL: addr})
	}
	return out
}

// StatsPeriod is how often this service should report, when it has an
// observer or enableStats. Zero means it does not report.
func (s *Service) StatsPeriod() time.Duration {
	if s == nil {
		return 0
	}
	if s.Observer == "" && !s.MetaBool("enableStats") {
		return 0
	}
	d, err := time.ParseDuration(s.MetaString("observer.period"))
	if err != nil || d <= 0 {
		d = 30 * time.Second
	}
	return d
}

// ResetTraffic reports whether each observe should send a delta and zero
// the counters. The panel bills by incrementing, so this is what it sets.
func (s *Service) ResetTraffic() bool {
	return s != nil && s.MetaBool("observer.resetTraffic")
}

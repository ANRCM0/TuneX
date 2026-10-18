// Package observe posts gost service stats to the panel's HTTP observer.
//
// The body matches go-gost/x v0.26.2 observer/plugin/http.go: a JSON object
// {"events":[{"kind":"service","service":"...","type":"stats","stats":{...}}]}.
// The panel (POST /api/tunnel/observer) bills (inputBytes+outputBytes) as a
// delta, so callers must pass bytes since the previous post when
// observer.resetTraffic is set.
package observe

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Stats is the stats object the panel validates.
type Stats struct {
	TotalConns   uint64 `json:"totalConns"`
	CurrentConns uint64 `json:"currentConns"`
	InputBytes   uint64 `json:"inputBytes"`
	OutputBytes  uint64 `json:"outputBytes"`
	TotalErrs    uint64 `json:"totalErrs"`
}

// Event is one gost observer event.
type Event struct {
	Kind    string `json:"kind"`
	Service string `json:"service"`
	Type    string `json:"type"`
	Stats   *Stats `json:"stats,omitempty"`
}

type payload struct {
	Events []Event `json:"events"`
}

type okBody struct {
	OK bool `json:"ok"`
}

// Post sends events and requires HTTP 200 with {"ok":true}.
func Post(ctx context.Context, url string, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	body, err := json.Marshal(payload{Events: events})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("observe: %s: %s", resp.Status, raw)
	}
	var ok okBody
	if err := json.Unmarshal(raw, &ok); err != nil {
		return fmt.Errorf("observe: %w", err)
	}
	if !ok.OK {
		return fmt.Errorf("observe: not ok")
	}
	return nil
}

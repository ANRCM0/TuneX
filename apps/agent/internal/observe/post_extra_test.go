package observe

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostNoEventsSkipsRequest(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	if err := Post(context.Background(), srv.URL, nil); err != nil {
		t.Fatalf("Post(nil): %v", err)
	}
	if called {
		t.Fatal("empty event list made a request")
	}
}

func TestPostFailureModes(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		wantErr string
	}{
		{name: "non-200", status: 500, body: "boom", wantErr: "500"},
		{name: "not ok", status: 200, body: `{"ok":false}`, wantErr: "not ok"},
		{name: "invalid json", status: 200, body: `nope`, wantErr: "observe:"},
	}
	events := []Event{{Kind: "service", Service: "tcp-1", Type: "stats", Stats: &Stats{}}}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()

			err := Post(context.Background(), srv.URL, events)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("err = %v, want %q", err, c.wantErr)
			}
		})
	}
}

func TestPostPayloadShape(t *testing.T) {
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("content-type = %q", ct)
		}
		body, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	events := []Event{
		{Kind: "service", Service: "tcp-1", Type: "stats", Stats: &Stats{TotalConns: 1, CurrentConns: 0, InputBytes: 10, OutputBytes: 20}},
		{Kind: "service", Service: "no-stats", Type: "stats"},
	}
	if err := Post(context.Background(), srv.URL, events); err != nil {
		t.Fatalf("Post: %v", err)
	}

	var decoded struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("body json: %v (%s)", err, body)
	}
	if len(decoded.Events) != 2 {
		t.Fatalf("events = %d", len(decoded.Events))
	}
	stats, ok := decoded.Events[0]["stats"].(map[string]any)
	if !ok {
		t.Fatalf("stats = %v", decoded.Events[0]["stats"])
	}
	if stats["inputBytes"].(float64) != 10 || stats["outputBytes"].(float64) != 20 {
		t.Fatalf("stats = %v", stats)
	}
	if _, present := decoded.Events[1]["stats"]; present {
		t.Fatalf("nil stats should be omitted: %v", decoded.Events[1])
	}
}

func TestPostCancelledContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Post(ctx, srv.URL, []Event{{Kind: "service"}}); err == nil {
		t.Fatal("cancelled request succeeded")
	}
}

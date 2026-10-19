package panel

import (
	"encoding/json"
	"fmt"
	"net"
	"testing"
)

func sessionFor(agent *Agent) *session {
	return &session{a: agent}
}

func raw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestHandlePingArguments(t *testing.T) {
	agent := newTestAgent(t)
	s := sessionFor(agent)

	if _, err := s.handlePing(nil); err == nil {
		t.Fatal("missing host accepted")
	}
	if _, err := s.handlePing([]json.RawMessage{raw(42)}); err == nil {
		t.Fatal("non-string host accepted")
	}
}

func TestHandlePingReportsResult(t *testing.T) {
	agent := newTestAgent(t)
	s := sessionFor(agent)

	reply, err := s.handlePing([]json.RawMessage{raw("127.0.0.1")})
	if err != nil {
		t.Fatalf("handlePing: %v", err)
	}
	m := reply.(map[string]any)
	if m["node_id"] != "test-node" {
		t.Fatalf("node_id = %v", m["node_id"])
	}
	results, ok := m["results"].(map[string]any)
	if !ok || len(results) != 1 {
		t.Fatalf("results = %v", m["results"])
	}
	// Either a latency number or the failure text is reported for the host.
	switch results["127.0.0.1"].(type) {
	case float64, string:
	default:
		t.Fatalf("result type = %T", results["127.0.0.1"])
	}
}

func TestHandleTest(t *testing.T) {
	agent := newTestAgent(t)
	s := sessionFor(agent)

	empty, err := s.handleTest(nil)
	if err != nil {
		t.Fatalf("handleTest(nil): %v", err)
	}
	emptyMap := empty.(map[string]any)
	if emptyMap["node_id"] != "test-node" || len(emptyMap["results"].(map[string]any)) != 0 {
		t.Fatalf("empty reply = %+v", emptyMap)
	}

	if _, err := s.handleTest([]json.RawMessage{raw("not-an-object")}); err == nil {
		t.Fatal("non-object payload accepted")
	}
}

func TestHandleTestDialsTargets(t *testing.T) {
	agent := newTestAgent(t)
	s := sessionFor(agent)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port

	payload := map[string]any{
		"127.0.0.1":    port,                              // number -> host:port
		"localhost":    "1",                               // numeric string, refused fast
		"other.test":   fmt.Sprintf("localhost:%d", port), // host:port string, live
		"bare.test":    "localhost",                       // bare host -> :80, refused fast
		"invalid.test": map[string]any{"x": 1},            // unsupported type
	}
	reply, err := s.handleTest([]json.RawMessage{raw(payload)})
	if err != nil {
		t.Fatalf("handleTest: %v", err)
	}
	results := reply.(map[string]any)["results"].(map[string]any)
	if _, ok := results["127.0.0.1"].(float64); !ok {
		t.Fatalf("live dial result = %v", results["127.0.0.1"])
	}
	if results["invalid.test"] != "invalid target" {
		t.Fatalf("invalid target result = %v", results["invalid.test"])
	}
	for _, key := range []string{"localhost", "other.test", "bare.test"} {
		if _, ok := results[key]; !ok {
			t.Fatalf("missing result for %s in %v", key, results)
		}
	}
}

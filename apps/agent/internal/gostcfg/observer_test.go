package gostcfg

import "testing"

func TestHTTPObservers(t *testing.T) {
	cfg, err := Parse([]byte(`{
		"observers": [{"name": "observer", "plugin": {"type": "http", "addr": "http://127.0.0.1:3000/api/tunnel/observer"}}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	obs := cfg.HTTPObservers()
	if len(obs) != 1 || obs[0].URL != "http://127.0.0.1:3000/api/tunnel/observer" {
		t.Fatalf("%+v", obs)
	}
	cfg, err = Parse([]byte(`{
		"observers": [{"name": "observer", "plugin": {"type": "http", "addr": "127.0.0.1:9/x"}}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	obs = cfg.HTTPObservers()
	if obs[0].URL != "http://127.0.0.1:9/x" {
		t.Fatalf("%+v", obs)
	}
}

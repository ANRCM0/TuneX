package mierux

import (
	"net"
	"testing"
)

func TestTransportSelection(t *testing.T) {
	if p, err := transport(""); err != nil || p.String() != "TCP" {
		t.Fatalf("empty = %v, %v", p, err)
	}
	if p, err := transport(" TCP "); err != nil || p.String() != "TCP" {
		t.Fatalf("tcp = %v, %v", p, err)
	}
	if p, err := transport("UDP"); err != nil || p.String() != "UDP" {
		t.Fatalf("udp = %v, %v", p, err)
	}
	if _, err := transport("sctp"); err == nil {
		t.Fatal("unknown protocol accepted")
	}
}

func TestParseUsers(t *testing.T) {
	users, err := ParseUsers(map[string]any{"alice": "secret", "bob": "hunter2"})
	if err != nil || len(users) != 2 || users["alice"] != "secret" {
		t.Fatalf("ParseUsers = %v, %v", users, err)
	}

	for _, bad := range []any{
		nil,
		map[string]any{},
		"not-a-map",
		map[string]any{"alice": 42},
		map[string]any{"alice": ""},
		map[string]any{"": "secret"},
	} {
		if _, err := ParseUsers(bad); err == nil {
			t.Fatalf("ParseUsers(%v) accepted", bad)
		}
	}
}

func TestListenValidation(t *testing.T) {
	cases := []*Server{
		{Port: 0, Users: map[string]string{"a": "b"}},
		{Port: 70000, Users: map[string]string{"a": "b"}},
		{Port: 10443},
		{Port: 10443, Users: map[string]string{"a": "b"}, Protocol: "sctp"},
		{Port: 10443, Users: map[string]string{"": "b"}},
		{Port: 10443, Users: map[string]string{"a": ""}},
	}
	for _, srv := range cases {
		if err := srv.Listen(); err == nil {
			t.Fatalf("Listen accepted %+v", srv)
		}
	}
}

func TestListenAndClose(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	srv := &Server{Port: port, Users: map[string]string{"alice": "secret"}, Protocol: "tcp"}
	if err := srv.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	if st, live := srv.TakeStats(false); st.In != 0 || st.Out != 0 || live != 0 {
		t.Fatalf("stats = %+v live=%d", st, live)
	}
	if err := srv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Close is idempotent and safe without a server.
	if err := srv.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if err := (&Server{}).Close(); err != nil {
		t.Fatalf("empty Close: %v", err)
	}
}

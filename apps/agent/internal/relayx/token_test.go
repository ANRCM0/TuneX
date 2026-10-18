package relayx

import (
	"testing"
	"time"
)

func TestTokenRoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tok, err := BuildToken("site-key", true, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != 75 {
		t.Fatalf("token length %d, want 75", len(tok))
	}
	mux, err := Validate("site-key", tok, now, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !mux {
		t.Fatal("mux bit cleared")
	}
	if _, err := Validate("other", tok, now, 0, nil); err != ErrMismatch {
		t.Fatalf("wrong key: %v", err)
	}
	if _, err := Validate("site-key", tok, now.Add(301*time.Second), 0, nil); err != ErrExpired {
		t.Fatalf("expired: %v", err)
	}
	var cache Replay
	if _, err := Validate("site-key", tok, now, 0, &cache); err != nil {
		t.Fatal(err)
	}
	if _, err := Validate("site-key", tok, now, 0, &cache); err != ErrReplay {
		t.Fatalf("replay: %v", err)
	}
}

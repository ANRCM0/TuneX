package panel

import (
	"testing"
	"time"
)

func TestInspectLicense(t *testing.T) {
	now := float64(1_700_000_000)
	plain := []byte(`{"v":1,"type":"business","site_url":"http://127.0.0.1:3000","expired_at":1700000000,"edition":"self-hosted","iat":1}`)

	ok, err := inspectLicense(plain, "http://127.0.0.1:3000", now)
	if err != nil {
		t.Fatal(err)
	}
	if !ok.SiteOK || ok.Expired {
		t.Fatalf("boundary now==expired_at should be valid, got %+v", ok)
	}

	later, err := inspectLicense(plain, "http://127.0.0.1:3000", now+1)
	if err != nil {
		t.Fatal(err)
	}
	if !later.Expired {
		t.Fatal("expected expired when now > expired_at")
	}

	mismatch, err := inspectLicense(plain, "http://other", now)
	if err != nil {
		t.Fatal(err)
	}
	if mismatch.SiteOK {
		t.Fatal("expected site mismatch")
	}

	if _, err := inspectLicense([]byte("not-json"), "http://127.0.0.1:3000", now); err == nil {
		t.Fatal("expected json error")
	}
}

func TestAckNow(t *testing.T) {
	if got := ackNow(map[string]any{"now": float64(42)}); got != 42 {
		t.Fatalf("float64 now: %v", got)
	}
	before := time.Now().Unix()
	got := int64(ackNow(map[string]any{}))
	if got < before || got > time.Now().Unix() {
		t.Fatalf("fallback now %d not local", got)
	}
}

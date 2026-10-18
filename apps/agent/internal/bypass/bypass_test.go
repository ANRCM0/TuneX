package bypass

import "testing"

func TestBlacklistAndWhitelist(t *testing.T) {
	black := Parse([]string{"10.0.0.0/8", ".example.com", "192.0.2.1:80"}, false)
	if !black.Contains("10.1.2.3:443") {
		t.Fatal("cidr should be bypassed")
	}
	if !black.Contains("a.example.com:1") {
		t.Fatal("suffix should be bypassed")
	}
	if black.Contains("192.0.2.1:443") {
		t.Fatal("different port should be proxied")
	}
	if !black.Contains("192.0.2.1:80") {
		t.Fatal("ip:port should be bypassed")
	}
	if black.Contains("1.2.3.4:9") {
		t.Fatal("unlisted dest should be proxied")
	}

	white := Parse([]string{"allowed.test"}, true)
	if white.Contains("allowed.test:80") {
		t.Fatal("whitelisted dest should be proxied")
	}
	if !white.Contains("other.test:80") {
		t.Fatal("dest outside the whitelist should be bypassed")
	}
	if Parse(nil, false) != nil {
		t.Fatal("empty list should be nil")
	}
}

package sniff

import "testing"

func TestDetect(t *testing.T) {
	bt := append([]byte{19}, []byte("BitTorrent protocol")...)
	if got := Detect(bt); got != "bittorrent" {
		t.Fatalf("bt %q", got)
	}
	if got := Detect([]byte("GET / HTTP/1.1\r\n")); got != "http" {
		t.Fatalf("http %q", got)
	}
	if got := Detect([]byte{0x16, 0x03, 0x01, 0x00}); got != "tls" {
		t.Fatalf("tls %q", got)
	}
	if !Blocked([]string{"BT"}, "bittorrent") {
		t.Fatal("alias")
	}
	if Blocked([]string{"bittorrent"}, "http") {
		t.Fatal("http should pass")
	}
	if Blocked(nil, "http") {
		t.Fatal("empty list")
	}
}

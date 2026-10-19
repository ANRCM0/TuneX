package sniff

import (
	"net"
	"testing"
	"time"
)

func TestDetectProtocols(t *testing.T) {
	btHandshake := append([]byte{19}, []byte("BitTorrent protocol")...)
	btHandshake = append(btHandshake, make([]byte, 8)...)

	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"bittorrent handshake", btHandshake, "bittorrent"},
		{"bittorrent bencode ad", []byte("d1:ad2:id20:"), "bittorrent"},
		{"bittorrent bencode rd", []byte("d1:rd2:id20:"), "bittorrent"},
		{"ssh", []byte("SSH-2.0-OpenSSH_9.6"), "ssh"},
		{"tls", []byte{0x16, 0x03, 0x01, 0x00, 0x40}, "tls"},
		{"http get", []byte("GET / HTTP/1.1\r\n"), "http"},
		{"http connect", []byte("CONNECT example.test:443 HTTP/1.1"), "http"},
		{"http patch", []byte("PATCH /x HTTP/1.1"), "http"},
		{"http head", []byte("HEAD / HTTP/1.0"), "http"},
		{"socks5", []byte{0x05, 0x01, 0x00}, "socks5"},
		{"socks5 max methods", []byte{0x05, 0x10}, "socks5"},
		{"socks4 connect", []byte{0x04, 0x01, 0x00, 0x50}, "socks4"},
		{"socks4 bind", []byte{0x04, 0x02, 0x00, 0x50}, "socks4"},
		{"unknown", []byte("hello world"), ""},
		{"empty", nil, ""},
		{"short tls", []byte{0x16}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Detect(c.in); got != c.want {
				t.Fatalf("Detect(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}

	// A socks5 greeting with too many methods and a socks4 command 3 are not
	// recognised.
	if got := Detect([]byte{0x05, 0x11}); got != "" {
		t.Fatalf("socks5 with 17 methods = %q", got)
	}
	if got := Detect([]byte{0x04, 0x03}); got != "" {
		t.Fatalf("socks4 cmd 3 = %q", got)
	}
}

func TestBlocked(t *testing.T) {
	list := []string{" HTTP ", "Bt", "https", ""}
	if !Blocked(list, "http") {
		t.Fatal("http should be blocked (trim/case)")
	}
	if !Blocked(list, "bittorrent") {
		t.Fatal("bt alias should block bittorrent")
	}
	if !Blocked(list, "tls") {
		t.Fatal("https alias should block tls")
	}
	if Blocked(list, "ssh") {
		t.Fatal("ssh should not be blocked")
	}
	if Blocked(list, "") {
		t.Fatal("empty name should never be blocked")
	}
}

func TestReject(t *testing.T) {
	if Reject(nil, false, "") {
		t.Fatal("empty block list must not reject")
	}
	if !Reject([]string{"http"}, false, "") {
		t.Fatal("unidentified bytes must be dropped without fallback")
	}
	if Reject([]string{"http"}, true, "") {
		t.Fatal("fallback must pass unidentified bytes")
	}
	if !Reject([]string{"http"}, false, "http") {
		t.Fatal("blocked protocol must be rejected")
	}
	if Reject([]string{"http"}, false, "ssh") {
		t.Fatal("unlisted protocol must pass")
	}
}

func TestPeekReplaysBytes(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	go func() {
		_, _ = client.Write([]byte("GET /probe HTTP/1.1\r\nHost: x\r\n\r\n"))
	}()

	conn, name, err := Peek(server)
	if err != nil {
		t.Fatalf("Peek: %v", err)
	}
	if name != "http" {
		t.Fatalf("name = %q", name)
	}

	// The peeked bytes must still be readable through the returned conn.
	buf := make([]byte, 4)
	if _, err := ioReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != "GET " {
		t.Fatalf("replayed = %q", buf)
	}
}

func TestPeekTimeoutAndError(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	// No data: a 500ms peek times out and the original conn comes back.
	start := time.Now()
	conn, name, err := Peek(server)
	if err != nil || name != "" {
		t.Fatalf("timeout peek = %q, %v", name, err)
	}
	if conn != server {
		t.Fatal("timeout should return the original conn")
	}
	if elapsed := time.Since(start); elapsed < 400*time.Millisecond {
		t.Fatalf("peek returned after %v, expected to wait for the deadline", elapsed)
	}

	// A closed peer is a real error.
	_ = client.Close()
	if _, _, err := Peek(server); err == nil {
		t.Fatal("closed peer should surface an error")
	}
}

// ioReadFull avoids importing io just for one call in the replay test.
func ioReadFull(c net.Conn, buf []byte) (int, error) {
	read := 0
	for read < len(buf) {
		n, err := c.Read(buf[read:])
		read += n
		if err != nil {
			return read, err
		}
	}
	return read, nil
}

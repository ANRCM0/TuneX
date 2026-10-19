package socksaddr

import (
	"bytes"
	"errors"
	"io"
	"net"
	"testing"
)

func TestParse(t *testing.T) {
	t.Run("ipv4", func(t *testing.T) {
		b := []byte{ATYPIPv4, 127, 0, 0, 1, 0x1f, 0x90}
		addr, n, err := Parse(b)
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if n != len(b) || addr.Type != ATYPIPv4 || addr.Host != "127.0.0.1" || addr.Port != 8080 {
			t.Fatalf("addr = %+v, n = %d", addr, n)
		}
		if addr.String() != "127.0.0.1:8080" {
			t.Fatalf("String = %q", addr.String())
		}
	})

	t.Run("ipv6", func(t *testing.T) {
		b := append([]byte{ATYPIPv6}, net.ParseIP("2001:db8::1").To16()...)
		b = append(b, 0x00, 0x50)
		addr, n, err := Parse(b)
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if n != 19 || addr.Host != "2001:db8::1" || addr.Port != 80 {
			t.Fatalf("addr = %+v, n = %d", addr, n)
		}
		if addr.String() != "[2001:db8::1]:80" {
			t.Fatalf("String = %q", addr.String())
		}
	})

	t.Run("domain", func(t *testing.T) {
		host := "example.test"
		b := append([]byte{ATYPDomain, byte(len(host))}, host...)
		b = append(b, 0x01, 0xbb)
		addr, n, err := Parse(b)
		if err != nil {
			t.Fatalf("Parse: %v", err)
		}
		if n != len(b) || addr.Host != host || addr.Port != 443 || addr.Type != ATYPDomain {
			t.Fatalf("addr = %+v, n = %d", addr, n)
		}
	})

	t.Run("errors", func(t *testing.T) {
		cases := [][]byte{
			{},
			{ATYPIPv4, 1, 2, 3},
			{ATYPIPv6, 1, 2},
			{ATYPDomain},
			{ATYPDomain, 5, 'a', 'b'},
		}
		for _, b := range cases {
			if _, _, err := Parse(b); !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("Parse(%v) = %v, want ErrUnexpectedEOF", b, err)
			}
		}
		if _, _, err := Parse([]byte{0x02}); err == nil {
			t.Fatal("unsupported ATYP accepted")
		}
	})
}

func TestMarshalRoundTrip(t *testing.T) {
	cases := []struct {
		host string
		port uint16
		atyp byte
	}{
		{"127.0.0.1", 1, ATYPIPv4},
		{"255.255.255.254", 65535, ATYPIPv4},
		{"2001:db8::1", 8080, ATYPIPv6},
		{"::1", 53, ATYPIPv6},
		{"example.test", 443, ATYPDomain},
		{"xn--fsqu00a.example", 80, ATYPDomain},
	}
	for _, c := range cases {
		b, err := Marshal(c.host, c.port)
		if err != nil {
			t.Fatalf("Marshal(%s): %v", c.host, err)
		}
		if b[0] != c.atyp {
			t.Fatalf("Marshal(%s) ATYP = %#x, want %#x", c.host, b[0], c.atyp)
		}
		addr, n, err := Parse(b)
		if err != nil {
			t.Fatalf("Parse(Marshal(%s)): %v", c.host, err)
		}
		if n != len(b) || addr.Port != c.port {
			t.Fatalf("%s: n=%d len=%d port=%d", c.host, n, len(b), addr.Port)
		}
		if got := net.ParseIP(addr.Host); got != nil {
			if !got.Equal(net.ParseIP(c.host)) {
				t.Fatalf("%s: host parsed as %s", c.host, addr.Host)
			}
		} else if addr.Host != c.host {
			t.Fatalf("%s: host = %s", c.host, addr.Host)
		}
	}
}

func TestMarshalRejectsLongDomain(t *testing.T) {
	long := string(bytes.Repeat([]byte("a"), 256))
	if _, err := Marshal(long, 80); err == nil {
		t.Fatal("256-byte domain accepted")
	}
	if b, err := Marshal(string(bytes.Repeat([]byte("a"), 255)), 80); err != nil || len(b) != 2+255+2 {
		t.Fatalf("255-byte domain: len=%d err=%v", len(b), err)
	}
}

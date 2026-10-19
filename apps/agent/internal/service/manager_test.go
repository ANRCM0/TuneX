package service

import (
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/relayx/agent/internal/gostcfg"
	"github.com/relayx/agent/internal/shadowsocks"
	"github.com/relayx/agent/internal/socks5"
	"github.com/relayx/agent/internal/socksaddr"
)

func TestApplyShadowsocksUDP(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()
	echoAddr := echo.LocalAddr().(*net.UDPAddr)

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "udp-1",
				"addr": "127.0.0.1:19171",
				"handler": {"type": "ssu", "auth": {"username": "aes-128-gcm", "password": "panel-secret"}},
				"listener": {"type": "udp", "metadata": {"keepalive": true}}
			},
			{
				"name": "relay-udp",
				"addr": "127.0.0.1:19172",
				"handler": {"type": "ssu", "metadata": {"bind": true}},
				"listener": {"type": "udp"}
			}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 {
		t.Fatalf("results: %+v", results)
	}
	if !results[0].OK() || results[0].Port != 19171 {
		t.Fatalf("ssu service: %+v", results[0])
	}
	if !results[1].OK() || results[1].Port != 19172 {
		t.Fatalf("credential-less ssu (method none): %+v", results[1])
	}

	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 19171})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	dst := socksaddr.Addr{Host: echoAddr.IP.String(), Port: uint16(echoAddr.Port)}
	pkt, err := shadowsocks.PackUDP("aes-128-gcm", "panel-secret", dst, []byte("via-manager"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(pkt); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 2048)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	_, payload, err := shadowsocks.UnpackUDP("aes-128-gcm", "panel-secret", buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "pong:via-manager" {
		t.Fatalf("payload %q", payload)
	}

	noneClient, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 19172})
	if err != nil {
		t.Fatal(err)
	}
	defer noneClient.Close()
	nonePkt, err := shadowsocks.PackUDP("none", "", dst, []byte("via-none"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := noneClient.Write(nonePkt); err != nil {
		t.Fatal(err)
	}
	_ = noneClient.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err = noneClient.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	_, payload, err = shadowsocks.UnpackUDP("none", "", buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "pong:via-none" {
		t.Fatalf("payload %q", payload)
	}
}

func TestApplySocks5IgnoresForwarder(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 32)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	// The forwarder points at a closed port. A socks5 handler must dial the
	// address in the CONNECT request, not this target.
	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "tcp-9",
				"addr": "127.0.0.1:19181",
				"handler": {"type": "socks5", "auth": {"username": "u", "password": "p"}, "metadata": {"udp": true}},
				"listener": {"type": "tcp"},
				"forwarder": {"nodes": [{"name": "gone", "addr": "127.0.0.1:1"}]}
			},
			{
				"name": "udp-9",
				"addr": "127.0.0.1:19182",
				"handler": {"type": "socks5"},
				"listener": {"type": "udp"}
			}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("results: %+v", results)
	}

	c, err := net.Dial("tcp", "127.0.0.1:19181")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte{0x01, 1, 'u', 1, 'p'}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if buf[1] != 0 {
		t.Fatalf("auth status %d", buf[1])
	}
	host, portStr, _ := net.SplitHostPort(echo.Addr().String())
	port, _ := strconv.Atoi(portStr)
	hdr, err := socksaddr.Marshal(host, uint16(port))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write(append([]byte{0x05, 0x01, 0x00}, hdr...)); err != nil {
		t.Fatal(err)
	}
	rep := make([]byte, 10)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, rep); err != nil {
		t.Fatal(err)
	}
	if rep[1] != 0 {
		t.Fatalf("connect rep %d", rep[1])
	}
	if _, err := c.Write([]byte("socks")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 16)
	n, err := c.Read(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(got[:n]) != "pong:socks" {
		t.Fatalf("got %q", got[:n])
	}
}

func TestApplyTLSTunnel(t *testing.T) {
	for _, tc := range []struct {
		kind string
		in   string
		out  string
	}{
		{"tls", "127.0.0.1:19261", "127.0.0.1:19262"},
		{"mtls", "127.0.0.1:19271", "127.0.0.1:19272"},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			echo, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer echo.Close()
			go func() {
				for {
					c, err := echo.Accept()
					if err != nil {
						return
					}
					go func(c net.Conn) {
						defer c.Close()
						buf := make([]byte, 64)
						n, err := c.Read(buf)
						if err != nil {
							return
						}
						_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
					}(c)
				}
			}()
			body := `{
				"tls": {"commonName": "panel.example"},
				"services": [
					{
						"name": "` + tc.kind + `",
						"addr": "` + tc.in + `",
						"handler": {"type": "relay"},
						"listener": {"type": "` + tc.kind + `"}
					},
					{
						"name": "tcp-1",
						"addr": "` + tc.out + `",
						"handler": {"type": "tcp", "chain": "1"},
						"listener": {"type": "tcp"},
						"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
					}
				],
				"chains": [{
					"name": "1",
					"hops": [{
						"nodes": [{
							"addr": "` + tc.in + `",
							"dialer": {"type": "` + tc.kind + `"},
							"connector": {"type": "relay"}
						}]
					}]
				}]
			}`
			cfg, err := gostcfg.Parse([]byte(body))
			if err != nil {
				t.Fatal(err)
			}
			m := New(Options{})
			defer m.Close()
			results := m.Apply(cfg)
			if len(results) != 2 || !results[0].OK() || !results[1].OK() {
				t.Fatalf("apply: %+v", results)
			}
			c, err := net.Dial("tcp", tc.out)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if _, err := c.Write([]byte("via-" + tc.kind)); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 32)
			_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
			n, err := c.Read(buf)
			if err != nil {
				t.Fatal(err)
			}
			if string(buf[:n]) != "pong:via-"+tc.kind {
				t.Fatalf("got %q", buf[:n])
			}
		})
	}
}

func TestApplyWSS(t *testing.T) {
	for _, tc := range []struct {
		kind string
		in   string
		out  string
	}{
		{"wss", "127.0.0.1:39281", "127.0.0.1:39282"},
		{"mwss", "127.0.0.1:39291", "127.0.0.1:39292"},
		{"ws", "127.0.0.1:39301", "127.0.0.1:39302"},
		{"mws", "127.0.0.1:39311", "127.0.0.1:39312"},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			echo, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer echo.Close()
			go func() {
				for {
					c, err := echo.Accept()
					if err != nil {
						return
					}
					go func(c net.Conn) {
						defer c.Close()
						buf := make([]byte, 64)
						n, err := c.Read(buf)
						if err != nil {
							return
						}
						_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
					}(c)
				}
			}()
			body := `{
				"tls": {"commonName": "panel.example"},
				"services": [
					{
						"name": "` + tc.kind + `",
						"addr": "` + tc.in + `",
						"handler": {"type": "relay"},
						"listener": {"type": "` + tc.kind + `"}
					},
					{
						"name": "tcp-1",
						"addr": "` + tc.out + `",
						"handler": {"type": "tcp", "chain": "1"},
						"listener": {"type": "tcp"},
						"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
					}
				],
				"chains": [{
					"name": "1",
					"hops": [{
						"nodes": [{
							"addr": "` + tc.in + `",
							"dialer": {"type": "` + tc.kind + `"},
							"connector": {"type": "relay"}
						}]
					}]
				}]
			}`
			cfg, err := gostcfg.Parse([]byte(body))
			if err != nil {
				t.Fatal(err)
			}
			m := New(Options{})
			defer m.Close()
			results := m.Apply(cfg)
			if len(results) != 2 || !results[0].OK() || !results[1].OK() {
				t.Fatalf("apply: %+v", results)
			}
			c, err := net.Dial("tcp", tc.out)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if _, err := c.Write([]byte("via-" + tc.kind)); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, 32)
			_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
			n, err := c.Read(buf)
			if err != nil {
				t.Fatal(err)
			}
			if string(buf[:n]) != "pong:via-"+tc.kind {
				t.Fatalf("got %q", buf[:n])
			}
		})
	}
}

func TestApplyMTCP(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()
	body := `{
		"services": [
			{
				"name": "mtcp",
				"addr": "127.0.0.1:19301",
				"handler": {"type": "relay"},
				"listener": {"type": "mtcp"}
			},
			{
				"name": "tcp-1",
				"addr": "127.0.0.1:19302",
				"handler": {"type": "tcp", "chain": "1"},
				"listener": {"type": "tcp"},
				"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [{
					"addr": "127.0.0.1:19301",
					"dialer": {"type": "mtcp"},
					"connector": {"type": "relay"}
				}]
			}]
		}]
	}`
	cfg, err := gostcfg.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	for _, msg := range []string{"via-mtcp", "via-mtcp-2"} {
		c, err := net.Dial("tcp", "127.0.0.1:19302")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Write([]byte(msg)); err != nil {
			c.Close()
			t.Fatal(err)
		}
		buf := make([]byte, 32)
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, err := c.Read(buf)
		c.Close()
		if err != nil {
			t.Fatal(err)
		}
		if string(buf[:n]) != "pong:"+msg {
			t.Fatalf("got %q", buf[:n])
		}
	}
}

func TestApplyQuic(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"tls": {"validity": "8760h", "commonName": "panel.example", "organization": "panel.example"},
		"services": [
			{
				"name": "quic",
				"addr": "127.0.0.1:19251",
				"handler": {"type": "relay"},
				"listener": {"type": "quic"}
			},
			{
				"name": "tcp-1",
				"addr": "127.0.0.1:19252",
				"handler": {"type": "tcp", "chain": "1"},
				"listener": {"type": "tcp"},
				"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [{
					"addr": "127.0.0.1:19251",
					"dialer": {"type": "quic"},
					"connector": {"type": "relay"}
				}]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("tcp", "127.0.0.1:19252")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-quic")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-quic" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestApplyRelayx(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "out-relayx",
				"addr": "127.0.0.1:19241",
				"handler": {"type": "relay"},
				"listener": {"type": "relayx", "metadata": {"key": "site-key"}}
			},
			{
				"name": "tcp-1",
				"addr": "127.0.0.1:19242",
				"handler": {"type": "tcp", "chain": "1"},
				"listener": {"type": "tcp"},
				"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [{
					"addr": "127.0.0.1:19241",
					"dialer": {"type": "relayx", "metadata": {"key": "site-key", "host": "panel.example"}},
					"connector": {"type": "relay"}
				}]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("tcp", "127.0.0.1:19242")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-relayx")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-relayx" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestApplyRelayChain(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "out-1",
				"addr": "127.0.0.1:19193",
				"handler": {"type": "relay", "auth": {"username": "exit", "password": "hop"}},
				"listener": {"type": "tcp"}
			},
			{
				"name": "tcp-1",
				"addr": "127.0.0.1:19194",
				"handler": {"type": "tcp", "chain": "1"},
				"listener": {"type": "tcp"},
				"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [
					{"addr": "127.0.0.1:1", "metadata": {"backup": true}, "connector": {"type": "relay"}},
					{"addr": "127.0.0.1:19193", "connector": {"type": "relay", "auth": {"username": "exit", "password": "hop"}}}
				]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("tcp", "127.0.0.1:19194")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-relay")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-relay" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestApplySocks5Hop(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()
	proxy := &socks5.Server{}
	if err := proxy.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [{
			"name": "tcp-1",
			"addr": "127.0.0.1:19196",
			"handler": {"type": "tcp", "chain": "1"},
			"listener": {"type": "tcp"},
			"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
		}],
		"chains": [{
			"name": "1",
			"hops": [{"nodes": [{"addr": "` + proxy.Addr().String() + `", "connector": {"type": "socks5"}}]}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 1 || !results[0].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("tcp", "127.0.0.1:19196")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-socks-hop")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-socks-hop" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestApplySocks5UDPHop(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()
	proxy := &socks5.Server{AllowUDP: true}
	if err := proxy.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [{
			"name": "udp-1",
			"addr": "127.0.0.1:19197",
			"handler": {"type": "udp", "chain": "1"},
			"listener": {"type": "udp"},
			"metadata": {"enableStats": true},
			"forwarder": {"nodes": [{"addr": "` + echo.LocalAddr().String() + `"}]}
		}],
		"chains": [{
			"name": "1",
			"hops": [{"nodes": [{"addr": "` + proxy.Addr().String() + `", "connector": {"type": "socks5"}}]}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 1 || !results[0].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("udp", "127.0.0.1:19197")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-socks-udp")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-socks-udp" {
		t.Fatalf("got %q", buf[:n])
	}
	waitObserved(t, m, "udp-1", len("via-socks-udp"), len("pong:via-socks-udp"))
}

func TestApplyRelayThenSocks5(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()
	proxy := &socks5.Server{}
	if err := proxy.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "out-1",
				"addr": "127.0.0.1:19198",
				"handler": {"type": "relay"},
				"listener": {"type": "tcp"}
			},
			{
				"name": "tcp-1",
				"addr": "127.0.0.1:19199",
				"handler": {"type": "tcp", "chain": "1"},
				"listener": {"type": "tcp"},
				"metadata": {"enableStats": true},
				"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [
				{"nodes": [{"addr": "127.0.0.1:19198", "connector": {"type": "relay"}}]},
				{"nodes": [{"addr": "` + proxy.Addr().String() + `", "connector": {"type": "socks5"}}]}
			]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("tcp", "127.0.0.1:19199")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-two")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-two" {
		t.Fatalf("got %q", buf[:n])
	}
	_ = c.Close()
	waitObserved(t, m, "tcp-1", len("via-two"), len("pong:via-two"))
}

func TestApplyRemoteBind(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 64)
				n, err := c.Read(buf)
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "in-bind",
				"addr": "127.0.0.1:19211",
				"handler": {"type": "relay", "metadata": {"bind": true}},
				"listener": {"type": "tcp"}
			},
			{
				"name": "remote-1",
				"addr": "127.0.0.1:19212",
				"handler": {"type": "rtcp"},
				"listener": {"type": "rtcp", "chain": "1"},
				"forwarder": {"nodes": [{"addr": "` + echo.Addr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [
					{"addr": "127.0.0.1:19211", "connector": {"type": "relay"}}
				]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	c, err := net.Dial("tcp", "127.0.0.1:19212")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("via-bind")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-bind" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestRemoteTCPRoundRobin(t *testing.T) {
	a, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	seen := make(chan string, 2)
	serve := func(ln net.Listener, name string) {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		buf := make([]byte, 32)
		n, _ := c.Read(buf)
		seen <- name + ":" + string(buf[:n])
		_, _ = c.Write([]byte("pong:" + name))
	}
	go serve(a, "a")
	go serve(b, "b")

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "in-bind",
				"addr": "127.0.0.1:19213",
				"handler": {"type": "relay", "metadata": {"bind": true}},
				"listener": {"type": "tcp"}
			},
			{
				"name": "remote-rr",
				"addr": "127.0.0.1:19214",
				"handler": {"type": "rtcp"},
				"listener": {"type": "rtcp", "chain": "1"},
				"forwarder": {
					"selector": {"strategy": "round"},
					"nodes": [
						{"addr": "` + a.Addr().String() + `"},
						{"addr": "` + b.Addr().String() + `"}
					]
				}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{"nodes": [{"addr": "127.0.0.1:19213", "connector": {"type": "relay"}}]}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	dial := func(payload string) {
		c, err := net.Dial("tcp", "127.0.0.1:19214")
		if err != nil {
			t.Error(err)
			return
		}
		defer c.Close()
		if _, err := c.Write([]byte(payload)); err != nil {
			t.Error(err)
			return
		}
		buf := make([]byte, 32)
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, err := c.Read(buf)
		if err != nil {
			t.Error(err)
			return
		}
		if string(buf[:n]) != "pong:"+payload {
			t.Errorf("got %q", buf[:n])
		}
	}
	dial("a")
	dial("b")
	got := map[string]bool{}
	deadline := time.Now().Add(3 * time.Second)
	for len(got) < 2 && time.Now().Before(deadline) {
		select {
		case s := <-seen:
			got[s] = true
		case <-time.After(time.Until(deadline)):
		}
	}
	if !got["a:a"] || !got["b:b"] {
		t.Fatalf("targets %v", got)
	}
}

func TestApplyRemoteUDP(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "in-bind",
				"addr": "127.0.0.1:19231",
				"handler": {"type": "relay", "metadata": {"bind": true}},
				"listener": {"type": "tcp"}
			},
			{
				"name": "remote-udp",
				"addr": "127.0.0.1:19232",
				"handler": {"type": "rudp"},
				"listener": {"type": "rudp", "chain": "1"},
				"forwarder": {"nodes": [{"addr": "` + echo.LocalAddr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [
					{"addr": "127.0.0.1:19231", "connector": {"type": "relay"}}
				]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	client, err := net.DialUDP("udp", nil, mustResolveUDP(t, "127.0.0.1:19232"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("via-rudp")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-rudp" {
		t.Fatalf("got %q", buf[:n])
	}
}

func mustResolveUDP(t *testing.T, addr string) *net.UDPAddr {
	t.Helper()
	ua, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		t.Fatal(err)
	}
	return ua
}

func TestApplyUDPHop(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "out-udp",
				"addr": "127.0.0.1:19221",
				"handler": {"type": "ssu"},
				"listener": {"type": "udp"}
			},
			{
				"name": "in-udp",
				"addr": "127.0.0.1:19222",
				"handler": {"type": "udp", "chain": "1"},
				"listener": {"type": "udp"},
				"forwarder": {"nodes": [{"addr": "` + echo.LocalAddr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [
					{"addr": "127.0.0.1:19221", "connector": {"type": "ssu"}}
				]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 19222})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("via-hop")); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-hop" {
		t.Fatalf("got %q", buf[:n])
	}
}

func TestApplyShadowsocksUDPHop(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()

	cfg, err := gostcfg.Parse([]byte(`{
		"services": [
			{
				"name": "out-ss",
				"addr": "127.0.0.1:19223",
				"handler": {"type": "ssu", "auth": {"username": "aes-128-gcm", "password": "secret"}},
				"listener": {"type": "udp"}
			},
			{
				"name": "in-ss",
				"addr": "127.0.0.1:19224",
				"handler": {"type": "udp", "chain": "1"},
				"listener": {"type": "udp"},
				"metadata": {"enableStats": true},
				"forwarder": {"nodes": [{"addr": "` + echo.LocalAddr().String() + `"}]}
			}
		],
		"chains": [{
			"name": "1",
			"hops": [{
				"nodes": [
					{"addr": "127.0.0.1:19223", "connector": {"type": "ss", "auth": {"username": "aes-128-gcm", "password": "secret"}}}
				]
			}]
		}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 2 || !results[0].OK() || !results[1].OK() {
		t.Fatalf("apply: %+v", results)
	}
	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 19224})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("via-ss")); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 64)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-ss" {
		t.Fatalf("got %q", buf[:n])
	}
	waitObserved(t, m, "in-ss", len("via-ss"), len("pong:via-ss"))
}

func waitObserved(t *testing.T, m *Manager, name string, in, out int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		for _, ev := range m.ObserveEvents() {
			if ev.Service == name && ev.Stats != nil && int(ev.Stats.InputBytes) >= in && int(ev.Stats.OutputBytes) >= out {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s was not observed (want in>=%d out>=%d)", name, in, out)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

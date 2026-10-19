package socks5

import (
	"bytes"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/socksaddr"
)

func TestReadRequestForms(t *testing.T) {
	ipv4 := append([]byte{0x05, cmdConnect, 0x00}, mustMarshal(t, "1.2.3.4", 80)...)
	cmd, addr, err := readRequest(bytes.NewReader(ipv4))
	if err != nil || cmd != cmdConnect || addr.Host != "1.2.3.4" || addr.Port != 80 {
		t.Fatalf("ipv4 request = %v %+v %v", cmd, addr, err)
	}

	domain := append([]byte{0x05, cmdUDP, 0x00}, mustMarshal(t, "example.test", 443)...)
	cmd, addr, err = readRequest(bytes.NewReader(domain))
	if err != nil || cmd != cmdUDP || addr.Host != "example.test" || addr.Port != 443 {
		t.Fatalf("domain request = %v %+v %v", cmd, addr, err)
	}

	ipv6 := append([]byte{0x05, cmdConnect, 0x00}, mustMarshal(t, "2001:db8::1", 53)...)
	_, addr, err = readRequest(bytes.NewReader(ipv6))
	if err != nil || addr.Host != "2001:db8::1" || addr.Port != 53 {
		t.Fatalf("ipv6 request = %+v %v", addr, err)
	}

	if _, _, err := readRequest(bytes.NewReader([]byte{0x04, 0x01, 0x00, 0x01})); err == nil {
		t.Fatal("wrong version accepted")
	}
	if _, _, err := readRequest(bytes.NewReader([]byte{0x05, 0x01, 0x00, 0x09, 0, 0})); err == nil {
		t.Fatal("unsupported ATYP accepted")
	}
	if _, _, err := readRequest(bytes.NewReader([]byte{0x05, 0x01})); err == nil {
		t.Fatal("truncated request accepted")
	}
}

func TestWriteReply(t *testing.T) {
	var buf bytes.Buffer
	if err := writeReply(&buf, repOK, nil); err != nil {
		t.Fatalf("writeReply: %v", err)
	}
	want := append([]byte{0x05, repOK, 0x00}, mustMarshal(t, "0.0.0.0", 0)...)
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("nil-addr reply = %x, want %x", buf.Bytes(), want)
	}

	buf.Reset()
	addr, _ := net.ResolveTCPAddr("tcp", "127.0.0.1:9000")
	if err := writeReply(&buf, repFailure, addr); err != nil {
		t.Fatalf("writeReply: %v", err)
	}
	want = append([]byte{0x05, repFailure, 0x00}, mustMarshal(t, "127.0.0.1", 9000)...)
	if !bytes.Equal(buf.Bytes(), want) {
		t.Fatalf("addr reply = %x, want %x", buf.Bytes(), want)
	}
}

func TestDialRep(t *testing.T) {
	timeout := &timeoutErr{}
	if got := dialRep(timeout); got != repHostUnreach {
		t.Fatalf("timeout -> %#x", got)
	}
	if got := dialRep(&net.OpError{Op: "dial", Err: errors.New("connect: connection refused")}); got != repConnRefused {
		t.Fatalf("refused -> %#x", got)
	}
	if got := dialRep(errors.ErrUnsupported); got != repAtypUnsup {
		t.Fatalf("unsupported -> %#x", got)
	}
	if got := dialRep(errors.New("boom")); got != repFailure {
		t.Fatalf("other -> %#x", got)
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }

func startServer(t *testing.T, srv *Server) string {
	t.Helper()
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return srv.Addr().String()
}

func dialAndHandshake(t *testing.T, addr string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if err := clientHandshake(c, "", ""); err != nil {
		t.Fatalf("handshake: %v", err)
	}
	return c
}

func TestUnsupportedCommand(t *testing.T) {
	srv := &Server{}
	addr := startServer(t, srv)
	c := dialAndHandshake(t, addr)

	req := append([]byte{0x05, cmdBind, 0x00}, mustMarshal(t, "1.2.3.4", 80)...)
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 10)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if head[1] != repCmdUnsupport {
		t.Fatalf("rep = %#x, want %#x", head[1], repCmdUnsupport)
	}
}

func TestUDPAssociateRequiresAllowUDP(t *testing.T) {
	srv := &Server{}
	addr := startServer(t, srv)
	c := dialAndHandshake(t, addr)

	req := append([]byte{0x05, cmdUDP, 0x00}, mustMarshal(t, "0.0.0.0", 0)...)
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 10)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if head[1] != repCmdUnsupport {
		t.Fatalf("rep = %#x, want %#x", head[1], repCmdUnsupport)
	}
}

func TestBypassReply(t *testing.T) {
	srv := &Server{Bypass: func(string) bool { return true }}
	addr := startServer(t, srv)
	c := dialAndHandshake(t, addr)

	req := append([]byte{0x05, cmdConnect, 0x00}, mustMarshal(t, "example.test", 80)...)
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 10)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if head[1] != repNotAllowed {
		t.Fatalf("rep = %#x, want %#x", head[1], repNotAllowed)
	}
}

func TestDialFailureReply(t *testing.T) {
	srv := &Server{Dial: func(net.Addr, string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Err: errors.New("connect: connection refused")}
	}}
	addr := startServer(t, srv)
	c := dialAndHandshake(t, addr)

	req := append([]byte{0x05, cmdConnect, 0x00}, mustMarshal(t, "example.test", 80)...)
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 10)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatalf("reply: %v", err)
	}
	if head[1] != repConnRefused {
		t.Fatalf("rep = %#x, want %#x", head[1], repConnRefused)
	}
}

func TestAdmissionRejectsSilently(t *testing.T) {
	srv := &Server{Allow: func(net.Addr) bool { return false }}
	addr := startServer(t, srv)

	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 2)
	if _, err := c.Read(buf); err == nil {
		t.Fatal("rejected connection should be closed without a greeting")
	}
}

func TestBlockedProtocolIsDropped(t *testing.T) {
	echo := tcpEcho(t)
	srv := &Server{Block: []string{"http"}}
	addr := startServer(t, srv)
	c := dialAndHandshake(t, addr)
	if err := clientConnect(c, echo); err != nil {
		t.Fatalf("connect: %v", err)
	}

	if _, err := c.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	if n, err := c.Read(buf); err == nil && strings.HasPrefix(string(buf[:n]), "pong:") {
		t.Fatalf("blocked request was forwarded: %q", buf[:n])
	}
}

func TestSniffFallbackPassesUnknown(t *testing.T) {
	echo := tcpEcho(t)
	srv := &Server{Block: []string{"http"}, SniffFallback: true}
	addr := startServer(t, srv)
	c := dialAndHandshake(t, addr)
	if err := clientConnect(c, echo); err != nil {
		t.Fatalf("connect: %v", err)
	}

	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 16)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf[:n]) != "pong:hello" {
		t.Fatalf("echo = %q", buf[:n])
	}
}

func mustMarshal(t *testing.T, host string, port uint16) []byte {
	t.Helper()
	b, err := socksaddr.Marshal(host, port)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

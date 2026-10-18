package socks5

import (
	"io"
	"net"
	"testing"
	"time"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/socksaddr"
)

func TestConnectNoAuth(t *testing.T) {
	echo := tcpEcho(t)
	srv := &Server{AllowUDP: true}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := clientHandshake(c, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := clientConnect(c, echo); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:hello" {
		t.Fatalf("got %q", buf[:n])
	}
	c.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		st, _ := srv.TakeStats(false)
		if st.In > 0 && st.Out > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("socks5 stats in=%d out=%d", st.In, st.Out)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestUserPass(t *testing.T) {
	srv := &Server{Username: "u", Password: "p", AllowUDP: true}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatal(err)
	}
	if buf[1] != authNoAcceptable {
		t.Fatalf("method reply %v", buf)
	}

	c2, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if _, err := c2.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c2, buf); err != nil {
		t.Fatal(err)
	}
	if buf[1] != authUserPass {
		t.Fatalf("method reply %v", buf)
	}
	if _, err := c2.Write([]byte{0x01, 0x01, 'u', 0x01, 'x'}); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(c2, buf); err != nil {
		t.Fatal(err)
	}
	if buf[1] == 0x00 {
		t.Fatal("wrong password was accepted")
	}
}

func TestUDPAssociate(t *testing.T) {
	echo, echoAddr := udpEcho(t)
	defer echo.Close()

	srv := &Server{AllowUDP: true}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := clientHandshake(c, "", ""); err != nil {
		t.Fatal(err)
	}
	// UDP ASSOCIATE, address 0.0.0.0:0.
	req := []byte{0x05, cmdUDP, 0x00, socksaddr.ATYPIPv4, 0, 0, 0, 0, 0, 0}
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
	bnd, err := readReply(c)
	if err != nil {
		t.Fatal(err)
	}

	client, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: int(bnd.Port)})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	dst := socksaddr.Addr{Host: echoAddr.IP.String(), Port: uint16(echoAddr.Port)}
	pkt, err := EncodeUDP(dst, []byte("via-socks"))
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
	_, payload, err := DecodeUDP(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "pong:via-socks" {
		t.Fatalf("payload %q", payload)
	}
	waitStats(t, srv.TakeStats, len("via-socks"), len("pong:via-socks"))
}

func TestUDPServer(t *testing.T) {
	echo, echoAddr := udpEcho(t)
	defer echo.Close()
	srv := &UDPServer{}
	if err := srv.ListenUDP("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	bound := srv.pc.LocalAddr().(*net.UDPAddr)

	client, err := net.DialUDP("udp", nil, bound)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	dst := socksaddr.Addr{Host: echoAddr.IP.String(), Port: uint16(echoAddr.Port)}
	pkt, err := EncodeUDP(dst, []byte("direct"))
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
	_, payload, err := DecodeUDP(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != "pong:direct" {
		t.Fatalf("payload %q", payload)
	}
	waitStats(t, srv.TakeStats, len("direct"), len("pong:direct"))
}

func waitStats(t *testing.T, take func(bool) (forward.Stats, int), wantIn, wantOut int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		st, _ := take(false)
		if st.In >= int64(wantIn) && st.Out >= int64(wantOut) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("stats in=%d out=%d, want at least %d/%d", st.In, st.Out, wantIn, wantOut)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func tcpEcho(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
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
	return ln.Addr().String()
}

func udpEcho(t *testing.T) (net.PacketConn, *net.UDPAddr) {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 2048)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()
	return pc, pc.LocalAddr().(*net.UDPAddr)
}

func clientHandshake(c net.Conn, user, pass string) error {
	if user == "" && pass == "" {
		if _, err := c.Write([]byte{0x05, 0x01, 0x00}); err != nil {
			return err
		}
		buf := make([]byte, 2)
		if _, err := io.ReadFull(c, buf); err != nil {
			return err
		}
		if buf[1] != authNone {
			return io.ErrUnexpectedEOF
		}
		return nil
	}
	if _, err := c.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		return err
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(c, buf); err != nil {
		return err
	}
	pkt := []byte{0x01, byte(len(user))}
	pkt = append(pkt, user...)
	pkt = append(pkt, byte(len(pass)))
	pkt = append(pkt, pass...)
	if _, err := c.Write(pkt); err != nil {
		return err
	}
	if _, err := io.ReadFull(c, buf); err != nil {
		return err
	}
	if buf[1] != 0x00 {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func clientConnect(c net.Conn, hostport string) error {
	host, portStr, err := net.SplitHostPort(hostport)
	if err != nil {
		return err
	}
	n, err := parsePort(portStr)
	if err != nil {
		return err
	}
	hdr, err := socksaddr.Marshal(host, n)
	if err != nil {
		return err
	}
	req := append([]byte{0x05, cmdConnect, 0x00}, hdr...)
	if _, err := c.Write(req); err != nil {
		return err
	}
	_, err = readReply(c)
	return err
}

func readReply(c net.Conn) (socksaddr.Addr, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		return socksaddr.Addr{}, err
	}
	if head[1] != repOK {
		return socksaddr.Addr{}, io.ErrUnexpectedEOF
	}
	rest, err := readAddrRest(c, head[3])
	if err != nil {
		return socksaddr.Addr{}, err
	}
	addr, _, err := socksaddr.Parse(append([]byte{head[3]}, rest...))
	return addr, err
}

func TestConnectBlocksBittorrent(t *testing.T) {
	echo := tcpEcho(t)
	srv := &Server{Block: []string{"bittorrent"}}
	if err := srv.Listen("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	c, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := clientHandshake(c, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := clientConnect(c, echo); err != nil {
		t.Fatal(err)
	}
	payload := append([]byte{19}, []byte("BitTorrent protocol")...)
	if _, err := c.Write(payload); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := c.Read(make([]byte, 8)); err == nil {
		t.Fatal("blocked socks connection stayed open")
	}

	ok, err := net.Dial("tcp", srv.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if err := clientHandshake(ok, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := clientConnect(ok, echo); err != nil {
		t.Fatal(err)
	}
	if _, err := ok.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	_ = ok.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 64)
	n, err := ok.Read(buf)
	if n == 0 {
		t.Fatal(err)
	}
}

package vless

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestUDPRelay(t *testing.T) {
	echo, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		buf := make([]byte, 64)
		for {
			n, addr, err := echo.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = echo.WriteTo(append([]byte("pong:"), buf[:n]...), addr)
		}
	}()

	id, err := ParseUUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
	if err != nil {
		t.Fatal(err)
	}
	users := map[[16]byte]struct{}{id: {}}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	errc := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			errc <- err
			return
		}
		defer c.Close()
		target, plain, udp, err := Accept(c, users)
		if err != nil {
			errc <- err
			return
		}
		if !udp || target != echo.LocalAddr().String() {
			errc <- errTarget("udp target " + target)
			return
		}
		_, err = RelayUDP(plain, target)
		errc <- err
	}()

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := writeUDPHeader(c, id, echo.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	if err := writePacket(c, []byte("ping-udp")); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	pkt, err := readPacket(c)
	if err != nil {
		t.Fatal(err)
	}
	if string(pkt) != "pong:ping-udp" {
		t.Fatalf("got %q", pkt)
	}
}

func writeUDPHeader(conn net.Conn, id [16]byte, addr string) error {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	port, err := net.LookupPort("udp", portStr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host).To4()
	buf := make([]byte, 0, 32)
	buf = append(buf, 0)
	buf = append(buf, id[:]...)
	buf = append(buf, 0, 2)
	var portb [2]byte
	binary.BigEndian.PutUint16(portb[:], uint16(port))
	buf = append(buf, portb[:]...)
	buf = append(buf, 1)
	buf = append(buf, ip...)
	_, err = conn.Write(buf)
	if err != nil {
		return err
	}
	var resp [2]byte
	_, err = conn.Read(resp[:])
	return err
}

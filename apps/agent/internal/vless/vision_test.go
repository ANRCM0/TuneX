package vless

import (
	"net"
	"testing"
	"time"
)

func TestVisionRoundTrip(t *testing.T) {
	id, err := ParseUUID("11111111-2222-3333-4444-555555555555")
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
		target, plain, _, err := Accept(c, users)
		if err != nil {
			errc <- err
			return
		}
		if target != "127.0.0.1:9" {
			errc <- errTarget(target)
			return
		}
		buf := make([]byte, 32)
		_ = plain.SetReadDeadline(time.Now().Add(3 * time.Second))
		n, err := plain.Read(buf)
		if err != nil {
			errc <- err
			return
		}
		if string(buf[:n]) != "hello-vision" {
			errc <- errTarget(string(buf[:n]))
			return
		}
		if _, err := plain.Write([]byte("pong-vision")); err != nil {
			errc <- err
			return
		}
		errc <- nil
	}()

	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	plain, err := WriteVision(c, id, "127.0.0.1:9")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := plain.Write([]byte("hello-vision")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = plain.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := plain.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong-vision" {
		t.Fatalf("got %q", buf[:n])
	}
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

func TestVisionContinueBlock(t *testing.T) {
	id, err := ParseUUID("11111111-2222-3333-4444-555555555555")
	if err != nil {
		t.Fatal(err)
	}
	block := append(visionBlock(id[:], cmdPaddingContinue, []byte("ab"), false), visionBlock(nil, cmdPaddingEnd, []byte("cd"), false)...)
	v := &visionConn{uuid: id, mode: modeCheck}
	v.feed(block)
	if string(v.out) != "abcd" {
		t.Fatalf("got %q", v.out)
	}
	if v.mode != modeRaw {
		t.Fatalf("mode %d", v.mode)
	}
}

type errTarget string

func (e errTarget) Error() string { return string(e) }

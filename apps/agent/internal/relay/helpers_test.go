package relay

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

func TestNormalizeBindAddr(t *testing.T) {
	cases := map[string]string{
		"":                        "0.0.0.0:0",
		"1.2.3.4:0:WAIT_LISTEN":   "0.0.0.0:0",
		"127.0.0.1:8080":          "127.0.0.1:8080",
		"*:9000":                  "0.0.0.0:9000",
		":7000":                   "0.0.0.0:7000",
		"not-an-address":          "0.0.0.0:0",
		"[::1]:8080":              "[::1]:8080",
		"0.0.0.0:WAIT_LISTEN:100": "0.0.0.0:0",
	}
	for in, want := range cases {
		if got := normalizeBindAddr(in); got != want {
			t.Fatalf("normalizeBindAddr(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNetworkFeature(t *testing.T) {
	f := networkFeature(258)
	if f.typ != featureNetwork {
		t.Fatalf("type = %d", f.typ)
	}
	if len(f.data) != 2 || binary.BigEndian.Uint16(f.data) != 258 {
		t.Fatalf("data = %v", f.data)
	}
}

func TestDialErrors(t *testing.T) {
	if _, err := Dial(nil, ""); err == nil {
		t.Fatal("empty target accepted")
	}

	echo := serveEcho(t)
	defer echo.Close()

	hops := []Hop{{Addr: echo.Addr().String(), Connector: "not-a-connector"}}
	if _, err := Dial(hops, "example.test:80"); err == nil || !contains(err.Error(), "is not implemented") {
		t.Fatalf("unsupported connector err = %v", err)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestForwardDirectAndStats(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()

	f := &Forward{Target: echo.Addr().String()}
	if err := f.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer f.Close()

	c, err := net.Dial("tcp", f.ln.Addr().String())
	if err != nil {
		t.Fatalf("dial forward: %v", err)
	}
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	n, err := c.Read(buf)
	if err != nil || string(buf[:n]) != "pong:hello" {
		t.Fatalf("read = %q, %v", buf[:n], err)
	}
	c.Close()

	deadline := time.Now().Add(3 * time.Second)
	for {
		st, live := f.TakeStats(false)
		if st.In > 0 && st.Out > 0 && live == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stats in=%d out=%d live=%d", st.In, st.Out, live)
		}
		time.Sleep(10 * time.Millisecond)
	}

	st, _ := f.TakeStats(true)
	if st.In == 0 {
		t.Fatal("reset should still report the previous counters")
	}
	if st2, _ := f.TakeStats(false); st2.In != 0 || st2.Out != 0 {
		t.Fatalf("counters not reset: %+v", st2)
	}

	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := net.DialTimeout("tcp", f.ln.Addr().String(), time.Second); err == nil {
		t.Fatal("dial after Close succeeded")
	}
}

func TestForwardPickAndObserve(t *testing.T) {
	echo := serveEcho(t)
	defer echo.Close()

	picked := make(chan struct{}, 1)
	observed := make(chan string, 1)

	f := &Forward{
		Pick: func(net.Addr) ([]Hop, string, func()) {
			picked <- struct{}{}
			return nil, echo.Addr().String(), func() {}
		},
	}
	if err := f.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer f.Close()

	// The picker is consulted for every accepted connection; a nil hop list is
	// ignored by the forward, so the connection is simply closed.
	c, err := net.Dial("tcp", f.ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c.Close()

	select {
	case <-picked:
	case <-time.After(3 * time.Second):
		t.Fatal("Pick was not called")
	}
	buf := make([]byte, 16)

	// Observe is only called for chained forwards; give it a hop that the echo
	// listener accepts as a relay server would not, so the dial fails and the
	// failure duration (30s) is still reported.
	f2 := &Forward{
		Hops:    []Hop{{Addr: echo.Addr().String()}},
		Target:  "example.test:80",
		Observe: func(addr string, _ time.Duration) { observed <- addr },
	}
	if err := f2.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer f2.Close()
	c2, err := net.Dial("tcp", f2.ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_ = c2.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _ = c2.Read(buf)
	c2.Close()

	select {
	case addr := <-observed:
		if addr != echo.Addr().String() {
			t.Fatalf("observed addr = %q", addr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Observe was not called")
	}
}

func TestForwardDiscardsBadTarget(t *testing.T) {
	f := &Forward{Target: ""}
	if err := f.Listen("127.0.0.1:0"); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer f.Close()
	st, live := f.TakeStats(false)
	if st.In != 0 || st.Out != 0 || st.Conns != 0 || live != 0 {
		t.Fatalf("stats = %+v live=%d", st, live)
	}
}

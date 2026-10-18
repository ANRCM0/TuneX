// Package ping implements the ICMP echo the panel uses to test whether a node
// can reach a host (`ping` event, see docs/AGENT.md).
//
// Upstream uses a raw-socket ICMP library. The replica speaks ICMPv4 directly
// through the standard library; when the process lacks CAP_NET_RAW it falls back
// to timing a TCP connect so the panel still gets a usable latency figure
// (reported via the `method` return value).
package ping

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"time"
)

// Result is a single ping outcome.
type Result struct {
	Milliseconds float64
	// Method is "icmp" or "tcp".
	Method string
}

// ErrPermission means raw sockets are unavailable to this process.
var ErrPermission = errors.New("ping: raw ICMP socket not permitted")

// Ping sends one ICMP echo request to host and reports the round-trip time.
// When raw sockets are denied it degrades to a TCP connect test.
func Ping(ctx context.Context, host string, timeout time.Duration) (Result, error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ip, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ip) == 0 {
		return Result{}, fmt.Errorf("ping: resolve %s: %w", host, err)
	}
	target := ip[0].IP

	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	ms, err := icmpEcho(dctx, target)
	if err == nil {
		return Result{Milliseconds: ms, Method: "icmp"}, nil
	}
	if !isPermission(err) {
		return Result{}, err
	}
	tcpms, tcpErr := tcpFallback(dctx, target, timeout)
	if tcpErr != nil {
		return Result{}, fmt.Errorf("ping: %s unreachable: icmp=%v tcp=%w", host, err, tcpErr)
	}
	return Result{Milliseconds: tcpms, Method: "tcp"}, nil
}

func isPermission(err error) bool {
	return errors.Is(err, os.ErrPermission) || errors.Is(err, ErrPermission)
}

func icmpEcho(ctx context.Context, target net.IP) (float64, error) {
	network := "ip4:icmp"
	if target.To4() == nil {
		network = "ip6:ipv6-icmp"
	}
	conn, err := net.Dial(network, target.String())
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return 0, fmt.Errorf("%w: %v", ErrPermission, err)
		}
		return 0, fmt.Errorf("ping: dial icmp: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	id := os.Getpid() & 0xffff
	payload := make([]byte, 32)
	binary.BigEndian.PutUint64(payload[:8], uint64(time.Now().UnixNano()))
	msg := buildEcho(id, payload)
	start := time.Now()
	if _, err := conn.Write(msg); err != nil {
		return 0, fmt.Errorf("ping: write icmp: %w", err)
	}

	buf := make([]byte, 1500)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return 0, fmt.Errorf("ping: read icmp: %w", err)
		}
		// IPv4 prepends the IP header; ICMPv6 does not.
		off := 0
		if buf[0]>>4 == 4 {
			off = int(buf[0]&0x0f) * 4
		}
		if n <= off+8 {
			continue
		}
		reply := buf[off:]
		if reply[0] != 0 && reply[0] != 129 { // echo reply v4 / v6
			continue
		}
		if binary.BigEndian.Uint16(reply[4:6]) != uint16(id) {
			continue
		}
		return float64(time.Since(start).Microseconds()) / 1000.0, nil
	}
}

func buildEcho(id int, payload []byte) []byte {
	msg := make([]byte, 8+len(payload))
	msg[0] = 8 // echo request
	binary.BigEndian.PutUint16(msg[4:6], uint16(id))
	binary.BigEndian.PutUint16(msg[6:8], uint16(len(payload)))
	copy(msg[8:], payload)
	binary.BigEndian.PutUint16(msg[2:4], checksum(msg))
	return msg
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(binary.BigEndian.Uint16(b[i : i+2]))
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// tcpFallback times a TCP handshake; 80 then 443 are the ports upstream uses
// when it cannot open a raw socket.
func tcpFallback(ctx context.Context, target net.IP, timeout time.Duration) (float64, error) {
	var lastErr error
	for _, port := range []string{"80", "443"} {
		d := net.Dialer{Timeout: timeout}
		start := time.Now()
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(target.String(), port))
		if err != nil {
			lastErr = err
			continue
		}
		elapsed := float64(time.Since(start).Microseconds()) / 1000.0
		_ = conn.Close()
		return elapsed, nil
	}
	return 0, lastErr
}

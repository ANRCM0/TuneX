package service

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/enfein/mieru/v3/apis/client"
	"github.com/enfein/mieru/v3/pkg/appctl/appctlpb"
	"github.com/relayx/agent/internal/gostcfg"
	"google.golang.org/protobuf/proto"
)

func TestApplyMieru(t *testing.T) {
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

	const port = 19331
	body := `{
		"services": [{
			"name": "mieru-1",
			"addr": "127.0.0.1:19331",
			"handler": {"type": "mieru"},
			"observer": "observer",
			"metadata": {"enableStats": true, "observer.resetTraffic": true},
			"listener": {"type": "mieru", "metadata": {
				"users": {"alice": "secret"},
				"protocol": "tcp",
				"mtu": 1400
			}}
		}]
	}`
	cfg, err := gostcfg.Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{})
	defer m.Close()
	results := m.Apply(cfg)
	if len(results) != 1 || !results[0].OK() {
		t.Fatalf("apply: %+v", results)
	}

	echoAddr := echo.Addr().(*net.TCPAddr)
	cli := client.NewClient()
	if err := cli.Store(&client.ClientConfig{
		Profile: &appctlpb.ClientProfile{
			ProfileName: proto.String("t"),
			User: &appctlpb.User{
				Name:     proto.String("alice"),
				Password: proto.String("secret"),
			},
			Servers: []*appctlpb.ServerEndpoint{{
				IpAddress: proto.String("127.0.0.1"),
				PortBindings: []*appctlpb.PortBinding{{
					Port:     proto.Int32(port),
					Protocol: appctlpb.TransportProtocol_TCP.Enum(),
				}},
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := cli.Start(); err != nil {
		t.Fatal(err)
	}
	defer cli.Stop()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := cli.DialContext(ctx, echoAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := io.WriteString(c, "via-mieru"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 32)
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:via-mieru" {
		t.Fatalf("got %q", buf[:n])
	}
	c.Close()
	deadline := time.Now().Add(3 * time.Second)
	var in uint64
	for time.Now().Before(deadline) {
		events := m.ObserveEvents()
		if len(events) == 1 && events[0].Service == "mieru-1" && events[0].Stats != nil && events[0].Stats.InputBytes > 0 {
			in = events[0].Stats.InputBytes
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if in == 0 {
		t.Fatal("mieru observer reported no input bytes")
	}
}

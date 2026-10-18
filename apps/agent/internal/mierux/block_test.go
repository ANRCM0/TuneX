package mierux

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/enfein/mieru/v3/apis/client"
	"github.com/enfein/mieru/v3/pkg/appctl/appctlpb"
	"google.golang.org/protobuf/proto"
)

func TestBlockBittorrent(t *testing.T) {
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	got := make(chan []byte, 1)
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
				if n > 0 {
					got <- append([]byte(nil), buf[:n]...)
				}
				if err != nil {
					return
				}
				_, _ = c.Write(append([]byte("pong:"), buf[:n]...))
			}(c)
		}
	}()

	const port = 19337
	srv := &Server{
		Port: port, Protocol: "tcp", MTU: 1400,
		Users:         map[string]string{"alice": "secret"},
		Block:         []string{"bittorrent"},
		SniffFallback: true,
	}
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

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
	blocked, err := cli.DialContext(ctx, echo.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer blocked.Close()
	hs := append([]byte{19}, []byte("BitTorrent protocol")...)
	_, _ = blocked.Write(hs)
	select {
	case b := <-got:
		t.Fatalf("bittorrent reached the target: %q", b)
	case <-time.After(800 * time.Millisecond):
	}

	ok, err := cli.DialContext(ctx, echo.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer ok.Close()
	if _, err := io.WriteString(ok, "GET / HTTP/1.0\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_ = ok.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := ok.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "pong:GET / HTTP/1.0\r\n\r\n" && n < 5 {
		t.Fatalf("got %q", buf[:n])
	}
	if string(buf[:5]) != "pong:" {
		t.Fatalf("got %q", buf[:n])
	}
}

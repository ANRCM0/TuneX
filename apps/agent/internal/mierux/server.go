// Package mierux is the panel's mieru entrance.
//
// The listener metadata is users (name to password), mtu, and protocol
// (tcp or udp; the panel default is tcp). The embedded library is
// github.com/enfein/mieru/v3 v3.36.0, the same module the upstream agent
// links. It binds the port itself (all interfaces; a host in the service
// address is not applied). Accept returns the connection after the SOCKS
// request has been read and before the response is written.
package mierux

import (
	"fmt"
	"io"
	"net"
	"strings"
	"sync"

	"github.com/enfein/mieru/v3/apis/constant"
	"github.com/enfein/mieru/v3/apis/model"
	"github.com/enfein/mieru/v3/apis/server"
	"github.com/enfein/mieru/v3/pkg/appctl/appctlpb"
	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
	"google.golang.org/protobuf/proto"
)

// Server is one mieru listener.
type Server struct {
	Port     int
	MTU      int
	Protocol string
	Users    map[string]string
	Dial     func(client net.Addr, target string) (net.Conn, error)
	Allow    func(net.Addr) bool
	Bypass   func(addr string) bool
	// Gate is the panel connection and bandwidth limit.
	Gate *limit.Gate
	// Block is handler metadata "block.protocol".
	Block []string
	// SniffFallback is metadata "sniffing.fallback". The panel sets it on mieru.
	SniffFallback bool

	mu    sync.Mutex
	srv   server.Server
	live  int
	stats forward.Stats
}

// TakeStats reports bytes copied for the panel observer.
func (s *Server) TakeStats(reset bool) (forward.Stats, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stats
	cur := s.live
	if reset {
		s.stats = forward.Stats{}
	}
	return st, cur
}

// Listen starts the mieru server and the accept loop.
func (s *Server) Listen() error {
	if s.Port < 1 || s.Port > 65535 {
		return fmt.Errorf("mieru: port %d", s.Port)
	}
	if len(s.Users) == 0 {
		return fmt.Errorf("mieru: no users")
	}
	protoID, err := transport(s.Protocol)
	if err != nil {
		return err
	}
	users := make([]*appctlpb.User, 0, len(s.Users))
	allow := proto.Bool(true)
	for name, password := range s.Users {
		if name == "" || password == "" {
			return fmt.Errorf("mieru: empty user or password")
		}
		users = append(users, &appctlpb.User{
			Name:            proto.String(name),
			Password:        proto.String(password),
			AllowPrivateIP:  allow,
			AllowLoopbackIP: allow,
		})
	}
	cfg := &appctlpb.ServerConfig{
		PortBindings: []*appctlpb.PortBinding{{
			Port:     proto.Int32(int32(s.Port)),
			Protocol: protoID,
		}},
		Users: users,
	}
	if s.MTU > 0 {
		cfg.Mtu = proto.Int32(int32(s.MTU))
	}
	srv := server.NewServer()
	if err := srv.Store(&server.ServerConfig{Config: cfg}); err != nil {
		return err
	}
	if err := srv.Start(); err != nil {
		return err
	}
	s.mu.Lock()
	s.srv = srv
	s.mu.Unlock()
	go s.loop(srv)
	return nil
}

// Close stops the server. Live proxy connections are left to finish.
func (s *Server) Close() error {
	s.mu.Lock()
	srv := s.srv
	s.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Stop()
}

func (s *Server) loop(srv server.Server) {
	for {
		c, req, err := srv.Accept()
		if err != nil {
			return
		}
		if s.Allow != nil && !s.Allow(c.RemoteAddr()) {
			_ = c.Close()
			continue
		}
		go s.serve(c, req)
	}
}

func (s *Server) serve(c net.Conn, req *model.Request) {
	defer c.Close()
	if req == nil || req.Command != constant.Socks5ConnectCmd {
		_ = writeReply(c, constant.Socks5ReplyCommandNotSupported)
		return
	}
	target := req.DstAddr.String()
	if s.Bypass != nil && s.Bypass(target) {
		_ = writeReply(c, constant.Socks5ReplyNotAllowedByRuleSet)
		return
	}
	if s.Gate != nil && !s.Gate.Enter(c.RemoteAddr()) {
		logx.Warnf("mieru: limit rejected %s", c.RemoteAddr())
		_ = writeReply(c, constant.Socks5ReplyConnectionRefused)
		return
	}
	if s.Gate != nil {
		defer s.Gate.Leave(c.RemoteAddr())
	}
	dial := s.Dial
	if dial == nil {
		dial = func(_ net.Addr, addr string) (net.Conn, error) {
			return net.Dial("tcp", addr)
		}
	}
	up, err := dial(c.RemoteAddr(), target)
	if err != nil {
		_ = writeReply(c, constant.Socks5ReplyConnectionRefused)
		return
	}
	defer up.Close()
	if err := writeReply(c, constant.Socks5ReplySuccess); err != nil {
		return
	}
	client := c
	if len(s.Block) > 0 {
		peeked, name, err := sniff.Peek(c)
		if err != nil {
			logx.Warnf("mieru: sniff: %v", err)
			return
		}
		if sniff.Reject(s.Block, s.SniffFallback, name) {
			logx.Warnf("mieru: blocked %s", name)
			return
		}
		client = peeked
	}
	s.mu.Lock()
	s.live++
	s.stats.Conns++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.live--
		s.mu.Unlock()
	}()
	in := io.Reader(client)
	out := io.Reader(up)
	if s.Gate != nil {
		in = limit.NewReader(client, s.Gate, c.RemoteAddr())
		out = limit.NewReader(up, s.Gate, c.RemoteAddr())
	}
	go func() {
		n, _ := io.Copy(up, in)
		s.addBytes(n, 0)
	}()
	n, _ := io.Copy(c, out)
	s.addBytes(0, n)
}

func (s *Server) addBytes(in, out int64) {
	s.mu.Lock()
	s.stats.In += in
	s.stats.Out += out
	s.mu.Unlock()
}

func writeReply(c net.Conn, reply byte) error {
	resp := &model.Response{Reply: reply, BindAddr: model.AddrSpec{IP: net.IPv4zero, Port: 0}}
	return resp.WriteToSocks5(c)
}

func transport(name string) (*appctlpb.TransportProtocol, error) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "", "tcp":
		return appctlpb.TransportProtocol_TCP.Enum(), nil
	case "udp":
		return appctlpb.TransportProtocol_UDP.Enum(), nil
	default:
		return nil, fmt.Errorf("mieru: protocol %q", name)
	}
}

// ParseUsers reads listener.metadata.users, a map of name to password.
func ParseUsers(raw any) (map[string]string, error) {
	obj, ok := raw.(map[string]any)
	if !ok || len(obj) == 0 {
		return nil, fmt.Errorf("mieru: users metadata is empty")
	}
	out := make(map[string]string, len(obj))
	for name, v := range obj {
		password, ok := v.(string)
		if !ok || name == "" || password == "" {
			return nil, fmt.Errorf("mieru: user %q has no password", name)
		}
		out[name] = password
	}
	return out, nil
}

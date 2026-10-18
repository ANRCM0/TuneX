package relay

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/relayx/agent/internal/logx"
	"github.com/xtaci/smux"
)

// networkTCP is go-gost/relay NetworkTCP (feature 0x04, uint16 big-endian).
const networkTCP = 0x0000

func smuxConfig() *smux.Config {
	cfg := smux.DefaultConfig()
	// go-gost/x forces smux version 1 even when the library default moves on.
	cfg.Version = 1
	return cfg
}

func networkFeature(id uint16) feature {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], id)
	return feature{typ: featureNetwork, data: b[:]}
}

// normalizeBindAddr turns a panel listen address into a host:port the entrance
// can net.Listen. An empty host means every interface. WAIT_LISTEN asks the
// entrance to pick a port.
func normalizeBindAddr(address string) string {
	if address == "" || strings.Contains(address, "WAIT_LISTEN") {
		return "0.0.0.0:0"
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "0.0.0.0:0"
	}
	if host == "" || host == "*" {
		host = "0.0.0.0"
	}
	return net.JoinHostPort(host, port)
}

func (s *Server) addBind(ln net.Listener) {
	s.mu.Lock()
	s.binds = append(s.binds, ln)
	s.mu.Unlock()
}

// serveBind is the entrance half of a remote port-forward. After the bound
// address is acknowledged, this side is the smux client: each public accept
// opens a stream, writes the peer address, then splices.
func (s *Server) serveBind(c net.Conn, feats []feature) {
	raw, err := findAddr(feats)
	if err != nil || raw == "" {
		raw = "0.0.0.0:0"
	}
	ln, err := net.Listen("tcp", normalizeBindAddr(raw))
	if err != nil {
		_ = writeMsg(c, statusServiceUnavail, nil)
		return
	}
	s.addBind(ln)
	defer ln.Close()

	bound, err := addrFeature(ln.Addr().String())
	if err != nil {
		_ = writeMsg(c, statusServiceUnavail, nil)
		return
	}
	if err := writeMsg(c, statusOK, []feature{bound}); err != nil {
		return
	}
	_ = c.SetDeadline(time.Time{})
	sess, err := smux.Client(c, smuxConfig())
	if err != nil {
		logx.Warnf("relay: bind smux: %v", err)
		return
	}
	defer sess.Close()
	logx.Infof("relay: bind on %s", ln.Addr())
	for {
		pub, err := ln.Accept()
		if err != nil {
			return
		}
		go pipeBind(sess, pub)
	}
}

func pipeBind(sess *smux.Session, pub net.Conn) {
	defer pub.Close()
	st, err := sess.OpenStream()
	if err != nil {
		return
	}
	defer st.Close()
	peer := pub.RemoteAddr().String()
	af, err := addrFeature(peer)
	if err != nil {
		return
	}
	if err := writeMsg(st, statusOK, []feature{af}); err != nil {
		return
	}
	splice(pub, st)
}

// Listener is the connector half of a TCP BIND. Accept returns one connection
// per public accept, with the peer-address response already consumed.
type Listener struct {
	sess  *smux.Session
	conn  net.Conn
	bound string
}

// Addr is the address the entrance actually bound.
func (l *Listener) Addr() net.Addr { return stringAddr(l.bound) }

// Close tears down the multiplexed session and the control connection.
func (l *Listener) Close() error {
	var err error
	if l.sess != nil {
		err = l.sess.Close()
	}
	if l.conn != nil {
		if cerr := l.conn.Close(); err == nil {
			err = cerr
		}
	}
	return err
}

// Accept waits for the next public connection.
func (l *Listener) Accept() (net.Conn, error) {
	for {
		st, err := l.sess.AcceptStream()
		if err != nil {
			return nil, err
		}
		_ = st.SetReadDeadline(time.Now().Add(15 * time.Second))
		status, _, rerr := readMsg(st)
		_ = st.SetReadDeadline(time.Time{})
		if rerr != nil || status != statusOK {
			_ = st.Close()
			continue
		}
		return st, nil
	}
}

// Bind sends CmdBind on an already-dialed relay connection and returns the
// smux server session that receives accepted public connections.
func Bind(conn net.Conn, addr, user, pass string) (*Listener, error) {
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	var feats []feature
	if user != "" || pass != "" {
		af, err := userAuthFeature(user, pass)
		if err != nil {
			return nil, err
		}
		feats = append(feats, af)
	}
	feats = append(feats, networkFeature(networkTCP))
	af, err := addrFeature(normalizeBindAddr(addr))
	if err != nil {
		return nil, err
	}
	feats = append(feats, af)
	if err := writeMsg(conn, cmdBind, feats); err != nil {
		return nil, err
	}
	status, rfeats, err := readMsg(conn)
	if err != nil {
		return nil, err
	}
	if status != statusOK {
		return nil, fmtStatus(status)
	}
	bound, err := findAddr(rfeats)
	if err != nil {
		bound = normalizeBindAddr(addr)
	}
	_ = conn.SetDeadline(time.Time{})
	sess, err := smux.Server(conn, smuxConfig())
	if err != nil {
		return nil, err
	}
	return &Listener{sess: sess, conn: conn, bound: bound}, nil
}

// DialBind dials the first hop, CONNECTs through any earlier hops, then BINDs
// on the last hop. The returned listener's Accept yields public connections.
func DialBind(hops []Hop, bindAddr string) (*Listener, error) {
	if len(hops) == 0 {
		return nil, fmt.Errorf("relay: no hop")
	}
	conn, err := (&net.Dialer{Timeout: 15 * time.Second}).Dial("tcp", hops[0].Addr)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = conn.Close()
		}
	}()
	for i, hop := range hops {
		if hop.Connector != "" && hop.Connector != "relay" {
			return nil, fmt.Errorf("relay: connector %q is not implemented", hop.Connector)
		}
		if i+1 < len(hops) {
			if err := Handshake(conn, hops[i+1].Addr, hop.Username, hop.Password); err != nil {
				return nil, err
			}
		}
	}
	last := hops[len(hops)-1]
	ln, err := Bind(conn, bindAddr, last.Username, last.Password)
	if err != nil {
		return nil, err
	}
	ok = true
	return ln, nil
}

type stringAddr string

func (a stringAddr) Network() string { return "tcp" }
func (a stringAddr) String() string  { return string(a) }

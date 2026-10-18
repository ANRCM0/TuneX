package relayx

import (
	"io"
	"net"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xtaci/smux"
)

// wsConn presents one websocket as a stream. Each Write is one binary message.
// Read spans messages. gorilla allows one reader and one writer, which is what
// smux uses.
type wsConn struct {
	ws *websocket.Conn
	r  io.Reader
}

func (c *wsConn) Read(p []byte) (int, error) {
	for {
		if c.r == nil {
			_, r, err := c.ws.NextReader()
			if err != nil {
				return 0, err
			}
			c.r = r
		}
		n, err := c.r.Read(p)
		if err == io.EOF {
			c.r = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := c.ws.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (c *wsConn) Close() error { return c.ws.Close() }

func (c *wsConn) LocalAddr() net.Addr  { return c.ws.LocalAddr() }
func (c *wsConn) RemoteAddr() net.Addr { return c.ws.RemoteAddr() }

func (c *wsConn) SetDeadline(t time.Time) error {
	_ = c.ws.SetReadDeadline(t)
	return c.ws.SetWriteDeadline(t)
}

func (c *wsConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

func smuxConfig() *smux.Config {
	cfg := smux.DefaultConfig()
	cfg.Version = 1
	return cfg
}

// streamConn is one smux stream. A shared session stays open when the stream
// closes so the next dial can reuse it. A private session is closed with the
// stream.
type streamConn struct {
	*smux.Stream
	session *smux.Session
	shared  bool
}

func (c *streamConn) Close() error {
	err := c.Stream.Close()
	if !c.shared {
		_ = c.session.Close()
	}
	return err
}

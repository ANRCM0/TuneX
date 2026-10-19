// Package socketio implements the client half of the Socket.IO v4 protocol on
// top of an Engine.IO v4 WebSocket transport.
//
// The upstream agent ships the socket.io Go client; this replica re-implements
// the wire protocol directly over github.com/gorilla/websocket so the framing
// is explicit and testable. Only the subset the agent needs is implemented:
// the default namespace, text frames, EVENTS in both directions, and ACK
// callbacks (which the panel's `register`/`listen`/`sysinfo` handlers use).
package socketio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/relayx/agent/internal/logx"
)

// Engine.IO packet types (EIO=4).
const (
	engineOpen    = '0'
	engineClose   = '1'
	enginePing    = '2'
	enginePong    = '3'
	engineMessage = '4'
	engineUpgrade = '5'
	engineNoop    = '6'
)

// Socket.IO packet types.
const (
	sioConnect      = '0'
	sioDisconnect   = '1'
	sioEvent        = '2'
	sioAck          = '3'
	sioConnectError = '4'
	sioBinaryEvent  = '5'
	sioBinaryAck    = '6'
)

// Handler receives the decoded arguments of one event. If the sender requested
// an acknowledgement and the handler returns a non-nil reply, the reply is sent
// back as an ACK packet. A non-nil error is turned into an
// `{"error": "..."}` acknowledgement body.
type Handler func(args []json.RawMessage) (any, error)

// ErrClosed is returned once the connection is gone.
var ErrClosed = errors.New("socket.io: client closed")

type pendingAck struct {
	ch chan []json.RawMessage
}

// Client is a connected Socket.IO v4 client on a single namespace.
type Client struct {
	rawURL    string
	namespace string
	auth      any
	header    http.Header

	conn *websocket.Conn
	sid  string

	writeMu sync.Mutex

	mu       sync.RWMutex
	handlers map[string]Handler

	ackMu   sync.Mutex
	nextAck int
	acks    map[int]*pendingAck

	closeOnce sync.Once
	done      chan struct{}
	errMu     sync.Mutex
	err       error

	pingInterval time.Duration
	pingTimeout  time.Duration
	lastSeenMu   sync.Mutex
	lastSeen     time.Time

	connected chan struct{}
}

// Config controls Dial.
type Config struct {
	// URL is the Socket.IO endpoint, e.g. "http://127.0.0.1:3000/socket.io".
	URL string
	// Namespace defaults to "/".
	Namespace string
	// Auth is the Socket.IO CONNECT payload (socket.io v4 `auth`).
	Auth any
	// Header is sent with the HTTP upgrade request.
	Header http.Header
	// DialTimeout bounds the TCP+WS upgrade. Defaults to 10s.
	DialTimeout time.Duration
}

// Dial performs the Engine.IO handshake and the Socket.IO namespace CONNECT.
func Dial(ctx context.Context, cfg Config) (*Client, error) {
	if cfg.URL == "" {
		return nil, errors.New("socketio: empty URL")
	}
	if cfg.Namespace == "" {
		cfg.Namespace = "/"
	}
	if cfg.DialTimeout == 0 {
		cfg.DialTimeout = 10 * time.Second
	}

	wsURL, err := websocketURL(cfg.URL)
	if err != nil {
		return nil, err
	}

	header := http.Header{}
	for k, vs := range cfg.Header {
		for _, v := range vs {
			header.Add(k, v)
		}
	}

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = cfg.DialTimeout
	conn, resp, err := dialer.DialContext(ctx, wsURL, header)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("socketio: dial %s: %w (http %d)", wsURL, err, resp.StatusCode)
		}
		return nil, fmt.Errorf("socketio: dial %s: %w", wsURL, err)
	}

	c := &Client{
		rawURL:       cfg.URL,
		namespace:    cfg.Namespace,
		auth:         cfg.Auth,
		header:       header,
		conn:         conn,
		handlers:     map[string]Handler{},
		acks:         map[int]*pendingAck{},
		done:         make(chan struct{}),
		connected:    make(chan struct{}),
		pingInterval: 25 * time.Second,
		pingTimeout:  20 * time.Second,
	}

	if err := c.handshake(); err != nil {
		_ = conn.Close()
		return nil, err
	}

	go c.readLoop()
	return c, nil
}

func websocketURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("socketio: bad URL %q: %w", raw, err)
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("socketio: unsupported scheme %q", u.Scheme)
	}
	if !strings.HasSuffix(u.Path, "/socket.io") && !strings.HasSuffix(u.Path, "/socket.io/") {
		u.Path = strings.TrimSuffix(u.Path, "/") + "/socket.io/"
	} else if !strings.HasSuffix(u.Path, "/") {
		u.Path += "/"
	}
	q := u.Query()
	q.Set("EIO", "4")
	q.Set("transport", "websocket")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// handshake consumes the Engine.IO OPEN packet and performs the Socket.IO
// CONNECT for the configured namespace (if it is not the default, which is
// connected implicitly by Engine.IO in most server implementations).
func (c *Client) handshake() error {
	_ = c.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	_, data, err := c.conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("socketio: read engine.io open: %w", err)
	}
	if len(data) == 0 || data[0] != engineOpen {
		return fmt.Errorf("socketio: expected engine.io OPEN, got %q", truncate(data, 120))
	}
	var open struct {
		SID          string `json:"sid"`
		PingInterval int    `json:"pingInterval"`
		PingTimeout  int    `json:"pingTimeout"`
	}
	if err := json.Unmarshal(data[1:], &open); err != nil {
		return fmt.Errorf("socketio: parse engine.io open: %w", err)
	}
	c.sid = open.SID
	if open.PingInterval > 0 {
		c.pingInterval = time.Duration(open.PingInterval) * time.Millisecond
	}
	if open.PingTimeout > 0 {
		c.pingTimeout = time.Duration(open.PingTimeout) * time.Millisecond
	}
	c.touch()
	logx.Debugf("socketio: engine.io open sid=%s pingInterval=%s pingTimeout=%s", c.sid, c.pingInterval, c.pingTimeout)

	// Socket.IO CONNECT: 40[<namespace>,]<auth json>
	connect := "40"
	if c.namespace != "/" {
		connect = "40" + c.namespace + ","
	}
	if c.auth != nil {
		b, err := json.Marshal(c.auth)
		if err != nil {
			return fmt.Errorf("socketio: marshal auth: %w", err)
		}
		connect += string(b)
	}
	if err := c.writeRaw(connect); err != nil {
		return err
	}

	// Wait for 40 (connected) or 44 (connect_error).
	deadline := time.Now().Add(30 * time.Second)
	for {
		if err := c.conn.SetReadDeadline(deadline); err != nil {
			return err
		}
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("socketio: read connect ack: %w", err)
		}
		if len(data) < 2 || data[0] != engineMessage {
			continue
		}
		switch rune(data[1]) {
		case sioConnect:
			close(c.connected)
			_ = c.conn.SetReadDeadline(time.Time{})
			return nil
		case sioConnectError:
			return fmt.Errorf("socketio: connect_error: %s", truncate(data[2:], 200))
		default:
			// Ignore stray traffic during the handshake.
		}
	}
}

func (c *Client) touch() {
	c.lastSeenMu.Lock()
	c.lastSeen = time.Now()
	c.lastSeenMu.Unlock()
}

// SID returns the Engine.IO session id assigned by the server.
func (c *Client) SID() string { return c.sid }

// ID returns the Socket.IO namespace session id (the Engine.IO sid unless the
// server sends a distinct one).
func (c *Client) ID() string { return c.sid }

// Done is closed when the connection is closed or lost.
func (c *Client) Done() <-chan struct{} { return c.done }

// Err returns the terminal error, if any.
func (c *Client) Err() error {
	c.errMu.Lock()
	defer c.errMu.Unlock()
	return c.err
}

// Closed reports whether the client has shut down.
func (c *Client) Closed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// Connected is closed once the namespace CONNECT was acknowledged.
func (c *Client) Connected() <-chan struct{} { return c.connected }

// On registers a handler for an event name.
func (c *Client) On(event string, h Handler) {
	c.mu.Lock()
	c.handlers[event] = h
	c.mu.Unlock()
}

func (c *Client) handler(event string) (Handler, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	h, ok := c.handlers[event]
	return h, ok
}

// Emit sends an event with the given arguments. No acknowledgement is expected.
func (c *Client) Emit(event string, args ...any) error {
	packet, err := buildEvent(event, -1, args)
	if err != nil {
		return err
	}
	logx.Debugf("socketio: <- %s", truncate([]byte(packet), 400))
	return c.writeRaw(packet)
}

// EmitWithAck sends an event and waits for the server's ACK body.
func (c *Client) EmitWithAck(ctx context.Context, event string, args ...any) ([]json.RawMessage, error) {
	c.ackMu.Lock()
	id := c.nextAck
	c.nextAck++
	p := &pendingAck{ch: make(chan []json.RawMessage, 1)}
	c.acks[id] = p
	c.ackMu.Unlock()

	defer func() {
		c.ackMu.Lock()
		delete(c.acks, id)
		c.ackMu.Unlock()
	}()

	packet, err := buildEvent(event, id, args)
	if err != nil {
		return nil, err
	}
	logx.Debugf("socketio: <- %s", truncate([]byte(packet), 400))
	if err := c.writeRaw(packet); err != nil {
		return nil, err
	}

	select {
	case body := <-p.ch:
		return body, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, ErrClosed
	}
}

func buildEvent(event string, ackID int, args []any) (string, error) {
	payload := make([]any, 0, len(args)+1)
	payload = append(payload, event)
	payload = append(payload, args...)
	b, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("socketio: marshal event %q: %w", event, err)
	}
	sb := strings.Builder{}
	sb.WriteByte(engineMessage)
	sb.WriteByte(sioEvent)
	if ackID >= 0 {
		sb.WriteString(strconv.Itoa(ackID))
	}
	sb.Write(b)
	return sb.String(), nil
}

func (c *Client) writeRaw(s string) error {
	select {
	case <-c.done:
		return ErrClosed
	default:
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, []byte(s))
}

// Ping sends an Engine.IO PING (the agent-side keepalive; the server also pings).
func (c *Client) Ping() error { return c.writeRaw("2") }

// Close performs a clean Socket.IO DISCONNECT + Engine.IO CLOSE.
func (c *Client) Close() error {
	var err error
	c.closeOnce.Do(func() {
		_ = c.writeRaw("41")
		_ = c.writeRaw("1")
		err = c.conn.Close()
		close(c.done)
	})
	return err
}

func (c *Client) fail(err error) {
	c.errMu.Lock()
	if c.err == nil {
		c.err = err
	}
	c.errMu.Unlock()
	c.closeOnce.Do(func() {
		_ = c.conn.Close()
		close(c.done)
	})
}

func (c *Client) readLoop() {
	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(c.pingInterval + c.pingTimeout + 10*time.Second))
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			select {
			case <-c.done:
				return
			default:
			}
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				c.fail(nil)
			} else {
				c.fail(err)
			}
			return
		}
		c.touch()
		c.dispatch(data)
	}
}

func (c *Client) dispatch(data []byte) {
	if len(data) == 0 {
		return
	}
	switch rune(data[0]) {
	case enginePing:
		// Engine.IO v4: the server pings, the client pongs with the same payload.
		_ = c.writeRaw("3" + string(data[1:]))
	case enginePong, engineNoop:
	case engineClose:
		c.emitDisconnect()
		c.fail(nil)
	case engineMessage:
		if len(data) < 2 {
			return
		}
		c.dispatchSocketIO(data[1:])
	default:
		logx.Debugf("socketio: unhandled engine.io packet %q", truncate(data, 80))
	}
}

// emitDisconnect runs a registered "disconnect" handler, mirroring the
// socket.io client which emits the event before the connection is torn down.
// The handler's reply and error are ignored: the transport is already gone.
func (c *Client) emitDisconnect() {
	if h, ok := c.handler("disconnect"); ok {
		_, _ = h(nil)
	}
}

func (c *Client) dispatchSocketIO(data []byte) {
	if len(data) == 0 {
		return
	}
	switch rune(data[0]) {
	case sioConnect:
		logx.Debugf("socketio: namespace connected %s", truncate(data[1:], 120))
	case sioDisconnect:
		c.emitDisconnect()
		c.fail(nil)
	case sioEvent:
		c.handleEvent(data[1:])
	case sioAck:
		c.handleAck(data[1:])
	case sioConnectError:
		c.fail(fmt.Errorf("socketio: connect_error: %s", truncate(data[1:], 200)))
	case sioBinaryEvent, sioBinaryAck:
		logx.Warnf("socketio: binary packets are not supported by the replica agent")
	default:
		logx.Debugf("socketio: unhandled socket.io packet %q", truncate(data, 80))
	}
}

// handleEvent parses `[<ackID>]["name",args...]` and runs the registered
// handler, replying with an ACK if the sender asked for one.
func (c *Client) handleEvent(data []byte) {
	ackID := -1
	i := 0
	for i < len(data) && data[i] >= '0' && data[i] <= '9' {
		i++
	}
	if i > 0 {
		n, err := strconv.Atoi(string(data[:i]))
		if err != nil {
			logx.Warnf("socketio: bad ack id in %q", truncate(data, 80))
			return
		}
		ackID = n
	}
	body := data[i:]
	var args []json.RawMessage
	if err := json.Unmarshal(body, &args); err != nil {
		logx.Warnf("socketio: bad event payload %q: %v", truncate(body, 200), err)
		return
	}
	if len(args) == 0 {
		return
	}
	var name string
	if err := json.Unmarshal(args[0], &name); err != nil {
		logx.Warnf("socketio: event name is not a string: %q", truncate(args[0], 80))
		return
	}
	payload := args[1:]
	logx.Debugf("socketio: -> event %q args=%s", name, truncate(joinRaw(payload), 600))

	h, ok := c.handler(name)
	if !ok {
		logx.Debugf("socketio: no handler for event %q", name)
		if ackID >= 0 {
			_ = c.writeRaw(ackPacket(ackID, []any{}))
		}
		return
	}
	reply, err := h(payload)
	if ackID < 0 {
		return
	}
	if err != nil {
		_ = c.writeRaw(ackPacket(ackID, []any{map[string]any{"error": err.Error()}}))
		return
	}
	if reply == nil {
		reply = map[string]any{}
	}
	_ = c.writeRaw(ackPacket(ackID, []any{reply}))
}

func ackPacket(ackID int, body []any) string {
	// A nil slice marshals to `null`; the protocol expects an argument array,
	// so normalise it before encoding.
	if body == nil {
		body = []any{}
	}
	b, err := json.Marshal(body)
	if err != nil {
		b = []byte("[]")
	}
	return string([]byte{engineMessage, sioAck}) + strconv.Itoa(ackID) + string(b)
}

func (c *Client) handleAck(data []byte) {
	i := 0
	for i < len(data) && data[i] >= '0' && data[i] <= '9' {
		i++
	}
	if i == 0 {
		logx.Warnf("socketio: ack without id: %q", truncate(data, 80))
		return
	}
	id, err := strconv.Atoi(string(data[:i]))
	if err != nil {
		return
	}
	var args []json.RawMessage
	if err := json.Unmarshal(data[i:], &args); err != nil {
		logx.Warnf("socketio: bad ack body %q: %v", truncate(data, 120), err)
		return
	}
	c.ackMu.Lock()
	p := c.acks[id]
	c.ackMu.Unlock()
	if p == nil {
		logx.Debugf("socketio: ack %d has no waiter", id)
		return
	}
	logx.Debugf("socketio: -> ack %d %s", id, truncate(joinRaw(args), 400))
	select {
	case p.ch <- args:
	default:
	}
}

func joinRaw(args []json.RawMessage) []byte {
	var sb strings.Builder
	for i, a := range args {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.Write(a)
	}
	return []byte(sb.String())
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}

// Backoff returns the reconnect delay for attempt n (0-based) with jitter,
// mirroring socket.io-client's default reconnection policy (1s base, 5s max,
// factor 2, ±50% jitter).
func Backoff(attempt int) time.Duration {
	const base = time.Second
	const max = 5 * time.Second
	d := base
	for i := 0; i < attempt && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	jitter := time.Duration(rand.Int63n(int64(d/2 + 1)))
	return d - d/4 + jitter
}

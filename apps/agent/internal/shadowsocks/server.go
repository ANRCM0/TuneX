// Package shadowsocks implements the shadowsocks AEAD TCP/UDP server used for
// the node's `ss` tunnels.
//
// Upstream links github.com/shadowsocks/go-shadowsocks2; the replica implements
// the same wire format directly so the dependency set stays minimal. The methods
// implemented are exactly the panel's ALLOWED_SHADOWSOCKS_METHODS
// (apps/backend/src/schemas/request.ts:48-52):
//
//	chacha20-ietf-poly1305, aes-128-gcm, aes-256-gcm
//
// Wire format (shadowsocks AEAD, TCP, both directions):
//
//	[salt][len+tag][payload+tag]...
//
// where len is a big-endian uint16 of the *plaintext* chunk length (max 0x3FFF),
// the master key comes from EVP_BytesToKey(MD5, password) and the per-session
// subkey from HKDF-SHA1(master, salt, "ss-subkey"). UDP is a separate packet
// format in udp.go (one salt and one AEAD blob per datagram, no length prefix).
package shadowsocks

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"golang.org/x/crypto/chacha20poly1305"

	"github.com/relayx/agent/internal/forward"
	"github.com/relayx/agent/internal/limit"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/sniff"
	"github.com/relayx/agent/internal/socksaddr"
)

// MaxChunk is the maximum plaintext chunk size for shadowsocks AEAD.
const MaxChunk = 0x3FFF

const hkdfInfo = "ss-subkey"

type method struct {
	keySize  int
	saltSize int
	newAEAD  func(key []byte) (cipher.AEAD, error)
}

var methods = map[string]method{
	"chacha20-ietf-poly1305": {
		keySize:  32,
		saltSize: 32,
		newAEAD:  chacha20poly1305.New,
	},
	"aes-128-gcm": {
		keySize:  16,
		saltSize: 16,
		newAEAD:  newGCM,
	},
	"aes-256-gcm": {
		keySize:  32,
		saltSize: 32,
		newAEAD:  newGCM,
	},
	// gost names the no-auth UDP hop "ssu" and, when a cipher is required,
	// accepts method "none": 16-byte salt, then the plaintext. Not a panel cipher.
	"none": {
		keySize:  0,
		saltSize: 16,
		newAEAD:  func([]byte) (cipher.AEAD, error) { return noopAEAD{}, nil },
	},
}

// noopAEAD is the gost "none"/"dummy" shadowsocks cipher: no tag, no nonce.
type noopAEAD struct{}

func (noopAEAD) NonceSize() int { return 0 }
func (noopAEAD) Overhead() int  { return 0 }
func (noopAEAD) Seal(dst, nonce, plaintext, additionalData []byte) []byte {
	return append(dst, plaintext...)
}
func (noopAEAD) Open(dst, nonce, ciphertext, additionalData []byte) ([]byte, error) {
	return append(dst, ciphertext...), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(blk)
}

// AllowedMethods lists the ciphers the replica accepts, mirroring the panel.
var AllowedMethods = []string{"chacha20-ietf-poly1305", "aes-128-gcm", "aes-256-gcm"}

// Supported reports whether name is a shadowsocks method the replica implements.
func Supported(name string) bool {
	_, ok := methods[name]
	return ok
}

// MasterKey derives the shadowsocks master key from a password using the
// EVP_BytesToKey construction (MD5, no salt) that shadowsocks uses.
func MasterKey(password string, keySize int) []byte {
	var key []byte
	var prev []byte
	for len(key) < keySize {
		h := md5.New()
		h.Write(prev)
		h.Write([]byte(password))
		prev = h.Sum(nil)
		key = append(key, prev...)
	}
	return key[:keySize]
}

// SubKey derives the per-session subkey.
func SubKey(master, salt []byte, keySize int) ([]byte, error) {
	return hkdf.Key(sha1.New, master, salt, hkdfInfo, keySize)
}

// Server is a shadowsocks AEAD listener bound to one port.
type Server struct {
	Method   string
	Password string
	OnStats  func(in, out int64, conns int)
	// Block is handler metadata "block.protocol". A recognized protocol in the
	// first plaintext after the SOCKS address is not dialled.
	Block []string
	// SniffFallback is metadata "sniffing.fallback".
	SniffFallback bool
	// Allow rejects a remote address that fails the panel admission list.
	Allow func(net.Addr) bool
	// Bypass reports that the SOCKS destination must not be dialled.
	Bypass func(addr string) bool
	// Gate is the panel connection and bandwidth limit.
	Gate *limit.Gate
	// ProxyV1 requires a HAProxy PROXY v1 header before the AEAD salt.
	ProxyV1 bool

	ln     net.Listener
	m      method
	master []byte

	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}
	stats  forward.Stats
}

// TakeStats reports bytes copied for the panel observer.
func (s *Server) TakeStats(reset bool) (forward.Stats, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.stats
	cur := len(s.conns)
	if reset {
		s.stats = forward.Stats{}
	}
	return st, cur
}

// New prepares a shadowsocks server for the given method/password. It returns an
// error for a method outside ALLOWED_SHADOWSOCKS_METHODS so the panel gets an
// explicit rejection instead of a silent no-op.
func New(method, password string) (*Server, error) {
	m, ok := methods[method]
	if !ok {
		return nil, fmt.Errorf("shadowsocks: unsupported method %q (allowed: %v)", method, AllowedMethods)
	}
	if password == "" {
		return nil, errors.New("shadowsocks: empty password")
	}
	return &Server{
		Method:   method,
		Password: password,
		m:        m,
		master:   MasterKey(password, m.keySize),
		conns:    map[net.Conn]struct{}{},
	}, nil
}

// Listen binds addr and starts accepting.
func (s *Server) Listen(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.ln = ln
	go s.acceptLoop()
	return nil
}

// Addr returns the bound address.
func (s *Server) Addr() net.Addr {
	if s.ln == nil {
		return nil
	}
	return s.ln.Addr()
}

// Close stops accepting and closes live connections.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	conns := make([]net.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	ln := s.ln
	s.mu.Unlock()

	if ln != nil {
		_ = ln.Close()
	}
	for _, c := range conns {
		_ = c.Close()
	}
	return nil
}

func netTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (s *Server) acceptLoop() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			s.mu.Lock()
			closed := s.closed
			s.mu.Unlock()
			if !closed {
				logx.Warnf("shadowsocks: accept on %s: %v", s.ln.Addr(), err)
			}
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			_ = c.Close()
			return
		}
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		go s.handle(c)
	}
}

func (s *Server) handle(c net.Conn) {
	defer func() {
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
		_ = c.Close()
	}()

	if s.Allow != nil && !s.Allow(c.RemoteAddr()) {
		logx.Warnf("shadowsocks: admission rejected %s", c.RemoteAddr())
		return
	}
	if s.Gate != nil && !s.Gate.Enter(c.RemoteAddr()) {
		logx.Warnf("shadowsocks: limit rejected %s", c.RemoteAddr())
		return
	}
	if s.Gate != nil {
		defer s.Gate.Leave(c.RemoteAddr())
	}
	if s.ProxyV1 {
		wrapped, err := forward.ConsumeProxyV1(c)
		if err != nil {
			logx.Warnf("shadowsocks: proxy protocol: %v", err)
			return
		}
		c = wrapped
	}
	_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
	rc, err := s.newReader(c)
	if err != nil {
		logx.Debugf("shadowsocks: handshake from %s failed: %v", c.RemoteAddr(), err)
		return
	}
	// The first plaintext chunk begins with the SOCKS5 destination address.
	head := make([]byte, 512)
	n, err := rc.Read(head)
	if err != nil {
		logx.Debugf("shadowsocks: read %s request: %v", c.RemoteAddr(), err)
		return
	}
	dst, used, err := socksaddr.Parse(head[:n])
	if err != nil {
		logx.Debugf("shadowsocks: bad destination from %s: %v", c.RemoteAddr(), err)
		return
	}
	rest := append([]byte(nil), head[used:n]...)
	if len(s.Block) > 0 {
		if len(rest) < 20 {
			_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			more := make([]byte, 64)
			n, err := rc.Read(more)
			if n > 0 {
				rest = append(rest, more[:n]...)
			} else if err != nil && !netTimeout(err) {
				return
			}
		}
		if name := sniff.Detect(rest); sniff.Reject(s.Block, s.SniffFallback, name) {
			logx.Warnf("shadowsocks: blocked %s", name)
			return
		}
	}

	if s.Bypass != nil && s.Bypass(dst.String()) {
		logx.Warnf("shadowsocks: bypass %s", dst)
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	target, err := net.DialTimeout("tcp", dst.String(), 15*time.Second)
	if err != nil {
		logx.Warnf("shadowsocks: dial %s: %v", dst, err)
		return
	}
	defer target.Close()

	if len(rest) > 0 {
		if _, err := target.Write(rest); err != nil {
			return
		}
	}

	var in, out int64
	done := make(chan struct{}, 2)
	go func() {
		n, _ := io.Copy(target, limit.NewReader(rc, s.Gate, c.RemoteAddr()))
		in = n
		if tc, ok := target.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		done <- struct{}{}
	}()
	go func() {
		wc, err := s.newWriter(c)
		if err != nil {
			done <- struct{}{}
			return
		}
		n, _ := io.Copy(wc, limit.NewReader(target, s.Gate, c.RemoteAddr()))
		out = n
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
		done <- struct{}{}
	}()
	<-done
	<-done
	s.mu.Lock()
	s.stats.Conns++
	s.stats.In += in + int64(len(rest))
	s.stats.Out += out
	s.mu.Unlock()
	if s.OnStats != nil {
		s.OnStats(in, out, 1)
	}
}

// newReader derives the session subkey from the salt the client sent and wraps
// c in a chunk-decrypting reader.
func (s *Server) newReader(c net.Conn) (io.Reader, error) {
	salt := make([]byte, s.m.saltSize)
	if _, err := io.ReadFull(c, salt); err != nil {
		return nil, fmt.Errorf("read salt: %w", err)
	}
	subkey, err := SubKey(s.master, salt, s.m.keySize)
	if err != nil {
		return nil, err
	}
	aead, err := s.m.newAEAD(subkey)
	if err != nil {
		return nil, err
	}
	return &chunkReader{r: c, aead: aead, nonce: make([]byte, aead.NonceSize())}, nil
}

// newWriter mirrors newReader for the server->client direction: it writes a
// fresh salt and then frames the payload into AEAD chunks.
func (s *Server) newWriter(c net.Conn) (io.Writer, error) {
	salt := make([]byte, s.m.saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("shadowsocks: salt: %w", err)
	}
	if _, err := c.Write(salt); err != nil {
		return nil, fmt.Errorf("shadowsocks: write salt: %w", err)
	}
	subkey, err := SubKey(s.master, salt, s.m.keySize)
	if err != nil {
		return nil, err
	}
	aead, err := s.m.newAEAD(subkey)
	if err != nil {
		return nil, err
	}
	return &chunkWriter{w: c, aead: aead, nonce: make([]byte, aead.NonceSize())}, nil
}

type chunkReader struct {
	r     io.Reader
	aead  cipher.AEAD
	nonce []byte
	buf   []byte
}

func (cr *chunkReader) Read(p []byte) (int, error) {
	if len(cr.buf) == 0 {
		if err := cr.fill(); err != nil {
			return 0, err
		}
	}
	n := copy(p, cr.buf)
	cr.buf = cr.buf[n:]
	return n, nil
}

func (cr *chunkReader) fill() error {
	overhead := cr.aead.Overhead()
	lenBuf := make([]byte, 2+overhead)
	if _, err := io.ReadFull(cr.r, lenBuf); err != nil {
		return err
	}
	plain, err := cr.aead.Open(nil, cr.nonce, lenBuf, nil)
	if err != nil {
		return fmt.Errorf("shadowsocks: decrypt length: %w", err)
	}
	cr.incrementNonce()
	size := int(binary.BigEndian.Uint16(plain))
	if size == 0 || size > MaxChunk {
		return fmt.Errorf("shadowsocks: invalid chunk size %d", size)
	}
	payload := make([]byte, size+overhead)
	if _, err := io.ReadFull(cr.r, payload); err != nil {
		return err
	}
	out, err := cr.aead.Open(nil, cr.nonce, payload, nil)
	if err != nil {
		return fmt.Errorf("shadowsocks: decrypt payload: %w", err)
	}
	cr.incrementNonce()
	cr.buf = out
	return nil
}

func (cr *chunkReader) incrementNonce() {
	for i := range cr.nonce {
		cr.nonce[i]++
		if cr.nonce[i] != 0 {
			return
		}
	}
}

// chunkWriter encrypts a plaintext stream into shadowsocks AEAD chunks. It is
// used for the UDP-style / testing direction and by the client-side helper.
type chunkWriter struct {
	w       io.Writer
	aead    cipher.AEAD
	nonce   []byte
	scratch []byte
}

// NewReader builds a shadowsocks AEAD stream reader for the client side: it
// consumes the salt the server wrote and returns a chunk-decrypting reader.
// Used by the loopback/self-test client and by any Go caller that needs to speak
// shadowsocks.
func NewReader(r io.Reader, method, password string) (io.Reader, error) {
	m, ok := methods[method]
	if !ok {
		return nil, fmt.Errorf("shadowsocks: unsupported method %q", method)
	}
	salt := make([]byte, m.saltSize)
	if _, err := io.ReadFull(r, salt); err != nil {
		return nil, fmt.Errorf("shadowsocks: read salt: %w", err)
	}
	subkey, err := SubKey(MasterKey(password, m.keySize), salt, m.keySize)
	if err != nil {
		return nil, err
	}
	aead, err := m.newAEAD(subkey)
	if err != nil {
		return nil, err
	}
	return &chunkReader{r: r, aead: aead, nonce: make([]byte, aead.NonceSize())}, nil
}

// NewWriter builds a shadowsocks AEAD stream writer, writing a fresh random salt
// first. Used by the loopback/self-test client.
func NewWriter(w io.Writer, method, password string) (io.WriteCloser, error) {
	m, ok := methods[method]
	if !ok {
		return nil, fmt.Errorf("shadowsocks: unsupported method %q", method)
	}
	salt := make([]byte, m.saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	if _, err := w.Write(salt); err != nil {
		return nil, err
	}
	subkey, err := SubKey(MasterKey(password, m.keySize), salt, m.keySize)
	if err != nil {
		return nil, err
	}
	aead, err := m.newAEAD(subkey)
	if err != nil {
		return nil, err
	}
	return &chunkWriter{w: w, aead: aead, nonce: make([]byte, aead.NonceSize())}, nil
}

func (cw *chunkWriter) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := len(p)
		if n > MaxChunk {
			n = MaxChunk
		}
		chunk := p[:n]
		var lenBuf [2]byte
		binary.BigEndian.PutUint16(lenBuf[:], uint16(n))
		encLen := cw.aead.Seal(nil, cw.nonce, lenBuf[:], nil)
		cw.incrementNonce()
		encPayload := cw.aead.Seal(nil, cw.nonce, chunk, nil)
		cw.incrementNonce()
		if _, err := cw.w.Write(encLen); err != nil {
			return total, err
		}
		if _, err := cw.w.Write(encPayload); err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}

func (cw *chunkWriter) Close() error { return nil }

func (cw *chunkWriter) incrementNonce() {
	for i := range cw.nonce {
		cw.nonce[i]++
		if cw.nonce[i] != 0 {
			return
		}
	}
}

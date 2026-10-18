// Package realityx is the REALITY transport the panel pairs with VLESS.
//
// The listener is github.com/xtls/reality: it dials metadata.dest, checks a
// Chrome ClientHello that offers X25519MLKEM768, and opens the session id
// with AES-GCM. The key is HKDF-SHA256 of the X25519 shared secret, salt
// ClientHello.Random[:20], info "REALITY". The 16-byte plaintext is
// 3 version bytes, one reserved byte, a uint32 unix time and an 8-byte
// short id. The dialer seals that blob with uTLS HelloChrome_Auto (Chrome
// 133). xtls-rprx-vision padding is not handled here; VLESS framing is the
// vless package.
package realityx

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"github.com/xtls/reality"
)

// ServerConfig is the listener metadata the panel emits.
type ServerConfig struct {
	PrivateKey string
	Dest       string
	ShortID    string
}

// Listen accepts REALITY connections on addr. Dest must already accept TLS
// 1.3; the library dials it before the handshake and probes it in the
// background.
func Listen(addr string, cfg ServerConfig) (net.Listener, error) {
	rc, err := serverConfig(cfg)
	if err != nil {
		return nil, err
	}
	inner, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	return reality.NewListener(inner, rc), nil
}

func serverConfig(cfg ServerConfig) (*reality.Config, error) {
	dest := strings.TrimSpace(cfg.Dest)
	if dest == "" {
		dest = "www.apple.com:443"
	}
	if !strings.Contains(dest, ":") {
		dest += ":443"
	}
	host, _, err := net.SplitHostPort(dest)
	if err != nil {
		return nil, fmt.Errorf("reality: dest: %w", err)
	}
	raw, err := decodeKey(cfg.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("reality: privateKey: %w", err)
	}
	priv, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("reality: privateKey: %w", err)
	}
	sid, err := DecodeShortID(cfg.ShortID)
	if err != nil {
		return nil, err
	}
	// RFC 6066 forbids an IP address in SNI, so a client aimed at an IP dest
	// sends an empty server name. Accept both.
	names := map[string]bool{host: true}
	if net.ParseIP(host) != nil {
		names[""] = true
	}
	return &reality.Config{
		DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
		// A real New Session Ticket is a different size from dest's, so the
		// library's padding math (handshakeLen[6] minus our record) goes
		// negative and the handshake aborts. Dest's ticket is already
		// mimicked by the library's one-byte record, which encrypt() turns
		// into an empty application-data record of the same length.
		SessionTicketsDisabled: true,
		Type:                   "tcp",
		Dest:                   dest,
		ServerNames:            names,
		PrivateKey:             priv,
		ShortIds:               map[[8]byte]bool{sid: true},
	}, nil
}

// ClientConfig is what a VLESS URL carries (public key, short id, SNI).
type ClientConfig struct {
	PublicKey  string
	ShortID    string
	ServerName string
}

// Dial performs the REALITY handshake and returns the inner connection.
func Dial(addr string, cfg ClientConfig) (net.Conn, error) {
	pubRaw, err := decodeKey(cfg.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("reality: publicKey: %w", err)
	}
	pub, err := ecdh.X25519().NewPublicKey(pubRaw)
	if err != nil {
		return nil, fmt.Errorf("reality: publicKey: %w", err)
	}
	sid, err := DecodeShortID(cfg.ShortID)
	if err != nil {
		return nil, err
	}
	raw, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, err
	}
	sni := cfg.ServerName
	if sni == "" {
		sni, _, _ = net.SplitHostPort(addr)
	}
	uconn := utls.UClient(raw, &utls.Config{
		ServerName:         sni,
		NextProtos:         []string{"h2", "http/1.1"},
		InsecureSkipVerify: true,
	}, utls.HelloChrome_Auto)
	if err := sealSessionID(uconn, pub, sid); err != nil {
		_ = raw.Close()
		return nil, err
	}
	if err := uconn.Handshake(); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("reality: handshake: %w", err)
	}
	return uconn, nil
}

// sealSessionID writes the REALITY authenticator into the ClientHello.
// Handshake remarsals from SessionId, so the AEAD additional data is a
// marshal of the same hello with a zero session id.
func sealSessionID(uconn *utls.UConn, pub *ecdh.PublicKey, sid [8]byte) error {
	if err := uconn.BuildHandshakeState(); err != nil {
		return err
	}
	hello := uconn.HandshakeState.Hello
	if hello == nil {
		return fmt.Errorf("reality: client hello was not built")
	}
	hello.SessionId = make([]byte, 32)
	if err := uconn.BuildHandshakeState(); err != nil {
		return err
	}
	hello = uconn.HandshakeState.Hello
	if len(hello.Random) < 32 || len(hello.Raw) < 71 || hello.Raw[38] != 32 {
		return fmt.Errorf("reality: unexpected client hello layout")
	}
	priv := x25519Private(uconn)
	if priv == nil {
		return fmt.Errorf("reality: chrome hello has no X25519 key share")
	}
	shared, err := priv.ECDH(pub)
	if err != nil {
		return err
	}
	authKey, err := hkdf.Key(sha256.New, shared, hello.Random[:20], "REALITY", 32)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(authKey)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	var plain [16]byte
	binary.BigEndian.PutUint32(plain[4:], uint32(time.Now().Unix()))
	copy(plain[8:], sid[:])
	sealed := aead.Seal(nil, hello.Random[20:], plain[:], hello.Raw)
	if len(sealed) != 32 {
		return fmt.Errorf("reality: sealed session id is %d bytes", len(sealed))
	}
	hello.SessionId = sealed
	return nil
}

// The server prefers a standalone X25519 share and falls back to the
// X25519 half of X25519MLKEM768. Chrome sends both; Ecdhe is the standalone key.
func x25519Private(uconn *utls.UConn) *ecdh.PrivateKey {
	keys := uconn.HandshakeState.State13.KeyShareKeys
	if keys == nil {
		return nil
	}
	if keys.Ecdhe != nil {
		return keys.Ecdhe
	}
	return keys.MlkemEcdhe
}

// DecodeShortID pads a hex short id to 8 bytes. Empty is eight zero bytes.
func DecodeShortID(s string) ([8]byte, error) {
	var out [8]byte
	s = strings.TrimSpace(s)
	if s == "" {
		return out, nil
	}
	b, err := hex.DecodeString(s)
	if err != nil || len(b) > 8 {
		return out, fmt.Errorf("reality: shortId %q is not 1-8 hex bytes", s)
	}
	copy(out[:], b)
	return out, nil
}

func decodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.StdEncoding} {
		b, err := enc.DecodeString(s)
		if err == nil && len(b) == 32 {
			return b, nil
		}
	}
	return nil, fmt.Errorf("key is not 32 bytes of base64")
}

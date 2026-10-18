// Package selfsign mints the certificate gost builds from the panel's tls
// block. The document only has commonName, validity and organization, so the
// key is new every process and the dialer cannot verify it.
package selfsign

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"time"
)

// Server returns a tls.Config with a fresh ECDSA certificate. nextProtos may
// be nil; QUIC needs h3 / quic/v1, TCP TLS does not.
func Server(name string, nextProtos []string) (*tls.Config, error) {
	if name == "" {
		name = "relayx"
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: name, Organization: []string{name}},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(8760 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{name},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{{
			Certificate: [][]byte{der},
			PrivateKey:  key,
		}},
		NextProtos: nextProtos,
	}, nil
}

// Client skips verification and sets SNI to name.
func Client(name string, nextProtos []string) *tls.Config {
	if name == "" {
		name = "relayx"
	}
	return &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         name,
		NextProtos:         nextProtos,
	}
}

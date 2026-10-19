package selfsign

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"testing"
	"time"
)

func TestServerCertificate(t *testing.T) {
	cfg, err := Server("", nil)
	if err != nil {
		t.Fatalf("Server: %v", err)
	}
	if len(cfg.Certificates) != 1 || len(cfg.Certificates[0].Certificate) != 1 {
		t.Fatalf("certificates = %+v", cfg.Certificates)
	}
	leaf, err := x509.ParseCertificate(cfg.Certificates[0].Certificate[0])
	if err != nil {
		t.Fatalf("ParseCertificate: %v", err)
	}
	if leaf.Subject.CommonName != "relayx" {
		t.Fatalf("CN = %q", leaf.Subject.CommonName)
	}
	if len(leaf.Subject.Organization) != 1 || leaf.Subject.Organization[0] != "relayx" {
		t.Fatalf("O = %v", leaf.Subject.Organization)
	}
	if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != "relayx" {
		t.Fatalf("DNSNames = %v", leaf.DNSNames)
	}
	if leaf.KeyUsage&x509.KeyUsageDigitalSignature == 0 {
		t.Fatal("digitalSignature key usage missing")
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Fatalf("ExtKeyUsage = %v", leaf.ExtKeyUsage)
	}
	lifetime := leaf.NotAfter.Sub(leaf.NotBefore)
	if lifetime < 8000*time.Hour || lifetime > 9000*time.Hour {
		t.Fatalf("lifetime = %v, want ~8760h", lifetime)
	}
	if !leaf.NotBefore.Before(time.Now()) || !leaf.NotAfter.After(time.Now()) {
		t.Fatalf("validity window = %v..%v", leaf.NotBefore, leaf.NotAfter)
	}
	if cfg.NextProtos != nil {
		t.Fatalf("NextProtos = %v", cfg.NextProtos)
	}
}

func TestServerCustomNameAndProtos(t *testing.T) {
	cfg, err := Server("node-7", []string{"h3", "quic/v1"})
	if err != nil {
		t.Fatalf("Server: %v", err)
	}
	leaf, err := x509.ParseCertificate(cfg.Certificates[0].Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if leaf.Subject.CommonName != "node-7" || leaf.DNSNames[0] != "node-7" {
		t.Fatalf("CN=%q DNS=%v", leaf.Subject.CommonName, leaf.DNSNames)
	}
	if len(cfg.NextProtos) != 2 || cfg.NextProtos[0] != "h3" {
		t.Fatalf("NextProtos = %v", cfg.NextProtos)
	}
}

func TestClientConfig(t *testing.T) {
	cfg := Client("", nil)
	if !cfg.InsecureSkipVerify || cfg.ServerName != "relayx" {
		t.Fatalf("Client() = %+v", cfg)
	}
	cfg = Client("node-7", []string{"h3"})
	if cfg.ServerName != "node-7" || len(cfg.NextProtos) != 1 {
		t.Fatalf("Client(node-7) = %+v", cfg)
	}
}

func TestHandshakeBetweenServerAndClient(t *testing.T) {
	serverCfg, err := Server("relayx", []string{"h3", "quic/v1"})
	if err != nil {
		t.Fatalf("Server: %v", err)
	}
	clientCfg := Client("relayx", []string{"h3"})

	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	errCh := make(chan error, 1)
	go func() {
		tlsServer := tls.Server(serverConn, serverCfg)
		errCh <- tlsServer.Handshake()
	}()

	tlsClient := tls.Client(clientConn, clientCfg)
	if err := tlsClient.Handshake(); err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("server handshake: %v", err)
	}
	if got := tlsClient.ConnectionState().NegotiatedProtocol; got != "h3" {
		t.Fatalf("negotiated protocol = %q", got)
	}
}

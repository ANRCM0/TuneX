package openvpn

import (
	"crypto/tls"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStockClientHandshake(t *testing.T) { stockClientHandshake(t, false) }

func TestStockClientUDP(t *testing.T) { stockClientHandshake(t, true) }

func stockClientHandshake(t *testing.T, udp bool) {
	if _, err := os.Stat("/usr/sbin/openvpn"); err != nil {
		t.Skip("openvpn is not installed")
	}
	dir := t.TempDir()
	run := func(name string, args ...string) {
		t.Helper()
		cmd := exec.Command(name, args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
	}
	run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
		"-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=RelayX OpenVPN CA", "-days", "30")
	run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=server")
	os.WriteFile(filepath.Join(dir, "server.ext"), []byte("keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n"), 0o644)
	run("openssl", "x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
		"-out", "server.crt", "-days", "30", "-extfile", "server.ext")
	run("openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=client")
	os.WriteFile(filepath.Join(dir, "client.ext"), []byte("extendedKeyUsage=clientAuth\n"), 0o644)
	run("openssl", "x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
		"-out", "client.crt", "-days", "30", "-extfile", "client.ext")
	run("/usr/sbin/openvpn", "--genkey", "secret", filepath.Join(dir, "tc.key"))

	keyText, err := os.ReadFile(filepath.Join(dir, "tc.key"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := ParseStaticKey(string(keyText))
	if err != nil {
		t.Fatal(err)
	}
	crypt, err := NewTLSCrypt(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	certPEM, err := os.ReadFile(filepath.Join(dir, "server.crt"))
	if err != nil {
		t.Fatal(err)
	}
	keyPEM, err := os.ReadFile(filepath.Join(dir, "server.key"))
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	tlsCfg := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}

	var ln net.Listener
	if udp {
		ln, err = ListenUDP("127.0.0.1:0")
	} else {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	errc := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			errc <- err
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(12 * time.Second))
		_, _, err = Serve(c, crypt, tlsCfg, 0, "10.8.0.0/24", "", 0)
		errc <- err
	}()

	_, portText, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	proto := "tcp-client"
	if udp {
		proto = "udp"
	}
	logPath := filepath.Join(dir, "client.log")
	cmd := exec.Command("/usr/sbin/openvpn",
		"--client", "--dev", "tun", "--proto", proto,
		"--remote", "127.0.0.1", portText,
		"--nobind", "--ca", filepath.Join(dir, "ca.crt"),
		"--cert", filepath.Join(dir, "client.crt"),
		"--key", filepath.Join(dir, "client.key"),
		"--tls-crypt", filepath.Join(dir, "tc.key"),
		"--data-ciphers", "AES-256-GCM", "--auth", "SHA256",
		"--remote-cert-tls", "server", "--route-nopull",
		"--connect-timeout", "8", "--connect-retry-max", "1",
		"--hand-window", "10", "--verb", "4",
		"--log", logPath,
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-errc:
		t.Logf("serve: %v", err)
	case <-time.After(12 * time.Second):
		t.Log("serve timed out")
	}
	deadline := time.Now().Add(2 * time.Second)
	var log []byte
	for {
		log, _ = os.ReadFile(logPath)
		text := string(log)
		if strings.Contains(text, "Initialization Sequence Completed") || strings.Contains(text, "Cannot ioctl TUNSETIFF") || strings.Contains(text, "Failed to apply push options") || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	<-done
	t.Logf("client log:\n%s", log)
	text := string(log)
	if !strings.Contains(text, "cipher AES-256-GCM") || strings.Contains(text, "failed to negotiate cipher") || strings.Contains(text, "Failed to apply push options") {
		t.Fatal("stock client rejected PUSH_REPLY")
	}
	// This container has no CAP_NET_ADMIN, so TUNSETIFF is the expected stop.
	if !strings.Contains(text, "Initialization Sequence Completed") && !strings.Contains(text, "Cannot ioctl TUNSETIFF") {
		t.Fatal("stock client did not finish the control handshake")
	}
}

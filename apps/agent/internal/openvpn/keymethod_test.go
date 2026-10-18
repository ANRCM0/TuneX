package openvpn

import (
	"bytes"
	"testing"
)

func TestKeyMethod2BothSides(t *testing.T) {
	clientSrc, err := NewKeySource(true)
	if err != nil {
		t.Fatal(err)
	}
	serverSrc, err := NewKeySource(false)
	if err != nil {
		t.Fatal(err)
	}
	clientRaw := MarshalClient(clientSrc, "V4,dev-type tun,cipher AES-256-GCM,auth SHA256,key-method 2,tls-client", "", "", "")
	serverRaw := MarshalServer(serverSrc, "V4,dev-type tun,cipher AES-256-GCM,auth SHA256,key-method 2,tls-server", "", "", "")

	gotClient, opt, err := ParseClient(clientRaw)
	if err != nil {
		t.Fatal(err)
	}
	if gotClient != clientSrc || opt == "" {
		t.Fatalf("client parse opt %q", opt)
	}
	gotServer, _, err := ParseServer(serverRaw)
	if err != nil || gotServer.Random1 != serverSrc.Random1 || gotServer.Random2 != serverSrc.Random2 {
		t.Fatal(err)
	}

	var cSess, sSess SessionID
	cSess[0] = 1
	sSess[0] = 2
	clientKeys, err := DeriveKeys(clientSrc, serverSrc, cSess, sSess, 32, true)
	if err != nil {
		t.Fatal(err)
	}
	serverKeys, err := DeriveKeys(clientSrc, serverSrc, cSess, sSess, 32, false)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(clientKeys.SendCipher, serverKeys.RecvCipher) || !bytes.Equal(clientKeys.RecvCipher, serverKeys.SendCipher) {
		t.Fatal("send/recv keys are not swapped")
	}
	if !bytes.Equal(clientKeys.SendHMAC[:8], serverKeys.RecvHMAC[:8]) {
		t.Fatal("implicit IV is not swapped")
	}

	a, err := NewDataChannel(clientKeys, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewDataChannel(serverKeys, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	pkt, err := a.Seal([]byte("from-km2"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := b.Open(pkt)
	if err != nil || string(plain) != "from-km2" {
		t.Fatalf("plain %q %v", plain, err)
	}
}

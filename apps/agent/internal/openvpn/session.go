package openvpn

import (
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"strings"
)

// Serve completes the server control handshake on conn: hard reset, TLS,
// key method 2, then PUSH_REPLY carrying peerID. network is a CIDR such as
// 10.8.0.0/24. The returned stream keeps reading that TCP connection and
// delivers P_DATA_V2 packets on Data. keys open those packets for peerID.
// There is still no TUN, and a stock client is not accepted.
func Serve(conn net.Conn, crypt *TLSCrypt, cfg *tls.Config, peerID uint32, network, cipher string, mtu int) (*Stream, DataKeys, error) {
	client, serverID, err := AcceptHardReset(conn, crypt)
	if err != nil {
		return nil, DataKeys{}, err
	}
	stream := NewStream(conn, crypt, serverID, client.LocalSession, 1)
	sc := tls.Server(stream, cfg)
	if err := sc.Handshake(); err != nil {
		return nil, DataKeys{}, err
	}
	buf := make([]byte, 4096)
	n, err := sc.Read(buf)
	if err != nil {
		return nil, DataKeys{}, err
	}
	clientSrc, _, err := ParseClient(buf[:n])
	if err != nil {
		return nil, DataKeys{}, err
	}
	serverSrc, err := NewKeySource(false)
	if err != nil {
		return nil, DataKeys{}, err
	}
	if _, err := sc.Write(MarshalServer(serverSrc, "", "", "", "")); err != nil {
		return nil, DataKeys{}, err
	}
	keyLen, cipherName, err := CipherKeyLen(cipher)
	if err != nil {
		return nil, DataKeys{}, err
	}
	keys, err := DeriveKeys(clientSrc, serverSrc, client.LocalSession, serverID, keyLen, false)
	if err != nil {
		return nil, DataKeys{}, err
	}
	msg, err := readControlString(sc)
	if err != nil {
		return nil, DataKeys{}, err
	}
	if !strings.HasPrefix(msg, "PUSH_REQUEST") {
		return nil, DataKeys{}, fmt.Errorf("openvpn: expected PUSH_REQUEST, got %q", msg)
	}
	if _, err := sc.Write(pushReply(peerID, network, cipherName, mtu)); err != nil {
		return nil, DataKeys{}, err
	}
	return stream, keys, nil
}

// Dial completes the client control handshake and returns the peer id from
// PUSH_REPLY. cfg may skip certificate verification; the replica server uses
// a certificate the panel did not sign when the pushed metadata has no cert.
func Dial(conn net.Conn, crypt *TLSCrypt, cfg *tls.Config, cipher string) (*Stream, DataKeys, uint32, error) {
	local, err := NewSessionID()
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	if err := WriteControl(conn, crypt, Control{
		Opcode: opHardResetClientV2, LocalSession: local,
	}, 1, 0); err != nil {
		return nil, DataKeys{}, 0, err
	}
	raw, err := ReadTCP(conn)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	reply, _, _, err := OpenControl(crypt, raw)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	stream := NewStream(conn, crypt, local, reply.LocalSession, 1)
	cc := tls.Client(stream, cfg)
	if err := cc.Handshake(); err != nil {
		return nil, DataKeys{}, 0, err
	}
	clientSrc, err := NewKeySource(true)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	if _, err := cc.Write(MarshalClient(clientSrc, "", "", "", "")); err != nil {
		return nil, DataKeys{}, 0, err
	}
	buf := make([]byte, 4096)
	n, err := readFullRecord(cc, buf)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	serverSrc, _, err := ParseServer(buf[:n])
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	keyLen, _, err := CipherKeyLen(cipher)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	keys, err := DeriveKeys(clientSrc, serverSrc, local, reply.LocalSession, keyLen, true)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	if _, err := cc.Write(pushRequest()); err != nil {
		return nil, DataKeys{}, 0, err
	}
	msg, err := readControlString(cc)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	peerID, err := parsePeerID(msg)
	if err != nil {
		return nil, DataKeys{}, 0, err
	}
	return stream, keys, peerID, nil
}

// readFullRecord reads one TLS application write. The key-method record is
// small enough to arrive in a single Read; a short read is still one record
// because the parser checks the minimum length.
func readFullRecord(r io.Reader, buf []byte) (int, error) {
	return r.Read(buf)
}

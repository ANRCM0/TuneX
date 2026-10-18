package openvpn

import (
	"fmt"
	"io"
	"net"
	"time"
)

// ReadControl reads one TCP frame and opens it with the server role key.
func ReadControl(r io.Reader, crypt *TLSCrypt) (Control, uint32, uint32, error) {
	raw, err := ReadTCP(r)
	if err != nil {
		return Control{}, 0, 0, err
	}
	return OpenControl(crypt, raw)
}

// WriteControl seals pkt and writes it as one TCP frame.
func WriteControl(w io.Writer, crypt *TLSCrypt, pkt Control, packetID, unixTime uint32) error {
	raw, err := pkt.Seal(crypt, packetID, unixTime)
	if err != nil {
		return err
	}
	return WriteTCP(w, raw)
}

// AcceptHardReset reads a client V2 hard reset and answers with a server V2
// hard reset that acks the client's message id. The returned session id is
// the server's. TLS records are not exchanged; this is only the first packet.
func AcceptHardReset(conn net.Conn, server *TLSCrypt) (client Control, serverID SessionID, err error) {
	client, _, _, err = ReadControl(conn, server)
	if err != nil {
		return Control{}, SessionID{}, err
	}
	if client.Opcode != opHardResetClientV2 {
		return Control{}, SessionID{}, fmt.Errorf("openvpn: opcode %d, want hard reset client v2", client.Opcode)
	}
	serverID, err = NewSessionID()
	if err != nil {
		return Control{}, SessionID{}, err
	}
	reply := Control{
		Opcode:       opHardResetServerV2,
		LocalSession: serverID,
		AckIDs:       []uint32{client.MessageID},
		AckSession:   client.LocalSession,
		MessageID:    0,
	}
	if err := WriteControl(conn, server, reply, 1, uint32(time.Now().Unix())); err != nil {
		return Control{}, SessionID{}, err
	}
	return client, serverID, nil
}

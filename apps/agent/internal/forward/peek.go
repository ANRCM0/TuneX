package forward

import (
	"net"

	"github.com/relayx/agent/internal/sniff"
)

func peekProtocol(c net.Conn) (net.Conn, string, error) {
	return sniff.Peek(c)
}

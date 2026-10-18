package vless

import (
	"bytes"
	"crypto/rand"
	"io"
	"net"
)

// VisionFlow is the flow the panel writes into every VLESS share link.
const VisionFlow = "xtls-rprx-vision"

const (
	cmdPaddingContinue = 0
	cmdPaddingEnd      = 1
	cmdPaddingDirect   = 2

	modeCheck = iota
	modeHeader
	modeContent
	modePadding
	modeRaw
)

// visionConn strips xtls-rprx-vision padding on Read and writes one padded
// block (then raw bytes) on Write. The first block starts with the user UUID,
// matching Xray XtlsPadding / XtlsUnpadding.
type visionConn struct {
	net.Conn
	uuid [16]byte

	mode int
	cmd  int
	need int
	hdr  [5]byte
	hdrN int
	out  []byte

	wrote bool
}

func newVision(conn net.Conn, id [16]byte) net.Conn {
	return &visionConn{Conn: conn, uuid: id, mode: modeCheck}
}

func isVision(addon []byte) bool {
	if len(addon) < 2 || addon[0] != 0x0a {
		return false
	}
	n := int(addon[1])
	if len(addon) < 2+n {
		return false
	}
	return string(addon[2:2+n]) == VisionFlow
}

func visionAddon() []byte {
	flow := VisionFlow
	return append([]byte{0x0a, byte(len(flow))}, flow...)
}

func (v *visionConn) Read(p []byte) (int, error) {
	for {
		if len(v.out) > 0 {
			n := copy(p, v.out)
			v.out = v.out[n:]
			return n, nil
		}
		if v.mode == modeRaw {
			return v.Conn.Read(p)
		}
		buf := make([]byte, 4096)
		n, err := v.Conn.Read(buf)
		if n > 0 {
			v.feed(buf[:n])
		}
		if len(v.out) > 0 {
			n := copy(p, v.out)
			v.out = v.out[n:]
			return n, nil
		}
		if err != nil {
			return 0, err
		}
		if n == 0 {
			return 0, io.EOF
		}
	}
}

// feed applies one underlying read. A check-mode chunk that is not a vision
// block is delivered as-is, which is what XtlsUnpadding does.
func (v *visionConn) feed(chunk []byte) {
	if v.mode == modeCheck {
		if len(chunk) >= 21 && bytes.Equal(chunk[:16], v.uuid[:]) {
			chunk = chunk[16:]
			v.mode = modeHeader
			v.hdrN = 0
		} else {
			v.out = append(v.out, chunk...)
			return
		}
	}
	for len(chunk) > 0 && v.mode != modeRaw {
		switch v.mode {
		case modeHeader:
			take := 5 - v.hdrN
			if take > len(chunk) {
				take = len(chunk)
			}
			copy(v.hdr[v.hdrN:], chunk[:take])
			v.hdrN += take
			chunk = chunk[take:]
			if v.hdrN < 5 {
				return
			}
			v.cmd = int(v.hdr[0])
			v.need = int(v.hdr[1])<<8 | int(v.hdr[2])
			v.mode = modeContent
			if v.need == 0 {
				v.need = int(v.hdr[3])<<8 | int(v.hdr[4])
				v.mode = modePadding
			}
		case modeContent:
			take := v.need
			if take > len(chunk) {
				take = len(chunk)
			}
			v.out = append(v.out, chunk[:take]...)
			chunk = chunk[take:]
			v.need -= take
			if v.need == 0 {
				v.need = int(v.hdr[3])<<8 | int(v.hdr[4])
				v.mode = modePadding
			}
		case modePadding:
			take := v.need
			if take > len(chunk) {
				take = len(chunk)
			}
			chunk = chunk[take:]
			v.need -= take
			if v.need > 0 {
				return
			}
			if v.cmd == cmdPaddingContinue {
				v.mode = modeHeader
				v.hdrN = 0
				continue
			}
			v.out = append(v.out, chunk...)
			v.mode = modeRaw
			return
		default:
			v.out = append(v.out, chunk...)
			return
		}
	}
}

func (v *visionConn) Write(p []byte) (int, error) {
	if v.wrote {
		return v.Conn.Write(p)
	}
	v.wrote = true
	original := len(p)
	var uuid []byte = v.uuid[:]
	var frame []byte
	for len(p) > 0 || uuid != nil {
		n := len(p)
		if n > 8000 {
			n = 8000
		}
		cmd := byte(cmdPaddingContinue)
		if n == len(p) {
			cmd = cmdPaddingEnd
		}
		frame = append(frame, visionBlock(uuid, cmd, p[:n], n < 900)...)
		uuid = nil
		p = p[n:]
		if n == 0 {
			break
		}
	}
	if _, err := v.Conn.Write(frame); err != nil {
		return 0, err
	}
	return original, nil
}

func visionBlock(uuid []byte, cmd byte, content []byte, long bool) []byte {
	contentLen := len(content)
	paddingLen := randInt(256)
	if contentLen < 900 && long {
		paddingLen = randInt(500) + 900 - contentLen
	}
	if paddingLen > 8192-21-contentLen {
		paddingLen = 8192 - 21 - contentLen
	}
	if paddingLen < 0 {
		paddingLen = 0
	}
	buf := make([]byte, 0, len(uuid)+5+contentLen+paddingLen)
	buf = append(buf, uuid...)
	buf = append(buf, cmd, byte(contentLen>>8), byte(contentLen), byte(paddingLen>>8), byte(paddingLen))
	buf = append(buf, content...)
	pad := make([]byte, paddingLen)
	_, _ = rand.Read(pad)
	return append(buf, pad...)
}

func randInt(n int) int {
	if n <= 1 {
		return 0
	}
	var b [2]byte
	_, _ = rand.Read(b[:])
	return (int(b[0])<<8 | int(b[1])) % n
}

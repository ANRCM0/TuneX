// Package sniff names a few protocols from the first bytes of a stream.
// The panel stores those names in handler metadata "block.protocol".
package sniff

import (
	"bytes"
	"strings"
)

// Detect returns a protocol name, or "" when the prefix is not recognized.
// Names match the strings a node group is likely to store: http, tls, ssh,
// socks4, socks5, bittorrent.
func Detect(b []byte) string {
	if len(b) >= 20 && b[0] == 19 && bytes.Equal(b[1:20], []byte("BitTorrent protocol")) {
		return "bittorrent"
	}
	if bytes.HasPrefix(b, []byte("d1:ad2")) || bytes.HasPrefix(b, []byte("d1:rd2")) {
		return "bittorrent"
	}
	if bytes.HasPrefix(b, []byte("SSH-")) {
		return "ssh"
	}
	if len(b) >= 3 && b[0] == 0x16 && b[1] == 0x03 {
		return "tls"
	}
	if isHTTP(b) {
		return "http"
	}
	if len(b) >= 2 && b[0] == 0x05 && int(b[1]) <= 16 {
		return "socks5"
	}
	if len(b) >= 2 && b[0] == 0x04 && (b[1] == 0x01 || b[1] == 0x02) {
		return "socks4"
	}
	return ""
}

func isHTTP(b []byte) bool {
	for _, method := range []string{"GET ", "POST ", "PUT ", "HEAD ", "DELETE ", "OPTIONS ", "CONNECT ", "PATCH "} {
		if bytes.HasPrefix(b, []byte(method)) {
			return true
		}
	}
	return false
}

// Blocked reports whether name is on the panel's block list.
// "bt" and "https" are accepted as aliases of bittorrent and tls.
func Blocked(list []string, name string) bool {
	if name == "" {
		return false
	}
	for _, item := range list {
		item = strings.ToLower(strings.TrimSpace(item))
		switch item {
		case strings.ToLower(name):
			return true
		case "bt":
			if name == "bittorrent" {
				return true
			}
		case "https":
			if name == "tls" {
				return true
			}
		}
	}
	return false
}

// Reject is the panel sniff decision. A named protocol on the block list is
// always dropped. When sniffing.fallback is false, a prefix that is not a
// known protocol is dropped too. The panel sets that only on plain TCP
// forwards; VLESS, mieru and OpenVPN set sniffing.fallback, so unknown
// bytes still pass.
func Reject(block []string, fallback bool, name string) bool {
	if len(block) == 0 {
		return false
	}
	if name == "" {
		return !fallback
	}
	return Blocked(block, name)
}

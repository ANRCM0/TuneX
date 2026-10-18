package wireguard

import "testing"

func TestParseTransfer(t *testing.T) {
	rx, tx, peers := parseTransfer("" +
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t100\t40\n" +
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t5\t7\n")
	if rx != 105 || tx != 47 || peers != 2 {
		t.Fatalf("rx=%d tx=%d peers=%d", rx, tx, peers)
	}
	rx, tx, peers = parseTransfer("   \nnot-a-row\n")
	if rx != 0 || tx != 0 || peers != 0 {
		t.Fatalf("empty parse rx=%d tx=%d peers=%d", rx, tx, peers)
	}
}

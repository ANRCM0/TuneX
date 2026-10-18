//go:build !unix

package service

import "errors"

// errnoAddrInUse is a portable stand-in on platforms without a POSIX errno.
// Result.IsPortInUse still falls back to matching the message text.
var errnoAddrInUse error = errors.New("address already in use")

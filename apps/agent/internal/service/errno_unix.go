//go:build unix

package service

import "syscall"

// errnoAddrInUse is the platform EADDRINUSE, used to answer the panel's
// `ERR_PORT_IN_USE` code (reports/AGENT_CONTROL.md C-B).
var errnoAddrInUse error = syscall.EADDRINUSE

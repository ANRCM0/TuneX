package sysinfo

import "runtime"

// Indirections kept as variables so tests can stub them.
var runtimeNumCPU = runtime.NumCPU

var goArch = func() string { return runtime.GOARCH }

// Package lockfile is the replica's single-instance guard. Upstream uses
// `gofrs/flock` on the relative path `relayx-agent.lock`; the replica uses a
// POSIX advisory lock (flock) through the standard library so it stays
// dependency-free and behaves the same way: a second agent started in the same
// directory refuses to run.
package lockfile

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// ErrAlreadyRunning is returned when another process holds the lock.
var ErrAlreadyRunning = errors.New("lockfile: another relayx-agent instance is already running")

// Acquire takes an exclusive, non-blocking lock on path and returns the release
// function. The lock is released when the returned function is called or when
// the process exits (the kernel drops flock locks on close/exit).
func Acquire(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("lockfile: open %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("%w (%s)", ErrAlreadyRunning, path)
		}
		return nil, fmt.Errorf("lockfile: flock %s: %w", path, err)
	}
	if err := f.Truncate(0); err == nil {
		_, _ = fmt.Fprintf(f, "%d\n", os.Getpid())
		_ = f.Sync()
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

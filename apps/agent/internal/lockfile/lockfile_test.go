package lockfile

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestAcquireAndRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.lock")

	release, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if pid := strings.TrimSpace(string(data)); pid != strconv.Itoa(os.Getpid()) {
		t.Fatalf("lock file holds %q, want pid %d", pid, os.Getpid())
	}

	release()

	// After release the file can be locked again.
	release2, err := Acquire(path)
	if err != nil {
		t.Fatalf("re-Acquire: %v", err)
	}
	release2()
}

func TestSecondAcquireFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.lock")
	release, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer release()

	if _, err := Acquire(path); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second Acquire = %v, want ErrAlreadyRunning", err)
	}
}

func TestAcquireReportsOpenError(t *testing.T) {
	dir := t.TempDir()
	if _, err := Acquire(filepath.Join(dir, "missing", "agent.lock")); err == nil {
		t.Fatal("Acquire in a missing directory succeeded")
	} else if errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("open error reported as ErrAlreadyRunning: %v", err)
	}
}

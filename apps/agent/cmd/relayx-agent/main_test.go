package main

import (
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayx/agent/internal/config"
	"github.com/relayx/agent/internal/lockfile"
)

// captureStdout runs fn while stdout is redirected into a pipe.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		buf, _ := io.ReadAll(r)
		done <- string(buf)
	}()
	runErr := fn()
	_ = w.Close()
	os.Stdout = old
	return <-done, runErr
}

func TestVersionFlags(t *testing.T) {
	for _, flag := range []string{"--version", "-v"} {
		out, err := captureStdout(t, func() error { return run([]string{flag}) })
		if err != nil {
			t.Fatalf("run(%s): %v", flag, err)
		}
		if !strings.Contains(out, "relayx-agent version "+version) {
			t.Fatalf("run(%s) output = %q", flag, out)
		}
	}
}

func TestVersionFlagAfterDoubleDashIsNotSpecial(t *testing.T) {
	// After `--` the argument is positional, so the required-flag check wins.
	_, err := captureStdout(t, func() error { return run([]string{"--", "--version"}) })
	if err == nil || !strings.Contains(err.Error(), "required flag") {
		t.Fatalf("run(-- --version) = %v", err)
	}
}

func TestHelp(t *testing.T) {
	if err := run([]string{"-h"}); !errors.Is(err, config.ErrHelp) {
		t.Fatalf("run(-h) = %v, want ErrHelp", err)
	}
	if err := run([]string{"--help"}); !errors.Is(err, config.ErrHelp) {
		t.Fatalf("run(--help) = %v, want ErrHelp", err)
	}
}

func TestArgumentErrors(t *testing.T) {
	cases := [][]string{
		nil,                                      // token and server are required
		{"-t", "token"},                          // server missing
		{"-s", "http://panel:3003"},              // token missing
		{"--unknown", "x"},                       // unknown flag
		{"-c"},                                   // -c without a value
		{"-t", "t", "-s", "s", "--tcp-port=abc"}, // bad number
	}
	for _, args := range cases {
		if err := run(args); err == nil {
			t.Fatalf("run(%v) accepted", args)
		}
	}
}

func TestMissingConfigFile(t *testing.T) {
	err := run([]string{"-c", filepath.Join(t.TempDir(), "absent.yaml"), "-t", "t", "-s", "http://panel:3003"})
	if err == nil || !strings.Contains(err.Error(), "config") {
		t.Fatalf("run with a missing config file = %v", err)
	}
}

func TestConfigFileIsReported(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte("token: file-token\nserver: http://127.0.0.1:1\npprof-port: 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(oldWD) }()

	// Hold the lock so run() reports the config file and then stops before it
	// would try to reach the panel.
	release, err := lockfile.Acquire(lockName)
	if err != nil {
		t.Fatalf("pre-acquire: %v", err)
	}
	defer release()

	out, runErr := captureStdout(t, func() error {
		return run([]string{"-c", path, "--pprof-port=0"})
	})
	if !errors.Is(runErr, lockfile.ErrAlreadyRunning) {
		t.Fatalf("run = %v", runErr)
	}
	if !strings.Contains(out, "Using config file: "+path) {
		t.Fatalf("output = %q", out)
	}
}

func TestSingleInstanceLock(t *testing.T) {
	work := t.TempDir()
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(oldWD) }()

	release, err := lockfile.Acquire(lockName)
	if err != nil {
		t.Fatalf("pre-acquire: %v", err)
	}
	defer release()

	// A second agent in the same directory must refuse before touching the panel.
	runErr := run([]string{"-t", "t", "-s", "http://127.0.0.1:1", "--pprof-port=0"})
	if !errors.Is(runErr, lockfile.ErrAlreadyRunning) {
		t.Fatalf("run with a held lock = %v", runErr)
	}
}

func TestPprofServes(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()

	startPprof(port)
	url := "http://127.0.0.1:" + itoa(port) + "/debug/pprof/"

	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := http.Get(url) //nolint:noctx // short-lived readiness probe
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("pprof did not answer at %s", url)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

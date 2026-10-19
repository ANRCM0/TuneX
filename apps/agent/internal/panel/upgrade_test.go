package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func upgradeArgs(values ...any) []json.RawMessage {
	out := make([]json.RawMessage, len(values))
	for i, v := range values {
		b, _ := json.Marshal(v)
		out[i] = b
	}
	return out
}

func TestHandleUpgradeArgumentErrors(t *testing.T) {
	agent := newTestAgent(t)
	s := sessionFor(agent)

	if _, err := s.handleUpgrade(nil); err == nil {
		t.Fatal("missing url accepted")
	}
	if _, err := s.handleUpgrade(upgradeArgs(42)); err == nil {
		t.Fatal("non-string url accepted")
	}
	if _, err := s.handleUpgrade(upgradeArgs("")); err == nil {
		t.Fatal("empty url accepted")
	}
}

// withExecutable points the installer at a scratch file for the duration of a test.
func withExecutable(t *testing.T) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), "relayx-agent-test")
	if err := os.WriteFile(target, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := executablePath
	executablePath = func() (string, error) { return target, nil }
	t.Cleanup(func() { executablePath = old })
	return target
}

func TestHandleUpgradeSkipsRunningVersion(t *testing.T) {
	agent := newTestAgent(t)
	s := sessionFor(agent)
	replaced := false
	old := replaceProcess
	replaceProcess = func(string) error { replaced = true; return nil }
	t.Cleanup(func() { replaceProcess = old })
	got, err := s.handleUpgrade(upgradeArgs("http://127.0.0.1:9/agent", "test-version"))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := got.(map[string]any)
	if body["skipped"] != true || replaced {
		t.Fatalf("result = %#v replaced=%v", got, replaced)
	}
}

func TestHandleUpgradeRestartsWhenDiskMatches(t *testing.T) {
	withExecutable(t)
	agent := newTestAgent(t)
	s := sessionFor(agent)
	oldRead := readDiskVersion
	readDiskVersion = func(string) (string, error) { return "1.2.3", nil }
	var restarted string
	oldExec := replaceProcess
	replaceProcess = func(path string) error { restarted = path; return nil }
	t.Cleanup(func() {
		readDiskVersion = oldRead
		replaceProcess = oldExec
	})
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hit = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	if _, err := s.handleUpgrade(upgradeArgs(srv.URL, "1.2.3")); err != nil {
		t.Fatal(err)
	}
	if hit {
		t.Fatal("downloaded despite a matching on-disk version")
	}
	if restarted == "" {
		t.Fatal("did not re-exec")
	}
}

func TestHandleUpgradeInstallsThenRestarts(t *testing.T) {
	target := withExecutable(t)
	agent := newTestAgent(t)
	s := sessionFor(agent)
	oldRead := readDiskVersion
	readDiskVersion = func(string) (string, error) { return "old", nil }
	oldArch := upgradeArch
	upgradeArch = ""
	var restarted string
	oldExec := replaceProcess
	replaceProcess = func(path string) error { restarted = path; return nil }
	t.Cleanup(func() {
		readDiskVersion = oldRead
		upgradeArch = oldArch
		replaceProcess = oldExec
	})
	body := append([]byte{0x7f, 'E', 'L', 'F'}, []byte("-next")...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	if _, err := s.handleUpgrade(upgradeArgs(srv.URL, "9.9.9")); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != string(body) {
		t.Fatalf("installed %q, %v", data, err)
	}
	if restarted != target {
		t.Fatalf("re-exec path = %q", restarted)
	}
}

func TestDownloadBinaryRejections(t *testing.T) {
	target := withExecutable(t)
	agent := newTestAgent(t)

	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer notFound.Close()
	if _, err := agent.downloadBinary(notFound.URL); err == nil {
		t.Fatal("404 accepted")
	}

	notELF := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("#!/bin/sh\n"))
	}))
	defer notELF.Close()
	if _, err := agent.downloadBinary(notELF.URL); err == nil {
		t.Fatal("non-ELF payload accepted")
	}

	if data, err := os.ReadFile(target); err != nil || string(data) != "old-binary" {
		t.Fatalf("target changed after rejected upgrades: %q, %v", data, err)
	}
}

func TestDownloadBinaryInstallsAndBacksUp(t *testing.T) {
	target := withExecutable(t)
	agent := newTestAgent(t)

	newBody := append([]byte{0x7f, 'E', 'L', 'F'}, []byte("new-binary")...)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(newBody)
	}))
	defer srv.Close()

	path, err := agent.downloadBinary(srv.URL)
	if err != nil {
		t.Fatalf("downloadBinary: %v", err)
	}
	if path != target {
		t.Fatalf("installed path = %q, want %q", path, target)
	}
	if data, _ := os.ReadFile(target); string(data) != string(newBody) {
		t.Fatalf("new binary = %q", data)
	}
	if backup, err := os.ReadFile(target + ".old"); err != nil || string(backup) != "old-binary" {
		t.Fatalf("backup = %q, %v", backup, err)
	}
	if info, err := os.Stat(target); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, %v", info.Mode().Perm(), err)
	}
}

package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/relayx/agent/internal/logx"
)

// upgradeTimeout bounds the binary download.
const upgradeTimeout = 10 * time.Minute

// handleUpgrade serves the `upgrade` event: 2 string arguments (download URL
// prefix, target version). Upstream builds the artifact name as
// `<url>-<goos>-<goarch>` and replaces the running binary through
// aead.dev/minisign + minio/selfupdate with all-zero options — i.e. with
// signature verification effectively disabled.
//
// The replica performs the same download and atomic replacement, but does not
// restart itself: like upstream, the newly written binary is used on the next
// start (a supervisor such as systemd owns the restart).
func (s *session) handleUpgrade(args []json.RawMessage) (any, error) {
	if len(args) < 1 {
		return nil, errors.New("upgrade: missing url")
	}
	var url, version string
	if err := json.Unmarshal(args[0], &url); err != nil {
		return nil, fmt.Errorf("upgrade: bad url argument: %w", err)
	}
	if len(args) > 1 {
		_ = json.Unmarshal(args[1], &version)
	}
	if url == "" {
		return nil, errors.New("upgrade: empty url")
	}

	artifact := fmt.Sprintf("%s-%s-%s", url, runtime.GOOS, runtime.GOARCH)
	logx.Infof("panel: upgrade requested to version %q from %s", version, artifact)

	path, err := s.a.downloadBinary(artifact)
	if err != nil {
		logx.Errorf("panel: upgrade failed: %v", err)
		return nil, err
	}
	logx.Infof("panel: upgrade staged at %s (version %q); restart required to activate", path, version)
	return map[string]any{"node_id": s.a.nodeID, "version": version, "path": path}, nil
}

func (a *Agent) downloadBinary(url string) (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("upgrade: locate executable: %w", err)
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return "", fmt.Errorf("upgrade: resolve executable: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), upgradeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: upgradeTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("upgrade: download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("upgrade: download %s: http %d", url, resp.StatusCode)
	}

	tmp, err := os.CreateTemp(filepath.Dir(self), ".relayx-agent-upgrade-*")
	if err != nil {
		return "", fmt.Errorf("upgrade: create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := io.Copy(tmp, io.LimitReader(resp.Body, 512<<20)); err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("upgrade: write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}

	// Both the old and the new agent are ELF binaries; reject anything else so a
	// bad URL cannot clobber the executable.
	if err := checkELF(tmpName); err != nil {
		return "", err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return "", err
	}

	// Keep a copy of the previous binary so an operator can roll back manually.
	backup := self + ".old"
	if err := os.Rename(self, backup); err != nil && !os.IsNotExist(err) {
		logx.Warnf("upgrade: cannot back up %s: %v", self, err)
	}
	if err := os.Rename(tmpName, self); err != nil {
		// Put the original back; leaving the node without a binary is worse.
		if _, statErr := os.Stat(backup); statErr == nil {
			_ = os.Rename(backup, self)
		}
		return "", fmt.Errorf("upgrade: install: %w", err)
	}
	tmpName = ""
	return self, nil
}

func checkELF(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var magic [4]byte
	if _, err := io.ReadFull(f, magic[:]); err != nil {
		return fmt.Errorf("upgrade: downloaded file is too small: %w", err)
	}
	if magic != [4]byte{0x7f, 'E', 'L', 'F'} {
		return errors.New("upgrade: downloaded file is not an ELF binary")
	}
	return nil
}

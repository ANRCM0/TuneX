package logx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withOutput points the logger at a temp file and restores stdout afterwards.
func withOutput(t *testing.T) (*os.File, func() string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	oldLevel := level
	oldOut := out
	SetOutput(f)
	t.Cleanup(func() {
		mu.Lock()
		level = oldLevel
		out = oldOut
		mu.Unlock()
		_ = f.Close()
	})
	return f, func() string {
		_ = f.Sync()
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
}

func TestLevelsAndFormat(t *testing.T) {
	_, read := withOutput(t)
	SetLevel("debug")

	Debugf("d %d", 1)
	Infof("i %s", "x")
	Warnf("w")
	Errorf("e")

	logs := read()
	lines := strings.Split(strings.TrimSpace(logs), "\n")
	if len(lines) != 4 {
		t.Fatalf("lines = %d: %q", len(lines), logs)
	}
	wants := []string{"\tdebug\td 1", "\tinfo\ti x", "\twarn\tw", "\terror\te"}
	for i, want := range wants {
		if !strings.HasSuffix(lines[i], want) {
			t.Fatalf("line %d = %q, want suffix %q", i, lines[i], want)
		}
		// Timestamp shape: 2006-01-02 15:04:05.000
		if len(lines[i]) < 23 || lines[i][4] != '-' || lines[i][7] != '-' || lines[i][10] != ' ' || lines[i][13] != ':' {
			t.Fatalf("timestamp shape = %q", lines[i])
		}
	}
}

func TestLevelFiltering(t *testing.T) {
	_, read := withOutput(t)

	SetLevel("warn")
	Infof("hidden")
	Warnf("shown")
	if logs := read(); strings.Contains(logs, "hidden") || !strings.Contains(logs, "shown") {
		t.Fatalf("warn level logs = %q", logs)
	}

	SetLevel("error")
	Warnf("also hidden")
	Errorf("only this")
	logs := read()
	if strings.Contains(logs, "also hidden") || !strings.Contains(logs, "only this") {
		t.Fatalf("error level logs = %q", logs)
	}
}

func TestSetLevelNames(t *testing.T) {
	cases := map[string]Level{
		"debug":   Debug,
		"DEBUG":   Debug,
		" info ":  Info,
		"":        Info,
		"warn":    Warn,
		"warning": Warn,
		"error":   Error,
	}
	for name, want := range cases {
		SetLevel("error") // start from a different level
		SetLevel(name)
		if level != want {
			t.Fatalf("SetLevel(%q) = %v, want %v", name, level, want)
		}
	}

	// Unknown names leave the level untouched.
	SetLevel("warn")
	SetLevel("verbose")
	if level != Warn {
		t.Fatalf("unknown name changed the level to %v", level)
	}
}

func TestLevelString(t *testing.T) {
	if Debug.String() != "debug" || Info.String() != "info" || Warn.String() != "warn" || Error.String() != "error" {
		t.Fatal("level names")
	}
	if Level(99).String() != "info" {
		t.Fatalf("unknown level string = %q", Level(99).String())
	}
}

// Package logx is a tiny dependency-free replacement for the upstream agent's
// zap sugared logger.
//
// Upstream uses go.uber.org/zap with a "2006-01-02 15:04:05" style timestamp.
// We reproduce the observable line shape (timestamp, level, message, optional
// key=value fields) without pulling in zap.
package logx

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Level is a log severity.
type Level int

const (
	Debug Level = iota
	Info
	Warn
	Error
)

func (l Level) String() string {
	switch l {
	case Debug:
		return "debug"
	case Info:
		return "info"
	case Warn:
		return "warn"
	case Error:
		return "error"
	default:
		return "info"
	}
}

var (
	mu    sync.Mutex
	level = Info
	out   = os.Stdout
)

// SetLevel sets the minimum level that is printed. Unknown names leave the
// current level untouched.
func SetLevel(name string) {
	mu.Lock()
	defer mu.Unlock()
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		level = Debug
	case "info", "":
		level = Info
	case "warn", "warning":
		level = Warn
	case "error":
		level = Error
	}
}

// SetOutput redirects log output (used by tests).
func SetOutput(f *os.File) {
	mu.Lock()
	defer mu.Unlock()
	out = f
}

func logf(l Level, format string, args ...any) {
	mu.Lock()
	defer mu.Unlock()
	if l < level {
		return
	}
	msg := fmt.Sprintf(format, args...)
	ts := time.Now().Format("2006-01-02 15:04:05.000")
	fmt.Fprintf(out, "%s\t%s\t%s\n", ts, l.String(), msg)
}

// Debugf logs at debug level.
func Debugf(format string, args ...any) { logf(Debug, format, args...) }

// Infof logs at info level.
func Infof(format string, args ...any) { logf(Info, format, args...) }

// Warnf logs at warn level.
func Warnf(format string, args ...any) { logf(Warn, format, args...) }

// Errorf logs at error level.
func Errorf(format string, args ...any) { logf(Error, format, args...) }

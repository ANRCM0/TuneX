// Command relayx-agent is the RelayX node agent: it connects to a RelayX panel,
// registers the node and serves the tunnels the panel pushes to it.
//
// The entrypoint path (cmd/relayx-agent) is part of the project contract: the
// root `pnpm agent:build` script runs
//
//	cd apps/agent && go build -o ../../dist/relayx-agent ./cmd/relayx-agent
//
// so it must not move.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/relayx/agent/internal/config"
	"github.com/relayx/agent/internal/lockfile"
	"github.com/relayx/agent/internal/logx"
	"github.com/relayx/agent/internal/panel"
)

// version is the wire version the agent reports. It matches the upstream
// release the replica is wire-compatible with; override at build time with
//
//	go build -ldflags "-X main.version=0.13.23-replica" ./cmd/relayx-agent
var version = "0.13.23"

// lockName is the relative single-instance guard upstream uses
// (`gofrs/flock` on the literal "relayx-agent.lock").
const lockName = "relayx-agent.lock"

func main() {
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, config.ErrHelp) {
			fmt.Print(config.Usage())
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	for _, a := range args {
		if a == "--" {
			break
		}
		if a == "-v" || a == "--version" {
			fmt.Printf("relayx-agent version %s\n", version)
			return nil
		}
	}

	cfg, err := config.Parse(args)
	if err != nil {
		return err
	}
	if cfg.Debug {
		logx.SetLevel("debug")
	}
	if cfg.ConfigFile != "" {
		fmt.Fprintln(os.Stdout, "Using config file:", cfg.ConfigFile)
	}

	if cfg.PprofPort != 0 {
		startPprof(cfg.PprofPort)
	}

	// Single-instance guard, mirroring the upstream flock on relayx-agent.lock.
	unlock, err := lockfile.Acquire(lockName)
	if err != nil {
		return err
	}
	defer unlock()

	agent, err := panel.New(cfg, version)
	if err != nil {
		return err
	}
	defer agent.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logx.Infof("RelayX agent %s starting (node_id=%s, server=%s)", version, agent.NodeID(), cfg.Server)
	if err := agent.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	logx.Infof("RelayX agent stopped")
	return nil
}

// startPprof serves the Go pprof handlers on 127.0.0.1 only, like upstream.
func startPprof(port int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		logx.Infof("Pprof server listening")
		logx.Infof("pprof server on http://%s/debug/pprof/", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logx.Warnf("pprof server: %v", err)
		}
	}()
}

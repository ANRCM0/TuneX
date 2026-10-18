package relayx

import (
	"sync"
	"time"
)

// maxReplay is the upstream fail-closed cap. Past this, new tokens are rejected
// even when the HMAC is valid.
const maxReplay = 100000

// Replay remembers nonce||timestamp so a token cannot be presented twice
// inside the accept window.
type Replay struct {
	mu sync.Mutex
	m  map[[24]byte]int64
}

// See records id (nonce||ts). A duplicate, or a cache already at the cap, is
// an error. ts is unix seconds; entries at or before floor are dropped first.
func (r *Replay) See(id [24]byte, ts int64) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = map[[24]byte]int64{}
	}
	if _, ok := r.m[id]; ok {
		return ErrReplay
	}
	if len(r.m) >= maxReplay {
		// Drop anything older than this token's timestamp minus the window,
		// then fail closed if it is still full.
		floor := ts - int64(defaultSkew/time.Second)
		for k, v := range r.m {
			if v <= floor {
				delete(r.m, k)
			}
		}
		if len(r.m) >= maxReplay {
			return ErrUnauthorized
		}
	}
	r.m[id] = ts
	return nil
}

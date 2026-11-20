// Package lidmap runs one lookup against whatsmeow's identity map under a
// bound that is REAL (ticket #222).
//
// WHY A PACKAGE FOR ONE FUNCTION. The library's cached phone-number-to-LID map
// takes an RWMutex and falls through to Postgres on a miss, and NEITHER the
// mutex nor a stalled query observes a context — so `ctx` around such a call
// is decoration. Three callers need the real thing, all three want the same
// words when it does not answer, and each would otherwise repeat the argument
// for why the bound is worth having:
//
//	the capture guard, resolving a LID-keyed history conversation, which runs
//	on whatsmeow's own event-handler goroutine — a wedge there stops every
//	event behind it;
//
//	the ninety-day fill, resolving the identity to address a request, which
//	runs on the request loop's goroutine — a wedge there leaves the request
//	taken with no outcome and every later request waiting behind it for the
//	life of the process, because the loop serves one at a time;
//
//	and the rig-only history spike, which paid for the reading in the first
//	place (#216, its own Codex round 1).
//
// HOW THE BOUND IS MADE REAL is `plane/bounded`'s subject, and the trade it
// argues reads here as: a process holding one blocked goroutine still
// captures, sends and serves, while one holding a blocked EVENT HANDLER
// captures nothing at all.
package lidmap

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/bounded"
)

// Bounded runs one identity lookup and returns whatever it answers, or says
// the lookup did not answer in time — which is a finding of its own rather
// than a silence to misread as "nothing is known".
//
// THE DANCE ITSELF LIVES IN `plane/bounded` (ticket #222, Codex r3), because
// the socket write turned out to ignore a context for the same reason this
// map does and a second copy of the goroutine-and-select would be the third.
// What stays here is the SUBJECT — the words the timeout reports, which are
// this package's to choose and are content-free by construction.
func Bounded(
	ctx context.Context,
	within time.Duration,
	lookup func(context.Context) (types.JID, error),
) (types.JID, error) {
	return bounded.Call(ctx, within, "the library's identity map", lookup)
}

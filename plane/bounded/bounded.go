// Package bounded runs one call under a deadline that is REAL — enforced by
// this process rather than by the callee's willingness to observe a context
// (ticket #222).
//
// WHY IT EXISTS. Go's context is a cooperative protocol: a callee that never
// checks it cannot be interrupted by it, so `context.WithTimeout` around such
// a call is decoration. Two kinds of callee in this plane are exactly that,
// and both were found by attacking a bound that looked real:
//
//	whatsmeow's cached identity map, which takes an RWMutex and falls through
//	to Postgres on a miss, observing neither;
//
//	whatsmeow's socket write, which acquires the noise socket's write lock
//	BEFORE it checks cancellation — so a stalled acknowledgement on a
//	half-open connection holds that lock, and every rail call behind it waits
//	for as long as the operating system lets the write hang.
//
// THE GOROUTINE IS THE BOUND, and it is deliberately LEAKED when the call
// wedges: the caller is freed and the goroutine dies with whatever finally
// releases the lock, or with the process. That is the correct trade wherever
// the alternative is a caller that never returns — a process holding one
// blocked goroutine still captures, sends and serves.
//
// WHAT IT IS NOT is a retry, and callers must not make it one. A rail call
// abandoned here MAY HAVE REACHED THE SERVER: the write lock is taken before
// the frame is known to be lost, so «did not answer» is ambiguous rather than
// negative. Asking again would risk a second pairing ceremony or a second
// history request the rep pays a notification for.
package bounded

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// ErrDidNotAnswer marks a call ABANDONED AT ITS BOUND, which is a different
// fact from a call that failed: the work may still be in flight, so a caller
// may report it and move on but may not treat it as "did not happen".
var ErrDidNotAnswer = errors.New("the call did not answer within its bound")

// Call runs one call and returns whatever it answers, or says it did not
// answer in time.
//
// `subject` names WHAT did not answer, in the plane's own words, and it is a
// constant at every call site for the reason every plane log line is
// content-free: a subject built from an identity would put a chat or a seat's
// number in the one place ADR-0025 keeps them out of.
//
// The buffered channel is what lets the abandoned goroutine finish and exit
// rather than blocking for ever on a send nobody will receive.
func Call[T any](
	ctx context.Context,
	within time.Duration,
	subject string,
	call func(context.Context) (T, error),
) (T, error) {
	callCtx, cancel := context.WithTimeout(ctx, within)
	defer cancel()
	type answer struct {
		value T
		err   error
	}
	answered := make(chan answer, 1)
	go func() {
		value, err := call(callCtx)
		answered <- answer{value: value, err: err}
	}()
	select {
	case got := <-answered:
		return got.value, got.err
	case <-time.After(within):
		var zero T
		return zero, fmt.Errorf("%w: %s did not answer within %s", ErrDidNotAnswer, subject, within)
	}
}

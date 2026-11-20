package bounded_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Dito-Core/dito/plane/bounded"
)

// A CALL THAT IGNORES CANCELLATION IS STILL BOUND (ticket #222).
//
// This is the whole reason the package exists, and the callee below is the
// honest model of the two real ones: it takes the context and never looks at
// it, exactly as a mutex and a socket write lock do not.
func TestACallThatIgnoresItsContextIsAbandonedAtTheBound(t *testing.T) {
	released := make(chan struct{})
	defer close(released)

	started := time.Now()
	got, err := bounded.Call(context.Background(), 50*time.Millisecond, "the wedged thing",
		func(context.Context) (string, error) {
			<-released
			return "never", nil
		})
	elapsed := time.Since(started)

	if !errors.Is(err, bounded.ErrDidNotAnswer) {
		t.Fatalf("err = %v, want ErrDidNotAnswer", err)
	}
	if got != "" {
		t.Errorf("value = %q, want the zero value — an abandoned call answered nothing", got)
	}
	// A generous ceiling: what would fail here is a bound that never fires,
	// which is the defect, not a slow machine.
	if elapsed > 5*time.Second {
		t.Errorf("returned after %s — the bound did not fire", elapsed)
	}
	if !strings.Contains(err.Error(), "the wedged thing") {
		t.Errorf("error %q does not name its subject", err)
	}
	if !strings.Contains(err.Error(), "50ms") {
		t.Errorf("error %q does not say what bound it hit", err)
	}
}

func TestACallThatAnswersReturnsItsOwnValueAndError(t *testing.T) {
	got, err := bounded.Call(context.Background(), time.Second, "the quick thing",
		func(context.Context) (int, error) { return 7, nil })
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != 7 {
		t.Errorf("value = %d, want 7", got)
	}

	own := errors.New("the callee's own reason")
	_, err = bounded.Call(context.Background(), time.Second, "the failing thing",
		func(context.Context) (int, error) { return 0, own })
	if !errors.Is(err, own) {
		t.Fatalf("err = %v, want the callee's own error unwrapped", err)
	}
	// A FAILURE IS NOT A TIMEOUT. The two are told apart by callers who must
	// not retry an abandoned call (pairing.Serve is one), so a call that
	// failed fast must never carry the abandonment marker.
	if errors.Is(err, bounded.ErrDidNotAnswer) {
		t.Error("a callee's own failure was reported as an abandoned call")
	}
}

// THE CALL SEES A CONTEXT THAT IS CANCELLED AT THE BOUND, so a cooperative
// callee — every Postgres call in this plane — is interrupted rather than
// merely abandoned, and its goroutine ends.
func TestTheCallReceivesABoundedContext(t *testing.T) {
	deadline := make(chan time.Time, 1)
	_, err := bounded.Call(context.Background(), 40*time.Millisecond, "the cooperative thing",
		func(callCtx context.Context) (struct{}, error) {
			if at, ok := callCtx.Deadline(); ok {
				deadline <- at
			}
			<-callCtx.Done()
			return struct{}{}, callCtx.Err()
		})
	if err == nil {
		t.Fatal("err = nil, want the cancellation the callee observed")
	}
	select {
	case <-deadline:
	default:
		t.Error("the callee was handed a context with no deadline")
	}
}

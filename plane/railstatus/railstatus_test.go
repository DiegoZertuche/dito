package railstatus_test

import (
	"runtime"
	"testing"

	"github.com/Dito-Core/dito/plane/internal/vocabulary"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// THE RAIL'S VOCABULARY HAS THREE COPIES AND THIS IS THE THIRD'S OWN PIN
// (ticket #222; #221's recorded remainder).
//
// The words live in `plane/railstatus` (the emitter), in `@dito/seam`'s
// `RAIL_STATUSES` (what rep-web renders per state), and in
// `rail_status_events_status_check` (what the store will accept).
// `migration-vocabulary.test.ts` compares the last two, which is why
// …20260908100050 gives that constraint a name its parser can find — the
// parser looks for `CONSTRAINT <name> CHECK (… IN (…))` and an inline
// constraint has none.
//
// THIS IS THE THIRD COPY'S HALF. A status the plane emits that the store
// refuses is a constraint violation on a real transition: for `pairing_code`
// that is the row carrying the credential the rep is waiting to type, inside a
// window 160 seconds wide (ADR-0031), and for `dropped` it is the plane
// fail-stopping on its own reconnect. So the Go set is compared against the
// migration's own SQL, which is the source of truth for what the database will
// take.
func TestTheStatusesAreExactlyWhatTheStoreAccepts(t *testing.T) {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locating this file")
	}
	granted := vocabulary.CheckSet(t, vocabulary.Dir(self), "rail_status_events_status_check")
	emitted := make([]string, 0, len(railstatus.Statuses))
	for _, status := range railstatus.Statuses {
		emitted = append(emitted, string(status))
	}
	if !vocabulary.Same(granted, emitted) {
		t.Errorf("the plane emits %v and the store accepts %v — a status the plane writes that the store refuses is a constraint violation on a real rail transition",
			emitted, granted)
	}
}

// ...and every status is sorted into the two that carry a CREDENTIAL in
// `detail` and the three that carry nothing, because that division is why
// nothing but the plane holds a grant on that column (…20260907100040,
// …20260908100050). A sixth status added without being sorted here fails,
// which is the moment to re-argue the grant rather than after it has shipped.
func TestEveryStatusIsSortedIntoCredentialCarriersAndPlainTransitions(t *testing.T) {
	carriers := map[railstatus.Status]bool{
		railstatus.StatusQR:          true,
		railstatus.StatusPairingCode: true,
	}
	plain := map[railstatus.Status]bool{
		railstatus.StatusLinked:    true,
		railstatus.StatusDropped:   true,
		railstatus.StatusLoggedOut: true,
	}
	for _, status := range railstatus.Statuses {
		if carriers[status] == plain[status] {
			t.Errorf("%q is sorted as neither a credential carrier nor a plain transition (or as both) — decide which, and re-argue rail_status_events.detail's grant if it carries one", status)
		}
	}
	if len(railstatus.Statuses) != len(carriers)+len(plain) {
		t.Errorf("the plane emits %d statuses and this test sorts %d — a status nobody sorted is one nobody decided the grant for",
			len(railstatus.Statuses), len(carriers)+len(plain))
	}
}

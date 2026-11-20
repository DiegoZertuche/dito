package planereq_test

import (
	"errors"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/Dito-Core/dito/plane/internal/vocabulary"
	"github.com/Dito-Core/dito/plane/planereq"
)

// THE REQUEST SEAM'S FOUR VOCABULARIES, PINNED AGAINST THE STORE (ticket
// #222). Each word has three copies — this package (which writes them),
// `@dito/seam` (which the runtime reads them from), and the store's own CHECK
// — and `migration-vocabulary.test.ts` compares the last two. This is the
// first's half.
//
// WHAT IT CATCHES. `stopped_by` is the sharpest: it is written AFTER the fill
// has paged a chat's history onto the seam and moved the directory row's
// progress, so a word the store refuses leaves the request taken and
// unsettled over work that actually happened — and the next start settles it
// `interrupted`, reporting a fill that ran as one that was cut off.
func TestTheFourVocabulariesAreExactlyWhatTheStoreAccepts(t *testing.T) {
	kinds := make([]string, 0, len(planereq.Kinds))
	for _, kind := range planereq.Kinds {
		kinds = append(kinds, string(kind))
	}
	outcomes := make([]string, 0, len(planereq.Outcomes))
	for _, outcome := range planereq.Outcomes {
		outcomes = append(outcomes, string(outcome))
	}
	reasons := make([]string, 0, len(planereq.Reasons))
	for _, reason := range planereq.Reasons {
		reasons = append(reasons, string(reason))
	}
	stops := make([]string, 0, len(planereq.Stops))
	for _, stop := range planereq.Stops {
		stops = append(stops, string(stop))
	}
	for _, c := range []struct {
		constraint string
		written    []string
	}{
		{"plane_requests_kind_check", kinds},
		{"plane_requests_outcome_check", outcomes},
		{"plane_requests_reason_check", reasons},
		{"plane_requests_stopped_by_check", stops},
	} {
		t.Run(c.constraint, func(t *testing.T) {
			granted := vocabulary.CheckSet(t, migrations(t), c.constraint)
			if !vocabulary.Same(granted, c.written) {
				t.Errorf("the plane writes %v and the store accepts %v", c.written, granted)
			}
		})
	}
}

// THE DIRECTORY ROW'S STOP MARKER IS THE FIFTH VOCABULARY, AND THE SHARPEST
// (ticket #245 F17). The marker is stamped in the SAME statement as the final
// page's progress, so a word the store refuses does not merely lose the marker:
// it rolls back a page of the rep's own history that the seam already holds.
// The set is DERIVED from the two vocabularies above rather than restated, so
// what this catches is a migration re-cutting the CHECK from a stale ancestor.
func TestTheDirectorysStopMarkerHoldsEveryWordAFillCanEndWith(t *testing.T) {
	written := make([]string, 0, len(planereq.FillStops))
	for _, stop := range planereq.FillStops {
		written = append(written, string(stop))
	}
	granted := vocabulary.CheckSet(t, migrations(t), "chat_directory_fill_stopped_by_check")
	if !vocabulary.Same(granted, written) {
		t.Errorf("the fill writes %v and the store accepts %v", written, granted)
	}
	// ...AND IT IS WIDER THAN `stopped_by`, which is the whole reason it is a
	// second vocabulary: an attempt refused by name ended just as finally as a
	// served one, and a refusal that left no marker would leave the card
	// running for ever over a chat nothing will ever fill.
	for _, refusal := range []planereq.Reason{
		planereq.ReasonNoLID, planereq.ReasonNoAnchor, planereq.ReasonRailNotLinked,
	} {
		if !slices.Contains(written, string(refusal)) {
			t.Errorf("the marker's set does not hold %q, which a scope-in ends with", refusal)
		}
	}
}

// A refusal carries its word and nothing a person typed: a reason a person
// could type would be the one column on this table that could hold content.
func TestARefusalCarriesItsClosedWord(t *testing.T) {
	err := planereq.Refuse(planereq.ReasonNoLID)
	var refusal planereq.Refusal
	if !errors.As(err, &refusal) {
		t.Fatalf("Refuse produced %v, which does not read as a refusal", err)
	}
	if refusal.Reason != planereq.ReasonNoLID {
		t.Errorf("reason = %q, want %q", refusal.Reason, planereq.ReasonNoLID)
	}
	if !strings.Contains(err.Error(), string(planereq.ReasonNoLID)) {
		t.Errorf("the refusal reads %q and does not name its own word", err.Error())
	}
}

// migrations is `db/migrations` from this file, so a package that moves does
// not have to count `..`s.
func migrations(t *testing.T) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locating this file")
	}
	return vocabulary.Dir(self)
}

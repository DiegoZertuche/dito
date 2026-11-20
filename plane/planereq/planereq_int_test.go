package planereq_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/planereq"
)

// The request seam at the Postgres seam (ticket #222; spec #214 decisions 7
// and 8): rows the twin runtime writes in, one outcome per row out.
//
// EVERY ROW ENDS WITH AN OUTCOME, whichever way it went, and that is the
// property this file is mostly about: a request left taken and unsettled makes
// its requester wait out a whole timeout and tells the rep nothing happened.

type reqHarness struct {
	db     *sql.DB
	twinID string
	server *planereq.Server
	handed *recordingHandler
	errors *[]error
	// swept counts the passes that reached the directory's own projection —
	// the binary wires `directory.ProjectStops` there (#245 F17).
	swept *int
	// sweepErr, when set, is what that projection answers with.
	sweepErr error
}

func newReqHarness(t *testing.T, handlers ...planereq.Kind) *reqHarness {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	handed := &recordingHandler{}
	wired := map[planereq.Kind]planereq.Handler{}
	for _, kind := range handlers {
		wired[kind] = handed
	}
	var errs []error
	swept := 0
	h := &reqHarness{
		db: db, twinID: uuid.NewString(), handed: handed,
		errors: &errs, swept: &swept,
	}
	h.server = planereq.New(planereq.Config{
		DB:       db,
		TwinID:   h.twinID,
		Handlers: wired,
		OnError:  func(err error) { errs = append(errs, err) },
		OnSwept: func(context.Context) error {
			swept++
			return h.sweepErr
		},
	})
	return h
}

// write puts one request row in place the way the runtime's rep act does.
func (h *reqHarness) write(t *testing.T, kind planereq.Kind, chat types.JID, phone string) string {
	t.Helper()
	var chatValue, parameters any
	parameters = "{}"
	if !chat.IsEmpty() {
		chatValue = chat.String()
	}
	if phone != "" {
		parameters = `{"phone": "` + phone + `"}`
	}
	var id string
	err := h.db.QueryRow(
		`INSERT INTO plane_requests (twin_id, kind, chat_jid, parameters)
		 VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
		h.twinID, string(kind), chatValue, parameters,
	).Scan(&id)
	if err != nil {
		t.Fatalf("writing a %s request: %v", kind, err)
	}
	return id
}

type settled struct {
	outcome   sql.NullString
	reason    sql.NullString
	stoppedBy sql.NullString
	pages     int
	takenAt   sql.NullTime
	settledAt sql.NullTime
}

func (h *reqHarness) read(t *testing.T, id string) settled {
	t.Helper()
	var row settled
	err := h.db.QueryRow(
		`SELECT outcome, reason, stopped_by, pages, taken_at, settled_at
		   FROM plane_requests WHERE id = $1`, id,
	).Scan(&row.outcome, &row.reason, &row.stoppedBy, &row.pages, &row.takenAt, &row.settledAt)
	if err != nil {
		t.Fatalf("reading request %s: %v", id, err)
	}
	return row
}

// recordingHandler is a scripted server of one ask: it records what it was
// handed and answers from a script, which is what lets the loop's own contract
// be asserted without a phone.
type recordingHandler struct {
	seen   []planereq.Request
	result planereq.Result
	err    error
}

func (r *recordingHandler) Serve(_ context.Context, req planereq.Request) (planereq.Result, error) {
	r.seen = append(r.seen, req)
	return r.result, r.err
}

func TestAServedFillRecordsItsPagesAndItsStop(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	chat := types.NewJID("5215550301", types.DefaultUserServer)
	h.handed.result = planereq.Result{Pages: 3, Stop: planereq.StopNinetyDayLine}
	id := h.write(t, planereq.KindScopeIn, chat, "")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	row := h.read(t, id)
	if row.outcome.String != string(planereq.Served) || row.pages != 3 {
		t.Errorf("outcome/pages = %q/%d, want served/3", row.outcome.String, row.pages)
	}
	if row.stoppedBy.String != string(planereq.StopNinetyDayLine) {
		t.Errorf("stopped_by = %q, want %q", row.stoppedBy.String, planereq.StopNinetyDayLine)
	}
	if row.reason.Valid {
		t.Errorf("a served request carries reason %q — served explains itself", row.reason.String)
	}
	if !row.takenAt.Valid || !row.settledAt.Valid {
		t.Errorf("taken/settled = %v/%v, want both stamped", row.takenAt.Valid, row.settledAt.Valid)
	}
	// ...and the handler was handed the chat off the row's own column.
	if len(h.handed.seen) != 1 || h.handed.seen[0].Chat != chat {
		t.Errorf("the handler saw %+v, want one ask about %s", h.handed.seen, chat)
	}
}

// A scope-out serves and pages nothing, and the store refuses a stop on it —
// a stop would describe a loop that never ran.
func TestAServedScopeOutCarriesNoStop(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeOut)
	id := h.write(t, planereq.KindScopeOut, types.NewJID("5215550302", types.DefaultUserServer), "")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	row := h.read(t, id)
	if row.outcome.String != string(planereq.Served) || row.stoppedBy.Valid || row.pages != 0 {
		t.Errorf("row = %q/%v/%d, want served with no stop and no pages", row.outcome.String, row.stoppedBy, row.pages)
	}
}

// A refusal is recorded BY NAME and fetches nothing.
func TestARefusalIsRecordedByName(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	h.handed.err = planereq.Refuse(planereq.ReasonNoAnchor)
	id := h.write(t, planereq.KindScopeIn, types.NewJID("5215550303", types.DefaultUserServer), "")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	row := h.read(t, id)
	if row.outcome.String != string(planereq.Refused) || row.reason.String != string(planereq.ReasonNoAnchor) {
		t.Errorf("outcome/reason = %q/%q, want refused/%q", row.outcome.String, row.reason.String, planereq.ReasonNoAnchor)
	}
	if row.pages != 0 || row.stoppedBy.Valid {
		t.Errorf("a refusal fetched %d page(s) and stopped by %v, want neither", row.pages, row.stoppedBy)
	}
}

// A HANDLER THAT FAILED NEVER FAIL-STOPS THE RAIL: the row is settled `failed`
// with `pass_failed`, the failure is reported loudly, and the loop carries on.
// A plane that died on a bad ask about the rep's own history would take
// capture, the rail and every other request down with it.
func TestAFailedHandlerSettlesTheRowAndTheLoopCarriesOn(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	h.handed.err = errors.New("the seam went away mid-fill")
	first := h.write(t, planereq.KindScopeIn, types.NewJID("5215550304", types.DefaultUserServer), "")
	second := h.write(t, planereq.KindScopeIn, types.NewJID("5215550305", types.DefaultUserServer), "")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass returned on a handler failure, want it absorbed: %v", err)
	}
	for _, id := range []string{first, second} {
		row := h.read(t, id)
		if row.outcome.String != string(planereq.Failed) || row.reason.String != string(planereq.ReasonPassFailed) {
			t.Errorf("request %s = %q/%q, want failed/%q", id, row.outcome.String, row.reason.String, planereq.ReasonPassFailed)
		}
	}
	if len(*h.errors) != 2 {
		t.Errorf("the loop reported %d failure(s), want 2 — absorbed is not silent", len(*h.errors))
	}
}

// A kind this build does not serve is refused rather than left taken: a row
// nothing will ever answer is worse than one answered "not by this build".
func TestAKindWithNoHandlerIsRefusedRatherThanLeftTaken(t *testing.T) {
	h := newReqHarness(t)
	id := h.write(t, planereq.KindPairingCode, types.JID{}, "5215551234567")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	row := h.read(t, id)
	if row.outcome.String != string(planereq.Refused) || row.reason.String != string(planereq.ReasonMalformedParameter) {
		t.Errorf("outcome/reason = %q/%q, want refused/%q", row.outcome.String, row.reason.String, planereq.ReasonMalformedParameter)
	}
}

// The pairing ask's phone reaches the handler off the parameters document, and
// the chat column stays empty — the store's own CHECK pairs them that way.
func TestAPairingAskHandsOverTheSeatsNumberAndNoChat(t *testing.T) {
	h := newReqHarness(t, planereq.KindPairingCode)
	id := h.write(t, planereq.KindPairingCode, types.JID{}, "5215551234567")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	if len(h.handed.seen) != 1 {
		t.Fatalf("the handler saw %d asks, want 1", len(h.handed.seen))
	}
	if got := h.handed.seen[0]; got.Phone != "5215551234567" || !got.Chat.IsEmpty() {
		t.Errorf("the handler saw phone %q and chat %q, want the number and no chat", got.Phone, got.Chat)
	}
	if row := h.read(t, id); row.outcome.String != string(planereq.Served) {
		t.Errorf("outcome = %q, want served", row.outcome.String)
	}
}

// ONE PASS SERVES EVERY PENDING ROW, OLDEST FIRST, ONE AT A TIME — and never
// two chats' fills at once, because the phone notifies the rep once per
// on-demand page (#216's readings).
func TestOnePassServesEveryPendingRowOldestFirst(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	first := types.NewJID("5215550306", types.DefaultUserServer)
	second := types.NewJID("5215550307", types.DefaultUserServer)
	h.write(t, planereq.KindScopeIn, first, "")
	// `requested_at` defaults to clock_timestamp(), so two rows written in the
	// same transaction still order — but ordering is asserted on the ROW's own
	// instant rather than on insertion, so this states it.
	if _, err := h.db.Exec(
		"UPDATE plane_requests SET requested_at = requested_at - interval '1 minute' WHERE twin_id = $1",
		h.twinID,
	); err != nil {
		t.Fatalf("ageing the first request: %v", err)
	}
	h.write(t, planereq.KindScopeIn, second, "")

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	if len(h.handed.seen) != 2 {
		t.Fatalf("the handler saw %d asks, want 2", len(h.handed.seen))
	}
	if h.handed.seen[0].Chat != first || h.handed.seen[1].Chat != second {
		t.Errorf("served %v then %v, want the older first", h.handed.seen[0].Chat, h.handed.seen[1].Chat)
	}
}

// A SECOND PASS SERVES NOTHING AGAIN. The claim is one statement and the poll
// selects on it, so a request is taken once however many times the loop ticks.
func TestASecondPassServesNothingTwice(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	h.write(t, planereq.KindScopeIn, types.NewJID("5215550308", types.DefaultUserServer), "")

	for range 3 {
		if err := h.server.RunOnce(context.Background()); err != nil {
			t.Fatalf("the pass failed: %v", err)
		}
	}
	if len(h.handed.seen) != 1 {
		t.Errorf("the handler saw %d asks over three passes, want 1 — a request is served once", len(h.handed.seen))
	}
}

// ANOTHER TWIN'S REQUESTS ARE NOT THIS PLANE'S. One plane serves one twin, and
// the poll is keyed by it.
func TestAnotherTwinsRequestIsLeftAlone(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	var other string
	err := h.db.QueryRow(
		`INSERT INTO plane_requests (twin_id, kind, chat_jid)
		 VALUES ($1, 'scope_in', '5215550309@s.whatsapp.net') RETURNING id`,
		uuid.NewString(),
	).Scan(&other)
	if err != nil {
		t.Fatalf("writing another twin's request: %v", err)
	}

	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}
	if len(h.handed.seen) != 0 {
		t.Errorf("this plane served %d of another twin's requests, want 0", len(h.handed.seen))
	}
	if row := h.read(t, other); row.takenAt.Valid {
		t.Errorf("another twin's request was taken at %v", row.takenAt.Time)
	}
}

// TAKEN AND UNSETTLED MEANS THE SERVER WENT AWAY, and the next start is what
// answers it: `failed`/`interrupted` rather than re-served, because whether
// the phone answered is unknowable from here and a fill re-asked from a stale
// anchor would re-page a window already read.
func TestTheNextStartSettlesWhatAPreviousProcessLeftTaken(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	id := h.write(t, planereq.KindScopeIn, types.NewJID("5215550310", types.DefaultUserServer), "")
	if _, err := h.db.Exec(
		"UPDATE plane_requests SET taken_at = clock_timestamp() WHERE id = $1", id,
	); err != nil {
		t.Fatalf("claiming the request on behalf of a process that went away: %v", err)
	}

	if err := h.server.SettleStranded(context.Background()); err != nil {
		t.Fatalf("settling stranded requests failed: %v", err)
	}
	row := h.read(t, id)
	if row.outcome.String != string(planereq.Failed) || row.reason.String != string(planereq.ReasonInterrupted) {
		t.Errorf("outcome/reason = %q/%q, want failed/%q", row.outcome.String, row.reason.String, planereq.ReasonInterrupted)
	}
	if len(h.handed.seen) != 0 {
		t.Errorf("a stranded request was re-served %d time(s), want 0", len(h.handed.seen))
	}
	// ...AND THE PASS BRINGS THE CHATS' OWN ROWS UP TO DATE (#245 F17). A fill
	// stamps its end as it goes, but a process that went away stamped none —
	// so the sweep that settles its request also re-derives the markers from
	// the settled rows (`directory.ProjectStops` is what the binary wires
	// here).
	if *h.swept != 1 {
		t.Errorf("the sweep reached the directory's projection %d time(s), want 1", *h.swept)
	}
}

// A PROJECTION THIS PASS COULD NOT WRITE IS ABSORBED AND DONE AGAIN NEXT PASS
// (#245 F17, Codex r2). It is one idempotent statement over rows that are
// already settled, so nothing is lost by failing — and a request the plane
// cannot project must not fail-stop the rail, which is the whole doctrine of
// this loop.
func TestAProjectionTheSweepCannotWriteIsAbsorbedAndRepeated(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	h.sweepErr = errors.New("the directory's markers could not be projected")

	if err := h.server.SettleStranded(context.Background()); err != nil {
		t.Fatalf("a projection that could not be written fail-stopped the sweep: %v", err)
	}
	if len(*h.errors) != 1 {
		t.Fatalf("the loop reported %d error(s), want the one it absorbed", len(*h.errors))
	}
	h.sweepErr = nil
	if err := h.server.SettleStranded(context.Background()); err != nil {
		t.Fatalf("the repeating sweep failed: %v", err)
	}
	if *h.swept != 2 {
		t.Errorf("the projection was attempted %d time(s), want one per pass", *h.swept)
	}
}

func TestASettledRequestSurvivesALaterStart(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	h.handed.result = planereq.Result{Pages: 1, Stop: planereq.StopEmptyPage}
	id := h.write(t, planereq.KindScopeIn, types.NewJID("5215550311", types.DefaultUserServer), "")
	if err := h.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("the pass failed: %v", err)
	}

	if err := h.server.SettleStranded(context.Background()); err != nil {
		t.Fatalf("settling stranded requests failed: %v", err)
	}
	if row := h.read(t, id); row.outcome.String != string(planereq.Served) {
		t.Errorf("outcome = %q after a later start, want served", row.outcome.String)
	}
}

// The loop stops with its context and reports no error for it — a plane being
// shut down is not a failure.
func TestRunStopsWithItsContext(t *testing.T) {
	h := newReqHarness(t, planereq.KindScopeIn)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := h.server.Run(ctx, time.Millisecond); err != nil {
		t.Errorf("Run returned %v on a cancelled context, want nil", err)
	}
}

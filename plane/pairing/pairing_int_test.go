package pairing_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"log"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/companion"
	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/pairing"
	"github.com/Dito-Core/dito/plane/planereq"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// The pairing code at the Postgres seam (ticket #222 AC 3; spec #214 decision
// 9, *Link day, in detail*; ADR-0031). A constructed request in, one rail
// status row out — no live socket, no live phone, and no QR row disturbed.

// fakePairer is the library. It records what it was handed and answers from a
// script, which is how the request's SHAPE can be asserted without a server.
type fakePairer struct {
	phone       string
	push        bool
	clientType  whatsmeow.PairClientType
	displayName string
	// displays is every display it was asked with, in order — which is what
	// makes the ceremony's fallback observable.
	displays    []string
	code        string
	err         error
	timesCalled int
	// block, when non-nil, is waited on WITHOUT looking at the context — the
	// honest model of the noise socket's write lock, which is taken before
	// cancellation is checked.
	block chan struct{}
	// mu guards the recorded fields, because a blocked call is abandoned and
	// its goroutine writes them after the caller has moved on.
	mu sync.Mutex
}

func (f *fakePairer) PairPhone(_ context.Context, phone string, push bool, clientType whatsmeow.PairClientType, displayName string) (string, error) {
	f.mu.Lock()
	f.timesCalled++
	f.phone, f.push, f.clientType, f.displayName = phone, push, clientType, displayName
	f.displays = append(f.displays, displayName)
	block, code, err := f.block, f.code, f.err
	f.mu.Unlock()
	if block != nil {
		<-block
	}
	return code, err
}

func (f *fakePairer) asks() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.displays...)
}

type linked struct{ jid types.JID }

// standing is a link session that is already open and offering codes — the
// state every test here asks the ceremony in. `plane/linksession`'s own suite
// is where a session is opened, ends and is opened again.
type standing struct{}

func (standing) Ready(context.Context) error { return nil }

func (standing) WhileStanding(record func() error) error { return record() }

// unopenable is a link session that cannot be opened.
type unopenable struct{}

func (unopenable) Ready(context.Context) error {
	return errors.New("the link session offered no code within its bound")
}

func (unopenable) WhileStanding(func() error) error {
	return errors.New("no link session stands")
}

func (l linked) SelfJID() (types.JID, bool) { return l.jid, !l.jid.IsEmpty() }

// pairingHarness is the seam, the twin and the handler, in one place: the
// setup was five copies of the same four lines.
type pairingHarness struct {
	db      *sql.DB
	twinID  string
	rail    *fakePairer
	handler *pairing.Pairing
}

func newPairingHarness(t *testing.T, rail *fakePairer, self SelfSource) *pairingHarness {
	return newPairingHarnessWaiting(t, rail, self, 0)
}

// newPairingHarnessWaiting is the same harness with the ceremony's bound named,
// so a rail that never answers can be proven bounded in milliseconds rather
// than in the argued twenty seconds.
func newPairingHarnessWaiting(t *testing.T, rail *fakePairer, self SelfSource, wait time.Duration) *pairingHarness {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	twinID := uuid.NewString()
	return &pairingHarness{
		db: db, twinID: twinID, rail: rail,
		handler: pairing.New(pairing.Config{
			Rail:     rail,
			Recorder: railstatus.NewStore(db, twinID),
			Self:     self,
			Link:     standing{},
			Wait:     wait,
		}),
	}
}

// SelfSource is the live-session identity the handler reads, named here so a
// harness can take either state.
type SelfSource = interface {
	SelfJID() (types.JID, bool)
}

func (h *pairingHarness) railRows(t *testing.T) []railRow {
	t.Helper()
	return railRows(t, h.db, h.twinID)
}

type railRow struct {
	status     string
	detail     string
	occurredAt time.Time
}

func railRows(t *testing.T, db *sql.DB, twinID string) []railRow {
	t.Helper()
	rows, err := db.Query(
		"SELECT status, detail, occurred_at FROM rail_status_events WHERE twin_id = $1 ORDER BY id", twinID,
	)
	if err != nil {
		t.Fatalf("reading rail_status_events: %v", err)
	}
	defer rows.Close()
	var out []railRow
	for rows.Next() {
		var row railRow
		if err := rows.Scan(&row.status, &row.detail, &row.occurredAt); err != nil {
			t.Fatalf("scanning rail_status_events row: %v", err)
		}
		out = append(out, row)
	}
	return out
}

func TestAPairingCodeRequestWritesOneRailStatusRow(t *testing.T) {
	rail := &fakePairer{code: "ABCD1234"}
	// No session: the plane is in a link session, which is the only state a
	// pairing code means anything in.
	h := newPairingHarness(t, rail, linked{})
	// A QR row already stands: link day offers both doors, so the code must
	// not disturb the one the laptop uses.
	if _, err := h.db.Exec(
		"INSERT INTO rail_status_events (twin_id, status, detail, occurred_at) VALUES ($1, 'qr', $2, now())",
		h.twinID, "a-qr-payload",
	); err != nil {
		t.Fatalf("seeding a qr row: %v", err)
	}

	result, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	})
	if err != nil {
		t.Fatalf("serving the pairing-code request failed: %v", err)
	}
	if result.Pages != 0 || result.Stop != "" {
		t.Errorf("result = %+v, want nothing fetched — a pairing code pages nothing", result)
	}

	rows := h.railRows(t)
	if len(rows) != 2 {
		t.Fatalf("want the seeded qr row plus one pairing_code row, got %d", len(rows))
	}
	if rows[0].status != "qr" || rows[0].detail != "a-qr-payload" {
		t.Errorf("the qr row changed to %q/%q — the QR path is untouched", rows[0].status, rows[0].detail)
	}
	code := rows[1]
	if code.status != string(railstatus.StatusPairingCode) {
		t.Errorf("status = %q, want %q", code.status, railstatus.StatusPairingCode)
	}
	if code.detail != "ABCD1234" {
		t.Errorf("detail = %q, want the code exactly as the library returned it", code.detail)
	}
	if code.occurredAt.IsZero() {
		t.Error("occurred_at is unset — a credential's row is stamped when the rep's 160 seconds started")
	}

	// THE REQUEST'S SHAPE, which the server validates and rejects: the number
	// as the request carried it, no push (the rep is holding the phone), and a
	// display name in the one format whatsmeow says is allowed.
	if rail.phone != "5215551234567" {
		t.Errorf("the library was handed %q, want the number the request carried", rail.phone)
	}
	if rail.push {
		t.Error("the pairing asked WhatsApp to notify the rep — every notification comes from the dashboard (ADR-0031)")
	}
	// THE PLATFORM AND THE DISPLAY. The id says this companion is not a
	// browser; the display is a value out of the server's OWN vocabulary,
	// because that field is validated against its list of browsers and
	// operating systems and refused any other (#245 F3).
	if rail.clientType != whatsmeow.PairClientOtherWebClient {
		t.Errorf("client type = %q, want %q — this plane is not a browser, a desktop shell or a phone",
			rail.clientType, whatsmeow.PairClientOtherWebClient)
	}
	if !browserOSShape.MatchString(rail.displayName) {
		t.Errorf("display name %q is not whatsmeow's documented `Browser (OS)` shape", rail.displayName)
	}
	// ...AND ASKED ONCE (#245 F3; boundary #225). A display naming the product
	// comes back refused on every ask, so there is no first choice to try and no
	// refusal to retry: one hello, with a value the documented vocabulary
	// holds.
	if asks := rail.asks(); len(asks) != 1 {
		t.Errorf("the rail was asked with %v, want exactly one hello", asks)
	}
	if strings.Contains(rail.displayName, companion.Name) {
		t.Errorf("display name %q carries the product's name — the server refuses it, and the rep names the device themselves (F15)",
			rail.displayName)
	}
}

// browserOSShape is the format whatsmeow says the server enforces: a first
// word, a space, and a parenthesised second. Pinned as a shape rather than as
// a value because the shape is the half this repo can defend — the server's
// list of "common browsers/OSes" is not checkable from here.
var browserOSShape = regexp.MustCompile(`^[^()]+ \([^()]+\)$`)

// THE HELLO IS THE DOCUMENTED VOCABULARY AND THE DEVICE PROPERTIES ARE DITO'S,
// AND THE TWO ARE INDEPENDENT (#245 F3; boundary #225's F3 and F15).
//
// The hello's display is checked against a list of browsers and operating
// systems, so a display naming the product comes back refused on every ask;
// the device properties are checked against nothing at all and carry the bare
// name the phone's sync notifications show. What this pins is that neither field has
// crept into the other — and that the rep loses nothing by it, because the
// Dispositivos vinculados name is what they type into WhatsApp's own prompt.
func TestTheHelloStatesADocumentedPairAndTheDevicePropertiesTheName(t *testing.T) {
	if companion.Name != "Dito" {
		t.Fatalf("companion.Name = %q — the device properties advertise this and the sync notifications carry it", companion.Name)
	}
	rail := &fakePairer{code: "ABCD1234"}
	h := newPairingHarness(t, rail, linked{})
	if _, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	}); err != nil {
		t.Fatalf("serving the pairing-code request failed: %v", err)
	}
	if strings.Contains(rail.displayName, companion.Name) {
		t.Errorf("the hello states %q, which carries the name the server has no entry for", rail.displayName)
	}
	if store.DeviceProps.GetOs() == rail.displayName {
		t.Errorf("the device properties advertise the hello's display %q — that field takes the bare name", rail.displayName)
	}
}

// A plane that already holds a session refuses BY NAME: `PairPhone` is
// meaningful only during a link session, and pairing over a working link would
// either fail obscurely or replace it.
func TestAPairingCodeRequestOnALinkedPlaneRefusesByName(t *testing.T) {
	rail := &fakePairer{code: "ABCD1234"}
	h := newPairingHarness(t, rail, linked{jid: types.NewJID("5215559999", types.DefaultUserServer)})

	_, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	})
	var refusal planereq.Refusal
	if !errors.As(err, &refusal) || refusal.Reason != planereq.ReasonAlreadyLinked {
		t.Errorf("err = %v, want a %q refusal", err, planereq.ReasonAlreadyLinked)
	}
	if rail.timesCalled != 0 {
		t.Errorf("the library was asked %d time(s) on a linked plane, want 0", rail.timesCalled)
	}
	if rows := h.railRows(t); len(rows) != 0 {
		t.Errorf("a refused pairing wrote %d rail status row(s), want 0", len(rows))
	}
}

// A request with no number is refused rather than asked with an empty one: the
// store's CHECK pairs a phone with this kind, so the only way here is a row
// written past it.
func TestAPairingCodeRequestWithNoNumberIsRefused(t *testing.T) {
	rail := &fakePairer{code: "ABCD1234"}
	h := newPairingHarness(t, rail, linked{})

	_, err := h.handler.Serve(context.Background(), planereq.Request{Kind: planereq.KindPairingCode})
	var refusal planereq.Refusal
	if !errors.As(err, &refusal) || refusal.Reason != planereq.ReasonMalformedParameter {
		t.Errorf("err = %v, want a %q refusal", err, planereq.ReasonMalformedParameter)
	}
	if rail.timesCalled != 0 {
		t.Errorf("the library was asked with an empty number %d time(s), want 0", rail.timesCalled)
	}
}

// THE LIBRARY'S OWN REASON IS NOT CARRIED: it reports pairing work by the
// NUMBER it was pairing, and the number is the rep's own (ADR-0025).
func TestAFailedPairingSaysWhatFailedAndNotWhoseNumberItWas(t *testing.T) {
	h := newPairingHarness(t,
		&fakePairer{err: errors.New("failed to pair 5215551234567: server said no")}, linked{})

	_, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	})
	if err == nil {
		t.Fatal("a failed pairing reported no error")
	}
	if strings.Contains(err.Error(), "5215551234567") {
		t.Errorf("the error carries the seat's number: %q", err.Error())
	}
	if rows := h.railRows(t); len(rows) != 0 {
		t.Errorf("a failed pairing wrote %d rail status row(s), want 0", len(rows))
	}
}

// An empty code is nothing for the rep to type, and a row carrying one would
// be a page rendering a blank credential inside a window that does not come
// back.
func TestAnEmptyCodeIsNotRecorded(t *testing.T) {
	h := newPairingHarness(t, &fakePairer{code: ""}, linked{})

	if _, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	}); err == nil {
		t.Fatal("an empty code was served as a success")
	}
	if rows := h.railRows(t); len(rows) != 0 {
		t.Errorf("an empty code wrote %d rail status row(s), want 0", len(rows))
	}
}

// A DISPLAY THE RAIL REFUSES IS A FAILURE, AND IS NOT ASKED AGAIN (#245 F3).
//
// The hello already states a value out of the documented vocabulary, so a
// refusal of THAT is the rail rejecting its own words — which no second hello
// can fix. Asking again would spend a second twenty
// seconds of the rep's hundred and sixty and risk minting a second code inside
// one window, so the plane fails instead, with no number and no code in the
// error.
func TestARefusedDisplayFailsWithNoRowAndIsNotAskedAgain(t *testing.T) {
	logs := captureLog(t)
	rail := &fakePairer{code: "ABCD1234"}
	h := newPairingHarness(t, rail, linked{})
	// Refuse whatever it is handed.
	rail.err = errors.New("400: companion_platform_display not accepted for 5215551234567")

	_, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	})
	if err == nil {
		t.Fatal("a refused display was served as a success")
	}
	if strings.Contains(err.Error(), "5215551234567") {
		t.Errorf("the error carries the seat's number: %q", err.Error())
	}
	if asks := rail.asks(); len(asks) != 1 {
		t.Errorf("the rail was asked with %v, want exactly one hello — there is no second display to try", asks)
	}
	if rows := h.railRows(t); len(rows) != 0 {
		t.Errorf("a failed pairing wrote %d rail status row(s), want 0", len(rows))
	}
	// AND THE PLANE SAYS NOTHING ABOUT IT ON THE TERMINAL. There is one
	// display and one hello, so there is no choice for a log line to report:
	// the request row's own outcome is the record.
	if strings.Contains(logs.String(), "display") {
		t.Errorf("the plane logged about the display: %q", logs.String())
	}
}

// captureLog redirects the standard logger for one test — the plane's
// telemetry is content-free by construction (ADR-0025), so the lines it leaves
// are part of the contract.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	writer, flags := log.Writer(), log.Flags()
	log.SetFlags(0)
	log.SetOutput(&buf)
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
	})
	return &buf
}

// A CEREMONY THE RAIL NEVER ANSWERS ENDS, AND ENDS ONCE (ticket #222, Codex
// r3).
//
// THE FAILURE THIS REFUSES. `PairPhone` sends an IQ, and whatsmeow's socket
// write takes the noise socket's write lock BEFORE it checks cancellation — so
// on a half-open connection the call observes no deadline at all. Without a
// bound this process enforces, the request stays taken with no outcome, every
// later request waits behind it (the loop serves one at a time), and the pass
// that would settle stranded rows never returns.
//
// AND IT IS NOT RETRIED, which is the second half. An abandoned hello may have
// reached the server, so asking again could mint a SECOND code inside one
// 160-second window — and the rep would be shown whichever landed in the row
// while possibly holding the other. The fallback display exists for a REFUSAL,
// which is a different fact from silence.
func TestAPairingCeremonyTheRailNeverAnswersIsAbandonedAndNotRetried(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	rail := &fakePairer{code: "NEVERSENT", block: release}
	h := newPairingHarnessWaiting(t, rail, linked{}, 50*time.Millisecond)

	started := time.Now()
	_, err := h.handler.Serve(context.Background(), planereq.Request{
		Kind:  planereq.KindPairingCode,
		Phone: "5215551234567",
	})
	elapsed := time.Since(started)

	if err == nil {
		t.Fatal("err = nil, want the abandoned ceremony reported")
	}
	var refusal planereq.Refusal
	if errors.As(err, &refusal) {
		t.Errorf("err = %v, want a failure rather than a refusal — a silent rail is not a reason the store may record", err)
	}
	if elapsed > 5*time.Second {
		t.Errorf("Serve returned after %s — the bound did not fire", elapsed)
	}
	if asks := rail.asks(); len(asks) != 1 {
		t.Errorf("the rail was asked %d time(s) (%v), want exactly one — an abandoned hello is never asked again", len(asks), asks)
	}
	if rows := h.railRows(t); len(rows) != 0 {
		t.Errorf("rail rows = %d, want none: no code was minted, so nothing may claim one", len(rows))
	}
	if strings.Contains(err.Error(), "5215551234567") || strings.Contains(err.Error(), "NEVERSENT") {
		t.Errorf("the error carries the seat's number or the code: %v", err)
	}
}

func TestAPairingCodeRequestWithNoLinkSessionToPairIntoFailsWithoutAHello(t *testing.T) {
	rail := &fakePairer{code: "ABCD1234"}
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	twinID := uuid.NewString()
	handler := pairing.New(pairing.Config{
		Rail:     rail,
		Recorder: railstatus.NewStore(db, twinID),
		Self:     linked{},
		Link:     unopenable{},
	})

	_, err := handler.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindPairingCode, Phone: "5215551234567",
	})
	if err == nil {
		t.Fatal("a pairing ask with no session to pair into was served — the code would be typed into nothing")
	}
	var refusal planereq.Refusal
	if errors.As(err, &refusal) {
		t.Errorf("it was refused %s; it is the plane's failure, settled failed so the page says so", refusal.Reason)
	}
	if rail.timesCalled != 0 {
		t.Errorf("the hello was sent %d times with no session standing, want 0", rail.timesCalled)
	}
	if rows := railRows(t, db, twinID); len(rows) != 0 {
		t.Errorf("rail rows = %+v, want none — no credential came into being", rows)
	}
	if strings.Contains(err.Error(), "5215551234567") {
		t.Error("the failure names the seat's number (ADR-0025)")
	}
}

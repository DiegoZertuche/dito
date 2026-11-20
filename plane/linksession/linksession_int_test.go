package linksession_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/linksession"
	"github.com/Dito-Core/dito/plane/pairing"
	"github.com/Dito-Core/dito/plane/planereq"
	"github.com/Dito-Core/dito/plane/rail"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// A pairing-code ask opens a link session, at the Postgres seam (ticket #403;
// ADR-0005 job 3; ADR-0031). The rail, the request loop, the pairing handler
// and the status rows are the real ones; the library is a fake whose QR
// channel the test drives, which is the whole of what a link session reads
// from WhatsApp.

// fakeLibrary is the client's link surface. Each GetQRChannel is one session;
// Connect offers that session's first code unless the test holds it back.
type fakeLibrary struct {
	mu         sync.Mutex
	opened     int
	current    chan whatsmeow.QRChannelItem
	channelCtx context.Context
	connected  bool
	holdCodes  bool
	connectErr error
}

func (f *fakeLibrary) GetQRChannel(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.connected {
		return nil, whatsmeow.ErrQRAlreadyConnected
	}
	f.opened++
	f.channelCtx = ctx
	f.current = make(chan whatsmeow.QRChannelItem, 8)
	return f.current, nil
}

func (f *fakeLibrary) Connect() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.connectErr != nil {
		return f.connectErr
	}
	f.connected = true
	if !f.holdCodes {
		f.current <- whatsmeow.QRChannelItem{
			Event: whatsmeow.QRChannelEventCode, Code: fmt.Sprintf("qr-of-session-%d", f.opened),
		}
	}
	return nil
}

// runOut is the library ending a session on its own clock: the codes ran out,
// the channel says `timeout` and closes, and the socket goes.
func (f *fakeLibrary) runOut() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.current <- whatsmeow.QRChannelTimeout
	close(f.current)
	f.connected = false
}

func (f *fakeLibrary) sessions() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.opened
}

// identity is the device store's answer to «who is this session», which a
// log-out empties.
type identity struct {
	mu  sync.Mutex
	jid types.JID
}

func (i *identity) GetJID() types.JID {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.jid
}

func (i *identity) GetLID() types.JID { return types.JID{} }

func (i *identity) set(jid types.JID) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.jid = jid
}

// pairer is the library's pairing hello: it answers one code per call.
type pairer struct {
	mu    sync.Mutex
	calls int
	// during, when set, runs inside the hello before the code comes back.
	during func()
}

func (p *pairer) PairPhone(context.Context, string, bool, whatsmeow.PairClientType, string) (string, error) {
	p.mu.Lock()
	p.calls++
	calls, during := p.calls, p.during
	p.mu.Unlock()
	if during != nil {
		during()
	}
	return fmt.Sprintf("CODE%04d", calls), nil
}

type plane struct {
	db       *sql.DB
	twinID   string
	library  *fakeLibrary
	identity *identity
	rail     *rail.Rail
	session  *linksession.Session
	server   *planereq.Server
	spoiled  chan string
	pairer   *pairer
	errs     []error
}

func newPlane(t *testing.T, library *fakeLibrary) *plane {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	p := &plane{
		db: db, twinID: uuid.NewString(), library: library,
		identity: &identity{}, spoiled: make(chan string, 1), pairer: &pairer{},
	}
	p.rail = rail.New(railstatus.NewStore(db, p.twinID), p.identity)
	p.session = linksession.New(context.Background(), linksession.Config{
		Library: library,
		Rail:    p.rail,
		Logf:    t.Logf,
		Spoiled: func(reason string) { p.spoiled <- reason },
		Wait:    time.Second,
	})
	p.server = planereq.New(planereq.Config{
		DB:     db,
		TwinID: p.twinID,
		Handlers: map[planereq.Kind]planereq.Handler{
			planereq.KindPairingCode: pairing.New(pairing.Config{
				Rail:     p.pairer,
				Recorder: railstatus.NewStore(db, p.twinID),
				Self:     p.rail,
				Link:     p.session,
			}),
		},
		OnError: func(err error) { p.errs = append(p.errs, err) },
	})
	return p
}

// ask writes the rep's pairing-code request and runs one pass of the loop.
func (p *plane) ask(t *testing.T) (outcome, reason string) {
	t.Helper()
	var id string
	if err := p.db.QueryRow(
		`INSERT INTO plane_requests (twin_id, kind, parameters)
		 VALUES ($1, 'pairing_code', jsonb_build_object('phone', '5215551234567')) RETURNING id`,
		p.twinID,
	).Scan(&id); err != nil {
		t.Fatalf("writing the pairing-code request: %v", err)
	}
	if err := p.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("running the request loop: %v", err)
	}
	var reasonValue sql.NullString
	var takenAt sql.NullTime
	if err := p.db.QueryRow(
		"SELECT outcome, reason, taken_at FROM plane_requests WHERE id = $1", id,
	).Scan(&outcome, &reasonValue, &takenAt); err != nil {
		t.Fatalf("reading the request back: %v", err)
	}
	if !takenAt.Valid {
		t.Fatal("the request was never taken — the loop must answer an ask whatever the rail last did")
	}
	return outcome, reasonValue.String
}

type row struct{ status, detail string }

func (p *plane) rows(t *testing.T) []row {
	t.Helper()
	rows, err := p.db.Query(
		"SELECT status, detail FROM rail_status_events WHERE twin_id = $1 ORDER BY id", p.twinID,
	)
	if err != nil {
		t.Fatalf("reading rail_status_events: %v", err)
	}
	defer rows.Close()
	var out []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.status, &r.detail); err != nil {
			t.Fatalf("scanning a rail row: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// eventually waits for the rail to have written n rows — the channel is read
// on the session's own goroutine, so its rows land a moment after the item.
func (p *plane) eventually(t *testing.T, n int) []row {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := p.rows(t)
		if len(got) >= n || time.Now().After(deadline) {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func wantRows(t *testing.T, got []row, want []row) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("rail rows = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("rail row %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestAnAskAfterALinkSessionTimedOutOpensAFreshOneWithNoRestart(t *testing.T) {
	library := &fakeLibrary{}
	p := newPlane(t, library)

	// The plane's own start, with no persisted session: the operator's QR.
	if err := p.session.Open(context.Background()); err != nil {
		t.Fatalf("opening the start's link session: %v", err)
	}
	p.eventually(t, 1)
	// ...and the library closing it on its own clock, with nobody scanning.
	library.runOut()
	p.eventually(t, 2)

	outcome, reason := p.ask(t)
	if outcome != string(planereq.Served) {
		t.Fatalf("the ask after a timeout settled %s/%s, want served — a missed window is the rep's to retry, not a restart", outcome, reason)
	}
	if library.sessions() != 2 {
		t.Errorf("the library was asked for %d link sessions, want 2: the start's and the ask's", library.sessions())
	}
	// THE SESSION OUTLIVES THE ASK THAT OPENED IT. The library closes the
	// channel and the socket when the channel's context ends, so a session
	// bound to the request's budget would close the moment the code was served
	// and the rep would type it into nothing.
	library.mu.Lock()
	channelErr := library.channelCtx.Err()
	library.mu.Unlock()
	if channelErr != nil {
		t.Errorf("the session's channel context ended with the ask (%v) — the code was served into a closing session", channelErr)
	}
	// THE STATUS EVENTS ARE AS THEY HAPPENED: a QR, the session ending as the
	// library said, a fresh QR, and the code typed into the fresh session.
	wantRows(t, p.eventually(t, 4), []row{
		{"qr", "qr-of-session-1"},
		{"logged_out", "timeout"},
		{"qr", "qr-of-session-2"},
		{"pairing_code", "CODE0001"},
	})
}

func TestAnAskAfterALogOutOnARunningPlaneOpensALinkSession(t *testing.T) {
	library := &fakeLibrary{}
	p := newPlane(t, library)
	p.identity.set(types.NewJID("5215551234567", types.DefaultUserServer))
	p.rail.HandleEvent(&events.Connected{})

	// Linked: the ask is refused by name and nothing is opened.
	if outcome, reason := p.ask(t); outcome != string(planereq.Refused) || reason != string(planereq.ReasonAlreadyLinked) {
		t.Fatalf("an ask on a linked plane settled %s/%s, want refused/already_linked", outcome, reason)
	}
	// WhatsApp logs the device out while the plane runs: the library deletes
	// the session, so the identity empties, and the rail says so.
	p.identity.set(types.JID{})
	p.rail.HandleEvent(&events.LoggedOut{Reason: events.ConnectFailureLoggedOut})

	outcome, reason := p.ask(t)
	if outcome != string(planereq.Served) {
		t.Fatalf("the ask after a log-out settled %s/%s, want served", outcome, reason)
	}
	if library.sessions() != 1 {
		t.Errorf("the library was asked for %d link sessions, want 1 — opened by the ask and by nothing else", library.sessions())
	}
	wantRows(t, p.eventually(t, 4), []row{
		{"linked", ""},
		{"logged_out", ""},
		{"qr", "qr-of-session-1"},
		{"pairing_code", "CODE0001"},
	})
}

func TestAPlaneThatLostItsSessionOpensNothingUntilAsked(t *testing.T) {
	library := &fakeLibrary{}
	p := newPlane(t, library)
	p.rail.HandleEvent(&events.LoggedOut{Reason: events.ConnectFailureLoggedOut})

	if err := p.server.RunOnce(context.Background()); err != nil {
		t.Fatalf("running the request loop: %v", err)
	}
	if library.sessions() != 0 {
		t.Errorf("the plane opened %d link sessions with no ask on the seam, want 0", library.sessions())
	}
}

func TestASessionThatEndsBeforeItsFirstCodeFailsTheAskAndTheNextAskOpensAnother(t *testing.T) {
	library := &fakeLibrary{holdCodes: true}
	p := newPlane(t, library)

	// The library closes the session before it has offered a code; the ask
	// waiting on it is told so, rather than waiting out its whole bound.
	go func() {
		for library.sessions() == 0 {
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(20 * time.Millisecond)
		library.runOut()
	}()
	outcome, reason := p.ask(t)
	if outcome != string(planereq.Failed) || reason != string(planereq.ReasonPassFailed) {
		t.Fatalf("an ask whose session ended settled %s/%s, want failed/pass_failed", outcome, reason)
	}
	if len(p.errs) != 1 || !errors.Is(p.errs[0], linksession.ErrSessionEnded) {
		t.Errorf("the loop reported %v, want the session's end", p.errs)
	}

	library.mu.Lock()
	library.holdCodes = false
	library.mu.Unlock()
	if outcome, reason := p.ask(t); outcome != string(planereq.Served) {
		t.Fatalf("the ask after a failed one settled %s/%s, want served", outcome, reason)
	}
	wantRows(t, p.eventually(t, 3), []row{
		{"logged_out", "timeout"},
		{"qr", "qr-of-session-2"},
		{"pairing_code", "CODE0001"},
	})
}

func TestADialTheLibraryRefusesFailsTheAskAndSpoilsTheClient(t *testing.T) {
	library := &fakeLibrary{connectErr: errors.New("websocket upgrade refused")}
	p := newPlane(t, library)

	outcome, reason := p.ask(t)
	if outcome != string(planereq.Failed) || reason != string(planereq.ReasonPassFailed) {
		t.Fatalf("an ask whose dial failed settled %s/%s, want failed/pass_failed", outcome, reason)
	}
	select {
	case <-p.spoiled:
	default:
		t.Error("a refused dial did not report the client spoiled — its stale QR listener would close the next session's socket")
	}
	wantRows(t, p.eventually(t, 1), []row{{"logged_out", "dial-failed"}})
}

func TestACodeThatComesBackAfterItsSessionClosedIsNotWritten(t *testing.T) {
	library := &fakeLibrary{}
	p := newPlane(t, library)
	// The library closes the session while the hello is in flight, and its end
	// reaches the seam before the code comes back.
	p.pairer.during = func() {
		library.runOut()
		p.eventually(t, 2)
	}

	outcome, reason := p.ask(t)
	if outcome != string(planereq.Failed) || reason != string(planereq.ReasonPassFailed) {
		t.Fatalf("an ask whose session closed mid-hello settled %s/%s, want failed/pass_failed", outcome, reason)
	}
	// NO `pairing_code` AFTER `logged_out`: the page would read that row as a
	// fresh session with a live code on a socket that is gone.
	wantRows(t, p.rows(t), []row{
		{"qr", "qr-of-session-1"},
		{"logged_out", "timeout"},
	})
}

func TestAPairingThatFailedPartWaySpoilsTheClient(t *testing.T) {
	library := &fakeLibrary{}
	p := newPlane(t, library)
	if err := p.session.Open(context.Background()); err != nil {
		t.Fatalf("opening the start's link session: %v", err)
	}
	p.eventually(t, 1)
	// The library's PairError: an error item, then the channel closes.
	library.mu.Lock()
	library.current <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventError, Error: errors.New("saving the device failed")}
	close(library.current)
	library.connected = false
	library.mu.Unlock()

	select {
	case <-p.spoiled:
	case <-time.After(2 * time.Second):
		t.Fatal("a pairing that failed part way did not spoil the client — its device may hold an identity the store never saved")
	}
	wantRows(t, p.rows(t), []row{
		{"qr", "qr-of-session-1"},
		{"logged_out", "error"},
	})
}

func TestASocketThatNeverOffersACodeIsAbandonedAndTheNextAskOpensAnother(t *testing.T) {
	library := &fakeLibrary{holdCodes: true}
	p := newPlane(t, library)

	if outcome, reason := p.ask(t); outcome != string(planereq.Failed) || reason != string(planereq.ReasonPassFailed) {
		t.Fatalf("an ask on a socket that offered no code settled %s/%s, want failed/pass_failed", outcome, reason)
	}
	select {
	case <-p.spoiled:
	default:
		t.Fatal("a session that never offered a code was left standing — every later ask would wait on it")
	}

	// The binary replaces the client; here the same fake stands in for the
	// fresh one, with its socket gone and its codes flowing.
	library.mu.Lock()
	library.connected = false
	library.holdCodes = false
	library.mu.Unlock()
	if outcome, reason := p.ask(t); outcome != string(planereq.Served) {
		t.Fatalf("the ask after an abandoned session settled %s/%s, want served", outcome, reason)
	}
	wantRows(t, p.eventually(t, 3), []row{
		{"logged_out", "no-code"},
		{"qr", "qr-of-session-2"},
		{"pairing_code", "CODE0001"},
	})
}

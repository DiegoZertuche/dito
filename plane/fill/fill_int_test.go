package fill_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/fill"
	"github.com/Dito-Core/dito/plane/historywindow"
	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/planereq"
)

// The ninety-day fill at the Postgres seam (ticket #222 AC 2; spec #214
// decisions 7 and 8): a scope-in request in, a chain of on-demand requests out,
// the chat's history on the seam and the fill's progress on the directory row.
//
// THE PHONE IS A FAKE RAIL AND EVERY ANSWER IS CONSTRUCTED. There is no live
// socket here and no live phone: the fake records what the fill asked, feeds
// the constructed answer through the SAME `HandleEvent` the socket would, and
// the rows come out of the real capture guard, the real crypto and real
// Postgres (ADR-0028 — the model is the one boundary and this path never
// reaches it).
//
// THE ANSWER IS DISPATCHED FROM INSIDE THE SEND, which is not a shortcut but
// the harder case: the phone can answer inside the send's own acknowledgement
// wait, so the pager holds the arrival and replays it when the request's id is
// known (its own unit tests walk the other arms).
//
// `now` IS THE REAL CLOCK AND EVERY INSTANT IS RELATIVE TO IT, deliberately.
// The fill takes its moment as a parameter; the capture GUARD reads the clock
// where a blob arrives, because a window is "the last N days" from now and
// only the guard knows when now is. Two clocks have to agree for these
// assertions to mean anything, so both are this one — a literal `now` here
// would make every row assertion below go red on the day the real clock passed
// the window, with no code change.

type fillHarness struct {
	db     *sql.DB
	key    []byte
	twinID string
	self   types.JID
	chats  *directory.Store
	ing    *ingest.Ingestor
	pager  *fill.Pager
	scope  *ingest.ScopeReader
	rail   *fakeRail
	// lids is what the LIBRARY's identity map knows, which is a second source
	// beside the directory's own column (`fill.LIDs` argues why it exists).
	lids   map[types.JID]types.JID
	errors *[]error
	// askWait names the bound on ONE ask reaching the phone (fill.Config's
	// AskWait); zero takes the argued default. A test that wedges the rail
	// sets it so the bound can be proven in milliseconds.
	askWait time.Duration
}

func newFillHarness(t *testing.T, window int) *fillHarness {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generating test DEK material: %v", err)
	}
	sealer, err := ingest.NewSealer(key)
	if err != nil {
		t.Fatalf("building sealer: %v", err)
	}
	twinID := uuid.NewString()
	if window > 0 {
		if _, err := db.Exec(
			"INSERT INTO history_windows (twin_id, days) VALUES ($1, $2)", twinID, window,
		); err != nil {
			t.Fatalf("seeding the twin's history window: %v", err)
		}
	}
	self := types.NewJID("5215559999", types.DefaultUserServer)
	chats := directory.New(db, twinID)
	var errs []error
	h := &fillHarness{
		db: db, key: key, twinID: twinID, self: self, chats: chats,
		pager: fill.NewPager(), errors: &errs,
	}
	h.scope = ingest.NewScopeReader(db, twinID, fixedSelf{jid: self})
	h.ing = ingest.New(ingest.Config{
		DB:        db,
		Sealer:    sealer,
		Stamp:     ingest.Stamp{CompanyID: uuid.NewString(), SeatID: uuid.NewString(), TwinID: twinID},
		Self:      fixedSelf{jid: self},
		Directory: chats,
		Window:    historywindow.New(db, twinID),
		OnError:   func(err error) { errs = append(errs, err) },
	})
	// The capture guard first and the pager second, exactly as the binary
	// wires them: whatsmeow dispatches one event to its handlers in
	// registration order on one goroutine, so a page's rows have landed by the
	// time the fill is told the page arrived.
	h.rail = &fakeRail{deliver: func(evt *events.HistorySync) {
		h.ing.HandleEvent(evt)
		h.pager.HandleEvent(evt)
	}}
	return h
}

// msgID returns a message id unique across test runs: the seam's dedupe
// constraint — UNIQUE (source, external_event_id) — is global (ADR-0005, one
// row per rail event), so a repeated fixture id would collide with a previous
// run's row and dedupe the whole page away. The ingest harness carries the same
// helper for the same reason.
func (h *fillHarness) msgID(tag string) string {
	return "3EB0" + h.twinID[:8] + tag
}

func (h *fillHarness) fill(t *testing.T, wait time.Duration, now time.Time) *fill.Fill {
	t.Helper()
	return fill.New(fill.Config{
		Rail:      h.rail,
		Directory: h.chats,
		Window:    historywindow.New(h.db, h.twinID),
		Self:      fixedSelf{jid: h.self},
		Scope:     h.scope,
		LIDs:      libraryLIDs{mapped: h.lids},
		Pager:     h.pager,
		Wait:      wait,
		AskWait:   h.askWait,
		Now:       func() time.Time { return now },
	})
}

// libraryLIDs is whatsmeow's own identity map, with the ONE guard that made
// #245's failure: `CachedLIDMap.GetLIDForPN` refuses any JID whose server is
// not the phone-number one — "invalid GetLIDForPN call with non-PN JID" —
// which is every group, every broadcast and every newsletter
// (`store/sqlstore/lidmap.go`). A fixture that answered those with an empty
// JID would be a fake kinder than the library, and the group would look
// refused here while it failed on the rig.
type libraryLIDs struct{ mapped map[types.JID]types.JID }

func (l libraryLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	if pn.Server != types.DefaultUserServer {
		return types.JID{}, fmt.Errorf("invalid GetLIDForPN call with non-PN JID %s", pn)
	}
	return l.mapped[pn], nil
}

func (h *fillHarness) requireNoErrors(t *testing.T) {
	t.Helper()
	for _, err := range *h.errors {
		t.Errorf("ingest error: %v", err)
	}
}

func (h *fillHarness) allow(t *testing.T, chat types.JID) {
	t.Helper()
	if _, err := h.db.Exec(
		"INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)", h.twinID, chat.String(),
	); err != nil {
		t.Fatalf("seeding scope_allowlist: %v", err)
	}
}

// seed puts one directory row in place the way the pairing push would: a
// conversation keyed by phone number, stating its LID, with one message that
// becomes the anchor.
func (h *fillHarness) seed(t *testing.T, chat, lid types.JID, anchorID string, at time.Time) {
	t.Helper()
	conv := &waHistorySync.Conversation{
		ID:       proto.String(chat.String()),
		LidJID:   proto.String(lid.String()),
		Messages: []*waHistorySync.HistorySyncMsg{{Message: historyRow(chat, anchorID, at)}},
	}
	h.ing.HandleEvent(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType:      waHistorySync.HistorySync_RECENT.Enum(),
		Conversations: []*waHistorySync.Conversation{conv},
	}})
	h.requireNoErrors(t)
}

func (h *fillHarness) progress(t *testing.T, chat types.JID) (pages int, oldest sql.NullTime, word sql.NullString) {
	t.Helper()
	err := h.db.QueryRow(
		`SELECT fill_pages, fill_oldest_at, fill_end_of_transfer FROM chat_directory
		  WHERE twin_id = $1 AND chat_jid = $2`,
		h.twinID, chat.String(),
	).Scan(&pages, &oldest, &word)
	if err != nil {
		t.Fatalf("reading the fill's progress: %v", err)
	}
	return pages, oldest, word
}

// marker is the fill's END as the directory row now carries it (#245 F17): the
// instant, the word, and whether the attempt began over history that already
// stood. `ok` is false for a chat the directory holds no row for.
func (h *fillHarness) marker(t *testing.T, chat types.JID) (stopped sql.NullTime, word sql.NullString, resumed bool, ok bool) {
	t.Helper()
	err := h.db.QueryRow(
		`SELECT fill_stopped_at, fill_stopped_by, fill_resumed FROM chat_directory
		  WHERE twin_id = $1 AND chat_jid = $2`,
		h.twinID, chat.String(),
	).Scan(&stopped, &word, &resumed)
	if errors.Is(err, sql.ErrNoRows) {
		return sql.NullTime{}, sql.NullString{}, false, false
	}
	if err != nil {
		t.Fatalf("reading the fill's stop marker: %v", err)
	}
	return stopped, word, resumed, true
}

// requireMarker is the claim EVERY end of a fill makes on the row: the word,
// and an instant beside it. A word with no instant would read as an attempt
// still working to the card, which decides that from the instant.
func (h *fillHarness) requireMarker(t *testing.T, chat types.JID, want planereq.FillStop) {
	t.Helper()
	stopped, word, _, ok := h.marker(t, chat)
	if !ok {
		t.Fatalf("the chat has no directory row, so the fill's end was recorded nowhere")
	}
	if word.String != string(want) {
		t.Errorf("fill_stopped_by = %q, want %q", word.String, want)
	}
	if !stopped.Valid {
		t.Errorf("fill_stopped_at is unset beside the word %q — the card reads the instant", word.String)
	}
}

func (h *fillHarness) eventIDs(t *testing.T) []string {
	t.Helper()
	rows, err := h.db.Query(
		"SELECT external_event_id FROM wa_events WHERE twin_id = $1 ORDER BY id", h.twinID,
	)
	if err != nil {
		t.Fatalf("reading wa_events: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scanning wa_events row: %v", err)
		}
		out = append(out, id)
	}
	return out
}

type fixedSelf struct{ jid types.JID }

func (f fixedSelf) SelfJID() (types.JID, bool) { return f.jid, !f.jid.IsEmpty() }
func (f fixedSelf) SelfLID() (types.JID, bool) { return types.JID{}, false }

// ask is one request the fill put on the rail, as the fake read it back off
// the proto — which is the only honest way to assert what was SENT.
type ask struct {
	chat      string
	messageID string
	fromMe    bool
	instant   int64
	count     int32
}

// fakeRail is the phone. It records every request, answers each from a script,
// and mints an id per request the way the rail does.
type fakeRail struct {
	mu      sync.Mutex
	asks    []ask
	answers []*events.HistorySync
	// deliver feeds one answer through the capture guard and then the pager,
	// in the binary's own handler order.
	deliver func(*events.HistorySync)
	// afterAnswer runs once a page has landed, with the page's number — the
	// only way to make something happen BETWEEN two pages of one sitting, since
	// the sitting is a single synchronous call.
	afterAnswer func(page int)
	// block, when non-nil, is waited on WITHOUT looking at the context — the
	// honest model of the noise socket's write lock, which is taken before
	// cancellation is checked.
	block chan struct{}
}

func (r *fakeRail) SendPeerMessage(_ context.Context, message *waE2E.Message) (whatsmeow.SendResponse, error) {
	req := message.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	r.mu.Lock()
	if r.block != nil {
		wedge := r.block
		r.asks = append(r.asks, ask{chat: req.GetChatJID(), messageID: req.GetOldestMsgID()})
		r.mu.Unlock()
		<-wedge
		return whatsmeow.SendResponse{}, nil
	}
	r.asks = append(r.asks, ask{
		chat:      req.GetChatJID(),
		messageID: req.GetOldestMsgID(),
		fromMe:    req.GetOldestMsgFromMe(),
		instant:   req.GetOldestMsgTimestampMS(),
		count:     req.GetOnDemandMsgCount(),
	})
	id := "REQ-" + string(rune('A'+len(r.asks)-1))
	answer := (*events.HistorySync)(nil)
	if len(r.answers) > 0 {
		answer, r.answers = r.answers[0], r.answers[1:]
	}
	r.mu.Unlock()
	if answer != nil {
		answer.Notification = &waE2E.HistorySyncNotification{PeerDataRequestSessionID: proto.String(id)}
		// INSIDE THE SEND, before the id is returned: the harder case, and the
		// one the rig saw (an answer three seconds after the ask, on a socket
		// whose acknowledgement had not necessarily come back).
		r.deliver(answer)
	}
	if r.afterAnswer != nil {
		r.afterAnswer(len(r.asks))
	}
	return whatsmeow.SendResponse{ID: types.MessageID(id)}, nil
}

func (r *fakeRail) script(answers ...*events.HistorySync) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.answers = append(r.answers, answers...)
}

func (r *fakeRail) recorded() []ask {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]ask(nil), r.asks...)
}

// historyRow is one message in a constructed history conversation.
func historyRow(key types.JID, id string, at time.Time) *waWeb.WebMessageInfo {
	return &waWeb.WebMessageInfo{
		Key:              &waCommon.MessageKey{RemoteJID: proto.String(key.String()), ID: proto.String(id), FromMe: proto.Bool(false)},
		MessageTimestamp: proto.Uint64(uint64(at.Unix())),
		Message:          &waE2E.Message{Conversation: proto.String("una línea de historia")},
	}
}

// page is a constructed on-demand answer keyed by LID with NEITHER `pnJid` NOR
// `lidJid` stated — the shape the rig phone actually returns (#216's readings
// of 2026-09-07), and the one the capture guard has to resolve through the
// directory.
func page(lid types.JID, transfer waHistorySync.Conversation_EndOfHistoryTransferType, ids []string, instants []time.Time) *events.HistorySync {
	msgs := make([]*waHistorySync.HistorySyncMsg, len(ids))
	for i, id := range ids {
		msgs[i] = &waHistorySync.HistorySyncMsg{Message: historyRow(lid, id, instants[i])}
	}
	return &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_ON_DEMAND.Enum(),
		Conversations: []*waHistorySync.Conversation{{
			ID:                       proto.String(lid.String()),
			Messages:                 msgs,
			EndOfHistoryTransferType: transfer.Enum(),
		}},
	}}
}

func TestAScopeInPagesBackwardsUntilThePhoneSaysNoMore(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550201", types.DefaultUserServer)
	lid := types.NewJID("111222333444555", types.HiddenUserServer)
	h.allow(t, chat)
	anchorAt := now.AddDate(0, 0, -2)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), anchorAt)

	first := []time.Time{now.AddDate(0, 0, -20), now.AddDate(0, 0, -10)}
	second := []time.Time{now.AddDate(0, 0, -40), now.AddDate(0, 0, -30)}
	h.rail.script(
		page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
			[]string{h.msgID("P1-OLD"), h.msgID("P1-NEW")}, first),
		page(lid, waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY,
			[]string{h.msgID("P2-OLD"), h.msgID("P2-NEW")}, second),
	)

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	h.requireNoErrors(t)

	if result.Pages != 2 || result.Stop != planereq.StopNoMoreOnPrimary {
		t.Errorf("result = %d page(s) stopped by %q, want 2 and %q", result.Pages, result.Stop, planereq.StopNoMoreOnPrimary)
	}

	// THE REQUEST CHAIN: the directory's anchor first, then each page's OLDEST
	// message — addressed by the chat's LID both times, because the PN form is
	// never answered (#216).
	asks := h.rail.recorded()
	if len(asks) != 2 {
		t.Fatalf("want 2 requests, got %d", len(asks))
	}
	wantChain := []ask{
		{chat: lid.String(), messageID: h.msgID("ANCHOR"), instant: anchorAt.Unix(), count: 50},
		{chat: lid.String(), messageID: h.msgID("P1-OLD"), instant: first[0].Unix(), count: 50},
	}
	for i, want := range wantChain {
		if asks[i] != want {
			t.Errorf("request %d = %+v, want %+v", i+1, asks[i], want)
		}
	}

	// THE ROWS LAND ON THE PN-CANONICAL CHAT, through the same code that
	// ingests the pairing push, with the backfill marker the payload carries.
	ids := h.eventIDs(t)
	want := []string{
		chat.String() + ":" + h.msgID("ANCHOR"),
		chat.String() + ":" + h.msgID("P1-OLD"),
		chat.String() + ":" + h.msgID("P1-NEW"),
		chat.String() + ":" + h.msgID("P2-OLD"),
		chat.String() + ":" + h.msgID("P2-NEW"),
	}
	if strings.Join(ids, "|") != strings.Join(want, "|") {
		t.Errorf("wa_events = %v, want %v — a LID-keyed page must land on the chat, not beside it", ids, want)
	}

	// ...AND THE PROGRESS MOVED AFTER EVERY PAGE, which is what the rep's sync
	// view reads while this runs.
	pages, oldest, word := h.progress(t, chat)
	if pages != 2 {
		t.Errorf("fill_pages = %d, want 2", pages)
	}
	// TO THE SECOND, because that is all a history row states: the proto's
	// `messageTimestamp` is whole seconds, so the instant that comes back is the
	// one the phone could have sent rather than the one the fixture composed.
	if !oldest.Valid || oldest.Time.UTC().Unix() != second[0].Unix() {
		t.Errorf("fill_oldest_at = %v, want the oldest instant reached %v", oldest.Time.UTC(), second[0])
	}
	if word.String != waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY.String() {
		t.Errorf("fill_end_of_transfer = %q, want the phone's last word", word.String)
	}
	// ...AND THE ATTEMPT'S END IS ON THE ROW, which is what Inicio's card
	// reads instead of inferring «still working» from how long ago a page
	// landed (#245 F17).
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopNoMoreOnPrimary))
}

// The line is a PRIMITIVE and not a constant (spec #214 decision 8; FR-15): a
// twin whose window row says ten days stops at ten days, over the same script
// that pages past ninety.
func TestTheFillStopsAtWhateverTheTwinsWindowRowSays(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 10)
	chat := types.NewJID("5215550202", types.DefaultUserServer)
	lid := types.NewJID("222333444555666", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))

	// One page reaching back twenty days — past a ten-day line, well inside a
	// ninety-day one — and the phone saying more remains.
	crossed := now.AddDate(0, 0, -20)
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
		[]string{h.msgID("CROSSED")}, []time.Time{crossed}))

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Pages != 1 || result.Stop != planereq.StopNinetyDayLine {
		t.Errorf("result = %d page(s) stopped by %q, want 1 and %q", result.Pages, result.Stop, planereq.StopNinetyDayLine)
	}
	if asks := h.rail.recorded(); len(asks) != 1 {
		t.Errorf("the fill asked %d times past its own line, want 1", len(asks))
	}
	// THE LINE IS A FILTER TOO: the crossing page's own row is older than ten
	// days, so the capture guard refused it. Only the anchor rests.
	ids := h.eventIDs(t)
	if len(ids) != 1 || ids[0] != chat.String()+":"+h.msgID("ANCHOR") {
		t.Errorf("wa_events = %v, want only the anchor — a row beyond the window is not written", ids)
	}
	// ...AND THE ROW SAYS SO IN THE SAME STATEMENT THAT MOVED ITS REACH PAST
	// THE LINE (#245 F17). This is the pair the rig showed broken: the reach
	// read «17 de mayo» on a card that also said «Trayendo tu historial».
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopNinetyDayLine))
}

// ...and the same script under a ninety-day window writes that row and pages
// on, which is what makes the test above a statement about the ROW rather than
// about the script.
func TestTheSameScriptUnderANinetyDayWindowKeepsThatRow(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550203", types.DefaultUserServer)
	lid := types.NewJID("333444555666777", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	h.rail.script(
		page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
			[]string{h.msgID("CROSSED")}, []time.Time{now.AddDate(0, 0, -20)}),
		page(lid, waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY,
			[]string{h.msgID("OLDER")}, []time.Time{now.AddDate(0, 0, -25)}),
	)

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Pages != 2 {
		t.Errorf("pages = %d, want 2 under a ninety-day window", result.Pages)
	}
	if n := len(h.eventIDs(t)); n != 3 {
		t.Errorf("wa_events = %d rows, want 3 — the same rows the ten-day window refused", n)
	}
}

// A phone that stops answering ends the sitting with what it fetched standing
// on the directory row: a link day held open by an unresponsive phone is the
// failure the pager's bound exists to refuse.
func TestAPhoneThatStopsAnsweringEndsTheSittingWithItsProgress(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550204", types.DefaultUserServer)
	lid := types.NewJID("444555666777888", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	// One page, then silence: the script runs out and the fake answers nothing.
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
		[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}))

	result, err := h.fill(t, 20*time.Millisecond, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Pages != 1 || result.Stop != planereq.StopWaitTimeout {
		t.Errorf("result = %d page(s) stopped by %q, want 1 and %q", result.Pages, result.Stop, planereq.StopWaitTimeout)
	}
	if pages, _, _ := h.progress(t, chat); pages != 1 {
		t.Errorf("fill_pages = %d, want the page that did land recorded", pages)
	}
	// A SILENCE IS AN END TOO. The page that landed carries no stop — the
	// sitting was still working when it was written — so the marker is
	// stamped on its own (#245 F17).
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopWaitTimeout))
}

// The phone saying "more remains and you may not have it" is a stop of its own
// (`endOfHistoryTransferType` value 3): history exists, so «no more remains»
// would be a lie on the record, and asking again cannot change the answer.
func TestNoAccessIsItsOwnStop(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550205", types.DefaultUserServer)
	lid := types.NewJID("555666777888999", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS,
		[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}))

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Stop != planereq.StopNoAccess {
		t.Errorf("stop = %q, want %q", result.Stop, planereq.StopNoAccess)
	}
	if asks := h.rail.recorded(); len(asks) != 1 {
		t.Errorf("the fill asked %d times after being told it has no access, want 1", len(asks))
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopNoAccess))
}

// An empty page ends it: there was nothing to fetch.
func TestAnEmptyPageEndsTheSitting(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550206", types.DefaultUserServer)
	lid := types.NewJID("666777888999000", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY, nil, nil))

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Pages != 1 || result.Stop != planereq.StopEmptyPage {
		t.Errorf("result = %d page(s) stopped by %q, want 1 and %q", result.Pages, result.Stop, planereq.StopEmptyPage)
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopEmptyPage))
}

// A phone that answers a second request with the page it already gave would
// otherwise page forever, asking the same window and paying for a
// notification on the rep's phone each time.
func TestARepeatedAnchorEndsTheSitting(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550207", types.DefaultUserServer)
	lid := types.NewJID("777888999000111", types.HiddenUserServer)
	h.allow(t, chat)
	anchorAt := now.AddDate(0, 0, -1)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), anchorAt)
	// The phone answers with the anchor itself as the page's oldest message.
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
		[]string{h.msgID("ANCHOR")}, []time.Time{anchorAt}))

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Stop != planereq.StopAnchorRepeated {
		t.Errorf("stop = %q, want %q", result.Stop, planereq.StopAnchorRepeated)
	}
	if asks := h.rail.recorded(); len(asks) != 1 {
		t.Errorf("the fill asked %d times from an anchor it had already used, want 1", len(asks))
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopAnchorRepeated))
}

// EVERY REFUSAL IS DECIDED BEFORE ANYTHING LEAVES THE SOCKET, and named. A
// request the phone can only answer emptily costs a notification on the rep's
// phone for nothing.
func TestTheFillRefusesByNameAndAsksNothing(t *testing.T) {
	now := time.Now().UTC()
	unknown := types.NewJID("5215550208", types.DefaultUserServer)
	anchorless := types.NewJID("5215550209", types.DefaultUserServer)
	lidless := types.NewJID("5215550210", types.DefaultUserServer)
	group := types.NewJID("5215550212-1600000000", types.GroupServer)
	broadcast := types.NewJID("status", types.BroadcastServer)
	windowless := types.NewJID("5215550214", types.DefaultUserServer)

	for _, c := range []struct {
		what   string
		window int
		setUp  func(t *testing.T, h *fillHarness)
		chat   types.JID
		want   planereq.Reason
	}{
		{
			what:   "a chat the plane has never seen",
			window: 90,
			setUp:  func(*testing.T, *fillHarness) {},
			chat:   unknown,
			want:   planereq.ReasonNoDirectoryRow,
		},
		{
			what:   "a chat whose only record came from a contact edit, so it has no anchor",
			window: 90,
			setUp: func(t *testing.T, h *fillHarness) {
				if err := h.chats.Upsert(context.Background(), directory.Entry{
					Chat: anchorless,
					LID:  types.NewJID("888999000111222", types.HiddenUserServer),
					Kind: directory.KindDM,
				}); err != nil {
					t.Fatalf("seeding a directory row with no anchor: %v", err)
				}
			},
			chat: anchorless,
			want: planereq.ReasonNoAnchor,
		},
		{
			what:   "a chat nobody knows a LID for, which the phone would never answer about",
			window: 90,
			setUp: func(t *testing.T, h *fillHarness) {
				if err := h.chats.Upsert(context.Background(), directory.Entry{
					Chat: lidless,
					Kind: directory.KindDM,
					Anchor: directory.Anchor{
						MessageID: h.msgID("ANCHOR"), At: now.AddDate(0, 0, -1),
					},
				}); err != nil {
					t.Fatalf("seeding a directory row with no LID: %v", err)
				}
			},
			chat: lidless,
			want: planereq.ReasonNoLID,
		},
		{
			// THE RIG'S OWN FAILURE (#245 F12; boundary #225). A group has no
			// LID at all, and the library REFUSES to be asked about one — so
			// the scope-in ended in eight milliseconds as `failed pass_failed`
			// with the chat withheld. It is a refusal by name: the plane holds
			// no identity the phone would answer a history request for.
			what:   "a group, which has no LID for the library to be asked about",
			window: 90,
			setUp: func(t *testing.T, h *fillHarness) {
				if err := h.chats.Upsert(context.Background(), directory.Entry{
					Chat: group,
					Kind: directory.KindGroup,
					Anchor: directory.Anchor{
						MessageID: h.msgID("GANCHOR"), At: now.AddDate(0, 0, -1),
					},
				}); err != nil {
					t.Fatalf("seeding a group's directory row: %v", err)
				}
			},
			chat: group,
			want: planereq.ReasonNoLID,
		},
		{
			// ...AND EVERY OTHER ADDRESS FORM THE RAIL HANDS THE GUARD, by the
			// same rule rather than by a list: the status feed is whatsmeow's
			// own standing JID and the directory holds a row for it (its
			// address CHECK admits one on purpose).
			what:   "the status feed, which the library refuses for the same reason",
			window: 90,
			setUp: func(t *testing.T, h *fillHarness) {
				if err := h.chats.Upsert(context.Background(), directory.Entry{
					Chat: broadcast,
					Kind: directory.KindOther,
					Anchor: directory.Anchor{
						MessageID: h.msgID("BANCHOR"), At: now.AddDate(0, 0, -1),
					},
				}); err != nil {
					t.Fatalf("seeding the status feed's directory row: %v", err)
				}
			},
			chat: broadcast,
			want: planereq.ReasonNoLID,
		},
		{
			// A ROW OF ITS OWN, so the marker's claim means something: a twin
			// with a provisioning gap has a directory full of ordinary chats,
			// and every one of them is refused until somebody writes the line.
			what:   "a twin nobody has set a history window for",
			window: 0,
			setUp: func(t *testing.T, h *fillHarness) {
				if err := h.chats.Upsert(context.Background(), directory.Entry{
					Chat: windowless,
					LID:  types.NewJID("999000111222333", types.HiddenUserServer),
					Kind: directory.KindDM,
					Anchor: directory.Anchor{
						MessageID: h.msgID("WANCHOR"), At: now.AddDate(0, 0, -1),
					},
				}); err != nil {
					t.Fatalf("seeding a directory row for a twin with no window: %v", err)
				}
			},
			chat: windowless,
			want: planereq.ReasonNoHistoryWindow,
		},
	} {
		t.Run(c.what, func(t *testing.T) {
			h := newFillHarness(t, c.window)
			c.setUp(t, h)
			_, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
				Kind: planereq.KindScopeIn, Chat: c.chat,
			})
			var refusal planereq.Refusal
			if !errors.As(err, &refusal) {
				t.Fatalf("err = %v, want a named refusal", err)
			}
			if refusal.Reason != c.want {
				t.Errorf("reason = %q, want %q", refusal.Reason, c.want)
			}
			if asks := h.rail.recorded(); len(asks) != 0 {
				t.Errorf("a refused fill put %d request(s) on the rail, want none", len(asks))
			}
			// A REFUSAL IS AN END, AND THE ROW SAYS SO (#245 F17). Nothing will
			// ever fill a group or a chat with no anchor, so a row left unmarked
			// would keep Inicio's card saying «Trayendo tu historial» for ever,
			// over a chat no fill is coming for.
			if c.want == planereq.ReasonNoDirectoryRow {
				// ...except where there is no row to mark, which is the same
				// absence the word names.
				if _, _, _, ok := h.marker(t, c.chat); ok {
					t.Errorf("the directory holds a row for a chat it was never told about")
				}
				return
			}
			h.requireMarker(t, c.chat, planereq.FillStop(c.want))
		})
	}
}

// A rail that is not linked has no socket to ask on — AND THE ROW SAYS SO
// (#245 F17). This is the Conexiones case rather than link day's: scoping is a
// standing capability, so a rep whose number has dropped can mark a chat, and
// the fill that answers them is refused before anything leaves the socket. A
// row left unmarked would keep Inicio's card saying «Trayendo tu historial»
// over a chat no fill is coming for.
func TestAFillWithNoLiveSessionRefusesRailNotLinked(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550211", types.DefaultUserServer)
	h.allow(t, chat)
	h.seed(t, chat, types.NewJID("111222000333444", types.HiddenUserServer), h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	unlinked := fill.New(fill.Config{
		Rail:      h.rail,
		Directory: h.chats,
		Window:    historywindow.New(h.db, h.twinID),
		Self:      fixedSelf{},
		Scope:     h.scope,
		Pager:     h.pager,
		Now:       func() time.Time { return now },
	})
	_, err := unlinked.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	var refusal planereq.Refusal
	if !errors.As(err, &refusal) || refusal.Reason != planereq.ReasonRailNotLinked {
		t.Errorf("err = %v, want a %q refusal", err, planereq.ReasonRailNotLinked)
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.ReasonRailNotLinked))
}

// Scope-out has nothing for the plane to do, and says so: the allowlist row is
// already gone and the guard reads the allowlist per event with no caching, so
// the very next message for that chat is dropped at the socket (ADR-0023).
func TestScopeOutServesWithoutAskingThePhoneAnything(t *testing.T) {
	result, err := fill.ScopeOut{}.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeOut,
		Chat: types.NewJID("5215550212", types.DefaultUserServer),
	})
	if err != nil {
		t.Fatalf("scope-out failed: %v", err)
	}
	if result.Pages != 0 || result.Stop != "" {
		t.Errorf("result = %+v, want nothing fetched and no stop — a scope-out pages nothing", result)
	}
}

// A REP WHO SWITCHES THE CHAT OFF MID-SITTING STOPS THE FILL (ticket #222).
//
// Reachable because the plane serves requests ONE AT A TIME: a scope-out
// written seconds after a scope-in is queued BEHIND the fill it would stop. So
// the sitting asks the capture guard's own rule before every page after the
// first — and without it the fill pages the whole window for a chat the rep
// has just unmarked, every page dropped at the socket, a notification on their
// own phone per page, and a directory row left claiming a fill that landed
// nothing.
func TestAChatDescopedMidSittingStopsTheFill(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550213", types.DefaultUserServer)
	lid := types.NewJID("888999000111222", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))

	// Two pages are scripted and the phone says more remains on both, so only
	// the rep's own act can end this sitting.
	h.rail.script(
		page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
			[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}),
		page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
			[]string{h.msgID("P2")}, []time.Time{now.AddDate(0, 0, -10)}),
	)
	// The rep's scope-out, landing between page one and page two — which is
	// where it lands in life, because the fill is one synchronous sitting.
	h.rail.afterAnswer = func(pageNumber int) {
		if pageNumber != 1 {
			return
		}
		if _, err := h.db.Exec(
			"DELETE FROM scope_allowlist WHERE twin_id = $1 AND chat_jid = $2", h.twinID, chat.String(),
		); err != nil {
			t.Fatalf("descoping the chat mid-sitting: %v", err)
		}
	}

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Stop != planereq.StopDescoped {
		t.Errorf("stop = %q, want %q", result.Stop, planereq.StopDescoped)
	}
	// NO SECOND REQUEST, which is the first half of the point: the rep pays no
	// notification for a chat they have switched off.
	if asks := h.rail.recorded(); len(asks) != 1 {
		t.Errorf("the fill put %d request(s) on the rail, want 1 — the pages after a scope-out would be dropped at the socket", len(asks))
	}
	// ...AND NO PROGRESS OVER A PAGE WHOSE ADMISSION CANNOT BE ESTABLISHED,
	// which is the second half: progress advances only over history the fill
	// can say was admitted and persisted.
	//
	// THE RESIDUE IS NAMED RATHER THAN HIDDEN. The pager reads the arriving
	// blob and not the guard's verdict on it, so a scope-out landing while a
	// page is in flight leaves the fill unable to tell "the guard dropped this"
	// from "the guard took it and the rep descoped a moment later" — and this
	// test is the second case. It therefore UNDER-states by at most one page,
	// which a later scope-in re-fetches for free (the seam's own dedupe
	// collapses the rows; only the notifications are paid twice). The
	// alternative error is a row claiming history the seam may not hold, and
	// between the two the recoverable one is the right one. The exact answer is
	// the guard reporting per-page outcomes back to the fill — a seam of its
	// own, recorded on the ticket.
	if result.Pages != 0 {
		t.Errorf("pages = %d, want 0 — a page the fill cannot prove was admitted is not counted", result.Pages)
	}
	if pages, _, _ := h.progress(t, chat); pages != 0 {
		t.Errorf("fill_pages = %d, want 0 for the same reason", pages)
	}
	// AND THE ROW CARRIES THE REP'S OWN ACT AS THE ATTEMPT'S END, so the card
	// stops saying «Trayendo tu historial» about a chat they switched off — with
	// no clock reading anywhere in the answer (#245 F17).
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopDescoped))
}

// ...and a scope-out that lands BEFORE the sitting's first ask costs no request
// at all. The scope-in act wrote the allowlist row in the same transaction as
// the request, so the chat was in scope when the ask was WRITTEN — the check is
// about the moment it is SERVED, which is a poll tick and a queue later
// (Codex r2).
func TestAScopeOutBeforeTheFirstAskCostsNoRequest(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550215", types.DefaultUserServer)
	lid := types.NewJID("111000222000333", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	// The rep switches it off between the act and the plane's poll.
	if _, err := h.db.Exec(
		"DELETE FROM scope_allowlist WHERE twin_id = $1 AND chat_jid = $2", h.twinID, chat.String(),
	); err != nil {
		t.Fatalf("descoping the chat before the sitting: %v", err)
	}
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
		[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}))

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Stop != planereq.StopDescoped || result.Pages != 0 {
		t.Errorf("result = %d page(s) stopped by %q, want 0 and %q", result.Pages, result.Stop, planereq.StopDescoped)
	}
	if asks := h.rail.recorded(); len(asks) != 0 {
		t.Errorf("the fill put %d request(s) on the rail for an already-descoped chat, want none", len(asks))
	}
}

// ...and a sitting whose chat stays scoped asks the rule and pages on, so the
// test above is a statement about the ACT rather than about the check firing
// on everything.
func TestASittingWhoseChatStaysScopedPagesOn(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550214", types.DefaultUserServer)
	lid := types.NewJID("999000111222333", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	h.rail.script(
		page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY,
			[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}),
		page(lid, waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY,
			[]string{h.msgID("P2")}, []time.Time{now.AddDate(0, 0, -10)}),
	)

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	})
	if err != nil {
		t.Fatalf("the fill failed: %v", err)
	}
	if result.Pages != 2 || result.Stop != planereq.StopNoMoreOnPrimary {
		t.Errorf("result = %d page(s) stopped by %q, want 2 and %q", result.Pages, result.Stop, planereq.StopNoMoreOnPrimary)
	}
}

// AN ASK THE RAIL NEVER ACKNOWLEDGES ENDS THE SITTING, NOT THE LOOP (ticket
// #222, Codex r3).
//
// THE FAILURE THIS REFUSES. The ask reaches whatsmeow's socket write, which
// takes the noise socket's write lock BEFORE it checks cancellation, so on a
// half-open connection neither `askTimeout`'s context nor `planereq`'s
// ten-minute fence is observed by anything. Without a bound this process
// enforces, the request stays taken with no outcome, every later request waits
// behind it — the loop serves one at a time — and the pass that would settle
// stranded rows never returns.
//
// SERVED IS NOT THE ANSWER HERE. A sitting that could not lodge its question
// fetched nothing, so it fails and `planereq` settles it `pass_failed`: a row
// that said «served, zero pages» would tell a later reader the chat was
// exhausted.
func TestAnAskTheRailNeverAcknowledgesEndsTheSitting(t *testing.T) {
	h := newFillHarness(t, 90)
	now := time.Now().UTC()
	chat := types.NewJID("5215550001", types.DefaultUserServer)
	lid := types.NewJID("111111111111111", types.HiddenUserServer)
	h.seed(t, chat, lid, h.msgID("W1"), now.Add(-time.Hour))
	h.allow(t, chat)

	release := make(chan struct{})
	defer close(release)
	h.rail.block = release
	h.askWait = 50 * time.Millisecond

	started := time.Now()
	result, err := h.fill(t, 50*time.Millisecond, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn,
		Chat: chat,
	})
	elapsed := time.Since(started)

	if err == nil {
		t.Fatal("err = nil, want the abandoned ask reported")
	}
	var refusal planereq.Refusal
	if errors.As(err, &refusal) {
		t.Errorf("err = %v, want a failure rather than a refusal — a silent rail is not a reason the store may record", err)
	}
	if elapsed > 5*time.Second {
		t.Errorf("Serve returned after %s — the bound did not fire", elapsed)
	}
	if result.Pages != 0 {
		t.Errorf("pages = %d, want 0: nothing was fetched", result.Pages)
	}
	if pages, _, word := h.progress(t, chat); pages != 0 || word.Valid {
		t.Errorf("directory progress = %d pages, word %v — a sitting that asked nothing records nothing", pages, word)
	}
	if strings.Contains(err.Error(), chat.String()) || strings.Contains(err.Error(), lid.String()) {
		t.Errorf("the error carries the chat's identity: %v", err)
	}
	// ...AND THE ROW SAYS THE ATTEMPT ENDED (#245 F17), on a budget of its own
	// because the sitting's context is what expired. Without the marker the row
	// would read as an attempt still running and Inicio's card would never
	// retire over a chat whose fill the plane could not do.
	h.requireMarker(t, chat, planereq.FillStopPassFailed)

	// AND THE LOOP IS NOT WEDGED: the next sitting reaches its own bound
	// rather than waiting behind the abandoned goroutine.
	if _, err := h.fill(t, 50*time.Millisecond, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn,
		Chat: chat,
	}); err == nil {
		t.Error("the second sitting returned nil — it should reach the same bound")
	}
}

// THE ANCHOR'S OWN MESSAGE IS NOT RECOVERED, AND THIS IS THE TEST THAT SAYS SO
// (ticket #222, Codex r3; the obligation is on the horizon, #117).
//
// WHY IT MATTERS AND WHY IT IS NOT FIXED HERE. The whole point of writing a
// directory row for an out-of-scope chat is that a later scope-in can be
// filled — and the anchor such a row carries is the NEWEST message the plane
// saw while dropping its content. whatsmeow's on-demand request returns the
// messages immediately BEFORE the message it names, so the anchor's own
// message is the one message a first sitting cannot fetch: a chat with exactly
// one message fills empty, and a busier chat comes back missing its newest.
// Both report `served`, which is the part that misleads.
//
// Recovering it needs a DIFFERENT rail request than the one the spike measured
// (#216 measured paging, not single-message recovery), so it is a build rather
// than a correction, and it is recorded on the horizon instead of guessed at
// here.
//
// THE ORDER IS THE POINT. The suite's other sittings allow the chat BEFORE
// seeding it, so their anchor's message is captured by the ordinary guard and
// the gap never shows. This one seeds while the chat is OUT of scope — the
// state the feature exists for — and asserts what actually happens.
func TestAScopeInDoesNotRecoverTheAnchorsOwnMessage(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550301", types.DefaultUserServer)
	lid := types.NewJID("999888777666555", types.HiddenUserServer)
	anchorAt := now.AddDate(0, 0, -2)

	// OUT OF SCOPE FIRST: the row and its anchor land, the content does not.
	h.seed(t, chat, lid, h.msgID("NEWEST"), anchorAt)
	if ids := h.eventIDs(t); len(ids) != 0 {
		t.Fatalf("wa_events = %v, want none — the chat was out of scope when it was seen", ids)
	}
	h.allow(t, chat)

	older := anchorAt.Add(-time.Hour)
	h.rail.answers = []*events.HistorySync{
		page(lid, waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY,
			[]string{h.msgID("OLDER")}, []time.Time{older}),
	}

	result, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn,
		Chat: chat,
	})
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	h.requireNoErrors(t)
	if result.Pages != 1 {
		t.Fatalf("pages = %d, want 1", result.Pages)
	}

	got := h.eventIDs(t)
	if want := []string{chat.String() + ":" + h.msgID("OLDER")}; strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("wa_events = %v, want %v — only the page's own message", got, want)
	}
	// THE RESIDUE, ASSERTED: the anchor's message is absent, and the sitting
	// still reports served over a chat whose newest message the twin does not
	// hold. When the horizon closes this, this assertion is what inverts.
	for _, id := range got {
		if id == chat.String()+":"+h.msgID("NEWEST") {
			t.Fatal("the anchor's own message was recovered — the horizon obligation is closed, invert this assertion")
		}
	}
	if result.Stop != planereq.StopNoMoreOnPrimary {
		t.Errorf("stop = %q, want %q — the phone's word stands", result.Stop, planereq.StopNoMoreOnPrimary)
	}
}

// THE FINAL PAGE AND ITS STOP ARE ONE STATEMENT (#245 F17), and this is the
// discriminator rather than a restatement of the postcondition: a stop word the
// store REFUSES rolls the page back with it. Two statements would leave the
// page recorded and the marker missing — which is precisely the row the rig
// showed, a reach of «17 de mayo» under «Trayendo tu historial».
//
// The refused word is deliberately not one of the thirteen the CHECK holds, so
// what this drives is the store's own fence rather than a mocked failure.
func TestTheFinalPageAndItsStopAreOneStatement(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550216", types.DefaultUserServer)
	lid := types.NewJID("121212121212121", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))

	err := h.chats.RecordPage(context.Background(), chat, now.AddDate(0, 0, -30),
		waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY.String(),
		planereq.FillStop("the phone gave up"))
	if err == nil {
		t.Fatal("the store accepted a stop word outside its own closed set")
	}
	pages, oldest, word := h.progress(t, chat)
	if pages != 0 {
		t.Errorf("fill_pages = %d, want 0 — the page rode with the stop and went back with it", pages)
	}
	if oldest.Valid || word.Valid {
		t.Errorf("the row kept the refused page's reach (%v) and word (%v)", oldest, word)
	}
	if stopped, _, _, _ := h.marker(t, chat); stopped.Valid {
		t.Errorf("the row was marked stopped by a word the store refused")
	}
}

// A NEW FILL CLEARS THE MARKER AND SAYS WHETHER IT IS A RESUME (#245 F17 and
// the F23 rider).
//
// The rep scoped the chat out and back in, so the second sitting starts over
// history that is already there — and a message that arrived while the chat was
// out of scope is not recoverable by any later fill, because the on-demand
// request returns only messages OLDER than its anchor. The rep is told at the
// moment the hole is made, and the fact is STAMPED because it cannot be
// recovered afterwards: once this sitting moves the page count, a first fill
// and a resumed one look identical from the seam.
func TestASecondFillClearsTheMarkerAndStampsTheResume(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550217", types.DefaultUserServer)
	lid := types.NewJID("131313131313131", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))

	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY,
		[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}))
	if _, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	}); err != nil {
		t.Fatalf("the first fill failed: %v", err)
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopNoMoreOnPrimary))
	if _, _, resumed, _ := h.marker(t, chat); resumed {
		t.Errorf("the FIRST fill was stamped as a resume")
	}

	// The second sitting, over a row that already carries a page. Its own
	// answer is scripted so the marker it ends with is a different word,
	// which is what proves the first marker was cleared rather than kept.
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY, nil, nil))
	if _, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	}); err != nil {
		t.Fatalf("the second fill failed: %v", err)
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopEmptyPage))
	if _, _, resumed, _ := h.marker(t, chat); !resumed {
		t.Errorf("the second fill over a row with pages was not stamped as a resume")
	}
}

// ...AND AN ATTEMPT THAT IS REFUSED IS STILL AN ATTEMPT (#245, the F23 rider).
//
// The hole a resume makes is the rep's to be told whether or not the fill that
// followed could run: a group marked again, or a chat scoped from Conexiones
// while the rail is down, has the same messages missing. So the attempt is
// OPENED before anything is decided, which is what puts the resumed fact on the
// row beside a refusal's own word.
func TestARefusedAttemptOnAFilledRowIsStillStampedAsAResume(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550219", types.DefaultUserServer)
	lid := types.NewJID("151515151515151", types.HiddenUserServer)
	h.allow(t, chat)
	h.seed(t, chat, lid, h.msgID("ANCHOR"), now.AddDate(0, 0, -1))
	h.rail.script(page(lid, waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY,
		[]string{h.msgID("P1")}, []time.Time{now.AddDate(0, 0, -5)}))
	if _, err := h.fill(t, time.Second, now).Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	}); err != nil {
		t.Fatalf("the first fill failed: %v", err)
	}

	// The rep marks it again with the rail down, which is Conexiones' own case.
	unlinked := fill.New(fill.Config{
		Rail:      h.rail,
		Directory: h.chats,
		Window:    historywindow.New(h.db, h.twinID),
		Self:      fixedSelf{},
		Scope:     h.scope,
		Pager:     h.pager,
		Now:       func() time.Time { return now },
	})
	if _, err := unlinked.Serve(context.Background(), planereq.Request{
		Kind: planereq.KindScopeIn, Chat: chat,
	}); err == nil {
		t.Fatal("a fill with no live session was served")
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.ReasonRailNotLinked))
	if _, _, resumed, _ := h.marker(t, chat); !resumed {
		t.Errorf("the refused attempt over a row with pages lost the resumed fact")
	}
}

// THE MARKER IS A PROJECTION OF THE REQUEST ROW, AND EVERY PASS RE-DERIVES IT
// (#245 F17, Codex r2).
//
// A fill stamps its own end as it goes, and that write can fail or its process
// can stop between the stamp and the settle — so the marker's correctness rests
// on the settled request rather than on one UPDATE landing at the right moment.
// This drives the three cases the projection has to tell apart: a row with no
// marker over a settled ask takes the ask's own word; a row whose marker is
// NEWER than the newest settled ask belongs to the attempt running right now
// and is left alone; and a row whose marker predates it is brought up to date.
func TestTheProjectionBringsEveryStoppedFillsRowUpToDate(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	unmarked := types.NewJID("5215550220", types.DefaultUserServer)
	running := types.NewJID("5215550221", types.DefaultUserServer)
	stale := types.NewJID("5215550222", types.DefaultUserServer)
	for i, chat := range []types.JID{unmarked, running, stale} {
		h.seed(t, chat, types.NewJID("16161616161616"+string(rune('1'+i)), types.HiddenUserServer),
			h.msgID("PANCHOR"+string(rune('A'+i))), now.AddDate(0, 0, -1))
	}

	// A settled ask per chat: the word the marker owes.
	for _, chat := range []types.JID{unmarked, running, stale} {
		if _, err := h.db.Exec(
			`INSERT INTO plane_requests
			   (twin_id, kind, chat_jid, taken_at, pages, outcome, stopped_by, settled_at)
			 VALUES ($1, 'scope_in', $2, clock_timestamp(), 3, 'served', 'ninety_day_line',
			         clock_timestamp())`,
			h.twinID, chat.String(),
		); err != nil {
			t.Fatalf("seeding a settled scope-in: %v", err)
		}
	}
	// ...and two rows that already carry a marker: one from the attempt running
	// NOW (stamped after the settled ask) and one from an attempt before it.
	if err := h.chats.RecordStop(context.Background(), running, planereq.FillStop(planereq.StopWaitTimeout)); err != nil {
		t.Fatalf("stamping the running attempt's marker: %v", err)
	}
	if _, err := h.db.Exec(
		`UPDATE chat_directory
		    SET fill_stopped_at = clock_timestamp() - interval '1 day',
		        fill_stopped_by = 'empty_page'
		  WHERE twin_id = $1 AND chat_jid = $2`,
		h.twinID, stale.String(),
	); err != nil {
		t.Fatalf("stamping the previous attempt's marker: %v", err)
	}

	if err := h.chats.ProjectStops(context.Background()); err != nil {
		t.Fatalf("projecting the fills' stops: %v", err)
	}

	h.requireMarker(t, unmarked, planereq.FillStop(planereq.StopNinetyDayLine))
	h.requireMarker(t, stale, planereq.FillStop(planereq.StopNinetyDayLine))
	// LEFT ALONE, which is what keeps a fill that is working from being
	// reported as one that ended: its own request is still unsettled, so the
	// newest settled ask is older than the marker it stamped.
	h.requireMarker(t, running, planereq.FillStop(planereq.StopWaitTimeout))
}

// ...AND «NEWEST» IS WHEN THE ASK WAS MADE, NEVER WHEN IT SETTLED (Codex r3).
//
// Settling is absorbed on failure, so an earlier request can be settled by a
// LATER pass than a newer one the loop served in between — giving the older
// attempt the later `settled_at`. Ordered by settlement the projection would
// pick that older attempt and overwrite the newer one's correct word, on this
// pass and on every pass after it. Here the OLD ask carries the later settle
// instant and the NEW one the earlier, which is the shape that inversion has.
func TestTheProjectionReadsTheNewestAskAndNotTheLatestSettle(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550224", types.DefaultUserServer)
	h.seed(t, chat, types.NewJID("191919191919191", types.HiddenUserServer), h.msgID("OANCHOR"), now.AddDate(0, 0, -1))

	// The older ask, settled LAST: the sweep reached it a pass after the newer
	// one had already been served and settled.
	if _, err := h.db.Exec(
		`INSERT INTO plane_requests
		   (twin_id, kind, chat_jid, requested_at, taken_at, pages, outcome, reason, settled_at)
		 VALUES ($1, 'scope_in', $2, clock_timestamp() - interval '2 minutes',
		         clock_timestamp() - interval '2 minutes', 0, 'failed', 'interrupted',
		         clock_timestamp())`,
		h.twinID, chat.String(),
	); err != nil {
		t.Fatalf("seeding the older ask: %v", err)
	}
	// ...and the newer ask, settled FIRST, with the word that should stand.
	if _, err := h.db.Exec(
		`INSERT INTO plane_requests
		   (twin_id, kind, chat_jid, requested_at, taken_at, pages, outcome, stopped_by, settled_at)
		 VALUES ($1, 'scope_in', $2, clock_timestamp() - interval '1 minute',
		         clock_timestamp() - interval '1 minute', 3, 'served', 'ninety_day_line',
		         clock_timestamp() - interval '30 seconds')`,
		h.twinID, chat.String(),
	); err != nil {
		t.Fatalf("seeding the newer ask: %v", err)
	}

	if err := h.chats.ProjectStops(context.Background()); err != nil {
		t.Fatalf("projecting the fills' stops: %v", err)
	}
	h.requireMarker(t, chat, planereq.FillStop(planereq.StopNinetyDayLine))
}

// ...AND IT IS IDEMPOTENT, which is what lets it run at the top of every pass:
// a projection that moved an instant on each tick would make «when did this
// fill end» a question with a new answer every second.
func TestTheProjectionIsIdempotent(t *testing.T) {
	now := time.Now().UTC()
	h := newFillHarness(t, 90)
	chat := types.NewJID("5215550223", types.DefaultUserServer)
	h.seed(t, chat, types.NewJID("181818181818181", types.HiddenUserServer), h.msgID("IANCHOR"), now.AddDate(0, 0, -1))
	if _, err := h.db.Exec(
		`INSERT INTO plane_requests
		   (twin_id, kind, chat_jid, taken_at, pages, outcome, reason, settled_at)
		 VALUES ($1, 'scope_in', $2, clock_timestamp(), 0, 'refused', 'no_lid', clock_timestamp())`,
		h.twinID, chat.String(),
	); err != nil {
		t.Fatalf("seeding a refused scope-in: %v", err)
	}

	if err := h.chats.ProjectStops(context.Background()); err != nil {
		t.Fatalf("projecting the fills' stops: %v", err)
	}
	first, _, _, _ := h.marker(t, chat)
	if err := h.chats.ProjectStops(context.Background()); err != nil {
		t.Fatalf("projecting the fills' stops a second time: %v", err)
	}
	second, word, _, _ := h.marker(t, chat)
	if word.String != string(planereq.ReasonNoLID) {
		t.Errorf("fill_stopped_by = %q, want %q", word.String, planereq.ReasonNoLID)
	}
	if !first.Time.Equal(second.Time) {
		t.Errorf("the marker's instant moved from %v to %v on a second projection", first.Time, second.Time)
	}
}

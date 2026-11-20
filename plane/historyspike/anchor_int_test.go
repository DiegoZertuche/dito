package historyspike_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/historyspike"
	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/internal/testdb"
)

// The Postgres seam is the pre-agreed test seam (spec #18), and the rows the
// anchor is read from are written by the CAPTURE GUARD ITSELF — constructed
// whatsmeow deliveries through ingest — rather than by hand-built fixtures.
// The spike reads what the plane actually writes, so a payload shape that
// moved would fail here rather than at the rig.

type seamHarness struct {
	db     *sql.DB
	ing    *ingest.Ingestor
	seam   historyspike.Seam
	twinID string
	self   types.JID
	errors *[]error
}

// selfIdentity stands in for the live session identity the rail derives
// (ADR-0006: rail.Rail is the binary's sole implementation).
type selfIdentity struct{ jid types.JID }

func (s selfIdentity) SelfJID() (types.JID, bool) { return s.jid, true }
func (s selfIdentity) SelfLID() (types.JID, bool) { return types.JID{}, false }

func newSeamHarness(t *testing.T) *seamHarness {
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
	self := types.NewJID("5215559999", types.DefaultUserServer)
	var errs []error
	ing := ingest.New(ingest.Config{
		DB:        db,
		Sealer:    sealer,
		Stamp:     ingest.Stamp{CompanyID: uuid.NewString(), SeatID: uuid.NewString(), TwinID: twinID},
		Self:      selfIdentity{jid: self},
		Directory: directory.New(db, twinID),
		OnError:   func(err error) { errs = append(errs, err) },
	})
	return &seamHarness{
		db:     db,
		ing:    ing,
		seam:   historyspike.Seam{DB: db, Opener: sealer, TwinID: twinID},
		twinID: twinID,
		self:   self,
		errors: &errs,
	}
}

func (h *seamHarness) allow(t *testing.T, chat types.JID) {
	t.Helper()
	if _, err := h.db.Exec(
		"INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)", h.twinID, chat.String(),
	); err != nil {
		t.Fatalf("seeding scope_allowlist: %v", err)
	}
}

// deliver puts one constructed delivery through the capture guard and fails
// on anything the guard reported — a row that never landed would make the
// anchor assertions below meaningless.
func (h *seamHarness) deliver(t *testing.T, chat types.JID, fromMe bool, id string, at time.Time, body *waE2E.Message) {
	t.Helper()
	sender := chat
	if fromMe {
		sender = h.self
	}
	h.ing.HandleEvent(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsFromMe: fromMe},
			ID:            id,
			Timestamp:     at,
		},
		Message: body,
	})
	for _, err := range *h.errors {
		t.Fatalf("capture guard/ingest: %v", err)
	}
}

func (h *seamHarness) text(t *testing.T, chat types.JID, fromMe bool, id string, at time.Time, text string) {
	t.Helper()
	h.deliver(t, chat, fromMe, id, at, &waE2E.Message{Conversation: proto.String(text)})
}

func (h *seamHarness) rows(t *testing.T) int {
	t.Helper()
	var n int
	if err := h.db.QueryRow("SELECT count(*) FROM wa_events WHERE twin_id = $1", h.twinID).Scan(&n); err != nil {
		t.Fatalf("counting wa_events: %v", err)
	}
	return n
}

// fixtureID keeps ids unique across runs: the seam's dedupe constraint is
// global, so a repeated id would collide with a previous run's row.
func (h *seamHarness) fixtureID(suffix string) string {
	return "3EB0" + h.twinID[:8] + suffix
}

func TestTheAnchorIsTheNewestMessageTheSeamHoldsForTheChat(t *testing.T) {
	h := newSeamHarness(t)
	chat := customerChat()
	h.allow(t, chat)
	newest := time.Date(2026, 9, 4, 17, 23, 51, 0, time.UTC)
	h.text(t, chat, false, h.fixtureID("A1"), newest.Add(-2*time.Hour), "¿tienes de la que lleva siempre?")
	h.text(t, chat, true, h.fixtureID("A2"), newest.Add(-time.Hour), "sí, te aparto dos cajas")
	h.text(t, chat, false, h.fixtureID("A3"), newest, "va, paso mañana")

	anchor, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeNewest)
	if err != nil {
		t.Fatalf("resolving the anchor: %v", err)
	}

	if anchor.MessageID != h.fixtureID("A3") {
		t.Errorf("anchor message id = %q, want the newest message's %q", anchor.MessageID, h.fixtureID("A3"))
	}
	if anchor.FromMe {
		t.Error("anchor direction = from me, want from the counterparty")
	}
	if !anchor.At.Equal(newest) {
		t.Errorf("anchor instant = %s, want %s", anchor.At, newest)
	}
}

func TestTheAnchorCarriesTheNewestMessagesDirection(t *testing.T) {
	h := newSeamHarness(t)
	chat := customerChat()
	h.allow(t, chat)
	at := time.Date(2026, 9, 4, 18, 0, 0, 0, time.UTC)
	h.text(t, chat, false, h.fixtureID("B1"), at.Add(-time.Hour), "¿a qué hora cierran?")
	h.text(t, chat, true, h.fixtureID("B2"), at, "hasta las seis")

	anchor, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeNewest)
	if err != nil {
		t.Fatalf("resolving the anchor: %v", err)
	}

	if !anchor.FromMe {
		t.Error("anchor direction = from the counterparty, want from me")
	}
	if anchor.MessageID != h.fixtureID("B2") {
		t.Errorf("anchor message id = %q, want %q", anchor.MessageID, h.fixtureID("B2"))
	}
}

func TestTheAnchorIsNeverAnotherChatsMessage(t *testing.T) {
	h := newSeamHarness(t)
	chat, other := customerChat(), foreignChat
	h.allow(t, chat)
	h.allow(t, other)
	at := time.Date(2026, 9, 4, 19, 0, 0, 0, time.UTC)
	h.text(t, chat, false, h.fixtureID("C1"), at.Add(-time.Hour), "mándame la cotización")
	h.text(t, other, false, h.fixtureID("C2"), at, "buenas tardes")

	anchor, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeNewest)
	if err != nil {
		t.Fatalf("resolving the anchor: %v", err)
	}

	if anchor.MessageID != h.fixtureID("C1") {
		t.Errorf("anchor message id = %q, want this chat's own newest %q", anchor.MessageID, h.fixtureID("C1"))
	}
}

func TestTheAnchorIsAMessageNotAGestureOrAnUnreadableDelivery(t *testing.T) {
	h := newSeamHarness(t)
	chat := customerChat()
	h.allow(t, chat)
	at := time.Date(2026, 9, 4, 20, 0, 0, 0, time.UTC)
	h.text(t, chat, false, h.fixtureID("D1"), at.Add(-2*time.Hour), "te mando foto de lo que quedó")
	h.deliver(t, chat, false, h.fixtureID("D2"), at.Add(-time.Hour), &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}})
	h.deliver(t, chat, false, h.fixtureID("D3"), at, &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
		Key:  &waCommon.MessageKey{ID: proto.String(h.fixtureID("D1"))},
		Text: proto.String("👍"),
	}})

	anchor, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeNewest)
	if err != nil {
		t.Fatalf("resolving the anchor: %v", err)
	}

	if anchor.MessageID != h.fixtureID("D1") {
		t.Errorf("anchor message id = %q, want the newest MESSAGE %q — a gesture's id is not a position in the chat, and an opaque row's id is composed",
			anchor.MessageID, h.fixtureID("D1"))
	}
}

func TestAChatTheSeamHoldsNothingForHasNoAnchor(t *testing.T) {
	h := newSeamHarness(t)
	chat := customerChat()
	h.allow(t, chat)

	_, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeNewest)

	if !errors.Is(err, historyspike.ErrNoAnchor) {
		t.Fatalf("error = %v, want ErrNoAnchor", err)
	}
}

func TestTheSpikeWritesNothing(t *testing.T) {
	h := newSeamHarness(t)
	chat := customerChat()
	h.allow(t, chat)
	at := time.Date(2026, 9, 4, 21, 0, 0, 0, time.UTC)
	h.text(t, chat, false, h.fixtureID("E1"), at, "¿me apartas otra caja?")
	before := h.rows(t)

	if _, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeNewest); err != nil {
		t.Fatalf("resolving the anchor: %v", err)
	}
	// The phone answers with fifty older messages, and the spike keeps none
	// of them: nothing is ingested, nothing is written (ticket #216).
	watcher := historyspike.NewWatcher(chat)
	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND,
		conversationOf(chat, at.Add(-72*time.Hour), at.Add(-48*time.Hour))))
	if outcome := watcher.Await(bound); outcome.Ending != historyspike.Answered {
		t.Fatalf("ending = %s, want answered", outcome.Ending)
	}

	if after := h.rows(t); after != before {
		t.Errorf("the spike wrote %d wa_events row(s) — it must write none", after-before)
	}
}

func TestTheOldestAnchorIsTheOtherEndOfWhatTheSeamHolds(t *testing.T) {
	// Runs 1 through 3 asked for the fifty messages before the NEWEST, which
	// the companion's own initial sync had already delivered — and a primary
	// that will not resend what it already transferred answers nothing at all
	// (#216). The oldest anchor asks for messages this device never had.
	h := newSeamHarness(t)
	chat := customerChat()
	h.allow(t, chat)
	oldest := time.Date(2026, 9, 4, 15, 0, 0, 0, time.UTC)
	h.text(t, chat, false, h.fixtureID("F1"), oldest, "buenas, ¿tienes cemento?")
	h.text(t, chat, true, h.fixtureID("F2"), oldest.Add(time.Hour), "sí, ¿cuántos bultos?")
	h.text(t, chat, false, h.fixtureID("F3"), oldest.Add(2*time.Hour), "veinte")

	anchor, err := h.seam.Anchor(context.Background(), chat, historyspike.EdgeOldest)
	if err != nil {
		t.Fatalf("resolving the oldest anchor: %v", err)
	}

	if anchor.MessageID != h.fixtureID("F1") {
		t.Errorf("anchor message id = %q, want the OLDEST message's %q", anchor.MessageID, h.fixtureID("F1"))
	}
	if !anchor.At.Equal(oldest) {
		t.Errorf("anchor instant = %s, want %s", anchor.At, oldest)
	}
	if anchor.FromMe {
		t.Error("anchor direction = from me, want from the counterparty")
	}
}

func TestTheSelfChatCanBeAnchoredAtEitherEnd(t *testing.T) {
	// The twin thread is the one in-scope chat whose initial sync was visibly
	// truncated on the rig, so it is the chat run B asks about — and every
	// message in it is the rep's own, which is the direction the request has
	// to carry (#216).
	h := newSeamHarness(t)
	at := time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)
	// No allowlist row: the self-chat's scope is structural (ADR-0023).
	h.text(t, h.self, true, h.fixtureID("G1"), at, "recuérdame surtir a don Chuy")
	h.text(t, h.self, true, h.fixtureID("G2"), at.Add(time.Hour), "va")

	oldest, err := h.seam.Anchor(context.Background(), h.self, historyspike.EdgeOldest)
	if err != nil {
		t.Fatalf("resolving the self-chat's oldest anchor: %v", err)
	}
	newest, err := h.seam.Anchor(context.Background(), h.self, historyspike.EdgeNewest)
	if err != nil {
		t.Fatalf("resolving the self-chat's newest anchor: %v", err)
	}

	if oldest.MessageID != h.fixtureID("G1") || newest.MessageID != h.fixtureID("G2") {
		t.Errorf("anchors = %q / %q, want %q / %q", oldest.MessageID, newest.MessageID, h.fixtureID("G1"), h.fixtureID("G2"))
	}
	if !oldest.FromMe || !newest.FromMe {
		t.Errorf("directions = %t / %t, want both from me — every message in the twin thread is the rep's own", oldest.FromMe, newest.FromMe)
	}
}

func TestTheSelfChatIsAChatTheModeAccepts(t *testing.T) {
	// The rig's own number, as .env.rig holds it: nothing in the flag's
	// parsing may refuse the one chat run B needs.
	chat, err := historyspike.ParseChat("15555550123@s.whatsapp.net")
	if err != nil {
		t.Fatalf("parsing the rig's self-chat: %v", err)
	}
	if chat.User != "15555550123" || chat.Server != types.DefaultUserServer {
		t.Errorf("chat = %q, want the bare self-chat JID", chat)
	}
}

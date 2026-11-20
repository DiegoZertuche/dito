package ingest_test

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/historywindow"
	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/internal/testdb"
)

// The Postgres seam is the pre-agreed test seam (spec #18): constructed
// whatsmeow events go in through the guard, and the assertions read what
// appears — or must NOT appear — in wa_events on the other side, exactly as
// the twin-runtime (#23) will. Guard rules come from the metadata-only
// scope_allowlist config table (ADR-0005/0023), so seeding it is seeding
// config, not reaching into internals.

func seamDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	return testdb.Open(t)
}

// fixedSelf is the live-session identity stand-in: rail.Rail satisfies
// ingest.SelfSource in the binary (ADR-0006 — the sole self source).
type fixedSelf struct {
	jid types.JID
	lid types.JID
}

func (f fixedSelf) SelfJID() (types.JID, bool) { return f.jid, true }
func (f fixedSelf) SelfLID() (types.JID, bool) { return f.lid, !f.lid.IsEmpty() }

// harnessWindowDays is the history window every harness twin is provisioned
// with — FR-15's product default, so an on-demand page's rows are bounded here
// exactly as they are on a provisioned rig (ticket #222). Tests about the BOUND
// state their own instants relative to now rather than moving this number.
const harnessWindowDays = 90

type harness struct {
	db      *sql.DB
	ing     *ingest.Ingestor
	dir     *directory.Store
	key     []byte
	stamp   ingest.Stamp
	self    types.JID
	selfLID types.JID
	errors  *[]error
}

// msgID returns a message id unique across test runs: the seam's dedupe
// constraint — UNIQUE (source, external_event_id) — is global (ADR-0005,
// one row per rail event), so a repeated fixture id would collide with a
// previous run's row and dedupe the event away.
func (h *harness) msgID(suffix string) string {
	return "3EB0" + h.stamp.TwinID[:8] + suffix
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db := seamDB(t)
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generating test DEK material: %v", err)
	}
	sealer, err := ingest.NewSealer(key)
	if err != nil {
		t.Fatalf("building sealer: %v", err)
	}
	stamp := ingest.Stamp{
		CompanyID: uuid.NewString(),
		SeatID:    uuid.NewString(),
		TwinID:    uuid.NewString(),
	}
	self := types.NewJID("5215559999", types.DefaultUserServer)
	selfLID := types.NewJID("999888777666555", types.HiddenUserServer)
	var errs []error
	// The chat directory and the history window are REAL here, as Postgres and
	// the crypto are (ADR-0028): both are this plane's own tables, and the
	// guard now resolves a LID-keyed history conversation through the first and
	// bounds an on-demand page by the second (ticket #222).
	dir := directory.New(db, stamp.TwinID)
	if _, err := db.Exec(
		"INSERT INTO history_windows (twin_id, days) VALUES ($1, $2)", stamp.TwinID, harnessWindowDays,
	); err != nil {
		t.Fatalf("seeding the twin's history window: %v", err)
	}
	ing := ingest.New(ingest.Config{
		DB:        db,
		Sealer:    sealer,
		Stamp:     stamp,
		Self:      fixedSelf{jid: self, lid: selfLID},
		Directory: dir,
		Window:    historywindow.New(db, stamp.TwinID),
		OnError: func(err error) {
			errs = append(errs, err)
		},
	})
	return &harness{db: db, ing: ing, dir: dir, key: key, stamp: stamp, self: self, selfLID: selfLID, errors: &errs}
}

func (h *harness) requireNoErrors(t *testing.T) {
	t.Helper()
	for _, err := range *h.errors {
		t.Errorf("ingest error: %v", err)
	}
}

func (h *harness) allow(t *testing.T, chatJID string) {
	t.Helper()
	_, err := h.db.Exec(
		"INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
		h.stamp.TwinID, chatJID,
	)
	if err != nil {
		t.Fatalf("seeding scope_allowlist: %v", err)
	}
}

type waEventRow struct {
	source          string
	externalEventID string
	eventType       string
	companyID       string
	seatID          string
	occurredAt      time.Time
	payloadEnc      []byte
}

func (h *harness) readEvents(t *testing.T) []waEventRow {
	t.Helper()
	rows, err := h.db.Query(
		"SELECT source, external_event_id, event_type, company_id, seat_id, occurred_at, payload_enc FROM wa_events WHERE twin_id = $1 ORDER BY id",
		h.stamp.TwinID,
	)
	if err != nil {
		t.Fatalf("reading wa_events: %v", err)
	}
	defer rows.Close()
	var out []waEventRow
	for rows.Next() {
		var row waEventRow
		if err := rows.Scan(&row.source, &row.externalEventID, &row.eventType, &row.companyID, &row.seatID, &row.occurredAt, &row.payloadEnc); err != nil {
			t.Fatalf("scanning wa_events row: %v", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading wa_events: %v", err)
	}
	return out
}

// decryptPayload opens the row's envelope with the harness DEK — proving the
// payload rests DEK-encrypted, never plaintext (ADR-0008).
func (h *harness) decryptPayload(t *testing.T, row waEventRow) map[string]any {
	t.Helper()
	plain, err := ingest.OpenEnvelope(h.key, row.payloadEnc)
	if err != nil {
		t.Fatalf("payload_enc does not open under the twin DEK: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(plain, &payload); err != nil {
		t.Fatalf("payload is not the pinned JSON contract: %v", err)
	}
	return payload
}

// textMessage is railDelivery with the one body the seam has a text slot for
// — the general constructor lives beside the shapes that need it (#125), and
// every live fixture builds its MessageInfo through it so the scaffolding has
// one definition.
func textMessage(chat, sender types.JID, fromMe bool, id string, at time.Time, text string) *events.Message {
	return railDelivery(chat, sender, fromMe, id, at, &waE2E.Message{Conversation: proto.String(text)})
}

// countAllRows counts every wa_events row for the harness twin — the "no row,
// no anything" assertion of slice AC 2 (dropped BEFORE persistence).
func (h *harness) countAllRows(t *testing.T) int {
	t.Helper()
	var n int
	if err := h.db.QueryRow("SELECT count(*) FROM wa_events WHERE twin_id = $1", h.stamp.TwinID).Scan(&n); err != nil {
		t.Fatalf("counting wa_events: %v", err)
	}
	return n
}

func TestNonAllowlistedInboundIsDroppedBeforePersistence(t *testing.T) {
	h := newHarness(t)
	stranger := types.NewJID("5215550002", types.DefaultUserServer)
	// No allowlist row for this chat — the twin's scope is empty.
	at := time.Date(2026, 8, 27, 16, 5, 0, 0, time.UTC)

	h.ing.HandleEvent(textMessage(stranger, stranger, false, h.msgID("B1"), at, "promoción exclusiva solo hoy"))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("out-of-scope inbound persisted %d wa_events row(s), want 0 — must be dropped before persistence (ADR-0023)", n)
	}
}

func TestSelfChatIsAlwaysInScopeWithoutAllowlistRow(t *testing.T) {
	h := newHarness(t)
	// The self-chat (twin thread) is NOT on the allowlist — its scope is
	// structural (ADR-0023), never a config row.
	at := time.Date(2026, 8, 27, 16, 10, 0, 0, time.UTC)

	h.ing.HandleEvent(textMessage(h.self, h.self, false, h.msgID("C1"), at, "recuérdame surtir a don Chuy"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("self-chat inbound: want 1 wa_events row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != h.self.String() || got["from_me"] != false {
		t.Errorf("payload chat/from_me = %v/%v, want %v/false", got["chat_jid"], got["from_me"], h.self.String())
	}
}

func TestOwnSentInSelfChatIsCapturedNeverDropped(t *testing.T) {
	h := newHarness(t)
	// The rep's own posts in the twin thread are the affirmation matcher's
	// raw input (ADR-0023/0006) — IsFromMe there must capture, not drop.
	at := time.Date(2026, 8, 27, 16, 15, 0, 0, time.UTC)

	h.ing.HandleEvent(textMessage(h.self, h.self, true, h.msgID("D1"), at, "va"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("own-sent self-chat event: want 1 wa_events row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["from_me"] != true || got["text"] != "va" {
		t.Errorf("payload from_me/text = %v/%v, want true/%q", got["from_me"], got["text"], "va")
	}
}

func TestOwnSentInAllowlistedChatIsCaptured(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550003", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 27, 16, 20, 0, 0, time.UTC)

	// The rep answering the customer from their own phone is rep content in
	// an in-scope chat — both sides of the conversation are twin memory.
	h.ing.HandleEvent(textMessage(customer, h.self, true, h.msgID("E1"), at, "sí, se los aparto"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("own-sent in allowlisted chat: want 1 wa_events row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["from_me"] != true || got["sender_jid"] != h.self.String() {
		t.Errorf("payload from_me/sender = %v/%v, want true/%v", got["from_me"], got["sender_jid"], h.self.String())
	}
}

func TestOwnSentInNonAllowlistedChatIsDropped(t *testing.T) {
	h := newHarness(t)
	private := types.NewJID("5215550004", types.DefaultUserServer)
	// Scope is chat-based (ADR-0023): the rep's own message in an
	// out-of-scope chat is just as out of scope as the counterparty's.
	at := time.Date(2026, 8, 27, 16, 25, 0, 0, time.UTC)

	h.ing.HandleEvent(textMessage(private, h.self, true, h.msgID("F1"), at, "asunto personal"))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("own-sent out-of-scope message persisted %d row(s), want 0", n)
	}
}

func TestDuplicateDeliveryWritesExactlyOneRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550005", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 27, 16, 30, 0, 0, time.UTC)

	// The rail redelivers (reconnect, retry): same source, same external
	// event id — the seam holds exactly one row (ADR-0005 dedupe).
	evt := textMessage(customer, customer, false, h.msgID("G1"), at, "¿tienen entrega el sábado?")
	h.ing.HandleEvent(evt)
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 1 {
		t.Fatalf("duplicate delivery produced %d row(s), want exactly 1", n)
	}
}

func TestDeviceQualifiedJIDsNormalizeToTheBareChat(t *testing.T) {
	h := newHarness(t)
	bare := types.NewJID("5215550006", types.DefaultUserServer)
	h.allow(t, bare.String())
	deviceQualified := bare
	deviceQualified.Device = 7
	at := time.Date(2026, 8, 27, 16, 35, 0, 0, time.UTC)

	// The allowlist stores bare JIDs; a device-qualified (AD) delivery of
	// the same chat must still match, and the persisted identity is bare.
	h.ing.HandleEvent(textMessage(deviceQualified, deviceQualified, false, h.msgID("H1"), at, "¿cuánto el ciento?"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("device-qualified delivery of an allowlisted chat: want 1 row, got %d", len(rows))
	}
	if want := bare.String() + ":" + h.msgID("H1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want bare-normalized %q", rows[0].externalEventID, want)
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != bare.String() || got["sender_jid"] != bare.String() {
		t.Errorf("payload chat/sender = %v/%v, want bare %v", got["chat_jid"], got["sender_jid"], bare.String())
	}
}

func TestQuotedReplyCarriesTextAndQuotedMessageID(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 27, 16, 40, 0, 0, time.UTC)

	// The rep quote-replies «va» on a draft in the self-chat: WhatsApp
	// delivers an ExtendedTextMessage whose ContextInfo carries the quoted
	// message's stanza id. That id is the affirmation matcher's raw input
	// (ADR-0006, ticket #24) — the payload must carry it.
	quotedID := h.msgID("Q0")
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: h.self, Sender: h.self, IsFromMe: true},
			ID:            h.msgID("Q1"),
			Timestamp:     at,
		},
		Message: &waE2E.Message{
			ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text:        proto.String("va"),
				ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String(quotedID)},
			},
		},
	}
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("quoted reply in self-chat: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["text"] != "va" {
		t.Errorf("payload text = %v, want %q", got["text"], "va")
	}
	if got["quoted_message_id"] != quotedID {
		t.Errorf("payload quoted_message_id = %v, want %q", got["quoted_message_id"], quotedID)
	}
}

// lidMessage constructs a LID-addressed delivery of a direct chat: the rail
// addresses the chat by its hidden-user (LID) identity and supplies the
// phone-number identity in SenderAlt/RecipientAlt (whatsmeow's alternative
// addressing for DMs).
func lidMessage(lidUser string, pn types.JID, fromMe bool, id string, at time.Time, text string) *events.Message {
	lid := types.NewJID(lidUser, types.HiddenUserServer)
	src := types.MessageSource{Chat: lid, Sender: lid, IsFromMe: fromMe}
	if fromMe {
		src.RecipientAlt = pn
	} else {
		src.SenderAlt = pn
	}
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: src,
			ID:            id,
			Timestamp:     at,
		},
		Message: &waE2E.Message{Conversation: proto.String(text)},
	}
}

func TestLIDAddressedAllowlistedChatIsCapturedUnderItsPNIdentity(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550008", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 27, 17, 0, 0, 0, time.UTC)

	// The scope allowlist stores the chat's phone-number JID; the same chat
	// delivered LID-addressed is still that chat and must capture — under
	// the PN identity, so scope, dedupe, and #23 all see one chat.
	h.ing.HandleEvent(lidMessage("111222333444555", customer, false, h.msgID("L1"), at, "¿me surtes mañana?"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("LID-addressed delivery of an allowlisted chat: want 1 row, got %d", len(rows))
	}
	if want := customer.String() + ":" + h.msgID("L1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want PN-canonical %q", rows[0].externalEventID, want)
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != customer.String() || got["sender_jid"] != customer.String() {
		t.Errorf("payload chat/sender = %v/%v, want PN-canonical %v", got["chat_jid"], got["sender_jid"], customer.String())
	}
}

func TestLIDAddressedSelfChatOwnSentIsCaptured(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 27, 17, 5, 0, 0, time.UTC)

	// The self-chat delivered under the rep's own LID is still the twin
	// thread: always in scope, own-sent never dropped (ADR-0023).
	h.ing.HandleEvent(lidMessage("999888777666555", h.self, true, h.msgID("L2"), at, "va"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("LID-addressed own-sent self-chat event: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != h.self.String() || got["from_me"] != true {
		t.Errorf("payload chat/from_me = %v/%v, want %v/true", got["chat_jid"], got["from_me"], h.self.String())
	}
	// Own-sent sender is self by definition — one identity, never a LID
	// split of the same participant (the matcher reads sender, #24).
	if got["sender_jid"] != h.self.String() {
		t.Errorf("payload sender_jid = %v, want the live self PN %v", got["sender_jid"], h.self.String())
	}
}

func TestOwnSentSelfChatUnderBareLIDWithNoAlternativeIsCaptured(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 27, 17, 15, 0, 0, time.UTC)

	// The rail can deliver the self-chat addressed purely by the account's
	// own LID, with no PN alternative attached. The live session knows its
	// own LID (rail.SelfLID, ADR-0006) — the guard must recognize the twin
	// thread structurally and never drop it to the allowlist (ADR-0023).
	lid := types.NewJID(h.selfLID.User, types.HiddenUserServer)
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: lid, Sender: lid, IsFromMe: true},
			ID:            h.msgID("L4"),
			Timestamp:     at,
		},
		Message: &waE2E.Message{Conversation: proto.String("va")},
	}
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("bare-LID own-sent self-chat event: want 1 row, got %d", len(rows))
	}
	if want := h.self.String() + ":" + h.msgID("L4"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want PN-canonical %q", rows[0].externalEventID, want)
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != h.self.String() || got["sender_jid"] != h.self.String() || got["from_me"] != true {
		t.Errorf("payload chat/sender/from_me = %v/%v/%v, want %v/%v/true", got["chat_jid"], got["sender_jid"], got["from_me"], h.self.String(), h.self.String())
	}
}

func TestLIDAddressedNonAllowlistedChatIsDropped(t *testing.T) {
	h := newHarness(t)
	stranger := types.NewJID("5215550009", types.DefaultUserServer)
	at := time.Date(2026, 8, 27, 17, 10, 0, 0, time.UTC)

	h.ing.HandleEvent(lidMessage("444555666777888", stranger, false, h.msgID("L3"), at, "oferta limitada"))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("LID-addressed out-of-scope message persisted %d row(s), want 0", n)
	}
}

// unknownSelf models a session whose identity is not derivable — the state
// before a device links (rail.SelfJID returns not-ok).
type unknownSelf struct{}

func (unknownSelf) SelfJID() (types.JID, bool) { return types.JID{}, false }
func (unknownSelf) SelfLID() (types.JID, bool) { return types.JID{}, false }

func TestGuardRefusesLoudlyWhenSelfIdentityIsUnknown(t *testing.T) {
	h := newHarness(t)
	var errs []error
	ing := ingest.New(ingest.Config{
		DB:        h.db,
		Sealer:    mustSealer(t, h.key),
		Stamp:     h.stamp,
		Self:      unknownSelf{},
		Directory: h.dir,
		OnError: func(err error) {
			errs = append(errs, err)
		},
	})
	customer := types.NewJID("5215550007", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 27, 16, 45, 0, 0, time.UTC)

	// Without self identity the guard cannot tell the self-chat from any
	// other chat — deciding scope would risk silently dropping self-chat
	// traffic ("always in scope, never dropped", ADR-0023). It must refuse
	// loudly and write nothing, even for an allowlisted chat.
	ing.HandleEvent(textMessage(customer, customer, false, h.msgID("I1"), at, "¿ya salió el pedido?"))
	ing.HandleEvent(textMessage(h.self, h.self, true, h.msgID("I2"), at, "va"))

	if len(errs) != 2 {
		t.Fatalf("want 2 loud guard refusals, got %d: %v", len(errs), errs)
	}
	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("guard without self identity persisted %d row(s), want 0", n)
	}
}

func mustSealer(t *testing.T, key []byte) *ingest.Sealer {
	t.Helper()
	s, err := ingest.NewSealer(key)
	if err != nil {
		t.Fatalf("building sealer: %v", err)
	}
	return s
}

func TestNonMessageEventsWriteNothing(t *testing.T) {
	h := newHarness(t)
	// The skeleton ingests messages only; any other rail event passes
	// through untouched — and never panics the handler.
	h.ing.HandleEvent(&events.Connected{})
	h.ing.HandleEvent("not an event at all")
	h.ing.HandleEvent(nil)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("non-message events persisted %d row(s), want 0", n)
	}
}

func TestAllowlistedInboundIsCapturedDEKEncrypted(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550001", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 27, 16, 0, 0, 0, time.UTC)

	h.ing.HandleEvent(textMessage(customer, customer, false, h.msgID("A1"), at, "¿me mandas 40 cajas para el jueves?"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want exactly 1 wa_events row, got %d", len(rows))
	}
	row := rows[0]
	if row.source != "whatsapp" {
		t.Errorf("source = %q, want %q", row.source, "whatsapp")
	}
	if want := "5215550001@s.whatsapp.net:" + h.msgID("A1"); row.externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", row.externalEventID, want)
	}
	if row.eventType != "message" {
		t.Errorf("event_type = %q, want %q", row.eventType, "message")
	}
	if row.companyID != h.stamp.CompanyID || row.seatID != h.stamp.SeatID {
		t.Errorf("company/seat stamp = %q/%q, want %q/%q", row.companyID, row.seatID, h.stamp.CompanyID, h.stamp.SeatID)
	}
	if !row.occurredAt.Equal(at) {
		t.Errorf("occurred_at = %v, want %v", row.occurredAt, at)
	}

	want := map[string]any{
		"v":          float64(1),
		"chat_jid":   "5215550001@s.whatsapp.net",
		"sender_jid": "5215550001@s.whatsapp.net",
		"from_me":    false,
		"message_id": h.msgID("A1"),
		"text":       "¿me mandas 40 cajas para el jueves?",
	}
	if got := h.decryptPayload(t, row); !reflect.DeepEqual(got, want) {
		t.Errorf("payload = %#v, want %#v", got, want)
	}
}

// Payload v:1 grows the additive sender push-name field (ticket #30, spec
// #29 decision 7): the rail's sender push name rides inside the encrypted
// payload so the twin can name the cliente (Mock A) before bindings exist.
// Additive only (#22 contract): nothing else about the payload moves.
func TestInboundPushNameIsCapturedInThePayload(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550001", types.DefaultUserServer)
	h.allow(t, customer.String())

	evt := textMessage(customer, customer, false, h.msgID("PN1"), time.Now(), "¿tiene disponibilidad?")
	evt.Info.PushName = "Sra. Garza"
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want exactly 1 wa_events row, got %d", len(rows))
	}
	payload := h.decryptPayload(t, rows[0])
	if got := payload["push_name"]; got != "Sra. Garza" {
		t.Errorf("payload push_name = %#v, want %q", got, "Sra. Garza")
	}
	// Still v:1 — the field is additive evolution, not a new version.
	if got := payload["v"]; got != float64(1) {
		t.Errorf("payload v = %#v, want 1", got)
	}
}

// Absence-tolerance (#22 contract): a rail delivery with no push name —
// common for own-sent traffic and unnamed contacts — omits the field
// entirely rather than stamping an empty string, so v:1 consumers that
// predate the field see byte-identical payloads.
func TestPayloadOmitsPushNameWhenTheRailSuppliesNone(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550001", types.DefaultUserServer)
	h.allow(t, customer.String())

	h.ing.HandleEvent(textMessage(customer, customer, false, h.msgID("PN2"), time.Now(), "buenas tardes"))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want exactly 1 wa_events row, got %d", len(rows))
	}
	payload := h.decryptPayload(t, rows[0])
	if _, present := payload["push_name"]; present {
		t.Errorf("payload carries push_name %#v for a delivery with none — want the field absent", payload["push_name"])
	}
}

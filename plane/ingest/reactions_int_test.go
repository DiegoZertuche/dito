package ingest_test

import (
	"math"
	"reflect"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// Reactions at the Postgres seam (ticket #100, ADR-0041). whatsmeow has no
// separate reaction event: a 👍 arrives as an ordinary *events.Message whose
// ReactionMessage is set, so it already reaches the capture guard — and
// before this ticket it landed as an empty-text 'message' husk. These tests
// feed constructed rail deliveries through the SAME guard and assert what
// appears in wa_events on the other side, decrypted with the real crypto and
// compared against the wire shape pinned in packages/seam/src/wa-payload.ts.

// reactionEvent constructs the rail's delivery of a reaction. Two identities
// are deliberately different: Info.ID is the REACTION's own fresh stanza id
// (whatsmeow gives a reaction one, which is what makes seam dedupe work for
// it), and the reaction key carries the TARGET message's id. senderTsMS of 0
// models a delivery whose rail supplied no sender timestamp.
func reactionEvent(chat, sender types.JID, fromMe bool, id string, at time.Time, targetID, emoji string, senderTsMS int64) *events.Message {
	r := &waE2E.ReactionMessage{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(chat.String()),
			// FromMe on the KEY is the reactor's perspective on the TARGET,
			// never the direction of the reaction — the fixtures below set it
			// to the opposite of Info.IsFromMe on purpose.
			FromMe: proto.Bool(!fromMe),
			ID:     proto.String(targetID),
		},
		Text: proto.String(emoji),
	}
	if senderTsMS != 0 {
		r.SenderTimestampMS = proto.Int64(senderTsMS)
	}
	evt := railDelivery(chat, sender, fromMe, id, at, &waE2E.Message{ReactionMessage: r})
	evt.Info.Type = "reaction"
	return evt
}

func TestInScopeInboundReactionIsCapturedAsATypedReactionEvent(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550021", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 0, 0, 0, time.UTC)
	senderTs := int64(1756663200123)

	// The customer 👍s the rep's quote: the most common way a rep's
	// counterparty says yes (ADR-0041).
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("R1"), at, h.msgID("R0"), "👍", senderTs))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("in-scope inbound reaction: want 1 wa_events row, got %d", len(rows))
	}
	row := rows[0]
	if row.eventType != "reaction" {
		t.Errorf("event_type = %q, want %q — a gesture is its own type, never a message (ADR-0041)", row.eventType, "reaction")
	}
	// The reaction's OWN id composes the seam identity, so a redelivered
	// reaction dedupes and a reaction never collides with its target.
	if want := customer.String() + ":" + h.msgID("R1"); row.externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", row.externalEventID, want)
	}
	if !row.occurredAt.Equal(at) {
		t.Errorf("occurred_at = %v, want the delivery instant %v", row.occurredAt, at)
	}

	// The pinned v:1 reaction shape, verbatim from the decoder header — no
	// text, no quoted_message_id, and push_name absent when the rail supplies
	// none (exactly as on a message).
	want := map[string]any{
		"v":            float64(1),
		"chat_jid":     customer.String(),
		"sender_jid":   customer.String(),
		"from_me":      false,
		"message_id":   h.msgID("R1"),
		"reaction_to":  h.msgID("R0"),
		"emoji":        "👍",
		"sender_ts_ms": float64(senderTs),
	}
	if got := h.decryptPayload(t, row); !reflect.DeepEqual(got, want) {
		t.Errorf("payload = %#v, want %#v", got, want)
	}
}

func TestRepsOwnReactionFromTheirPhoneIsCaptured(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550022", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 5, 0, 0, time.UTC)

	// The plane is a linked device, so a reaction the REP places from their
	// own phone arrives as a live event with IsFromMe — "both directions" is
	// one code path with from_me stamped (ADR-0023 amendment, ADR-0041: a
	// rep's 👍 on the customer's request is agreement too).
	h.ing.HandleEvent(reactionEvent(customer, h.self, true, h.msgID("R2"), at, h.msgID("R0"), "👍", 1756663500000))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("rep's own reaction in an in-scope chat: want 1 wa_events row, got %d", len(rows))
	}
	if rows[0].eventType != "reaction" {
		t.Errorf("event_type = %q, want %q", rows[0].eventType, "reaction")
	}
	got := h.decryptPayload(t, rows[0])
	if got["from_me"] != true {
		t.Errorf("payload from_me = %v, want true", got["from_me"])
	}
	// Own-sent sender is self by definition — the same doctrine a message
	// gets, never a LID split of the same participant.
	if got["sender_jid"] != h.self.String() {
		t.Errorf("payload sender_jid = %v, want the live self PN %v", got["sender_jid"], h.self.String())
	}
	if got["chat_jid"] != customer.String() {
		t.Errorf("payload chat_jid = %v, want %v", got["chat_jid"], customer.String())
	}
}

func TestSetChangeAndRemovalEachWriteTheirOwnRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550023", types.DefaultUserServer)
	h.allow(t, customer.String())
	target := h.msgID("T0")
	at := time.Date(2026, 8, 31, 18, 10, 0, 0, time.UTC)

	// Three deliveries on the SAME target: a 👍, a change to ❤️ (a fresh
	// event carrying the same target key), and a removal (empty text, the
	// rail's RemoveReactionText). Append-only — the plane folds nothing, and
	// a retraction stays visible AS a retraction (ADR-0041).
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("S1"), at, target, "👍", 1756664000000))
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("S2"), at.Add(time.Minute), target, "❤️", 1756664060000))
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("S3"), at.Add(2*time.Minute), target, "", 1756664120000))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("set + change + removal: want 3 wa_events rows (no plane-side folding), got %d", len(rows))
	}
	wantEmoji := []string{"👍", "❤️", ""}
	for n, row := range rows {
		if row.eventType != "reaction" {
			t.Errorf("row %d event_type = %q, want %q", n, row.eventType, "reaction")
		}
		got := h.decryptPayload(t, row)
		// The removal's emoji must be PRESENT and empty: an absent field
		// would make a retraction indistinguishable from a malformed row.
		emoji, present := got["emoji"]
		if !present {
			t.Errorf("row %d payload has no emoji key — the empty string is a removal, not an absent field", n)
		}
		if emoji != wantEmoji[n] {
			t.Errorf("row %d emoji = %#v, want %#v", n, emoji, wantEmoji[n])
		}
		// Every delivery points at the same target — the change did not
		// rewrite the first row, and the removal did not delete it.
		if got["reaction_to"] != target {
			t.Errorf("row %d reaction_to = %v, want %v", n, got["reaction_to"], target)
		}
		// Each delivery carries its own stanza id, which is what lets three
		// beats coexist under the seam's dedupe constraint.
		if got["message_id"] != h.msgID([]string{"S1", "S2", "S3"}[n]) {
			t.Errorf("row %d message_id = %v, want the reaction's own id", n, got["message_id"])
		}
	}
	// The fold key is total and ordered: a consumer that needs the reaction
	// that STANDS can decide it (ADR-0041), and the plane still decides
	// nothing.
	var last float64
	for n, row := range rows {
		ts, ok := h.decryptPayload(t, row)["sender_ts_ms"].(float64)
		if !ok {
			t.Fatalf("row %d has no numeric sender_ts_ms", n)
		}
		if ts <= last {
			t.Errorf("row %d sender_ts_ms %v does not follow %v", n, ts, last)
		}
		last = ts
	}
}

func TestReactionNeverWritesTheEmptyTextMessageHusk(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550024", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 20, 0, 0, time.UTC)

	// The regression this ticket exists for: before ADR-0041 an in-scope
	// reaction wrote an event_type='message' row with empty text and no
	// target pointer — a husk the runtime then embedded and batched as if
	// someone had said nothing.
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("H1"), at, h.msgID("H0"), "👍", 1756665000000))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want exactly 1 row for one reaction, got %d", len(rows))
	}
	if rows[0].eventType == "message" {
		t.Fatalf("a reaction still wrote an event_type='message' husk row")
	}
	got := h.decryptPayload(t, rows[0])
	// A reaction is not what was said: the emoji is not speech and the
	// target is not a quote, so neither key exists on the wire.
	if _, present := got["text"]; present {
		t.Errorf("reaction payload carries a text key (%#v) — the pinned shape has none", got["text"])
	}
	if _, present := got["quoted_message_id"]; present {
		t.Errorf("reaction payload carries a quoted_message_id key (%#v) — the pinned shape has none", got["quoted_message_id"])
	}
}

func TestOutOfScopeReactionNeverPersists(t *testing.T) {
	h := newHarness(t)
	stranger := types.NewJID("5215550025", types.DefaultUserServer)
	// No allowlist row: the guard is per CHAT, never per message kind, so a
	// reaction is dropped exactly where a message is — before persistence,
	// no row anywhere (ADR-0023, unchanged by ADR-0041).
	at := time.Date(2026, 8, 31, 18, 25, 0, 0, time.UTC)

	h.ing.HandleEvent(reactionEvent(stranger, stranger, false, h.msgID("O1"), at, h.msgID("O0"), "👍", 1756666000000))
	// The rep's own reaction in an out-of-scope chat is just as out of scope.
	h.ing.HandleEvent(reactionEvent(stranger, h.self, true, h.msgID("O2"), at, h.msgID("O0"), "❤️", 1756666060000))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("out-of-scope reactions persisted %d row(s), want 0", n)
	}
}

func TestSelfChatReactionIsCapturedWithoutAnAllowlistRow(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 31, 18, 30, 0, 0, time.UTC)

	// The twin thread is always in scope, structurally (ADR-0023) — and a
	// rep's 👍 on a Borrador is ordinary rep input the twin reads (ADR-0041),
	// so it must cross like any other. It is captured as a REACTION, which is
	// what keeps it out of the affirmation matcher structurally.
	h.ing.HandleEvent(reactionEvent(h.self, h.self, true, h.msgID("N1"), at, h.msgID("N0"), "👍", 1756667000000))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("self-chat reaction: want 1 wa_events row, got %d", len(rows))
	}
	if rows[0].eventType != "reaction" {
		t.Errorf("event_type = %q, want %q", rows[0].eventType, "reaction")
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != h.self.String() || got["from_me"] != true {
		t.Errorf("payload chat/from_me = %v/%v, want %v/true", got["chat_jid"], got["from_me"], h.self.String())
	}
}

func TestDuplicateReactionDeliveryWritesExactlyOneRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550026", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 35, 0, 0, time.UTC)

	// The rail redelivers (reconnect, retry). The reaction's OWN stanza id
	// composes the seam identity, so the dedupe constraint covers a reaction
	// exactly as it covers a message (ADR-0005).
	evt := reactionEvent(customer, customer, false, h.msgID("D1"), at, h.msgID("D0"), "👍", 1756668000000)
	h.ing.HandleEvent(evt)
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 1 {
		t.Fatalf("duplicate reaction delivery produced %d row(s), want exactly 1", n)
	}
}

func TestReactionWithoutARailSenderTimestampFallsBackToTheDeliveryInstant(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550027", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 40, 0, 123_000_000, time.UTC)

	// sender_ts_ms is REQUIRED by the pinned shape, so the fold key is total:
	// where the rail supplies no sender timestamp the plane stamps the same
	// delivery instant it already writes to occurred_at, in whole ms. That is
	// normalization, not judgement.
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("F1"), at, h.msgID("F0"), "👍", 0))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want 1 wa_events row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if want := float64(at.UnixMilli()); got["sender_ts_ms"] != want {
		t.Errorf("payload sender_ts_ms = %#v, want the delivery instant %v (= occurred_at in whole ms)", got["sender_ts_ms"], want)
	}
	if !rows[0].occurredAt.Equal(at) {
		t.Errorf("occurred_at = %v, want %v", rows[0].occurredAt, at)
	}
}

func TestReactionChatAndDirectionComeFromTheDeliveryNeverTheReactionKey(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550028", types.DefaultUserServer)
	stranger := types.NewJID("5215550029", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 45, 0, 0, time.UTC)

	// The reaction key is the REACTOR's perspective on the TARGET message:
	// Key.FromMe says whether the target was theirs, and Key.RemoteJID is the
	// target's chat as they addressed it. Neither decides anything here — the
	// chat is Info.Chat and the direction is Info.IsFromMe, exactly as for a
	// message. The fixture inverts both so a reader of either would be caught.
	evt := reactionEvent(customer, customer, false, h.msgID("K1"), at, h.msgID("K0"), "👍", 1756669000000)
	evt.Message.ReactionMessage.Key.RemoteJID = proto.String(stranger.String())
	if evt.Message.ReactionMessage.Key.GetFromMe() != true {
		t.Fatal("fixture: the reaction key's FromMe must contradict the delivery's direction")
	}
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want 1 wa_events row, got %d", len(rows))
	}
	if want := customer.String() + ":" + h.msgID("K1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want %q — the key's remoteJID is not the chat", rows[0].externalEventID, want)
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != customer.String() {
		t.Errorf("payload chat_jid = %v, want the delivery's chat %v", got["chat_jid"], customer.String())
	}
	if got["from_me"] != false {
		t.Errorf("payload from_me = %v, want the delivery's direction false", got["from_me"])
	}
	// The one thing that IS read off the key: the target.
	if got["reaction_to"] != h.msgID("K0") {
		t.Errorf("payload reaction_to = %v, want the key's target id %v", got["reaction_to"], h.msgID("K0"))
	}
}

func TestReactionCarriesThePushNameWhenTheRailSuppliesOne(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550030", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 50, 0, 0, time.UTC)

	// push_name is additive on a reaction exactly as on a message: carried
	// when the rail supplies one, omitted entirely when it does not (the
	// TestInScopeInboundReaction… payload comparison above pins the absence).
	evt := reactionEvent(customer, customer, false, h.msgID("P1"), at, h.msgID("P0"), "👍", 1756670000000)
	evt.Info.PushName = "Sra. Garza"
	h.ing.HandleEvent(evt)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want 1 wa_events row, got %d", len(rows))
	}
	if got := h.decryptPayload(t, rows[0])["push_name"]; got != "Sra. Garza" {
		t.Errorf("payload push_name = %#v, want %q", got, "Sra. Garza")
	}
}

func TestReactionWithAnUnreadableSenderTimestampFallsBackToTheDeliveryInstant(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550032", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 18, 55, 0, 0, time.UTC)

	// SenderTimestampMS is an int64 the COUNTERPARTY's client fills in, and
	// the plane copies what it is told. But the pinned contract's reader is
	// the twin-runtime's decoder, which refuses a value outside JavaScript's
	// safe-integer range — and a reaction row the runtime cannot decode is a
	// poison row: routing is fail-stop, the row stays pending forever, and
	// every later event for that twin stops behind it (Codex r1-1). A rail
	// timestamp that is not a readable instant is not a sender timestamp,
	// so it takes the same delivery-instant fallback an absent one takes.
	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("U1"), at, h.msgID("U0"), "👍", math.MaxInt64))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want 1 wa_events row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if want := float64(at.UnixMilli()); got["sender_ts_ms"] != want {
		t.Errorf("payload sender_ts_ms = %#v, want the delivery instant %v — an unreadable rail timestamp must not cross", got["sender_ts_ms"], want)
	}
}

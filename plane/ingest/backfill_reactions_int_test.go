package ingest_test

import (
	"bytes"
	"log"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// History reactions at the Postgres seam (ticket #101, ADR-0041's "backfill
// walks both history shapes"). History sync carries a reaction TWICE over,
// in two unrelated containers: as a standalone reaction message in the
// stream, and accumulated onto the target message as a waWeb.Reaction
// entry. whatsmeow merges neither and dedups nothing. Both must normalize
// to the SAME typed 'reaction' event with backfill:true, through the same
// capture guard — and a reaction that was also captured live must collapse
// onto one seam row. These tests feed constructed history-sync batches
// through the one HandleEvent entry and assert what lands in wa_events,
// decrypted with the real crypto against the shape pinned in
// packages/seam/src/wa-payload.ts.

type historyReactionOpts struct {
	fromMe     bool
	pushName   string
	senderTsMS int64
}

// historyReaction builds the STANDALONE history shape: a WebMessageInfo
// whose body is a ReactionMessage. Its own Key.ID is the reaction's stanza
// id (the same id its live delivery carried), and the reaction key holds
// the TARGET's id — exactly like a live delivery, which is why this shape
// parses like one.
func historyReaction(chatID, id, targetID, emoji string, at time.Time, opts historyReactionOpts) *waWeb.WebMessageInfo {
	r := &waE2E.ReactionMessage{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(chatID),
			// As in the live fixtures: FromMe on the reaction KEY is the
			// reactor's perspective on the TARGET, never the direction of
			// the reaction. Inverted on purpose.
			FromMe: proto.Bool(!opts.fromMe),
			ID:     proto.String(targetID),
		},
		Text: proto.String(emoji),
	}
	if opts.senderTsMS != 0 {
		r.SenderTimestampMS = proto.Int64(opts.senderTsMS)
	}
	// A history reaction row is an ordinary history row with a reaction for
	// a body — built through the same webMsg the message fixtures use, so
	// the two can never disagree about what a history row's scaffolding is.
	m := webMsg(chatID, id, "", at, webMsgOpts{fromMe: opts.fromMe, pushName: opts.pushName})
	m.Message = &waE2E.Message{ReactionMessage: r}
	return m
}

type accumulatedOpts struct {
	// keyID is what the entry's own Key.ID holds. What that id IDENTIFIES —
	// the reaction's own stanza id, or the target's — is not knowable from
	// the proto (no comment, and whatsmeow never reads the field), so the
	// plane decides per entry by comparing it with the parent's id. These
	// fixtures cover all three readings: distinct, equal to the parent, and
	// absent.
	keyID       string
	noKey       bool
	fromMe      bool
	participant string
	senderTsMS  int64
}

// accumulatedEntry builds one ACCUMULATED history entry: a waWeb.Reaction
// hanging off the TARGET message (WebMessageInfo.Reactions, field 41). The
// nesting IS the target pointer — the entry itself names no target.
func accumulatedEntry(emoji string, opts accumulatedOpts) *waWeb.Reaction {
	e := &waWeb.Reaction{Text: proto.String(emoji)}
	if !opts.noKey {
		e.Key = &waCommon.MessageKey{FromMe: proto.Bool(opts.fromMe)}
		if opts.keyID != "" {
			e.Key.ID = proto.String(opts.keyID)
		}
		if opts.participant != "" {
			e.Key.Participant = proto.String(opts.participant)
		}
	}
	if opts.senderTsMS != 0 {
		e.SenderTimestampMS = proto.Int64(opts.senderTsMS)
	}
	return e
}

// withReactions hangs accumulated entries on a history row — the shape
// whatsmeow neither reads nor merges with the standalone one.
func withReactions(m *waWeb.WebMessageInfo, entries ...*waWeb.Reaction) *waWeb.WebMessageInfo {
	m.Reactions = entries
	return m
}

func TestHistoryStandaloneReactionIsATypedBackfilledReaction(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550041", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	senderTs := int64(1756550400123)

	// A re-link re-offers the month-old 👍 the customer put on the rep's
	// quote. It must cross as the same typed event live capture writes,
	// plus the one additive backfill marker (ADR-0041).
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyReaction(customer.String(), h.msgID("HR1"), h.msgID("HR0"), "👍", at,
			historyReactionOpts{senderTsMS: senderTs, pushName: "Sra. Garza"}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("standalone history reaction: want 1 wa_events row, got %d", len(rows))
	}
	row := rows[0]
	if row.eventType != "reaction" {
		t.Errorf("event_type = %q, want %q — a history gesture is the same type as a live one (ADR-0041)", row.eventType, "reaction")
	}
	// The reaction's OWN stanza id composes the seam identity, which is
	// what makes the collapse against live capture free.
	if want := customer.String() + ":" + h.msgID("HR1"); row.externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", row.externalEventID, want)
	}
	if !row.occurredAt.Equal(at) {
		t.Errorf("occurred_at = %v, want the historical instant %v", row.occurredAt, at)
	}

	want := map[string]any{
		"v":            float64(1),
		"chat_jid":     customer.String(),
		"sender_jid":   customer.String(),
		"from_me":      false,
		"message_id":   h.msgID("HR1"),
		"reaction_to":  h.msgID("HR0"),
		"emoji":        "👍",
		"sender_ts_ms": float64(senderTs),
		"push_name":    "Sra. Garza",
		"backfill":     true,
	}
	if got := h.decryptPayload(t, row); !reflect.DeepEqual(got, want) {
		t.Errorf("payload = %#v, want %#v", got, want)
	}
}

func TestAccumulatedReactionsWithTheirOwnIDsAreTypedBackfilledReactions(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550042", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 11, 0, 0, 0, time.UTC)
	target := h.msgID("AC0")
	customerTs := at.Add(time.Minute).UnixMilli()
	repTs := at.Add(2 * time.Minute).UnixMilli()

	// The other shape: the rep's quote comes back from history with the
	// reactions accumulated ON it — the customer's 👍 and the rep's own ❤️.
	// Here each entry's key carries an id of its OWN, distinct from the
	// target's, so it is the reaction's stanza id and the composed seam
	// identity is the same one a live delivery would compose.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "le mando 20 bultos a $180", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("AC1"), senderTsMS: customerTs}),
			accumulatedEntry("❤️", accumulatedOpts{keyID: h.msgID("AC2"), fromMe: true, senderTsMS: repTs}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("target message + 2 accumulated reactions: want 3 wa_events rows, got %d", len(rows))
	}
	// The target's OWN capture is never skipped because it carries
	// reactions: the message is still the message.
	if rows[0].eventType != "message" {
		t.Errorf("row 0 event_type = %q, want the target message itself", rows[0].eventType)
	}

	wantIDs := []string{h.msgID("AC1"), h.msgID("AC2")}
	wantEmoji := []string{"👍", "❤️"}
	wantFromMe := []bool{false, true}
	wantSender := []string{customer.String(), h.self.String()}
	wantTs := []int64{customerTs, repTs}
	for n, row := range rows[1:] {
		if row.eventType != "reaction" {
			t.Errorf("row %d event_type = %q, want %q", n+1, row.eventType, "reaction")
		}
		if want := customer.String() + ":" + wantIDs[n]; row.externalEventID != want {
			t.Errorf("row %d external_event_id = %q, want %q — an entry key that is not the target's IS the reaction's own stanza id", n+1, row.externalEventID, want)
		}
		// The gesture lands at the instant IT states, not its target's —
		// occurred_at is what orders the transcript, and a gesture is its
		// own beat.
		if want := time.UnixMilli(wantTs[n]).UTC(); !row.occurredAt.Equal(want) {
			t.Errorf("row %d occurred_at = %v, want the gesture's own instant %v", n+1, row.occurredAt, want)
		}
		want := map[string]any{
			"v":            float64(1),
			"chat_jid":     customer.String(),
			"sender_jid":   wantSender[n],
			"from_me":      wantFromMe[n],
			"message_id":   wantIDs[n],
			"reaction_to":  target,
			"emoji":        wantEmoji[n],
			"sender_ts_ms": float64(wantTs[n]),
			"backfill":     true,
		}
		if got := h.decryptPayload(t, row); !reflect.DeepEqual(got, want) {
			t.Errorf("row %d payload = %#v, want %#v", n+1, got, want)
		}
	}
}

func TestAccumulatedReactionKeyedToTheTargetGetsADeterministicSyntheticID(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550043", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	target := h.msgID("SY0")
	firstTs := int64(1756557600000)
	secondTs := int64(1756557660000)

	// The reading the shape's own proto cannot settle: an entry whose key
	// names the TARGET (and one that carries no key at all) leaves the
	// gesture with no rail identity of its own. The plane synthesizes a
	// deterministic one rather than dropping the gesture or inventing a
	// content match — <target>:r:<reactor bare JID>:<sender_ts_ms>, composed
	// into the seam id like any stanza id.
	batch := historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "se los mando el jueves", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: target, senderTsMS: firstTs}),
			accumulatedEntry("❤️", accumulatedOpts{noKey: true, senderTsMS: secondTs}),
		),
	))
	h.ing.HandleEvent(batch)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("target + 2 keyless accumulated reactions: want 3 wa_events rows, got %d", len(rows))
	}
	// The recipe, spelled out here from the ticket rather than read back
	// from the code: the reactor of a non-from-me DM gesture is the chat.
	wantIDs := []string{
		customer.String() + ":" + target + ":r:" + customer.String() + ":1756557600000",
		customer.String() + ":" + target + ":r:" + customer.String() + ":1756557660000",
	}
	for n, row := range rows[1:] {
		if row.eventType != "reaction" {
			t.Errorf("row %d event_type = %q, want %q", n+1, row.eventType, "reaction")
		}
		if row.externalEventID != wantIDs[n] {
			t.Errorf("row %d external_event_id = %q, want the synthetic %q", n+1, row.externalEventID, wantIDs[n])
		}
		got := h.decryptPayload(t, row)
		// reaction_to is the PARENT, always — the nesting is the pointer,
		// and an entry key that repeats the target says nothing new.
		if got["reaction_to"] != target {
			t.Errorf("row %d reaction_to = %v, want the parent %q", n+1, got["reaction_to"], target)
		}
		if got["backfill"] != true {
			t.Errorf("row %d backfill = %v, want true", n+1, got["backfill"])
		}
	}

	// Deterministic means restart-safe: the same blob re-offered composes
	// the same ids, so the seam writes nothing the second time.
	h.ing.HandleEvent(batch)
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 3 {
		t.Fatalf("re-delivered history batch produced %d rows, want exactly 3 — the synthetic id is not deterministic", n)
	}
}

func TestAReactionCapturedLiveAndInHistoryCollapsesToOneRow(t *testing.T) {
	h := newHarness(t)
	live := types.NewJID("5215550044", types.DefaultUserServer)
	sync := types.NewJID("5215550045", types.DefaultUserServer)
	h.allow(t, live.String())
	h.allow(t, sync.String())
	at := time.Date(2026, 8, 30, 13, 0, 0, 0, time.UTC)
	senderTs := int64(1756561200000)

	// Live first, then the re-link (the ordinary order — a reaction is
	// delivered when it happens and history only re-offers it): the
	// standalone shape composes the SAME <chat>:<stanza id>, so the seam
	// collapses the two and the live row stands, unmarked.
	h.ing.HandleEvent(reactionEvent(live, live, false, h.msgID("LV1"), at, h.msgID("LV0"), "👍", senderTs))
	h.ing.HandleEvent(historyBatch(conversation(live.String(),
		historyReaction(live.String(), h.msgID("LV1"), h.msgID("LV0"), "👍", at, historyReactionOpts{senderTsMS: senderTs}),
	)))

	// Sync first, then live — the precedence bug #100 recorded and this
	// ticket closes. Whichever feed lands first, both now write the SAME
	// typed shape, so the collapse can no longer pin an empty-text husk on
	// a gesture.
	h.ing.HandleEvent(historyBatch(conversation(sync.String(),
		historyReaction(sync.String(), h.msgID("SL1"), h.msgID("SL0"), "👍", at, historyReactionOpts{senderTsMS: senderTs}),
	)))
	h.ing.HandleEvent(reactionEvent(sync, sync, false, h.msgID("SL1"), at, h.msgID("SL0"), "👍", senderTs))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("one reaction per chat delivered on both feeds: want 2 rows, got %d", len(rows))
	}
	for n, row := range rows {
		if row.eventType != "reaction" {
			t.Errorf("row %d event_type = %q, want %q — neither order may pin a husk", n, row.eventType, "reaction")
		}
	}
	if _, present := h.decryptPayload(t, rows[0])["backfill"]; present {
		t.Errorf("the live-captured reaction was replaced by its backfill copy — the first delivery must win")
	}
	if h.decryptPayload(t, rows[1])["backfill"] != true {
		t.Errorf("the sync-first reaction lost its backfill marker — the first delivery must win in this order too")
	}
}

func TestAccumulatedReactionCarryingItsOwnIDCollapsesOntoTheLiveRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550046", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 14, 0, 0, 0, time.UTC)
	target := h.msgID("AL0")
	reaction := h.msgID("AL1")
	senderTs := int64(1756564800000)

	// The accumulated shape collapses against live capture too — but only
	// when it carries the reaction's OWN id, which is the whole reason the
	// key is read per entry rather than assumed to be the target's.
	h.ing.HandleEvent(reactionEvent(customer, customer, false, reaction, at, target, "👍", senderTs))
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "¿le mando 20 bultos?", at.Add(-time.Minute), webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: reaction, senderTsMS: senderTs}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("live reaction + its target with the same reaction accumulated: want 2 rows, got %d", len(rows))
	}
	if _, present := h.decryptPayload(t, rows[0])["backfill"]; present {
		t.Errorf("the live reaction row was replaced by the accumulated copy — the first delivery must win")
	}
	if rows[1].eventType != "message" {
		t.Errorf("row 1 event_type = %q, want the target message", rows[1].eventType)
	}
}

func TestHistoryReactionNeverWritesTheEmptyTextMessageHusk(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550047", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 15, 0, 0, 0, time.UTC)

	// The regression this ticket exists for on the history side (#100's
	// remainder 4): a standalone history reaction passed `conversational`
	// and was normalized as an empty-text 'message' row with no target
	// pointer — a husk the runtime then embedded and batched as if someone
	// had said nothing.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyReaction(customer.String(), h.msgID("HK1"), h.msgID("HK0"), "👍", at, historyReactionOpts{senderTsMS: 1756566000000}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want exactly 1 row for one history reaction, got %d", len(rows))
	}
	if rows[0].eventType == "message" {
		t.Fatalf("a history reaction still wrote an event_type='message' husk row")
	}
	got := h.decryptPayload(t, rows[0])
	if _, present := got["text"]; present {
		t.Errorf("history reaction payload carries a text key (%#v) — the pinned shape has none", got["text"])
	}
	if _, present := got["quoted_message_id"]; present {
		t.Errorf("history reaction payload carries a quoted_message_id key (%#v) — the pinned shape has none", got["quoted_message_id"])
	}
}

func TestAccumulatedRemovalCrossesAsTheEmptyEmoji(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550048", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 16, 0, 0, 0, time.UTC)
	target := h.msgID("RM0")

	// A retraction is itself a signal (ADR-0041), and the empty string is
	// how the rail says it. The key must be PRESENT and empty on the wire —
	// absence would make a retraction indistinguishable from a malformed
	// row — in this shape exactly as in the live one.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "van 20 bultos el jueves", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("", accumulatedOpts{keyID: h.msgID("RM1"), senderTsMS: 1756569600000}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("target + accumulated removal: want 2 rows, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[1])
	emoji, present := got["emoji"]
	if !present {
		t.Fatalf("accumulated removal has no emoji key — the empty string is a removal, not an absent field")
	}
	if emoji != "" {
		t.Errorf("accumulated removal emoji = %#v, want the empty string", emoji)
	}
	if got["reaction_to"] != target {
		t.Errorf("accumulated removal reaction_to = %v, want %q", got["reaction_to"], target)
	}
}

func TestHistoryReactionWithoutASenderTimestampFallsBackToTheHistoricalInstant(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550049", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 17, 0, 0, 0, time.UTC)
	target := h.msgID("FB0")

	// Whether the accumulated shape carries a sender timestamp at all is
	// one of the two facts #96 refused to assume. sender_ts_ms is REQUIRED
	// by the pinned shape either way, so where the blob supplies none the
	// plane stamps the same instant it writes to occurred_at — the parent's
	// historical timestamp for an accumulated entry, the row's own for a
	// standalone one. Normalization, not judgement.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "mañana temprano", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("FB1")}),
		),
		historyReaction(customer.String(), h.msgID("FB3"), target, "❤️", at.Add(time.Hour), historyReactionOpts{}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("target + accumulated + standalone: want 3 rows, got %d", len(rows))
	}
	accumulated := h.decryptPayload(t, rows[1])
	if want := float64(at.UnixMilli()); accumulated["sender_ts_ms"] != want {
		t.Errorf("accumulated sender_ts_ms = %#v, want the parent's historical instant %v", accumulated["sender_ts_ms"], want)
	}
	if !rows[1].occurredAt.Equal(at) {
		t.Errorf("accumulated occurred_at = %v, want %v — the fold key and the row instant are the same instant", rows[1].occurredAt, at)
	}
	standalone := h.decryptPayload(t, rows[2])
	if want := float64(at.Add(time.Hour).UnixMilli()); standalone["sender_ts_ms"] != want {
		t.Errorf("standalone sender_ts_ms = %#v, want its own historical instant %v", standalone["sender_ts_ms"], want)
	}
}

func TestOutOfScopeHistoryReactionsNeverPersist(t *testing.T) {
	h := newHarness(t)
	stranger := types.NewJID("5215550050", types.DefaultUserServer)
	// No allowlist row: the guard is per CHAT and runs per conversation,
	// before any persistence — so neither history shape can slip a gesture
	// past it (ADR-0023, unchanged by ADR-0041).
	at := time.Date(2026, 8, 30, 18, 0, 0, 0, time.UTC)
	target := h.msgID("OS0")

	h.ing.HandleEvent(historyBatch(conversation(stranger.String(),
		historyReaction(stranger.String(), h.msgID("OS1"), target, "👍", at, historyReactionOpts{senderTsMS: 1756576800000}),
		withReactions(
			webMsg(stranger.String(), target, "asunto privado de hace un mes", at, webMsgOpts{}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("OS2"), senderTsMS: 1756576860000}),
			accumulatedEntry("❤️", accumulatedOpts{noKey: true}),
		),
	)))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("an out-of-scope conversation's history reactions persisted %d row(s), want 0 — no row, anywhere", n)
	}
}

func TestSelfChatHistoryReactionIsCapturedWithoutAnAllowlistRow(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 30, 19, 0, 0, 0, time.UTC)
	target := h.msgID("SC0")

	// The twin thread is always in scope, structurally (ADR-0023) — its
	// history included. A rep's 👍 on an old Borrador crosses as a
	// reaction, which is what keeps it out of the affirmation matcher
	// structurally (ADR-0041).
	h.ing.HandleEvent(historyBatch(conversation(h.selfLID.String(),
		withReactions(
			webMsg(h.selfLID.String(), target, "Borrador para la Sra. Garza", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("SC1"), fromMe: true, senderTsMS: 1756580400000}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("self-chat history with an accumulated reaction: want 2 rows, got %d", len(rows))
	}
	if rows[1].eventType != "reaction" {
		t.Errorf("event_type = %q, want %q", rows[1].eventType, "reaction")
	}
	// PN-canonical on both the row identity and the payload, exactly as the
	// message rows of the same conversation land.
	if want := h.self.String() + ":" + h.msgID("SC1"); rows[1].externalEventID != want {
		t.Errorf("external_event_id = %q, want PN-canonical self %q", rows[1].externalEventID, want)
	}
	got := h.decryptPayload(t, rows[1])
	if got["chat_jid"] != h.self.String() || got["sender_jid"] != h.self.String() || got["from_me"] != true {
		t.Errorf("payload chat/sender/from_me = %v/%v/%v, want %v/%v/true", got["chat_jid"], got["sender_jid"], got["from_me"], h.self.String(), h.self.String())
	}
}

func TestAccumulatedReactorFollowsTheOneSenderDoctrine(t *testing.T) {
	h := newHarness(t)
	group := types.NewJID("120363001122334455", types.GroupServer)
	h.allow(t, group.String())
	at := time.Date(2026, 8, 30, 20, 0, 0, 0, time.UTC)
	target := h.msgID("RD0")
	otherPN := types.NewJID("5215550051", types.DefaultUserServer)
	otherLID := types.NewJID("444555666777888", types.HiddenUserServer)

	// The reactor is read off the ENTRY, never the parent — whoever sent
	// the message reacted to need not be whoever reacted. A participant is
	// what a group entry states; the same canonicalSenderJID doctrine both
	// feeds already share decides the rest (own-sent is self; a LID or
	// absent participant resolves to the chat).
	//
	// THE MIDDLE CASE PINS A PRE-EXISTING DOCTRINE, not a choice made here:
	// canonicalSenderJID resolves a LID sender to the chat without asking
	// whether that chat is a DM, so in a GROUP a LID participant projects to
	// the group's own JID and two members become indistinguishable. That is
	// the one sender doctrine every feed shares — a group MESSAGE lands the
	// same way today — and groups are outside this slice's scope, so it is
	// recorded on #101 as a remainder rather than changed underneath the
	// live and own-send paths. Asserted so that the day it is fixed, it is
	// fixed here too.
	h.ing.HandleEvent(historyBatch(conversation(group.String(),
		withReactions(
			webMsg(group.String(), target, "¿quién puede el jueves?", at, webMsgOpts{}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("RD1"), participant: otherPN.String(), senderTsMS: 1756584000000}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("RD2"), participant: otherLID.String(), senderTsMS: 1756584060000}),
			accumulatedEntry("❤️", accumulatedOpts{keyID: h.msgID("RD3"), fromMe: true, participant: otherPN.String(), senderTsMS: 1756584120000}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 4 {
		t.Fatalf("target + 3 accumulated reactions: want 4 rows, got %d", len(rows))
	}
	wantSender := []string{otherPN.String(), group.String(), h.self.String()}
	wantFromMe := []bool{false, false, true}
	for n, row := range rows[1:] {
		got := h.decryptPayload(t, row)
		if got["sender_jid"] != wantSender[n] {
			t.Errorf("row %d sender_jid = %v, want %v", n+1, got["sender_jid"], wantSender[n])
		}
		if got["from_me"] != wantFromMe[n] {
			t.Errorf("row %d from_me = %v, want %v", n+1, got["from_me"], wantFromMe[n])
		}
		// push_name is never stamped from the parent: the accumulated shape
		// supplies none of its own, and the parent's belongs to the parent's
		// sender.
		if _, present := got["push_name"]; present {
			t.Errorf("row %d carries push_name %v — the accumulated shape supplies none", n+1, got["push_name"])
		}
	}
}

// captureLog redirects the standard logger for one test — the plane's
// diagnostics go there (the convention `cmd/plane` established), and the
// rig session (#102) reads them off the plane's output.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	// Restore what was there, not a guess at it: the standard logger is
	// process-global, so a test that hands it back to os.Stderr would
	// silently redirect anything a harness had pointed elsewhere.
	writer, flags := log.Writer(), log.Flags()
	log.SetFlags(0)
	log.SetOutput(&buf)
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
	})
	return &buf
}

func TestHistorySyncReportsReactionShapesWithoutLeakingContentOrIdentity(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550052", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 21, 0, 0, 0, time.UTC)
	target := h.msgID("DG0")
	logs := captureLog(t)

	reactor := types.NewJID("5215550056", types.DefaultUserServer)

	// What the accumulated shape's key ACTUALLY identifies cannot be
	// settled from code, so the plane reports the SHAPES it saw and the rig
	// session (#102) confirms or corrects the reading against a real phone.
	// Counts only: no JIDs, no ids, no text, no emoji — content never rests
	// in plaintext (ADR-0008) and telemetry is content-free by construction
	// (ADR-0025).
	//
	// The fixture carries one of each reading, and the two counts that
	// settle whether a target-naming key is a COPY of the parent's: the
	// second entry repeats both the parent's id AND its direction (a copy),
	// the first carries a participant.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyReaction(customer.String(), h.msgID("DG1"), target, "👍", at, historyReactionOpts{senderTsMS: 1756587600000}),
		withReactions(
			webMsg(customer.String(), target, "se los aparto", at, webMsgOpts{fromMe: true, pushName: "Sra. Garza"}),
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("DG1"), participant: reactor.String(), senderTsMS: 1756587660000}),
			accumulatedEntry("", accumulatedOpts{keyID: target, fromMe: true, senderTsMS: 1756587720000}),
			accumulatedEntry("❤️", accumulatedOpts{noKey: true}),
		),
	)))
	h.requireNoErrors(t)

	line := logs.String()
	want := "history reactions: twin_thread=false messages=2 standalone=1 accumulated=3 key_absent=1 key_is_target=1 key_distinct=1 with_sender_ts=2 removals=1 key_restates_parent=1 key_with_participant=1 also_standalone=1"
	if !strings.Contains(line, want) {
		t.Errorf("history-sync diagnostic = %q, want a line containing %q", line, want)
	}
	// The content-freedom half, asserted rather than assumed: nothing that
	// could identify a person, a chat, a message or what was said.
	for _, leak := range []string{
		customer.String(), h.self.String(), reactor.String(), "5215550052", "5215550056", target,
		h.msgID("DG1"), h.msgID("DG2"), "👍", "❤️", "se los aparto", "Sra. Garza",
	} {
		if strings.Contains(line, leak) {
			t.Errorf("history-sync diagnostic leaked %q: %q", leak, line)
		}
	}
}

func TestWrappedHistoryReactionIsUnwrappedLikeTheLivePath(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550054", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 30, 23, 0, 0, 0, time.UTC)
	target := h.msgID("EW0")

	// A disappearing-mode chat wraps every history body in
	// EphemeralMessage, and the rep's own gestures from another device ride
	// DeviceSentMessage — both unwrapped by whatsmeow before the LIVE path
	// ever sees them. History must read the same unwrapped body, or a
	// wrapped reaction silently becomes an empty-text husk again: the
	// wrapper has no ReactionMessage of its own.
	wrapped := historyReaction(customer.String(), h.msgID("EW1"), target, "👍", at, historyReactionOpts{senderTsMS: 1756594800000})
	wrapped.Message = &waE2E.Message{
		EphemeralMessage: &waE2E.FutureProofMessage{Message: wrapped.Message},
	}
	h.ing.HandleEvent(historyBatch(conversation(customer.String(), wrapped)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("ephemeral-wrapped history reaction: want 1 row, got %d", len(rows))
	}
	if rows[0].eventType != "reaction" {
		t.Fatalf("event_type = %q, want %q — a wrapped gesture is still a gesture", rows[0].eventType, "reaction")
	}
	got := h.decryptPayload(t, rows[0])
	if got["reaction_to"] != target || got["emoji"] != "👍" {
		t.Errorf("payload reaction_to/emoji = %v/%v, want %q/👍", got["reaction_to"], got["emoji"], target)
	}
}

func TestATargetNamingKeyStillStatesTheReactorAsRuled(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550055", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 9, 0, 0, 0, time.UTC)
	target := h.msgID("TD0")

	// THE KEY IS READ FOR THE REACTOR WHATEVER ITS ID SAYS. The id
	// comparison decides the row's identity and nothing else — a plane that
	// substituted its own direction where the blob supplies one would be
	// judging (ADR-0005), and there is no safe substitute to reach for
	// anyway: ADR-0041 makes a gesture agreement in BOTH directions, so a
	// wrong reactor misstates an agreement whichever way it falls.
	//
	// THIS FIXTURE IS THE HAZARD ITSELF, pinned so it is visible rather than
	// implied: the entry copies the target's key — same id, same direction —
	// and the target is the REP's, so a gesture that may well be the
	// customer's lands from_me:true. That reading cannot reach a filed fact
	// (backfill never enters the extraction transcript, and a cited reaction
	// is refused until #98), and `key_restates_parent` in the diagnostic
	// counts exactly these entries so #102 can settle it from a real phone.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "le mando 20 bultos a $180", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: target, fromMe: true, senderTsMS: 1756630800000}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("rep's message + one accumulated gesture: want 2 rows, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[1])
	if got["from_me"] != true || got["sender_jid"] != h.self.String() {
		t.Errorf("payload from_me/sender = %v/%v, want true/%v — the entry's key states the reactor (R1)", got["from_me"], got["sender_jid"], h.self.String())
	}
	// The synthetic id follows the reactor the plane stated, so the row's
	// identity and its content can never disagree — which is also why a
	// later correction of the reactor rule writes a NEW row rather than
	// repairing this one, and why #102 settles the rule before a rig ever
	// carries a corpus that depends on it.
	if want := customer.String() + ":" + target + ":r:" + h.self.String() + ":1756630800000"; rows[1].externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", rows[1].externalEventID, want)
	}
}

func TestTheStandaloneShapeWinsWhenHistoryCarriesBoth(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550057", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)
	target := h.msgID("BW0")
	reaction := h.msgID("BW1")
	senderTs := int64(1756634400000)

	// The blob carries the SAME reaction twice: accumulated on the target,
	// and standalone later in the stream — which is the ordinary order,
	// since a target precedes the gesture on it. Both compose the same seam
	// identity, so first write wins, and the accumulated one would win by
	// arriving first: a row with the TARGET's instant, no push name, and a
	// reactor read off the ambiguous key. The standalone shape is the
	// authoritative one — it states the gesture's own instant, its own
	// direction and its push name — so it is preferred where both are
	// present, and the accumulated copy is not written at all.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), target, "le mando 20 bultos a $180", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{keyID: reaction, senderTsMS: senderTs}),
		),
		historyReaction(customer.String(), reaction, target, "👍", at.Add(time.Hour),
			historyReactionOpts{senderTsMS: senderTs, pushName: "Sra. Garza"}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("one target + the same reaction in both history shapes: want 2 rows, got %d", len(rows))
	}
	if rows[1].eventType != "reaction" {
		t.Fatalf("row 1 event_type = %q, want %q", rows[1].eventType, "reaction")
	}
	if !rows[1].occurredAt.Equal(at.Add(time.Hour)) {
		t.Errorf("occurred_at = %v, want the STANDALONE row's own instant %v — the accumulated copy must not win", rows[1].occurredAt, at.Add(time.Hour))
	}
	if got := h.decryptPayload(t, rows[1])["push_name"]; got != "Sra. Garza" {
		t.Errorf("payload push_name = %#v, want %q — the standalone shape carries one and the accumulated shape does not", got, "Sra. Garza")
	}
}

func TestAccumulatedReactorFollowsTheEntrysKeyNotTheParents(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550058", types.DefaultUserServer)
	h.allow(t, customer.String())
	group := types.NewJID("120363009988776655", types.GroupServer)
	h.allow(t, group.String())
	member := types.NewJID("5215550059", types.DefaultUserServer)
	at := time.Date(2026, 8, 31, 11, 0, 0, 0, time.UTC)
	dmTarget := h.msgID("TS0")
	groupTarget := h.msgID("TS1")

	// Whoever sent the message reacted TO need not be whoever reacted, so
	// the reactor is read off the entry and never off the parent — even
	// where the entry's key repeats the parent's id, which decides identity
	// alone. Both halves of the ruled rule, on the two chats that exercise
	// them: a DM entry that contradicts the parent's direction, and a group
	// entry naming a participant the parent does not.
	h.ing.HandleEvent(historyBatch(
		conversation(customer.String(),
			withReactions(
				// The customer's request; the REP's 👍 on it, keyed to the
				// target but stating the opposite direction.
				webMsg(customer.String(), dmTarget, "¿me manda 20 bultos?", at, webMsgOpts{}),
				accumulatedEntry("👍", accumulatedOpts{keyID: dmTarget, fromMe: true, senderTsMS: 1756638000000}),
			),
		),
		conversation(group.String(),
			withReactions(
				webMsg(group.String(), groupTarget, "¿quién puede el jueves?", at, webMsgOpts{}),
				accumulatedEntry("👍", accumulatedOpts{keyID: groupTarget, participant: member.String(), senderTsMS: 1756638060000}),
			),
		),
	))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 4 {
		t.Fatalf("two targets + two accumulated reactions: want 4 rows, got %d", len(rows))
	}
	dm := h.decryptPayload(t, rows[1])
	if dm["from_me"] != true || dm["sender_jid"] != h.self.String() {
		t.Errorf("DM gesture from_me/sender = %v/%v, want true/%v — a key that contradicts the parent's direction is not the parent's key", dm["from_me"], dm["sender_jid"], h.self.String())
	}
	inGroup := h.decryptPayload(t, rows[3])
	if inGroup["sender_jid"] != member.String() {
		t.Errorf("group gesture sender_jid = %v, want the participant %v — a participant the parent does not name is the reactor's", inGroup["sender_jid"], member.String())
	}
}

func TestAccumulatedReactionsSurviveAParentWithNoBody(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550060", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	target := h.msgID("NB0")

	// A history row whose body is gone (revoked, or a kind the blob does not
	// carry) is not conversational — there is nothing to remember about the
	// MESSAGE, and it writes no row. Its accumulated gestures are a separate
	// question: the parent's stanza id is present, which is everything a
	// gesture needs — a target to point at and a base for its identity — so
	// they cross. The message the twin cannot read is a worse reason to
	// forget an agreement than no reason at all.
	bodyless := &waWeb.WebMessageInfo{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(customer.String()),
			FromMe:    proto.Bool(true),
			ID:        proto.String(target),
		},
		MessageTimestamp: proto.Uint64(uint64(at.Unix())),
		MessageStubType:  waWeb.WebMessageInfo_REVOKE.Enum(),
	}
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(bodyless,
			accumulatedEntry("👍", accumulatedOpts{keyID: h.msgID("NB1"), senderTsMS: 1756641600000}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("bodyless parent + one accumulated reaction: want 1 row (the gesture, not the parent), got %d", len(rows))
	}
	if rows[0].eventType != "reaction" {
		t.Errorf("event_type = %q, want %q — the parent itself is still not conversational", rows[0].eventType, "reaction")
	}
	if got := h.decryptPayload(t, rows[0])["reaction_to"]; got != target {
		t.Errorf("reaction_to = %v, want the bodyless parent's stanza id %q", got, target)
	}
}

func TestAnAccumulatedGestureLandsAtItsOwnInstantNotItsTargets(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550061", types.DefaultUserServer)
	h.allow(t, customer.String())
	target := time.Date(2026, 8, 31, 13, 0, 0, 0, time.UTC)
	set := target.Add(time.Hour)
	removal := target.Add(2 * time.Hour)
	targetID := h.msgID("CH0")

	// CHRONOLOGY IS WHAT A GESTURE MEANS. Twin memory orders a chat by
	// occurred_at and keeps no fold key of its own, so a gesture written at
	// its TARGET's instant is a gesture the twin reads at the wrong moment —
	// and where a set and its removal arrive in different shapes, at the
	// wrong moment in the wrong ORDER: the removal, taking the target's
	// older instant, renders before the set it retracts and the withdrawn
	// reaction reads as the one that stands.
	//
	// So an accumulated gesture lands at the instant it states — which is
	// its sender timestamp where it carries one, and the target's instant
	// where it does not, the two being the same value the fold key already
	// takes. The row's instant and its fold key are one instant, always.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyReaction(customer.String(), h.msgID("CH1"), targetID, "👍", set,
			historyReactionOpts{senderTsMS: set.UnixMilli()}),
		withReactions(
			webMsg(customer.String(), targetID, "le mando 20 bultos a $180", target, webMsgOpts{fromMe: true}),
			accumulatedEntry("", accumulatedOpts{keyID: h.msgID("CH2"), senderTsMS: removal.UnixMilli()}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("standalone set + target + accumulated removal: want 3 rows, got %d", len(rows))
	}
	var retraction waEventRow
	for _, row := range rows {
		if got := h.decryptPayload(t, row); got["message_id"] == h.msgID("CH2") {
			retraction = row
		}
	}
	if !retraction.occurredAt.Equal(removal) {
		t.Fatalf("the accumulated removal's occurred_at = %v, want its own instant %v — not its target's", retraction.occurredAt, removal)
	}
	if !retraction.occurredAt.After(set) {
		t.Errorf("the removal (%v) does not follow the set it retracts (%v)", retraction.occurredAt, set)
	}
	// The row's instant and its fold key are the same instant, so no reader
	// can order these two beats differently from the other.
	if want := float64(removal.UnixMilli()); h.decryptPayload(t, retraction)["sender_ts_ms"] != want {
		t.Errorf("sender_ts_ms = %#v, want %v", h.decryptPayload(t, retraction)["sender_ts_ms"], want)
	}
}

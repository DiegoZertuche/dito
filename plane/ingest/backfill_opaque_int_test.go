package ingest_test

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// Opaque deliveries on the HISTORY feed (ticket #125, ADR-0042). One rule,
// three feeds: backfill applies the identical per-entry decision live capture
// does, so a photo in the past is the same row as a photo now, minus the
// backfill marker's difference. Two things change beyond the shared rule —
// backfill stops skipping an id-less entry, and it stops aborting the rest of
// a conversation on a bad one.

// unparseableJID is a conversation identity whatsmeow's own parser refuses:
// the user part carries a device suffix that is not a number. It is the only
// way a history blob can leave the capture guard unable to decide, since
// ParseJID accepts every other shape — including plain nonsense, which
// becomes a JID with an odd server and is simply out of scope.
const unparseableJID = "5215550084.x.y@s.whatsapp.net"

// historyBody builds a history row carrying an arbitrary message body — the
// history counterpart of railDelivery, through the same webMsg scaffolding
// the message fixtures use so the two can never disagree about what a
// history row is.
func historyBody(chatID, id string, at time.Time, body *waE2E.Message) *waWeb.WebMessageInfo {
	m := webMsg(chatID, id, "", at, webMsgOpts{})
	m.Message = body
	return m
}

func TestHistoryMediaIsCapturedAsABackfilledOpaqueRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550081", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)

	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyBody(customer.String(), h.msgID("HO1"), at, &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("history media: want 1 row, got %d", len(rows))
	}
	if rows[0].eventType != "opaque" {
		t.Fatalf("event_type = %q, want opaque", rows[0].eventType)
	}
	if want := customer.String() + ":" + h.msgID("HO1") + ":opaque"; rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", rows[0].externalEventID, want)
	}
	if !rows[0].occurredAt.Equal(at) {
		t.Errorf("occurred_at = %v, want the historical instant %v", rows[0].occurredAt, at)
	}
	got := h.decryptPayload(t, rows[0])
	if got["kind"] != "imageMessage" || got["reason"] != "no_slot" {
		t.Errorf("payload kind/reason = %#v/%#v, want imageMessage/no_slot", got["kind"], got["reason"])
	}
	// The one additive marker, exactly as on every other history row — the
	// twin routes marked events to ingest only (spec #29 decision 6).
	if got["backfill"] != true {
		t.Errorf("payload backfill = %#v, want true", got["backfill"])
	}
}

// The behaviour change the ticket names: a bad entry no longer takes the rest
// of the conversation down with it. Before ADR-0042 an unwritable entry
// returned on the spot and everything after it in that conversation was never
// captured.
func TestABadHistoryEntryWritesItsOpaqueRowAndTheConversationContinues(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	t1 := time.Date(2026, 8, 21, 9, 10, 0, 0, time.UTC)
	t2 := t1.Add(time.Minute)
	t3 := t1.Add(2 * time.Minute)
	t4 := t1.Add(3 * time.Minute)

	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		webMsg(customer.String(), h.msgID("HB1"), "¿tiene azúcar en costal?", t1, webMsgOpts{}),
		// A gesture pointing at nothing, then a delivery with no identity at
		// all — the two malformations, one after the other, in the middle of
		// an ordinary conversation.
		historyBody(customer.String(), h.msgID("HB2"), t2, &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}}),
		historyBody(customer.String(), "", t3, &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}),
		webMsg(customer.String(), h.msgID("HB4"), "dos, porfa", t4, webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 4 {
		t.Fatalf("text + malformed gesture + id-less photo + text: want 4 rows, got %d", len(rows))
	}
	wantTypes := []string{"message", "opaque", "opaque", "message"}
	for i, want := range wantTypes {
		if rows[i].eventType != want {
			t.Errorf("row %d event_type = %q, want %q", i, rows[i].eventType, want)
		}
	}
	gesture := h.decryptPayload(t, rows[1])
	if gesture["reason"] != "malformed" || gesture["kind"] != "reactionMessage/reaction_to" {
		t.Errorf("malformed gesture = %#v, want reactionMessage/reaction_to and malformed", gesture)
	}
	// THE ID-LESS ENTRY IS WRITTEN, not skipped, and keys on the hash of its
	// own envelope so a re-offered blob still writes nothing twice.
	idless := h.decryptPayload(t, rows[2])
	if idless["reason"] != "malformed" || idless["kind"] != "imageMessage/message_id" {
		t.Errorf("id-less entry = %#v, want imageMessage/message_id and malformed", idless)
	}
	if prefix := customer.String() + ":opaque:"; !strings.HasPrefix(rows[2].externalEventID, prefix) {
		t.Errorf("id-less external_event_id = %q, want the %q-prefixed hash identity", rows[2].externalEventID, prefix)
	}
	// The conversation survived both: the last message is there.
	if last := h.decryptPayload(t, rows[3]); last["text"] != "dos, porfa" {
		t.Errorf("the conversation stopped at the bad entry: last row = %#v", last)
	}
}

func TestARedeliveredHistoryBlobWritesNoSecondIdlessRow(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 8, 21, 9, 20, 0, 0, time.UTC)

	// A phone re-offers its history on every relink. The hash is composed
	// from the blob alone — never from the clock — so the second pass writes
	// nothing (ADR-0042).
	blob := historyBatch(conversation(customer.String(),
		historyBody(customer.String(), "", at, &waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}),
	))
	h.ing.HandleEvent(blob)
	h.ing.HandleEvent(blob)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 1 {
		t.Fatalf("a re-offered blob wrote %d rows for one id-less entry, want 1", n)
	}
}

// A gesture accumulated on a parent that has no stanza id has no target
// either — the nesting IS the pointer, and a pointer to nothing is the same
// malformation the live feed has. One rule, every container.
func TestAnAccumulatedGestureOnAnIdlessParentIsMalformed(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 8, 21, 9, 30, 0, 0, time.UTC)

	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		withReactions(
			webMsg(customer.String(), "", "se los aparto", at, webMsgOpts{fromMe: true}),
			accumulatedEntry("👍", accumulatedOpts{senderTsMS: 1756787400000}),
		),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("id-less parent + its gesture: want 2 rows, got %d", len(rows))
	}
	gesture := h.decryptPayload(t, rows[1])
	if rows[1].eventType != "opaque" {
		t.Fatalf("gesture event_type = %q, want opaque — it points at a parent with no identity", rows[1].eventType)
	}
	if gesture["reason"] != "malformed" || gesture["kind"] != "reactionMessage/reaction_to" {
		t.Errorf("gesture reason/kind = %#v/%#v, want malformed and reactionMessage/reaction_to", gesture["reason"], gesture["kind"])
	}
	if _, present := gesture["reaction_to"]; present {
		t.Errorf("gesture carries reaction_to %#v — the field it is missing", gesture["reaction_to"])
	}
}

// THE ONE PERMITTED DROP (ADR-0042). An opaque row is still an in-scope row,
// so the guard decides before the kind — and a conversation whose chat
// identity does not parse can be placed on no allowlist. Nothing is written,
// one line is logged naming the feed and the kind and no content, and the
// binary keeps running: this used to reach OnError, which is log.Fatalf, so a
// history blob could halt capture on its own contents.
func TestAnUnparseableChatIdentityDropsWithOneContentFreeLine(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550085", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 21, 9, 40, 0, 0, time.UTC)
	logs := captureLog(t)

	// whatsmeow's ParseJID accepts almost anything; what it refuses is a
	// user part whose device/agent suffix is not a number — the shape a
	// corrupt or hostile history blob produces.
	h.ing.HandleEvent(historyBatch(
		conversation(unparseableJID, webMsg(unparseableJID, h.msgID("GU1"), "hola", at, webMsgOpts{})),
		// A well-formed conversation in the same blob still lands: the drop
		// is per conversation, and the walk continues.
		conversation(customer.String(), webMsg(customer.String(), h.msgID("GU2"), "¿abren el domingo?", at, webMsgOpts{})),
	))

	if len(*h.errors) != 0 {
		t.Fatalf("an unparseable chat identity reached OnError, which fail-stops the binary: %v", *h.errors)
	}
	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want only the well-formed conversation's row, got %d", len(rows))
	}
	if !strings.Contains(rows[0].externalEventID, h.msgID("GU2")) {
		t.Errorf("the row written is %q, want the well-formed conversation's", rows[0].externalEventID)
	}

	line := logs.String()
	want := "capture guard drop: feed=history kind=conversation reason=chat_identity_unparseable"
	if !strings.Contains(line, want) {
		t.Errorf("log = %q, want a line containing %q", line, want)
	}
	if n := strings.Count(line, "capture guard drop:"); n != 1 {
		t.Errorf("want exactly 1 drop line, got %d: %q", n, line)
	}
	// Content-free, asserted rather than assumed: the identity that could not
	// be placed is exactly what this line must not carry (ADR-0025).
	for _, leak := range []string{unparseableJID, "hola", h.msgID("GU1"), customer.String()} {
		if strings.Contains(line, leak) {
			t.Errorf("the drop line leaked %q: %q", leak, line)
		}
	}
}

func TestAnUnparseablePnJIDDropsTheSameWay(t *testing.T) {
	h := newHarness(t)
	lid := types.NewJID("777666555444333", types.HiddenUserServer)
	at := time.Date(2026, 8, 21, 9, 45, 0, 0, time.UTC)
	logs := captureLog(t)

	// The pnJID is how a LID-identified history thread states its
	// phone-number identity, so an unparseable one leaves the guard exactly
	// as undecided as an unparseable conversation id.
	conv := conversation(lid.String(), webMsg(lid.String(), h.msgID("GU3"), "hola", at, webMsgOpts{}))
	conv.PnJID = proto.String("5215550087:xx@s.whatsapp.net")
	h.ing.HandleEvent(historyBatch(conv))

	if len(*h.errors) != 0 {
		t.Fatalf("an unparseable pnJID reached OnError: %v", *h.errors)
	}
	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("an undecidable conversation persisted %d row(s), want 0", n)
	}
	if !strings.Contains(logs.String(), "capture guard drop: feed=history kind=conversation") {
		t.Errorf("log = %q, want the drop line", logs.String())
	}
}

// An undecidable conversation writes nothing AND reports nothing: the shapes
// diagnostic is per in-scope conversation, and this one never got past the
// guard. "Exactly one log line" is the whole of what the drop leaves.
func TestAnUndecidableConversationEmitsNoShapesLine(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 21, 9, 50, 0, 0, time.UTC)
	logs := captureLog(t)

	h.ing.HandleEvent(historyBatch(
		conversation(unparseableJID, webMsg(unparseableJID, h.msgID("GU4"), "hola", at, webMsgOpts{})),
	))

	if strings.Contains(logs.String(), "history reactions:") {
		t.Errorf("an undecidable conversation reported shapes: %q", logs.String())
	}
	if n := strings.Count(logs.String(), "\n"); n != 1 {
		t.Errorf("want exactly one log line, got %d: %q", n, logs.String())
	}
}

// A history blob whose conversations carry no messages at all still reaches
// the seam without a row and without an error — the guard-undecidable case is
// the ONLY drop, and an empty conversation is not one.
func TestAnEmptyHistoryConversationWritesNothingQuietly(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550086", types.DefaultUserServer)
	h.allow(t, customer.String())

	h.ing.HandleEvent(historyBatch(&waHistorySync.Conversation{
		ID:       proto.String(customer.String()),
		Messages: []*waHistorySync.HistorySyncMsg{{Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{ID: proto.String(h.msgID("EC1"))}}}},
	}))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("a body-less history row persisted %d row(s), want 0 — a stub is metadata, not a delivery", n)
	}
}

package ingest_test

import (
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/internal/testdb"
)

// Opaque deliveries at the Postgres seam (ticket #125, ADR-0042). Every
// in-scope delivery leaves exactly one seam row, and a row the plane could
// not read says so: the shapes the seam has no slot for (a photo, a voice
// note, a poll, an edit, a revoke, a sticker) used to land as the empty-text
// 'message' husk ADR-0041 retired for reactions, and now land as their own
// typed 'opaque' row carrying the rail's own kind and a reason. These tests
// feed constructed rail deliveries through the SAME guard as every other
// feed and assert what appears in wa_events on the other side.

// unnamedChat returns an allowlisted customer chat unique across test runs.
// A delivery with NO stanza id keys on the hash of its own envelope (#125),
// and that envelope carries no message id to vary — so a fixture reusing one
// chat would compose the identity a PREVIOUS run already wrote and dedupe
// itself away against the seam's global UNIQUE (source, external_event_id).
// Exactly the hazard msgID exists for, one field over.
func (h *harness) unnamedChat(t *testing.T) types.JID {
	t.Helper()
	digest := sha256.Sum256([]byte(h.stamp.TwinID))
	chat := types.NewJID("521"+strconv.FormatUint(binary.BigEndian.Uint64(digest[:8])%1e10, 10), types.DefaultUserServer)
	h.allow(t, chat.String())
	return chat
}

// railDelivery constructs the rail's delivery of an ARBITRARY message body —
// every shape textMessage cannot express, which is the whole subject here.
func railDelivery(chat, sender types.JID, fromMe bool, id string, at time.Time, body *waE2E.Message) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsFromMe: fromMe},
			ID:            id,
			Timestamp:     at,
		},
		Message: body,
	}
}

func TestInScopeMediaDeliveryIsCapturedAsATypedOpaqueEvent(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550061", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)

	// The customer sends a photo of the pallet they want. The twin cannot
	// see it, but something happened and the thread must not read as silence
	// (ADR-0042).
	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("OP1"), at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("in-scope media delivery: want 1 wa_events row, got %d", len(rows))
	}
	row := rows[0]
	if row.eventType != "opaque" {
		t.Errorf("event_type = %q, want %q — a shape the seam has no slot for is its own kind, never an empty message (ADR-0042)", row.eventType, "opaque")
	}
	// The opaque identity carries the kind, so a readable re-delivery of the
	// same message (or a typed re-capture after promotion) is never swallowed
	// by the dedupe.
	if want := customer.String() + ":" + h.msgID("OP1") + ":opaque"; row.externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", row.externalEventID, want)
	}
	if !row.occurredAt.Equal(at) {
		t.Errorf("occurred_at = %v, want the delivery instant %v", row.occurredAt, at)
	}

	// The pinned v:1 opaque shape: the common envelope plus the rail's own
	// kind and a reason — and NO raw envelope, no text, nothing that could be
	// read as speech (ADR-0042).
	want := map[string]any{
		"v":            float64(1),
		"chat_jid":     customer.String(),
		"sender_jid":   customer.String(),
		"from_me":      false,
		"message_id":   h.msgID("OP1") + ":opaque",
		"kind":         "imageMessage",
		"reason":       "no_slot",
		"sender_ts_ms": float64(at.UnixMilli()),
	}
	if got := h.decryptPayload(t, row); !reflect.DeepEqual(got, want) {
		t.Errorf("payload = %#v, want %#v", got, want)
	}
}

func TestEveryShapeWithNoSeamSlotNamesItsOwnRailKind(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550062", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 10, 5, 0, 0, time.UTC)

	// One deterministic derivation, recorded on #125: the name of the set
	// field on the rail's own waE2E.Message, and `protocolMessage/<TYPE>`
	// for the protocol shapes, whose type is the whole of what they say.
	// The counter this gives an operator ("how many photos, in which chats,
	// before anything is built") is the only thing an opaque row owes a
	// later promotion (ADR-0042).
	cases := []struct {
		suffix string
		body   *waE2E.Message
		kind   string
	}{
		{"K1", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}, "audioMessage"},
		{"K2", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{}}, "videoMessage"},
		{"K3", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{}}, "stickerMessage"},
		{"K4", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{}}, "documentMessage"},
		{"K5", &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{}}, "pollCreationMessage"},
		{"K6", &waE2E.Message{EncReactionMessage: &waE2E.EncReactionMessage{}}, "encReactionMessage"},
		{"K7", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum()}}, "protocolMessage/REVOKE"},
		{"K8", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum()}}, "protocolMessage/MESSAGE_EDIT"},
	}
	for _, c := range cases {
		h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID(c.suffix), at, c.body))
	}
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != len(cases) {
		t.Fatalf("want %d opaque rows, got %d", len(cases), len(rows))
	}
	for i, c := range cases {
		got := h.decryptPayload(t, rows[i])
		if rows[i].eventType != "opaque" {
			t.Errorf("%s event_type = %q, want opaque", c.kind, rows[i].eventType)
		}
		if got["kind"] != c.kind {
			t.Errorf("payload kind = %#v, want %q", got["kind"], c.kind)
		}
		if got["reason"] != "no_slot" {
			t.Errorf("%s payload reason = %#v, want %q", c.kind, got["reason"], "no_slot")
		}
	}
}

// The regression that names the whole ticket: the husk must not come back by
// another door. A media delivery writes NO 'message' row and no `text` field
// at all — the twin read the husk as someone saying nothing, and the embedder
// stored it as an utterance (ADR-0042).
func TestAnOpaqueDeliveryNeverWritesTheEmptyTextMessageHusk(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550063", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 10, 10, 0, 0, time.UTC)

	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("OP2"), at,
		&waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true)}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("voice note: want exactly 1 row, got %d", len(rows))
	}
	if rows[0].eventType == "message" {
		t.Fatal("a voice note wrote a 'message' row — the empty-text husk ADR-0042 retired")
	}
	got := h.decryptPayload(t, rows[0])
	if _, present := got["text"]; present {
		t.Errorf("opaque payload carries text %#v — an opaque row is never speech", got["text"])
	}
	if _, present := got["quoted_message_id"]; present {
		t.Errorf("opaque payload carries quoted_message_id %#v", got["quoted_message_id"])
	}
}

func TestOutOfScopeOpaqueDeliveryNeverPersists(t *testing.T) {
	h := newHarness(t)
	stranger := types.NewJID("5215550064", types.DefaultUserServer)
	at := time.Date(2026, 9, 1, 10, 15, 0, 0, time.UTC)

	// An opaque row is still an in-scope row, so the guard decides before the
	// kind does: content the guard would not admit never rests anywhere
	// (ADR-0023 outranks the row invariant, ADR-0042).
	h.ing.HandleEvent(railDelivery(stranger, stranger, false, h.msgID("OP3"), at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("out-of-scope opaque delivery persisted %d row(s), want 0", n)
	}
}

func TestSelfChatOpaqueDeliveryIsCapturedWithoutAnAllowlistRow(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 9, 1, 10, 20, 0, 0, time.UTC)

	// The rep sends their twin a photo. The twin thread is always in scope,
	// structurally (ADR-0023) — and the delivery is ordinary rep input the
	// twin answers in its own words, so it has to reach the seam.
	h.ing.HandleEvent(railDelivery(h.self, h.self, true, h.msgID("OP4"), at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("self-chat opaque delivery: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != h.self.String() || got["from_me"] != true {
		t.Errorf("payload chat/from_me = %v/%v, want %v/true", got["chat_jid"], got["from_me"], h.self.String())
	}
	if got["kind"] != "imageMessage" {
		t.Errorf("payload kind = %#v, want %q", got["kind"], "imageMessage")
	}
}

// undecryptableDelivery constructs whatsmeow's UndecryptableMessage: a
// delivery the rail could not decrypt at all. It carries identity and
// nothing else — there is no body, which is the whole of what makes it
// undecryptable. whatsmeow asks the sender to retry and emits the readable
// resend as an ordinary *events.Message with the SAME stanza id.
func undecryptableDelivery(chat, sender types.JID, fromMe bool, id string, at time.Time) *events.UndecryptableMessage {
	return &events.UndecryptableMessage{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsFromMe: fromMe},
			ID:            id,
			Timestamp:     at,
		},
		IsUnavailable: true,
	}
}

func TestAnUndecryptableDeliveryIsCapturedAsAnOpaqueRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550065", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 0, 0, 0, time.UTC)

	// Before this the event fell out of the type switch: no row, no log, no
	// counter, so a gap in the twin's memory was indistinguishable from a
	// quiet chat (ADR-0042).
	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, h.msgID("UD1"), at))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("undecryptable delivery: want 1 wa_events row, got %d", len(rows))
	}
	if rows[0].eventType != "opaque" {
		t.Errorf("event_type = %q, want opaque", rows[0].eventType)
	}
	want := map[string]any{
		"v":            float64(1),
		"chat_jid":     customer.String(),
		"sender_jid":   customer.String(),
		"from_me":      false,
		"message_id":   h.msgID("UD1") + ":opaque",
		"kind":         "undecryptable",
		"reason":       "undecryptable",
		"sender_ts_ms": float64(at.UnixMilli()),
	}
	if got := h.decryptPayload(t, rows[0]); !reflect.DeepEqual(got, want) {
		t.Errorf("payload = %#v, want %#v", got, want)
	}
}

func TestTheReadableRedeliveryStandsBesideItsUndecryptableRow(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550066", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 5, 0, 0, time.UTC)
	id := h.msgID("UD2")

	// whatsmeow asks the sender to retry, and the resend arrives as an
	// ordinary message with the SAME stanza id. The opaque row keys
	// <chat>:<stanza>:opaque, so it never blocks the readable one — both rows
	// exist and which one STANDS is the consumer's fold (ADR-0042).
	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, id, at))
	h.ing.HandleEvent(textMessage(customer, customer, false, id, at.Add(4*time.Second), "¿me apartas 12 garrafones?"))
	// And a repeated undecryptable delivery of the same message (whatsmeow
	// re-emits when the resend is also undecryptable) collapses onto the row
	// it already wrote.
	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, id, at.Add(2*time.Second)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("undecryptable + its readable redelivery: want 2 rows, got %d", len(rows))
	}
	if rows[0].externalEventID != customer.String()+":"+id+":opaque" {
		t.Errorf("opaque external_event_id = %q, want the :opaque-suffixed identity", rows[0].externalEventID)
	}
	if rows[1].externalEventID != customer.String()+":"+id {
		t.Errorf("readable external_event_id = %q, want the plain <chat>:<stanza> identity", rows[1].externalEventID)
	}
	if rows[0].eventType != "opaque" || rows[1].eventType != "message" {
		t.Errorf("event types = %q/%q, want opaque/message", rows[0].eventType, rows[1].eventType)
	}
	if got := h.decryptPayload(t, rows[1]); got["text"] != "¿me apartas 12 garrafones?" {
		t.Errorf("the readable redelivery lost its text: %#v", got)
	}
}

func TestOutOfScopeUndecryptableDeliveryNeverPersists(t *testing.T) {
	h := newHarness(t)
	stranger := types.NewJID("5215550067", types.DefaultUserServer)
	at := time.Date(2026, 9, 1, 11, 10, 0, 0, time.UTC)

	// The guard runs first for an undecryptable delivery exactly as for any
	// other: the same function, not a copy (ADR-0023).
	h.ing.HandleEvent(undecryptableDelivery(stranger, stranger, false, h.msgID("UD3"), at))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("out-of-scope undecryptable delivery persisted %d row(s), want 0", n)
	}
}

func TestAReactionWithNoTargetKeyIsMalformedNotAGestureAtNothing(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550068", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 15, 0, 0, time.UTC)

	// A reaction whose key states no target used to be stamped as written —
	// `reaction_to: ""` decodes and renders a gesture at nothing (#100's
	// remainder 2, ADR-0042). It is malformed, and the row says which field
	// is missing.
	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("MF1"), at,
		&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("nil-key reaction: want 1 row, got %d", len(rows))
	}
	if rows[0].eventType != "opaque" {
		t.Fatalf("event_type = %q, want opaque — a gesture with nothing to point at is not a reaction", rows[0].eventType)
	}
	got := h.decryptPayload(t, rows[0])
	if got["kind"] != "reactionMessage/reaction_to" || got["reason"] != "malformed" {
		t.Errorf("payload kind/reason = %#v/%#v, want reactionMessage/reaction_to and malformed", got["kind"], got["reason"])
	}
	// And the lie it replaces is gone: no reaction_to, no emoji.
	if _, present := got["reaction_to"]; present {
		t.Errorf("malformed row carries reaction_to %#v — the field it is missing", got["reaction_to"])
	}
	if _, present := got["emoji"]; present {
		t.Errorf("malformed row carries emoji %#v", got["emoji"])
	}
}

// The regression the malformed rule must not break: an EMPTY EMOJI is the
// rail's own encoding of a removal (whatsmeow's RemoveReactionText), so a
// gesture with a valid key and no emoji is a legitimate retraction and stays
// a 'reaction' row. Presence checks there would refuse the signal ADR-0041
// exists to keep.
func TestAnEmptyEmojiWithAValidKeyIsStillAReactionRemoval(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550069", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 20, 0, 0, time.UTC)
	target := h.msgID("MF0")

	h.ing.HandleEvent(reactionEvent(customer, customer, false, h.msgID("MF2"), at, target, "", 1756663200123))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("removal: want 1 row, got %d", len(rows))
	}
	if rows[0].eventType != "reaction" {
		t.Fatalf("event_type = %q, want reaction — an empty emoji is a removal, not a malformation", rows[0].eventType)
	}
	got := h.decryptPayload(t, rows[0])
	if got["emoji"] != "" || got["reaction_to"] != target {
		t.Errorf("removal payload emoji/reaction_to = %#v/%#v, want \"\"/%q", got["emoji"], got["reaction_to"], target)
	}
}

func TestADeliveryWithNoStanzaIDKeysOnItsEnvelopeHash(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 11, 25, 0, 0, time.UTC)

	// A message with no stanza id used to take the id `<chat>:`, so the next
	// one like it was swallowed by the dedupe (ADR-0042). It now names the
	// field it is missing and keys on the hash of its own envelope.
	h.ing.HandleEvent(railDelivery(customer, customer, false, "", at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("id-less delivery: want 1 row, got %d", len(rows))
	}
	prefix := customer.String() + ":opaque:"
	if !strings.HasPrefix(rows[0].externalEventID, prefix) {
		t.Fatalf("external_event_id = %q, want the %q-prefixed hash identity", rows[0].externalEventID, prefix)
	}
	// A SHA-256 in hex, and nothing but: the hash is composed at write time
	// and never stored (ADR-0042).
	digest := strings.TrimPrefix(rows[0].externalEventID, prefix)
	if len(digest) != 64 {
		t.Errorf("hash identity = %q, want 64 hex characters", digest)
	}
	if _, err := hex.DecodeString(digest); err != nil {
		t.Errorf("hash identity %q is not hex: %v", digest, err)
	}
	got := h.decryptPayload(t, rows[0])
	// The identity IS the message_id: the runtime reads what a row stands for
	// out of it, and an id-less row truthfully stands for no message.
	if got["message_id"] != "opaque:"+digest || got["reason"] != "malformed" || got["kind"] != "imageMessage/message_id" {
		t.Errorf("payload message_id/reason/kind = %#v/%#v/%#v, want opaque:<hash>/malformed/imageMessage/message_id", got["message_id"], got["reason"], got["kind"])
	}
}

func TestIdenticalIdlessBytesCollapseAndDifferentOnesDoNot(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 11, 30, 0, 0, time.UTC)

	photo := railDelivery(customer, customer, false, "", at, &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}})
	// The same bytes offered twice — a rail redelivery — collapse on the
	// seam's dedupe, which is what the hash identity is for.
	h.ing.HandleEvent(photo)
	h.ing.HandleEvent(photo)
	// A SECOND, DIFFERENT id-less delivery in the same chat is not swallowed:
	// under the old `<chat>:` identity it would have been. AT THE SAME
	// INSTANT, deliberately — varying the clock as well would prove only that
	// the clock varies, and the seam's own instant is second-granular anyway.
	h.ing.HandleEvent(railDelivery(customer, customer, false, "", at,
		&waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}))
	// And one more the other axis over: the same KIND at the same instant from
	// the OTHER direction is still its own delivery.
	h.ing.HandleEvent(railDelivery(customer, h.self, true, "", at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("photo twice + a voice note + the rep's own photo: want 3 rows, got %d", len(rows))
	}
	seen := map[string]bool{}
	for _, row := range rows {
		if seen[row.externalEventID] {
			t.Fatalf("two different id-less deliveries composed one identity %q", row.externalEventID)
		}
		seen[row.externalEventID] = true
	}
	if got := h.decryptPayload(t, rows[0]); got["kind"] != "imageMessage/message_id" || got["from_me"] != false {
		t.Errorf("first row = %#v, want an inbound imageMessage", got)
	}
	if got := h.decryptPayload(t, rows[1]); got["kind"] != "audioMessage/message_id" {
		t.Errorf("second row kind = %#v, want audioMessage/message_id", got["kind"])
	}
	if got := h.decryptPayload(t, rows[2]); got["kind"] != "imageMessage/message_id" || got["from_me"] != true {
		t.Errorf("third row = %#v, want an own-sent imageMessage", got)
	}
}

// The rail attaches metadata ALONGSIDE a body's real shape — per-message
// context on ordinary deliveries, the sender-key transport on group ones —
// and both are declared before the shapes this ticket exists for
// (`messageContextInfo` before `pollCreationMessage`,
// `senderKeyDistributionMessage` before `imageMessage`). Naming a rider would
// make the operator's counter count the wrong thing on exactly the deliveries
// it is for.
func TestARiderFieldNeverNamesTheKind(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550070", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 35, 0, 0, time.UTC)

	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("RD1"), at, &waE2E.Message{
		PollCreationMessage: &waE2E.PollCreationMessage{},
		MessageContextInfo:  &waE2E.MessageContextInfo{},
	}))
	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("RD2"), at, &waE2E.Message{
		SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{},
		ImageMessage:                 &waE2E.ImageMessage{},
	}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("want 2 opaque rows, got %d", len(rows))
	}
	if got := h.decryptPayload(t, rows[0]); got["kind"] != "pollCreationMessage" {
		t.Errorf("poll carrying message context named kind %#v, want pollCreationMessage", got["kind"])
	}
	if got := h.decryptPayload(t, rows[1]); got["kind"] != "imageMessage" {
		t.Errorf("photo carrying a sender key named kind %#v, want imageMessage", got["kind"])
	}
}

// A body that names no shape at all. There is no rail name to report and
// inventing one would be worse than saying so, so the row states what it can:
// something arrived, and the plane could not say what.
func TestABodylessDeliveryStillLeavesARowNamingWhatItCan(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550071", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 40, 0, 0, time.UTC)

	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("EM1"), at, &waE2E.Message{}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("empty body: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if rows[0].eventType != "opaque" || got["kind"] != "unknown" || got["reason"] != "no_slot" {
		t.Errorf("empty body wrote %q with kind/reason %#v/%#v, want opaque/unknown/no_slot", rows[0].eventType, got["kind"], got["reason"])
	}
}

// FAIL-STOP IS FOR THE PLANE BEING UNABLE TO DO ITS JOB, NEVER FOR WHAT IT
// WAS HANDED (ADR-0042). Every shape a counterparty can choose goes through
// the whole live path here, and OnError — which the binary wires to
// log.Fatalf — must receive nothing. A content-shaped fatal is a switch any
// counterparty could throw by sending one strange message.
func TestNoContentShapedDeliveryEverReachesOnError(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 11, 45, 0, 0, time.UTC)

	bodies := []*waE2E.Message{
		{ImageMessage: &waE2E.ImageMessage{}},
		{ProtocolMessage: &waE2E.ProtocolMessage{}},
		{ReactionMessage: &waE2E.ReactionMessage{}},
		{ReactionMessage: &waE2E.ReactionMessage{Key: &waCommon.MessageKey{}}},
		{Conversation: proto.String("")},
		{},
		nil,
	}
	for i, body := range bodies {
		h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("FS"+strconv.Itoa(i)), at, body))
		// ...and the same shapes with no stanza id either, at their own
		// instant so each keys its own envelope hash.
		h.ing.HandleEvent(railDelivery(customer, customer, false, "", at.Add(time.Duration(i)*time.Minute), body))
	}
	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, h.msgID("FSU"), at))
	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, "", at))

	if len(*h.errors) != 0 {
		t.Fatalf("content reached OnError, which fail-stops the binary: %v", *h.errors)
	}
	// And every one of them left a row: the invariant is the row, not the log.
	if n := h.countAllRows(t); n != 2*len(bodies)+2 {
		t.Errorf("want %d rows (one per delivery), got %d", 2*len(bodies)+2, n)
	}
}

// The other half of the same rule: an INFRASTRUCTURE failure still reaches
// OnError. A closed pool is a database the plane can neither read nor write,
// and a delivery's first two steps are both — the chat directory's upsert and
// the allowlist read (ticket #222) — so either way the failure is loud and the
// delivery leaves no row (ADR-0042: a plane that cannot capture what it is told
// to capture must not keep consuming).
func TestAnInfrastructureFailureStillReachesOnError(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550072", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 11, 50, 0, 0, time.UTC)

	var errs []error
	broken := ingest.New(ingest.Config{
		DB:        closedDB(t),
		Sealer:    mustSealer(t, h.key),
		Stamp:     h.stamp,
		Self:      fixedSelf{jid: h.self, lid: h.selfLID},
		Directory: h.dir,
		OnError:   func(err error) { errs = append(errs, err) },
	})
	broken.HandleEvent(railDelivery(customer, customer, false, h.msgID("IF1"), at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}))
	broken.HandleEvent(undecryptableDelivery(customer, customer, false, h.msgID("IF2"), at))

	if len(errs) != 2 {
		t.Fatalf("want 2 loud infrastructure failures, got %d: %v", len(errs), errs)
	}
}

// closedDB is a pool that cannot serve a query — the plane's own database
// being unreachable, which is what "infrastructure" means here.
func closedDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", testdb.DSN(t))
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("closing test database: %v", err)
	}
	return db
}

// The identity rule reaches the undecryptable feed too: an absent stanza id is
// a malformation whatever the shape, so both live feeds answer the same
// absence the same way rather than one calling it undecryptable and the other
// malformed.
func TestAnIdlessUndecryptableDeliveryNamesTheFieldItIsMissing(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 11, 55, 0, 0, time.UTC)

	h.ing.HandleEvent(undecryptableDelivery(customer, customer, false, "", at))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("id-less undecryptable delivery: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["kind"] != "undecryptable/message_id" || got["reason"] != "malformed" {
		t.Errorf("payload kind/reason = %#v/%#v, want undecryptable/message_id and malformed", got["kind"], got["reason"])
	}
	if prefix := customer.String() + ":opaque:"; !strings.HasPrefix(rows[0].externalEventID, prefix) {
		t.Errorf("external_event_id = %q, want the %q-prefixed hash identity", rows[0].externalEventID, prefix)
	}
}

// THE COLLISION THE PROJECTION WOULD HAVE HAD (Codex r1). Two photos a
// customer sends in one second are the same chat, the same sender, the same
// direction, the same kind and the same instant — and history's timestamps are
// second-granular by construction, so this is not a corner. They are different
// deliveries and each must leave a row; only the rail's own bytes tell them
// apart.
func TestTwoDifferentIdlessDeliveriesOfOneKindInOneSecondBothLand(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

	h.ing.HandleEvent(railDelivery(customer, customer, false, "", at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{DirectPath: proto.String("/v/t62.7118-24/uno")}}))
	h.ing.HandleEvent(railDelivery(customer, customer, false, "", at,
		&waE2E.Message{ImageMessage: &waE2E.ImageMessage{DirectPath: proto.String("/v/t62.7118-24/dos")}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("two different photos in one second: want 2 rows, got %d", len(rows))
	}
	if rows[0].externalEventID == rows[1].externalEventID {
		t.Fatalf("both photos composed one identity %q — the second was swallowed", rows[0].externalEventID)
	}
	// And neither row carries the bytes that told them apart: the hash is
	// taken at write time and discarded (ADR-0042 — no raw envelope).
	for _, row := range rows {
		got := h.decryptPayload(t, row)
		for key := range got {
			switch key {
			case "v", "chat_jid", "sender_jid", "from_me", "message_id", "kind", "reason", "sender_ts_ms", "push_name", "backfill":
			default:
				t.Errorf("opaque payload carries an unexpected field %q = %#v", key, got[key])
			}
		}
	}
}

// The mirror of the same rule: `backfill` says which FEED carried a delivery,
// not which delivery it is. A row with a stanza id captured live and again
// through the phone's history collapses onto one identity; an id-less one must
// collapse the same way rather than landing twice.
func TestTheSameIdlessDeliveryLiveAndInHistoryCollapsesToOneRow(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 12, 5, 0, 0, time.UTC)
	body := &waE2E.Message{AudioMessage: &waE2E.AudioMessage{DirectPath: proto.String("/v/t62.7117-24/nota")}}

	h.ing.HandleEvent(railDelivery(customer, customer, false, "", at, body))
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyBody(customer.String(), "", at, body),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("one delivery on two feeds: want 1 row, got %d", len(rows))
	}
	// Live wrote first, so the row that stands is the live one — first write
	// wins at the seam, exactly as it does for a row with a stanza id.
	if got := h.decryptPayload(t, rows[0]); got["backfill"] != nil {
		t.Errorf("payload backfill = %#v, want the live row (absent)", got["backfill"])
	}
}

// THE FOLD WHATSMEOW PERFORMS ON THE WAY IN (Codex r2). When a delivery
// arrives that this device cannot read, whatsmeow asks the phone to resend it
// — the same `unavailable` branch that emits the UndecryptableMessage above —
// and rebuilds the answer with ParseWebMessage, which for a MESSAGE_EDIT
// rewrites Info.ID to the TARGET's id and replaces the body with the edited
// content. Folded that way the edit wears the original's identity and reads as
// ordinary speech; the seam folds nothing, so it is written as itself.
func TestAPlaceholderResentEditIsWrittenAsItselfNotAsTheMessageItEdits(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550091", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 12, 10, 0, 0, time.UTC)
	original := h.msgID("ED0")
	editID := h.msgID("ED1")

	// The original, captured normally.
	h.ing.HandleEvent(textMessage(customer, customer, false, original, at, "mándame 20 cajas"))

	// The edit, as ParseWebMessage hands it over: Info.ID is the ORIGINAL's,
	// Message is the edited content, and SourceWebMsg still states the
	// delivery's own key and its own body.
	web := &waWeb.WebMessageInfo{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(customer.String()),
			FromMe:    proto.Bool(false),
			ID:        proto.String(editID),
		},
		MessageTimestamp: proto.Uint64(uint64(at.Add(time.Minute).Unix())),
		Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
			Key:  &waCommon.MessageKey{ID: proto.String(original)},
			EditedMessage: &waE2E.Message{
				Conversation: proto.String("mándame 30 cajas"),
			},
		}},
	}
	folded := railDelivery(customer, customer, false, original, at.Add(time.Minute),
		&waE2E.Message{Conversation: proto.String("mándame 30 cajas")})
	folded.SourceWebMsg = web
	h.ing.HandleEvent(folded)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("the original + its edit: want 2 rows, got %d — a folded edit is discarded by the dedupe", len(rows))
	}
	if want := customer.String() + ":" + original; rows[0].externalEventID != want {
		t.Errorf("original external_event_id = %q, want %q", rows[0].externalEventID, want)
	}
	if got := h.decryptPayload(t, rows[0]); got["text"] != "mándame 20 cajas" {
		t.Errorf("the original was overwritten: %#v", got)
	}
	// The edit under its OWN identity, as its own kind — never as speech the
	// counterparty did not send under the id of a message they did.
	if want := customer.String() + ":" + editID + ":opaque"; rows[1].externalEventID != want {
		t.Errorf("edit external_event_id = %q, want %q", rows[1].externalEventID, want)
	}
	edit := h.decryptPayload(t, rows[1])
	if rows[1].eventType != "opaque" || edit["kind"] != "protocolMessage/MESSAGE_EDIT" || edit["reason"] != "no_slot" {
		t.Errorf("edit row = %q %#v, want opaque/protocolMessage/MESSAGE_EDIT/no_slot", rows[1].eventType, edit)
	}
	if _, present := edit["text"]; present {
		t.Errorf("the edit row carries text %#v — an opaque row is never speech", edit["text"])
	}
}

// The last husk (Codex r2): a text shape carrying NO text. A Conversation
// explicitly set to the empty string, and an ExtendedTextMessage whose Text
// field is absent, are both a known kind missing the one field it cannot be
// written without — not silence, and above all not a blank utterance for the
// embedder to store.
func TestATextShapeWithNoTextIsMalformedNotABlankUtterance(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550092", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 12, 15, 0, 0, time.UTC)

	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("MT1"), at,
		&waE2E.Message{Conversation: proto.String("")}))
	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("MT2"), at,
		&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String(h.msgID("MT0"))},
		}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("two text shapes with no text: want 2 rows, got %d", len(rows))
	}
	for i, wantKind := range []string{"conversation", "extendedTextMessage"} {
		if rows[i].eventType != "opaque" {
			t.Errorf("row %d event_type = %q, want opaque — a text shape with no text is not speech", i, rows[i].eventType)
		}
		got := h.decryptPayload(t, rows[i])
		if got["kind"] != wantKind+"/text" || got["reason"] != "malformed" {
			t.Errorf("row %d kind/reason = %#v/%#v, want %s/text and malformed", i, got["kind"], got["reason"], wantKind)
		}
		if _, present := got["text"]; present {
			t.Errorf("row %d carries text %#v", i, got["text"])
		}
	}
}

// The single permitted drop must stay single (Codex r2): a conversation whose
// own id is a perfectly good PN identity is decidable, whatever its optional
// pnJID says — canonicalDMChat reads that alternative only for a LID.
func TestAMalformedPnJIDOnAPNConversationDropsNothing(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550093", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 12, 20, 0, 0, time.UTC)
	logs := captureLog(t)

	conv := conversation(customer.String(),
		webMsg(customer.String(), h.msgID("PJ1"), "¿abren el domingo?", at, webMsgOpts{}))
	conv.PnJID = proto.String(unparseableJID)
	h.ing.HandleEvent(historyBatch(conv))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("a decidable conversation with a malformed pnJID: want 1 row, got %d", len(rows))
	}
	if got := h.decryptPayload(t, rows[0]); got["chat_jid"] != customer.String() {
		t.Errorf("payload chat_jid = %#v, want %q", got["chat_jid"], customer.String())
	}
	if strings.Contains(logs.String(), "capture guard drop:") {
		t.Errorf("a decidable conversation was dropped: %q", logs.String())
	}
}

// A rider with nothing to ride is still a shape (Codex r3): a body carrying
// only the group sender-key transport is a delivery, and the rail did name it.
// Calling it `unknown` would invent an absence — and the bytes that would have
// said otherwise are hashed and discarded, so the counter could never be
// repaired afterwards.
func TestARiderThatIsTheOnlyShapeStillNamesItself(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550094", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 9, 1, 12, 25, 0, 0, time.UTC)

	h.ing.HandleEvent(railDelivery(customer, customer, false, h.msgID("SK1"), at,
		&waE2E.Message{SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{}}))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("sender-key-only delivery: want 1 row, got %d", len(rows))
	}
	if got := h.decryptPayload(t, rows[0]); got["kind"] != "senderKeyDistributionMessage" {
		t.Errorf("payload kind = %#v, want senderKeyDistributionMessage", got["kind"])
	}
}

// The push name is read from two different places by the two feeds — the
// stanza's optional `notify` attribute live, WebMessageInfo.PushName in
// history — so the same delivery routinely arrives named on one and unnamed on
// the other (Codex r3). It is not the delivery, so it must not key one.
func TestAnIdlessDeliveryCollapsesAcrossFeedsWhateverThePushNameSays(t *testing.T) {
	h := newHarness(t)
	customer := h.unnamedChat(t)
	at := time.Date(2026, 9, 1, 12, 30, 0, 0, time.UTC)
	body := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{DirectPath: proto.String("/v/t62.7118-24/pn")}}

	live := railDelivery(customer, customer, false, "", at, body)
	live.Info.PushName = "Sra. Garza"
	h.ing.HandleEvent(live)
	// The same delivery through the phone's history on the next relink, with
	// no push name in the blob.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		historyBody(customer.String(), "", at, body),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("one delivery, named live and unnamed in history: want 1 row, got %d", len(rows))
	}
	// The live row stands (first write wins), push name and all — excluded
	// from the identity, never from the record.
	if got := h.decryptPayload(t, rows[0]); got["push_name"] != "Sra. Garza" {
		t.Errorf("payload push_name = %#v, want the live row's %q", got["push_name"], "Sra. Garza")
	}
}

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
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/ingest"
)

// History-sync backfill (ticket #33, spec #29 decisions 5–7): the plane
// normalizes whatsmeow history-sync conversations into the SAME payload v:1
// shape as live capture — one additive backfill marker, push-name where
// present — over the same seam, behind the same capture guard. These tests
// drive constructed *events.HistorySync batches through the one HandleEvent
// entry and read the Postgres seam on the other side, exactly like the live
// guard matrix above.

// historyBatch wraps conversations the way whatsmeow delivers a history-sync
// blob after pairing.
func historyBatch(convs ...*waHistorySync.Conversation) *events.HistorySync {
	return &events.HistorySync{
		Data: &waHistorySync.HistorySync{
			SyncType:      waHistorySync.HistorySync_RECENT.Enum(),
			Conversations: convs,
		},
	}
}

func conversation(chatID string, msgs ...*waWeb.WebMessageInfo) *waHistorySync.Conversation {
	wrapped := make([]*waHistorySync.HistorySyncMsg, len(msgs))
	for i, m := range msgs {
		wrapped[i] = &waHistorySync.HistorySyncMsg{Message: m}
	}
	return &waHistorySync.Conversation{
		ID:       proto.String(chatID),
		Messages: wrapped,
	}
}

type webMsgOpts struct {
	fromMe   bool
	pushName string
	quotedID string
}

func webMsg(chatID string, id, text string, at time.Time, opts webMsgOpts) *waWeb.WebMessageInfo {
	m := &waWeb.WebMessageInfo{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(chatID),
			FromMe:    proto.Bool(opts.fromMe),
			ID:        proto.String(id),
		},
		MessageTimestamp: proto.Uint64(uint64(at.Unix())),
	}
	if opts.quotedID != "" {
		m.Message = &waE2E.Message{
			ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text:        proto.String(text),
				ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String(opts.quotedID)},
			},
		}
	} else {
		m.Message = &waE2E.Message{Conversation: proto.String(text)}
	}
	if opts.pushName != "" {
		m.PushName = proto.String(opts.pushName)
	}
	return m
}

func TestHistorySyncNormalizesToV1WithBackfillMarker(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550011", types.DefaultUserServer)
	h.allow(t, customer.String())
	t1 := time.Date(2026, 8, 20, 10, 42, 0, 0, time.UTC)
	t2 := time.Date(2026, 8, 20, 10, 45, 0, 0, time.UTC)
	t3 := time.Date(2026, 8, 20, 10, 50, 0, 0, time.UTC)

	// A month-old exchange arrives as one history-sync conversation: a
	// customer inbound (with their push name), the rep's own reply (no push
	// name supplied), and a quoted follow-up.
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		webMsg(customer.String(), h.msgID("HS1"), "¿tiene azúcar en costal?", t1, webMsgOpts{pushName: "Sra. Garza"}),
		webMsg(customer.String(), h.msgID("HS2"), "sí, ¿cuántos le mando?", t2, webMsgOpts{fromMe: true}),
		webMsg(customer.String(), h.msgID("HS3"), "dos, porfa", t3, webMsgOpts{pushName: "Sra. Garza", quotedID: h.msgID("HS2")}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("history conversation of 3 messages: want 3 wa_events rows, got %d", len(rows))
	}

	// Ordinary seam events (spec #29 decision 5): same source, same event
	// type, same composed external id as live capture — the metadata row
	// carries no hint of backfill, the marker lives in the payload.
	wantAt := []time.Time{t1, t2, t3}
	for i, row := range rows {
		if row.source != "whatsapp" || row.eventType != "message" {
			t.Errorf("row %d source/event_type = %q/%q, want whatsapp/message", i, row.source, row.eventType)
		}
		if !row.occurredAt.Equal(wantAt[i]) {
			t.Errorf("row %d occurred_at = %v, want the historical timestamp %v", i, row.occurredAt, wantAt[i])
		}
		if !strings.HasPrefix(row.externalEventID, customer.String()+":") {
			t.Errorf("row %d external_event_id = %q, want composed <chat>:<message-id>", i, row.externalEventID)
		}
	}

	// The inbound: full v:1 shape + the one additive marker + push_name —
	// exactly the #30 wire shape for push_name (additive, absent-not-empty).
	inbound := h.decryptPayload(t, rows[0])
	want := map[string]any{
		"v":          float64(1),
		"chat_jid":   customer.String(),
		"sender_jid": customer.String(),
		"from_me":    false,
		"message_id": h.msgID("HS1"),
		"text":       "¿tiene azúcar en costal?",
		"backfill":   true,
		"push_name":  "Sra. Garza",
	}
	if len(inbound) != len(want) {
		t.Errorf("inbound payload keys = %v, want exactly %v", inbound, want)
	}
	for k, v := range want {
		if inbound[k] != v {
			t.Errorf("inbound payload[%q] = %v, want %v", k, inbound[k], v)
		}
	}

	// The rep's own historical reply: from_me, sender is the live self PN,
	// and push_name is ABSENT (never an empty stamp) when the rail supplied
	// none.
	ownSent := h.decryptPayload(t, rows[1])
	if ownSent["from_me"] != true || ownSent["sender_jid"] != h.self.String() {
		t.Errorf("own-sent from_me/sender = %v/%v, want true/%v", ownSent["from_me"], ownSent["sender_jid"], h.self.String())
	}
	if _, present := ownSent["push_name"]; present {
		t.Errorf("own-sent payload carries push_name %v, want the key absent when the rail supplies none", ownSent["push_name"])
	}
	if ownSent["backfill"] != true {
		t.Errorf("own-sent payload backfill = %v, want true", ownSent["backfill"])
	}

	// The quoted follow-up keeps the quoted stanza id, like live capture.
	quoted := h.decryptPayload(t, rows[2])
	if quoted["quoted_message_id"] != h.msgID("HS2") {
		t.Errorf("quoted payload quoted_message_id = %v, want %q", quoted["quoted_message_id"], h.msgID("HS2"))
	}
}

func TestHistorySyncGuardDropsOutOfScopeChatsAtTheSocket(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550012", types.DefaultUserServer)
	stranger := types.NewJID("5215550013", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)

	// One batch mixing an in-scope conversation with an out-of-scope one —
	// including the rep's own messages there. The out-of-scope past never
	// leaves the plane (ADR-0023 applies to backfill identically).
	h.ing.HandleEvent(historyBatch(
		conversation(customer.String(),
			webMsg(customer.String(), h.msgID("MIX1"), "¿me surte mañana?", at, webMsgOpts{}),
			webMsg(customer.String(), h.msgID("MIX2"), "claro que sí", at.Add(time.Minute), webMsgOpts{fromMe: true}),
		),
		conversation(stranger.String(),
			webMsg(stranger.String(), h.msgID("MIX3"), "asunto privado de hace un mes", at, webMsgOpts{}),
			webMsg(stranger.String(), h.msgID("MIX4"), "respuesta privada", at.Add(time.Minute), webMsgOpts{fromMe: true}),
		),
	))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("mixed batch: want seam rows for the in-scope chat only (2), got %d", len(rows))
	}
	for i, row := range rows {
		if !strings.HasPrefix(row.externalEventID, customer.String()+":") {
			t.Errorf("row %d external_event_id = %q — an out-of-scope chat's history left the plane", i, row.externalEventID)
		}
	}
}

func TestHistorySyncLIDConversationCanonicalizesToPN(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550014", types.DefaultUserServer)
	h.allow(t, customer.String())
	lid := types.NewJID("222333444555666", types.HiddenUserServer)
	at := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)

	// Modern history-sync threads can be LID-identified; the conversation
	// carries its PN alternative in pnJID. The same chat must land on the
	// same identity as live capture (#22 contract) — scope, dedupe, and the
	// twin all see one chat.
	conv := conversation(lid.String(),
		webMsg(lid.String(), h.msgID("LID1"), "¿tiene chile de árbol?", at, webMsgOpts{pushName: "Don Chuy"}),
		webMsg(lid.String(), h.msgID("LID2"), "sí, ¿cuánto quiere?", at.Add(time.Minute), webMsgOpts{fromMe: true}),
	)
	conv.PnJID = proto.String(customer.String())
	h.ing.HandleEvent(historyBatch(conv))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("LID-identified history conversation of an allowlisted chat: want 2 rows, got %d", len(rows))
	}
	if want := customer.String() + ":" + h.msgID("LID1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want PN-canonical %q", rows[0].externalEventID, want)
	}
	inbound := h.decryptPayload(t, rows[0])
	if inbound["chat_jid"] != customer.String() || inbound["sender_jid"] != customer.String() {
		t.Errorf("payload chat/sender = %v/%v, want PN-canonical %v", inbound["chat_jid"], inbound["sender_jid"], customer.String())
	}
	ownSent := h.decryptPayload(t, rows[1])
	if ownSent["chat_jid"] != customer.String() || ownSent["sender_jid"] != h.self.String() {
		t.Errorf("own-sent chat/sender = %v/%v, want %v/%v", ownSent["chat_jid"], ownSent["sender_jid"], customer.String(), h.self.String())
	}
}

func TestHistorySyncLIDParticipantCanonicalizesLikeTheLivePath(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550019", types.DefaultUserServer)
	h.allow(t, customer.String())
	lidParticipant := types.NewJID("777888999000111", types.HiddenUserServer)
	at := time.Date(2026, 8, 13, 14, 0, 0, 0, time.UTC)

	// A history row can stamp its sender as a LID participant. The live
	// path's doctrine (#22): a LID sender in a DM IS the chat — the
	// payload's sender_jid must land PN-canonical, never a LID the twin
	// cannot correlate.
	msg := webMsg(customer.String(), h.msgID("LP1"), "¿cuánto el ciento?", at, webMsgOpts{})
	msg.Participant = proto.String(lidParticipant.String())
	h.ing.HandleEvent(historyBatch(conversation(customer.String(), msg)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("LID-participant history row: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["sender_jid"] != customer.String() {
		t.Errorf("payload sender_jid = %v, want PN-canonical %v (live-path doctrine)", got["sender_jid"], customer.String())
	}
}

func TestHistorySyncSelfLIDConversationIsTheTwinThread(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 8, 17, 8, 0, 0, 0, time.UTC)

	// The self-chat's history can arrive identified by the account's own
	// LID with no PN alternative. The live session knows its own LID
	// (rail.SelfLID, ADR-0006) — the twin thread is structurally in scope,
	// no allowlist row (ADR-0023).
	h.ing.HandleEvent(historyBatch(conversation(h.selfLID.String(),
		webMsg(h.selfLID.String(), h.msgID("SLF1"), "apuntar: cobrarle a la sra garza", at, webMsgOpts{fromMe: true}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("self-LID history conversation: want 1 row, got %d", len(rows))
	}
	if want := h.self.String() + ":" + h.msgID("SLF1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want PN-canonical self %q", rows[0].externalEventID, want)
	}
	got := h.decryptPayload(t, rows[0])
	if got["chat_jid"] != h.self.String() || got["sender_jid"] != h.self.String() || got["from_me"] != true {
		t.Errorf("payload chat/sender/from_me = %v/%v/%v, want %v/%v/true", got["chat_jid"], got["sender_jid"], got["from_me"], h.self.String(), h.self.String())
	}
}

func TestHistorySyncRedeliveredBatchWritesNoDuplicates(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550015", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 16, 15, 0, 0, 0, time.UTC)

	// A crash-and-resync (or whatsmeow re-delivering a chunk) presents the
	// same history again: the composed <chat>:<message-id> identity dedupes
	// at the seam — restart-safe by construction.
	batch := historyBatch(conversation(customer.String(),
		webMsg(customer.String(), h.msgID("RD1"), "¿ya llegó el pedido?", at, webMsgOpts{}),
		webMsg(customer.String(), h.msgID("RD2"), "mañana temprano", at.Add(time.Minute), webMsgOpts{fromMe: true}),
	))
	h.ing.HandleEvent(batch)
	h.ing.HandleEvent(batch)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 2 {
		t.Fatalf("re-delivered history batch produced %d rows, want exactly 2", n)
	}
}

func TestHistorySyncOverlapsLiveCaptureOnTheMessageID(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550016", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 27, 9, 30, 0, 0, time.UTC)

	// The overlap shape: a message captured live also appears in the
	// history blob. Same chat, same WhatsApp message id → same composed
	// external id → one seam row (the message-id rule, #22/#31): the live
	// row stands, the backfill copy dedupes away.
	h.ing.HandleEvent(textMessage(customer, customer, false, h.msgID("OV1"), at, "¿me lo aparta?"))
	h.ing.HandleEvent(historyBatch(conversation(customer.String(),
		webMsg(customer.String(), h.msgID("OV0"), "mensaje más viejo", at.Add(-time.Hour), webMsgOpts{}),
		webMsg(customer.String(), h.msgID("OV1"), "¿me lo aparta?", at, webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 2 {
		t.Fatalf("live/backfill overlap: want 2 rows (old + once-captured), got %d", len(rows))
	}
	byID := map[string]map[string]any{}
	for _, row := range rows {
		p := h.decryptPayload(t, row)
		byID[p["message_id"].(string)] = p
	}
	if _, present := byID[h.msgID("OV1")]["backfill"]; present {
		t.Errorf("the live-captured row was replaced by a backfill copy — the first delivery must win")
	}
	if byID[h.msgID("OV0")]["backfill"] != true {
		t.Errorf("the history-only message lost its backfill marker: %v", byID[h.msgID("OV0")])
	}
}

func TestHistorySyncUnwrapsEphemeralWrappedText(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550020", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 12, 13, 0, 0, 0, time.UTC)

	// A disappearing-mode chat's history wraps every body in
	// EphemeralMessage. The live pipeline dispatches the UNWRAPPED body
	// (whatsmeow's UnwrapRaw runs before the event reaches the guard) —
	// normalization consistent with the live path means the history feed
	// must unwrap the same way, or a disappearing chat's whole past lands
	// as empty text.
	wrapped := &waWeb.WebMessageInfo{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(customer.String()),
			ID:        proto.String(h.msgID("EPH1")),
		},
		Message: &waE2E.Message{
			EphemeralMessage: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{
					ExtendedTextMessage: &waE2E.ExtendedTextMessage{
						Text:        proto.String("¿me guarda dos costales?"),
						ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String(h.msgID("EPH0"))},
					},
				},
			},
		},
		MessageTimestamp: proto.Uint64(uint64(at.Unix())),
	}
	h.ing.HandleEvent(historyBatch(conversation(customer.String(), wrapped)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("ephemeral-wrapped history row: want 1 row, got %d", len(rows))
	}
	got := h.decryptPayload(t, rows[0])
	if got["text"] != "¿me guarda dos costales?" {
		t.Errorf("payload text = %v, want the unwrapped ephemeral body", got["text"])
	}
	if got["quoted_message_id"] != h.msgID("EPH0") {
		t.Errorf("payload quoted_message_id = %v, want %q (context rides inside the wrapper)", got["quoted_message_id"], h.msgID("EPH0"))
	}
}

func TestHistorySyncWritesEveryDeliveryAndOnlyStubsWriteNothing(t *testing.T) {
	h := newHarness(t)
	// A per-run chat, because one of these entries has no message id and so
	// keys on the hash of its own envelope (unnamedChat says why).
	customer := h.unnamedChat(t)
	at := time.Date(2026, 8, 15, 11, 0, 0, 0, time.UTC)

	// History blobs carry protocol stubs (no message content at all), the odd
	// unidentifiable row (no message id) and media. A stub is METADATA, not a
	// delivery — ADR-0023 routes it to the scoping UI and it stays outside the
	// seam. The other two ARE deliveries and each leaves exactly one row: the
	// id-less one was skipped and the photo was husked before ADR-0042, and
	// neither left an honest row.
	stub := &waWeb.WebMessageInfo{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(customer.String()),
			ID:        proto.String(h.msgID("ST1")),
		},
		MessageTimestamp: proto.Uint64(uint64(at.Unix())),
		MessageStubType:  waWeb.WebMessageInfo_CALL_MISSED_VOICE.Enum(),
	}
	noID := webMsg(customer.String(), "", "texto sin identidad", at, webMsgOpts{})
	media := &waWeb.WebMessageInfo{
		Key: &waCommon.MessageKey{
			RemoteJID: proto.String(customer.String()),
			ID:        proto.String(h.msgID("MED1")),
		},
		Message:          &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}},
		MessageTimestamp: proto.Uint64(uint64(at.Add(time.Minute).Unix())),
	}
	real1 := webMsg(customer.String(), h.msgID("RL1"), "¿abren el domingo?", at.Add(2*time.Minute), webMsgOpts{})

	h.ing.HandleEvent(historyBatch(conversation(customer.String(), stub, noID, media, real1)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("stub + no-id + media + text: want 3 rows (no-id, media, text), got %d", len(rows))
	}
	if rows[0].eventType != "opaque" || rows[1].eventType != "opaque" || rows[2].eventType != "message" {
		t.Fatalf("event types = %q/%q/%q, want opaque/opaque/message", rows[0].eventType, rows[1].eventType, rows[2].eventType)
	}
	mediaPayload := h.decryptPayload(t, rows[1])
	if mediaPayload["message_id"] != h.msgID("MED1")+":opaque" || mediaPayload["kind"] != "imageMessage" {
		t.Errorf("media row = %v, want message_id %q of kind imageMessage", mediaPayload, h.msgID("MED1"))
	}
	if mediaPayload["backfill"] != true {
		t.Errorf("media row backfill = %v, want true", mediaPayload["backfill"])
	}
	// The stub left nothing behind it: its id appears on no row.
	for _, row := range rows {
		if strings.Contains(row.externalEventID, h.msgID("ST1")) {
			t.Errorf("a stub wrote a seam row (%q) — metadata is not a delivery (ADR-0023)", row.externalEventID)
		}
	}
}

// newIngestorWithSelf builds an ingestor sharing the harness DB/key/stamp
// but with a different self source (the unknown-identity axis).
func newIngestorWithSelf(t *testing.T, h *harness, self ingest.SelfSource, errs *[]error) *ingest.Ingestor {
	t.Helper()
	return ingest.New(ingest.Config{
		DB:        h.db,
		Sealer:    mustSealer(t, h.key),
		Stamp:     h.stamp,
		Self:      self,
		Directory: h.dir,
		OnError: func(err error) {
			*errs = append(*errs, err)
		},
	})
}

func TestHistorySyncRefusesLoudlyWithoutSelfIdentity(t *testing.T) {
	h := newHarness(t)
	var errs []error
	ing := newIngestorWithSelf(t, h, unknownSelf{}, &errs)
	customer := types.NewJID("5215550018", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Date(2026, 8, 14, 10, 0, 0, 0, time.UTC)

	// Without the live session identity the guard cannot tell the twin
	// thread's history from any other chat's — deciding scope would risk
	// silently dropping it (ADR-0023). Refuse loudly, write nothing.
	ing.HandleEvent(historyBatch(conversation(customer.String(),
		webMsg(customer.String(), h.msgID("NS1"), "¿sigue en pie el pedido?", at, webMsgOpts{}),
	)))

	if len(errs) == 0 {
		t.Fatalf("want a loud guard refusal for history without self identity, got none")
	}
	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("history without self identity persisted %d rows, want 0", n)
	}
}

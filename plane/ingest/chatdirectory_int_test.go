package ingest_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historywindow"
	"github.com/Dito-Core/dito/plane/ingest"
)

// The chat directory at the Postgres seam (ticket #222 AC 1; spec #214
// decision 7; ADR-0023 as this ticket amends it). Constructed whatsmeow
// events in, rows out: the directory rows on one side, `wa_events` on the
// other, and the plane's own log read for anything it must never carry.

// directoryRow is the directory as a reader sees it, with the name still
// SEALED — the test opens it with the harness DEK, which is the whole point
// (ADR-0008: only a process holding the twin's key can read what a rep's
// phone calls a person).
type directoryRow struct {
	chatJID         string
	lidJID          sql.NullString
	kind            string
	nameEnc         []byte
	lastActivityAt  sql.NullTime
	anchorMessageID sql.NullString
	anchorFromMe    sql.NullBool
	anchorAt        sql.NullTime
	pages           int
	oldestAt        sql.NullTime
	endOfTransfer   sql.NullString
	lastFillAt      sql.NullTime
}

func (h *harness) readDirectory(t *testing.T) []directoryRow {
	t.Helper()
	rows, err := h.db.Query(
		`SELECT chat_jid, lid_jid, kind, name_enc, last_activity_at,
		        anchor_message_id, anchor_from_me, anchor_at,
		        fill_pages, fill_oldest_at, fill_end_of_transfer, fill_last_at
		   FROM chat_directory WHERE twin_id = $1 ORDER BY chat_jid`,
		h.stamp.TwinID,
	)
	if err != nil {
		t.Fatalf("reading chat_directory: %v", err)
	}
	defer rows.Close()
	var out []directoryRow
	for rows.Next() {
		var row directoryRow
		if err := rows.Scan(&row.chatJID, &row.lidJID, &row.kind, &row.nameEnc, &row.lastActivityAt,
			&row.anchorMessageID, &row.anchorFromMe, &row.anchorAt,
			&row.pages, &row.oldestAt, &row.endOfTransfer, &row.lastFillAt); err != nil {
			t.Fatalf("scanning chat_directory row: %v", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading chat_directory: %v", err)
	}
	return out
}

// openName opens a sealed directory name under the harness DEK, proving it
// rests encrypted rather than in a plaintext column.
func (h *harness) openName(t *testing.T, row directoryRow) string {
	t.Helper()
	if row.nameEnc == nil {
		return ""
	}
	plain, err := ingest.OpenEnvelope(h.key, row.nameEnc)
	if err != nil {
		t.Fatalf("name_enc does not open under the twin DEK: %v", err)
	}
	return string(plain)
}

func TestHistorySyncRecordsEveryConversationInScopeOrNot(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	inScope := types.NewJID("5215550101", types.DefaultUserServer)
	h.allow(t, inScope.String())
	strangerA := types.NewJID("5215550102", types.DefaultUserServer)
	strangerBLID := types.NewJID("444555666777888", types.HiddenUserServer)
	strangerBPN := types.NewJID("5215550103", types.DefaultUserServer)
	at := time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)

	// The pairing push: one chat the rep scoped, and two they did not — the
	// second of those LID-keyed with its phone number stated beside it, which
	// is the shape the pairing push comes in.
	scoped := conversation(inScope.String(),
		webMsg(inScope.String(), h.msgID("D1"), "¿tiene azúcar?", at, webMsgOpts{pushName: "Sra. Garza"}),
		webMsg(inScope.String(), h.msgID("D2"), "sí, ¿cuántos?", at.Add(time.Minute), webMsgOpts{fromMe: true}),
	)
	scoped.Name = proto.String("Sra. Garza")
	scoped.LastMsgTimestamp = proto.Uint64(uint64(at.Add(time.Minute).Unix()))
	scoped.LidJID = proto.String("111222333444555@lid")

	strangerOne := conversation(strangerA.String(),
		webMsg(strangerA.String(), h.msgID("D3"), "mamá, ya voy", at.Add(2*time.Minute), webMsgOpts{}),
	)
	strangerOne.DisplayName = proto.String("Mamá")

	strangerTwo := conversation(strangerBLID.String(),
		webMsg(strangerBLID.String(), h.msgID("D4"), "el partido del domingo", at.Add(3*time.Minute), webMsgOpts{}),
	)
	strangerTwo.PnJID = proto.String(strangerBPN.String())
	strangerTwo.DisplayName = proto.String("Fut dominical")

	h.ing.HandleEvent(historyBatch(scoped, strangerOne, strangerTwo))
	h.requireNoErrors(t)

	// THREE ROWS: metadata, a LID and an anchor of an out-of-scope chat leave
	// the socket (ADR-0023 as amended), so scoping can become a standing
	// capability.
	dir := h.readDirectory(t)
	if len(dir) != 3 {
		t.Fatalf("one in-scope and two out-of-scope conversations: want 3 directory rows, got %d", len(dir))
	}
	byChat := map[string]directoryRow{}
	for _, row := range dir {
		byChat[row.chatJID] = row
	}
	for _, want := range []struct {
		chat, name, lid string
		anchor          string
		anchorFromMe    bool
	}{
		{inScope.String(), "Sra. Garza", "111222333444555@lid", h.msgID("D2"), true},
		{strangerA.String(), "Mamá", "", h.msgID("D3"), false},
		{strangerBPN.String(), "Fut dominical", strangerBLID.String(), h.msgID("D4"), false},
	} {
		row, ok := byChat[want.chat]
		if !ok {
			t.Errorf("no directory row for %s — every conversation is recorded, in scope or not", want.chat)
			continue
		}
		if row.kind != "dm" {
			t.Errorf("%s kind = %q, want dm", want.chat, row.kind)
		}
		if got := h.openName(t, row); got != want.name {
			t.Errorf("%s sealed name opens to %q, want %q", want.chat, got, want.name)
		}
		if row.lidJID.String != want.lid {
			t.Errorf("%s lid_jid = %q, want %q", want.chat, row.lidJID.String, want.lid)
		}
		if row.anchorMessageID.String != want.anchor {
			t.Errorf("%s anchor = %q, want the chat's newest message %q", want.chat, row.anchorMessageID.String, want.anchor)
		}
		if row.anchorFromMe.Bool != want.anchorFromMe {
			t.Errorf("%s anchor from_me = %v, want %v", want.chat, row.anchorFromMe.Bool, want.anchorFromMe)
		}
		if !row.anchorAt.Valid {
			t.Errorf("%s anchor states no instant — the request cannot be built from two of the three facts", want.chat)
		}
		if row.pages != 0 || row.oldestAt.Valid || row.endOfTransfer.Valid {
			t.Errorf("%s carries fill progress before any fill ran: pages=%d oldest=%v word=%v",
				want.chat, row.pages, row.oldestAt, row.endOfTransfer)
		}
	}

	// ...AND ONLY THE SCOPED CHAT'S MESSAGES. The out-of-scope past never
	// leaves the plane (ADR-0023), which the directory does not change.
	events := h.readEvents(t)
	if len(events) != 2 {
		t.Fatalf("want exactly the in-scope conversation's 2 wa_events rows, got %d", len(events))
	}
	for _, row := range events {
		if !strings.HasPrefix(row.externalEventID, inScope.String()+":") {
			t.Errorf("a wa_events row keys on %q — only the scoped chat's messages may rest anywhere", row.externalEventID)
		}
	}

	// ...AND THE LOG NAMES NEITHER. Telemetry is content-free by construction
	// (ADR-0025): no chat identity, no name, no message text — for the scoped
	// chat as much as for the two nobody scoped.
	line := logs.String()
	for _, forbidden := range []string{
		strangerA.String(), strangerA.User, strangerBPN.String(), strangerBPN.User,
		strangerBLID.String(), strangerBLID.User, inScope.String(), inScope.User,
		"Mamá", "Fut dominical", "Sra. Garza", "el partido del domingo", "mamá, ya voy", "¿tiene azúcar?",
	} {
		if strings.Contains(line, forbidden) {
			t.Errorf("the plane's log carries %q — a chat, a name and a message are exactly what telemetry may not name (ADR-0025)", forbidden)
		}
	}
}

// The anchor is the chat's NEWEST message and it moves forward only: a second
// sync carrying an older window must not pull it back, or the fill would
// re-ask a window it has already paged through (ticket #222).
func TestTheAnchorMovesForwardOnlyAndTheLIDIsNeverBlanked(t *testing.T) {
	h := newHarness(t)
	chat := types.NewJID("5215550110", types.DefaultUserServer)
	lid := types.NewJID("555666777888999", types.HiddenUserServer)
	newest := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)
	older := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)

	first := conversation(chat.String(),
		webMsg(chat.String(), h.msgID("F1"), "¿me aparta dos?", newest, webMsgOpts{}),
	)
	first.DisplayName = proto.String("Don Chuy")
	first.LidJID = proto.String(lid.String())
	h.ing.HandleEvent(historyBatch(first))

	// An on-demand page: older messages, no name, no stated identities at all
	// — the exact shape the phone answers with (#216's readings of
	// 2026-09-07).
	page := conversation(chat.String(),
		webMsg(chat.String(), h.msgID("F0"), "buenas tardes", older, webMsgOpts{}),
	)
	h.ing.HandleEvent(historyBatch(page))
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("two syncs of one chat: want 1 directory row, got %d", len(dir))
	}
	row := dir[0]
	if row.anchorMessageID.String != h.msgID("F1") {
		t.Errorf("anchor = %q, want the newest message %q — an anchor that moved backwards would re-ask a paged window",
			row.anchorMessageID.String, h.msgID("F1"))
	}
	if !row.anchorAt.Valid || !row.anchorAt.Time.Equal(newest) {
		t.Errorf("anchor_at = %v, want %v", row.anchorAt.Time, newest)
	}
	if row.lidJID.String != lid.String() {
		t.Errorf("lid_jid = %q after a sync that stated none, want it kept as %q — a blanked LID retires the chat's history",
			row.lidJID.String, lid.String())
	}
	if got := h.openName(t, row); got != "Don Chuy" {
		t.Errorf("sealed name opens to %q after a sync that carried none, want it kept as %q", got, "Don Chuy")
	}
	if !row.lastActivityAt.Valid || !row.lastActivityAt.Time.Equal(newest) {
		t.Errorf("last_activity_at = %v, want the newest instant %v — the scoping page orders by it", row.lastActivityAt.Time, newest)
	}
}

// A gesture is not a position in the chat's message history, so it is never
// the anchor — the phone is asked for "the messages before THIS message"
// (`historyspike/anchor.go`'s argument, applied to the blob). A photo IS one,
// which is where the blob reader is deliberately wider than the seam reader.
func TestTheAnchorSkipsAGestureAndTakesAPhoto(t *testing.T) {
	h := newHarness(t)
	chat := types.NewJID("5215550111", types.DefaultUserServer)
	photoAt := time.Date(2026, 9, 5, 8, 0, 0, 0, time.UTC)
	gestureAt := photoAt.Add(time.Hour)

	photo := webMsg(chat.String(), h.msgID("G1"), "", photoAt, webMsgOpts{})
	photo.Message = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}
	gesture := webMsg(chat.String(), h.msgID("G2"), "", gestureAt, webMsgOpts{})
	gesture.Message = &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
		Key:  photo.GetKey(),
		Text: proto.String("👍"),
	}}

	h.ing.HandleEvent(historyBatch(conversation(chat.String(), photo, gesture)))
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("want 1 directory row, got %d", len(dir))
	}
	if dir[0].anchorMessageID.String != h.msgID("G1") {
		t.Errorf("anchor = %q, want the photo %q — a reaction's own stanza id is not a position in the chat",
			dir[0].anchorMessageID.String, h.msgID("G1"))
	}
}

// The twin thread's kind is structural, from the live session identity rather
// than a config row (ADR-0023) — so the rep's own chat is never something to
// scope on the scoping page.
func TestTheTwinThreadIsRecordedAsSelf(t *testing.T) {
	h := newHarness(t)
	at := time.Date(2026, 9, 5, 9, 0, 0, 0, time.UTC)

	h.ing.HandleEvent(historyBatch(conversation(h.self.String(),
		webMsg(h.self.String(), h.msgID("S1"), "recuérdame surtir a don Chuy", at, webMsgOpts{fromMe: true}),
	)))
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("want 1 directory row for the twin thread, got %d", len(dir))
	}
	if dir[0].kind != "self" {
		t.Errorf("the twin thread's kind = %q, want self", dir[0].kind)
	}
}

// The app-state feeds: a contact edit and a changed push name teach the
// directory a name and, where they state both identities, a LID — for a chat
// with no history at all, which is how a chat the pairing push never carried
// gets a name on the scoping page (ticket #222; spec #214 decision 7).
func TestTheAppStateFeedsRecordNamesAndIdentitiesAndNothingElse(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	contact := types.NewJID("5215550120", types.DefaultUserServer)
	contactLID := types.NewJID("666777888999000", types.HiddenUserServer)
	pusher := types.NewJID("5215550121", types.DefaultUserServer)
	pusherLID := types.NewJID("777888999000111", types.HiddenUserServer)

	h.ing.HandleEvent(&events.Contact{
		JID: contact,
		Action: &waSyncAction.ContactAction{
			FullName: proto.String("Doña Lupita"),
			PnJID:    proto.String(contact.String()),
			LidJID:   proto.String(contactLID.String()),
		},
	})
	// The push-name feed states one identity in JID and the other in JIDAlt,
	// with nothing to say which is which — the server on each decides.
	h.ing.HandleEvent(&events.PushName{
		JID:         pusherLID,
		JIDAlt:      pusher,
		OldPushName: "",
		NewPushName: "Tacos El Güero",
	})
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 2 {
		t.Fatalf("a contact edit and a push name: want 2 directory rows, got %d", len(dir))
	}
	byChat := map[string]directoryRow{}
	for _, row := range dir {
		byChat[row.chatJID] = row
	}
	for _, want := range []struct{ chat, name, lid string }{
		{contact.String(), "Doña Lupita", contactLID.String()},
		{pusher.String(), "Tacos El Güero", pusherLID.String()},
	} {
		row, ok := byChat[want.chat]
		if !ok {
			t.Errorf("no directory row for %s", want.chat)
			continue
		}
		if got := h.openName(t, row); got != want.name {
			t.Errorf("%s sealed name opens to %q, want %q", want.chat, got, want.name)
		}
		if row.lidJID.String != want.lid {
			t.Errorf("%s lid_jid = %q, want %q", want.chat, row.lidJID.String, want.lid)
		}
		// A CONTACT IS NOT A CHAT: an address-book edit did not happen in a
		// conversation, so it states no anchor and no activity instant, and an
		// anchor invented from one would ask the phone to page back from a
		// message that does not exist.
		if row.anchorMessageID.Valid || row.lastActivityAt.Valid {
			t.Errorf("%s took an anchor or an activity instant off an app-state event: anchor=%v activity=%v",
				want.chat, row.anchorMessageID, row.lastActivityAt)
		}
	}
	// No seam row: neither feed is a delivery.
	if n := h.countAllRows(t); n != 0 {
		t.Errorf("the app-state feeds wrote %d wa_events row(s), want 0 — a name is not a delivery", n)
	}
	for _, forbidden := range []string{"Doña Lupita", "Tacos El Güero", contact.String(), pusher.String(), pusherLID.String()} {
		if strings.Contains(logs.String(), forbidden) {
			t.Errorf("the plane's log carries %q from an app-state feed (ADR-0025)", forbidden)
		}
	}
}

// A feed with no name writes nothing at all: there is no anchor and no instant
// to record, so an upsert would either touch a row to change nothing or create
// one saying only "this address exists" — a chat identity resting in the
// directory for no reason anybody asked for (`recordName` argues it).
func TestAnAppStateEventWithNoNameWritesNoRow(t *testing.T) {
	h := newHarness(t)
	h.ing.HandleEvent(&events.PushName{
		JID:         types.NewJID("5215550122", types.DefaultUserServer),
		NewPushName: "",
	})
	h.ing.HandleEvent(&events.Contact{
		JID:    types.NewJID("5215550123", types.DefaultUserServer),
		Action: &waSyncAction.ContactAction{},
	})
	h.requireNoErrors(t)

	if dir := h.readDirectory(t); len(dir) != 0 {
		t.Errorf("a nameless app-state event wrote %d directory row(s), want 0", len(dir))
	}
}

// THE FAILURE THIS TICKET EXISTS FOR (ticket #222 AC 2; #216's readings of
// 2026-09-07): the phone answers an on-demand request with a conversation
// keyed by LID that states NEITHER `pnJid` NOR `lidJid`. Before the
// resolution, the LID stayed the chat's identity, the uncached allowlist read
// found no row for it — the allowlist carries the PN — and the whole page was
// dropped as out-of-scope for a chat the rep had just scoped in.
func TestALIDKeyedPageWithNoPnJIDLandsOnThePNCanonicalChat(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550130", types.DefaultUserServer)
	lid := types.NewJID("888999000111222", types.HiddenUserServer)
	h.allow(t, customer.String())
	// The directory learned both identities from the pairing push, which
	// states `pnJid` — this is what the resolution reads.
	//
	// EVERY INSTANT IS RELATIVE TO NOW and inside the harness's ninety-day
	// window, because the guard bounds an on-demand page by that window and
	// this test is about the RESOLUTION rather than the bound (the bound has
	// its own test below).
	now := time.Now().UTC()
	seed := conversation(customer.String(),
		webMsg(customer.String(), h.msgID("P9"), "¿cuánto el bulto?", now.AddDate(0, 0, -2), webMsgOpts{}),
	)
	seed.LidJID = proto.String(lid.String())
	h.ing.HandleEvent(historyBatch(seed))

	// ...and now the page: ON_DEMAND, keyed by LID, silent about both
	// alternatives.
	older := now.AddDate(0, 0, -30)
	page := onDemandBatch(conversation(lid.String(),
		webMsg(lid.String(), h.msgID("P1"), "hola, ¿tiene cemento?", older, webMsgOpts{pushName: "Don Beto"}),
		webMsg(lid.String(), h.msgID("P2"), "sí, ¿cuántos bultos?", older.Add(time.Minute), webMsgOpts{fromMe: true}),
	))
	h.ing.HandleEvent(page)
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 3 {
		t.Fatalf("the seed plus a two-message on-demand page: want 3 wa_events rows, got %d", len(rows))
	}
	for _, row := range rows {
		if !strings.HasPrefix(row.externalEventID, customer.String()+":") {
			t.Errorf("external_event_id = %q, want the PN-canonical chat %q — a LID-keyed page must land on the chat, not beside it",
				row.externalEventID, customer.String())
		}
	}
	// The page's own rows: the backfill marker and the PN-canonical identity,
	// through the same code that ingests the pairing push.
	page1 := h.decryptPayload(t, rows[1])
	if page1["backfill"] != true {
		t.Errorf("page row backfill = %v, want true — a page is history, and history never drafts", page1["backfill"])
	}
	if page1["chat_jid"] != customer.String() || page1["sender_jid"] != customer.String() {
		t.Errorf("page row chat/sender = %v/%v, want PN-canonical %v", page1["chat_jid"], page1["sender_jid"], customer.String())
	}
	ownSent := h.decryptPayload(t, rows[2])
	if ownSent["sender_jid"] != h.self.String() {
		t.Errorf("page own-sent sender = %v, want the live self %v", ownSent["sender_jid"], h.self.String())
	}
}

// ...and the same page for a chat the directory has never seen resolves
// through the LIBRARY's own identity map, which the PHONE fills inside its
// history syncs. A wider net, one indirection further away, tried second.
func TestALIDKeyedPageResolvesThroughTheLibraryMapWhenTheDirectoryCannot(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550131", types.DefaultUserServer)
	lid := types.NewJID("999000111222333", types.HiddenUserServer)
	h.allow(t, customer.String())

	ing := newIngestorWithLIDs(t, h, stubLIDs{lid: lid, pn: customer})
	older := time.Now().UTC().AddDate(0, 0, -30)
	ing.HandleEvent(onDemandBatch(conversation(lid.String(),
		webMsg(lid.String(), h.msgID("L1"), "¿tiene varilla?", older, webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("want the page's 1 row, got %d", len(rows))
	}
	if want := customer.String() + ":" + h.msgID("L1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", rows[0].externalEventID, want)
	}
}

// When neither knows, nothing changes: the LID remains the identity and the
// allowlist decides, which is the rule `canonicalDMChat` has always applied to
// a LID with no alternative — "the allowlist can carry it, and nothing is
// guessed". Forcing an undecidable drop here instead would take away the one
// case that rule exists for.
func TestALIDNobodyKnowsStaysTheIdentityAndTheAllowlistDecides(t *testing.T) {
	h := newHarness(t)
	lid := types.NewJID("111000111000111", types.HiddenUserServer)
	h.allow(t, lid.String())
	at := time.Now().UTC().AddDate(0, 0, -30)

	h.ing.HandleEvent(onDemandBatch(conversation(lid.String(),
		webMsg(lid.String(), h.msgID("U1"), "¿a qué hora abren?", at, webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("a LID-allowlisted chat: want 1 row, got %d", len(rows))
	}
	if want := lid.String() + ":" + h.msgID("U1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want the LID itself %q", rows[0].externalEventID, want)
	}
}

// onDemandBatch is the answer shape the phone returns to an on-demand history
// request: `ON_DEMAND` rather than `RECENT`, one chunk, and the conversation
// stating that more remains on the primary (#216's readings of 2026-09-07).
func onDemandBatch(convs ...*waHistorySync.Conversation) *events.HistorySync {
	for _, conv := range convs {
		conv.EndOfHistoryTransferType =
			waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY.Enum()
	}
	batch := historyBatch(convs...)
	batch.Data.SyncType = waHistorySync.HistorySync_ON_DEMAND.Enum()
	return batch
}

// stubLIDs is the library's identity map as the plane reads it — one mapping,
// which is what the phone's own history sync leaves behind.
type stubLIDs struct {
	lid types.JID
	pn  types.JID
}

func (s stubLIDs) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	if lid.ToNonAD() == s.lid.ToNonAD() {
		return s.pn, nil
	}
	return types.JID{}, nil
}

// newIngestorWithLIDs builds an ingestor sharing the harness DB, key, stamp
// and directory but with the library's identity map wired — the second source
// of the guard's LID resolution.
func newIngestorWithLIDs(t *testing.T, h *harness, lids ingest.LIDStore) *ingest.Ingestor {
	t.Helper()
	return ingest.New(ingest.Config{
		DB:        h.db,
		Sealer:    mustSealer(t, h.key),
		Stamp:     h.stamp,
		Self:      fixedSelf{jid: h.self, lid: h.selfLID},
		Directory: h.dir,
		LIDs:      lids,
		Window:    historywindow.New(h.db, h.stamp.TwinID),
		OnError:   func(err error) { *h.errors = append(*h.errors, err) },
	})
}

// THE LINE IS A FILTER AS WELL AS A STOP (ticket #222; spec #214 decision 8).
// The fill stops asking once a page reaches past the twin's window, but the
// page that CROSSED it is already at the socket with up to fifty messages on
// it — some of them older than the ninety days the product promised to read.
// So the guard refuses those rows, where every other rule about what may rest
// already lives.
func TestAnOnDemandPageIsBoundedByTheTwinsHistoryWindow(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	chat := types.NewJID("5215550140", types.DefaultUserServer)
	h.allow(t, chat.String())
	now := time.Now().UTC()
	inside := now.AddDate(0, 0, -30)
	beyond := now.AddDate(0, 0, -harnessWindowDays-30)

	h.ing.HandleEvent(onDemandBatch(conversation(chat.String(),
		webMsg(chat.String(), h.msgID("W1"), "dentro de la ventana", inside, webMsgOpts{}),
		webMsg(chat.String(), h.msgID("W0"), "de hace mucho", beyond, webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("a page straddling the window: want 1 row, got %d", len(rows))
	}
	if want := chat.String() + ":" + h.msgID("W1"); rows[0].externalEventID != want {
		t.Errorf("external_event_id = %q, want only the row inside the window (%q)", rows[0].externalEventID, want)
	}
	// ...and the refusal is COUNTED rather than silent, content-free.
	if !strings.Contains(logs.String(), "kind=on_demand_page beyond_window=1") {
		t.Errorf("the guard refused a row for the window and said nothing about it; log = %q", logs.String())
	}
	for _, forbidden := range []string{chat.String(), chat.User, "de hace mucho", "dentro de la ventana"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Errorf("the window line carries %q (ADR-0025)", forbidden)
		}
	}
}

// ...and the PAIRING PUSH is not bounded by it, which is a decision rather
// than an omission: the phone's own pushes are its choice of what to send and
// the guard writes them whole, and bounding them too would change what five
// slices of corpora contain for a promise about the FILL. Whether the promise
// should reach the push as well is carried on the horizon ([#117]).
func TestThePairingPushIsNotBoundedByTheWindow(t *testing.T) {
	h := newHarness(t)
	chat := types.NewJID("5215550141", types.DefaultUserServer)
	h.allow(t, chat.String())
	beyond := time.Now().UTC().AddDate(0, 0, -harnessWindowDays-30)

	h.ing.HandleEvent(historyBatch(conversation(chat.String(),
		webMsg(chat.String(), h.msgID("R0"), "de hace mucho", beyond, webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	if n := len(h.readEvents(t)); n != 1 {
		t.Errorf("the pairing push wrote %d row(s) beyond the window, want the 1 it carried", n)
	}
}

// A page nobody has bounded is dropped WHOLE and loudly: it is an answer to a
// request this plane would now refuse to make (the fill refuses
// `no_history_window`), and writing history nobody promised is worse than
// dropping it.
func TestAnUnboundedOnDemandPageIsDroppedWhole(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	chat := types.NewJID("5215550142", types.DefaultUserServer)
	h.allow(t, chat.String())
	if _, err := h.db.Exec("DELETE FROM history_windows WHERE twin_id = $1", h.stamp.TwinID); err != nil {
		t.Fatalf("removing the twin's history window: %v", err)
	}

	h.ing.HandleEvent(onDemandBatch(conversation(chat.String(),
		webMsg(chat.String(), h.msgID("N1"), "sin ventana", time.Now().UTC().AddDate(0, 0, -1), webMsgOpts{}),
	)))
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Errorf("an unbounded on-demand page wrote %d row(s), want 0 — fail-closed", n)
	}
	if !strings.Contains(logs.String(), "kind=on_demand_page reason=no_history_window") {
		t.Errorf("the drop was silent; log = %q", logs.String())
	}
	// The DIRECTORY row is still written: the chat exists whatever this plane
	// may write of its history, and forgetting it would retire the chat's
	// anchor over a config row somebody can add in a second.
	if dir := h.readDirectory(t); len(dir) != 1 {
		t.Errorf("an unbounded page left %d directory row(s), want 1", len(dir))
	}
}

// THE UNCACHED ALLOWLIST READ, PINNED (ticket #222 AC 4; ADR-0023: "a
// scope/pause change is confirmed to the rep only after the plane acknowledges
// the new version active (no TTL caching of guard rules)").
//
// The chat is admitted, its row is deleted the way the rep's scope-out act
// deletes it, and the NEXT message goes through the SAME live Ingestor. Nothing
// tells the plane and nothing restarts it: "instant descope is mechanically
// true rather than cache-dependent" is a property of this one read, and the
// only way to state it is a transition through one guard.
func TestDeletingTheAllowlistRowDropsTheChatsNextMessageAtTheSocket(t *testing.T) {
	h := newHarness(t)
	chat := types.NewJID("5215550150", types.DefaultUserServer)
	h.allow(t, chat.String())
	at := time.Now().UTC().Add(-time.Hour)

	h.ing.HandleEvent(textMessage(chat, chat, false, h.msgID("SC1"), at, "¿me aparta dos bultos?"))
	h.requireNoErrors(t)
	if n := len(h.readEvents(t)); n != 1 {
		t.Fatalf("an in-scope message: want 1 row, got %d", n)
	}

	// The rep's scope-out act, as `scopeChatOut` performs it on the other side
	// of the seam.
	if _, err := h.db.Exec(
		"DELETE FROM scope_allowlist WHERE twin_id = $1 AND chat_jid = $2", h.stamp.TwinID, chat.String(),
	); err != nil {
		t.Fatalf("descoping the chat: %v", err)
	}

	h.ing.HandleEvent(textMessage(chat, chat, false, h.msgID("SC2"), at.Add(time.Minute), "¿y el otro pedido?"))
	h.requireNoErrors(t)
	rows := h.readEvents(t)
	if len(rows) != 1 {
		t.Fatalf("the next message after a descope: want the 1 earlier row and no more, got %d", len(rows))
	}
	if want := chat.String() + ":" + h.msgID("SC1"); rows[0].externalEventID != want {
		t.Errorf("the row that stands is %q, want the one captured while the chat was in scope (%q)", rows[0].externalEventID, want)
	}
	// ...and the same for HISTORY, which passes the same guard: a page for a
	// descoped chat is dropped whole, so a fill in flight when the rep unmarks
	// a chat writes nothing more.
	h.ing.HandleEvent(onDemandBatch(conversation(chat.String(),
		webMsg(chat.String(), h.msgID("SC3"), "de la semana pasada", at.Add(-24*time.Hour), webMsgOpts{}),
	)))
	h.requireNoErrors(t)
	if n := len(h.readEvents(t)); n != 1 {
		t.Errorf("a page for a descoped chat wrote rows: %d, want the 1 earlier row and no more", n)
	}
	// The DIRECTORY row survives, and that is the amendment rather than a
	// leak: the chat still exists and the rep may scope it back in, which is
	// what the anchor is kept for.
	if dir := h.readDirectory(t); len(dir) != 1 {
		t.Errorf("descoping left %d directory row(s), want the chat's own to stand", len(dir))
	}
}

// THE LIVE FEED ADVANCES THE ANCHOR, IN SCOPE OR NOT (ticket #222, Codex r1).
//
// A live delivery is the plane's ONLY witness that anything happened in a chat
// it is not capturing. Without it a chat out of scope for a month keeps the
// anchor its pairing push left, and a scope-in a month later pages BACKWARDS
// from that: ninety days ending on pairing day, with the month the rep cares
// about a hole in the middle.
func TestALiveDeliveryAdvancesTheDirectoryForAnOutOfScopeChat(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	stranger := types.NewJID("5215550160", types.DefaultUserServer)
	lid := types.NewJID("161616161616161", types.HiddenUserServer)
	pairingDay := time.Now().UTC().AddDate(0, 0, -30)
	today := time.Now().UTC().Add(-time.Minute)

	// The pairing push knew the chat and left an anchor 30 days back.
	seed := conversation(stranger.String(),
		webMsg(stranger.String(), h.msgID("LV0"), "hace un mes", pairingDay, webMsgOpts{}),
	)
	seed.LidJID = proto.String(lid.String())
	h.ing.HandleEvent(historyBatch(seed))

	// ...and today a message arrives that the guard drops: the chat is not
	// scoped. The DIRECTORY still moves.
	live := textMessage(stranger, stranger, false, h.msgID("LV1"), today, "¿tiene cemento?")
	live.Info.PushName = "Don Beto"
	h.ing.HandleEvent(live)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("an out-of-scope live delivery persisted %d wa_events row(s), want 0 — content never leaves the plane (ADR-0023)", n)
	}
	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("want 1 directory row, got %d", len(dir))
	}
	row := dir[0]
	if row.anchorMessageID.String != h.msgID("LV1") {
		t.Errorf("anchor = %q, want today's delivery %q — a fill from the pairing-day anchor would leave a month-shaped hole",
			row.anchorMessageID.String, h.msgID("LV1"))
	}
	if !row.lastActivityAt.Valid || row.lastActivityAt.Time.UTC().Unix() != today.Unix() {
		t.Errorf("last_activity_at = %v, want today's delivery %v", row.lastActivityAt.Time.UTC(), today)
	}
	if got := h.openName(t, row); got != "Don Beto" {
		t.Errorf("sealed name opens to %q, want the counterparty's push name %q", got, "Don Beto")
	}
	if row.lidJID.String != lid.String() {
		t.Errorf("lid_jid = %q, want it kept as %q", row.lidJID.String, lid.String())
	}
	for _, forbidden := range []string{stranger.String(), stranger.User, "Don Beto", "¿tiene cemento?"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Errorf("the plane's log carries %q from a live delivery (ADR-0025)", forbidden)
		}
	}
}

// ...and the rep's OWN push name is never the chat's display name: on an
// own-sent delivery `PushName` is the rep's, and stamping it would put the rep
// on their own scoping page as the person they are talking to.
func TestAnOwnSentDeliveryDoesNotNameTheChatAfterTheRep(t *testing.T) {
	h := newHarness(t)
	customer := types.NewJID("5215550161", types.DefaultUserServer)
	at := time.Now().UTC().Add(-time.Minute)

	own := textMessage(customer, h.self, true, h.msgID("OS1"), at, "sí, se los aparto")
	own.Info.PushName = "Mauricio"
	h.ing.HandleEvent(own)
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("want 1 directory row, got %d", len(dir))
	}
	if got := h.openName(t, dir[0]); got != "" {
		t.Errorf("the chat's name opens to %q — an own-sent delivery carries the REP's push name, not the chat's", got)
	}
	// The anchor still moves: the rep's own message is a position in the chat.
	if dir[0].anchorMessageID.String != h.msgID("OS1") {
		t.Errorf("anchor = %q, want the own-sent delivery %q", dir[0].anchorMessageID.String, h.msgID("OS1"))
	}
}

// A GESTURE IS NOT AN ANCHOR on the live feed either: the request asks for the
// messages before a MESSAGE, and a reaction's own stanza id is not a position.
func TestALiveReactionDoesNotBecomeTheAnchor(t *testing.T) {
	h := newHarness(t)
	chat := types.NewJID("5215550162", types.DefaultUserServer)
	at := time.Now().UTC().Add(-2 * time.Minute)

	h.ing.HandleEvent(textMessage(chat, chat, false, h.msgID("RA1"), at, "¿cuánto el bulto?"))
	h.ing.HandleEvent(railDelivery(chat, chat, false, h.msgID("RA2"), at.Add(time.Minute),
		&waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
			Key:  &waCommon.MessageKey{ID: proto.String(h.msgID("RA1"))},
			Text: proto.String("👍"),
		}}))
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("want 1 directory row, got %d", len(dir))
	}
	if dir[0].anchorMessageID.String != h.msgID("RA1") {
		t.Errorf("anchor = %q, want the message %q rather than the gesture on it",
			dir[0].anchorMessageID.String, h.msgID("RA1"))
	}
}

// A ROW THAT KNOWS NO MORE THAN THE CALLER ANSWERS NOTHING (Codex r1). A chat
// the rail only ever addressed by LID keys its row on that LID, so the
// directory's own lookup would hand the LID back as if it were a phone number
// — and the resolution would STOP there rather than asking the library, which
// may have learned the PN since.
func TestALIDKeyedRowIsNotAPhoneNumberResolution(t *testing.T) {
	h := newHarness(t)
	lidOnly := types.NewJID("171717171717171", types.HiddenUserServer)
	at := time.Now().UTC().Add(-time.Minute)

	// A conversation the blob states nothing but a LID for: its directory row
	// keys on the LID and records the same value as its LID.
	h.ing.HandleEvent(historyBatch(conversation(lidOnly.String(),
		webMsg(lidOnly.String(), h.msgID("LO1"), "hola", at, webMsgOpts{}),
	)))
	h.requireNoErrors(t)
	dir := h.readDirectory(t)
	if len(dir) != 1 || dir[0].chatJID != lidOnly.String() || dir[0].lidJID.String != lidOnly.String() {
		t.Fatalf("want one row keyed on the LID with the LID as its own alternative, got %+v", dir)
	}

	pn, ok, err := h.dir.PNForLID(context.Background(), lidOnly)
	if err != nil {
		t.Fatalf("reading the directory's LID map: %v", err)
	}
	if ok {
		t.Errorf("the directory answered %q as this LID's phone number — a LID is not a resolution, and taking it as one stops the walk to the library", pn)
	}
}

// AN ORDINARY STATUS UPDATE MUST NOT KILL THE PLANE (ticket #222, Codex r2).
//
// whatsmeow's own standing JID for the status feed is `status@broadcast` — a
// user part that is a word, not digits — and live capture writes a directory
// row BEFORE it checks scope. An address CHECK that enumerated "digits and
// four servers" therefore turned every contact's status post into a refused
// INSERT reaching the guard's fail-stop, which is capture ending over traffic
// nobody scoped. Two fences now: the CHECK bounds the SHAPE rather than the
// vocabulary, and a directory refusal is reported without stopping the
// delivery.
func TestOrdinaryStatusAndNewsletterTrafficNeitherKillsThePlaneNorRests(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	at := time.Now().UTC().Add(-time.Minute)

	for _, c := range []struct {
		what string
		chat types.JID
		kind string
	}{
		{"the status feed", types.StatusBroadcastJID, "other"},
		{"a broadcast list", types.NewJID("1600000000", types.BroadcastServer), "other"},
		{"a newsletter", types.NewJID("120363000000000000", types.NewsletterServer), "other"},
		{"a legacy user address", types.NewJID("5215550170", types.LegacyUserServer), "other"},
		{"a hosted address", types.NewJID("5215550171", types.HostedServer), "other"},
	} {
		t.Run(c.what, func(t *testing.T) {
			h.ing.HandleEvent(textMessage(c.chat, c.chat, false, h.msgID("SB"+c.chat.User), at, "una actualización"))
			// NOT FATAL and not an error: the guard reports nothing at all here,
			// because the row went in.
			h.requireNoErrors(t)
		})
	}

	// Every one of them is a directory row the scoping page can hold...
	dir := h.readDirectory(t)
	if len(dir) != 5 {
		t.Fatalf("want a directory row per address form, got %d", len(dir))
	}
	for _, row := range dir {
		if row.kind != "other" {
			t.Errorf("%s kind = %q, want other — the rail's address space divides into four and these are the fourth", row.chatJID, row.kind)
		}
	}
	// ...and NONE of them rests as content: not one is on the allowlist.
	if n := h.countAllRows(t); n != 0 {
		t.Errorf("status and newsletter traffic persisted %d wa_events row(s), want 0 (ADR-0023)", n)
	}
	for _, forbidden := range []string{"una actualización", "status@broadcast", "120363000000000000"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Errorf("the plane's log carries %q (ADR-0025)", forbidden)
		}
	}
}

// A GROUP'S ROW IS NOT A MEMBER'S (ticket #222, Codex r2). whatsmeow fills
// `SenderAlt` from `participant_lid` on a group message, so reading it as the
// chat's alternative stored a MEMBER's LID on the group row — and the fill
// would then address the group's history request to that member's DM identity,
// carrying the group's anchor. `PushName` is the same mistake in the other
// column: it would overwrite the group's subject with whoever spoke last.
func TestAGroupDeliveryStoresNeitherTheSendersLIDNorTheirName(t *testing.T) {
	h := newHarness(t)
	group := types.NewJID("5215550180-1600000000", types.GroupServer)
	member := types.NewJID("5215550181", types.DefaultUserServer)
	memberLID := types.NewJID("181818181818181", types.HiddenUserServer)
	at := time.Now().UTC().Add(-time.Minute)

	delivery := textMessage(group, member, false, h.msgID("GR1"), at, "¿quién trae el hielo?")
	delivery.Info.SenderAlt = memberLID
	delivery.Info.PushName = "Beto del fut"
	h.ing.HandleEvent(delivery)
	h.requireNoErrors(t)

	dir := h.readDirectory(t)
	if len(dir) != 1 {
		t.Fatalf("want the group's own directory row, got %d", len(dir))
	}
	row := dir[0]
	if row.chatJID != group.String() || row.kind != "group" {
		t.Fatalf("row = %q/%q, want the group and kind group", row.chatJID, row.kind)
	}
	if row.lidJID.Valid {
		t.Errorf("the group's lid_jid = %q — that is a MEMBER's identity, and a fill would send the group's request to their DM",
			row.lidJID.String)
	}
	if got := h.openName(t, row); got != "" {
		t.Errorf("the group's name opens to %q — that is the member who spoke, not the group's subject", got)
	}
	// The anchor is still the group's own: a member's message IS a position in
	// the group's history.
	if row.anchorMessageID.String != h.msgID("GR1") {
		t.Errorf("anchor = %q, want the group delivery %q", row.anchorMessageID.String, h.msgID("GR1"))
	}
}

// A DIRECTORY REFUSAL IS REPORTED AND NEVER FATAL, ON EVERY FEED (ticket
// #222).
//
// The invariant is one sentence and it has to be true of all four, because the
// consequence of its being false anywhere is the same: a plane that dies on a
// metadata row stops capturing CONTENT. Four feeds write the row, so there are
// four plants — one per feed, each proving the plane keeps capturing and the
// next in-scope row still lands.
//
// THE PLANT IS A REAL CHECK VIOLATION at the real store rather than a stubbed
// error: the seam is the agreed boundary (ADR-0028), and an identity carrying a
// space is what an address fence exists to refuse.
func TestADirectoryRefusalIsReportedAndNeverFatalOnEveryFeed(t *testing.T) {
	refusedChat := types.JID{User: "in valid", Server: types.DefaultUserServer}
	at := time.Now().UTC().Add(-time.Minute)

	for _, c := range []struct {
		feed  string
		plant func(t *testing.T, h *harness)
	}{
		{
			feed: "live",
			plant: func(_ *testing.T, h *harness) {
				h.ing.HandleEvent(textMessage(refusedChat, refusedChat, false, h.msgID("RF1"), at, "hola"))
			},
		},
		{
			feed: "history",
			plant: func(_ *testing.T, h *harness) {
				h.ing.HandleEvent(historyBatch(conversation(refusedChat.String(),
					webMsg(refusedChat.String(), h.msgID("RF2"), "hola", at, webMsgOpts{}),
				)))
			},
		},
		{
			feed: "contact",
			plant: func(_ *testing.T, h *harness) {
				h.ing.HandleEvent(&events.Contact{
					JID:    refusedChat,
					Action: &waSyncAction.ContactAction{FullName: proto.String("Doña Lupita")},
				})
			},
		},
		{
			feed: "push name",
			plant: func(_ *testing.T, h *harness) {
				h.ing.HandleEvent(&events.PushName{JID: refusedChat, NewPushName: "Don Beto"})
			},
		},
	} {
		t.Run(c.feed, func(t *testing.T) {
			h := newHarness(t)
			logs := captureLog(t)
			customer := types.NewJID("5215550190", types.DefaultUserServer)
			h.allow(t, customer.String())

			c.plant(t, h)
			// NEVER FATAL: nothing reaches OnError, which is `log.Fatalf` in the
			// binary.
			h.requireNoErrors(t)
			// ...BUT REPORTED, content-free, naming the feed and nothing else.
			if want := "chat directory refused: feed=" + c.feed; !strings.Contains(logs.String(), want) {
				t.Errorf("the refusal was silent; want a line containing %q, log = %q", want, logs.String())
			}
			for _, forbidden := range []string{refusedChat.User, "Failing row", "Doña Lupita", "Don Beto", "hola"} {
				if strings.Contains(logs.String(), forbidden) {
					t.Errorf("the refusal line carries %q — PostgreSQL states a CHECK violation with the failing row, which is the identity (ADR-0025)", forbidden)
				}
			}
			// ...AND CAPTURE GOES ON: the next in-scope delivery still lands.
			h.ing.HandleEvent(textMessage(customer, customer, false, h.msgID("OK1"), at.Add(time.Minute), "¿me aparta dos?"))
			h.requireNoErrors(t)
			rows := h.readEvents(t)
			if len(rows) != 1 {
				t.Fatalf("after a refused directory row on the %s feed: want the next in-scope delivery captured, got %d row(s)", c.feed, len(rows))
			}
			if want := customer.String() + ":" + h.msgID("OK1"); rows[0].externalEventID != want {
				t.Errorf("external_event_id = %q, want %q", rows[0].externalEventID, want)
			}
		})
	}
}

// ...and a SEALING failure stays fatal, which is the other half of the one
// sentence: the plane's custody is broken (ADR-0008), not one row's shape.
func TestASealingFailureOnTheNameFeedsStaysFatal(t *testing.T) {
	h := newHarness(t)
	// A sealer whose key is not the harness's cannot be built with a short key,
	// so the failure is provoked where it is reachable: an ingestor wired with
	// no directory at all, which is the wiring failure the same path reports
	// through OnError rather than swallowing.
	var errs []error
	ing := ingest.New(ingest.Config{
		DB:      h.db,
		Sealer:  mustSealer(t, h.key),
		Stamp:   h.stamp,
		Self:    fixedSelf{jid: h.self, lid: h.selfLID},
		Window:  historywindow.New(h.db, h.stamp.TwinID),
		OnError: func(err error) { errs = append(errs, err) },
	})

	ing.HandleEvent(&events.PushName{
		JID:         types.NewJID("5215550191", types.DefaultUserServer),
		NewPushName: "Don Beto",
	})
	if len(errs) != 1 {
		t.Fatalf("a name feed with no directory wired reported %d error(s), want 1 — that is a wiring failure, not a refusal", len(errs))
	}
	if strings.Contains(errs[0].Error(), "Don Beto") {
		t.Errorf("the error carries the name: %q", errs[0].Error())
	}
}

// A LOCKED DIRECTORY DOES NOT COST THE DELIVERY ITS CAPTURE (ticket #222,
// Codex r3).
//
// THE FAILURE THIS REFUSES. The directory is written BEFORE the guard decides,
// on every feed. Under one shared budget, a lock on that one table spent the
// whole of it: the write was reported non-fatally — and then the healthy
// allowlist read, and the seam write behind it, failed on an expired context.
// A metadata row starving the CONTENT decision, through OnError, which the
// binary fail-stops on. `directoryBudget` caps the write so what follows keeps
// what the cap leaves.
//
// THE LOCK IS REAL, and it is the only honest way to make a write slow: no
// stub, no injected sleep, the seam itself (ADR-0028). ACCESS EXCLUSIVE is
// what an upsert waits behind.
func TestALockedChatDirectoryStillLetsTheDeliveryBeCaptured(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	customer := types.NewJID("5215550077", types.DefaultUserServer)
	h.allow(t, customer.String())
	at := time.Now().UTC().Add(-time.Minute)

	// A second connection holds the table while the delivery runs. The
	// transaction is rolled back either way, so the lock outlives the write's
	// cap and nothing else.
	locker, err := h.db.Begin()
	if err != nil {
		t.Fatalf("opening the locking transaction: %v", err)
	}
	if _, err := locker.Exec("LOCK TABLE chat_directory IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatalf("locking chat_directory: %v", err)
	}
	released := false
	defer func() {
		if !released {
			_ = locker.Rollback()
		}
	}()

	started := time.Now()
	h.ing.HandleEvent(textMessage(customer, customer, false, h.msgID("LK1"), at, "hola"))
	elapsed := time.Since(started)

	released = true
	if err := locker.Rollback(); err != nil {
		t.Fatalf("releasing the lock: %v", err)
	}

	// THE CONTENT LANDED. This is the assertion the defect broke: the guard
	// read and the seam write ran on a budget the metadata write could not
	// spend.
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 1 {
		t.Errorf("wa_events rows = %d, want 1 — the in-scope delivery was captured", n)
	}
	// And the metadata write gave up rather than waiting out the event.
	if !strings.Contains(logs.String(), "chat directory refused: feed=live") {
		t.Errorf("no content-free refusal line for the capped write; log was:\n%s", logs.String())
	}
	if rows := h.readDirectory(t); len(rows) != 0 {
		t.Errorf("directory rows = %d, want none — the write never got the lock", len(rows))
	}
	// The cap is three seconds and the event's budget is fifteen: a delivery
	// that took the whole event budget is the defect, not a slow machine.
	if elapsed > 10*time.Second {
		t.Errorf("the delivery took %s — the metadata write was not capped", elapsed)
	}
	if strings.Contains(logs.String(), customer.String()) {
		t.Errorf("the refusal line names the chat; log was:\n%s", logs.String())
	}
}

// A CHAT SCOPED UNDER ITS LID STAYS IN SCOPE WHEN THE RAIL LEARNS ITS PHONE
// NUMBER (ticket #222, Codex r3).
//
// THE FAILURE THIS REFUSES, in the order it happens. A modern DM whose phone
// number nothing has yet stated is known by its LID alone — so that is the
// identity the directory holds, the identity a dashboard shows, and therefore
// the identity the rep's scope-in writes to the allowlist. The day the rail
// states the PN, canonicalization starts answering with the PN, a one-name
// allowlist read misses, and EVERY message of a chat the rep scoped in is
// dropped at the socket. Silently: nothing looks wrong from the guard's side,
// and the ninety-day fill would meanwhile ask under the LID it still finds
// allowed and report `served` over pages the guard threw away.
func TestAChatScopedByLIDSurvivesLearningItsPhoneNumber(t *testing.T) {
	h := newHarness(t)
	lid := types.NewJID("222222222222222", types.HiddenUserServer)
	pn := types.NewJID("5215550088", types.DefaultUserServer)
	at := time.Now().UTC().Add(-2 * time.Minute)

	// BEFORE: nothing states a phone number, so the chat is its LID and the
	// rep scopes THAT in.
	h.ing.HandleEvent(textMessage(lid, lid, false, h.msgID("LP1"), at, "hola"))
	h.requireNoErrors(t)
	h.allow(t, lid.String())

	if n := h.countAllRows(t); n != 0 {
		t.Fatalf("wa_events rows = %d, want 0 — the first delivery arrived before the scope-in", n)
	}

	// The LID-keyed delivery is captured under the identity the rep allowed.
	h.ing.HandleEvent(textMessage(lid, lid, false, h.msgID("LP2"), at.Add(time.Minute), "¿tienen?"))
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 1 {
		t.Fatalf("wa_events rows = %d, want 1 — a LID-scoped chat is in scope", n)
	}

	// AFTER: one delivery states the PN alternative, which is all it takes —
	// the directory now pairs the two identities and canonicalization answers
	// with the PN.
	stated := textMessage(lid, lid, false, h.msgID("LP3"), at.Add(2*time.Minute), "mándame precio")
	stated.Info.SenderAlt = pn
	h.ing.HandleEvent(stated)
	h.requireNoErrors(t)

	if n := h.countAllRows(t); n != 2 {
		t.Errorf("wa_events rows = %d, want 2 — learning the phone number must not un-scope the chat", n)
	}
	// And the rows the guard admits are the ones the rep scoped: a fourth
	// delivery under the PN alone (the shape every later one takes) still
	// lands.
	h.ing.HandleEvent(textMessage(pn, pn, false, h.msgID("LP4"), at.Add(3*time.Minute), "gracias"))
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 3 {
		t.Errorf("wa_events rows = %d, want 3 — the PN form of a LID-scoped chat is the same chat", n)
	}

	// A chat NOBODY scoped is still dropped, in either form: the widened read
	// spends the directory's pairing, it does not admit strangers.
	other := types.NewJID("5215550099", types.DefaultUserServer)
	otherLID := types.NewJID("333333333333333", types.HiddenUserServer)
	unscoped := textMessage(otherLID, otherLID, false, h.msgID("LP5"), at.Add(4*time.Minute), "hola")
	unscoped.Info.SenderAlt = other
	h.ing.HandleEvent(unscoped)
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 3 {
		t.Errorf("wa_events rows = %d, want 3 — an unscoped chat's two identities are both out of scope", n)
	}
}

// AND WHEN THE DIRECTORY CANNOT BE READ, THE GUARD STILL DECIDES — on the
// delivered identity alone, loudly, never by fail-stopping (ticket #222, Codex
// r3).
//
// This is the price `pairedIdentity` names out loud, asserted rather than
// asserted-away: a chat scoped under its LID whose delivery arrives under its
// PN is DROPPED while the metadata table is locked. The alternative was making
// capture depend on that table, where an `ALTER TABLE` would end it.
func TestALockedDirectoryDecidesScopeOnTheDeliveredIdentityAlone(t *testing.T) {
	h := newHarness(t)
	logs := captureLog(t)
	lid := types.NewJID("444444444444444", types.HiddenUserServer)
	pn := types.NewJID("5215550066", types.DefaultUserServer)
	at := time.Now().UTC().Add(-3 * time.Minute)

	// The chat is known by both names and scoped under the LID.
	stating := textMessage(lid, lid, false, h.msgID("PU1"), at, "hola")
	stating.Info.SenderAlt = pn
	h.ing.HandleEvent(stating)
	h.requireNoErrors(t)
	h.allow(t, lid.String())

	locker, err := h.db.Begin()
	if err != nil {
		t.Fatalf("opening the locking transaction: %v", err)
	}
	if _, err := locker.Exec("LOCK TABLE chat_directory IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatalf("locking chat_directory: %v", err)
	}
	h.ing.HandleEvent(textMessage(pn, pn, false, h.msgID("PU2"), at.Add(time.Minute), "¿precio?"))
	if err := locker.Rollback(); err != nil {
		t.Fatalf("releasing the lock: %v", err)
	}

	// NOT A FAIL-STOP: no error reached OnError, so the plane is still running.
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 0 {
		t.Errorf("wa_events rows = %d, want 0 — the pairing could not be read, so the one-name decision stood", n)
	}
	if !strings.Contains(logs.String(), "capture guard: the chat directory did not answer") {
		t.Errorf("no content-free line for the unanswered pairing; log was:\n%s", logs.String())
	}
	for _, forbidden := range []string{lid.String(), pn.String(), "¿precio?"} {
		if strings.Contains(logs.String(), forbidden) {
			t.Errorf("the log carries %q; log was:\n%s", forbidden, logs.String())
		}
	}

	// And once the lock is gone the same delivery lands, which is what makes
	// the drop a degradation rather than a broken rule.
	h.ing.HandleEvent(textMessage(pn, pn, false, h.msgID("PU3"), at.Add(2*time.Minute), "¿precio?"))
	h.requireNoErrors(t)
	if n := h.countAllRows(t); n != 1 {
		t.Errorf("wa_events rows = %d, want 1 — with the directory readable the chat is in scope under either name", n)
	}
}

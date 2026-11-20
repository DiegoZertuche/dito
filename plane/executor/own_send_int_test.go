package executor_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/executor"
	"github.com/Dito-Core/dito/plane/ingest"
)

// Ticket #63 — THE TWIN COULD NOT SEE WHAT IT SAID.
//
// WhatsApp syncs a rep's outgoing messages to their OTHER linked devices.
// The plane is the device that sent them, so its own sends never echo back
// through ingest, and nothing else wrote them down: three `customer_send`s
// went out at the #57 rig session and the twin's record of that chat held
// only the customer's side. Extraction filed zero facts from a conversation
// that plainly contained a commitment — correctly, because three of the
// four fact types are things the REP commits.
//
// The seam is the same one every slice tests at: `send_commands` rows go in
// as the writer mints them, the executor runs against a stubbed socket, and
// the assertions read `wa_events` — twin memory's one inbound door — from
// the other side. Nothing reaches into the executor or the guard.

// ownSendHarness is the executor plus the capture component it records
// through, sharing one DEK so a test can open what was written.
type ownSendHarness struct {
	db      *sql.DB
	exec    *executor.Executor
	sender  *stubSender
	sealer  *ingest.Sealer
	key     []byte
	ing     *ingest.Ingestor
	twinID  string
	self    types.JID
	selfLID types.JID
	errors  *[]error
}

// ownSendSelf is the live-session identity for both halves: the executor
// addresses by it and the guard decides scope by it (ADR-0006/0023). The
// plane's own `rail.Rail` satisfies both interfaces in the binary.
type ownSendSelf struct {
	jid types.JID
	lid types.JID
}

func (s ownSendSelf) SelfJID() (types.JID, bool) { return s.jid, true }
func (s ownSendSelf) SelfLID() (types.JID, bool) { return s.lid, !s.lid.IsEmpty() }

func newOwnSendHarness(t *testing.T, messageID string) *ownSendHarness {
	t.Helper()
	db := seamDB(t)
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generating DEK material: %v", err)
	}
	sealer, err := ingest.NewSealer(key)
	if err != nil {
		t.Fatalf("constructing sealer: %v", err)
	}
	twinID := uuid.NewString()
	self := types.NewJID("5215599999999", types.DefaultUserServer)
	// The account's hidden-user identity. Both halves of the harness read it,
	// as the binary's rail.Rail supplies it to both.
	selfLID := types.NewJID("999888777666555", types.HiddenUserServer)
	var errs []error
	ing := ingest.New(ingest.Config{
		DB:        db,
		Sealer:    sealer,
		Stamp:     ingest.Stamp{CompanyID: uuid.NewString(), SeatID: uuid.NewString(), TwinID: twinID},
		Self:      ownSendSelf{jid: self, lid: selfLID},
		Directory: directory.New(db, twinID),
		OnError:   func(err error) { errs = append(errs, err) },
	})
	sender := &stubSender{resp: whatsmeow.SendResponse{
		ID:        types.MessageID(messageID),
		Timestamp: time.Date(2026, 8, 29, 20, 46, 1, 0, time.UTC),
	}}
	exec := executor.New(executor.Config{
		DB:      db,
		Sender:  sender,
		Self:    ownSendSelf{jid: self, lid: selfLID},
		Opener:  sealer,
		Capture: ing,
		TwinID:  twinID,
	})
	return &ownSendHarness{
		db: db, exec: exec, sender: sender, sealer: sealer, key: key,
		ing: ing, twinID: twinID, self: self, selfLID: selfLID, errors: &errs,
	}
}

func (h *ownSendHarness) allow(t *testing.T, chatJID string) {
	t.Helper()
	if _, err := h.db.Exec(
		"INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
		h.twinID, chatJID,
	); err != nil {
		t.Fatalf("seeding scope_allowlist: %v", err)
	}
}

type capturedEvent struct {
	externalEventID string
	occurredAt      time.Time
	payload         map[string]any
}

// captured reads twin memory's inbound door for one chat and opens every
// envelope under the twin DEK — proving the content rests encrypted
// (ADR-0008) and that what landed is the pinned v1 contract the runtime
// reads. Scoped by the chat prefix of the seam id, which is exactly how the
// extraction pass reads a chat's window.
func (h *ownSendHarness) captured(t *testing.T, chatJID string) []capturedEvent {
	t.Helper()
	rows, err := h.db.Query(
		`SELECT external_event_id, occurred_at, payload_enc
		   FROM wa_events
		  WHERE twin_id = $1
		    AND left(external_event_id, length($2::text) + 1) = $2 || ':'
		  ORDER BY id`,
		h.twinID, chatJID,
	)
	if err != nil {
		t.Fatalf("reading wa_events: %v", err)
	}
	defer rows.Close()
	var out []capturedEvent
	for rows.Next() {
		var row capturedEvent
		var enc []byte
		if err := rows.Scan(&row.externalEventID, &row.occurredAt, &enc); err != nil {
			t.Fatalf("scanning wa_events row: %v", err)
		}
		plain, err := ingest.OpenEnvelope(h.key, enc)
		if err != nil {
			t.Fatalf("payload_enc does not open under the twin DEK: %v", err)
		}
		if err := json.Unmarshal(plain, &row.payload); err != nil {
			t.Fatalf("payload is not the pinned JSON contract: %v", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading wa_events: %v", err)
	}
	return out
}

func (h *ownSendHarness) requireNoIngestErrors(t *testing.T) {
	t.Helper()
	for _, err := range *h.errors {
		t.Errorf("capture error: %v", err)
	}
}

// AC 1 (ticket #63): a customer_send the executor delivers appears in twin
// memory as a from_me message on the destination chat, carrying the rail's
// own wa_message_id, the canonical chat identity the chat's inbound rows
// already use, and the send's real instant.
func TestCustomerSendEntersTwinMemoryAsAnOwnSentCapture(t *testing.T) {
	h := newOwnSendHarness(t, "3EB0D51776BD2EF9DA4DAF")
	customer := "5215511111111@s.whatsapp.net"
	h.allow(t, customer)

	draftID := insertDraft(t, h.db, h.twinID, customer, seal(t, h.sealer, "Se lo dejo en $8,400 y se lo mando el sábado."))
	insertTappedCustomerSend(t, h.db, h.twinID, draftID, customer)

	if err := h.exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	h.requireNoIngestErrors(t)

	events := h.captured(t, customer)
	if len(events) != 1 {
		t.Fatalf("want exactly 1 wa_events row for the delivered customer_send, got %d — the twin cannot see what it said (#63)", len(events))
	}
	got := events[0]
	// The rail's own id, composed into the seam id exactly as ingest
	// composes an inbound one: <canonical chat>:<message id>. That identity
	// is what makes a real echo dedupe rather than duplicate.
	if want := customer + ":3EB0D51776BD2EF9DA4DAF"; got.externalEventID != want {
		t.Errorf("external_event_id = %q, want %q", got.externalEventID, want)
	}
	if got.payload["from_me"] != true {
		t.Errorf("from_me = %v, want true — the twin sent this", got.payload["from_me"])
	}
	if got.payload["chat_jid"] != customer {
		t.Errorf("chat_jid = %v, want the destination chat %q", got.payload["chat_jid"], customer)
	}
	if got.payload["sender_jid"] != h.self.String() {
		t.Errorf("sender_jid = %v, want the live self %q", got.payload["sender_jid"], h.self.String())
	}
	if got.payload["message_id"] != "3EB0D51776BD2EF9DA4DAF" {
		t.Errorf("message_id = %v, want the rail's own id", got.payload["message_id"])
	}
	if got.payload["text"] != "Se lo dejo en $8,400 y se lo mando el sábado." {
		t.Errorf("text = %v, want the body that actually went to the customer", got.payload["text"])
	}
	if want := time.Date(2026, 8, 29, 20, 46, 1, 0, time.UTC); !got.occurredAt.Equal(want) {
		t.Errorf("occurred_at = %s, want the rail's send instant %s", got.occurredAt, want)
	}
}

// echoOfOwnSend is the delivery WhatsApp would make if it ever did sync this
// plane's own send back to it — a re-link, a rail change, or a whatsmeow
// that starts looping own-sends to the sending device.
func echoOfOwnSend(chat, self types.JID, messageID, text string, at time.Time) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				Chat:         chat,
				Sender:       self,
				IsFromMe:     true,
				RecipientAlt: chat,
			},
			ID:        messageID,
			Timestamp: at,
		},
		Message: &waE2E.Message{Conversation: proto.String(text)},
	}
}

// AC 2 (ticket #63): idempotent against a real echo. The write-back composes
// the seam id from the same canonical chat and the same rail message id an
// inbound delivery would, so the existing (source, external_event_id) dedupe
// collapses the two to ONE row — proven with the echo arriving AFTER the
// write, which is the order that actually happens.
func TestARealEchoAfterTheWriteBackCollapsesToOneRow(t *testing.T) {
	h := newOwnSendHarness(t, "3EB0ECHO0001")
	customer := "5215511111111@s.whatsapp.net"
	h.allow(t, customer)
	body := "Va, se lo mando el sábado."

	draftID := insertDraft(t, h.db, h.twinID, customer, seal(t, h.sealer, body))
	insertTappedCustomerSend(t, h.db, h.twinID, draftID, customer)
	if err := h.exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n := len(h.captured(t, customer)); n != 1 {
		t.Fatalf("after the send: %d row(s), want 1", n)
	}

	// ...and now WhatsApp delivers it back.
	h.ing.HandleEvent(echoOfOwnSend(
		types.NewJID("5215511111111", types.DefaultUserServer),
		h.self,
		"3EB0ECHO0001",
		body,
		time.Date(2026, 8, 29, 20, 46, 3, 0, time.UTC),
	))
	h.requireNoIngestErrors(t)

	events := h.captured(t, customer)
	if len(events) != 1 {
		t.Fatalf("the echo produced %d row(s), want 1 — the seam dedupe must collapse it (AC 2)", len(events))
	}
	// The FIRST write wins, as ON CONFLICT DO NOTHING means: the row keeps
	// the send's own instant, not the echo's.
	if want := time.Date(2026, 8, 29, 20, 46, 1, 0, time.UTC); !events[0].occurredAt.Equal(want) {
		t.Errorf("occurred_at = %s, want the send's instant %s (first write wins)", events[0].occurredAt, want)
	}
}

// AC 4 (ticket #63): the capture guard's property still holds — nothing
// enters twin memory that the guard would not have admitted.
//
// `scope_allowlist` and `send_allowlist` are DIFFERENT LISTS and they can
// disagree: send_allowlist answers "may this twin send here" (ADR-0017),
// scope_allowlist answers "may this twin remember this chat" (ADR-0023). A
// write-back is a capture, so the CAPTURE list governs it. Here a chat the
// rep has descoped still has a tapped draft in flight: the send goes (it was
// authorized by a real tap), and nothing is remembered — exactly what would
// have happened had the rep typed it on their phone.
func TestOwnSendToAnOutOfScopeChatIsSentAndNeverRemembered(t *testing.T) {
	h := newOwnSendHarness(t, "3EB0OUTOFSCOPE")
	customer := "5215522222222@s.whatsapp.net"
	// No scope_allowlist row: the guard would have dropped this chat's
	// inbound, so it must drop this chat's own-sent too.

	draftID := insertDraft(t, h.db, h.twinID, customer, seal(t, h.sealer, "quedamos el jueves"))
	commandID := insertTappedCustomerSend(t, h.db, h.twinID, draftID, customer)

	if err := h.exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(h.sender.sent) != 1 {
		t.Fatalf("want the send to happen anyway (the tap authorized it), got %d", len(h.sender.sent))
	}
	outcome, _ := commandState(t, h.db, commandID)
	if !outcome.Valid || outcome.String != "sent" {
		t.Errorf("outcome = %v, want sent — an unremembered send is still a send", outcome)
	}
	if n := len(h.captured(t, customer)); n != 0 {
		t.Errorf("an out-of-scope chat produced %d wa_events row(s), want 0 — the capture guard governs the write-back (ADR-0023)", n)
	}
	// The execution evidence is unaffected: the mapping is send bookkeeping,
	// not twin memory.
	var recorded string
	if err := h.db.QueryRow("SELECT wa_message_id FROM send_executions WHERE command_id = $1", commandID).Scan(&recorded); err != nil {
		t.Fatalf("reading send_executions: %v", err)
	}
	if recorded != "3EB0OUTOFSCOPE" {
		t.Errorf("send_executions wa_message_id = %q, want the rail's id", recorded)
	}
}

// AC 6 (ticket #63), the DECISION: the twin's own posts do NOT enter twin
// memory. A system_send is recorded as an execution and nothing else.
//
// The reasoning lives on `finalizeSent`. In short: nothing needs them (the
// twin thread is excluded from extraction by construction under ADR-0033,
// and every post is already a durable rep-side row), they would compete with
// real content in the bundle's retrieval, and the twin thread is the one
// chat where twin-authored text is input grammar. This test is what makes
// that a decision rather than a gap — flipping it fails HERE.
func TestSystemSendIsRecordedAsAnExecutionAndNeverEntersTwinMemory(t *testing.T) {
	h := newOwnSendHarness(t, "3EB0SYSPOST01")
	// The twin thread is always in scope (ADR-0023) — so if the write-back
	// were class-blind, this WOULD land. It must not.
	draftID := insertDraft(t, h.db, h.twinID, "5215511111111@s.whatsapp.net", seal(t, h.sealer, "cuerpo"))
	commandID := insertSystemSend(t, h.db, h.twinID, h.self.String(), draftID)

	if err := h.exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(h.sender.sent) != 1 {
		t.Fatalf("want exactly 1 post, got %d", len(h.sender.sent))
	}
	if n := len(h.captured(t, h.self.String())); n != 0 {
		t.Errorf("the twin's own post produced %d wa_events row(s), want 0 — system_send write-back is deliberately not built (#63 AC 6)", n)
	}
	var recorded string
	if err := h.db.QueryRow("SELECT wa_message_id FROM send_executions WHERE command_id = $1", commandID).Scan(&recorded); err != nil {
		t.Fatalf("reading send_executions: %v", err)
	}
	if recorded != "3EB0SYSPOST01" {
		t.Errorf("send_executions wa_message_id = %q, want the rail's id — the mapping the twin-post registry reads", recorded)
	}
}

// ADR-0006's class boundary, in BOTH spellings of self (Codex r1 on #63).
// The account has two identities — its phone number and its hidden-user
// (LID) identity — with different user components, so a customer_send whose
// frozen destination is the rep's own LID slipped past a PN-only comparison.
// It is seam corruption either way, and since #63 it would also write the
// customer-bound body into the twin thread's own memory: the very surface
// the feedback-loop rule protects. Refused before the socket, loudly.
func TestCustomerSendToTheSelfLIDIsRefused(t *testing.T) {
	h := newOwnSendHarness(t, "3EB0SELFLID")
	poisoned := h.selfLID.String()
	h.allow(t, poisoned)

	draftID := insertDraft(t, h.db, h.twinID, poisoned, seal(t, h.sealer, "esto nunca debe salir"))
	commandID := insertTappedCustomerSend(t, h.db, h.twinID, draftID, poisoned)

	if err := h.exec.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce succeeded over a customer_send addressed to the live self LID — must refuse (ADR-0006)")
	}
	if len(h.sender.sent) != 0 {
		t.Errorf("socket touched %d time(s) for a self-LID-addressed customer_send", len(h.sender.sent))
	}
	outcome, _ := commandState(t, h.db, commandID)
	if outcome.Valid {
		t.Errorf("outcome = %v, want unfinalized — a refused class violation is not a send outcome", outcome)
	}
	if n := len(h.captured(t, poisoned)); n != 0 {
		t.Errorf("the refused send left %d wa_events row(s), want 0", n)
	}
	// ...and nothing landed under the self-chat identity either, which is
	// where the LID canonicalizes once the guard sees it.
	if n := len(h.captured(t, h.self.String())); n != 0 {
		t.Errorf("the refused send left %d wa_events row(s) in the twin thread, want 0", n)
	}
}

// A plane wired without a recorder must not deliver a customer_send and
// leave no trace of it: that is the #63 defect, silently restored. It
// fail-stops BEFORE the socket — nothing is sent, no claim is spent, and the
// command is not finalized, so nothing pretends the send was accounted for.
func TestCustomerSendWithoutAnOwnSendRecorderIsLoudAndUnfinalized(t *testing.T) {
	h := newOwnSendHarness(t, "3EB0NORECORDER")
	customer := "5215533333333@s.whatsapp.net"
	h.allow(t, customer)
	unwired := executor.New(executor.Config{
		DB:     h.db,
		Sender: h.sender,
		Self:   ownSendSelf{jid: h.self},
		Opener: h.sealer,
		TwinID: h.twinID,
	})

	draftID := insertDraft(t, h.db, h.twinID, customer, seal(t, h.sealer, "hola"))
	commandID := insertTappedCustomerSend(t, h.db, h.twinID, draftID, customer)

	if err := unwired.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce succeeded with no own-send recorder wired — must refuse loudly (#63)")
	}
	if len(h.sender.sent) != 0 {
		t.Errorf("socket touched %d time(s) — a customer_send this plane cannot remember is one it does not send", len(h.sender.sent))
	}
	outcome, _ := commandState(t, h.db, commandID)
	if outcome.Valid {
		t.Errorf("outcome = %v, want unfinalized — the refusal must not record an outcome", outcome)
	}
	var claims int
	if err := h.db.QueryRow("SELECT count(*) FROM send_attempts WHERE command_id = $1", commandID).Scan(&claims); err != nil {
		t.Fatalf("counting claims: %v", err)
	}
	if claims != 0 {
		t.Errorf("the refusal spent %d claim(s) — a claim it never used would strand the command as held", claims)
	}
}

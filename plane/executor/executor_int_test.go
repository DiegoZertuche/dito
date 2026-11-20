package executor_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/executor"
	"github.com/Dito-Core/dito/plane/ingest"
	"github.com/Dito-Core/dito/plane/internal/testdb"
)

// The Postgres seam is the pre-agreed test seam (spec #18): send_commands
// rows go in exactly as the twin-runtime's writers mint them, and the
// assertions read what the executor did — the stubbed socket's recorded
// sends, the finalized outcome, and the send_executions evidence — from
// the other side. The socket is the one stub (spec #18 testing decisions:
// "executor semantics against a stubbed socket"); Postgres and the
// envelope crypto are real (ADR-0028).

func seamDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	resetSeam(t, db)
	return db
}

// resetSeam empties the seam before a test.
//
// Driven by the catalog, never a hand-kept list — the mirror image of the
// fix ticket #50 made to the TS harness for the same reason. The list went
// stale the moment a migration added a table: `disclosure_lines` arrived
// with the aperture, references `wa_events`, and was never named here, so a
// database carrying a crossing corpus failed every test in this file on a
// foreign key rather than resetting.
//
// One TRUNCATE naming every table settles the delete ORDER by construction
// too (the old loop's order was itself a hand-kept dependency claim), and
// the user triggers come off around it because several of these tables are
// deliberately append-only (ADR-0034) and refuse TRUNCATE outright.
//
// `public` only: `ledger` is company-owned and the plane has no business
// there, `whatsmeow` is the library's own store (#22), and Atlas's revision
// history is what lets the next Migrate be a no-op.
func resetSeam(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query(`
		SELECT tablename FROM pg_tables
		 WHERE schemaname = 'public' AND tablename <> 'atlas_schema_revisions'
		 ORDER BY tablename`)
	if err != nil {
		t.Fatalf("enumerating seam tables: %v", err)
	}
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatalf("reading seam table name: %v", err)
		}
		tables = append(tables, pgx.Identifier{table}.Sanitize())
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("enumerating seam tables: %v", err)
	}
	if len(tables) == 0 {
		t.Fatal("no seam tables found — the migrations did not apply")
	}
	for _, table := range tables {
		if _, err := db.Exec("ALTER TABLE " + table + " DISABLE TRIGGER USER"); err != nil {
			t.Fatalf("disabling triggers to reset %s: %v", table, err)
		}
	}
	// One statement over every table: TRUNCATE resolves the foreign-key
	// order itself, which the old per-table DELETE loop could only do by
	// hand-keeping it.
	if _, err := db.Exec("TRUNCATE " + strings.Join(tables, ", ") + " CASCADE"); err != nil {
		t.Fatalf("resetting the seam: %v", err)
	}
	for _, table := range tables {
		if _, err := db.Exec("ALTER TABLE " + table + " ENABLE TRIGGER USER"); err != nil {
			t.Fatalf("re-enabling triggers on %s: %v", table, err)
		}
	}
}

// liveSelf is the live-session identity stub: the executor must address
// system_send by THIS identity, never by anything in the database.
type liveSelf struct {
	jid types.JID
	lid types.JID
	ok  bool
}

func (s liveSelf) SelfJID() (types.JID, bool) { return s.jid, s.ok }

// SelfLID is the account's hidden-user identity, when the session has one.
// customer_send refuses BOTH spellings of self (ADR-0006; Codex r1 on #63).
func (s liveSelf) SelfLID() (types.JID, bool) { return s.lid, s.ok && !s.lid.IsEmpty() }

type sentMessage struct {
	to      types.JID
	message *waE2E.Message
}

// stubSender records sends and answers from a script — the one stub in
// these tests.
type stubSender struct {
	sent []sentMessage
	resp whatsmeow.SendResponse
	err  error
}

func (s *stubSender) SendMessage(ctx context.Context, to types.JID, message *waE2E.Message, extra ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error) {
	s.sent = append(s.sent, sentMessage{to: to, message: message})
	return s.resp, s.err
}

func newSealer(t *testing.T) *ingest.Sealer {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generating DEK material: %v", err)
	}
	sealer, err := ingest.NewSealer(key)
	if err != nil {
		t.Fatalf("constructing sealer: %v", err)
	}
	return sealer
}

func seal(t *testing.T, sealer *ingest.Sealer, text string) []byte {
	t.Helper()
	blob, err := sealer.Seal([]byte(text))
	if err != nil {
		t.Fatalf("sealing draft content: %v", err)
	}
	return blob
}

func insertDraft(t *testing.T, db *sql.DB, twinID, destination string, contentEnc []byte) string {
	t.Helper()
	var id string
	err := db.QueryRow(
		"INSERT INTO drafts (twin_id, destination, content_enc) VALUES ($1, $2, $3) RETURNING id",
		twinID, destination, contentEnc,
	).Scan(&id)
	if err != nil {
		t.Fatalf("inserting draft fixture: %v", err)
	}
	return id
}

// insertDraftWithPost mints a #30-era draft: content_enc is the
// customer-bound body, post_enc the grammar's framed twin-thread rendering.
func insertDraftWithPost(t *testing.T, db *sql.DB, twinID, destination string, contentEnc, postEnc []byte) string {
	t.Helper()
	var id string
	err := db.QueryRow(
		"INSERT INTO drafts (twin_id, destination, content_enc, post_enc) VALUES ($1, $2, $3, $4) RETURNING id",
		twinID, destination, contentEnc, postEnc,
	).Scan(&id)
	if err != nil {
		t.Fatalf("inserting draft fixture: %v", err)
	}
	return id
}

func insertSystemSend(t *testing.T, db *sql.DB, twinID, destination, draftID string) string {
	t.Helper()
	var id string
	err := db.QueryRow(
		"INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, draft_id) VALUES ($1, 'system_send', $2, $3, $4) RETURNING id",
		twinID, destination, "draft:"+draftID, draftID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("inserting system_send fixture: %v", err)
	}
	return id
}

// newExecutor wires the executor the way the binary does, capture recorder
// included (ticket #63): a delivered customer_send is recorded into twin
// memory through the guard's own door.
//
// The tests in THIS file seed no `scope_allowlist` rows, so the guard admits
// nothing and no wa_events row is written — which is what keeps them about
// send semantics alone. The capture behaviour itself is tested at the seam in
// own_send_int_test.go, where the scope is seeded.
func newExecutor(db *sql.DB, sender executor.Sender, self executor.SelfSource, sealer *ingest.Sealer, twinID string) *executor.Executor {
	return executor.New(executor.Config{
		DB:     db,
		Sender: sender,
		Self:   self,
		Opener: sealer,
		Capture: ingest.New(ingest.Config{
			DB:        db,
			Sealer:    sealer,
			Stamp:     ingest.Stamp{CompanyID: uuid.NewString(), SeatID: uuid.NewString(), TwinID: twinID},
			Self:      self,
			Directory: directory.New(db, twinID),
			OnError:   func(error) {},
		}),
		TwinID: twinID,
	})
}

func commandState(t *testing.T, db *sql.DB, commandID string) (outcome sql.NullString, executedAt sql.NullTime) {
	t.Helper()
	err := db.QueryRow("SELECT outcome, executed_at FROM send_commands WHERE id = $1", commandID).Scan(&outcome, &executedAt)
	if err != nil {
		t.Fatalf("reading command state: %v", err)
	}
	return outcome, executedAt
}

// AC (ticket #25 / slice AC 5): system_send goes exclusively to the
// self-chat derived from the live whatsmeow session inside the plane — a
// poisoned table destination cannot redirect it, and the posted content is
// the draft's, decrypted under the twin DEK. The execution is recorded
// (outcome sent + executed_at, one finalization) and the posted message id
// lands in send_executions — the draft↔message mapping born at execution.
func TestSystemSendGoesToLiveSelfNotTheTableDestination(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "Sí, tenemos 20 cajas listas."))
	// The table destination is poisoned: it names the counterparty, not the
	// self-chat. The executor must ignore it.
	commandID := insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-DRAFT-1"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if len(sender.sent) != 1 {
		t.Fatalf("want exactly 1 send, got %d", len(sender.sent))
	}
	if sender.sent[0].to != self {
		t.Errorf("system_send went to %s, want the live self %s (ADR-0006: never a table value)", sender.sent[0].to, self)
	}
	if got := sender.sent[0].message.GetConversation(); got != "Sí, tenemos 20 cajas listas." {
		t.Errorf("posted content %q, want the decrypted draft text", got)
	}

	outcome, executedAt := commandState(t, db, commandID)
	if !outcome.Valid || outcome.String != "sent" {
		t.Errorf("outcome = %v, want sent", outcome)
	}
	if !executedAt.Valid {
		t.Error("executed_at not set with the outcome (finalization is one paired UPDATE)")
	}

	var gotTwin, gotMessageID string
	err := db.QueryRow("SELECT twin_id, wa_message_id FROM send_executions WHERE command_id = $1", commandID).Scan(&gotTwin, &gotMessageID)
	if err != nil {
		t.Fatalf("reading send_executions: %v", err)
	}
	if gotTwin != twinID || gotMessageID != "WAMID-DRAFT-1" {
		t.Errorf("send_executions = (%s, %s), want (%s, WAMID-DRAFT-1)", gotTwin, gotMessageID, twinID)
	}
}

// Ticket #30 (grammar frame): a draft now carries two contents — the
// twin-thread post (post_enc, the Mock A rendering the twin's grammar
// produced) and the customer-bound body (content_enc). A system_send draft
// ref posts the FRAMED rendering: the plane stays dumb (ADR-0005) — it
// picks the column its class names, judging nothing.
func TestSystemSendDraftPostsTheFramedRenderingNotTheBody(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	framed := "✳️ *Borrador — para Sra. Garza*\n\n«Sí, tenemos 20 cajas listas.»\n\nPorque: preguntó disponibilidad (su chat, 10:42).\n\nPara enviarlo, responde a este mensaje citándolo con «va». Para descartarlo: «no va»."
	draftID := insertDraftWithPost(t, db, twinID, "5215511111111@s.whatsapp.net",
		seal(t, sealer, "Sí, tenemos 20 cajas listas."), seal(t, sealer, framed))
	insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-DRAFT-P1"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("want exactly 1 send, got %d", len(sender.sent))
	}
	if got := sender.sent[0].message.GetConversation(); got != framed {
		t.Errorf("system_send posted %q, want the framed post_enc rendering", got)
	}
}

// Ticket #30: a slice-1 draft that predates the grammar has no post_enc —
// the system_send falls back to the body (unframed, honest) rather than
// wedging a pending legacy post. The prior test
// (TestSystemSendGoesToLiveSelfNotTheTableDestination) pins the same
// fallback on the poisoned-destination path; this one names the behavior.
func TestLegacyDraftWithoutPostFallsBackToTheBody(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "cuerpo sin marco"))
	insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-DRAFT-P2"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("want exactly 1 send, got %d", len(sender.sent))
	}
	if got := sender.sent[0].message.GetConversation(); got != "cuerpo sin marco" {
		t.Errorf("legacy system_send posted %q, want the content_enc fallback", got)
	}
}

// AC (ADR-0006, "unknown → held", never auto-retried): a pending command
// that carries a STALE attempt claim is a crash survivor — the previous
// process died somewhere between claiming and finalizing, so whether the
// send left is unknowable. The executor finalizes it held WITHOUT touching
// the socket; re-sending a customer_send here would be a send with no new
// tap. A fresh command commits its claim before the socket send.
func TestClaimedButUnfinalizedCommandIsHeldNeverResent(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "hola"))
	commandID := insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)
	// The crash signature: a committed claim past the staleness horizon
	// (which itself exceeds the 90s deadline every send is bounded by),
	// no finalization.
	if _, err := db.Exec("INSERT INTO send_attempts (command_id, attempted_at) VALUES ($1, now() - interval '10 minutes')", commandID); err != nil {
		t.Fatalf("planting the crash-survivor claim: %v", err)
	}

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-NEVER"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if len(sender.sent) != 0 {
		t.Fatalf("a claimed-but-unfinalized command was re-sent %d time(s) — the crash window must never auto-retry", len(sender.sent))
	}
	outcome, executedAt := commandState(t, db, commandID)
	if !outcome.Valid || outcome.String != "held" {
		t.Errorf("outcome = %v, want held (unknown → held)", outcome)
	}
	if !executedAt.Valid {
		t.Error("executed_at not set with the held outcome")
	}
	var executions int
	if err := db.QueryRow("SELECT count(*) FROM send_executions WHERE command_id = $1", commandID).Scan(&executions); err != nil {
		t.Fatalf("counting executions: %v", err)
	}
	if executions != 0 {
		t.Errorf("held command has %d send_executions rows, want 0 — nothing provably left the rail", executions)
	}
}

// A YOUNG claim belongs to a live worker still mid-send (Codex round 1:
// deployment overlap, stream takeover): converting it to held would
// record a delivered message as held and roll back its mapping. A
// contender skips it — no socket touch, no outcome — and only a claim
// past the staleness horizon converts.
func TestYoungClaimIsSkippedNotHeld(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "hola"))
	commandID := insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)
	// A claim committed moments ago: some worker is (or was just) sending.
	if _, err := db.Exec("INSERT INTO send_attempts (command_id) VALUES ($1)", commandID); err != nil {
		t.Fatalf("planting the live claim: %v", err)
	}

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-NEVER"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(sender.sent) != 0 {
		t.Fatalf("socket touched %d time(s) over a live claim", len(sender.sent))
	}
	outcome, _ := commandState(t, db, commandID)
	if outcome.Valid {
		t.Errorf("outcome = %v, want still pending — the claim owner decides", outcome)
	}
}

// The claim commits BEFORE the socket send: a fresh execution leaves its
// send_attempts row behind, so any crash after this point is recognizable.
func TestFreshExecutionCommitsItsClaim(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "hola"))
	commandID := insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-2"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	var claims int
	if err := db.QueryRow("SELECT count(*) FROM send_attempts WHERE command_id = $1", commandID).Scan(&claims); err != nil {
		t.Fatalf("counting claims: %v", err)
	}
	if claims != 1 {
		t.Errorf("executed command has %d send_attempts rows, want 1", claims)
	}
}

func insertWaEvent(t *testing.T, db *sql.DB, twinID string) int64 {
	t.Helper()
	var id int64
	err := db.QueryRow(
		`INSERT INTO wa_events (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
		 VALUES ('whatsapp', $1, 'message', $2, $3, $4, now(), '\x01'::bytea)
		 RETURNING id`,
		uuid.NewString(), uuid.NewString(), uuid.NewString(), twinID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("inserting wa_events fixture: %v", err)
	}
	return id
}

// insertTappedCustomerSend mints the fixture the writer (#24) would have:
// tap + customer_send bound to the draft, destination the draft's.
func insertTappedCustomerSend(t *testing.T, db *sql.DB, twinID, draftID, destination string) string {
	t.Helper()
	eventID := insertWaEvent(t, db, twinID)
	var tapID string
	err := db.QueryRow(
		"INSERT INTO taps (draft_id, minter, source_event_id) VALUES ($1, 'affirmation_matcher', $2) RETURNING id",
		draftID, eventID,
	).Scan(&tapID)
	if err != nil {
		t.Fatalf("inserting tap fixture: %v", err)
	}
	var commandID string
	err = db.QueryRow(
		"INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, tap_id, draft_id) VALUES ($1, 'customer_send', $2, $3, $4, $5) RETURNING id",
		twinID, destination, "draft:"+draftID, tapID, draftID,
	).Scan(&commandID)
	if err != nil {
		t.Fatalf("inserting customer_send fixture: %v", err)
	}
	return commandID
}

// AC (ticket #25): customer_send executes only with a tap-referencing
// command row — here the writer-minted row — to the writer-validated,
// trigger-frozen destination, posting the tapped draft's content; the
// posted message id is recorded and the outcome finalizes sent.
func TestCustomerSendExecutesTheTappedDraftToItsDestination(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "Claro, mañana se lo mando."))
	commandID := insertTappedCustomerSend(t, db, twinID, draftID, "5215511111111@s.whatsapp.net")

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-CUST-1"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	if len(sender.sent) != 1 {
		t.Fatalf("want exactly 1 send, got %d", len(sender.sent))
	}
	want := types.NewJID("5215511111111", types.DefaultUserServer)
	if sender.sent[0].to != want {
		t.Errorf("customer_send went to %s, want the tapped draft's destination %s", sender.sent[0].to, want)
	}
	if got := sender.sent[0].message.GetConversation(); got != "Claro, mañana se lo mando." {
		t.Errorf("posted content %q, want the tapped draft's decrypted text", got)
	}
	outcome, _ := commandState(t, db, commandID)
	if !outcome.Valid || outcome.String != "sent" {
		t.Errorf("outcome = %v, want sent", outcome)
	}
	var gotMessageID string
	if err := db.QueryRow("SELECT wa_message_id FROM send_executions WHERE command_id = $1", commandID).Scan(&gotMessageID); err != nil {
		t.Fatalf("reading send_executions: %v", err)
	}
	if gotMessageID != "WAMID-CUST-1" {
		t.Errorf("recorded message id %q, want WAMID-CUST-1", gotMessageID)
	}
}

// Ticket #30: the frame is rep-facing only. A customer_send on a
// #30-era draft (post_enc present) sends the BODY — the framed Mock A
// rendering, instruction line included, can never reach a customer.
func TestCustomerSendSendsTheBodyNeverTheFramedPost(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	framed := "✳️ *Borrador — para Sra. Garza*\n\n«Claro, mañana se lo mando.»\n\nPorque: preguntó (su chat, 10:42).\n\nPara enviarlo, responde a este mensaje citándolo con «va». Para descartarlo: «no va»."
	draftID := insertDraftWithPost(t, db, twinID, "5215511111111@s.whatsapp.net",
		seal(t, sealer, "Claro, mañana se lo mando."), seal(t, sealer, framed))
	insertTappedCustomerSend(t, db, twinID, draftID, "5215511111111@s.whatsapp.net")

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-CUST-P1"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(sender.sent) != 1 {
		t.Fatalf("want exactly 1 send, got %d", len(sender.sent))
	}
	if got := sender.sent[0].message.GetConversation(); got != "Claro, mañana se lo mando." {
		t.Errorf("customer_send sent %q, want the bare body — the frame must never reach a customer", got)
	}
}

// AC (ADR-0006): outcomes are exactly sent(acked) / failed / unknown→held —
// never silent, never auto-retried. Only an error that PROVES nothing
// reached the transport finalizes failed; everything ambiguous — ack
// timeouts, cancelled contexts, and any unrecognized transport error
// (bytes may already have left the socket) — finalizes held (Codex round
// 1: a frame-write error after partial transmission is not proof of
// non-delivery, and a new-tap retry on a false "failed" could
// double-send). Neither leaves execution evidence and a second pass
// retries neither.
func TestSocketErrorsFinalizeFailedOrHeldAndAreNeverRetried(t *testing.T) {
	cases := []struct {
		name    string
		sendErr error
		want    string
	}{
		{name: "not-logged-in provably sent nothing: failed", sendErr: whatsmeow.ErrNotLoggedIn, want: "failed"},
		{name: "ack timeout is unknown: held", sendErr: whatsmeow.ErrMessageTimedOut, want: "held"},
		{name: "an unrecognized transport error is unknown: held", sendErr: errors.New("websocket: write broken pipe"), want: "held"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := seamDB(t)
			twinID := uuid.NewString()
			sealer := newSealer(t)
			draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "hola"))
			commandID := insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)

			self := types.NewJID("5215599999999", types.DefaultUserServer)
			sender := &stubSender{err: tc.sendErr}
			exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

			if err := exec.RunOnce(context.Background()); err != nil {
				t.Fatalf("RunOnce: %v", err)
			}
			outcome, executedAt := commandState(t, db, commandID)
			if !outcome.Valid || outcome.String != tc.want {
				t.Errorf("outcome = %v, want %s", outcome, tc.want)
			}
			if !executedAt.Valid {
				t.Error("executed_at not set with the outcome")
			}
			var executions int
			if err := db.QueryRow("SELECT count(*) FROM send_executions WHERE command_id = $1", commandID).Scan(&executions); err != nil {
				t.Fatalf("counting executions: %v", err)
			}
			if executions != 0 {
				t.Errorf("unsent command has %d send_executions rows, want 0", executions)
			}

			// Never auto-retried: the next pass must not touch the socket.
			attempts := len(sender.sent)
			if err := exec.RunOnce(context.Background()); err != nil {
				t.Fatalf("second RunOnce: %v", err)
			}
			if len(sender.sent) != attempts {
				t.Errorf("a finalized command was retried — %d sends after second pass, want %d (a retry is a new tap)", len(sender.sent), attempts)
			}
		})
	}
}

// ADR-0006 defines customer_send as any JID EXCEPT self. The plane
// enforces the class boundary: a customer_send whose frozen destination
// resolves to the live self — a poisoned allowlist admitted it — is
// refused loudly, never sent, never finalized (seam corruption is not a
// send outcome).
func TestCustomerSendToSelfIsRefused(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	selfJid := "5215599999999@s.whatsapp.net"
	draftID := insertDraft(t, db, twinID, selfJid, seal(t, sealer, "hola"))
	commandID := insertTappedCustomerSend(t, db, twinID, draftID, selfJid)

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-NEVER"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce succeeded over a customer_send addressed to self — must refuse (ADR-0006)")
	}
	if len(sender.sent) != 0 {
		t.Fatalf("socket touched %d time(s) for a self-addressed customer_send", len(sender.sent))
	}
	outcome, _ := commandState(t, db, commandID)
	if outcome.Valid {
		t.Errorf("outcome = %v, want still pending", outcome)
	}
}

// Pre-link there is no self identity: a pending system_send stays pending
// — loudly, via ErrSelfUnavailable — with no socket touch, no claim, and
// no outcome. Not-ready is not an outcome.
func TestSystemSendWithoutLiveSelfStaysPending(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)
	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "hola"))
	commandID := insertSystemSend(t, db, twinID, "5215511111111@s.whatsapp.net", draftID)

	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-NEVER"}}
	exec := newExecutor(db, sender, liveSelf{ok: false}, sealer, twinID)

	err := exec.RunOnce(context.Background())
	if !errors.Is(err, executor.ErrSelfUnavailable) {
		t.Fatalf("RunOnce error = %v, want ErrSelfUnavailable", err)
	}
	if len(sender.sent) != 0 {
		t.Fatalf("socket touched %d time(s) with no live self", len(sender.sent))
	}
	outcome, _ := commandState(t, db, commandID)
	if outcome.Valid {
		t.Errorf("outcome = %v, want still pending", outcome)
	}
	var claims int
	if err := db.QueryRow("SELECT count(*) FROM send_attempts WHERE command_id = $1", commandID).Scan(&claims); err != nil {
		t.Fatalf("counting claims: %v", err)
	}
	if claims != 0 {
		t.Errorf("command claimed %d time(s) with no live self — an unattempted send must stay claimable", claims)
	}
}

// The runtime's notices («Enviado a …», «ya se envió») post through the
// same contract as drafts: payload_ref 'notice:<uuid>', content
// DEK-encrypted at rest, dereferenced and decrypted only in-plane, and
// addressed to the live self like every system_send.
func TestNoticeSystemSendPostsTheDecryptedNoticeToLiveSelf(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)

	// The chain the schema demands: a resolved customer_send for the
	// confirmation notice to be about.
	draftID := insertDraft(t, db, twinID, "5215511111111@s.whatsapp.net", seal(t, sealer, "hola"))
	aboutID := insertTappedCustomerSend(t, db, twinID, draftID, "5215511111111@s.whatsapp.net")
	if _, err := db.Exec("UPDATE send_commands SET outcome = 'sent', executed_at = now() WHERE id = $1", aboutID); err != nil {
		t.Fatalf("resolving the about command: %v", err)
	}
	var noticeID string
	if err := db.QueryRow(
		`INSERT INTO notices (twin_id, kind, about_command_id, content_enc)
		 VALUES ($1, 'send_confirmation', $2, $3) RETURNING id`,
		twinID, aboutID, seal(t, sealer, "Enviado a 5215511111111"),
	).Scan(&noticeID); err != nil {
		t.Fatalf("inserting notice fixture: %v", err)
	}

	var commandID string
	if err := db.QueryRow(
		"INSERT INTO send_commands (twin_id, send_class, destination, payload_ref) VALUES ($1, 'system_send', $2, $3) RETURNING id",
		twinID, "poisoned@s.whatsapp.net", "notice:"+noticeID,
	).Scan(&commandID); err != nil {
		t.Fatalf("inserting notice system_send: %v", err)
	}

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-NOTICE-1"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	// One send: the notice post (the about command was already finalized).
	if len(sender.sent) != 1 {
		t.Fatalf("want exactly 1 send, got %d", len(sender.sent))
	}
	if sender.sent[0].to != self {
		t.Errorf("notice went to %s, want the live self %s", sender.sent[0].to, self)
	}
	if got := sender.sent[0].message.GetConversation(); got != "Enviado a 5215511111111" {
		t.Errorf("posted %q, want the decrypted notice text", got)
	}
	outcome, _ := commandState(t, db, commandID)
	if !outcome.Valid || outcome.String != "sent" {
		t.Errorf("outcome = %v, want sent", outcome)
	}
}

// A payload_ref scheme this executor does not speak is a newer runtime
// talking past this plane: loud error, no send, no finalization — upgrade,
// never guess (mirrors the consumer's UnsupportedEventTypeError doctrine).
func TestUnknownPayloadRefSchemeIsLoudAndUnfinalized(t *testing.T) {
	db := seamDB(t)
	twinID := uuid.NewString()
	sealer := newSealer(t)
	var commandID string
	err := db.QueryRow(
		"INSERT INTO send_commands (twin_id, send_class, destination, payload_ref) VALUES ($1, 'system_send', $2, 'hologram:42') RETURNING id",
		twinID, "5215599999999@s.whatsapp.net",
	).Scan(&commandID)
	if err != nil {
		t.Fatalf("inserting future-schemed command: %v", err)
	}

	self := types.NewJID("5215599999999", types.DefaultUserServer)
	sender := &stubSender{resp: whatsmeow.SendResponse{ID: "WAMID-NEVER"}}
	exec := newExecutor(db, sender, liveSelf{jid: self, ok: true}, sealer, twinID)

	if err := exec.RunOnce(context.Background()); err == nil {
		t.Fatal("RunOnce succeeded over an unknown payload_ref scheme — must be loud")
	}
	if len(sender.sent) != 0 {
		t.Fatalf("socket touched %d time(s) for an unresolvable payload", len(sender.sent))
	}
	outcome, _ := commandState(t, db, commandID)
	if outcome.Valid {
		t.Errorf("outcome = %v, want still pending — a version mismatch is not a send outcome", outcome)
	}
}

// Package executor is the connection plane's send execution (ADR-0005 job
// 2; ticket #25): it consumes send_commands rows and is the SOLE caller of
// the rail's MESSAGE-egress APIs — a CI invariant scan
// (invariant_sole_sender_test.go in the plane root) proves no other package
// touches them, one named file apart, which puts a peer protocol request on
// the rail and no message (the scan's peerRequestException argues it). Zero
// business logic: what may send was decided at the writer (ADR-0017); the
// executor dereferences, addresses, sends, and records.
//
// The two send classes execute under ADR-0006:
//
//   - system_send goes exclusively to the rep's self-chat, where "self"
//     derives from the live whatsmeow session identity on every send —
//     the command row's destination column is advisory and CANNOT redirect
//     the post, whatever it says.
//   - customer_send executes only from a tap-referencing command row (the
//     schema makes a tapless row unrepresentable; the executor still
//     refuses, fail-closed) and goes to the frozen, writer-validated
//     destination.
//
// Outcomes are exactly sent(acked) / failed / unknown→held — never silent,
// never auto-retried; a retry is a new tap. Each command is finalized with
// outcome + executed_at in ONE UPDATE, exactly once (every other column is
// trigger-frozen since #24).
//
// A delivered customer_send is also RECORDED INTO TWIN MEMORY (ticket #63),
// through the capture guard's own door — see finalizeSent. Still zero
// business logic: the executor records what it sent, it does not decide what
// may be remembered.
package executor

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane"
)

// Sender is the rail's send surface. *whatsmeow.Client is the sole
// production implementation; tests stub it (spec #18: executor semantics
// against a stubbed socket).
type Sender interface {
	SendMessage(ctx context.Context, to types.JID, message *waE2E.Message, extra ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error)
}

// SelfSource yields the rep's live-session self identities — rail.Rail in
// the binary. system_send destinations come from here and ONLY here
// (ADR-0006: never a table or caller value).
//
// BOTH identities, because the account has two and ADR-0006's class split
// is about the account, not about one spelling of it (Codex r1 on #63): the
// rail addresses modern DMs by the hidden-user (LID) identity, so a
// customer_send whose frozen destination is the rep's own LID would slip
// past a PN-only comparison and post to the twin thread as a customer send.
// The capture guard already reads both for the same reason (ADR-0023).
type SelfSource interface {
	SelfJID() (types.JID, bool)
	SelfLID() (types.JID, bool)
}

// Opener opens DEK envelope blobs — *ingest.Sealer in the binary (the
// plane process is one of the DEK's two custody points, ADR-0008).
type Opener interface {
	Open(blob []byte) ([]byte, error)
}

// OwnSendRecorder writes a delivered message down as an own-sent capture,
// under the capture guard (ADR-0023) — *ingest.Ingestor in the binary, the
// same component that captures inbound.
//
// TICKET #63: WhatsApp syncs a rep's outgoing messages to their OTHER linked
// devices, so the plane never receives an echo of its own send. Recording it
// here is what lets the twin see what it said — without it, three of the four
// fact types (a price GIVEN, a date PROMISED, an order ACCEPTED) are
// invisible to extraction, and the Q&A cannot recall what the rep told a
// customer.
//
// It takes the executor's open transaction so the capture, the execution
// evidence and the finalization are one thing: either all three land or none
// does. The alternative — a write after the commit — would add a NEW silent
// hole: a crash between them loses the message from twin memory forever, and
// nothing re-drives it, which is #63 restored one send at a time.
//
// STATED PLAINLY, BECAUSE IT IS A COST: this WIDENS the executor's existing
// lost-mapping window rather than fitting inside it. Two more statements (the
// guard read and the seam INSERT) now sit between the socket send and the
// finalizing UPDATE, so a transient database failure on either resolves the
// command `held` for a message that actually went. That trade is deliberate —
// a `held` outcome is a state the system already models, reconciles and
// refuses to auto-retry, while a message missing from twin memory is a state
// nothing detects — but it is a wider window than before, not the same one.
// Closing it properly means durable outbound identity in the plane, which
// stays that class's recorded remainder (#25/#30).
//
// RECORDED, NOT CLOSED — THE CAPTURE IS NOT CAUSALLY ORDERED WITH INBOUND
// (Codex r2). The message becomes observable to the customer when
// SendMessage returns, and the capture commits a few statements later. A
// reply arriving inside that window is ingested by the socket feed on
// another goroutine and can take a LOWER wa_events id, so the runtime — which
// processes by insertion id — drafts against a history that does not yet
// contain what was just sent. Nothing is lost (the capture still lands, and
// the bundle orders by the send's own instant); one draft is composed
// without the last outgoing line.
//
// It is a NARROWED residue rather than a regression: before #63 that line
// was missing from EVERY draft, permanently. Closing it means a causal
// barrier — inbound for a chat held until that chat's acknowledged send is
// captured — which is new sequencing machinery in the runtime, a design
// change rather than a fix, and not something to introduce in a change going
// onto a live rig.
//
// Whether the guard admits the chat is not the executor's business; a
// refusal is not an error and produces no row.
type OwnSendRecorder interface {
	CaptureOwnSend(ctx context.Context, tx *sql.Tx, chat types.JID, messageID types.MessageID, text string, sentAt time.Time) error
}

// sendDeadline bounds one socket send end to end. The pinned whatsmeow
// waits up to 75s for the server ack (request.go defaultRequestTimeout);
// this caps preparation + ack wait so a live send can never outlast it —
// past the deadline the send resolves ErrMessageTimedOut → held.
const sendDeadline = 90 * time.Second

// staleClaimSeconds is the claim staleness horizon: a send_attempts row
// older than this with no finalization is a crash survivor (held); a
// younger one belongs to a worker plausibly still mid-send and is left
// alone. Codex round 2: the horizon must comfortably exceed the LONGEST
// legitimate send — sendDeadline bounds that at 90s, so 300s means a
// claim this old is provably dead, not slow.
const staleClaimSeconds = 300

// ErrSelfUnavailable marks a pass that found work but no live self
// identity (pre-link, or a store without a device). The commands stay
// pending — not an outcome, a not-ready rail; the binary logs and retries
// on the next tick rather than dying.
var ErrSelfUnavailable = errors.New("live session self identity unavailable — commands stay pending")

// Config wires an Executor.
type Config struct {
	DB     *sql.DB
	Sender Sender
	Self   SelfSource
	Opener Opener
	// Capture records a delivered customer_send as an own-sent capture
	// (ticket #63). REQUIRED for customer_send: a nil recorder is refused
	// BEFORE the socket, because running without it silently restores the
	// amnesia this field exists to end.
	Capture OwnSendRecorder
	// TwinID scopes the poll: one twin per plane process this slice.
	TwinID string
}

// Executor consumes pending send_commands for one twin.
type Executor struct {
	cfg Config
}

// New builds an Executor.
func New(cfg Config) *Executor {
	return &Executor{cfg: cfg}
}

// Run polls RunOnce until ctx is done. ErrSelfUnavailable waits for the
// next tick (pre-link is a legitimate transient — the commands stay
// pending, loudly); any other error returns: a command the executor
// cannot execute correctly means a broken seam or crypto path, and the
// binary must die observably rather than skip past it (the rail's
// fail-stop doctrine).
func (e *Executor) Run(ctx context.Context, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := e.RunOnce(ctx); err != nil && !errors.Is(err, ErrSelfUnavailable) {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

type pendingCommand struct {
	id          string
	sendClass   string
	destination string
	payloadRef  string
	tapID       sql.NullString
}

// isCustomerSend names the one class distinction the #63 write-back turns
// on, so the string literal appears once rather than at every site that
// asks. The class itself is ADR-0006's; `resolveDestination` still switches
// on it for addressing, which is a different question.
func (c pendingCommand) isCustomerSend() bool {
	return c.sendClass == string(plane.SendClassCustomer)
}

// RunOnce processes every pending command for the twin, oldest first. Any
// error is loud and stops the pass: a command the executor cannot execute
// correctly is never skipped past, and never guessed at.
func (e *Executor) RunOnce(ctx context.Context) error {
	rows, err := e.cfg.DB.QueryContext(ctx,
		`SELECT id, send_class, destination, payload_ref, tap_id
		   FROM send_commands
		  WHERE twin_id = $1 AND outcome IS NULL
		  ORDER BY created_at, id`,
		e.cfg.TwinID,
	)
	if err != nil {
		return fmt.Errorf("reading pending send_commands: %w", err)
	}
	var pending []pendingCommand
	for rows.Next() {
		var c pendingCommand
		if err := rows.Scan(&c.id, &c.sendClass, &c.destination, &c.payloadRef, &c.tapID); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scanning send_commands row: %w", err)
		}
		pending = append(pending, c)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reading pending send_commands: %w", err)
	}
	_ = rows.Close()

	for _, c := range pending {
		if err := e.executeOne(ctx, c); err != nil {
			return err
		}
	}
	return nil
}

// executeOne executes a single command through the full contract:
// destination resolution, content dereference, at-most-once claim, the one
// socket send, and the single finalizing UPDATE.
func (e *Executor) executeOne(ctx context.Context, c pendingCommand) error {
	// Refused BEFORE the socket, not after (ticket #63): an executor wired
	// without an own-send recorder would otherwise deliver the message and
	// only then discover it cannot record it — the send gone, the trace
	// missing, and the command finalized `held`. A customer_send this plane
	// cannot remember is one it does not send.
	if c.isCustomerSend() && e.cfg.Capture == nil {
		return fmt.Errorf("customer_send %s has no own-send recorder wired — refusing to send what the twin could never see (ticket #63)", c.id)
	}
	to, err := e.resolveDestination(c)
	if err != nil {
		return err
	}
	text, err := e.resolveContent(ctx, c)
	if err != nil {
		return err
	}

	// The at-most-once claim, committed BEFORE the socket send. An
	// already-existing claim means another attempt claimed this command:
	// past the staleness horizon it is a crash survivor — the process
	// died between claiming and finalizing, so whether that send left is
	// unknowable: unknown → held, never re-sent (a re-send here would be
	// a customer_send with no new tap, ADR-0006). A YOUNG claim belongs
	// to a worker plausibly still mid-send (deployment overlap, stream
	// takeover — Codex round 1): converting it would record a delivered
	// message as held and strand its mapping, so the contender skips and
	// leaves the claim owner to finalize.
	res, err := e.cfg.DB.ExecContext(ctx,
		"INSERT INTO send_attempts (command_id) VALUES ($1) ON CONFLICT (command_id) DO NOTHING",
		c.id,
	)
	if err != nil {
		return fmt.Errorf("claiming command %s: %w", c.id, err)
	}
	claimed, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("claiming command %s: %w", c.id, err)
	}
	if claimed == 0 {
		var stale bool
		err := e.cfg.DB.QueryRowContext(ctx,
			"SELECT attempted_at < now() - make_interval(secs => $2) FROM send_attempts WHERE command_id = $1",
			c.id, staleClaimSeconds,
		).Scan(&stale)
		if err != nil {
			return fmt.Errorf("reading the claim age for command %s: %w", c.id, err)
		}
		if !stale {
			return nil // the claim owner is (or was moments ago) sending
		}
		return e.finalize(ctx, c.id, "held")
	}

	// The send is deadline-bounded below the staleness horizon: a live
	// send can never look like a dead claim.
	sendCtx, cancel := context.WithTimeout(ctx, sendDeadline)
	resp, sendErr := e.cfg.Sender.SendMessage(sendCtx, to, &waE2E.Message{Conversation: proto.String(text)})
	cancel()
	if sendErr == nil {
		// The rail's own instant, not this process's clock: it is what the
		// echo would carry, so a message that both lands here and arrives
		// later reads the same either way. A rail that supplies none falls
		// back to now — the send just happened.
		sentAt := resp.Timestamp
		if sentAt.IsZero() {
			sentAt = time.Now()
		}
		return e.finalizeSent(ctx, c, resp.ID, to, text, sentAt)
	}
	return e.finalize(ctx, c.id, classifySendError(sendErr))
}

// resolveDestination addresses the send. system_send: the live self,
// always — the row's destination cannot redirect it (ADR-0006).
// customer_send: the writer-validated, trigger-frozen row destination.
func (e *Executor) resolveDestination(c pendingCommand) (types.JID, error) {
	switch c.sendClass {
	case "system_send":
		self, ok := e.cfg.Self.SelfJID()
		if !ok {
			return types.JID{}, ErrSelfUnavailable
		}
		return self, nil
	case "customer_send":
		// The schema makes a tapless customer_send unrepresentable
		// (send_commands_customer_send_requires_tap_check); refuse anyway,
		// fail-closed — a row that reaches here without a tap means a
		// broken seam, never something to send.
		if !c.tapID.Valid {
			return types.JID{}, fmt.Errorf("customer_send %s carries no tap — refusing (ADR-0006)", c.id)
		}
		to, err := types.ParseJID(c.destination)
		if err != nil {
			return types.JID{}, fmt.Errorf("customer_send %s destination %q does not parse: %w", c.id, c.destination, err)
		}
		// ADR-0006: customer_send is any JID EXCEPT self — the plane
		// enforces the class split. A destination resolving to the live
		// self (a poisoned allowlist admitted it) is seam corruption,
		// refused loudly, never a send outcome.
		//
		// BOTH self identities are compared (Codex r1 on #63). The account's
		// hidden-user (LID) identity has a different user component from its
		// phone number, so a PN-only comparison let a destination spelled as
		// the rep's own LID through as a customer_send — and since #63 that
		// would also write the customer-bound body into the twin thread's own
		// memory, which is exactly the surface the feedback-loop rule
		// protects. A session with no LID (older account) simply has one
		// identity to compare.
		self, ok := e.cfg.Self.SelfJID()
		if !ok {
			return types.JID{}, ErrSelfUnavailable
		}
		if to.ToNonAD().User == self.ToNonAD().User {
			return types.JID{}, fmt.Errorf("customer_send %s destination %q resolves to the live self — refusing (ADR-0006: customer_send is any JID except self)", c.id, c.destination)
		}
		if lid, ok := e.cfg.Self.SelfLID(); ok && to.ToNonAD() == lid.ToNonAD() {
			return types.JID{}, fmt.Errorf("customer_send %s destination %q resolves to the live self LID — refusing (ADR-0006: customer_send is any JID except self)", c.id, c.destination)
		}
		return to, nil
	default:
		return types.JID{}, fmt.Errorf("send_commands row %s has unknown send_class %q", c.id, c.sendClass)
	}
}

// resolveContent dereferences payload_ref and decrypts under the twin DEK.
// An unknown scheme is a newer runtime speaking past this plane: loud,
// never skipped, never finalized.
//
// A draft carries two contents since ticket #30 and the executor picks the
// column its class names — mechanical dereference, no judgment (ADR-0005):
// a system_send posts the twin-thread rendering the grammar produced
// (post_enc — the ✳️-framed Mock A), falling back to content_enc only for
// slice-1 drafts that predate the column; a customer_send sends the
// customer-bound body (content_enc) — the frame never reaches a customer.
func (e *Executor) resolveContent(ctx context.Context, c pendingCommand) (string, error) {
	query := ""
	switch {
	case strings.HasPrefix(c.payloadRef, "draft:"):
		if c.sendClass == "system_send" {
			query = "SELECT COALESCE(post_enc, content_enc) FROM drafts WHERE id = $1"
		} else {
			query = "SELECT content_enc FROM drafts WHERE id = $1"
		}
	case strings.HasPrefix(c.payloadRef, "notice:"):
		query = "SELECT content_enc FROM notices WHERE id = $1"
	default:
		return "", fmt.Errorf("send_commands row %s has payload_ref %q — this executor speaks only draft:/notice: (a newer runtime means upgrading the plane, never guessing)", c.id, c.payloadRef)
	}
	id := c.payloadRef[strings.Index(c.payloadRef, ":")+1:]
	var contentEnc []byte
	err := e.cfg.DB.QueryRowContext(ctx, query, id).Scan(&contentEnc)
	if err != nil {
		return "", fmt.Errorf("dereferencing %s for command %s: %w", c.payloadRef, c.id, err)
	}
	plaintext, err := e.cfg.Opener.Open(contentEnc)
	if err != nil {
		return "", fmt.Errorf("opening content for command %s under the twin DEK: %w", c.id, err)
	}
	return string(plaintext), nil
}

// classifySendError maps a socket error to its outcome. Only an error
// that PROVES nothing reached the transport is failed (not logged in: no
// live socket existed to write to). Everything else — ack timeouts,
// cancelled contexts, unrecognized transport errors — is unknown → held:
// a frame-write error can fire after bytes already left, and a false
// "failed" invites a new-tap retry that double-sends (Codex round 1).
// Neither outcome is retried: a retry is a new tap (ADR-0006).
func classifySendError(err error) string {
	if errors.Is(err, whatsmeow.ErrNotLoggedIn) {
		return "failed"
	}
	return "held"
}

// finalizeSent records the execution evidence (the posted message id — the
// draft↔message mapping and the echo-protection origin tag), records a
// customer_send as an own-sent capture so the twin can see what it said
// (ticket #63), and finalizes the command — all in one transaction.
//
// WHY THE CAPTURE IS ONLY FOR customer_send — A DECISION, NOT AN OVERSIGHT
// (ticket #63 AC 6).
//
// A customer_send is what unblocks the slice: three of the four fact types
// are rep commitments, so extraction reading only the customer's half of a
// conversation was reading half a conversation.
//
// The twin's OWN POSTS (system_send, in the twin thread) are deliberately
// NOT written back, on three grounds:
//
//  1. Nothing needs them. The twin thread is excluded from extraction by
//     construction (ADR-0033, mechanized at the extraction pass), so no fact
//     is ever missing for want of them; and every twin post is already a
//     durable rep-side row — `drafts.post_enc`, `notices.content_enc`,
//     `draft_posts`, the disclosure lines — which is how the Q&A already
//     reads back a post the rep quotes.
//  2. It would degrade the memory it claims to improve. Every captured
//     message is embedded into the bundle's vector store (#32), so the
//     twin's own boilerplate («✳️ Enviado a … ✓», «✳️ Descartado») would
//     compete with real rep and customer content in retrieval, and anything
//     the twin got wrong in a post would come back later as its own
//     recollection.
//  3. It is the one chat where twin-authored text is INPUT GRAMMAR. The
//     matcher's origin tag and the ✳️ frame both hold today (both are tested
//     in both directions), but the value on offer does not justify feeding
//     the twin's own voice into the surface where an unquoted line means
//     "the rep is speaking to me".
//
// If a later slice wants the twin's posts in twin memory, this is where it
// goes and the reasoning above is what it must answer.
func (e *Executor) finalizeSent(ctx context.Context, c pendingCommand, messageID types.MessageID, to types.JID, text string, sentAt time.Time) error {
	tx, err := e.cfg.DB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning finalization for command %s: %w", c.id, err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO send_executions (command_id, twin_id, wa_message_id) VALUES ($1, $2, $3)",
		c.id, e.cfg.TwinID, string(messageID),
	); err != nil {
		return fmt.Errorf("recording send execution for command %s: %w", c.id, err)
	}
	if c.isCustomerSend() {
		if err := e.cfg.Capture.CaptureOwnSend(ctx, tx, to, messageID, text, sentAt); err != nil {
			return fmt.Errorf("capturing own send for command %s: %w", c.id, err)
		}
	}
	if err := finalizeOn(ctx, tx, c.id, "sent"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing finalization for command %s: %w", c.id, err)
	}
	return nil
}

// finalize records failed or held without an acknowledged-send record.
// Held means delivery is unknown; it does not prove that nothing was sent.
// The outcome and execution time share one atomic UPDATE.
func (e *Executor) finalize(ctx context.Context, commandID, outcome string) error {
	return finalizeOn(ctx, e.cfg.DB, commandID, outcome)
}

// execer is the slice of database/sql both *sql.DB and *sql.Tx satisfy.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// finalizeOn is the single finalizing UPDATE (ADR-0006): outcome +
// executed_at together, exactly once — the guard on outcome IS NULL plus
// #24's freeze trigger make a second finalization structurally impossible.
func finalizeOn(ctx context.Context, db execer, commandID, outcome string) error {
	res, err := db.ExecContext(ctx,
		"UPDATE send_commands SET outcome = $2, executed_at = now() WHERE id = $1 AND outcome IS NULL",
		commandID, outcome,
	)
	if err != nil {
		return fmt.Errorf("finalizing command %s as %s: %w", commandID, outcome, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("finalizing command %s as %s: %w", commandID, outcome, err)
	}
	if n != 1 {
		return fmt.Errorf("finalizing command %s as %s touched %d rows — the command vanished or was finalized elsewhere", commandID, outcome, n)
	}
	return nil
}

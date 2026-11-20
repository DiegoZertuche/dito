package ingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/directory"
)

// eventTimeout bounds ONE EVENT end to end — the identity work, the metadata
// write, the guard read and the seam write — so a hung database can never
// wedge whatsmeow's event-handler goroutine (mirrors rail's recordTimeout
// doctrine).
//
// IT IS THE SUM OF ITS STEPS, NOT A CEILING THEY MUST SHARE (ticket #222,
// Codex r3). Every feed writes the chat directory AHEAD of the guard read, and
// a lock on that one table can hold a write for as long as it is given: under
// a shared ceiling the write is reported non-fatally and then the healthy
// allowlist read — and the seam write behind it — fails on an expired context.
// A metadata row starving the CONTENT decision, through OnError, which the
// binary fail-stops on. So the metadata write carries a cap of its own
// (`directoryBudget`) and this number holds the worst case beside it:
// `lidLookupTimeout` resolving an identity, plus `directoryBudget` writing the
// row, leaves seven seconds for the guard read and the rows.
const eventTimeout = 15 * time.Second

// directoryBudget caps the chat directory's own write so it cannot spend the
// event's budget (ticket #222, Codex r3).
//
// THE ASYMMETRY IS THE POINT. Losing a metadata row degrades a later fill and
// is reported content-free (`ErrDirectoryRefused`); losing the guard read, or
// the seam write behind it, fail-stops the plane. A step whose failure is
// survivable may not be the step that starves the ones whose failure is not,
// so it gets the smaller half of the budget rather than the first claim on all
// of it. Three seconds: an upsert of one row by primary key, generous enough
// that only a LOCK or a dead database reaches it.
const directoryBudget = 3 * time.Second

// source is the rail identifier stamped on every wa_events row.
const source = "whatsapp"

// eventTypeMessage is the event_type for a rail-delivered message.
const eventTypeMessage = "message"

// eventTypeReaction is the event_type for a rail-delivered reaction — an
// emoji placed on one specific message, either direction (ADR-0041). A type
// of its own rather than an additive field on a message: a gesture is not
// what was said, so every consumer that reads `text` as speech would quietly
// lie about one. Consumers opt in by name.
const eventTypeReaction = "reaction"

// Sealer holds the twin's unwrapped DEK inside the plane process — one of
// ADR-0008's exactly-two custody points. It seals content into the shared
// envelope blob; the material never leaves the process.
type Sealer struct {
	key []byte
}

// NewSealer takes custody of 32 bytes of DEK material (copied). The KMS
// unwrap path and tests are the construction points.
func NewSealer(key []byte) (*Sealer, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("DEK material must be 32 bytes, got %d", len(key))
	}
	s := &Sealer{key: make([]byte, 32)}
	copy(s.key, key)
	return s, nil
}

// Seal seals plaintext into the shared envelope blob under the DEK.
func (s *Sealer) Seal(plaintext []byte) ([]byte, error) {
	return SealEnvelope(s.key, plaintext)
}

// Open opens an envelope blob sealed under the same DEK — either side of
// the cross-language contract. The executor (#25) dereferences draft and
// notice content through this: the plane process is one of the DEK's two
// custody points (ADR-0008), and outbound content crosses the seam
// encrypted exactly like inbound.
func (s *Sealer) Open(blob []byte) ([]byte, error) {
	return OpenEnvelope(s.key, blob)
}

// Stamp is the config-read identity stamped on every captured row — the
// plane judges nothing, it stamps what it was told (ADR-0005).
type Stamp struct {
	CompanyID string
	SeatID    string
	TwinID    string
}

// SelfSource yields the rep's self identities from the live session —
// rail.Rail is the sole implementation in the binary (ADR-0006: never a
// table or caller value). The self-chat (twin thread) is always in scope
// (ADR-0023), and the rail can address it by either the phone-number JID or
// the account's hidden-user (LID) identity — the guard must recognize both.
type SelfSource interface {
	SelfJID() (types.JID, bool)
	SelfLID() (types.JID, bool)
}

// Directory is the chat directory the guard records every conversation in and
// resolves a LID-keyed one through (ticket #222) — *directory.Store in the
// binary. TWO JOBS AND ONE STORE, because they are one fact read in two
// directions: the row that says "this chat exists, here is its anchor" is the
// row that says "this LID is that chat".
//
// REQUIRED. A plane that records no directory cannot fill a chat scoped in
// later, which is the whole of what this ticket built; a nil store is
// therefore reported through OnError and fail-stops the binary rather than
// leaving capture running with the obligation quietly unmet.
type Directory interface {
	Upsert(ctx context.Context, entry directory.Entry) error
	PNForLID(ctx context.Context, lid types.JID) (types.JID, bool, error)
}

// LIDStore is the library's own phone-number-to-LID map, filled by the PHONE
// inside its history syncs (whatsmeow's storeHistoricalPNLIDMappings) and by
// the LID migration messages it pushes — *store.Device's LIDs in the binary,
// which reaches no network. The SECOND source the guard tries for a LID the
// directory does not know, and the last: when both are silent the thread is
// genuinely undecidable (ADR-0042).
//
// Optional, unlike the directory, and the difference is what each ABSENCE
// means. A missing directory is a wiring failure — the store is this plane's
// own table. A missing LID map is a plane with no live session store, which is
// a legitimate shape (the guard's own tests construct no session), and its
// absence subtracts one source from a resolution that already has another.
type LIDStore interface {
	GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error)
}

// HistoryWindow bounds how far back an ON-DEMAND history page may reach —
// *historywindow.Store in the binary, reading the twin's own
// `history_windows` row (ticket #222; spec #214 decision 8; FR-15).
//
// THE LINE IS A FILTER AS WELL AS A STOP, and the guard is where the filter
// has to be. The fill stops asking once a page reaches past the line, but the
// page that CROSSED it has already been dispatched to this handler with up to
// fifty messages on it, some of them older than the ninety days the product
// promised to read — so the rows are refused here, at the socket, where every
// other rule about what may rest lives (ADR-0023).
//
// ON-DEMAND ONLY, deliberately. The pairing push is the phone's own choice of
// what to send and the guard writes it whole; bounding it too would change what
// five slices of corpora contain, for a promise about the FILL. Whether the
// promise should reach the push as well is carried on the horizon ([#117]).
//
// REQUIRED, and its absence is fail-closed rather than open: a page this plane
// cannot bound is dropped whole, because writing history nobody promised is
// worse than dropping an answer to a request this plane would now refuse to
// make.
type HistoryWindow interface {
	Floor(ctx context.Context, now time.Time) (time.Time, bool, error)
}

// Config wires an Ingestor.
type Config struct {
	DB     *sql.DB
	Sealer *Sealer
	Stamp  Stamp
	Self   SelfSource
	// Directory is where every conversation the plane sees is recorded, in
	// scope or not (ADR-0023 as ticket #222 amends it). Required; see the
	// interface.
	Directory Directory
	// LIDs is the library's own identity map, tried after the directory when a
	// history conversation states a LID and no phone number.
	LIDs LIDStore
	// Window bounds how far back an on-demand history page may reach.
	// Required; see the interface.
	Window HistoryWindow
	// OnError receives every failure to guard or persist an in-scope event.
	// The binary fail-stops (a plane that cannot capture what it is told to
	// capture must not keep consuming); tests collect.
	OnError func(error)
}

// Ingestor is the capture guard plus encrypted ingest (ADR-0005 job 1):
// wire HandleEvent via whatsmeow.Client.AddEventHandler beside the rail's.
type Ingestor struct {
	cfg Config
}

// queryExecer is the slice of database/sql that both *sql.DB and *sql.Tx
// satisfy — so the guard read and the seam write can run either on their own
// (the socket feeds) or inside a caller's open transaction (the executor's
// own-send capture, ticket #63), with one implementation of each.
type queryExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// New builds an Ingestor.
func New(cfg Config) *Ingestor {
	return &Ingestor{cfg: cfg}
}

// seamEvent is everything the seam write needs from a payload whatever its
// shape: which event_type names it, and the stanza id that composes the
// row's identity. Both are read OFF the payload rather than passed beside
// it, so a shape cannot be written under another shape's type — the reaction
// husk this ticket ended was exactly that mistake in the other direction
// (ADR-0041).
type seamEvent interface {
	eventType() string
	stanzaID() string
}

// payload is the decrypted MESSAGE payload contract the twin-runtime (#23)
// reads — pinned here, versioned by "v". Everything conversational lives in
// here, DEK-encrypted; the row's plaintext columns carry metadata only
// (ADR-0008). One version, several types: "v" is the transport version and
// it does not move — what grows is the set of event TYPES the seam speaks
// (ADR-0034), each with its own shape.
type payload struct {
	V         int    `json:"v"`
	ChatJID   string `json:"chat_jid"`
	SenderJID string `json:"sender_jid"`
	FromMe    bool   `json:"from_me"`
	MessageID string `json:"message_id"`
	Text      string `json:"text"`
	// QuotedMessageID carries the quoted message's stanza id on a quoted
	// reply — the affirmation matcher's raw input (ADR-0006, ticket #24).
	QuotedMessageID string `json:"quoted_message_id,omitempty"`
	// PushName is the sender's self-chosen WhatsApp display name as the
	// rail delivered it — additive v:1 evolution (ticket #30, spec #29
	// decision 7): the twin's grammar names the counterparty from it until
	// a binding exists. The history path (#33) stamps it from the history
	// blob, conforming to this same wire shape exactly. Omitted when the
	// rail supplies none (absence, never an empty stamp); rep content
	// class, so it rides inside the encrypted payload (ADR-0008), never a
	// plaintext column.
	PushName string `json:"push_name,omitempty"`
	// Backfill is the one additive backfill marker (spec #29 decision 5,
	// ticket #33): true on events normalized from a history-sync blob,
	// omitted on live capture. The twin routes marked events to ingest
	// only — backfill never drafts (decision 6).
	Backfill bool `json:"backfill,omitempty"`
}

func (payload) eventType() string  { return eventTypeMessage }
func (p payload) stanzaID() string { return p.MessageID }

// reactionPayload is the decrypted REACTION payload contract, the second
// shape of v:1 (ticket #97 pinned it in packages/seam/src/wa-payload.ts;
// this struct is the Go side of that comment). It is a SEPARATE struct on
// purpose: a reaction carries no text and no quoted message, and bending the
// message shape with two more optional fields would leave every consumer
// that reads `text` as speech free to read a gesture as one (ADR-0041).
type reactionPayload struct {
	V         int    `json:"v"`
	ChatJID   string `json:"chat_jid"`
	SenderJID string `json:"sender_jid"`
	FromMe    bool   `json:"from_me"`
	// MessageID is the REACTION's own stanza id — whatsmeow gives a reaction
	// a fresh one — so the seam's (source, external_event_id) dedupe works
	// for it exactly as it does for a message.
	MessageID string `json:"message_id"`
	// ReactionTo is the TARGET message's stanza id, read off the rail's
	// reaction key. Required: a gesture with nothing to point at is not
	// evidence of anything.
	ReactionTo string `json:"reaction_to"`
	// Emoji is the reaction text, and THE EMPTY STRING MEANS REMOVAL,
	// mirroring the rail (whatsmeow's RemoveReactionText). No `omitempty`,
	// deliberately: absence would make a retraction indistinguishable from a
	// malformed row, and a retraction is itself a signal (ADR-0041).
	Emoji string `json:"emoji"`
	// SenderTsMS is the rail's SenderTimestampMS as whole milliseconds — the
	// fold key a consumer needing CURRENT state takes last-write per
	// (reactor, target) by. Required, never omitted, so the fold is decidable
	// for every row; see reactionSenderTsMS for the delivery-instant fallback
	// the pinned shape prescribes. The plane still folds nothing itself.
	SenderTsMS int64 `json:"sender_ts_ms"`
	// PushName and Backfill are exactly as on a message: additive, omitted
	// when absent. Backfill is set by the history feed only (#101).
	PushName string `json:"push_name,omitempty"`
	Backfill bool   `json:"backfill,omitempty"`
}

func (reactionPayload) eventType() string  { return eventTypeReaction }
func (p reactionPayload) stanzaID() string { return p.MessageID }

// newReactionPayload composes the pinned v:1 reaction shape from the rail's
// ReactionMessage plus the identity the FEED resolved for the delivery —
// canonical chat, sender doctrine, direction, the reaction's own stanza id
// and push name. Split from the live path so the history feed (#101)
// composes the same shape from the same code with its own identity
// resolution and its own delivered instant, then adds the backfill marker —
// which it does for BOTH history shapes, the accumulated one re-expressed
// as a ReactionMessage (backfill.go's asReactionMessage) rather than given a
// second copy of the wire shape to drift from.
//
// It reads TWO fields off the reaction and no others. `Key.ID` is the
// target; `Key.FromMe` and `Key.RemoteJID` are the REACTOR's perspective on
// the target message, never the direction or the chat of this delivery —
// those come from Info, like any message. `GroupingKey` is a rail transport
// detail with nothing to say to the twin.
//
// The resolved identity arrives as one `delivered` value (#125), the backfill
// marker included, so every shape the per-entry decision can choose is
// composed from the same envelope rather than from an argument list each feed
// unpacks its own way.
func newReactionPayload(r *waE2E.ReactionMessage, d delivered) reactionPayload {
	return reactionPayload{
		V:          1,
		ChatJID:    d.chat.String(),
		SenderJID:  d.senderJID,
		FromMe:     d.fromMe,
		MessageID:  d.messageID,
		ReactionTo: r.GetKey().GetID(),
		Emoji:      r.GetText(),
		SenderTsMS: reactionSenderTsMS(r, d.at),
		PushName:   d.pushName,
		Backfill:   d.backfill,
	}
}

// reactionSenderTsMS is the rail's sender timestamp in whole milliseconds,
// falling back to the same delivery instant the row's occurred_at records
// when the rail supplies none — the fallback the pinned wire shape
// prescribes, so the fold key is TOTAL: required, not optional, because a
// consumer folding last-write per (reactor, target) must be able to order
// every row. That is normalization, not judgement — the plane still folds
// nothing and resolves nothing (ADR-0005/0041).
//
// A missing field and a zero (or negative) one are the same absence here:
// protobuf cannot tell an unset int64 from a zero one through its getter,
// and no reaction was ever sent at the Unix epoch.
//
// SO IS AN UNREADABLE ONE, and that upper bound is not defensive tidiness
// (Codex r1-1). The field is an int64 the COUNTERPARTY's client fills in,
// and the reader of this contract is the twin-runtime's decoder, which
// refuses anything outside JavaScript's safe-integer range — where a JSON
// number stops being an exact instant. A reaction row the runtime cannot
// decode is a POISON ROW: routing is fail-stop and the row stays pending
// forever, so every later event for that twin stops behind it. The plane
// must never emit a payload its own pinned decoder refuses; a rail
// timestamp that is not a readable instant is not a sender timestamp, and
// takes the same fallback an absent one takes. Still normalization, not
// judgement: nothing about the reaction's CONTENT is inspected.
func reactionSenderTsMS(r *waE2E.ReactionMessage, at time.Time) int64 {
	if ts := r.GetSenderTimestampMS(); ts > 0 && ts <= maxSafeInteger {
		return ts
	}
	return at.UnixMilli()
}

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER (2^53 − 1) — the
// largest integer the twin-runtime's decoder reads back exactly, and so the
// ceiling of every whole-millisecond field crossing this seam. Roughly the
// year 287396, some 285 millennia past any timestamp a rail will deliver.
const maxSafeInteger = 1<<53 - 1

// HandleEvent consumes one raw whatsmeow event: live messages, deliveries
// the rail could not decrypt, and history-sync blobs land through the same
// guard onto the same seam (spec #29 decision 5 — one ingest path, two
// feeds). Out-of-scope traffic returns before any persistence — no row,
// anywhere (ADR-0023).
//
// UndecryptableMessage IS A DELIVERY, and subscribing to it is what stops the
// plane's one silent drop (ADR-0042). whatsmeow emits it when a message
// arrives that this device could not decrypt, then asks the sender to retry;
// before this it fell out of this switch with no row, no log and no counter,
// so a gap in the twin's memory was indistinguishable from a quiet chat.
//
// THE TWO APP-STATE FEEDS ARE NOT DELIVERIES AND WRITE NO SEAM ROW (ticket
// #222; spec #214 decision 7: "at history sync and at app-state contact sync
// the plane upserts … a directory row"). A contact edit and a changed push
// name are the phone telling this device what it calls somebody, and they are
// the only way a chat with no history at all gets a NAME on the scoping page.
// Each writes exactly one thing into the chat directory — the sealed name and,
// where the event states both identities, the LID — and nothing else: no
// anchor, no activity instant, and never a `wa_events` row. Everything else
// the rail emits — receipts, presence, typing, connection state, the rest of
// app state — is metadata with nothing to say to the twin and stays outside
// both (ADR-0023).
func (i *Ingestor) HandleEvent(evt any) {
	switch e := evt.(type) {
	case *events.Message:
		i.handleLiveMessage(e)
	case *events.UndecryptableMessage:
		i.handleUndecryptable(e)
	case *events.HistorySync:
		i.handleHistorySync(e)
	case *events.Contact:
		i.handleContact(e)
	case *events.PushName:
		i.handlePushName(e)
	}
}

func (i *Ingestor) handleLiveMessage(msg *events.Message) {
	ctx, cancel := context.WithTimeout(context.Background(), eventTimeout)
	defer cancel()

	// A GESTURE IS NOT AN ANCHOR (directory.AnchorFromHistoryRow argues it):
	// the on-demand request asks for the messages before a MESSAGE, and a
	// reaction's own stanza id is not a position in the chat's history.
	chat, self, ok := i.admit(ctx, &msg.Info, msg.Message.GetReactionMessage() == nil)
	if !ok {
		return
	}
	if err := i.persist(ctx, msg, chat, self); err != nil {
		i.cfg.OnError(fmt.Errorf("persisting in-scope event %s: %w", msg.Info.ID, err))
	}
}

// handleUndecryptable captures a delivery the rail handed over without a
// plaintext (ADR-0042). It runs the SAME guard as an ordinary delivery — the
// function, not a copy — and then writes the one thing that can honestly be
// said about it: that a message happened here, from whom, when, and that the
// plane could not read it.
//
// The row keys `<chat>:<stanza>:opaque`, so the readable re-delivery
// whatsmeow's retry receipt asks for lands on its own `<chat>:<stanza>` row
// beside it rather than being swallowed — and a repeated undecryptable
// delivery of the same message (whatsmeow re-emits when the resend is also
// undecryptable) collapses onto this one.
func (i *Ingestor) handleUndecryptable(evt *events.UndecryptableMessage) {
	ctx, cancel := context.WithTimeout(context.Background(), eventTimeout)
	defer cancel()

	// An undecryptable delivery IS an anchor: the rail could not turn it into
	// bytes this plane can read, but its stanza id is a real one and the phone
	// can page from it.
	chat, self, ok := i.admit(ctx, &evt.Info, true)
	if !ok {
		return
	}
	d := deliveredLive(&evt.Info, chat, self)
	// No body to hash: an undecryptable delivery is exactly the one the rail
	// could not turn into bytes the plane can read, so an id-less one keys on
	// the envelope alone (deliveryHash).
	if err := i.writeEvent(ctx, i.cfg.DB, chat, newOpaquePayload(undecryptableOpacity(d), d, nil), evt.Info.Timestamp); err != nil {
		i.cfg.OnError(fmt.Errorf("persisting in-scope event %s: %w", evt.Info.ID, err))
	}
}

// admit is the capture guard for one LIVE delivery, shared by the two live
// feeds (an ordinary message and an undecryptable one) so the guard has one
// implementation rather than two that could drift: the session identity, the
// canonical chat, and the uncached allowlist read. It returns the chat the
// guard admitted and the session's own identity; ok is false when the
// delivery is out of scope or the guard could not decide — the second having
// already been reported through OnError.
func (i *Ingestor) admit(ctx context.Context, info *types.MessageInfo, anchorable bool) (chat, self types.JID, ok bool) {
	self, ok = i.cfg.Self.SelfJID()
	if !ok {
		// Without the live session identity the guard cannot tell the
		// self-chat from any other chat, and deciding scope anyway would
		// risk silently dropping self-chat traffic — "always in scope,
		// never dropped" (ADR-0023). Refuse loudly instead; messages only
		// flow on an established session, so this is a broken invariant,
		// not a normal state.
		// THE CHAT IS NOT NAMED. This runs before the guard has decided, so
		// the identity in hand may be one the twin may not remember, and a
		// plane's own error is no place for it (ADR-0025; the withholding
		// `historyspike.Request` makes for the same reason). The event's own
		// wa_events row is where a decided delivery is identified.
		i.cfg.OnError(errors.New("capture guard: session identity unavailable — cannot decide scope (ADR-0006/0023)"))
		return types.JID{}, types.JID{}, false
	}
	chat = i.canonicalChat(info, self)
	// THE DIRECTORY IS WRITTEN BEFORE THE GUARD DECIDES, on this feed as on
	// the history one, and it is what makes a LATER scope-in worth anything
	// (ticket #222, Codex r1): a live delivery is the plane's only witness that
	// anything happened in a chat it is not capturing, and without one a chat
	// out of scope for a month keeps the anchor its pairing push left — the
	// fill then pages BACKWARDS from that, and the month of live traffic the
	// guard dropped is a hole in the middle of the ninety days the rep was
	// promised. Metadata, a LID and an anchor leave the socket here too;
	// content never does, and `inScope` one statement below still drops it.
	//
	// AND A DIRECTORY REFUSAL IS NOT A CAPTURE FAILURE (Codex r2): it is
	// reported and the delivery goes on, on this feed and the three others,
	// through the one path that applies that rule (`reportDirectory`). The
	// concrete case is an ordinary `status@broadcast` update — a rail address
	// whose user part is a WORD — meeting a fence that did not expect it: the
	// row is refused, and a refusal reaching OnError would end capture over
	// traffic nobody scoped. The CHECK is a shape fence for the same reason, so
	// there are two, and no address form anybody adds later can end capture.
	//
	// THE WRITE IS ALSO CAPPED (`directoryBudget`, Codex r3), because a row
	// that cannot be written FAST is the same hazard as one that cannot be
	// written at all: the guard read and the seam write below must not be left
	// spending this step's budget.
	i.metadata(ctx, "live", func(writeCtx context.Context) error {
		return i.recordDelivery(writeCtx, info, chat, self, anchorable)
	})
	inScope, err := i.inScope(ctx, i.cfg.DB, chat, self)
	if err != nil {
		// The chat is withheld for the reason the line above withholds it:
		// the guard did not decide, so this identity may be one the twin may
		// not remember.
		i.cfg.OnError(fmt.Errorf("capture guard could not read the twin's scope: %w", err))
		return types.JID{}, types.JID{}, false
	}
	return chat, self, inScope
}

// metadata runs one chat-directory write under the cap and reports it the one
// way a directory failure is ever reported (`reportDirectory`).
//
// IT WRAPS THE WRITE RATHER THAN HANDING OUT A CONTEXT, so the cap's timer is
// released when the write returns instead of living to the end of the event —
// and so the cap cannot be applied to one feed and forgotten on another.
//
// THE TWO APP-STATE FEEDS DO NOT CALL IT, deliberately: a contact or a
// push-name event IS the metadata write, with no guard read and no seam write
// behind it to starve, so `eventTimeout` is already its cap.
func (i *Ingestor) metadata(ctx context.Context, feed string, write func(context.Context) error) {
	capped, cancel := context.WithTimeout(ctx, directoryBudget)
	defer cancel()
	i.reportDirectory(feed, write(capped))
}

// deliveredLive resolves the identity a LIVE delivery carries, once, for
// whichever shape the per-entry decision then chooses — the same sender
// doctrine, the same instant, and no backfill marker.
func deliveredLive(info *types.MessageInfo, chat, self types.JID) delivered {
	return delivered{
		chat:      chat,
		senderJID: canonicalSenderJID(info.IsFromMe, info.Sender, chat, self),
		fromMe:    info.IsFromMe,
		messageID: info.ID,
		pushName:  info.PushName,
		at:        info.Timestamp,
	}
}

// inScope is the capture-guard decision (ADR-0023 skeleton): the self-chat
// (twin thread) is always in scope — structurally, from the live session
// identity, never a config row — and every other chat must be on the twin's
// scope allowlist. The chat arrives PN-canonical (canonicalChat), so the
// one self comparison covers LID-addressed deliveries too. The allowlist is
// read per event: guard rules are never cached (ADR-0023: no TTL caching).
//
// SCOPE ONLY, SO FAR. ADR-0023 also governs PAUSE and TENURE, evaluated
// against the MESSAGE TIMESTAMP, and neither is built yet — this is the
// ADR's skeleton. When they arrive they land HERE, taking the event instant,
// and there are now THREE feeds that must pass theirs: live capture
// (`msg.Info.Timestamp`), history backfill (`historyOccurredAt`) and the
// executor's own-send capture (the rail's send instant, #63). One guard, FOUR
// callers — those three plus the ninety-day fill through ScopeReader (ticket
// #222) — which is the whole reason each of them calls this rule rather than
// carrying a copy of it.
func (i *Ingestor) inScope(ctx context.Context, db queryExecer, chat, self types.JID) (bool, error) {
	return inScopeOn(ctx, db, i.cfg.Stamp.TwinID, chat, self)
}

// inScopeOn IS THE RULE, and it is a package-level function so that the ONE
// implementation can be reached without an Ingestor (ticket #222). The
// Ingestor's three feeds call it through the method above; the ninety-day
// fill calls it through ScopeReader, which holds a pool of its own. Four
// callers, one rule — the property `inScope`'s docblock rests on, extended
// rather than forked.
func inScopeOn(ctx context.Context, db queryExecer, twinID string, chat, self types.JID) (bool, error) {
	if chat == self.ToNonAD() {
		return true, nil
	}
	allowed, err := allowlisted(ctx, db, twinID, chat.String())
	if err != nil || allowed {
		return allowed, err
	}
	other, known := pairedIdentity(ctx, db, twinID, chat.String())
	if !known {
		return false, nil
	}
	return allowlisted(ctx, db, twinID, other)
}

func allowlisted(ctx context.Context, db queryExecer, twinID, chatJID string) (bool, error) {
	var one int
	err := db.QueryRowContext(ctx,
		"SELECT 1 FROM scope_allowlist WHERE twin_id = $1 AND chat_jid = $2",
		twinID, chatJID,
	).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// pairedIdentity is THE OTHER NAME OF THE SAME CHAT, when the plane has
// recorded one (ticket #222, Codex r3).
//
// THE FAILURE IT EXISTS TO REFUSE. A modern DM has two identities and the rail
// hands over whichever it likes: a chat nothing has yet stated a phone number
// for is known by its LID alone, so that is the identity the directory holds,
// the identity a dashboard shows, and therefore the identity the rep's
// scope-in writes. The day the rail states the PN — one contact sync, one
// delivery carrying `SenderAlt` — canonicalization starts answering with the
// PN, a one-name allowlist read misses, and EVERY message of a chat the rep
// scoped in is dropped at the socket. Silently: nothing looks wrong from the
// guard's side, and the ninety-day fill would meanwhile ask under the LID it
// still finds allowed and report `served` over pages the guard threw away.
//
// THE DIRECTORY IS THE RIGHT AUTHORITY. Its `lid_jid` is written from the same
// alternative fields `canonicalDMChat` already trusts to decide the identity
// in the first place, so this spends a pairing the plane recorded rather than
// adding any trust. Both directions, because the allowlist row may carry
// either name.
//
// IT IS ASKED SECOND, AND ITS FAILURE IS NOT THE GUARD'S. The allowlist is
// read first and alone, so CAPTURE NEVER DEPENDS ON THIS TABLE BEING
// AVAILABLE: an `ALTER TABLE` on the directory takes a lock that would
// otherwise block the guard read and fail-stop the plane over metadata — the
// same asymmetry `directoryBudget` exists for. So this read carries a cap of
// its own and answers "no pairing recorded" when it cannot answer, which
// leaves the one-name decision standing. What that costs, said out loud: while
// the directory is unavailable, a chat scoped under ONE of its names whose
// delivery arrives under the OTHER is dropped — loudly, content-free, the
// guard's own answer for a rule it cannot fully evaluate — rather than
// captured.
//
// THE `lid_jid` DIRECTION IS BOUND TO ONE ROW because nothing makes that
// column unique: `ORDER BY` makes the row it picks deterministic (the bound
// `directory.PNForLID` takes) instead of leaving a scalar subquery to fail on
// two.
func pairedIdentity(ctx context.Context, db queryExecer, twinID, chatJID string) (string, bool) {
	pairingCtx, cancel := context.WithTimeout(ctx, scopePairingBudget)
	defer cancel()
	var other sql.NullString
	err := db.QueryRowContext(pairingCtx,
		`SELECT COALESCE(
		          (SELECT lid_jid FROM chat_directory
		            WHERE twin_id = $1 AND chat_jid = $2),
		          (SELECT chat_jid FROM chat_directory
		            WHERE twin_id = $1 AND lid_jid = $2
		            ORDER BY chat_jid LIMIT 1))`,
		twinID, chatJID,
	).Scan(&other)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return "", false
	case err != nil:
		logScopePairingUnavailable()
		return "", false
	}
	if !other.Valid || other.String == "" || other.String == chatJID {
		return "", false
	}
	return other.String, true
}

// scopePairingBudget caps the second of the guard's two reads. Short on
// purpose: it is an indexed lookup of one row, and the whole reason it is
// separate from the allowlist read is that the CONTENT decision must not wait
// on the metadata table.
const scopePairingBudget = time.Second

// logScopePairingUnavailable says that a decision was taken on one name
// because the other could not be read. Content-free, like every guard line
// (ADR-0025): which chat it was is exactly what may not be said, and the fact
// that it happened is what a reader needs.
func logScopePairingUnavailable() {
	log.Print("capture guard: the chat directory did not answer — scope decided on the delivered identity alone")
}

// ScopeReader is the capture guard's own question, asked by something that is
// not the guard (ticket #222): "may this twin remember this chat, right now".
//
// THE FOURTH CALLER IS THE NINETY-DAY FILL, and it needs the rule for a
// reason the guard cannot cover: a rep who scopes a chat in and back out
// inside one sitting has their scope-out request QUEUED BEHIND the fill that
// is already running — the plane serves requests one at a time — so the fill
// would page the whole ninety days for a chat the rep has just switched off,
// every page dropped at the socket, a notification on their own phone per
// page, and a directory row left claiming a fill that landed nothing.
//
// A CALLER, NOT A SECOND READER. `inScope`'s own docblock rests on there
// being one implementation of the rule and several callers of it ("One guard,
// three callers — which is the whole reason the own-send feed calls this
// function rather than carrying a copy of the rule"), and this is the fourth:
// the same function, the same allowlist read, the same self-chat rule. What it
// is NOT is a cache — the read happens per page, which is ADR-0023's rule
// applied to the one place a decision can go stale mid-work.
//
// IT NEEDS NO DEK, deliberately: the guard's decision is a config read, so
// this is constructible on a plane whose twin is not provisioned, which is the
// state link day begins in.
type ScopeReader struct {
	db     *sql.DB
	twinID string
	self   SelfSource
}

// NewScopeReader builds a reader for the configured twin.
func NewScopeReader(db *sql.DB, twinID string, self SelfSource) *ScopeReader {
	return &ScopeReader{db: db, twinID: twinID, self: self}
}

// InScope answers the guard's question for one chat.
//
// NO LIVE SESSION IS NOT "OUT OF SCOPE": without the session identity the
// self-chat cannot be told from any other chat, which is the refusal every
// guard path makes (ADR-0006/0023) rather than an answer. The caller sees an
// error and stops, which is what it would do on any other unreadable rule.
func (r *ScopeReader) InScope(ctx context.Context, chat types.JID) (bool, error) {
	self, ok := r.self.SelfJID()
	if !ok {
		return false, fmt.Errorf("reading capture scope for twin %s: session identity unavailable — cannot decide scope (ADR-0006/0023)", r.twinID)
	}
	return inScopeOn(ctx, r.db, r.twinID, chat.ToNonAD(), self)
}

// persist seals the payload in-plane and writes the pinned envelope row.
// Duplicate delivery of the same (source, external event id) is the seam
// dedupe: exactly one row (ADR-0005).
//
// WHICH SHAPE is the per-entry decision seamEventFor makes, and it is the
// SAME decision the history feed makes (ADR-0042: one rule, three feeds).
// whatsmeow has no separate reaction event — a reaction arrives as an
// ordinary *events.Message whose ReactionMessage is set — and no separate
// event for a photo either, so every shape parts there rather than here.
// Everything before it is shared and unchanged: the same guard, the same
// canonical chat, the same sender doctrine. Set, change and removal all land
// here as ordinary deliveries and each writes its own row; the plane folds
// nothing.
func (i *Ingestor) persist(ctx context.Context, msg *events.Message, chat, self types.JID) error {
	d := deliveredLive(&msg.Info, chat, self)
	body := msg.Message
	if raw, id, folded := unfoldedEdit(msg); folded {
		body, d.messageID = raw, id
	}
	return i.writeEvent(ctx, i.cfg.DB, chat, seamEventFor(body, d), msg.Info.Timestamp)
}

// unfoldedEdit undoes THE ONE FOLD whatsmeow performs on the way in, and it is
// not a hypothetical (Codex r2). When a delivery arrives that this device
// cannot read, whatsmeow asks the phone to resend it — unconditionally, on the
// same `unavailable` branch that emits the UndecryptableMessage this ticket
// just subscribed to. The phone answers with a WebMessageInfo, and
// `ParseWebMessage` rebuilds it into an ordinary *events.Message — except for
// a MESSAGE_EDIT, where it REWRITES Info.ID to the TARGET message's id and
// replaces the body with the edited content. Folded that way, an edit reaches
// the seam wearing the original's identity and looking like ordinary speech:
// either the dedupe discards it against the original's row, so a delivery
// leaves none, or it lands as something the counterparty never said.
//
// The seam records deliveries and folds nothing (ADR-0041/0042). SourceWebMsg
// — which whatsmeow attaches only on this path — still states the delivery's
// OWN key and its own body, so the edit is written as itself: one row of kind
// `protocolMessage/MESSAGE_EDIT` under the edit's own stanza id, and which row
// STANDS is the consumer's fold.
func unfoldedEdit(msg *events.Message) (body *waE2E.Message, messageID string, folded bool) {
	web := msg.SourceWebMsg
	if web == nil {
		return nil, "", false
	}
	raw := unwrapWebBody(web)
	if raw.GetProtocolMessage().GetType() != waE2E.ProtocolMessage_MESSAGE_EDIT {
		return nil, "", false
	}
	return raw, web.GetKey().GetID(), true
}

// writeEvent seals one v:1 payload in-plane and writes the pinned envelope
// row — the one seam write every feed shares (live capture, #33 backfill,
// the executor's own-send write-back). Duplicate delivery of the same
// (source, external event id) is the seam dedupe: exactly one row (ADR-0005)
// — which is also what holds a live/backfill overlap to one row, the
// composed id being the same <chat>:<stanza-id> on both feeds, and what
// dedupes a redelivered reaction, whose own stanza id composes it.
//
// The event_type is the PAYLOAD'S, never the caller's: one shape, one type,
// with no seam at which they can be paired wrongly.
//
// BOTH SHAPES NOW REACH HERE FROM BOTH SOCKET FEEDS — #101 closed the
// window #100 had to leave open. A standalone history reaction composes the
// SAME <chat>:<stanza-id> as its live delivery, so this dedupe collapses
// the two; because the history feed writes the TYPED shape rather than an
// empty-text husk, that collapse is now between IDENTICAL shapes and
// first-write-wins no longer decides which one a chat keeps. The one
// collapse that is not free is an accumulated history entry carrying no
// rail id of its own: its synthesized identity can never equal a live row's
// (syntheticReactionID), so a gesture captured both ways lands twice —
// recorded on #101, and left to consumers to fold, rather than resolved by
// a plane that judges nothing.
func (i *Ingestor) writeEvent(ctx context.Context, db queryExecer, chat types.JID, p seamEvent, occurredAt time.Time) error {
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	enc, err := i.cfg.Sealer.Seal(body)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx,
		`INSERT INTO wa_events (source, external_event_id, event_type, company_id, seat_id, twin_id, occurred_at, payload_enc)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT ON CONSTRAINT wa_events_source_external_event_id_key DO NOTHING`,
		source, externalEventID(chat, p.stanzaID()), p.eventType(),
		i.cfg.Stamp.CompanyID, i.cfg.Stamp.SeatID, i.cfg.Stamp.TwinID,
		occurredAt.UTC(), enc,
	)
	return err
}

// CaptureOwnSend records a message the PLANE ITSELF sent, as an own-sent
// capture on the seam (ticket #63).
//
// WHY IT HAS TO EXIST. WhatsApp syncs a rep's outgoing messages to their
// OTHER linked devices. The plane is the device that sent them, so it never
// receives its own echo — and before this, nothing else wrote them down.
// Every message the twin sent on the rep's behalf was invisible to the twin
// the moment it left: the rig's customer chat held six messages, every one
// inbound, across two slices, while three customer_sends had gone out with
// outcome `sent`. Extraction filed nothing from a conversation that plainly
// contained a commitment — correctly, because a price GIVEN, a date PROMISED
// and an order ACCEPTED are all things the rep says.
//
// IT IS A RECORDING, NOT A SECOND JOB (ADR-0005). The plane stays thin: this
// writes down what job 2 already did, through job 1's own door. Nothing here
// judges, sends, or reaches a model.
//
// THE GUARD DECIDES, EXACTLY AS IT DOES INBOUND (ADR-0023). This runs the
// same `inScope` the socket feeds run — the same function, not a copy — so
// the property "nothing enters twin memory that the guard would not have
// admitted" holds by construction rather than by agreement. That matters
// because `scope_allowlist` and `send_allowlist` are DIFFERENT LISTS:
// send_allowlist is the writer's answer to "may this twin send here"
// (ADR-0017), scope_allowlist is the guard's answer to "may this twin
// remember this chat" (ADR-0023). A write-back is a capture, so the CAPTURE
// list governs it. A rep who descopes a chat with a tapped draft still in
// flight gets the send (it was authorized) and no memory of it — which is
// precisely what would happen had they typed it on their phone.
//
// IDEMPOTENT AGAINST A REAL ECHO. The seam id is composed by the same
// `externalEventID` an inbound delivery composes, from the same canonical
// chat and the rail's own message id — so if WhatsApp ever does deliver this
// message back (a re-link, a rail change, a whatsmeow that starts looping
// own-sends), it collapses onto this row rather than duplicating it.
//
// Returns nothing but an error: whether the guard admitted the chat is the
// guard's business, never the caller's (ADR-0005).
//
// The transaction is the CALLER'S, and required rather than optional: the
// capture belongs with the execution evidence it records, and a signature
// that also accepted the pool would let a caller drift out of that unit
// without noticing.
func (i *Ingestor) CaptureOwnSend(ctx context.Context, tx *sql.Tx, chat types.JID, messageID, text string, sentAt time.Time) error {
	var db queryExecer = tx
	self, ok := i.cfg.Self.SelfJID()
	if !ok {
		// Same refusal the live path makes: without the session identity the
		// guard cannot tell the self-chat from any other chat, and deciding
		// scope anyway would risk writing content the guard would have
		// dropped. Loud, never a silent skip.
		return fmt.Errorf("capture guard on own send to %s: session identity unavailable — cannot decide scope (ADR-0006/0023)", chat.ToNonAD())
	}
	// The one canonicalization doctrine, applied in this direction too. The
	// destination the send-lock writer froze was taken from a captured
	// inbound's payload, so it already IS this chat's guard identity; running
	// it through anyway is what keeps a single doctrine rather than an
	// assumption. There is no PN alternative to supply at send time — the
	// rail delivers those on a DELIVERY — so a LID destination stays itself,
	// which is exactly what `canonicalDMChat` does with an absent alternative
	// on the inbound side.
	//
	// RECORDED, NOT CLOSED. That makes the guard identity here whatever the
	// chat's captured rows already carry, which is the property that matters
	// — but it also means that for a chat whose identity is a LID (no PN
	// alternative was ever delivered, so the allowlist holds the LID), an
	// echo that DID arrive carrying a RecipientAlt would canonicalize to the
	// PN and key a second row. That is a property of `canonicalDMChat` under
	// an identity that changes mid-life, not of this write-back — the same
	// chat's inbound rows would already split the same way — and no rail
	// delivers such an echo today. Closing it means resolving LID→PN inside
	// the plane, which is the durable-outbound-identity work already recorded
	// as a remainder on #25/#30.
	chat = i.canonicalDMChat(chat, types.JID{}, self)
	inScope, err := i.inScope(ctx, db, chat, self)
	if err != nil {
		return fmt.Errorf("capture guard on own send to %s: %w", chat, err)
	}
	if !inScope {
		return nil
	}
	return i.writeEvent(ctx, db, chat, payload{
		V:       1,
		ChatJID: chat.String(),
		// An own-sent event's sender is self by definition — the same
		// doctrine both feeds share.
		SenderJID: canonicalSenderJID(true, types.JID{}, chat, self),
		FromMe:    true,
		MessageID: messageID,
		Text:      text,
		// No push-name: the rep is not a counterparty, and the inbound
		// contract omits the field rather than stamping an empty one.
	}, sentAt)
}

// canonicalChat resolves a live delivery's chat to its one guard identity:
// the shared canonicalization core, fed the PN alternative whatsmeow
// supplies on the delivery — SenderAlt (inbound: the sender IS the chat)
// or RecipientAlt (own-sent: the recipient is).
func (i *Ingestor) canonicalChat(info *types.MessageInfo, self types.JID) types.JID {
	alt := info.SenderAlt
	if info.IsFromMe {
		alt = info.RecipientAlt
	}
	return i.canonicalDMChat(info.Chat, alt, self)
}

// canonicalDMChat is the one canonicalization doctrine both feeds share
// (live capture and #33 backfill — a doctrine split between them would let
// the same chat land under two identities). The rail addresses modern DMs
// by LID (hidden-user identity) while the scope allowlist and the self JID
// carry phone-number JIDs — the same chat must land on the same identity
// however it is addressed, or an in-scope delivery would drop (slice ACs
// 2–3). The account's own LID resolves through the live session identity
// (rail.SelfLID, ADR-0006) — the self-chat needs no alternative attached.
// Any other LID resolves through the PN alternative the feed supplies
// (live: SenderAlt/RecipientAlt; history: the conversation's pnJID).
// Without an alternative the LID itself is the identity — the allowlist
// can carry it, and nothing is guessed.
func (i *Ingestor) canonicalDMChat(chat, alt, self types.JID) types.JID {
	chat = chat.ToNonAD()
	if !addressedByLID(chat) {
		return chat
	}
	if selfLID, ok := i.cfg.Self.SelfLID(); ok && chat == selfLID.ToNonAD() {
		return self.ToNonAD()
	}
	if alt = alt.ToNonAD(); !alt.IsEmpty() && alt.Server == types.DefaultUserServer {
		return alt
	}
	return chat
}

// addressedByLID reports whether a chat identity is the rail's hidden-user
// (LID) form — the ONE case in which the PN alternative a feed supplies
// decides the chat's guard identity. Named because two places ask it: the
// canonicalization itself, and the history feed deciding whether an
// unparseable pnJID leaves it with anything undecided (#125).
func addressedByLID(chat types.JID) bool {
	return chat.ToNonAD().Server == types.HiddenUserServer
}

// canonicalSenderJID is the one sender doctrine both feeds share: an
// own-sent event's sender is self by definition — stamped from the live PN
// identity, never a LID split of the same participant. A LID (or absent)
// sender in a DM IS the chat, which arrives here already PN-canonical.
func canonicalSenderJID(fromMe bool, sender, chat, self types.JID) string {
	if fromMe {
		return self.ToNonAD().String()
	}
	if sender = sender.ToNonAD(); sender.IsEmpty() || sender.Server == types.HiddenUserServer {
		return chat.String()
	}
	return sender.String()
}

// messageText extracts the conversational text of a message body and, for a
// quoted reply, the quoted message's stanza id — the same projection for a
// live delivery and a history-sync row (both carry a waE2E.Message). Plain
// messages arrive as Conversation; replies (and any message with context)
// as ExtendedTextMessage.
//
// `isTextShape` REPORTS WHETHER THIS BODY IS ONE THE SEAM HAS A TEXT SLOT FOR,
// and with the text itself it is the whole of what decides 'message' against
// 'opaque' (#125). Every other shape — a photo, a voice note, a poll, an edit,
// a revoke, a sticker — used to fall through to empty text here, which wrote
// the 'message' husk ADR-0041 retired for reactions and ADR-0042 retired for
// everything else. The fall-through is now named rather than silent, and its
// caller writes an opaque row.
//
// PRESENCE, NOT EMPTINESS, and the difference is the last husk (Codex r2). A
// text shape carrying NO text — a Conversation explicitly set to the empty
// string, an ExtendedTextMessage with its Text field absent — is a known kind
// missing the one field it cannot be written without, so it is malformed
// rather than speech; asking `!= ""` here would have called the first one
// no_slot and written the second as a blank utterance for the embedder to
// store. Which of the two answers a caller gives is its own business: this
// reports what the body IS, and returns the text it carries.
func messageText(msg *waE2E.Message) (text, quotedID string, isTextShape bool) {
	if msg == nil {
		return "", "", false
	}
	if msg.Conversation != nil {
		return msg.GetConversation(), "", true
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil {
		return ext.GetText(), ext.GetContextInfo().GetStanzaID(), true
	}
	return "", "", false
}

// externalEventID composes the rail's own identity for a message. WhatsApp
// message ids are client-generated and unique only per chat, so the chat is
// part of the id: a cross-chat id collision must never dedupe away an
// in-scope event, while a true duplicate delivery (same chat, same id)
// still lands on the seam's UNIQUE (source, external_event_id).
//
// Decision, recorded on #22: the chat JID rests here in plaintext. Chat
// identity is metadata-class in this architecture — the scope_allowlist and
// send_allowlist config tables carry chat JIDs in the same shared store, and
// ADR-0008 scopes DEK encryption to rep CONTENT ("metadata-only events
// always flow", ADR-0023) — and every captured chat's identity is already a
// config row (or the self JID). The payload duplicates chat_jid inside the
// envelope so #23 never needs to parse this column; treat the id as opaque.
func externalEventID(chat types.JID, messageID string) string {
	return chat.String() + ":" + messageID
}

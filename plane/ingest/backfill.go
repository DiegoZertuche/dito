package ingest

// History-sync backfill (ticket #33, spec #29 decisions 5–7): the twin
// knows the customers from before it existed. whatsmeow delivers the
// phone's history as a blob of conversations after pairing; the plane
// normalizes each one into the SAME payload v:1 shapes as live capture —
// one additive backfill marker, push-name where present — and writes
// ordinary seam events through the same capture guard. One ingest path, two
// feeds: no second payload version, no second table, and the out-of-scope
// past never leaves the plane (ADR-0023 applies to history exactly as to
// live traffic). The plane still judges nothing (ADR-0005) — the marker is
// a statement of provenance, and the twin's routing ("backfill never
// drafts", decision 6) happens on the other side of the seam.
//
// EVERY CONVERSATION IS RECORDED, IN SCOPE OR NOT (ticket #222): before the
// guard decides anything, the conversation's identities, its kind, its sealed
// name, its last activity and one anchor go into the chat directory, so that a
// chat the rep scopes in a month from now can still be asked for its history.
// That is this ticket's amendment to ADR-0023, and it is exactly one sentence
// wide — content is still dropped at the socket, one statement later, on the
// same uncached allowlist read. `chatdirectory.go` holds the write side.
//
// REACTIONS ARRIVE HERE IN TWO CONTAINERS, not one (ticket #101, ADR-0041's
// "backfill walks both history shapes"): as a standalone reaction message
// in the stream, and accumulated onto the target message as
// WebMessageInfo.Reactions entries. whatsmeow merges neither and dedups
// nothing, so this file walks both into the ONE typed 'reaction' event the
// live feed emits, and lets the seam's (source, external_event_id)
// constraint do the collapsing. Standalone rows carry the reaction's own
// stanza id and collapse against live capture for free; an accumulated
// entry collapses when it carries that id too, and takes a deterministic
// synthesized one when it does not (syntheticReactionID).

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// handleHistorySync guards and persists one history-sync blob,
// conversation by conversation. Scope is decided per conversation with the
// same uncached allowlist read as live capture (ADR-0023: guard rules are
// never cached) — an out-of-scope conversation is skipped whole, before
// any persistence. Failures are loud (OnError → the binary fail-stops) but
// scoped: one conversation's failure never silently swallows the rest of
// the blob.
func (i *Ingestor) handleHistorySync(evt *events.HistorySync) {
	self, ok := i.cfg.Self.SelfJID()
	if !ok {
		// Same refusal as the live guard: without the session identity the
		// twin thread's history is indistinguishable from any other
		// chat's, and deciding scope would risk silently dropping it
		// ("always in scope, never dropped", ADR-0023).
		i.cfg.OnError(fmt.Errorf("capture guard on history sync: session identity unavailable — cannot decide scope (ADR-0006/0023)"))
		return
	}
	if i.cfg.Directory == nil {
		// Loud, never a silent skip: a plane that records no directory keeps
		// no anchor, and a chat scoped in tomorrow then has no way back to its
		// history for the life of that pairing (ticket #222). The binary
		// fail-stops on this, exactly as it does on a capture it cannot
		// perform — the obligation is not optional and its absence is a
		// wiring failure, not a state.
		i.cfg.OnError(fmt.Errorf("capture guard on history sync: no chat directory wired — the plane would keep no anchor, so a later scope-in could never be filled (ticket #222)"))
		return
	}
	// WHICH FEED THIS BLOB IS, and it decides one thing: whether the twin's
	// history window bounds what may be written from it (ticket #222). An
	// ON_DEMAND blob is the answer to a request THIS PLANE made, so the ninety
	// days the product promised bounds it; the phone's own pushes are its
	// choice of what to send, and the guard writes them whole.
	onDemand := evt.Data.GetSyncType() == waHistorySync.HistorySync_ON_DEMAND
	for _, conv := range evt.Data.GetConversations() {
		if err := i.backfillConversation(conv, self, onDemand); err != nil {
			// THE CHAT IS NOT IN THE MESSAGE (Codex r1). This wrapper named
			// `conv.GetID()`, and OnError is `log.Fatalf` in the binary — so a
			// failure put a chat identity in the plane's log (ADR-0025). It was
			// only reachable for a chat the guard ADMITTED until the directory
			// write moved ahead of the scope decision; now a store failure on an
			// out-of-scope conversation reaches here too, which is precisely the
			// identity that must never be logged.
			i.cfg.OnError(fmt.Errorf("backfilling one history conversation of twin %s: %w", i.cfg.Stamp.TwinID, err))
		}
	}
}

func (i *Ingestor) backfillConversation(conv *waHistorySync.Conversation, self types.JID, onDemand bool) error {
	guardCtx, cancel := context.WithTimeout(context.Background(), eventTimeout)
	defer cancel()
	chat, ok, err := i.canonicalHistoryChat(guardCtx, conv, self)
	if err != nil {
		return err
	}
	if !ok {
		// THE ONE PERMITTED DROP (ADR-0042). An opaque row is still an
		// in-scope row, so scope is decided before kind — and here the guard
		// cannot decide it at all: a conversation whose chat identity does
		// not parse can be placed on no allowlist, so ADR-0023 outranks the
		// row invariant and content the guard cannot place never rests
		// anywhere. Nothing is written and one line is logged, which is the
		// trace the corpus structurally cannot hold. It is NOT an error: a
		// history blob is a file a counterparty's phone helped fill, and
		// fail-stopping on its contents would be the content-shaped fatal
		// ADR-0042 exists to end.
		logGuardUndecidable()
		return nil
	}
	// THE DIRECTORY IS WRITTEN BEFORE THE GUARD DECIDES, and that order IS
	// this ticket's amendment to ADR-0023: metadata, a LID and an anchor of an
	// out-of-scope chat leave the socket — sealed where they are a name — so
	// that a chat the rep scopes in next month can still be asked for. CONTENT
	// never does, and the uncached allowlist read one statement below is what
	// still drops it (ticket #222; spec #214 decision 7).
	// A DIRECTORY REFUSAL IS NOT A CAPTURE FAILURE, on this feed for the reason
	// it is not on any other (`ErrDirectoryRefused` argues the one rule): the
	// row is metadata whose loss degrades a later fill, and returning here
	// would fail-stop the plane over a conversation whose CONTENT the guard may
	// be about to drop anyway. A SEALING failure still returns, and is fatal.
	// THE WRITE IS CAPPED (`directoryBudget` argues it): this feed spends an
	// identity lookup before it even gets here, and a metadata row must not
	// spend what the guard read and the conversation's rows need after it.
	i.metadata(guardCtx, "history", func(writeCtx context.Context) error {
		return i.recordConversation(writeCtx, conv, chat, self)
	})
	inScope, err := i.inScope(guardCtx, i.cfg.DB, chat, self)
	if err != nil {
		return err
	}
	if !inScope {
		// Dropped at the socket: no row, anywhere — the out-of-scope past
		// never leaves the plane (ADR-0023).
		return nil
	}
	// THE NINETY-DAY LINE, WHERE IT HAS TO BE. The fill stops asking once a
	// page reaches past the window, but the page that CROSSED it is already
	// here, and up to fifty of its messages are older than the history the
	// product promised to read (spec #214 decision 8). So the line is a filter
	// as well as a stop, and it is applied at the socket beside every other
	// rule about what may rest (ticket #222).
	//
	// Read per blob and never held: this bounds what enters twin memory, so it
	// is a guard rule and guard rules are never cached (ADR-0023).
	floor, bounded, err := i.historyFloor(guardCtx, onDemand)
	if err != nil {
		return err
	}
	if onDemand && !bounded {
		// Fail-closed, and loud rather than silent: a page this plane cannot
		// bound is an answer to a request it would now refuse to make (the
		// fill refuses `no_history_window`), and writing history nobody
		// promised is worse than dropping it. Content-free, like every other
		// line the guard leaves (ADR-0025).
		logUnboundedOnDemandPage()
		return nil
	}
	// How many of this page's rows the line refused, reported at the end of
	// the walk (`logBeyondWindow`) — a count and nothing else.
	beyondWindow := 0
	defer func() { logBeyondWindow(beyondWindow) }()
	// Deferred rather than trailing: a conversation that fails half-way
	// still reports the shapes it walked, and the guard has already decided
	// scope above — so an out-of-scope conversation, which returns before
	// this, never produces a line at all.
	var shapes historyReactionShapes
	defer func() { shapes.report() }()
	// The same rule inScope applies for the twin thread (a self-chat is
	// its own non-AD JID), and the count is what the walk WILL see — every
	// message in the conversation, the id-less ones included, because a
	// reader sizing "no reactions in this chat" needs the size of the chat.
	shapes.twinThread = chat == self.ToNonAD()
	shapes.messages = len(conv.GetMessages())
	// The standalone shape is PREFERRED where a conversation carries both,
	// so it has to be known before the first write: rows are persisted in
	// stream order and the seam's first write wins, and a target precedes
	// the gesture on it — so without this index the accumulated copy would
	// win every ordinary ordering, keeping a row with the TARGET's instant,
	// no push name, and a reactor read off the ambiguous key.
	standalone := standaloneReactionIDs(conv)
	for _, hsMsg := range conv.GetMessages() {
		// AN ID-LESS ENTRY IS NO LONGER SKIPPED (#125). It used to be the one
		// absence nothing survived — neither the row nor a gesture on it could
		// dedupe or be referenced — but a skip is a delivery that leaves no
		// row, and the corpus is the only thing anyone measures (ADR-0042). It
		// now writes an opaque row naming the field it is missing, keyed by
		// the hash of its own envelope so a redelivered blob still writes
		// nothing twice. Whether the entry carries a body at all is a separate
		// question, asked inside backfillRow — a body-less parent still
		// carries its accumulated gestures.
		// ...AND A ROW OLDER THAN THE LINE IS NOT ONE OF THEM. It is skipped
		// whole, its accumulated gestures with it: a gesture is written
		// BESIDE its target (backfillRow says why), so keeping one whose
		// target was refused would leave a reaction pointing at a message the
		// twin does not have.
		if bounded && historyOccurredAt(hsMsg.GetMessage()).Before(floor) {
			beyondWindow++
			continue
		}
		if err := i.backfillRow(hsMsg.GetMessage(), chat, self, standalone, &shapes); err != nil {
			return err
		}
	}
	return nil
}

// historyFloor is the oldest instant this blob may write, and whether one
// applies at all. Only an on-demand page is bounded (HistoryWindow says why),
// so the pairing push pays for no read.
//
// THE MOMENT IS READ HERE rather than passed in, and it is the one clock read
// in the capture path: a window is "the last N days" from NOW, and the guard
// is the only thing that knows when now is when a blob arrives. The store
// itself reads no clock, so a test states the moment by stating the window.
func (i *Ingestor) historyFloor(ctx context.Context, onDemand bool) (time.Time, bool, error) {
	if !onDemand || i.cfg.Window == nil {
		return time.Time{}, false, nil
	}
	return i.cfg.Window.Floor(ctx, time.Now())
}

// logUnboundedOnDemandPage emits the one line an on-demand page nobody has
// bounded leaves: the FEED it happened on and the KIND of thing dropped, and
// nothing else — `logGuardUndecidable`'s shape, for the same reason
// (ADR-0025: telemetry is content-free by construction).
// logDirectoryRefused emits the one line a refused directory write leaves: the
// FEED it happened on and nothing else. No chat, no name, no reason text —
// PostgreSQL states a CHECK violation with «DETAIL: Failing row contains (…)»,
// which is the chat identity that could not be stored, and that is exactly what
// a plane log may not hold (ADR-0025). `reportDirectory` is its one caller and
// `ErrDirectoryRefused` argues why the refusal is never fatal.
func logDirectoryRefused(feed string) {
	log.Printf("chat directory refused: feed=%s", feed)
}

func logUnboundedOnDemandPage() {
	log.Print("capture guard drop: feed=history kind=on_demand_page reason=no_history_window")
}

// logBeyondWindow says how many of one page's rows the twin's history window
// refused — a COUNT and nothing else, and only when there were any: a page
// wholly inside the window is the ordinary case and a line per page would bury
// the ones that mean something. Content-free by construction, like every other
// line the guard leaves (ADR-0025).
func logBeyondWindow(rows int) {
	if rows == 0 {
		return
	}
	log.Printf("capture guard: feed=history kind=on_demand_page beyond_window=%d", rows)
}

// standaloneReactionIDs indexes the stanza ids of every STANDALONE reaction
// row in one conversation — the shape that states a gesture's own instant,
// its own direction and its push name, and so the one to keep when the same
// reaction also arrives accumulated on its target. whatsmeow merges the two
// shapes nowhere, so this is the only place the preference can be applied.
func standaloneReactionIDs(conv *waHistorySync.Conversation) map[string]struct{} {
	ids := map[string]struct{}{}
	for _, hsMsg := range conv.GetMessages() {
		webMsg := hsMsg.GetMessage()
		if id := webMsg.GetKey().GetID(); id != "" && unwrapWebBody(webMsg).GetReactionMessage() != nil {
			ids[id] = struct{}{}
		}
	}
	return ids
}

// backfillRow persists one history row and every reaction ACCUMULATED on it
// — the second history shape (waWeb.Reaction entries on the target message,
// field 41), which whatsmeow neither reads nor merges with the standalone
// reaction messages in the same stream (ADR-0041).
//
// The row's own capture is never skipped because it carries reactions: the
// message is still the message, and the gestures are written IN ADDITION to
// it, after it — a target precedes the reaction to it, in the transcript as
// on the phone. The converse holds too, and is the reason the two writes are
// gated separately: a row with no BODY is nothing to remember as a message
// (a stub, a revoked message), but its stanza id is still everything a
// gesture on it needs, so forgetting the message must not forget the
// agreement.
//
// An entry the conversation ALSO carries standalone is dropped here rather
// than written and deduped: both compose the same seam identity, first write
// wins, and the standalone row is the one worth keeping.
func (i *Ingestor) backfillRow(webMsg *waWeb.WebMessageInfo, chat, self types.JID, standalone map[string]struct{}, shapes *historyReactionShapes) error {
	if carriesADelivery(webMsg) {
		event := historyEvent(webMsg, chat, self)
		if event.eventType() == eventTypeReaction {
			shapes.standalone++
		}
		if err := i.writeHistoryEvent(chat, event, historyOccurredAt(webMsg)); err != nil {
			return fmt.Errorf("persisting history message %s: %w", webMsg.GetKey().GetID(), err)
		}
	}
	for _, entry := range webMsg.GetReactions() {
		alsoStandalone := carriedStandalone(entry, webMsg.GetKey().GetID(), standalone)
		shapes.observe(entry, webMsg.GetKey(), alsoStandalone)
		if alsoStandalone {
			continue
		}
		// AT ITS OWN INSTANT, NOT ITS TARGET'S. This shape carries no
		// history timestamp of its own — it hangs on a message that does —
		// but it is not the message, and chronology is what a gesture means:
		// twin memory orders a chat by occurred_at and keeps no fold key, so
		// a gesture written at its target's instant is read at the wrong
		// moment, and a removal written there renders BEFORE the set it
		// retracts, leaving the withdrawn reaction reading as the one that
		// stands. So the row takes the instant the gesture states — its
		// sender timestamp when it carries one, the target's when it does
		// not, which is the same value the fold key already resolved
		// (reactionSenderTsMS). One instant, so no reader can order two
		// beats differently from another.
		gesture, at := accumulatedGesture(webMsg, entry, chat, self)
		if err := i.writeHistoryEvent(chat, gesture, at); err != nil {
			return fmt.Errorf("persisting history reaction on %s: %w", webMsg.GetKey().GetID(), err)
		}
	}
	return nil
}

// historyReactionShapes counts what the two history shapes LOOKED LIKE in
// one conversation. It exists for one reason: what an accumulated entry's
// `Key` identifies is not knowable from the proto, so the plane reads it
// per entry (accumulatedReactionEvent) and REPORTS the distribution, and
// the rig session (#102) confirms or corrects that reading against a real
// phone's blob — the verification ADR-0041 asks for, which no test with
// hand-built fixtures can supply.
//
// COUNTS ONLY, and that fence is the whole design: no JIDs, no ids, no
// text, no emoji. Content never rests in plaintext (ADR-0008) and telemetry
// is content-free by construction (ADR-0025) — this is shape telemetry, and
// a diagnostic that had to be read before it could be trusted would be the
// wrong kind of artifact to leave in a plane.
type historyReactionShapes struct {
	// WHICH conversation the line reports, without identifying it (#119):
	// whether this is the twin thread, and how many history messages the
	// walk saw. The rig session (#102) had two lines for two chats and no
	// way to tell them apart; a JID would tell them apart and would also
	// put a chat identity in the plane's log, which ADR-0025 forbids —
	// telemetry is content-free by construction, and the test on this line
	// asserts exactly that. The twin thread is the one conversation whose
	// identity is structural rather than personal (ADR-0023), so naming it
	// as such names nobody.
	twinThread         bool
	messages           int
	standalone         int
	accumulated        int
	keyAbsent          int
	keyIsTarget        int
	keyDistinct        int
	withSenderTS       int
	removals           int
	keyRestatesParent  int
	keyWithParticipant int
	alsoStandalone     int
}

// observe records one accumulated entry's shape against its parent's KEY —
// through the same readAccumulatedKey and keyRestatesParent the write path
// acts on, so the counts report the readings actually taken rather than a
// second copy of them.
func (s *historyReactionShapes) observe(entry *waWeb.Reaction, parent *waCommon.MessageKey, alsoStandalone bool) {
	s.accumulated++
	switch readAccumulatedKey(entry, parent.GetID()) {
	case keyIsAbsent:
		s.keyAbsent++
	case keyNamesTheTarget:
		s.keyIsTarget++
	case keyNamesTheReaction:
		s.keyDistinct++
	}
	// The three counts that size the readings this shape forced. The first
	// is the reactor refusal exactly as the write path computes it — if it
	// is always zero on real blobs, the refusal never fires and the ruled
	// rule stands unqualified; if it equals key_is_target, the phone sends
	// the parent's key verbatim and the refusal is the whole target-naming
	// case. The second says whether this shape carries a reactor identity at
	// all. The third says whether the phone sends the same gesture in BOTH
	// shapes, which is what the standalone preference exists for.
	if keyRestatesParent(entry, parent) {
		s.keyRestatesParent++
	}
	if entry.GetKey().GetParticipant() != "" {
		s.keyWithParticipant++
	}
	if alsoStandalone {
		s.alsoStandalone++
	}
	// Presence, not value: whether this shape carries a sender timestamp AT
	// ALL is one of the two facts spec #96 refused to assume (#97's
	// remainder 3).
	if entry.SenderTimestampMS != nil {
		s.withSenderTS++
	}
	// An absent Text and a present-but-empty one both cross as the empty
	// string, so both are counted as what they become: a removal.
	if entry.GetText() == "" {
		s.removals++
	}
}

// report emits the one structured line per in-scope conversation, through
// the plane's logging convention. Emitted even when every count is zero: a
// conversation the guard admitted and found no gesture in is itself a
// finding for #102, and a silent feed would leave "no reactions in history"
// indistinguishable from "the walk never ran". Deferred by its caller, so a
// conversation that FAILED half-way still reports what it had seen — the
// case where knowing the shapes matters most.
// Two words of WHICH conversation come first (#119: twin thread or not,
// and its size — never its identity), then the six counts the ruling named,
// in the order it named them, so a reader looking for exactly those finds
// exactly those; the three that size the readings this shape forced are
// appended after.
func (s historyReactionShapes) report() {
	log.Printf("history reactions: twin_thread=%t messages=%d standalone=%d accumulated=%d key_absent=%d key_is_target=%d key_distinct=%d with_sender_ts=%d removals=%d key_restates_parent=%d key_with_participant=%d also_standalone=%d",
		s.twinThread, s.messages,
		s.standalone, s.accumulated, s.keyAbsent, s.keyIsTarget, s.keyDistinct, s.withSenderTS, s.removals,
		s.keyRestatesParent, s.keyWithParticipant, s.alsoStandalone)
}

// writeHistoryEvent gives every history row its own write budget (mirroring
// the live path's per-event timeout): a hung database must not wedge
// whatsmeow's event-handler goroutine, and a large blob must not starve its
// tail on one shared deadline.
func (i *Ingestor) writeHistoryEvent(chat types.JID, p seamEvent, at time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), eventTimeout)
	defer cancel()
	return i.writeEvent(ctx, i.cfg.DB, chat, p, at)
}

// canonicalHistoryChat resolves a history conversation to its one guard
// identity through the SAME canonicalization core as live capture (#22
// contract, canonicalDMChat) — the history feed's PN alternative is the
// pnJID the blob itself carries on a LID-identified thread.
//
// ok is false when the blob states an identity the guard cannot resolve: a
// conversation id that does not parse as a JID, or — for a LID-identified
// thread, where the alternative IS how the identity resolves — a pnJID that
// does not. It reports no ERROR for either, and that is the point (ADR-0042).
// The unparseable value is the chat's own identity, so an error carrying it
// would put content in the plane's log (ADR-0025) and, reaching OnError, would
// let a history blob halt the binary on its contents. The caller logs the
// drop, content-free, and walks on. The error it DOES report is the
// resolution's own failure below: a store that could not be read is
// infrastructure, not contents, and it names neither.
//
// A CHAT THAT IS ALREADY PN-CANONICAL IS DECIDABLE WHATEVER ITS pnJID SAYS
// (Codex r2). canonicalDMChat reads the alternative only for a LID, so a
// malformed one on a PN thread decides nothing — and dropping that whole
// conversation would be a second content-driven loss beside the one case
// ADR-0042 permits.
//
// A LID CONVERSATION THAT STATES NO PHONE NUMBER IS WHERE AN ON-DEMAND PAGE
// WOULD HAVE DIED (ticket #222; #216's readings of 2026-09-07). The phone keys
// the answering conversation by LID and states NEITHER `pnJid` NOR `lidJid`,
// and with no alternative to canonicalize through the LID would stay the
// chat's identity: the uncached allowlist read finds no row for it — the
// allowlist carries the PN the pairing push established — and the whole
// fifty-message page is dropped as out-of-scope, silently, for a chat the rep
// has just scoped in. So the alternative is LOOKED UP when the blob states
// none: the chat directory first, then the library's own identity map
// (`pnForLID`).
//
// AND WHEN NEITHER KNOWS, NOTHING CHANGES. The LID remains the identity and
// the allowlist decides, which is the rule canonicalDMChat has always applied
// to a LID with no alternative — "the allowlist can carry it, and nothing is
// guessed". Forcing an undecidable drop here instead would take away the one
// case that rule exists for: a chat whose allowlist row IS a LID, because no
// phone number was ever delivered for it.
func (i *Ingestor) canonicalHistoryChat(ctx context.Context, conv *waHistorySync.Conversation, self types.JID) (chat types.JID, ok bool, err error) {
	chat, err = types.ParseJID(conv.GetID())
	if err != nil {
		return types.JID{}, false, nil
	}
	if !addressedByLID(chat) {
		return i.canonicalDMChat(chat, types.JID{}, self), true, nil
	}
	var alt types.JID
	if pn := conv.GetPnJID(); pn != "" {
		if alt, err = types.ParseJID(pn); err != nil {
			return types.JID{}, false, nil
		}
	} else if alt, err = i.pnForLID(ctx, chat.ToNonAD()); err != nil {
		return types.JID{}, false, err
	}
	return i.canonicalDMChat(chat, alt, self), true, nil
}

// logGuardUndecidable emits the one line the single permitted drop leaves
// (ADR-0042): the FEED it happened on and the KIND of thing dropped, and
// nothing else. No chat, no id, no text — telemetry is content-free by
// construction (ADR-0025), and the identity that could not be placed is
// exactly the content this line must not carry.
//
// It takes no arguments because there is exactly one shape of undecidable
// delivery in the plane: a whole history CONVERSATION whose identity does not
// parse. Live capture and the executor's own-send write-back cannot reach it
// — both arrive with a JID whatsmeow already parsed — so a parameter here
// would be a variable with one value.
func logGuardUndecidable() {
	log.Print("capture guard drop: feed=history kind=conversation reason=chat_identity_unparseable")
}

// carriesADelivery reports whether a history row is a DELIVERY — something
// that happened in the chat and must leave a row (ADR-0042). It carries a
// body: a stub (a call log, a group change, an encryption notice) carries
// none, and metadata is not a delivery, so stubs stay outside the seam
// exactly as receipts, presence and typing do (ADR-0023).
//
// A MESSAGE ID IS NO LONGER PART OF IT (#125). It was, because a row without
// one could neither dedupe nor be referenced — but skipping it meant a
// delivery that left no row at all, and the corpus is the only thing anyone
// measures. An id-less entry now writes an opaque row keyed by the hash of
// its own envelope, which dedupes a redelivered blob and names the absence
// rather than hiding it.
func carriesADelivery(webMsg *waWeb.WebMessageInfo) bool {
	return webMsg.GetMessage() != nil
}

// historyEvent normalizes one history row into the pinned v:1 payload the
// row's own body names — the live shape plus the backfill marker, push_name
// in exactly the #30 wire shape (additive, absent when the blob supplies
// none). Sender doctrine is the SAME code path as live capture
// (canonicalSenderJID): own-sent is self by definition; a LID or absent
// participant in a DM IS the chat, already PN-canonical; a group row's PN
// participant carries through (groups are out of slice scope, but the
// projection stays honest if one is ever allowlisted).
//
// WHICH SHAPE IS NOT DECIDED HERE (#125). This resolves the row's IDENTITY —
// the part only the history feed knows — and hands it to seamEventFor, the
// ONE per-entry decision both socket feeds apply (ADR-0042). History carries
// a reaction as a row of its own whose body is a ReactionMessage — the
// STANDALONE shape, which parses like a live delivery and carries the
// reaction's own stanza id, so its composed external id is identical to its
// live delivery's and the seam collapses the two for free. Before #101 such
// a row was written as an empty-text 'message' husk, which is what made that
// free collapse a collapse of two DIFFERENT shapes, decided by whichever feed
// landed first; before #125 every other unreadable shape still was.
//
// The direction is the row's own Key.FromMe: history is the ACCOUNT's own
// message store, so a history row states the account's perspective — unlike
// a reaction key's FromMe, which is the reactor's perspective on the target
// and decides nothing here.
func historyEvent(webMsg *waWeb.WebMessageInfo, chat, self types.JID) seamEvent {
	fromMe := webMsg.GetKey().GetFromMe()
	return seamEventFor(unwrapWebBody(webMsg), delivered{
		chat:      chat,
		senderJID: canonicalSenderJID(fromMe, historyParticipant(webMsg), chat, self),
		fromMe:    fromMe,
		messageID: webMsg.GetKey().GetID(),
		pushName:  webMsg.GetPushName(),
		at:        historyOccurredAt(webMsg),
		backfill:  true,
	})
}

// accumulatedGesture normalizes ONE accumulated entry — a waWeb.Reaction
// hanging off the target message — into the seam event the ONE per-entry
// decision names for it (seamEventFor), plus the instant the row lands at.
// Nothing about the shape is re-derived here: only its identity has to be
// decided, because the container says less than the standalone one does.
//
// IT GOES THROUGH THE SAME DECISION AS EVERY OTHER DELIVERY (#125). A gesture
// whose target states no id points at nothing, and that is the same
// malformation the live feed and the standalone shape have — so a parent with
// no stanza id yields an opaque row naming `reaction_to` rather than a
// 'reaction' row whose `reaction_to` is the empty string, which decodes and
// renders as a gesture at nothing (ADR-0042).
//
// WHAT THE ENTRY'S KEY IDENTIFIES IS DECIDED PER ENTRY, BY COMPARISON, and
// that is not a guess dressed up as a rule. The proto carries no comment on
// the field and whatsmeow never reads it, so no code can say in general
// whether `Key` is the reaction's own key or the target's — but for one
// concrete entry the question is answerable: an id that is NOT the parent's
// can only be the reaction's own, and an id that IS the parent's (or is
// absent) named the target and leaves the gesture with no rail identity.
//
//	own id      → message_id = Key.ID, so the composed external event id is
//	              byte-identical to the live/standalone delivery's and the
//	              seam collapses the two for free (ADR-0041).
//	target id   → SYNTHESIZE: syntheticReactionID, deterministic from the
//	or absent     blob alone, so a redelivered batch writes zero new rows.
//
// The synthetic case can never match a live row's id, so an entry of that
// kind whose reaction WAS also captured live yields two rows with different
// ids. That is accepted and recorded (#101), not designed around: a
// consumer needing current state folds per (reactor, target) by
// sender_ts_ms, and a transcript shows the same beat twice. Inventing a
// content-based match would be the plane judging, which it does not do
// (ADR-0005).
//
// The target is the PARENT — the nesting is the pointer, and it is the one
// thing this shape states unambiguously. It is passed as the parent's own
// message key, which is exactly what a live ReactionMessage.Key is: the
// reactor's key for the message reacted to.
func accumulatedGesture(webMsg *waWeb.WebMessageInfo, entry *waWeb.Reaction, chat, self types.JID) (seamEvent, time.Time) {
	reading := readAccumulatedKey(entry, webMsg.GetKey().GetID())
	// THE REACTOR IS THE ENTRY'S KEY, ALWAYS — Key.Participant when it names
	// one, else Key.FromMe, through the one sender doctrine every feed
	// shares. The id comparison decides the row's IDENTITY and nothing else;
	// it is not evidence about who reacted.
	//
	// AND THAT IS A COPY THE PLANE MAKES WITHOUT KNOWING, which is worth
	// naming here rather than in a ticket nobody reads. If a phone fills
	// this key with the TARGET's key verbatim, its FromMe is the target
	// SENDER's — so a customer's 👍 on the rep's own quote would land
	// from_me:true. There is no safe default to retreat to: ADR-0041 makes a
	// gesture agreement in BOTH directions, so a wrong reactor misstates an
	// agreement whichever way it falls, and inventing a direction would be
	// the plane judging (ADR-0005). What can be done instead is done: the
	// wrong reading cannot reach a FILED fact, because backfill never enters
	// the extraction transcript (extraction-pass.ts) and a cited reaction is
	// refused until #98; and `key_restates_parent` in the diagnostic counts
	// exactly the entries where this copy is possible, so #102 sizes it from
	// real blobs and the rule is corrected with evidence rather than by
	// argument.
	fromMe := entry.GetKey().GetFromMe()
	reactor := canonicalSenderJID(fromMe, parseParticipant(entry.GetKey().GetParticipant()), chat, self)
	r := asReactionMessage(entry, webMsg.GetKey())
	// THE INSTANT IS RESOLVED BEFORE THE SHAPE IS CHOSEN, because the
	// synthetic identity keys on it — the entry's own sender timestamp when
	// it carries one, the parent's historical instant when it does not, which
	// is exactly what reactionSenderTsMS answers for the fold key. Resolving
	// it once means the row's id, its sender_ts_ms and its occurred_at can
	// never disagree, whichever shape the decision below picks.
	at := time.UnixMilli(reactionSenderTsMS(r, historyOccurredAt(webMsg))).UTC()
	d := delivered{
		chat:      chat,
		senderJID: reactor,
		fromMe:    fromMe,
		messageID: entry.GetKey().GetID(),
		// No push name: the accumulated shape carries none, and the parent's
		// belongs to the parent's sender — stamping it on a gesture that may
		// be someone else's would be an invention. Absent, never an empty
		// stamp (the #30 wire rule).
		at:       at,
		backfill: true,
	}
	if reading != keyNamesTheReaction {
		d.messageID = syntheticReactionID(webMsg.GetKey().GetID(), reactor, at.UnixMilli())
	}
	return seamEventFor(&waE2E.Message{ReactionMessage: r}, d), at
}

// accumulatedKeyReading is what ONE accumulated entry's key turned out to
// identify, decided against its parent's id. The three readings are the
// whole of what this shape can say, and BOTH the identity decision and the
// reactor decision hang off the same one — read here once so the two can
// never drift, and counted by the same function so the diagnostic reports
// the reading the plane actually acted on.
type accumulatedKeyReading int

const (
	// keyNamesTheReaction — an id that is not the parent's can only be the
	// reaction's own stanza id, so the whole key is the REACTION's: its
	// direction and participant are the reactor's, and its id dedupes
	// against the live delivery for free.
	keyNamesTheReaction accumulatedKeyReading = iota
	// keyNamesTheTarget — the key repeats the parent's id, so it is the
	// TARGET's key and nothing on it describes the reactor.
	keyNamesTheTarget
	// keyIsAbsent — no key, or a key carrying no id: nothing to read at all.
	keyIsAbsent
)

func readAccumulatedKey(entry *waWeb.Reaction, target string) accumulatedKeyReading {
	switch id := entry.GetKey().GetID(); {
	case id == "":
		return keyIsAbsent
	case id == target:
		return keyNamesTheTarget
	default:
		return keyNamesTheReaction
	}
}

// carriedStandalone reports whether this entry is the same reaction the
// conversation ALSO carries standalone — a question only answerable where
// the entry states the reaction's own stanza id, since that is the only
// identity the two shapes can be compared on. An entry whose key names the
// target is never a match, however that target's own id was indexed.
func carriedStandalone(entry *waWeb.Reaction, target string, standalone map[string]struct{}) bool {
	if readAccumulatedKey(entry, target) != keyNamesTheReaction {
		return false
	}
	_, ok := standalone[entry.GetKey().GetID()]
	return ok
}

// keyRestatesParent reports whether an accumulated entry's key is the
// PARENT's own key repeated — the same id, the same direction and the same
// participant. It DECIDES NOTHING: the reactor rule reads the key either way
// (accumulatedReactionEvent says why). It is the measurement of the one
// thing no code can settle — whether a phone fills this field with the
// target's key, in which case its direction is the target sender's and every
// gesture of this kind carries the wrong reactor. Counted per conversation
// so #102 can answer it from real blobs: zero means the copy never happens
// and the ruled rule stands unqualified; equal to key_is_target means the
// phone always copies, and the reactor rule needs re-ruling with that fact
// in hand.
func keyRestatesParent(entry *waWeb.Reaction, parent *waCommon.MessageKey) bool {
	key := entry.GetKey()
	return key != nil &&
		key.GetID() == parent.GetID() &&
		key.GetFromMe() == parent.GetFromMe() &&
		key.GetParticipant() == parent.GetParticipant()
}

// asReactionMessage re-expresses one accumulated entry as the rail's
// ordinary ReactionMessage — the same gesture in the other container — so
// both history shapes and live capture compose the pinned wire shape
// through the ONE newReactionPayload rather than through copies of it. The
// three facts an entry carries are exactly the three that builder reads:
// the target key, the emoji text (nil and "" both meaning what they mean
// there), and the sender timestamp when the shape supplies one — including
// its absence, which the builder answers with the documented
// delivery-instant fallback (here the parent's historical instant, the same
// one written to occurred_at).
func asReactionMessage(entry *waWeb.Reaction, target *waCommon.MessageKey) *waE2E.ReactionMessage {
	return &waE2E.ReactionMessage{
		Key:               target,
		Text:              entry.Text,
		SenderTimestampMS: entry.SenderTimestampMS,
	}
}

// syntheticReactionID is the deterministic stand-in identity for an
// accumulated entry that carries no rail id of its own:
//
//	<target stanza id>:r:<reactor's bare JID>:<sender_ts_ms>
//
// composed into the seam's external event id by externalEventID like any
// other stanza id, so the row keys as <chat>:<target>:r:<reactor>:<ts>.
//
// Deterministic from the blob alone — every part is read from the entry or
// its parent, never from the clock — so the same history delivered twice
// composes the same id and the seam's ON CONFLICT DO NOTHING writes nothing
// the second time. Distinguishable from a rail id on sight (a WhatsApp
// stanza id carries no colons), which is what keeps it from ever colliding
// with a real delivery's row.
//
// The three parts are the identity of the gesture as this shape states it:
// WHO reacted, to WHAT, and WHEN. Two entries agreeing on all three are the
// same reaction as far as anything the plane can read — which is also this
// recipe's one lossy edge, recorded on #101: a reactor who set and then
// changed a reaction on one target, both entries accumulated with neither
// an own id NOR a sender timestamp, collapses to one row.
func syntheticReactionID(target, reactor string, senderTsMS int64) string {
	return target + ":r:" + reactor + ":" + strconv.FormatInt(senderTsMS, 10)
}

// unwrapWebBody unwraps the body a WebMessageInfo carries the way whatsmeow's
// live pipeline does before dispatch (events.Message.UnwrapRaw — Codex r1):
// a disappearing-mode chat wraps every body in EphemeralMessage (view-once
// and device-sent wrappers ride the same mechanism), and normalization
// consistent with the live path means reading the same unwrapped body live
// capture sees — not the wrapper, which would land the whole past as empty
// text.
//
// TWO CALLERS, ONE CONTAINER (#125): every history row, and the live delivery
// whatsmeow recovers through a placeholder resend, which arrives carrying the
// WebMessageInfo it was rebuilt from (unfoldedEdit says why that matters).
func unwrapWebBody(webMsg *waWeb.WebMessageInfo) *waE2E.Message {
	return (&events.Message{RawMessage: webMsg.GetMessage()}).UnwrapRaw().Message
}

// historyParticipant extracts the sender identity a history row records,
// when it records one — the zero JID otherwise (canonicalSenderJID then
// resolves the sender to the chat, the DM rule).
func historyParticipant(webMsg *waWeb.WebMessageInfo) types.JID {
	participant := webMsg.GetParticipant()
	if participant == "" {
		participant = webMsg.GetKey().GetParticipant()
	}
	return parseParticipant(participant)
}

// parseParticipant reads one recorded participant identity — the zero JID
// when the blob records none or records something unparseable, which
// canonicalSenderJID then resolves by the DM rule. Shared by the two places
// history states a sender: the row itself and an accumulated reaction entry.
func parseParticipant(participant string) types.JID {
	if participant == "" {
		return types.JID{}
	}
	p, err := types.ParseJID(participant)
	if err != nil {
		return types.JID{}
	}
	return p
}

// historyOccurredAt is the message's original send time — history lands
// with its own past, not the sync's present.
func historyOccurredAt(webMsg *waWeb.WebMessageInfo) time.Time {
	return time.Unix(int64(webMsg.GetMessageTimestamp()), 0).UTC()
}

// Package directory is the chat directory (ticket #222; spec #214 decision
// 7): for every conversation the plane sees, in scope or not, the chat's two
// identities, its kind, its display name SEALED, when it was last active, one
// forward-only anchor, and the ninety-day fill's progress. Never content.
//
// WHY IT EXISTS. The initial history push is dropped at the socket for every
// chat the rep did not scope (ADR-0023), so nothing else in the plane
// remembers that such a conversation exists — and the on-demand history
// request needs a MESSAGE to page backwards from. This table is the anchor's
// home, which is what makes scoping a standing capability rather than a
// one-shot at pairing: a chat scoped in a month later still has a way back to
// its history.
//
// WHAT LEAVES THE SOCKET, exactly (ADR-0023 as ticket #222 amends it):
// metadata, a LID and an anchor of an out-of-scope chat now do, sealed where
// they are a name; CONTENT never does. The per-event allowlist read is
// unchanged, uncached, and still drops every out-of-scope message before
// persistence.
//
// THE NAME IS THE ONE SEALED THING HERE, and this package never sees it in
// the clear: the caller seals it in plane custody (ADR-0008's exactly-two
// custody points) and hands over ciphertext. Nothing in this file logs
// anything at all — a chat's name and a chat's identity are precisely what a
// plane log must not carry (ADR-0025).
//
// IT TAKES THE REQUEST SEAM'S OWN WORD FOR A FILL'S END (ticket #245 F17), and
// that is why a store depends on `plane/planereq` at all: the marker this row
// carries and the word the request row carries are ONE vocabulary, derived in
// that package and swept against this table's CHECK there. A second spelling
// here would be the drift the sweep exists to catch.
package directory

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/planereq"
)

// Kind is what the rail's ADDRESS SPACE divides into — the plane's reading of
// an address, never a product taxonomy (ADR-0005: the plane judges nothing).
// `@dito/seam`'s CHAT_KINDS is the other copy and `chat_directory_kind_check`
// the third, swept together by `migration-vocabulary.test.ts`.
type Kind string

const (
	// KindSelf is the rep's own thread, whose scope is structural rather than
	// an allowlist row (ADR-0023) — the one chat whose identity is structural
	// rather than personal.
	KindSelf Kind = "self"
	// KindDM is one counterparty, addressed by phone number or by LID.
	KindDM Kind = "dm"
	// KindGroup is a group thread.
	KindGroup Kind = "group"
	// KindOther is anything else the rail addresses: a broadcast or status
	// list today, WhatsApp's own system account, whatever WhatsApp adds
	// tomorrow. It exists so a fifth address server is a row the directory can
	// hold rather than a conversation it silently forgets — which is the
	// failure this table is here to end.
	KindOther Kind = "other"
)

// SystemUser is WhatsApp's own account on the default server, the address its
// announcements arrive from (boundary #225, F32).
//
// IT IS A RESERVED ADDRESS AND NOT A JUDGEMENT, which is what keeps this
// inside ADR-0005: user `0` names no counterparty in the rail's address space,
// the way `status` names none on the broadcast server. Read as a `dm` it sat
// in the directory as somebody to scope, was offered on the scoping page as
// «Chat por conocer», was marked, and its fill refused `no_lid` — a chat with
// no person behind it, no history worth ninety days and no customer the record
// could be about.
const SystemUser = "0"

// Kinds is the closed set in one place, for the test that pins it against the
// store's CHECK and against the seam package's copy.
var Kinds = []Kind{KindSelf, KindDM, KindGroup, KindOther}

// KindOf reads a chat's kind off its address and the live session identity —
// the same two inputs the capture guard decides scope from, so a row's kind
// and its scope can never disagree about which chat is the twin thread.
func KindOf(chat, self types.JID) Kind {
	bare := chat.ToNonAD()
	if !self.IsEmpty() && bare == self.ToNonAD() {
		return KindSelf
	}
	switch bare.Server {
	case types.DefaultUserServer:
		if bare.User == SystemUser {
			return KindOther
		}
		return KindDM
	case types.HiddenUserServer:
		return KindDM
	case types.GroupServer:
		return KindGroup
	default:
		return KindOther
	}
}

// Anchor is the message the on-demand history request pages backwards from:
// the three facts whatsmeow's own builder takes (its stanza id, its direction
// and its instant). The zero value states none.
type Anchor struct {
	MessageID string
	FromMe    bool
	At        time.Time
}

// Stated reports whether an anchor is a whole one. The store refuses two of
// the three (`chat_directory_anchor_whole_check`), because a request cannot be
// built from a stanza id with no instant — a chat that looked fillable and was
// not would be worse than one that says it has no anchor. Exported because the
// fill asks it too, of a row it read back and of the page it just received.
func (a Anchor) Stated() bool {
	return a.MessageID != "" && !a.At.IsZero()
}

// AnchorFromHistoryRow reads one history row as a candidate anchor, or reports
// that it is not one.
//
// TWO CALLERS, ONE RULE. The capture guard folds the NEWEST of a
// conversation's candidates into the directory row; the fill folds the OLDEST
// of a page's, because that is the next request's anchor. A copy of this rule
// in each is how the two come to disagree about what a page can be asked from.
//
// THREE REASONS A ROW IS NOT AN ANCHOR:
//
//	no rail stanza id — it names nothing the phone could find.
//	no instant        — whatsmeow's request states the anchor's instant, and a
//	                    history timestamp is optional in the proto: an absent
//	                    one crosses as zero, and a request anchored at the Unix
//	                    epoch asks for the fifty messages before 1970.
//	a reaction        — a GESTURE IS NOT A POSITION. It states its own stanza
//	                    id, but the request means "the messages immediately
//	                    before this MESSAGE", and a gesture is not a place in
//	                    the chat's message history (`historyspike/anchor.go`
//	                    argues it in full).
//
// EVERY OTHER SHAPE IS AN ANCHOR, including the ones the seam records as
// opaque rows — a photo, a voice note, an edit. The seam READER had to exclude
// those because an opaque row states a COMPOSED id (`<stanza>:opaque`) rather
// than a rail one; this reads the BLOB, where the rail's own id is present
// whatever the body was, so a chat whose last beats are photos has an anchor
// rather than one buried further back.
//
// The body is unwrapped the way whatsmeow's own live pipeline unwraps it
// before dispatch: a disappearing-mode chat wraps every body in
// EphemeralMessage, so reading the wrapper would call a wrapped gesture an
// ordinary message.
func AnchorFromHistoryRow(webMsg *waWeb.WebMessageInfo) (Anchor, bool) {
	id := webMsg.GetKey().GetID()
	if id == "" || webMsg.GetMessageTimestamp() == 0 {
		return Anchor{}, false
	}
	unwrapped := (&events.Message{RawMessage: webMsg.GetMessage()}).UnwrapRaw().Message
	if unwrapped.GetReactionMessage() != nil {
		return Anchor{}, false
	}
	return Anchor{
		MessageID: id,
		FromMe:    webMsg.GetKey().GetFromMe(),
		At:        time.Unix(int64(webMsg.GetMessageTimestamp()), 0).UTC(),
	}, true
}

// Entry is one upsert's worth of what a feed learned about a chat. EVERY
// FIELD BUT THE CHAT AND THE KIND IS OPTIONAL, and its zero value means "this
// feed says nothing about that" rather than "blank it": a contact sync carries
// a name and no anchor, a history sync carries both, and neither may erase
// what the other knew.
type Entry struct {
	// Chat is the chat's one guard identity, PN-canonical (the ingest's
	// canonicalDMChat), so a directory row, an allowlist row and a wa_events
	// row all name the same chat by the same name.
	Chat types.JID
	// LID is the chat's hidden-user identity when the feed stated one. It is
	// what makes a later scope-in askable at all — the phone answers an
	// on-demand request only when the chat is addressed by its LID (#216's
	// readings of 2026-09-07) — so it is FILLED AND NEVER BLANKED.
	LID  types.JID
	Kind Kind
	// NameEnc is the display name already sealed under the twin DEK by the
	// caller (ADR-0008). nil says the feed carried none.
	NameEnc []byte
	// LastActivityAt moves forward only: the scoping page orders by it, so a
	// chat whose activity went backwards would move under the rep's finger.
	LastActivityAt time.Time
	Anchor         Anchor
}

// Row is what the fill reads back: the two facts a page can be asked with,
// and the progress a sitting continues from.
type Row struct {
	LID    types.JID
	Anchor Anchor
	Pages  int
	// OldestAt is the oldest instant the fill has reached so far; zero when
	// nothing has been paged yet.
	OldestAt time.Time
}

// ErrNoRow marks a chat the directory has never seen — the plane has no anchor
// for it, so a fill for it is refused by name rather than asked for.
var ErrNoRow = errors.New("the chat directory holds no row for this chat")

// Store writes and reads one twin's directory. Read-and-write, and never a
// judgement: the plane stamps what the rail told it (ADR-0005).
type Store struct {
	db     *sql.DB
	twinID string
}

// New builds a store for the configured twin — one plane process, one twin.
func New(db *sql.DB, twinID string) *Store {
	return &Store{db: db, twinID: twinID}
}

// anchorMovesForward is THE ONE PREDICATE the three anchor columns move
// together under, named once because three columns ask it and a copy per
// column is how two of them come to disagree about which anchor stands.
//
// STRICTLY LATER, and the strictness is the point: two messages can share a
// whole-second history timestamp, and nothing in a history blob orders them,
// so "later or equal" would let an arbitrary one of a second's messages win
// each time the same blob is redelivered — an anchor that moves under the
// fill without moving forward. An anchor that goes BACKWARDS is the failure
// this exists to refuse outright: it would ask the phone for a window the
// fill has already paged through, and a fill that re-asks its own pages never
// ends.
const anchorMovesForward = `EXCLUDED.anchor_at IS NOT NULL
	AND (chat_directory.anchor_at IS NULL OR EXCLUDED.anchor_at > chat_directory.anchor_at)`

// Upsert records what one feed learned about one chat.
//
// ONE STATEMENT, so two feeds arriving together cannot read one row and write
// two: every "keep what was there" rule is an expression on the conflict
// target rather than a read followed by a write. `COALESCE` is the absent-says-
// nothing rule for the LID and the name; `GREATEST` is it for last activity
// (PostgreSQL's GREATEST ignores NULLs, so a first row and a later one take the
// same path); and the anchor moves under the one predicate above.
//
// THE KIND IS REPLACED RATHER THAN KEPT, and that is deliberate: it is derived
// from the address and the live session identity, so a later reading of the
// same chat is a BETTER reading — the twin thread's own chat is `dm` until the
// session identity is known and `self` after it, and freezing the first answer
// would leave the rep's own thread on the scoping page as a counterparty.
func (s *Store) Upsert(ctx context.Context, e Entry) error {
	var lid any
	if !e.LID.IsEmpty() {
		lid = e.LID.ToNonAD().String()
	}
	var lastActivity, anchorAt any
	if !e.LastActivityAt.IsZero() {
		lastActivity = e.LastActivityAt.UTC()
	}
	var anchorID, anchorFromMe any
	if e.Anchor.Stated() {
		anchorID, anchorFromMe, anchorAt = e.Anchor.MessageID, e.Anchor.FromMe, e.Anchor.At.UTC()
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO chat_directory
		   (twin_id, chat_jid, lid_jid, kind, name_enc, last_activity_at,
		    anchor_message_id, anchor_from_me, anchor_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT ON CONSTRAINT chat_directory_twin_chat_key DO UPDATE SET
		   lid_jid = COALESCE(EXCLUDED.lid_jid, chat_directory.lid_jid),
		   kind = EXCLUDED.kind,
		   name_enc = COALESCE(EXCLUDED.name_enc, chat_directory.name_enc),
		   last_activity_at = GREATEST(EXCLUDED.last_activity_at, chat_directory.last_activity_at),
		   anchor_message_id = CASE WHEN `+anchorMovesForward+`
		     THEN EXCLUDED.anchor_message_id ELSE chat_directory.anchor_message_id END,
		   anchor_from_me = CASE WHEN `+anchorMovesForward+`
		     THEN EXCLUDED.anchor_from_me ELSE chat_directory.anchor_from_me END,
		   anchor_at = CASE WHEN `+anchorMovesForward+`
		     THEN EXCLUDED.anchor_at ELSE chat_directory.anchor_at END,
		   updated_at = clock_timestamp()`,
		s.twinID, e.Chat.ToNonAD().String(), lid, string(e.Kind), e.NameEnc, lastActivity,
		anchorID, anchorFromMe, anchorAt,
	)
	if err != nil {
		// THE CHAT IS NOT IN THE MESSAGE, and this is one of the two places
		// that rule is easy to break: an error naming the row would put a chat
		// identity in the plane's log the moment a caller reports it
		// (ADR-0025). The twin is not content and the failing statement is.
		return fmt.Errorf("upserting a chat directory row for twin %s: %w", s.twinID, err)
	}
	return nil
}

// Read returns what the fill needs to ask about one chat. ErrNoRow is the
// honest answer for a chat the plane has never seen: the fill refuses by name
// rather than putting a request on the socket that can only come back empty.
func (s *Store) Read(ctx context.Context, chat types.JID) (Row, error) {
	var lid sql.NullString
	var anchorID sql.NullString
	var anchorFromMe sql.NullBool
	var anchorAt, oldestAt sql.NullTime
	var row Row
	err := s.db.QueryRowContext(ctx,
		`SELECT lid_jid, anchor_message_id, anchor_from_me, anchor_at, fill_pages, fill_oldest_at
		   FROM chat_directory WHERE twin_id = $1 AND chat_jid = $2`,
		s.twinID, chat.ToNonAD().String(),
	).Scan(&lid, &anchorID, &anchorFromMe, &anchorAt, &row.Pages, &oldestAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Row{}, ErrNoRow
	}
	if err != nil {
		return Row{}, fmt.Errorf("reading a chat directory row for twin %s: %w", s.twinID, err)
	}
	if lid.Valid {
		// A stored LID that does not parse is the same absence as no LID at
		// all: the fill refuses `no_lid` rather than addressing a request with
		// something the phone cannot resolve. The store's own CHECK makes this
		// unreachable through this plane; a hand-written row is why it is
		// still asked.
		if parsed, parseErr := types.ParseJID(lid.String); parseErr == nil {
			row.LID = parsed.ToNonAD()
		}
	}
	if anchorID.Valid && anchorAt.Valid {
		row.Anchor = Anchor{MessageID: anchorID.String, FromMe: anchorFromMe.Bool, At: anchorAt.Time.UTC()}
	}
	if oldestAt.Valid {
		row.OldestAt = oldestAt.Time.UTC()
	}
	return row, nil
}

// PNForLID answers "which chat is this LID" — the resolution that keeps an
// on-demand page from being dropped as undecidable.
//
// WHY THE INGEST NEEDS IT (#216's readings of 2026-09-07). The phone keys the
// answering conversation by LID and states NEITHER `pnJid` NOR `lidJid`, so
// `canonicalHistoryChat` has no alternative to canonicalize through and would
// call the thread undecidable and drop the whole page (ADR-0042's one
// permitted drop). The directory row is the alternative: it carries both
// identities for every chat the plane has ever seen.
//
// ok is false for a LID no row names, which is not an error — it is the
// caller's cue to ask the library's own map next.
//
// AND FOR A ROW THAT ANSWERS WITH THE LID ITSELF (Codex r1). A chat the rail
// only ever addressed by LID keys its row on that LID, and its `lid_jid` is
// the same value — so this lookup would find that row and hand the LID back
// as if it were a phone number. The caller would take it as a resolution and
// STOP, never asking the library, which may have learned the PN from the
// mapping table the phone sends inside its own history sync. So the predicate
// says PHONE NUMBER: a row that knows no more than the caller already did
// answers nothing, and the resolution walks on.
//
// The query is also written to survive the non-unique index the same shape
// implies — two rows can name one LID while a chat's identity is migrating,
// and the PN-keyed one is the only one worth returning.
func (s *Store) PNForLID(ctx context.Context, lid types.JID) (types.JID, bool, error) {
	var chat string
	err := s.db.QueryRowContext(ctx,
		`SELECT chat_jid FROM chat_directory
		  WHERE twin_id = $1 AND lid_jid = $2 AND chat_jid LIKE '%@' || $3
		  ORDER BY chat_jid
		  LIMIT 1`,
		s.twinID, lid.ToNonAD().String(), types.DefaultUserServer,
	).Scan(&chat)
	if errors.Is(err, sql.ErrNoRows) {
		return types.JID{}, false, nil
	}
	if err != nil {
		return types.JID{}, false, fmt.Errorf("reading the chat directory's LID map for twin %s: %w", s.twinID, err)
	}
	parsed, err := types.ParseJID(chat)
	if err != nil || parsed.ToNonAD().Server != types.DefaultUserServer {
		// Same reading as an unparseable stored LID, and the same silence
		// about the value: it is a chat identity.
		return types.JID{}, false, nil
	}
	return parsed.ToNonAD(), true, nil
}

// StartFill opens an attempt on one chat: the previous attempt's stop marker
// goes, and whether history was ALREADY on the row is stamped in its place
// (ticket #245 F17 and the F23 rider).
//
// EVERY ATTEMPT, INCLUDING ONE THAT IS ABOUT TO BE REFUSED. The fill calls this
// before it decides anything, so the resumed fact is computed from the page
// count that stood when the attempt BEGAN — and a chat marked again whose fill
// is then refused still tells the rep that the twin takes it up from today. A
// chat the directory has never seen has no attempt to open, so a statement that
// finds no row is not a failure here: it is the same absence
// `no_directory_row` names.
//
// THE MARKER IS CLEARED WHEN THE FILL STARTS AND NOT WHEN THE REP ASKS,
// because the plane is what knows the attempt has started: requests are served
// one at a time, so a chat re-scoped while another chat's sitting runs waits
// its turn, and a marker cleared at the act would say «working» over a fill
// nothing has begun. What tells a reader the difference in the meantime is the
// scoping's own instant, which is older than a live marker and newer than a
// stale one (`fill.ts` reads exactly that comparison).
//
// AND THE RESUMED FACT IS COMPUTED IN THIS STATEMENT because it cannot be
// recovered afterwards: once the attempt has moved the page count, a first fill
// and a resumed one are identical from the outside. A resumed fill means a hole
// no fill can close — the on-demand request returns only messages OLDER than
// its anchor — so the fact is the rep's to be told, and this is the one
// statement in which it is knowable.
func (s *Store) StartFill(ctx context.Context, chat types.JID) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE chat_directory
		    SET fill_stopped_at = NULL,
		        fill_stopped_by = NULL,
		        fill_resumed = fill_pages > 0,
		        updated_at = clock_timestamp()
		  WHERE twin_id = $1 AND chat_jid = $2`,
		s.twinID, chat.ToNonAD().String(),
	)
	if err != nil {
		return fmt.Errorf("opening a fill on a chat's directory row for twin %s: %w", s.twinID, err)
	}
	return nil
}

// RecordPage moves one chat's fill progress after a page has landed, and
// stamps the fill's END when this page is the last one — IN THE SAME
// STATEMENT.
//
// AFTER EVERY PAGE, not once at the end (spec #214 *Link day, in detail*: "the
// plane records per-chat fill progress on the directory row"). A sitting that
// is interrupted — the phone stops answering, the plane is stopped — has to
// leave behind what it actually fetched, or the rep watches a progress view
// that says nothing happened over history that is already in their twin.
//
// THE STOP RIDES WITH THE PAGE, AND ONE STATEMENT IS THE WHOLE POINT (ticket
// #245 F17). The page that reaches past the ninety-day line moves
// `fill_oldest_at` PAST that line, and the card labels itself with that
// instant — so a row that showed the page and not yet its stop would say
// «Trayendo tu historial … Ya llegó hasta el 17 de mayo», which is a date
// outside the window the product promised, and is exactly what the rig showed.
// Written together, that row cannot exist: either both land or neither does,
// and the CHECK on the marker's own word is what makes the "neither" case a
// rolled-back page rather than a page with a bad marker.
//
// An empty `stop` clears the marker rather than leaving it, which is the same
// statement saying «this attempt is still running» — so a stale marker cannot
// survive a page either.
//
// The oldest instant moves BACKWARDS only (LEAST ignores NULLs, so the first
// page and a later one take the same path) and the phone's word is replaced
// only when the page states one: a page that says nothing about the rest of
// the chat's history says nothing, and must not erase what the previous page
// said.
func (s *Store) RecordPage(ctx context.Context, chat types.JID, oldest time.Time, endOfTransfer string, stop planereq.FillStop) error {
	var oldestAt, word, stopped any
	if !oldest.IsZero() {
		oldestAt = oldest.UTC()
	}
	if endOfTransfer != "" {
		word = endOfTransfer
	}
	if stop != "" {
		stopped = string(stop)
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE chat_directory
		    SET fill_pages = fill_pages + 1,
		        fill_oldest_at = LEAST(fill_oldest_at, $3),
		        fill_end_of_transfer = COALESCE($4, fill_end_of_transfer),
		        fill_last_at = clock_timestamp(),
		        fill_stopped_at = CASE WHEN $5::text IS NULL
		                               THEN NULL ELSE clock_timestamp() END,
		        fill_stopped_by = $5,
		        updated_at = clock_timestamp()
		  WHERE twin_id = $1 AND chat_jid = $2`,
		s.twinID, chat.ToNonAD().String(), oldestAt, word, stopped,
	)
	if err != nil {
		return fmt.Errorf("recording a fill page for twin %s: %w", s.twinID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("recording a fill page for twin %s: %w", s.twinID, err)
	}
	if n != 1 {
		// The fill read the row before it asked, so a row that has vanished
		// mid-sitting is a broken invariant rather than a state to page past —
		// and the chat is not in the message, because a chat identity is
		// exactly what a plane log may not carry (ADR-0025).
		return fmt.Errorf("recording a fill page for twin %s touched %d rows — the chat's directory row vanished mid-fill", s.twinID, n)
	}
	return nil
}

// ProjectStops re-derives the marker of every row whose newest SETTLED
// scope-in ended after the marker it carries — which is the whole of the
// marker's recovery, in one idempotent statement (ticket #245 F17, Codex r2).
//
// THE MARKER IS A PROJECTION OF THE REQUEST ROW, and reading it that way is
// what makes it self-healing. The fill stamps its own end as it goes, and that
// write can fail or its process can stop between the stamp and the settle — so
// the marker's correctness cannot rest on one UPDATE landing at the right
// moment. What it rests on instead is the request row: an ask that ended has a
// settled row carrying the very word the marker holds (`stopped_by` when it
// was served, `reason` otherwise), and this statement copies it. Run at the top
// of every pass, an end that was not stamped is stamped a second later,
// whatever went wrong.
//
// WHICH ASK IS THE NEWEST IS DECIDED BY WHEN IT WAS ASKED, never by when it
// settled (Codex r3). Settling is absorbed on failure, so an earlier request
// whose settle failed is settled `interrupted` by a LATER pass — with a later
// `settled_at` than a newer request the loop served in the meantime. Ordered by
// settlement, the projection would then pick the older attempt and overwrite
// the newer one's correct word, and keep doing it on every pass. `requested_at`
// is the runtime's own stamp on the ask and cannot be reordered by a failure;
// `id` breaks a tie within one instant.
//
// AND IT IS ATTEMPT-AWARE BY TIMING FOR THE MARKER ITSELF, which is the
// alternative to carrying an attempt id through two tables. A marker stamped
// AFTER the newest settled ask belongs to a NEWER attempt — the one running
// right now, whose request is still unsettled — so it is left alone; a marker
// stamped before that ask, or missing, is the one this projection owes. That is
// also what keeps a stranded re-scope honest: the sweep above settles it
// `interrupted`, and this stamps that word over the previous attempt's stop
// rather than leaving the row claiming a fill nobody is doing.
//
// `malformed_parameter` IS THE ONE WORD SKIPPED: it belongs to an ask whose
// chat does not parse, so it names no row here, and the marker's CHECK does not
// hold it (…20260909100020's backfill makes the same exclusion for the same
// reason — this statement is that backfill run on a clock).
func (s *Store) ProjectStops(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE chat_directory d
		    SET fill_stopped_at = r.settled_at,
		        fill_stopped_by = COALESCE(r.stopped_by, r.reason),
		        updated_at = clock_timestamp()
		   FROM (SELECT DISTINCT ON (chat_jid)
		                chat_jid, settled_at, stopped_by, reason
		           FROM plane_requests
		          WHERE twin_id = $1
		            AND kind = $2
		            AND outcome IS NOT NULL
		            AND settled_at IS NOT NULL
		            AND COALESCE(stopped_by, reason) <> $3
		          ORDER BY chat_jid, requested_at DESC, id DESC) r
		  WHERE d.twin_id = $1
		    AND d.chat_jid = r.chat_jid
		    AND (d.fill_stopped_at IS NULL OR d.fill_stopped_at < r.settled_at)`,
		s.twinID, string(planereq.KindScopeIn), string(planereq.ReasonMalformedParameter),
	)
	if err != nil {
		return fmt.Errorf("projecting the fills' stops for twin %s: %w", s.twinID, err)
	}
	return nil
}

// RecordStop stamps the fill's end on a chat whose LAST PAGE could not carry
// it — the attempt that was refused by name before a request went out, the one
// the phone stopped answering, the one the rep switched off mid-sitting, and
// the one the plane itself failed (ticket #245 F17).
//
// EVERY END LEAVES A MARKER, AND THAT IS THE INVARIANT THE CARD RESTS ON. An
// attempt that ended and said nothing reads as one still working, and the card
// it feeds would stand on Inicio for ever over a chat nothing will ever fill —
// a group, a chat whose only record came from a contact edit, a chat scoped
// while the rail was down.
//
// A CHAT WITH NO ROW IS NOT A FAILURE HERE, which is the one place this store
// differs from `RecordPage`: the fill stamps its outcome by one rule with no
// exception, and for a chat the directory has never seen there is no row to
// mark — the same absence `no_directory_row` names.
func (s *Store) RecordStop(ctx context.Context, chat types.JID, stop planereq.FillStop) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE chat_directory
		    SET fill_stopped_at = clock_timestamp(),
		        fill_stopped_by = $3,
		        updated_at = clock_timestamp()
		  WHERE twin_id = $1 AND chat_jid = $2`,
		s.twinID, chat.ToNonAD().String(), string(stop),
	)
	if err != nil {
		return fmt.Errorf("stamping a fill's stop for twin %s: %w", s.twinID, err)
	}
	return nil
}

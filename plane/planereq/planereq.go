// Package planereq is the request seam the PLANE serves (ticket #222; spec
// #214 decisions 7 and 8): a scope-in, a scope-out and a pairing-code ask are
// rows the twin runtime writes and this loop answers.
//
// THE MIRROR OF `runtime_requests`, and that is why it is a table of its own
// rather than a widened one. That store's own header states the claim its
// grants rest on — "the runtime is the SERVER of requests and never a
// requester: a runtime that could write its own rows could fabricate the
// operator's ask" — and here the roles are swapped: the runtime asks and the
// plane serves, so the grants are the exact opposite and one table cannot hold
// both claims (…20260908100050 argues it in full).
//
// NOTHING CROSSES THE WALL HERE (ADR-0004). Push-only crossing governs facts
// reaching the company-owned Ledger; both parties to this seam are rep-side
// processes on the rep side's own Postgres, and no row names an entity, a fact
// or anything owner-visible. It is `send_commands` with the direction
// reversed.
//
// AND THE PLANE'S POLLER IS STILL ONE MACHINE (ADR-0012, which permits
// "internal sub-loops … same harness, same twin, nothing user-named"): this
// ticks beside the executor's loop, in the same process, over the same twin,
// on the same second cadence, and neither loop is anything a rep or an
// operator can name or schedule.
//
// A BAD REQUEST NEVER FAIL-STOPS THE RAIL, which is the one place this loop
// deliberately departs from the executor's doctrine. The executor returns on
// any error because a send it cannot execute correctly means a broken seam and
// a customer may not be written to on a guess. A request is an ask ABOUT the
// rep's own history: an ask this plane cannot serve is settled `failed` and the
// loop carries on, because a plane that died on one would take capture, the
// rail and every other request down with it — and a request nothing will ever
// answer is answered on the next pass (`SettleStranded`, swept at the top of
// every one).
package planereq

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// Kind is which of the three the plane is being asked for. The store's
// `plane_requests_kind_check` and `@dito/seam`'s PLANE_REQUEST_KINDS are the
// other two copies, swept together by `migration-vocabulary.test.ts`.
type Kind string

const (
	// KindScopeIn is the rep marking a chat. The allowlist row is already
	// written — the runtime writes it in the act's own transaction — so what
	// the plane owes is the ninety-day fill.
	KindScopeIn Kind = "scope_in"
	// KindScopeOut is the rep unmarking one. The allowlist row is already
	// gone, so the guard is already dropping that chat's next message at the
	// socket on its uncached read; what the plane owes is to say so.
	KindScopeOut Kind = "scope_out"
	// KindPairingCode is link day on a phone: eight characters the rep types
	// into WhatsApp, inside ADR-0031's ~160-second window.
	KindPairingCode Kind = "pairing_code"
)

// Kinds is the closed set in one place, for the test that pins it against the
// store's CHECK.
var Kinds = []Kind{KindScopeIn, KindScopeOut, KindPairingCode}

// Outcome is what became of one ask.
type Outcome string

const (
	// Served — the plane did what was asked.
	Served Outcome = "served"
	// Refused — the ask could not be served and nothing was fetched.
	Refused Outcome = "refused"
	// Failed — the plane could not serve it, or went away mid-serve.
	Failed Outcome = "failed"
)

// Outcomes is the closed set in one place.
var Outcomes = []Outcome{Served, Refused, Failed}

// Reason is why an ask was not served, as a closed word and never a sentence:
// a reason a person could type would be the one column on this table that
// could carry content.
type Reason string

const (
	// ReasonNoDirectoryRow — the plane has never seen this chat, so it holds
	// no anchor for it.
	ReasonNoDirectoryRow Reason = "no_directory_row"
	// ReasonNoAnchor — the row names no message the phone could page from.
	ReasonNoAnchor Reason = "no_anchor"
	// ReasonNoLID — neither the directory nor the library's map knows the
	// chat's LID, and the PN form is never answered (#216).
	ReasonNoLID Reason = "no_lid"
	// ReasonNoHistoryWindow — the twin has no `history_windows` row, and the
	// line is never guessed.
	ReasonNoHistoryWindow Reason = "no_history_window"
	// ReasonRailNotLinked — no live session identity: nothing can be asked.
	ReasonRailNotLinked Reason = "rail_not_linked"
	// ReasonAlreadyLinked — a pairing-code ask on a plane that already holds a
	// session.
	ReasonAlreadyLinked Reason = "already_linked"
	// ReasonMalformedParameter — a parameter the plane cannot read.
	ReasonMalformedParameter Reason = "malformed_parameter"
	// ReasonPassFailed — the plane tried and failed; the loop carries on.
	ReasonPassFailed Reason = "pass_failed"
	// ReasonInterrupted — the plane went away mid-serve; the next start
	// settles the row.
	ReasonInterrupted Reason = "interrupted"
)

// Reasons is the closed set in one place.
var Reasons = []Reason{
	ReasonNoDirectoryRow, ReasonNoAnchor, ReasonNoLID, ReasonNoHistoryWindow,
	ReasonRailNotLinked, ReasonAlreadyLinked, ReasonMalformedParameter,
	ReasonPassFailed, ReasonInterrupted,
}

// Stop is how a SERVED fill ended, which is a different question from why an
// unserved ask failed — so it is a different column with a different closed
// set. A fill that stopped at the ninety-day line and one the phone stopped
// answering both SERVED the ask; conflating them with a refusal's reason would
// make "did the rep's history arrive" unanswerable from the row.
type Stop string

const (
	// StopNinetyDayLine — a page reached past the twin's history window.
	StopNinetyDayLine Stop = "ninety_day_line"
	// StopEmptyPage — the phone answered with a page carrying no messages.
	StopEmptyPage Stop = "empty_page"
	// StopNoMoreOnPrimary — the phone's own
	// COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY: the chat is exhausted.
	StopNoMoreOnPrimary Stop = "no_more_on_primary"
	// StopNoAccess — the phone says more remains and this companion may not
	// have it (`endOfHistoryTransferType` value 3). A stop rather than a
	// refusal, and a different word from the one above: history exists, so «no
	// more remains» would be a lie on the record, but asking again cannot
	// change the answer — #216's research found this build offers no such grant
	// at all — so paging on spends a request and a notification on the rep's
	// phone per page for nothing. A later reader needs this word to know that
	// re-scoping the chat is not worth anything.
	StopNoAccess Stop = "no_access"
	// StopWaitTimeout — the phone stopped answering inside the pager's bound.
	// The progress that landed stands.
	StopWaitTimeout Stop = "wait_timeout"
	// StopAnchorRepeated — the phone returned a page the fill had already
	// asked from, which is the one shape of answer that would otherwise make
	// the sitting never end.
	StopAnchorRepeated Stop = "anchor_repeated"
	// StopDescoped — the rep switched the chat off while the sitting was
	// running. Reachable because the plane serves requests ONE AT A TIME: a
	// scope-out written seconds after a scope-in is queued BEHIND the fill it
	// would stop, so without this stop the fill pages the whole window for a
	// chat the rep has just unmarked — every page dropped at the socket, a
	// notification on their own phone per page, and a directory row left
	// claiming a fill that landed nothing.
	StopDescoped Stop = "descoped"
)

// Stops is the closed set in one place.
var Stops = []Stop{
	StopNinetyDayLine, StopEmptyPage, StopNoMoreOnPrimary, StopNoAccess,
	StopWaitTimeout, StopAnchorRepeated, StopDescoped,
}

// FillStop is the word the DIRECTORY ROW's stop marker carries — how this
// chat's last fill attempt ended (ticket #245 F17; boundary #225).
//
// WHY THE ROW NEEDS ITS OWN COPY OF A WORD THIS TABLE ALREADY HOLDS. The fill's
// end lived only here, on `plane_requests`, and rep-web holds no grant on this
// table and must not — a dashboard that could read the plane's asks could read
// every chat a rep ever scoped. So the fill card inferred «still working» from
// how long ago a page landed, and on the rig it sat on «Ya llegó hasta el
// domingo, 17 de mayo» long after the fill had stopped at the ninety-day line.
// The marker is the same fact stamped where the card may read it.
//
// AND IT IS A WIDER SET THAN `Stops`, deliberately. `stopped_by` answers "how
// did a SERVED fill end", so it holds seven words; the marker answers "how did
// this chat's attempt end", and an attempt that was REFUSED by name or that
// FAILED ended just as finally. A refusal that left no marker would leave the
// card running for ever over a chat nothing will ever fill — a group (`no_lid`),
// a chat whose only record came from a contact edit (`no_anchor`), a chat
// scoped from Conexiones while the rail was dropped (`rail_not_linked`) — which
// is the very failure the marker exists to end.
type FillStop string

// scopeInEnds is the subset of Reasons a SCOPE-IN's own row can carry: the four
// the fill decides about a chat, the one it decides about the twin, the plane's
// own failure, and the word the next start writes over a fill whose process
// went away. `already_linked` is the pairing ask's; `malformed_parameter`
// belongs to a row whose chat does not parse, which no directory row names.
var scopeInEnds = []Reason{
	ReasonNoDirectoryRow, ReasonNoAnchor, ReasonNoLID,
	ReasonNoHistoryWindow, ReasonRailNotLinked, ReasonPassFailed,
	ReasonInterrupted,
}

// FillStopPassFailed and FillStopInterrupted are the two ends that are not a
// stop and not a refusal: the plane tried and could not, and the plane went
// away mid-fill and the next start said so. They are named here because the
// fill and the loop write them, and they are the REQUEST's own words rather
// than a second spelling — the marker's whole claim is that the row carries
// what the request carries.
const (
	FillStopPassFailed  = FillStop(ReasonPassFailed)
	FillStopInterrupted = FillStop(ReasonInterrupted)
)

// FillStops is the marker's closed set, DERIVED rather than restated: every
// word a scope-in can end with, which is `Stops` plus `scopeInEnds`. A copy of
// these spellings would be the drift this repo's vocabulary tests exist to
// catch, so `chat_directory_fill_stopped_by_check` is swept against this list
// (`planereq_test.go`).
//
// `no_directory_row` IS IN IT, and the reason is that the fill stamps its
// outcome by ONE rule with no exception: the marker is an UPDATE keyed by the
// twin and the chat, and for a chat the directory has never seen it finds no
// row to mark — which is the same absence the word names.
var FillStops = fillStops()

func fillStops() []FillStop {
	stops := make([]FillStop, 0, len(Stops)+len(scopeInEnds))
	for _, stop := range Stops {
		stops = append(stops, FillStop(stop))
	}
	for _, reason := range scopeInEnds {
		stops = append(stops, FillStop(reason))
	}
	return stops
}

// Request is one taken row, as a handler reads it.
type Request struct {
	ID   string
	Kind Kind
	// Chat is the chat the two scope acts name; the zero JID on a
	// pairing-code ask, which is about a number.
	Chat types.JID
	// Phone is the seat's number a pairing-code ask carries, digits only as
	// the store's own CHECK holds it; empty on the two scope acts.
	Phone string
}

// Result is what a served ask produced. Pages and Stop are the fill's;
// a scope-out and a pairing code produce neither.
type Result struct {
	Pages int
	Stop  Stop
}

// Refusal is a handler saying "this ask cannot be served, and here is the
// closed word for why". It is an error type rather than a second return value
// because refusing is the exceptional path and every other failure is an
// error too — so a handler has one way out and the loop has one thing to
// inspect.
type Refusal struct {
	Reason Reason
}

func (r Refusal) Error() string {
	return "the plane refused the request: " + string(r.Reason)
}

// Refuse names a refusal by its closed word.
func Refuse(reason Reason) error { return Refusal{Reason: reason} }

// Handler serves one kind of ask. The plane wires one per kind; a kind with no
// handler is refused rather than left taken, because a row nothing will ever
// answer is worse than one answered "not by this build".
type Handler interface {
	Serve(ctx context.Context, req Request) (Result, error)
}

// serveTimeout bounds ONE ask end to end. The fill is the long one — it pages
// sequentially in a single sitting, each page under the pager's own bound —
// and this is the outer fence that stops a sitting from outliving the link day
// it belongs to. Generous rather than tight: fifty messages a page over ninety
// days of a busy chat is a couple of dozen pages, each answered in about three
// seconds on the rig (#216's readings of 2026-09-07), and a bound that cut a
// working fill short would lose history the rep was promised.
const serveTimeout = 10 * time.Minute

// Config wires a Server.
type Config struct {
	DB     *sql.DB
	TwinID string
	// Handlers is one per kind. A kind absent from it is refused
	// `malformed_parameter` — this build does not serve that word.
	Handlers map[Kind]Handler
	// OnError receives every failure the loop absorbed rather than returned:
	// a request settled `failed`, and a settle that could not be written. The
	// binary logs; tests collect.
	OnError func(error)
	// OnSwept runs once at the top of every pass, after the stranded rows have
	// been settled. The binary wires the directory's own projection there, so
	// every fill whose end is on a settled request row is stamped on the chat's
	// row a second later whatever went wrong when it ended
	// (`directory.ProjectStops` argues it). Optional, and its failure is
	// absorbed: a projection this pass could not write must not fail-stop the
	// rail, and the next pass writes it.
	OnSwept func(ctx context.Context) error
}

// Server polls the request table for one twin.
type Server struct {
	cfg Config
}

// New builds a Server.
func New(cfg Config) *Server { return &Server{cfg: cfg} }

// Run polls RunOnce until ctx is done, settling anything a previous process
// left taken first.
//
// IT RETURNS ONLY ON AN INFRASTRUCTURE FAILURE — a table it cannot read or a
// settle it cannot write — because those are the same class the plane already
// fail-stops on. Everything a request itself caused is absorbed (see the
// package header).
func (s *Server) Run(ctx context.Context, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := s.stopped(ctx, s.RunOnce(ctx)); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// stopped absorbs the one error class that is not a failure: A CANCELLED
// CONTEXT REACHES A STATEMENT AS AN ERROR, so a plane being shut down mid-poll
// would otherwise return «context canceled» from this loop and fail-stop the
// binary on its own teardown. The context's own state is what distinguishes
// the two, and it is asked rather than the error's text sniffed.
func (s *Server) stopped(ctx context.Context, err error) error {
	if err != nil && ctx.Err() != nil {
		return nil
	}
	return err
}

// SettleStranded closes every request this twin's plane took and never
// settled — the shape `settleStrandedRequests` has on the runtime's side of
// the wall — and tells `OnStranded` about each one.
//
// TAKEN AND UNSETTLED MEANS THE SERVER WENT AWAY. The row is claimed in one
// statement before the work starts and settled in one after, so a row between
// them belongs to a process that is gone: this one is starting, and one plane
// serves one twin. Settled `failed`/`interrupted` rather than re-served,
// because whether the phone answered is unknowable from here and a fill
// re-asked from a stale anchor would re-page a window already read.
//
// AND THE SWEEP IS WHERE THE CHAT'S OWN ROW IS BROUGHT UP TO DATE TOO (ticket
// #245 F17). A fill stamps its end on the chat's directory row as it goes, and
// that write can fail or its process can stop between the stamp and the settle
// — so the marker's correctness rests on the REQUEST rows rather than on one
// UPDATE landing at the right moment, and `OnSwept` re-derives it from them
// once per pass. `directory.ProjectStops` is what the binary wires there and
// argues the whole of it; this package stays ignorant of the directory.
func (s *Server) SettleStranded(ctx context.Context) error {
	_, err := s.cfg.DB.ExecContext(ctx,
		`UPDATE plane_requests
		    SET outcome = $2, reason = $3, settled_at = clock_timestamp()
		  WHERE twin_id = $1 AND taken_at IS NOT NULL AND outcome IS NULL`,
		s.cfg.TwinID, string(Failed), string(ReasonInterrupted),
	)
	if err != nil {
		return fmt.Errorf("settling stranded plane requests for twin %s: %w", s.cfg.TwinID, err)
	}
	if s.cfg.OnSwept != nil {
		if err := s.cfg.OnSwept(ctx); err != nil {
			// ABSORBED, NOT RETURNED, for the reason the whole sweep is
			// absorbed: work this pass could not do must not fail-stop the
			// rail, and this particular work is idempotent — the next pass
			// does it.
			s.cfg.OnError(fmt.Errorf("projecting the fills' stops for twin %s: %w", s.cfg.TwinID, err))
		}
	}
	return nil
}

// RunOnce serves every request pending for the twin, oldest first, ONE AT A
// TIME.
//
// SEQUENTIALLY AND NEVER INTERLEAVED, which is a product rule rather than a
// concurrency preference: the phone notifies the rep once per on-demand page
// («Finished syncing with WhatsApp Business on Other device» — #216's
// readings), so two chats' fills running together would double the
// notifications a rep sees for no gain. One sitting, one chat at a time.
//
// IT SETTLES STRANDED ROWS FIRST, ON EVERY PASS AND NOT ONLY AT STARTUP
// (Codex r1). A settle that fails is absorbed — the loop must not fail-stop
// the rail over one request — and `take` will never see that row again,
// because it is taken. So a transient database failure on the one UPDATE would
// leave the request with no outcome for the life of the process, and the
// requester waiting out its whole timeout over a fill that ran. Sweeping at
// the top of the pass is what makes the absorption self-healing; it is safe
// because a pass serves its requests SEQUENTIALLY, so nothing is mid-serve
// when this runs.
func (s *Server) RunOnce(ctx context.Context) error {
	if err := s.SettleStranded(ctx); err != nil {
		return err
	}
	for {
		req, ok, err := s.take(ctx)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
		s.serve(ctx, req)
		// Cancellation is checked between asks rather than inside one: a fill
		// that has started pages to a stop and records what it fetched, and
		// abandoning it half-way would leave the row for the next start to
		// settle `interrupted` over history that did land.
		if ctx.Err() != nil {
			return nil
		}
	}
}

// take claims the oldest pending request in one statement. `FOR UPDATE SKIP
// LOCKED` is not for this deployment — one plane serves one twin — but for the
// overlap between two of them across a restart, where two processes would
// otherwise read the same row and serve it twice.
func (s *Server) take(ctx context.Context) (Request, bool, error) {
	var req Request
	var kind string
	var chat sql.NullString
	var parameters []byte
	err := s.cfg.DB.QueryRowContext(ctx,
		`UPDATE plane_requests
		    SET taken_at = clock_timestamp()
		  WHERE id = (SELECT id FROM plane_requests
		               WHERE twin_id = $1 AND taken_at IS NULL
		               ORDER BY requested_at, id
		               LIMIT 1
		               FOR UPDATE SKIP LOCKED)
		  RETURNING id, kind, chat_jid, parameters`,
		s.cfg.TwinID,
	).Scan(&req.ID, &kind, &chat, &parameters)
	if errors.Is(err, sql.ErrNoRows) {
		return Request{}, false, nil
	}
	if err != nil {
		return Request{}, false, fmt.Errorf("taking a plane request for twin %s: %w", s.cfg.TwinID, err)
	}
	req.Kind = Kind(kind)
	if chat.Valid {
		parsed, parseErr := types.ParseJID(chat.String)
		if parseErr != nil {
			// The store's own address CHECK makes this unreachable through any
			// writer that goes through it; a hand-written row is why it is
			// still asked, and the VALUE is not carried — it is a chat
			// identity (ADR-0025).
			s.settled(ctx, req, Refused, ReasonMalformedParameter, Result{})
			return Request{}, false, nil
		}
		req.Chat = parsed.ToNonAD()
	}
	if phone, ok := readPhone(parameters); ok {
		req.Phone = phone
	}
	return req, true, nil
}

// readPhone reads the one parameter the document may carry. A document that
// does not decode states nothing: the store's CHECKs make it a closed typed
// schema of one key, so the only way here is a row written past them, and a
// pairing-code handler with no number refuses `malformed_parameter` anyway.
func readPhone(parameters []byte) (string, bool) {
	var doc struct {
		Phone string `json:"phone"`
	}
	if err := json.Unmarshal(parameters, &doc); err != nil || doc.Phone == "" {
		return "", false
	}
	return doc.Phone, true
}

// serve runs one ask under its own budget and writes its outcome — ALWAYS one
// outcome, whichever way it went. A request left taken and unsettled is the
// one state this table must not hold while its server is alive: the requester
// waits out its whole timeout and the rep is told nothing happened.
func (s *Server) serve(ctx context.Context, req Request) {
	handler, ok := s.cfg.Handlers[req.Kind]
	if !ok {
		s.settled(ctx, req, Refused, ReasonMalformedParameter, Result{})
		return
	}
	serveCtx, cancel := context.WithTimeout(ctx, serveTimeout)
	defer cancel()
	result, err := handler.Serve(serveCtx, req)
	var refusal Refusal
	switch {
	case errors.As(err, &refusal):
		s.settled(ctx, req, Refused, refusal.Reason, Result{})
	case err != nil:
		s.cfg.OnError(fmt.Errorf("serving %s request %s: %w", req.Kind, req.ID, err))
		s.settled(ctx, req, Failed, ReasonPassFailed, Result{})
	default:
		s.settled(ctx, req, Served, "", result)
	}
}

// settled writes the one outcome, on a context of its own.
//
// A DETACHED BUDGET, DELIBERATELY: the ask's own context may already be done —
// a fill that ran its ten minutes, or a plane being stopped — and settling on
// it would leave exactly the taken-and-unsettled row this function exists to
// prevent. The write is one UPDATE and its budget is the plane's ordinary
// per-step one.
func (s *Server) settled(ctx context.Context, req Request, outcome Outcome, reason Reason, result Result) {
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), settleTimeout)
	defer cancel()
	var reasonValue, stopValue any
	if reason != "" {
		reasonValue = string(reason)
	}
	// The store pairs the stop with a SERVED fill and refuses it anywhere else
	// (`plane_requests_stopped_by_paired_check`), so the one place it is sent
	// is the one place it means something.
	if outcome == Served && req.Kind == KindScopeIn {
		stopValue = string(result.Stop)
	}
	res, err := s.cfg.DB.ExecContext(settleCtx,
		`UPDATE plane_requests
		    SET outcome = $2, reason = $3, stopped_by = $4, pages = $5,
		        settled_at = clock_timestamp()
		  WHERE id = $1 AND outcome IS NULL`,
		req.ID, string(outcome), reasonValue, stopValue, result.Pages,
	)
	if err != nil {
		s.cfg.OnError(fmt.Errorf("settling %s request %s as %s: %w", req.Kind, req.ID, outcome, err))
		return
	}
	n, err := res.RowsAffected()
	if err != nil {
		s.cfg.OnError(fmt.Errorf("settling %s request %s as %s: %w", req.Kind, req.ID, outcome, err))
		return
	}
	if n != 1 {
		s.cfg.OnError(fmt.Errorf("settling %s request %s as %s touched %d rows — the request vanished or was settled elsewhere", req.Kind, req.ID, outcome, n))
	}
}

// settleTimeout bounds the one UPDATE that closes a request — the plane's
// ordinary per-step budget (ingest's eventTimeout, rail's recordTimeout).
const settleTimeout = 10 * time.Second

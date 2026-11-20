// Package fill is the ninety-day history fill (ticket #222; spec #214
// decisions 7 and 8): on a scope-in request the plane asks the rep's own phone
// for the chat's history, page by page, backwards, until the window, an empty
// page or the phone's own word that nothing more remains.
//
// WHAT #216 SETTLED, AND WHAT THIS IS BUILT ON (its readings of 2026-09-07,
// confirmed on the rig phone):
//
//  1. The chat is addressed by its LID. The phone-number form is never
//     answered — a PN chat id names a record a LID-migrated phone does not
//     have.
//  2. whatsmeow's own request is right as it stands: seconds, no
//     `supportInlineResponse`, no `accountLid`. `historyspike.BuildRequest`
//     with the default unit is byte-identical to it, and a test in that
//     package pins that.
//  3. The first anchor is the chat's newest known message; every later anchor
//     is the oldest message the previous page returned.
//  4. The answer is ONE chunk, about three seconds after the ask, and the
//     conversation is keyed by LID with neither `pnJid` nor `lidJid` stated —
//     which is why the capture guard resolves it through the directory
//     (`ingest.canonicalHistoryChat`).
//  5. `COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY` is the phone's own
//     statement that the next page exists.
//
// SEQUENTIALLY, IN ONE SITTING, AND NEVER TWO CHATS AT ONCE. The phone
// notifies the rep on every on-demand answer — iOS «Finished syncing with
// WhatsApp Business on Other device», one per page — so a ninety-day fill is
// that many notifications on the rep's own phone. Doing them one chat at a
// time, right after the link, is what keeps that a burst the rep expects
// rather than a drip all day.
//
// THE SEND LIVES WHERE IT ALREADY DID. `historyspike.Request` is the one file
// outside the executor that may touch a rail send API, named by path and
// selector in the invariant scan (ADR-0006), and it is what this package
// calls: the fill adds a CALLER, not a path. Nothing here reaches whatsmeow's
// send surface directly, so the scan stays exactly as narrow as it was.
package fill

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/bounded"
	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/historyspike"
	"github.com/Dito-Core/dito/plane/lidmap"
	"github.com/Dito-Core/dito/plane/planereq"
)

// pageWait is how long one page's answer is waited for.
//
// THIRTY SECONDS, ARGUED FROM THE RIG rather than picked. Every LID-addressed
// answer on the rig phone arrived in about three seconds, on three pairings,
// at both anchors, with the phone in a pocket (#216) — so this is an order of
// magnitude of headroom for a phone on mobile data or briefly asleep. It is
// also deliberately SHORT: a fill runs during link day with the rep watching a
// progress view, and a bound of minutes per page would let one unresponsive
// phone hold that view open for an hour. On a timeout the sitting ends with
// what it fetched standing on the directory row (`wait_timeout`), which is a
// fill the rep can resume by scoping the chat again.
const pageWait = 30 * time.Second

// Directory is the four things a fill does to a chat's directory row: read
// what it can be asked with, open an attempt on it, move its progress after
// every page, and say how the attempt ended.
//
// EVERY ATTEMPT ENDS WITH A MARKER, and the two writers are how (ticket #245
// F17): the last page carries the stop in its own statement, and every other
// end — a refusal decided before a request went out, a phone that stopped
// answering, a rep who switched the chat off, a failure — is stamped on its
// own. An end that left no marker reads as an attempt still working, and the
// card it feeds would stand on Inicio for ever.
type Directory interface {
	Read(ctx context.Context, chat types.JID) (directory.Row, error)
	StartFill(ctx context.Context, chat types.JID) error
	RecordPage(ctx context.Context, chat types.JID, oldest time.Time, endOfTransfer string, stop planereq.FillStop) error
	RecordStop(ctx context.Context, chat types.JID, stop planereq.FillStop) error
}

// Window is how far back this twin's history may reach —
// *historywindow.Store in the binary. Read per fill and never held, because
// it bounds what enters twin memory (ADR-0023).
type Window interface {
	Days(ctx context.Context) (int, bool, error)
}

// SelfSource yields the rep's live-session identity — rail.Rail in the binary
// (ADR-0006: never a table or caller value). A fill with no live session has
// no socket to ask on.
type SelfSource interface {
	SelfJID() (types.JID, bool)
}

// LIDs is the library's own phone-number-to-LID map, the SECOND place a
// chat's LID can be found — `historyspike.LIDs`, satisfied by *store.Device's
// LIDs in the binary, reaching no network.
//
// WHY THE FILL NEEDS IT AT ALL (Codex r1). The directory learns a LID only
// where a conversation or a name event states one; whatsmeow ALSO learns
// mappings from the separate table the phone sends inside its history sync
// (`storeHistoricalPNLIDMappings`) — which is where the rig's own instrument
// found every LID it asked with (#216). So a chat whose conversations never
// stated a `lidJID` would be refused `no_lid` for ever while the library knew
// its LID all along, and «the PN form is never answered» would make that a
// chat whose history can never be fetched.
type LIDs interface {
	GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error)
}

// Scope is the capture guard's own question, asked between pages —
// *ingest.ScopeReader in the binary, which is the guard's rule itself and not
// a second reading of it (that type argues the whole of it).
//
// WHY A SITTING HAS TO ASK AT ALL. The plane serves requests ONE AT A TIME, so
// a rep who switches a chat off seconds after switching it on has their
// scope-out queued BEHIND the fill it would stop. Without this the fill pages
// the whole window for a chat the rep has just unmarked: every page dropped at
// the socket, a notification on their own phone per page, and a directory row
// left claiming a fill that landed nothing.
type Scope interface {
	InScope(ctx context.Context, chat types.JID) (bool, error)
}

// Config wires a Fill.
type Config struct {
	// Rail is the peer-message surface `historyspike.Request` sends on —
	// *whatsmeow.Client in the binary.
	Rail      historyspike.PeerRail
	Directory Directory
	Window    Window
	Self      SelfSource
	// LIDs is the library's identity map, asked when the directory holds no
	// LID for the chat. Optional: without it the directory is the only source,
	// which is a narrower fill rather than a broken one.
	LIDs LIDs
	// Scope is the guard's rule, asked before EVERY page including the first
	// and again after each answer. Required; see the interface.
	Scope Scope
	// Pager is the answer reader, registered on the client AFTER the capture
	// guard so a page's rows have landed by the time the page is reported.
	Pager *Pager
	// Wait overrides pageWait; zero takes the argued default.
	Wait time.Duration
	// AskWait overrides askTimeout; zero takes the argued default.
	AskWait time.Duration
	// Now is the moment the history window is measured from; nil reads the
	// clock. A parameter rather than a clock read inside the loop, so a test
	// states the line rather than waiting for it.
	Now func() time.Time
}

// Fill serves scope-in requests. It is a planereq.Handler.
type Fill struct {
	cfg Config
}

// New builds a Fill.
func New(cfg Config) *Fill { return &Fill{cfg: cfg} }

// Serve pages one chat's history backwards until a stop, AND LEAVES THE
// ATTEMPT'S END ON THE CHAT'S OWN ROW whichever way it went.
//
// ONE MARKER PER ATTEMPT, NO EXCEPTION (ticket #245 F17; boundary #225). The
// request row's own word is unreachable for the card — rep-web holds no grant
// on that table and must not — so the fill's end is stamped on the chat's row,
// where an ABSENT marker means «an attempt is running». The stops ride with
// their page (`page`), the refusals stamp their own word (`refuse`), and a
// failure is stamped here, so no path out of this function leaves a row that
// reads as an attempt still running over one that has ended.
func (f *Fill) Serve(ctx context.Context, req planereq.Request) (planereq.Result, error) {
	result, err := f.serve(ctx, req)
	var refusal planereq.Refusal
	if err != nil && !errors.As(err, &refusal) {
		err = errors.Join(err, f.markFailed(ctx, req.Chat))
	}
	return result, err
}

// serve is the decision, and every refusal in it is decided BEFORE ANYTHING
// LEAVES THE SOCKET, and refused BY NAME. A chat with no directory row, no
// anchor or no known LID cannot be asked about at all — the phone answers only
// a request addressed by the chat's LID from a message it can find — so the
// plane says which of the three it was missing instead of putting a request on
// the wire that can only come back empty and a notification on the rep's phone
// for it.
func (f *Fill) serve(ctx context.Context, req planereq.Request) (planereq.Result, error) {
	// THE ATTEMPT IS OPENED BEFORE ANYTHING IS DECIDED, which is what makes the
	// resumed fact right for a refusal too (`StartFill` argues it): a chat
	// marked again whose fill is then refused still tells the rep the twin takes
	// it up from today, and the marker of the PREVIOUS attempt cannot survive
	// this one whichever way it goes.
	if err := f.cfg.Directory.StartFill(ctx, req.Chat); err != nil {
		return planereq.Result{}, err
	}
	if _, ok := f.cfg.Self.SelfJID(); !ok {
		return planereq.Result{}, f.refuse(ctx, req.Chat, planereq.ReasonRailNotLinked)
	}
	days, bounded, err := f.cfg.Window.Days(ctx)
	if err != nil {
		return planereq.Result{}, err
	}
	if !bounded {
		// The line is never guessed (spec #214 decision 8; FR-15): a fill that
		// chose its own window would write history the product never promised.
		return planereq.Result{}, f.refuse(ctx, req.Chat, planereq.ReasonNoHistoryWindow)
	}
	row, err := f.cfg.Directory.Read(ctx, req.Chat)
	if errors.Is(err, directory.ErrNoRow) {
		return planereq.Result{}, f.refuse(ctx, req.Chat, planereq.ReasonNoDirectoryRow)
	}
	if err != nil {
		return planereq.Result{}, err
	}
	if !row.Anchor.Stated() {
		return planereq.Result{}, f.refuse(ctx, req.Chat, planereq.ReasonNoAnchor)
	}
	addressed, err := f.addressed(ctx, req.Chat, row.LID)
	if err != nil {
		return planereq.Result{}, err
	}
	if addressed.IsEmpty() {
		return planereq.Result{}, f.refuse(ctx, req.Chat, planereq.ReasonNoLID)
	}
	return f.page(ctx, req.Chat, addressed, row.Anchor, f.now().UTC().AddDate(0, 0, -days))
}

// refuse names a refusal and stamps it on the chat's row, which is ONE act:
// the word the request carries and the word the card reads are the same word.
//
// A REFUSAL IS AN END, and treating it as one is the whole of #245's F17. A
// scope-in refused `no_lid` (a group), `no_anchor` (a chat whose only record
// came from a contact edit) or `rail_not_linked` (a chat scoped from Conexiones
// while the rail was down) will never be filled by anything, so a row left
// unmarked would keep the card saying «Trayendo tu historial» for ever.
//
// A STAMP THAT FAILS IS RETURNED RATHER THAN SWALLOWED: the plane could not
// record what it decided, which is the plane's own failure, and the loop
// settles the request `failed` and logs it.
func (f *Fill) refuse(ctx context.Context, chat types.JID, reason planereq.Reason) error {
	if err := f.cfg.Directory.RecordStop(ctx, chat, planereq.FillStop(reason)); err != nil {
		return err
	}
	return planereq.Refuse(reason)
}

// markFailed stamps the plane's own failure on the chat's row.
//
// A DETACHED BUDGET, DELIBERATELY, and `planereq`'s own `settled` makes the
// same argument for the same reason: the sitting's context may already be done
// — the ten-minute fence expired, or the plane is being stopped — and stamping
// on it would leave the row with no marker at all, which is the card running
// for ever. The write is one UPDATE and its budget is the plane's ordinary
// per-step one.
func (f *Fill) markFailed(ctx context.Context, chat types.JID) error {
	stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
	defer cancel()
	if err := f.cfg.Directory.RecordStop(stopCtx, chat, planereq.FillStopPassFailed); err != nil {
		return fmt.Errorf("stamping a failed fill on the chat's directory row: %w", err)
	}
	return nil
}

// stopTimeout bounds the one UPDATE that marks an attempt's end — the plane's
// ordinary per-step budget (`ingest.eventTimeout`, `rail.recordTimeout`,
// `planereq.settleTimeout`).
const stopTimeout = 10 * time.Second

// page is the sitting: ask, decide, record, move the anchor.
//
// THE SITTING'S OWN TWO STOPS ARE HERE and the PAGE'S are `stopFor`'s, which
// is the split the ordering below rests on:
//
//	the rep switched it off      → asked BEFORE every page and AGAIN before the
//	                               page's progress is recorded
//	the phone did not answer     → the sitting ends, progress stands
//
// THE FIRST PAGE IS CHECKED TOO, and the argument that it need not be was
// wrong (Codex r2). The scope-in act wrote the allowlist row in the same
// transaction as the request row (`scoping.ts`), so the chat was in scope when
// the ask was WRITTEN — not when it is SERVED. A rep who switches the chat
// back off in between has their scope-out queued behind this very request, so
// without the first check the sitting pages the whole window for a chat that
// is already out of scope.
//
// AND IT IS CHECKED AGAIN AFTER THE ANSWER, BEFORE PROGRESS MOVES, because the
// pager reads the arriving blob and not the guard's verdict on it: a descope
// landing while a page is in flight means the guard DROPPED that page, and
// recording it would leave the row claiming history the seam does not hold.
// The second read collapses that window from a whole round trip to the
// microseconds between the guard's own read and this one. What it does not
// cover is a page the guard refused for the WINDOW rather than for scope —
// recorded on the ticket, because closing it means the guard reporting per-page
// outcomes back to the fill, which is a seam of its own.
//
// PROGRESS AND THE STOP ARE ONE STATEMENT (ticket #245 F17), which is a
// change of ORDER from "record the page, then decide": the page that reaches
// past the ninety-day line moves the row's reach past that line, and the card
// labels itself with that instant — so a row carrying the page and not yet its
// stop would tell the rep «Ya llegó hasta el 17 de mayo», a date outside the
// window the product promised, which is what the rig showed. `stopFor` decides
// first and `RecordPage` writes both, so that row cannot exist. A sitting that
// ends still leaves behind what it actually fetched: the page is recorded
// whether or not it also stops the sitting.
//
// AN ANCHOR IS NEVER RE-ASKED, and the set is what makes that true rather than
// assumed: a phone that answers two different requests with the same page
// would otherwise page forever, asking the same window and paying for a
// notification on the rep's phone each time.
func (f *Fill) page(ctx context.Context, chat, addressed types.JID, anchor directory.Anchor, line time.Time) (planereq.Result, error) {
	asked := map[string]struct{}{}
	result := planereq.Result{}
	for {
		scoped, err := f.cfg.Scope.InScope(ctx, chat)
		if err != nil {
			return planereq.Result{}, err
		}
		if !scoped {
			return f.stopped(ctx, chat, result, planereq.StopDescoped)
		}
		asked[anchor.MessageID] = struct{}{}
		page, answered, err := f.ask(ctx, chat, addressed, anchor)
		if err != nil {
			return planereq.Result{}, err
		}
		if !answered {
			return f.stopped(ctx, chat, result, planereq.StopWaitTimeout)
		}
		// ...AND AGAIN BEFORE THE PROGRESS MOVES: a descope that landed while
		// this page was in flight means the guard dropped it, so counting it
		// would leave the row claiming history the seam does not hold.
		if scoped, err = f.cfg.Scope.InScope(ctx, chat); err != nil {
			return planereq.Result{}, err
		} else if !scoped {
			return f.stopped(ctx, chat, result, planereq.StopDescoped)
		}
		result.Pages++
		stop := stopFor(page, asked, line)
		if err := f.cfg.Directory.RecordPage(
			ctx, chat, page.Oldest.At, page.EndOfTransfer, planereq.FillStop(stop),
		); err != nil {
			return planereq.Result{}, err
		}
		if stop != "" {
			result.Stop = stop
			return result, nil
		}
		anchor = page.Oldest
	}
}

// stopped ends a sitting whose last page could not carry the marker — the rep
// switched the chat off, or the phone went quiet — so the row is stamped on
// its own. The progress that landed stands: this writes no page.
func (f *Fill) stopped(ctx context.Context, chat types.JID, result planereq.Result, stop planereq.Stop) (planereq.Result, error) {
	if err := f.cfg.Directory.RecordStop(ctx, chat, planereq.FillStop(stop)); err != nil {
		return planereq.Result{}, err
	}
	result.Stop = stop
	return result, nil
}

// stopFor is one page's verdict on whether the sitting goes on: the empty Stop
// means "ask the next question".
//
// THE ORDER IS WHAT THE PHONE SAID ABOUT THE FUTURE FIRST, then this plane's
// own bound. A row that says the chat is exhausted, or that this companion may
// not have the rest, tells a later reader that re-scoping the chat is worth
// nothing; a row that says «we reached our ninety-day line» invites exactly
// that. So when a page states both, the phone's word stands.
//
//	the phone says no access     → more remains and asking cannot get it
//	the phone says no more       → the chat is exhausted on the primary
//	an empty page                → there was nothing to fetch
//	the page crossed the line    → the window is reached; the guard already
//	                               refused the rows beyond it
//	the page states no anchor    → nothing to ask the next question with
//	the anchor was already used  → the phone is repeating itself
func stopFor(page Page, asked map[string]struct{}, line time.Time) planereq.Stop {
	switch {
	case page.noAccess():
		return planereq.StopNoAccess
	case page.noMoreOnPrimary():
		return planereq.StopNoMoreOnPrimary
	case page.Messages == 0:
		return planereq.StopEmptyPage
	case page.Oldest.At.Before(line):
		return planereq.StopNinetyDayLine
	case !page.Oldest.Stated():
		// A page of messages none of which could be an anchor — every one a
		// gesture, or none stating an instant. There is nothing to ask the
		// next question with, and it is not an empty page: the rows landed.
		return planereq.StopEmptyPage
	}
	if _, repeated := asked[page.Oldest.MessageID]; repeated {
		return planereq.StopAnchorRepeated
	}
	return ""
}

// ask sends one on-demand history request and waits for its answer.
//
// THE WINDOW OPENS BEFORE THE SEND and shuts when this returns, whichever way
// it went: the phone can answer inside the send's own acknowledgement wait, so
// the pager has to be listening before the request leaves (Pager says why).
func (f *Fill) ask(ctx context.Context, chat, addressed types.JID, anchor directory.Anchor) (Page, bool, error) {
	f.cfg.Pager.Ask(chat, addressed)
	defer f.cfg.Pager.Close()
	// whatsmeow's request as its own builder makes it: seconds, nothing added
	// (#216 finding 2). The unit and the inline-response flag are the spike's
	// knobs and the fill turns neither.
	//
	// AND THE ASK ITSELF IS BOUND, because `ctx` alone does not bind it (ticket
	// #222, Codex r3): the send reaches the noise socket's write lock, which is
	// taken BEFORE cancellation is checked, so a stalled acknowledgement on a
	// half-open connection would hold this request taken with no outcome and
	// every later request waiting behind it — the loop serves one at a time,
	// and the pass that would settle stranded rows never returns. `askTimeout`
	// argues the number.
	request, err := bounded.Call(ctx, f.askWait(), "the rail's on-demand history request",
		func(askCtx context.Context) (types.MessageID, error) {
			return historyspike.Request(askCtx, f.cfg.Rail, historyspike.Ask{
				Chat:      chat,
				Addressed: addressed,
				Anchor: historyspike.Anchor{
					MessageID: anchor.MessageID,
					FromMe:    anchor.FromMe,
					At:        anchor.At,
				},
				Unit: historyspike.UnitSeconds,
			})
		})
	if err != nil {
		return Page{}, false, fmt.Errorf("asking the phone for a page of history: %w", err)
	}
	f.cfg.Pager.Asked(request)
	page, answered := f.cfg.Pager.Await(f.wait())
	return page, answered, nil
}

// addressed is the identity the request will name the chat by: the directory's
// LID, and failing that the library's own map (LIDs says why the second source
// exists). The zero JID is "neither knows", which the caller refuses by name.
//
// THE MAP IS ASKED ONLY ABOUT A PHONE NUMBER, and that is what keeps a group a
// REFUSAL rather than a failure (#245 F12; boundary #225). whatsmeow's map
// takes a phone-number JID and refuses every other server outright — "invalid
// GetLIDForPN call with non-PN JID" (`store/sqlstore/lidmap.go`) — so on the
// rig a scope-in on a group ended `failed pass_failed` with its reason
// withheld, when the honest answer is that no identity exists for the phone to
// be asked with. The predicate is the ADDRESS and not the row's kind, because
// the kind is DERIVED from the address (`directory.KindOf`): reading it here
// means a group, a broadcast and a newsletter are refused by one rule, and the
// row's kind and the refusal cannot come to disagree.
//
// WHAT IT DOES NOT DO IS FILL A GROUP. Whether Dito ever asks a phone for a
// group's history is a different anchor shape and is on the horizon (#117);
// live messages from a scoped group flow exactly as they do today.
//
// THE BOUND NEEDS A GOROUTINE TO BE REAL (Codex r2), and the argument that it
// did not was wrong. The library's cached map takes an RWMutex that observes
// no context, so neither this ten-second budget nor planereq's ten-minute
// fence would interrupt a wedged lookup — and because the request loop serves
// ONE AT A TIME, the request would stay taken with no outcome and every later
// request would wait behind it for the life of the process. `plane/lidmap`
// holds the one implementation the guard uses too.
func (f *Fill) addressed(ctx context.Context, chat, known types.JID) (types.JID, error) {
	if !known.IsEmpty() {
		return known, nil
	}
	if f.cfg.LIDs == nil || chat.Server != types.DefaultUserServer {
		return types.JID{}, nil
	}
	lid, err := lidmap.Bounded(ctx, lidLookupTimeout, func(lookupCtx context.Context) (types.JID, error) {
		return historyspike.AddressChat(lookupCtx, f.cfg.LIDs, chat, historyspike.AddressLID)
	})
	if errors.Is(err, historyspike.ErrNoLIDForChat) {
		return types.JID{}, nil
	}
	if err != nil {
		// The library's own reason is not carried: it reports identity work by
		// the identity it was working on, and that identity is a chat
		// (ADR-0025 — the withholding `historyspike.Request` makes).
		return types.JID{}, errors.New("reading the library's identity map for a chat failed (its own reason is withheld: it names the chat)")
	}
	return lid, nil
}

// lidLookupTimeout bounds the library's identity lookup — the plane's ordinary
// per-step budget (ingest's eventTimeout, rail's recordTimeout), and short
// because a fill that cannot even address its request has learned that in a
// database read.
const lidLookupTimeout = 10 * time.Second

// askTimeout bounds ONE ask reaching the phone — the socket write and the
// server's acknowledgement of it, not the answer, which `pageWait` bounds.
//
// The plane's ordinary rail-write budget (`rail.recordTimeout` is five
// seconds, `ingest.eventTimeout` ten), doubled once because this write goes
// out over the same session a live delivery may be arriving on. Deliberately
// far below `planereq.serveTimeout`: a sitting that cannot even lodge its
// question has learned that in a socket write, and the ten-minute fence is
// for a fill that is WORKING.
const askTimeout = 20 * time.Second

func (f *Fill) wait() time.Duration {
	if f.cfg.Wait > 0 {
		return f.cfg.Wait
	}
	return pageWait
}

func (f *Fill) askWait() time.Duration {
	if f.cfg.AskWait > 0 {
		return f.cfg.AskWait
	}
	return askTimeout
}

func (f *Fill) now() time.Time {
	if f.cfg.Now != nil {
		return f.cfg.Now()
	}
	return time.Now()
}

// ScopeOut serves a scope-out request, and what it does is say the plane saw
// it (ticket #222; spec #214 *Link day, in detail*: "scope-out removes the row
// and the capture guard stops at the socket as today").
//
// THERE IS NOTHING FOR THE PLANE TO DO, and that is a property of ADR-0023
// rather than an omission: the allowlist row is already gone — the runtime
// deletes it in the rep act's own transaction — and the capture guard reads
// the allowlist PER EVENT with no caching, so the very next message for that
// chat is dropped at the socket without this plane being told anything. The
// request row exists so that the act has an outcome the requester can read,
// and so that "the plane knows" is a fact rather than an assumption.
//
// WHAT IT DELIBERATELY DOES NOT DO is remove anything already in the bundle.
// Deleting ingested content on scope-out is on the horizon (#117), recorded at
// spec #214's *Out of Scope*: what was captured while the chat was in scope
// stays, exactly as it would if the rep had descoped a chat their phone had
// already synced.
type ScopeOut struct{}

// Serve records that the ask was seen. It is a planereq.Handler.
func (ScopeOut) Serve(context.Context, planereq.Request) (planereq.Result, error) {
	return planereq.Result{}, nil
}

package fill

import (
	"sync"
	"time"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/directory"
	"github.com/Dito-Core/dito/plane/historyspike"
)

// Page is what ONE on-demand answer said about the chat asked about, and it is
// content-free by construction (ADR-0025): a count, the phone's own
// end-of-transfer word, and the oldest message's POSITION — its rail stanza
// id, its direction and its instant, which is the next request's anchor and
// the only thing about the page's contents the pager reads.
//
// NO TEXT, NO NAME, NO JID. The page's messages are ingested by the capture
// guard on the same goroutine, through the same door as the pairing push; this
// reads what the fill needs to ask the next question and nothing else.
type Page struct {
	Messages int
	// Oldest is the page's oldest message as the next request's anchor; the
	// zero value when the page carried no message that could be one.
	Oldest directory.Anchor
	// EndOfTransfer is the conversation's own `endOfHistoryTransferType`, the
	// phone's statement about whether more remains on the primary — empty when
	// it stated none.
	EndOfTransfer string
}

// noMoreOnPrimary reports whether the phone said this chat is exhausted.
//
// ONE VALUE MEANS IT, and it is worth naming which of the four does not. The
// protocol's `endOfHistoryTransferType` has exactly these:
//
//	COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY (0)  — page on. What #216 saw
//	                                                    on every answer.
//	COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY (1) — THIS ONE: exhausted.
//	COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY (2) — page on.
//	COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS (3) —
//	                                                    more remain and this
//	                                                    companion may not have
//	                                                    them (noAccess).
//
// So there is no on-demand spelling of "no more": value 1 is the only word for
// it, and reading value 2 as one would stop a fill with history still to
// fetch.
func (p Page) noMoreOnPrimary() bool {
	return p.EndOfTransfer == waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY.String()
}

// noAccess reports whether the phone said more remains and this companion may
// not have it (`endOfHistoryTransferType` value 3).
//
// IT IS A STOP, AND NOT THE SAME STOP. More history exists, so «no more
// remains» would be a lie on the record; but asking again cannot change the
// answer — #216's research found the grant this refers to has no row at all on
// the rig phone's Linked-devices screen — so paging on would spend a request
// and a notification on the rep's phone per page for nothing. The row says
// `no_access`, which is what a later reader needs to know before deciding
// whether re-scoping the chat is worth anything.
func (p Page) noAccess() bool {
	return p.EndOfTransfer == waHistorySync.Conversation_COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS.String()
}

// Pager waits for the phone's answer to one on-demand history request.
//
// WIRED ONCE, LENT ONE WINDOW AT A TIME. It is registered beside the capture
// guard before the socket opens and stays for the life of the process; a fill
// opens a window for each page it asks (Ask), names the request once the rail
// has minted its id (Asked), waits (Await), and shuts the window (Close).
// Fills never interleave — the phone notifies the rep once per page, so two
// chats paging together would double the notifications for no gain — so one
// window at a time is the shape of the work rather than a limitation.
//
// IT IS A READER, NOT A FEED. Nothing here writes a row or opens a payload:
// the answer's messages reach the seam through the capture guard, registered
// BEFORE this handler so the rows have landed by the time a page is reported.
// The pager's own reading is the page's shape (Page says what that is).
//
// THE WINDOW OPENS ON THE SEND, NOT ON THE ID (the spike's Watcher paid for
// this reading, Codex r2 on #216): the id the answer names does not exist
// until the send returns, and the phone can answer inside that window — so an
// arrival naming a request while ours is still on the wire is HELD, and Asked
// replays the one that answers ours and drops the rest. Before the window
// opens, everything that arrives belongs to some earlier request: a page
// queued for a sitting that timed out is handed over on connect, and counting
// it would report progress this fill never made.
type Pager struct {
	mu sync.Mutex
	// open is true from the moment a request goes on the wire until the
	// sitting shuts the window.
	open bool
	// chat and addressed are the two names of the chat this window is about —
	// the seam's PN-canonical identity and the LID the request addressed —
	// because the answer may be filed under either (historyspike's
	// MatchConversation).
	chat, addressed types.JID
	// asked is the id the rail minted for the request, known only once the
	// send returns.
	asked types.MessageID
	// pending holds arrivals that named a request while ours was still on the
	// wire.
	pending []arrival
	page    Page
	got     bool
	// changed wakes Await; buffered and dropped when full, because it carries
	// no information beyond "look again".
	changed chan struct{}
}

// arrival is one answer the phone sent, beside the request it says it answers
// ("" when it says nothing).
type arrival struct {
	answers string
	page    Page
}

// NewPager builds a pager with no window open.
func NewPager() *Pager {
	return &Pager{changed: make(chan struct{}, 1)}
}

// Ask opens the window for one page. Call it immediately before the request
// goes out; it discards whatever the previous window held, so a sitting's
// second page can never be answered by its first page's arrival.
func (p *Pager) Ask(chat, addressed types.JID) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.open, p.chat, p.addressed = true, chat, addressed
	p.asked, p.pending, p.page, p.got = "", nil, Page{}, false
}

// Asked names the request the phone's answer must state — the id the rail
// minted for it — and replays whatever arrived while the send was still
// waiting for its acknowledgement.
func (p *Pager) Asked(request types.MessageID) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.asked = request
	for _, held := range p.pending {
		if held.answers == string(request) {
			p.take(held.page)
		}
	}
	p.pending = nil
	p.wake()
}

// Close shuts the window. Everything that arrives after it belongs to nobody.
func (p *Pager) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.open, p.pending = false, nil
}

// Await returns the page, or reports that the phone did not answer inside the
// bound. The bound is what makes a fill terminate whatever the phone does — a
// link day held open by a phone that stopped answering is the failure this
// exists to refuse.
func (p *Pager) Await(within time.Duration) (Page, bool) {
	bound := time.After(within)
	for {
		select {
		case <-p.changed:
			if page, ok := p.answered(); ok {
				return page, true
			}
		case <-bound:
			return p.answered()
		}
	}
}

// HandleEvent consumes one raw whatsmeow event. ONE of them is an answer to a
// fill's request: the history sync the phone sends back. Everything else the
// rail emits during a sitting is nothing the fill asked about.
func (p *Pager) HandleEvent(evt any) {
	arrived, ok := evt.(*events.HistorySync)
	if !ok {
		return
	}
	// The phone pushes RECENT and other sync types on its own schedule; only
	// ON_DEMAND is an answer to a request (whatsmeow's own
	// BuildHistorySyncRequest says so where it builds one).
	if arrived.Data.GetSyncType() != waHistorySync.HistorySync_ON_DEMAND {
		return
	}
	p.inspect(arrived.Notification.GetPeerDataRequestSessionID(), p.read(arrived.Data))
}

// read counts what one arriving blob holds FOR THE CHAT ASKED ABOUT and
// nothing else. A blob can carry several conversations, and counting all of
// their messages would report a number that is not the answer to the question
// asked.
func (p *Pager) read(blob *waHistorySync.HistorySync) Page {
	p.mu.Lock()
	chat, addressed := p.chat, p.addressed
	p.mu.Unlock()

	var page Page
	for _, conv := range blob.GetConversations() {
		// KNOWING THE CHAT BY BOTH ITS NAMES, which is the whole finding of
		// #216: the phone keys the answering conversation by LID and states
		// neither alternative, so a match on the PN form alone reads every
		// answer as empty.
		if !historyspike.MatchConversation(conv, chat, addressed).Matched {
			continue
		}
		if conv.EndOfHistoryTransferType != nil {
			page.EndOfTransfer = conv.GetEndOfHistoryTransferType().String()
		}
		for _, entry := range conv.GetMessages() {
			page.Messages++
			// THE OLDEST, because that is the next request's anchor — the same
			// rule the capture guard folds the NEWEST out of for the directory
			// row, called rather than copied (directory.AnchorFromHistoryRow).
			candidate, ok := directory.AnchorFromHistoryRow(entry.GetMessage())
			if !ok {
				continue
			}
			if page.Oldest.At.IsZero() || candidate.At.Before(page.Oldest.At) {
				page.Oldest = candidate
			}
		}
	}
	return page
}

// inspect decides whether one arrival is this window's, by the same rule the
// spike's watcher applies: nothing counts before the window opened; an arrival
// naming THIS request counts; one naming ANOTHER is somebody else's; one
// naming NONE counts, because nothing can attribute it elsewhere; and one
// naming a request while ours is still on the wire is held for Asked.
func (p *Pager) inspect(answers string, page Page) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.open {
		return
	}
	switch {
	case answers == "":
	case p.asked == "":
		p.pending = append(p.pending, arrival{answers: answers, page: page})
		return
	case answers != string(p.asked):
		return
	}
	p.take(page)
	p.wake()
}

// take folds one arrival into what this window will report — the counts add up
// and the oldest instant is the oldest so far, so two chunks dispatched before
// Await looks are one page rather than the second overwriting the first. The
// lock is the caller's.
//
// A CHUNK THAT ARRIVES LATE IS DISCARDED, and that is a trade rather than an
// oversight. `Await` returns on the first arrival and `ask` shuts the window
// behind it, so an answer split across notifications a second apart loses its
// tail. The rig saw exactly ONE chunk per request, on three pairings, at both
// anchors (#216) — and the alternative is the spike's settle window, ten
// seconds per page, which on a twenty-page fill is another three minutes of a
// rep watching a progress view. Carried on the horizon ([#117]): if a phone
// ever splits an answer, the page's own count and its oldest instant are what
// go short, and the next page's anchor is a message that is not the oldest.
func (p *Pager) take(page Page) {
	p.page.Messages += page.Messages
	if p.page.EndOfTransfer == "" {
		p.page.EndOfTransfer = page.EndOfTransfer
	}
	if !page.Oldest.At.IsZero() && (p.page.Oldest.At.IsZero() || page.Oldest.At.Before(p.page.Oldest.At)) {
		p.page.Oldest = page.Oldest
	}
	p.got = true
}

// answered reads what has arrived so far.
func (p *Pager) answered() (Page, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.page, p.got
}

// wake nudges Await without ever blocking whatsmeow's event-handler goroutine;
// the lock is held by the callers.
func (p *Pager) wake() {
	select {
	case p.changed <- struct{}{}:
	default:
	}
}

package historyspike

import (
	"fmt"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// answerSettle is how long the wait keeps listening after history arrives.
// A phone may answer ONE request in several notifications, and whatsmeow
// dispatches one event per notification — so a wait that returned on the
// first of them would record a count far below what the phone actually
// sent, and the count is the finding this ticket exists to record (#216).
// The window restarts on each chunk, and the overall bound still caps
// everything.
const answerSettle = 10 * time.Second

// Ending is how the wait for the phone's answer finished, and the three are
// the whole of it: the history arrived, the protocol refused with a code, or
// the bound ran out. Every one of them is named — a rig command that exits
// without saying which of the three happened tells the operator nothing.
type Ending string

const (
	// Answered — an ON_DEMAND history sync arrived; the counts say what was
	// in it. The plane exits 0 on this and only this.
	Answered Ending = "answered"
	// Refused — the phone answered the peer request with a response code
	// (REQUEST_TIME_EXPIRED, DECLINED_SHARING_HISTORY, …). Which code it is
	// is the whole finding: it says whether re-pairing with the on-demand
	// capability advertised could change the answer.
	Refused Ending = "refused"
	// TimedOut — nothing arrived inside the bound. Not a refusal: the phone
	// may have been asleep, offline, or slower than the wait.
	TimedOut Ending = "timed_out"
)

// Finding is what the spike learned, and it is content-free by construction
// (ADR-0025): counts, one instant, the protocol's own two names, and the
// chat the operator asked about. No message text, no push name, no chat
// name, no JID but that one — the answer's conversations carry all of those
// and none of them is copied here.
type Finding struct {
	// Chat is the chat the request asked about — the flag's own value.
	Chat   types.JID
	Ending Ending
	// SyncType is what the arriving history called itself, read off the blob
	// rather than assumed, so the line reports the phone's own word.
	SyncType string
	// Chunks is how many history events made up the answer. One request need
	// not come back in one piece, and how the phone splits it is itself a
	// finding for the fill that pages to the ninety-day line.
	Chunks int
	// Conversations is how many conversation entries the answer carried
	// across those chunks — its size, without naming any of them. Entries,
	// not distinct chats: a chat carried by two chunks counts twice.
	Conversations int
	// Matched is how many of those conversation entries were the chat asked
	// about, under either of its names. A blob whose conversation matched
	// NONE reads as `matched=0` rather than as an empty answer, which is the
	// distinction the earlier arms could not make (#216).
	Matched int
	// Messages is how many messages came back for the chat asked about.
	Messages int
	// ConvKey, PNStated and LIDStated are how the phone filed the answering
	// conversation: which identity form its own key was, and whether it also
	// stated the other two. What a later request must name is decided by
	// these three.
	ConvKey   string
	PNStated  bool
	LIDStated bool
	// Oldest is the oldest instant among those messages; the zero time when
	// none came back, which the line renders as `none`.
	Oldest time.Time
	// EndOfTransfer, LastMessage and Unread are what the answering
	// CONVERSATION states about itself — the phone's own account of whether
	// more remains on the primary (`endOfHistoryTransferType`), the instant
	// of its newest message, and its unread count. All three are numbers or
	// enum names, and they are the fields that would say "this chat is
	// exhausted" if the phone believes it is (#216).
	EndOfTransfer string
	LastMessage   time.Time
	Unread        uint32
	// Access is what the phone said about this companion's access to the
	// history it answered about (accessStatus argues why it decides whether
	// the request is wrong or the grant is missing).
	Access string
	// Code is the protocol's response code on a refusal.
	Code string
	// Waited is the bound that ran out on a timeout.
	Waited time.Duration
}

// Line is the one line the mode prints, and its shape is pinned by a test
// (ticket #216 AC 2). Each ending prints only what it actually learned: a
// refusal has no counts and a timeout has no code, so an operator reading
// the line can never mistake one ending for another.
func (f Finding) Line() string {
	switch f.Ending {
	case Answered:
		return fmt.Sprintf("history spike: %s chat=%s sync_type=%s chunks=%d conversations=%d matched=%d messages=%d oldest=%s end_of_transfer=%s last_msg=%s unread=%d access=%s conv_key=%s conv_pn_stated=%s conv_lid_stated=%s",
			f.Ending, f.Chat, f.SyncType, f.Chunks, f.Conversations, f.Matched, f.Messages, oldestInstant(f.Oldest),
			transferState(f.EndOfTransfer), oldestInstant(f.LastMessage), f.Unread, accessOf(f.Access),
			convKeyOf(f.ConvKey), statedYesNo(f.PNStated), statedYesNo(f.LIDStated))
	case Refused:
		return fmt.Sprintf("history spike: %s chat=%s code=%s", f.Ending, f.Chat, f.Code)
	default:
		return fmt.Sprintf("history spike: %s chat=%s waited=%s", f.Ending, f.Chat, f.Waited)
	}
}

// convKeyOf renders which identity form the phone filed the conversation
// under; an unset one is the same as no conversation having matched.
func convKeyOf(key string) string {
	if key == "" {
		return convKeyUnmatched
	}
	return key
}

// transferState renders what the conversation said about the rest of its
// history, or says plainly that it said nothing.
func transferState(state string) string {
	if state == "" {
		return "none"
	}
	return state
}

// oldestInstant renders an instant in UTC, or says plainly
// that there was none — an answer carrying nothing for this chat is a real
// result, and an epoch timestamp printed for it would read as a message from
// 1970.
func oldestInstant(oldest time.Time) string {
	if oldest.IsZero() {
		return "none"
	}
	return oldest.UTC().Format(time.RFC3339)
}

// Watcher waits for the phone's answer to one on-demand history request.
// Wire HandleEvent through whatsmeow.Client.AddEventHandler before the
// socket opens, say when the request goes out (Asking) and which request it
// was once the rail has minted its id (Asked), then call Await.
//
// THE PHONE HANDS OVER WHAT IT COULD NOT DELIVER EARLIER (Codex r1). A run
// that timed out leaves its answer — or its refusal — queued, and the next
// run receives it on connect, before it has asked anything. Read as this
// run's finding it would record an answer the phone never gave this request,
// and exit 0 on it. So nothing counts until Asking, and after it a refusal
// must still name this request or name none.
//
// IT IS A READER, NOT A FEED. Nothing here writes a row, opens a payload or
// touches the ingest path: the answer's messages are counted and dropped,
// which is what makes the mode safe to run against a live rig session
// (ticket #216; ADR-0023 — the out-of-scope past never leaves the plane, and
// here nothing at all does).
type Watcher struct {
	chat types.JID
	// addressed is the identity the REQUEST named the chat by — the
	// counterparty's LID when the run asked that way, the same JID as chat
	// otherwise. The answer may be filed under either, and matching only the
	// first is what made every answer read empty (#216, MatchConversation).
	addressed types.JID
	// trace is the verbose lane's sink, nil in the ordinary mode. Set once at
	// construction and never again, so the event-handler goroutine reads it
	// without the lock.
	trace Trace

	mu sync.Mutex
	// asking is true from the moment the request goes on the wire: before it,
	// everything that arrives belongs to some earlier run.
	asking bool
	// asked is the id the rail minted for the request, known only once the
	// send returns; a refusal has to name it (or name nothing) to be this
	// request's finding.
	asked types.MessageID
	// pending holds arrivals that named a request while ours was still on the
	// wire — the send waits for the server's acknowledgement, and the phone
	// can answer inside that window. Each carries the request it names, so
	// Asked replays the ones that answer ours and drops the rest.
	pending []arrival
	// answer accumulates the chunks of one answer, and refusal holds the
	// first refusal. Both are read by Await under the same lock, so a chunk
	// arriving mid-read can never be half-counted.
	answer  Finding
	refusal Finding
	// changed wakes Await; buffered and dropped when full, because it
	// carries no information beyond "look again".
	changed chan struct{}
}

// arrival is one thing the phone sent, beside the request it says it answers
// ("" when it says nothing).
type arrival struct {
	answers string
	finding Finding
}

// decided is what the watcher made of one event: how its request id stood to
// this run's, and which arm of the rule it took. BOTH COME FROM ONE LOCK
// ACQUISITION, so a trace line can never claim no comparison was possible
// while its own verdict shows one was made.
type decided struct {
	correlation string
	verdict     string
}

// Trace receives one content-free line for every event the watcher
// inspected, saying what it did with it — the rig's verbose lane, and the
// one home of why it exists: run 1 of the spike timed out, and a finding
// that says `timed_out` cannot tell SILENCE from an answer the watcher
// declined to attribute to this request (#216). nil is the default and
// means silence.
//
// The lines carry the protocol's own words and the plane's own verdicts, and
// no identity at all: no text, no push name, no chat name, no JID, and
// NEITHER REQUEST ID — the comparison is what an operator needs, and the
// value is what the phone calls one message.
type Trace func(line string)

// How one event's request id compared with this run's, which is the whole of
// what the trace says about either id.
const (
	// correlationNone — the event named no request, so there was nothing to
	// compare and the rule takes it as this run's.
	correlationNone = "none"
	// correlationUnknown — the event named a request while the send had not
	// yet returned this run's id, so no comparison was possible yet.
	correlationUnknown = "unknown"
	correlationMatched = "matched"
	correlationDiffers = "differs"
)

// What the rule DID with one event. The word says which arm of the rule the
// event took, not whether it changed the finding — a second refusal is
// attributed and says nothing new (apply).
const (
	verdictCounted        = "counted"
	verdictRefused        = "refused"
	verdictHeld           = "held"
	verdictNotOnDemand    = "ignored:not_on_demand"
	verdictBeforeRequest  = "ignored:before_request"
	verdictAnotherRequest = "ignored:another_request"
	verdictNotARefusal    = "ignored:not_a_refusal"
	verdictNotOwnPhone    = "ignored:not_own_phone"
)

// What the trace prints for a peer response's code where the protocol's own
// word is not available.
const (
	// codeNone — the response carries no on-demand result at all, so there is
	// no code to state (a response of another kind entirely).
	codeNone = "none"
	// codeUnstated — an on-demand result with its code field absent. Not
	// rendered as REQUEST_SUCCESS, which is the enum's zero value: reporting
	// an acknowledgement nobody sent would be an invention, and telling the
	// two apart is the whole point of this lane.
	codeUnstated = "unstated"
)

// NewWatcher builds a watcher for one chat's answer, silent: the mode's
// three lines are its whole output.
func NewWatcher(chat types.JID) *Watcher {
	return NewTracingWatcher(chat, chat, nil)
}

// NewTracingWatcher builds a watcher that also tells trace what it saw.
func NewTracingWatcher(chat, addressed types.JID, trace Trace) *Watcher {
	return &Watcher{chat: chat, addressed: addressed, trace: trace, changed: make(chan struct{}, 1)}
}

// Asking opens the window in which an arriving answer or refusal is this
// run's. Call it immediately before the request goes out: the id the refusal
// will name does not exist until the send returns, so the window has to open
// on the send rather than on the id.
func (w *Watcher) Asking() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.asking = true
}

// Asked names the request the phone's answer or refusal must state — the id
// the rail minted for it (Request returns it) — and reconciles what arrived
// while the send was still waiting for its acknowledgement: whatever answers
// this request is kept, the rest was somebody else's.
func (w *Watcher) Asked(request types.MessageID) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.asking = true
	w.asked = request
	for _, held := range w.pending {
		if held.answers == string(request) {
			w.apply(held.finding)
		}
	}
	w.pending = nil
	w.wake()
}

// Await returns the finding: the accumulated answer once it has settled, the
// first refusal, or the timeout once the bound runs out. The bound is what
// makes the wait terminate whatever the phone does — an operator holding a
// rig session open is the reason this can never be unbounded.
//
// HISTORY THAT ARRIVED OUTRANKS A REFUSAL THAT FOLLOWS IT: the phone sent
// what was asked for, and that is the fact the ticket records.
func (w *Watcher) Await(within time.Duration) Finding {
	bound := time.After(within)
	// nil until history arrives, and a receive on a nil channel blocks — so
	// the settle window exists only once there is something to settle.
	var settled <-chan time.Time
	for {
		select {
		case <-w.changed:
			answer, refusal := w.recorded()
			switch {
			case answer.Ending == Answered:
				settled = time.After(answerSettle)
			case refusal.Ending == Refused:
				return refusal
			}
		case <-settled:
			answer, _ := w.recorded()
			return answer
		case <-bound:
			if answer, _ := w.recorded(); answer.Ending == Answered {
				return answer
			}
			return Finding{Chat: w.chat, Ending: TimedOut, Waited: within}
		}
	}
}

// HandleEvent consumes one raw whatsmeow event. Two of them can end the
// wait: the history sync that IS the answer, and the peer response the phone
// sends when it will not answer. Everything else the rail emits during a
// spike run — receipts, presence, app-state, ordinary messages — is nothing
// this command asked about.
func (w *Watcher) HandleEvent(evt any) {
	switch e := evt.(type) {
	case *events.HistorySync:
		w.readHistory(e)
	case *events.Message:
		w.readPeerResponse(e)
	}
}

// readHistory decides what one arriving history event is to this run, and
// leaves a trace line saying so — EVERY event, whatever its sync type, which
// is what separates the two readings of a timeout (Trace).
func (w *Watcher) readHistory(evt *events.HistorySync) {
	// WHICH REQUEST THIS HISTORY ANSWERS, when the phone says (Codex r2). A
	// notification received on connect — queued for a run that timed out —
	// downloads asynchronously and can be dispatched after this run asked, so
	// the boundary alone is not enough to tell whose answer it is.
	// `peerDataRequestSessionID` is the phone's own correlation for a sync a
	// peer request asked for.
	answers := evt.Notification.GetPeerDataRequestSessionID()
	// The phone pushes RECENT and other sync types on its own schedule; only
	// ON_DEMAND is an answer to a request (whatsmeow's
	// BuildHistorySyncRequest says so where it builds one).
	gate := ""
	if evt.Data.GetSyncType() != waHistorySync.HistorySync_ON_DEMAND {
		gate = verdictNotOnDemand
	}
	chunk := w.chunk(evt.Data)
	chunk.Access = accessStatus(evt.Notification)
	saw := w.inspect(answers, chunk, gate)
	w.say("saw history sync_type=%s chunk_order=%d conversations=%d answers=%s verdict=%s",
		evt.Data.GetSyncType(), evt.Data.GetChunkOrder(), len(evt.Data.GetConversations()),
		saw.correlation, saw.verdict)
}

// chunk counts what one arriving history event holds FOR THE CHAT ASKED
// ABOUT and nothing else. A blob can carry several conversations, and
// counting all of their messages would report a number that is not the
// answer to the question asked.
//
// THE OLDEST INSTANT IS FOLDED ONLY OVER MESSAGES THAT STATE ONE. A history
// row's timestamp is optional in the proto, and an absent one crosses as
// zero — printed as the oldest message it would read as a message from 1970
// and make the reach of the answer look decades deeper than it is. The same
// distinction the plane already draws for a rail timestamp it cannot use
// (ingest's reactionSenderTsMS): absent is absent, never the epoch. The row
// is still COUNTED, because it did come back.
func (w *Watcher) chunk(blob *waHistorySync.HistorySync) Finding {
	chunk := Finding{
		Chat:          w.chat,
		Ending:        Answered,
		SyncType:      blob.GetSyncType().String(),
		Chunks:        1,
		Conversations: len(blob.GetConversations()),
	}
	for _, conv := range blob.GetConversations() {
		match := w.match(conv)
		if !match.Matched {
			continue
		}
		chunk.Matched++
		chunk.ConvKey, chunk.PNStated, chunk.LIDStated = match.Key, match.PNStated, match.LIDStated
		if conv.EndOfHistoryTransferType != nil {
			chunk.EndOfTransfer = conv.GetEndOfHistoryTransferType().String()
		}
		if ts := conv.GetLastMsgTimestamp(); ts > 0 {
			chunk.LastMessage = time.Unix(int64(ts), 0).UTC()
		}
		chunk.Unread = conv.GetUnreadCount()
		for _, entry := range conv.GetMessages() {
			chunk.Messages++
			at, stated := historyInstant(entry.GetMessage())
			if stated && (chunk.Oldest.IsZero() || at.Before(chunk.Oldest)) {
				chunk.Oldest = at
			}
		}
	}
	return chunk
}

// isChatAsked reports whether one conversation in the answer is the chat the
// request named. The rail addresses modern DMs by the hidden-user (LID)
// identity while the seam and the allowlist carry phone-number JIDs, and a
// LID-identified thread states its phone number as the blob's own `pnJID` —
// the same alternative the capture guard canonicalizes through (ingest's
// canonicalHistoryChat, ADR-0023). Reading both is what keeps the answer
// from looking empty for a chat the phone did answer about.
func (w *Watcher) match(conv *waHistorySync.Conversation) ConversationMatch {
	return MatchConversation(conv, w.chat, w.addressed)
}

// historyInstant is a history row's own send time, read exactly as the
// backfill feed reads it (ingest's historyOccurredAt): history lands with
// its own past, not the sync's present. It reports whether the row stated
// one at all — a zero timestamp is an absence, and no message was ever sent
// at the Unix epoch.
func historyInstant(webMsg *waWeb.WebMessageInfo) (at time.Time, stated bool) {
	ts := webMsg.GetMessageTimestamp()
	if ts == 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(ts), 0).UTC(), true
}

// readPeerResponse takes the phone's refusal out of a peer response, if that
// is what this message is: the response code the protocol names, which is
// the whole of what a refusal says.
//
// THE ACCOUNT'S OWN PRIMARY DEVICE OR NOTHING, which is the same gate
// whatsmeow puts on its own peer-response handling (message.go's
// handleProtocolMessage: `!info.IsFromMe` returns, and the peer switch runs
// only for `Sender.Device == 0`). A counterparty can put any protobuf on the
// wire, this one included, and a spike that read a stranger's message as its
// own phone's refusal would record a false finding on the ticket the whole
// slice rests on.
//
// AND THIS REQUEST OR NONE. The response states the request it answers
// (`stanzaID`, which is how whatsmeow routes its own peer responses), so a
// response naming another request is somebody else's. A response that names
// NO request is taken: nothing can attribute it elsewhere, and refusing it
// would turn a real decline into a timeout.
//
// REQUEST_SUCCESS IS NOT A REFUSAL: the phone acknowledges the request and
// the history follows as its own event, so the wait goes on.
func (w *Watcher) readPeerResponse(msg *events.Message) {
	response := msg.Message.GetProtocolMessage().GetPeerDataOperationRequestResponseMessage()
	if response == nil {
		// An ordinary delivery is not a response to anything this command
		// asked, and a line per delivery would bury the ones that are.
		return
	}
	code, refused := refusalCode(response)
	saw := w.inspect(response.GetStanzaID(), Finding{Chat: w.chat, Ending: Refused, Code: code},
		peerResponseGate(msg, response, refused))
	w.say("saw peer response type=%s code=%s answers=%s verdict=%s",
		response.GetPeerDataOperationRequestType(), statedCode(response), saw.correlation, saw.verdict)
}

// peerResponseGate names the reason a peer response is not this request's
// refusal, or the empty string when the attribution rule is what decides.
// The three gates are the ones the finding has always applied — the
// account's own primary device, an on-demand request type, and a code that
// actually refuses — and each now says so.
func peerResponseGate(msg *events.Message, response *waE2E.PeerDataOperationRequestResponseMessage, refused bool) string {
	if !msg.Info.IsFromMe || msg.Info.Sender.Device != 0 {
		return verdictNotOwnPhone
	}
	switch response.GetPeerDataOperationRequestType() {
	case waE2E.PeerDataOperationRequestType_HISTORY_SYNC_ON_DEMAND,
		waE2E.PeerDataOperationRequestType_FULL_HISTORY_SYNC_ON_DEMAND:
	default:
		return verdictNotOnDemand
	}
	if !refused {
		return verdictNotARefusal
	}
	return ""
}

// say emits one trace line, or nothing at all in the ordinary mode.
func (w *Watcher) say(format string, args ...any) {
	if w.trace == nil {
		return
	}
	w.trace("history spike: " + fmt.Sprintf(format, args...))
}

// correlationLocked renders how one event's request id stands to this run's,
// and never either id. The lock is the caller's — it is read in the same
// breath as the decision it explains.
func (w *Watcher) correlationLocked(answers string) string {
	switch {
	case answers == "":
		return correlationNone
	case w.asked == "":
		return correlationUnknown
	case answers == string(w.asked):
		return correlationMatched
	default:
		return correlationDiffers
	}
}

// statedCode is the code a peer response STATES, whatever it means — the
// trace's field, not the finding's (Codex r1 on the verbose lane).
//
// A SUCCESS AND A SILENCE ARE DIFFERENT FINDINGS, and run 1's timeout is
// exactly the case where the difference decides what to do next: a phone that
// acknowledged the request and then sent no history is not a phone that
// answered nothing at all. `refusalCode` deliberately discards a success —
// it answers "does this refuse?" — so the displayed code is read here,
// independently, and the finding's behaviour is untouched.
func statedCode(response *waE2E.PeerDataOperationRequestResponseMessage) string {
	for _, result := range response.GetPeerDataOperationResult() {
		onDemand := result.GetFullHistorySyncOnDemandRequestResponse()
		if onDemand == nil {
			continue
		}
		if onDemand.ResponseCode == nil {
			return codeUnstated
		}
		return onDemand.GetResponseCode().String()
	}
	return codeNone
}

// refusalCode reads the response code out of a peer response's results —
// the one field a refusal states — and reports whether it refuses at all.
func refusalCode(response *waE2E.PeerDataOperationRequestResponseMessage) (string, bool) {
	for _, result := range response.GetPeerDataOperationResult() {
		onDemand := result.GetFullHistorySyncOnDemandRequestResponse()
		if onDemand == nil {
			continue
		}
		if code := onDemand.GetResponseCode(); code != waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_SUCCESS {
			return code.String(), true
		}
	}
	return "", false
}

// inspect takes one arrival — a chunk of history or a refusal — beside the
// request it says it answers, and decides whether it is this run's.
//
// THE RULE IS ONE RULE FOR BOTH KINDS, and it reads the same comparison the
// trace prints: nothing counts before the request went on the wire; an
// arrival that names THIS request counts; one that names ANOTHER is somebody
// else's; one that names NONE counts, because nothing can attribute it
// elsewhere. An arrival that names a request while ours is still
// on the wire — the send waits for the server's acknowledgement — is held for
// Asked to reconcile.
//
// A gate already refused the event when `gate` names a reason; the rule then
// only renders the comparison, so a gated event still leaves an honest line.
//
// It returns what it decided, which is what the verbose trace prints.
func (w *Watcher) inspect(answers string, finding Finding, gate string) decided {
	w.mu.Lock()
	defer w.mu.Unlock()
	correlation := w.correlationLocked(answers)
	if gate != "" {
		return decided{correlation: correlation, verdict: gate}
	}
	if !w.asking {
		// Queued for a run that timed out, handed over on connect.
		return decided{correlation: correlation, verdict: verdictBeforeRequest}
	}
	switch correlation {
	case correlationUnknown:
		w.pending = append(w.pending, arrival{answers: answers, finding: finding})
		return decided{correlation: correlation, verdict: verdictHeld}
	case correlationDiffers:
		return decided{correlation: correlation, verdict: verdictAnotherRequest}
	}
	w.apply(finding)
	w.wake()
	if finding.Ending == Answered {
		return decided{correlation: correlation, verdict: verdictCounted}
	}
	return decided{correlation: correlation, verdict: verdictRefused}
}

// apply folds one arrival into what the wait will report: the answer's counts
// add up and its oldest instant is the oldest across the whole of it, while
// the first refusal stands — the request was asked once, so a second says
// nothing new. The lock is the caller's.
func (w *Watcher) apply(finding Finding) {
	if finding.Ending != Answered {
		if w.refusal.Ending != Refused {
			w.refusal = finding
		}
		return
	}
	if w.answer.Ending != Answered {
		w.answer = finding
		return
	}
	w.answer.Chunks += finding.Chunks
	w.answer.Conversations += finding.Conversations
	w.answer.Matched += finding.Matched
	w.answer.Messages += finding.Messages
	// How the phone filed the conversation is stated per chunk; the first
	// chunk that matched is what the line names, and a statement anywhere in
	// the answer counts as stated.
	if w.answer.ConvKey == "" || w.answer.ConvKey == convKeyUnmatched {
		w.answer.ConvKey = finding.ConvKey
	}
	w.answer.PNStated = w.answer.PNStated || finding.PNStated
	w.answer.LIDStated = w.answer.LIDStated || finding.LIDStated
	// What the conversation says about itself is stated once per chunk; the
	// first chunk that says anything is what stands.
	if w.answer.EndOfTransfer == "" {
		w.answer.EndOfTransfer = finding.EndOfTransfer
	}
	if w.answer.LastMessage.IsZero() {
		w.answer.LastMessage = finding.LastMessage
	}
	if w.answer.Unread == 0 {
		w.answer.Unread = finding.Unread
	}
	w.answer.Access = accessAcross(w.answer.Access, finding.Access)
	if !finding.Oldest.IsZero() && (w.answer.Oldest.IsZero() || finding.Oldest.Before(w.answer.Oldest)) {
		w.answer.Oldest = finding.Oldest
	}
}

// recorded reads what has arrived so far.
func (w *Watcher) recorded() (answer, refusal Finding) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.answer, w.refusal
}

// wake nudges Await without ever blocking the whatsmeow event-handler
// goroutine; the lock is held by the callers.
func (w *Watcher) wake() {
	select {
	case w.changed <- struct{}{}:
	default:
	}
}

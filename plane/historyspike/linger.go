package historyspike

import (
	"fmt"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Linger keeps listening after the finding is in, and says what it sees.
//
// WHY THE MODE MIGHT HAVE BEEN LEAVING TOO EARLY (#216). Every LID run so
// far lasted about twelve seconds: the phone answered within three, the
// settle window closed ten seconds later, and the command exited. An answer
// that arrives as a metadata chunk FIRST and a data chunk half a minute
// later — which is what reading months of a chat and uploading a blob would
// look like — would have been counted as one empty answer and thrown away
// before the rest arrived. This is the instrument for that: one line per
// history event of ANY type, for as long as the operator asks, and a count
// at the end so silence is distinguishable from "nothing more came".
//
// Content-free like everything else the mode prints: the protocol's own sync
// type and numbers, the count of conversations, and the messages that belong
// to the chat asked about. No identity, no text, no name.
type Linger struct {
	chat types.JID
	// addressed is the chat's other name — the identity the request used
	// (MatchConversation says why both are needed).
	addressed types.JID
	say       Trace

	mu sync.Mutex
	// seen counts the history events that arrived while the lane was open.
	seen int
	// interrupted names the connection event that ended the lane early, if
	// one did. A DROPPED SOCKET IS NOT SILENCE (Codex r1): reconnect is off
	// on this client, so a drop after the answer would otherwise leave the
	// wait running to its timer and print a zero count — the very reading
	// this instrument exists to produce, from an observation that never
	// happened.
	interrupted string
	// closed stops the lane counting or printing once the finding is being
	// stated, so nothing can land after the count that claims to be final.
	closed bool
	// ended is closed when an interruption is recorded, so the wait returns
	// at once rather than sitting out a socket that is gone.
	ended chan struct{}
}

// NewLinger builds a linger for one chat's events. A nil trace makes it
// silent, which is what the ordinary mode passes.
func NewLinger(chat, addressed types.JID, trace Trace) *Linger {
	return &Linger{chat: chat, addressed: addressed, say: trace, ended: make(chan struct{})}
}

// HandleEvent consumes one raw whatsmeow event; wire it beside the
// watcher's. Only history events are reported — a receipt or a presence
// update is not what this instrument is looking for.
func (l *Linger) HandleEvent(evt any) {
	switch e := evt.(type) {
	case *events.HistorySync:
		if !l.count() {
			return
		}
		blob := e.Data
		matched, messages, key, pnStated, lidStated := l.readConversations(blob)
		l.trace("saw history sync_type=%s chunk_order=%d progress=%d conversations=%d matched=%d messages=%d oldest_in_chunk=%s access=%s conv_key=%s conv_pn_stated=%s conv_lid_stated=%s",
			blob.GetSyncType(), blob.GetChunkOrder(), blob.GetProgress(),
			len(blob.GetConversations()), matched, messages,
			oldestInstant(oldestInChunk(e.Notification)), accessStatus(e.Notification),
			convKeyOf(key), statedYesNo(pnStated), statedYesNo(lidStated))
	case *events.Disconnected:
		l.interrupt("disconnected")
	case *events.LoggedOut:
		l.interrupt("logged_out")
	case *events.StreamReplaced:
		l.interrupt("stream_replaced")
	case *events.TemporaryBan:
		l.interrupt("temporary_ban")
	case *events.KeepAliveTimeout:
		l.interrupt("keepalive_timeout")
	}
}

// count records one history event and reports whether the lane is still
// open; a closed lane neither counts nor prints.
func (l *Linger) count() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.seen++
	return true
}

// interrupt records the first connection event that ended the lane and wakes
// the wait. Later ones say nothing new.
func (l *Linger) interrupt(what string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.interrupted != "" {
		return
	}
	l.interrupted = what
	close(l.ended)
}

// Close ends the lane before its count is stated: after it, no event counts
// and no line is printed, so nothing can follow a count that calls itself
// final (Codex r1). The caller unregisters the handler first; this closes
// the window a callback already in flight would otherwise slip through.
func (l *Linger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
}

// Done is the line that closes the lane: how many history events arrived
// while it was open, how long it was open for, and whether the socket
// survived it. Zero events over the whole duration on a live socket is the
// finding the earlier runs could not state; zero events on an interrupted
// one is no finding at all, and says so.
func (l *Linger) Done(open time.Duration) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return fmt.Sprintf("history spike: linger_done saw=%d open=%s interrupted=%s",
		l.seen, open.Round(time.Second), interruption(l.interrupted))
}

// Wait holds the lane open for the given duration, or until the socket goes
// — whichever comes first. It returns how long it was actually open, which
// is what makes an interrupted lane readable.
func (l *Linger) Wait(within time.Duration) time.Duration {
	started := time.Now()
	select {
	case <-time.After(within):
		return within
	case <-l.ended:
		return time.Since(started)
	}
}

// interruption renders the connection event that ended the lane, or says
// plainly that none did.
func interruption(what string) string {
	if what == "" {
		return "none"
	}
	return what
}

func (l *Linger) trace(format string, args ...any) {
	if l.say == nil {
		return
	}
	l.say("history spike: " + fmt.Sprintf(format, args...))
}

// readConversations walks one blob's conversations through the same identity
// rule the watcher applies (MatchConversation), and reports what matched:
// how many entries were the chat asked about, how many messages they carried,
// and how the phone filed the first of them.
func (l *Linger) readConversations(blob *waHistorySync.HistorySync) (matched, messages int, key string, pnStated, lidStated bool) {
	for _, conv := range blob.GetConversations() {
		match := MatchConversation(conv, l.chat, l.addressed)
		if !match.Matched {
			continue
		}
		matched++
		messages += len(conv.GetMessages())
		if key == "" {
			key, pnStated, lidStated = match.Key, match.PNStated, match.LIDStated
		}
	}
	return matched, messages, key, pnStated, lidStated
}

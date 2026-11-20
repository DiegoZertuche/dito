package fill_test

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/fill"
)

// The correlation rule, as a pure test (ticket #222). Which arriving answer is
// THIS request's is the whole of what the pager decides, and the arms are what
// the spike paid a rig session to learn: a page queued for a sitting that
// timed out is handed over on connect, and a phone can answer inside the
// send's own acknowledgement wait.

// noWait is the bound every arm here uses. The answer is already dispatched
// before Await is called, so a bound of nothing distinguishes "arrived" from
// "did not" without waiting for anything.
const noWait = time.Millisecond

var (
	pagerChat = types.NewJID("5215550001", types.DefaultUserServer)
	pagerLID  = types.NewJID("111222333444555", types.HiddenUserServer)
)

func TestAnAnswerThatNamesThisRequestIsThisPagesAnswer(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.Asked("REQ-1")
	pager.HandleEvent(answer("REQ-1", pagerLID, 50, oldest))

	page, ok := pager.Await(noWait)
	if !ok {
		t.Fatal("an answer naming this request was not taken as this page's")
	}
	if page.Messages != 50 {
		t.Errorf("messages = %d, want 50", page.Messages)
	}
	if page.Oldest.MessageID != "OLD" || !page.Oldest.At.Equal(oldest) {
		t.Errorf("oldest = %q at %v, want OLD at %v — it is the next request's anchor", page.Oldest.MessageID, page.Oldest.At, oldest)
	}
}

// The phone can answer inside the send's acknowledgement wait, so the window
// opens on the SEND and an arrival naming a request while ours is still on the
// wire is held for Asked to reconcile.
func TestAnAnswerArrivingBeforeTheRequestIdIsKnownIsReplayed(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.HandleEvent(answer("REQ-2", pagerLID, 12, oldest))

	if _, ok := pager.Await(noWait); ok {
		t.Fatal("an arrival was taken before the request it answers was known — nothing could attribute it yet")
	}
	pager.Asked("REQ-2")
	page, ok := pager.Await(noWait)
	if !ok {
		t.Fatal("the held arrival was not replayed once its request was named")
	}
	if page.Messages != 12 {
		t.Errorf("messages = %d, want the held page's 12", page.Messages)
	}
}

// ...and one that named a DIFFERENT request is somebody else's: a page queued
// for a sitting that timed out is handed over on connect, and counting it
// would report progress this fill never made.
func TestAnAnswerNamingAnotherRequestIsNotThisPages(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.HandleEvent(answer("SOMEBODY-ELSE", pagerLID, 50, oldest))
	pager.Asked("REQ-3")

	if _, ok := pager.Await(noWait); ok {
		t.Fatal("an answer naming another request was counted as this page's")
	}
}

// Nothing at all counts before the window opened.
func TestNothingCountsBeforeTheWindowOpens(t *testing.T) {
	pager := fill.NewPager()
	pager.HandleEvent(answer("REQ-4", pagerLID, 50, oldest))
	pager.Ask(pagerChat, pagerLID)
	pager.Asked("REQ-4")

	if _, ok := pager.Await(noWait); ok {
		t.Fatal("an answer that arrived before the window opened was taken as this page's")
	}
}

// ...and nothing after it closes.
func TestNothingCountsAfterTheWindowCloses(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.Asked("REQ-5")
	pager.Close()
	pager.HandleEvent(answer("REQ-5", pagerLID, 50, oldest))

	if _, ok := pager.Await(noWait); ok {
		t.Fatal("an answer arriving after the window closed was taken")
	}
}

// A RECENT push is the phone's own schedule and not an answer to anything;
// only ON_DEMAND is a page (whatsmeow's own BuildHistorySyncRequest says so
// where it builds one).
func TestAPushedRecentSyncIsNotAPage(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.Asked("REQ-6")
	pushed := answer("REQ-6", pagerLID, 50, oldest)
	pushed.Data.SyncType = waHistorySync.HistorySync_RECENT.Enum()
	pager.HandleEvent(pushed)

	if _, ok := pager.Await(noWait); ok {
		t.Fatal("a RECENT push was read as an answer to an on-demand request")
	}
}

// THE FINDING THE INSTRUMENT WAS BUILT WRONG FOR (#216): the phone keys the
// answering conversation by LID, so a pager that knew only the chat's
// PN-canonical name would read every answer as empty. Both names go in.
func TestAnAnswerKeyedByLIDIsMatched(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.Asked("REQ-7")
	pager.HandleEvent(answer("REQ-7", pagerLID, 3, oldest))

	page, ok := pager.Await(noWait)
	if !ok || page.Messages != 3 {
		t.Fatalf("a LID-keyed answer read as %v/%d messages, want matched with 3", ok, page.Messages)
	}
}

// A conversation for another chat entirely is counted for nobody: a blob can
// carry several, and counting all of their messages would report a number that
// is not the answer to the question asked.
func TestAnotherChatsConversationIsNotCounted(t *testing.T) {
	pager := fill.NewPager()
	pager.Ask(pagerChat, pagerLID)
	pager.Asked("REQ-8")
	pager.HandleEvent(answer("REQ-8", types.NewJID("999888777666555", types.HiddenUserServer), 50, oldest))

	page, ok := pager.Await(noWait)
	if !ok {
		t.Fatal("the answer was not attributed to this request at all")
	}
	if page.Messages != 0 {
		t.Errorf("messages = %d, want 0 — another chat's conversation is not this chat's page", page.Messages)
	}
}

var oldest = time.Date(2026, 5, 17, 1, 42, 41, 0, time.UTC)

// answer builds the shape the phone returns to an on-demand request: an
// ON_DEMAND blob whose notification names the request it answers, carrying one
// conversation keyed by the identity given, with n messages of which the
// oldest states `oldestAt`.
func answer(request string, key types.JID, n int, oldestAt time.Time) *events.HistorySync {
	msgs := make([]*waHistorySync.HistorySyncMsg, 0, n)
	for i := 0; i < n; i++ {
		id, at := "MSG", oldestAt.Add(time.Duration(i+1)*time.Minute)
		if i == 0 {
			id, at = "OLD", oldestAt
		}
		msgs = append(msgs, &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{RemoteJID: proto.String(key.String()), ID: proto.String(id), FromMe: proto.Bool(false)},
			MessageTimestamp: proto.Uint64(uint64(at.Unix())),
			Message:          &waE2E.Message{Conversation: proto.String("x")},
		}})
	}
	return &events.HistorySync{
		Data: &waHistorySync.HistorySync{
			SyncType: waHistorySync.HistorySync_ON_DEMAND.Enum(),
			Conversations: []*waHistorySync.Conversation{{
				ID:                       proto.String(key.String()),
				Messages:                 msgs,
				EndOfHistoryTransferType: waHistorySync.Conversation_COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY.Enum(),
			}},
		},
		Notification: &waE2E.HistorySyncNotification{
			PeerDataRequestSessionID: proto.String(request),
		},
	}
}

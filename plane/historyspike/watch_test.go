package historyspike_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// Constructed whatsmeow events are the plane's test substrate (spec #18):
// the wait's three endings and the shape of what it prints are proven here,
// and the live rail appears only on the rig.

// requestID is the id the rail minted for the request under test — the id a
// refusal has to name to be this request's finding.
const requestID types.MessageID = "3EB0THEREQUESTASKED"

// bound is the wait every test here gives the watcher — short, because a
// test that must observe the timeout ending waits it out.
const bound = 30 * time.Millisecond

// foreignChat, aText, aPushName and aChatName are the four things the output
// must never carry: another chat's identity, a message's words, a
// counterparty's self-chosen name, and the chat's own name (sealed on the
// seam, ADR-0008).
var (
	foreignChat = types.NewJID("5215557654321", types.DefaultUserServer)
	aText       = "el pedido llega el martes"
	aPushName   = "Cliente Contento"
	aChatName   = "Ferretería del Centro"
)

func historyMessage(id string, at time.Time) *waHistorySync.HistorySyncMsg {
	return &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{ID: proto.String(id)},
			MessageTimestamp: proto.Uint64(uint64(at.Unix())),
			PushName:         proto.String(aPushName),
			Message:          &waE2E.Message{Conversation: proto.String(aText)},
		},
	}
}

func conversationOf(chat types.JID, instants ...time.Time) *waHistorySync.Conversation {
	conv := &waHistorySync.Conversation{ID: proto.String(chat.String()), Name: proto.String(aChatName)}
	for i, at := range instants {
		conv.Messages = append(conv.Messages, historyMessage(fmt.Sprintf("3EB0FIXTURE%02d", i), at))
	}
	return conv
}

func historySync(syncType waHistorySync.HistorySync_HistorySyncType, convs ...*waHistorySync.Conversation) *events.HistorySync {
	return &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType:      syncType.Enum(),
		Conversations: convs,
		Pushnames:     []*waHistorySync.Pushname{{ID: proto.String(foreignChat.String()), Pushname: proto.String(aPushName)}},
	}}
}

// historySyncAnswering is the same blob with the phone's own correlation on
// it: the notification says which peer request this sync answers.
func historySyncAnswering(answers types.MessageID, convs ...*waHistorySync.Conversation) *events.HistorySync {
	sync := historySync(waHistorySync.HistorySync_ON_DEMAND, convs...)
	sync.Notification = &waE2E.HistorySyncNotification{
		SyncType:                 waE2E.HistorySyncType_ON_DEMAND.Enum(),
		PeerDataRequestSessionID: proto.String(string(answers)),
	}
	return sync
}

// peerResponse is the phone's answer to a peer request as whatsmeow
// dispatches it: an ordinary message event from the account's own primary
// device carrying a protocol message.
func peerResponse(fromMe bool, device uint16, answers types.MessageID, code waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_FullHistorySyncOnDemandResponseCode) *events.Message {
	self := types.NewJID("5215559999", types.DefaultUserServer)
	self.Device = device
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: self.ToNonAD(), Sender: self, IsFromMe: fromMe},
			ID:            "3EB0PEERRESPONSE",
		},
		Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE.Enum(),
			PeerDataOperationRequestResponseMessage: &waE2E.PeerDataOperationRequestResponseMessage{
				PeerDataOperationRequestType: waE2E.PeerDataOperationRequestType_HISTORY_SYNC_ON_DEMAND.Enum(),
				StanzaID:                     proto.String(string(answers)),
				PeerDataOperationResult: []*waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult{{
					FullHistorySyncOnDemandRequestResponse: &waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_FullHistorySyncOnDemandRequestResponse{
						ResponseCode: code.Enum(),
					},
				}},
			},
		}},
	}
}

func TestTheWaitEndsOnTheOnDemandHistoryForTheChatAsked(t *testing.T) {
	oldest := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND,
		conversationOf(customerChat(), oldest.Add(time.Hour), oldest, oldest.Add(2*time.Hour))))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Answered {
		t.Fatalf("ending = %s, want answered", got.Ending)
	}
	if got.SyncType != "ON_DEMAND" {
		t.Errorf("sync type = %q, want ON_DEMAND", got.SyncType)
	}
	if got.Messages != 3 {
		t.Errorf("messages = %d, want 3", got.Messages)
	}
	if !got.Oldest.Equal(oldest) {
		t.Errorf("oldest = %s, want %s", got.Oldest, oldest)
	}
	if got.Conversations != 1 {
		t.Errorf("conversations = %d, want 1", got.Conversations)
	}
}

func TestTheAnswerCarriesWhatTheConversationSaysAboutItself(t *testing.T) {
	// The three fields that would say "this chat is exhausted" if the phone
	// believed it — the reading every empty answer so far has left open.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	conv := conversationOf(customerChat(), at)
	conv.EndOfHistoryTransferType = waHistorySync.Conversation_COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY.Enum()
	conv.LastMsgTimestamp = proto.Uint64(uint64(at.Add(time.Hour).Unix()))
	conv.UnreadCount = proto.Uint32(4)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asking()

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))
	got := watcher.Await(bound)

	if got.EndOfTransfer != "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY" {
		t.Errorf("end of transfer = %q, want the conversation's own word", got.EndOfTransfer)
	}
	if !got.LastMessage.Equal(at.Add(time.Hour)) {
		t.Errorf("last message = %s, want %s", got.LastMessage, at.Add(time.Hour))
	}
	if got.Unread != 4 {
		t.Errorf("unread = %d, want 4", got.Unread)
	}
}

func TestTheAnswerSaysWhatThePhoneSaidAboutAccess(t *testing.T) {
	// The field that decides whether the request is wrong or the grant is
	// missing (#216) — and its three readings, since every answer so far has
	// been read without it.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	for name, c := range map[string]struct {
		status *waE2E.HistorySyncMessageAccessStatus
		want   string
	}{
		"granted":                {status: &waE2E.HistorySyncMessageAccessStatus{CompleteAccessGranted: proto.Bool(true)}, want: "granted"},
		"denied":                 {status: &waE2E.HistorySyncMessageAccessStatus{CompleteAccessGranted: proto.Bool(false)}, want: "denied"},
		"unstated":               {status: nil, want: "unstated"},
		"unstated with a status": {status: &waE2E.HistorySyncMessageAccessStatus{}, want: "unstated"},
	} {
		t.Run(name, func(t *testing.T) {
			sync := historySyncAnswering(requestID, conversationOf(customerChat(), at))
			sync.Notification.MessageAccessStatus = c.status
			watcher := historyspike.NewWatcher(customerChat())
			watcher.Asked(requestID)

			watcher.HandleEvent(sync)
			got := watcher.Await(bound)

			if got.Access != c.want {
				t.Errorf("access = %q, want %q", got.Access, c.want)
			}
			if !strings.Contains(got.Line(), "access="+c.want) {
				t.Errorf("the answered line does not carry access=%s: %s", c.want, got.Line())
			}
		})
	}
}

func TestTheAnswerReportsChunksThatDisagreeAboutAccess(t *testing.T) {
	// A grant that arrived second must not be discarded, and a denial that
	// arrived second must not be hidden: the disagreement is the finding
	// (Codex r1), and it reads the same whichever order the chunks came in.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	for name, order := range map[string][]bool{
		"denied then granted": {false, true},
		"granted then denied": {true, false},
	} {
		t.Run(name, func(t *testing.T) {
			watcher := historyspike.NewWatcher(customerChat())
			watcher.Asked(requestID)
			for _, granted := range order {
				sync := historySyncAnswering(requestID, conversationOf(customerChat(), at))
				sync.Notification.MessageAccessStatus = &waE2E.HistorySyncMessageAccessStatus{
					CompleteAccessGranted: proto.Bool(granted),
				}
				watcher.HandleEvent(sync)
			}

			if got := watcher.Await(bound); got.Access != "mixed" {
				t.Errorf("access = %q, want mixed", got.Access)
			}
		})
	}
}

func TestASilentChunkDoesNotEraseWhatAnotherStated(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	granted := historySyncAnswering(requestID, conversationOf(customerChat(), at))
	granted.Notification.MessageAccessStatus = &waE2E.HistorySyncMessageAccessStatus{
		CompleteAccessGranted: proto.Bool(true),
	}
	watcher.HandleEvent(granted)
	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at)))

	if got := watcher.Await(bound); got.Access != "granted" {
		t.Errorf("access = %q, want granted — a chunk that said nothing says nothing", got.Access)
	}
}

func TestTheWaitCountsOnlyTheChatAskedFor(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND,
		conversationOf(foreignChat, at, at.Add(time.Minute), at.Add(2*time.Minute)),
		conversationOf(customerChat(), at)))
	got := watcher.Await(bound)

	if got.Messages != 1 {
		t.Errorf("messages = %d, want 1 — only the chat asked for is counted", got.Messages)
	}
	if got.Conversations != 2 {
		t.Errorf("conversations = %d, want 2 — the blob's own size", got.Conversations)
	}
}

func TestTheWaitReadsTheChatThroughItsPhoneNumberAlternative(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	lidChat := types.NewJID("111222333444555", types.HiddenUserServer)
	conv := conversationOf(lidChat, at, at.Add(time.Minute))
	conv.PnJID = proto.String(customerChat().String())
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))
	got := watcher.Await(bound)

	if got.Messages != 2 {
		t.Errorf("messages = %d, want 2 — a LID-addressed thread states its phone number as pnJID", got.Messages)
	}
}

func TestTheOldestInstantIgnoresAMessageThatStatesNone(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	conv := conversationOf(customerChat(), at)
	conv.Messages = append(conv.Messages, &waHistorySync.HistorySyncMsg{
		Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{ID: proto.String("3EB0NOINSTANT")}},
	})
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))
	got := watcher.Await(bound)

	if got.Messages != 2 {
		t.Errorf("messages = %d, want 2 — a message that states no instant still came back", got.Messages)
	}
	if !got.Oldest.Equal(at) {
		t.Errorf("oldest = %s, want %s — an absent instant is not the epoch", got.Oldest, at)
	}
}

func TestHistoryThatNamesThisRequestIsTheAnswer(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at, at.Add(time.Minute))))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Answered {
		t.Fatalf("ending = %s, want answered", got.Ending)
	}
	if got.Messages != 2 {
		t.Errorf("messages = %d, want 2", got.Messages)
	}
}

func TestHistoryThatNamesAnotherRequestIsNotThisRunsAnswer(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	// A notification queued for a run that timed out downloads asynchronously
	// and can be dispatched after this run asked; the phone says whose it is.
	watcher.HandleEvent(historySyncAnswering("3EB0SOMEOTHERREQUEST", conversationOf(customerChat(), at)))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — that history answered somebody else's request", got.Ending)
	}
}

func TestHistoryOnTheWireNamingThisRequestIsReconciled(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at)))
	watcher.Asked(requestID)
	got := watcher.Await(bound)

	if got.Ending != historyspike.Answered {
		t.Errorf("ending = %s, want answered — the history named this request", got.Ending)
	}
}

func TestTheWaitIgnoresAHistorySyncThatIsNotTheAnswer(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_RECENT, conversationOf(customerChat(), at)))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — only an ON_DEMAND sync answers the request", got.Ending)
	}
}

func TestTheWaitEndsOnTheProtocolsRefusalCode(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Refused {
		t.Fatalf("ending = %s, want refused", got.Ending)
	}
	if got.Code != "DECLINED_SHARING_HISTORY" {
		t.Errorf("code = %q, want DECLINED_SHARING_HISTORY", got.Code)
	}
}

func TestTheWaitTakesARefusalThatNamesNoRequest(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(true, 0, "",
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_TIME_EXPIRED))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Refused {
		t.Errorf("ending = %s, want refused — a response that names no request cannot be attributed to another one", got.Ending)
	}
}

func TestTheWaitIgnoresARefusalToSomebodyElsesRequest(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(true, 0, "3EB0SOMEOTHERREQUEST",
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — a refusal to another request is not this one's finding", got.Ending)
	}
}

func TestTheWaitIgnoresHistoryThatArrivedBeforeTheRequestWentOut(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())

	// A run that timed out leaves its answer queued on the phone, which
	// hands it over on connect — before this run has asked anything.
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at)))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — nothing had been asked yet", got.Ending)
	}
}

func TestARefusalThatArrivesWhileTheRequestIsOnTheWireIsThisRunsFinding(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())

	// The send waits for the server's acknowledgement, so the phone can
	// refuse before the rail's id for the request is known here.
	watcher.Asking()
	watcher.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	watcher.Asked(requestID)
	got := watcher.Await(bound)

	if got.Ending != historyspike.Refused {
		t.Fatalf("ending = %s, want refused — the refusal named this request", got.Ending)
	}
	if got.Code != "DECLINED_SHARING_HISTORY" {
		t.Errorf("code = %q, want DECLINED_SHARING_HISTORY", got.Code)
	}
}

func TestARefusalOnTheWireNamingAnotherRequestIsDropped(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(peerResponse(true, 0, "3EB0SOMEOTHERREQUEST",
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	watcher.Asked(requestID)
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — that refusal answered somebody else's request", got.Ending)
	}
}

func TestTheWaitIgnoresARefusalThatArrivedBeforeAnythingWasAsked(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())

	// The phone queues what it could not deliver and hands it over on
	// connect: a leftover response from a previous run must not be read as
	// this run's finding.
	watcher.HandleEvent(peerResponse(true, 0, "3EB0LEFTOVER",
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — nothing had been asked yet", got.Ending)
	}
}

func TestTheWaitIgnoresARefusalThatDidNotComeFromTheAccountsOwnPhone(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(false, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — a peer response is the account's own primary device or nothing", got.Ending)
	}
}

func TestTheWaitIgnoresASuccessCodeAndKeepsWaitingForTheHistory(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_SUCCESS))
	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Errorf("ending = %s, want timed_out — success is not a refusal, the history follows as its own event", got.Ending)
	}
}

func TestAnAnswerInSeveralChunksIsOneFinding(t *testing.T) {
	oldest := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND,
		conversationOf(customerChat(), oldest.Add(2*time.Hour), oldest.Add(3*time.Hour))))
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND,
		conversationOf(customerChat(), oldest, oldest.Add(time.Hour))))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Answered {
		t.Fatalf("ending = %s, want answered", got.Ending)
	}
	if got.Chunks != 2 {
		t.Errorf("chunks = %d, want 2", got.Chunks)
	}
	if got.Messages != 4 {
		t.Errorf("messages = %d, want 4 — every chunk of the answer counts", got.Messages)
	}
	if !got.Oldest.Equal(oldest) {
		t.Errorf("oldest = %s, want %s — the oldest across the whole answer", got.Oldest, oldest)
	}
}

func TestTheWaitEndsOnItsBoundWithANamedReason(t *testing.T) {
	watcher := historyspike.NewWatcher(customerChat())

	got := watcher.Await(bound)

	if got.Ending != historyspike.TimedOut {
		t.Fatalf("ending = %s, want timed_out", got.Ending)
	}
	if got.Waited != bound {
		t.Errorf("waited = %s, want %s", got.Waited, bound)
	}
}

func TestAnAnswerStandsOverARefusalThatFollowsIt(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at)))
	watcher.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Answered {
		t.Errorf("ending = %s, want answered — history that arrived is the finding, whatever follows it", got.Ending)
	}
}

func TestTheLinePinsTheShapeOfEveryEnding(t *testing.T) {
	chat := customerChat()
	oldest := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name    string
		finding historyspike.Finding
		want    string
	}{
		{
			name: "answered",
			finding: historyspike.Finding{
				Chat: chat, Ending: historyspike.Answered, SyncType: "ON_DEMAND",
				Chunks: 1, Conversations: 1, Matched: 1, Messages: 50, Oldest: oldest,
				EndOfTransfer: "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY",
				LastMessage:   oldest.Add(2 * time.Hour),
				Unread:        3,
				// The shape the rig actually answers with: keyed by the LID,
				// stating the number beside it (#216).
				ConvKey:  "lid",
				PNStated: true,
			},
			want: "history spike: answered chat=5215551234567@s.whatsapp.net sync_type=ON_DEMAND chunks=1 conversations=1 matched=1 messages=50 oldest=2026-06-01T10:00:00Z end_of_transfer=COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY last_msg=2026-06-01T12:00:00Z unread=3 access=unstated conv_key=lid conv_pn_stated=yes conv_lid_stated=no",
		},
		{
			name: "answered with a conversation that is not this chat",
			finding: historyspike.Finding{
				Chat: chat, Ending: historyspike.Answered, SyncType: "ON_DEMAND", Chunks: 1, Conversations: 1,
			},
			want: "history spike: answered chat=5215551234567@s.whatsapp.net sync_type=ON_DEMAND chunks=1 conversations=1 matched=0 messages=0 oldest=none end_of_transfer=none last_msg=none unread=0 access=unstated conv_key=unmatched conv_pn_stated=no conv_lid_stated=no",
		},
		{
			name:    "refused",
			finding: historyspike.Finding{Chat: chat, Ending: historyspike.Refused, Code: "REQUEST_TIME_EXPIRED"},
			want:    "history spike: refused chat=5215551234567@s.whatsapp.net code=REQUEST_TIME_EXPIRED",
		},
		{
			name:    "timed out",
			finding: historyspike.Finding{Chat: chat, Ending: historyspike.TimedOut, Waited: 90 * time.Second},
			want:    "history spike: timed_out chat=5215551234567@s.whatsapp.net waited=1m30s",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := c.finding.Line(); got != c.want {
				t.Errorf("line =\n  %q\nwant\n  %q", got, c.want)
			}
		})
	}
}

func TestTheOutputCarriesNoTextNoPushNameNoChatNameAndNoOtherChat(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND,
		conversationOf(customerChat(), at),
		conversationOf(foreignChat, at)))
	line := watcher.Await(bound).Line()

	for _, forbidden := range []string{aText, aPushName, aChatName, foreignChat.String(), foreignChat.User} {
		if strings.Contains(line, forbidden) {
			t.Errorf("the output carries %q: %s", forbidden, line)
		}
	}
	if !strings.Contains(line, customerChat().String()) {
		t.Errorf("the output does not name the chat asked for: %s", line)
	}
}

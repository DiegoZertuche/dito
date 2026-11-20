package historyspike_test

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// The lines the verbose flag adds — one per event the watcher inspected,
// saying what it did with it (Trace argues why run 2 needs them), pinned
// exactly, and content-free for the same reason the finding is (ADR-0025).

// tracing builds a watcher that records its trace lines instead of logging
// them, which is how the shape below is pinned.
func tracing(t *testing.T, chat types.JID) (*historyspike.Watcher, *[]string) {
	t.Helper()
	var lines []string
	watcher := historyspike.NewTracingWatcher(chat, chat, func(line string) { lines = append(lines, line) })
	return watcher, &lines
}

func onlyLine(t *testing.T, lines []string) string {
	t.Helper()
	if len(lines) != 1 {
		t.Fatalf("want exactly one trace line, got %d: %v", len(lines), lines)
	}
	return lines[0]
}

func TestTheTraceNamesEveryHistorySyncWhateverItsType(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	// The phone pushes RECENT on its own schedule; run 1 could not say
	// whether one had arrived at all.
	sync := historySync(waHistorySync.HistorySync_RECENT,
		conversationOf(customerChat(), at), conversationOf(foreignChat, at))
	sync.Data.ChunkOrder = proto.Uint32(2)
	watcher.HandleEvent(sync)

	want := "history spike: saw history sync_type=RECENT chunk_order=2 conversations=2 answers=none verdict=ignored:not_on_demand"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesTheAnswerItCounted(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at)))

	want := "history spike: saw history sync_type=ON_DEMAND chunk_order=0 conversations=1 answers=matched verdict=counted"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesHistoryThatAnsweredAnotherRequest(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySyncAnswering("3EB0SOMEOTHERREQUEST", conversationOf(customerChat(), at)))

	// The whole point of the flag: run 1's `timed_out` and this line are
	// different findings about the phone.
	want := "history spike: saw history sync_type=ON_DEMAND chunk_order=0 conversations=1 answers=differs verdict=ignored:another_request"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesHistoryThatArrivedBeforeTheRequestWentOut(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher, lines := tracing(t, customerChat())

	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at)))

	want := "history spike: saw history sync_type=ON_DEMAND chunk_order=0 conversations=1 answers=unknown verdict=ignored:before_request"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesHistoryHeldWhileTheRequestIsStillOnTheWire(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher, lines := tracing(t, customerChat())

	watcher.Asking()
	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at)))

	want := "history spike: saw history sync_type=ON_DEMAND chunk_order=0 conversations=1 answers=unknown verdict=held"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesTheRefusalAndItsCode(t *testing.T) {
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))

	want := "history spike: saw peer response type=HISTORY_SYNC_ON_DEMAND code=DECLINED_SHARING_HISTORY answers=matched verdict=refused"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesAPeerResponseThatWasNotTheAccountsOwnPhone(t *testing.T) {
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(false, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_DECLINED_SHARING_HISTORY))

	want := "history spike: saw peer response type=HISTORY_SYNC_ON_DEMAND code=DECLINED_SHARING_HISTORY answers=matched verdict=ignored:not_own_phone"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesASuccessCodeItDidNotTakeAsARefusal(t *testing.T) {
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_SUCCESS))

	want := "history spike: saw peer response type=HISTORY_SYNC_ON_DEMAND code=REQUEST_SUCCESS answers=matched verdict=ignored:not_a_refusal"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceTellsAnAcknowledgementFromAResponseThatStatesNoCode(t *testing.T) {
	// The two readings run 2 has to separate: a phone that took the request
	// and then sent no history, and a response that says nothing about it.
	unstated := peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_SUCCESS)
	result := unstated.Message.GetProtocolMessage().
		GetPeerDataOperationRequestResponseMessage().GetPeerDataOperationResult()[0]
	result.GetFullHistorySyncOnDemandRequestResponse().ResponseCode = nil

	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)
	watcher.HandleEvent(unstated)

	want := "history spike: saw peer response type=HISTORY_SYNC_ON_DEMAND code=unstated answers=matched verdict=ignored:not_a_refusal"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesAPeerResponseOfAnotherKind(t *testing.T) {
	other := peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_SUCCESS)
	response := other.Message.GetProtocolMessage().GetPeerDataOperationRequestResponseMessage()
	response.PeerDataOperationRequestType = waE2E.PeerDataOperationRequestType_PLACEHOLDER_MESSAGE_RESEND.Enum()
	response.PeerDataOperationResult = nil

	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)
	watcher.HandleEvent(other)

	want := "history spike: saw peer response type=PLACEHOLDER_MESSAGE_RESEND code=none answers=matched verdict=ignored:not_on_demand"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheTraceNamesARefusalToAFullHistoryRequest(t *testing.T) {
	// The gate accepts both on-demand request types, and the phone chooses
	// which one it answers under.
	full := peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_TIME_EXPIRED)
	full.Message.GetProtocolMessage().GetPeerDataOperationRequestResponseMessage().
		PeerDataOperationRequestType = waE2E.PeerDataOperationRequestType_FULL_HISTORY_SYNC_ON_DEMAND.Enum()

	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)
	watcher.HandleEvent(full)

	want := "history spike: saw peer response type=FULL_HISTORY_SYNC_ON_DEMAND code=REQUEST_TIME_EXPIRED answers=matched verdict=refused"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
	if got := watcher.Await(bound); got.Ending != historyspike.Refused {
		t.Errorf("ending = %s, want refused", got.Ending)
	}
}

func TestTheTraceSaysNothingAboutAnOrdinaryMessage(t *testing.T) {
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	// A delivery is not a response to anything this command asked, and a line
	// per message would be a line per delivery on a live rail.
	watcher.HandleEvent(&events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: foreignChat, Sender: foreignChat},
			ID:            "3EB0ANORDINARYMESSAGE",
			PushName:      aPushName,
		},
		Message: &waE2E.Message{Conversation: proto.String(aText)},
	})

	if len(*lines) != 0 {
		t.Errorf("an ordinary message was traced: %v", *lines)
	}
}

func TestTheTraceCarriesNoContentNoIdentityAndNeitherRequestID(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher, lines := tracing(t, customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySyncAnswering("3EB0SOMEOTHERREQUEST",
		conversationOf(customerChat(), at), conversationOf(foreignChat, at)))
	watcher.HandleEvent(peerResponse(true, 0, "3EB0SOMEOTHERREQUEST",
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_TIME_EXPIRED))

	traced := strings.Join(*lines, "\n")
	// The ids are compared and never printed: an id is what the phone calls
	// one message, and the operator needs the comparison, not the value.
	for _, forbidden := range []string{
		aText, aPushName, aChatName,
		foreignChat.String(), foreignChat.User,
		customerChat().String(), customerChat().User,
		string(requestID), "3EB0SOMEOTHERREQUEST",
	} {
		if strings.Contains(traced, forbidden) {
			t.Errorf("the trace carries %q:\n%s", forbidden, traced)
		}
	}
}

func TestAWatcherWithNoTraceStillReportsItsFinding(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := historyspike.NewWatcher(customerChat())
	watcher.Asked(requestID)

	watcher.HandleEvent(historySyncAnswering(requestID, conversationOf(customerChat(), at)))
	got := watcher.Await(bound)

	if got.Ending != historyspike.Answered || got.Messages != 1 {
		t.Errorf("finding = %s with %d message(s), want answered with 1 — the silent mode is unchanged", got.Ending, got.Messages)
	}
}

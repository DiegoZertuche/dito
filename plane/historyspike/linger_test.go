package historyspike_test

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// Every LID run so far lasted about twelve seconds: answered in three,
// settled ten later, gone. An answer whose data chunk arrives half a minute
// after its metadata chunk would have been thrown away (#216). These are the
// lines the linger adds while the socket stays open.

func lingering(t *testing.T) (*historyspike.Linger, *[]string) {
	t.Helper()
	var lines []string
	// The PN chat and, for these, the same identity as the addressed one:
	// the LID shapes have their own tests (conversation_test.go).
	return historyspike.NewLinger(customerChat(), customerChat(), func(line string) { lines = append(lines, line) }), &lines
}

func TestTheLingerReportsEveryHistoryEventWhateverItsType(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	linger, lines := lingering(t)

	recent := historySync(waHistorySync.HistorySync_RECENT, conversationOf(customerChat(), at, at.Add(time.Hour)))
	recent.Data.ChunkOrder = proto.Uint32(2)
	recent.Data.Progress = proto.Uint32(40)
	recent.Notification = &waE2E.HistorySyncNotification{
		OldestMsgInChunkTimestampSec: proto.Int64(at.Unix()),
		MessageAccessStatus:          &waE2E.HistorySyncMessageAccessStatus{CompleteAccessGranted: proto.Bool(false)},
	}
	linger.HandleEvent(recent)

	want := "history spike: saw history sync_type=RECENT chunk_order=2 progress=40 conversations=1 matched=1 messages=2 oldest_in_chunk=2026-06-01T10:00:00Z access=denied conv_key=pn conv_pn_stated=no conv_lid_stated=no"
	if got := onlyLine(t, *lines); got != want {
		t.Errorf("line =\n  %q\nwant\n  %q", got, want)
	}
}

func TestTheLingerCountsWhatItSawAndSaysSoAtTheEnd(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	linger, _ := lingering(t)

	linger.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at)))
	linger.HandleEvent(historySync(waHistorySync.HistorySync_RECENT, conversationOf(foreignChat, at)))

	if got, want := linger.Done(time.Minute), "history spike: linger_done saw=2 open=1m0s interrupted=none"; got != want {
		t.Errorf("done = %q, want %q", got, want)
	}
}

func TestTheLingerSaysZeroWhenNothingMoreArrives(t *testing.T) {
	// The finding the earlier runs could not state: the phone sent nothing
	// further, rather than the mode having left too early.
	linger, lines := lingering(t)

	if got, want := linger.Done(3*time.Minute), "history spike: linger_done saw=0 open=3m0s interrupted=none"; got != want {
		t.Errorf("done = %q, want %q", got, want)
	}
	if len(*lines) != 0 {
		t.Errorf("lines = %v, want none", *lines)
	}
}

func TestTheLingerIgnoresEverythingThatIsNotHistory(t *testing.T) {
	linger, lines := lingering(t)

	linger.HandleEvent(peerResponse(true, 0, requestID,
		waE2E.PeerDataOperationRequestResponseMessage_PeerDataOperationResult_REQUEST_SUCCESS))
	linger.HandleEvent("not an event at all")

	if len(*lines) != 0 {
		t.Errorf("lines = %v, want none — the linger watches history and nothing else", *lines)
	}
	if got, want := linger.Done(time.Minute), "history spike: linger_done saw=0 open=1m0s interrupted=none"; got != want {
		t.Errorf("done = %q, want %q", got, want)
	}
}

func TestTheLingerSaysWhenTheSocketWentRatherThanCallingItSilence(t *testing.T) {
	// Reconnect is off on this client, so a drop after the answer would
	// otherwise leave the wait sitting out its timer and print a zero count —
	// the very finding this lane exists to produce, from an observation that
	// never happened (Codex r1).
	linger, _ := lingering(t)

	go linger.HandleEvent(&events.Disconnected{})
	open := linger.Wait(2 * time.Minute)

	if open >= 2*time.Minute {
		t.Errorf("the lane stayed open %s, want it to end with the socket", open)
	}
	if got := linger.Done(open); !strings.Contains(got, "interrupted=disconnected") {
		t.Errorf("done = %q, want it to name the interruption", got)
	}
}

func TestTheLingerNeitherCountsNorPrintsAfterItIsClosed(t *testing.T) {
	// whatsmeow dispatches a downloaded blob on its own goroutine, so a chunk
	// can land while the count is being stated; nothing may follow a count
	// that calls itself final.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	linger, lines := lingering(t)

	linger.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at)))
	linger.Close()
	linger.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at)))

	if len(*lines) != 1 {
		t.Errorf("lines = %v, want exactly the one from before the close", *lines)
	}
	if got, want := linger.Done(time.Minute), "history spike: linger_done saw=1 open=1m0s interrupted=none"; got != want {
		t.Errorf("done = %q, want %q", got, want)
	}
}

func TestTheLingerSaysUnstatedWhenTheNotificationSaysNothing(t *testing.T) {
	// Which is what every answer so far has looked like from here, because
	// nothing read the field (#216).
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	linger, lines := lingering(t)

	linger.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at)))

	line := onlyLine(t, *lines)
	if !strings.Contains(line, "access=unstated") || !strings.Contains(line, "oldest_in_chunk=none") {
		t.Errorf("line = %q, want access=unstated and oldest_in_chunk=none", line)
	}
}

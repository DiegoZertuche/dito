package historyspike_test

import (
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// THE FINDING (#216). Every LID-addressed answer carried messages —
// whatsmeow stored 27 message secrets from the same blob for the oldest
// anchor and 36 for the newest, identically on three devices — while the
// finding read messages=0, because the match compared the conversation
// against the PN-canonical chat alone and the phone keys it by LID. These
// are the shapes the rule now has to answer for.

// lidWatcher is the instrument as the LID arms run it: the trace names the
// PN chat, the request addressed the LID.
func lidWatcher(t *testing.T) *historyspike.Watcher {
	t.Helper()
	watcher := historyspike.NewTracingWatcher(customerChat(), counterpartyLID, nil)
	watcher.Asked(requestID)
	return watcher
}

func TestAConversationKeyedByTheLIDIsTheChatAskedAbout(t *testing.T) {
	// The shape the phone actually sends, and the one every arm dropped: the
	// conversation's own key is the LID and it states no pnJid at all.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	conv := conversationOf(counterpartyLID, at, at.Add(time.Hour), at.Add(2*time.Hour))
	conv.PnJID = nil
	watcher := lidWatcher(t)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))
	got := watcher.Await(bound)

	if got.Messages != 3 {
		t.Errorf("messages = %d, want 3 — the answer was never empty", got.Messages)
	}
	if got.Matched != 1 {
		t.Errorf("matched = %d, want 1", got.Matched)
	}
	if got.ConvKey != "lid" {
		t.Errorf("conv_key = %q, want lid", got.ConvKey)
	}
	// Neither ALTERNATIVE was stated: the LID is the conversation's own key,
	// which conv_key reports, and the two stated flags are about the fields
	// beside it.
	if got.PNStated || got.LIDStated {
		t.Errorf("pn stated = %t, lid stated = %t, want no and no", got.PNStated, got.LIDStated)
	}
	if line := got.Line(); !strings.Contains(line, "matched=1") || !strings.Contains(line, "conv_key=lid") {
		t.Errorf("the answered line does not say how the phone filed it: %s", line)
	}
}

func TestAConversationKeyedByTheLIDWithADevicePartStillMatches(t *testing.T) {
	// The phone may state the LID with a device part; both sides are compared
	// bare, so it decides nothing.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	qualified := counterpartyLID
	qualified.Device = 3
	conv := conversationOf(qualified, at)
	conv.PnJID = nil
	watcher := lidWatcher(t)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))

	if got := watcher.Await(bound); got.Messages != 1 || got.ConvKey != "lid" {
		t.Errorf("messages = %d, conv_key = %q; want 1 and lid", got.Messages, got.ConvKey)
	}
}

func TestAConversationKeyedByThePhoneNumberStillMatches(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	watcher := lidWatcher(t)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conversationOf(customerChat(), at, at.Add(time.Hour))))

	got := watcher.Await(bound)
	if got.Messages != 2 || got.Matched != 1 {
		t.Errorf("messages = %d, matched = %d; want 2 and 1", got.Messages, got.Matched)
	}
	if got.ConvKey != "pn" {
		t.Errorf("conv_key = %q, want pn", got.ConvKey)
	}
}

func TestAConversationThatStatesThePhoneNumberBesideALIDKeyMatches(t *testing.T) {
	// The shape the earlier rule was written for, and it still holds: keyed
	// by a LID this run never addressed, but stating the chat's own number.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	other := types.NewJID("777666555444333", types.HiddenUserServer)
	conv := conversationOf(other, at)
	conv.PnJID = proto.String(customerChat().String())
	watcher := lidWatcher(t)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))

	got := watcher.Await(bound)
	if got.Messages != 1 {
		t.Errorf("messages = %d, want 1", got.Messages)
	}
	if !got.PNStated {
		t.Error("pn stated = no, want yes")
	}
}

func TestAConversationThatStatesTheLIDBesideAPhoneNumberKeyMatches(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	stranger := types.NewJID("5215550000", types.DefaultUserServer)
	conv := conversationOf(stranger, at)
	conv.PnJID = nil
	conv.LidJID = proto.String(counterpartyLID.String())
	watcher := lidWatcher(t)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))

	got := watcher.Await(bound)
	if got.Messages != 1 || !got.LIDStated {
		t.Errorf("messages = %d, lid stated = %t; want 1 and yes", got.Messages, got.LIDStated)
	}
}

func TestAnUnrelatedConversationIsStillNotTheChatAskedAbout(t *testing.T) {
	// And the answer says so, rather than reading as an empty one: the whole
	// distinction this change exists for.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	conv := conversationOf(foreignChat, at, at.Add(time.Hour))
	conv.PnJID = nil
	watcher := lidWatcher(t)

	watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))

	got := watcher.Await(bound)
	if got.Messages != 0 || got.Matched != 0 {
		t.Errorf("messages = %d, matched = %d; want 0 and 0", got.Messages, got.Matched)
	}
	if got.Conversations != 1 {
		t.Errorf("conversations = %d, want 1 — the blob's own size is still reported", got.Conversations)
	}
	if line := got.Line(); !strings.Contains(line, "matched=0") || !strings.Contains(line, "conv_key=unmatched") {
		t.Errorf("the answered line does not say the conversation did not match: %s", line)
	}
}

func TestTheLingerReadsTheChatByBothItsNamesToo(t *testing.T) {
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	var lines []string
	linger := historyspike.NewLinger(customerChat(), counterpartyLID, func(line string) { lines = append(lines, line) })
	conv := conversationOf(counterpartyLID, at, at.Add(time.Hour))
	conv.PnJID = nil

	linger.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))

	line := onlyLine(t, lines)
	for _, want := range []string{"matched=1", "messages=2", "conv_key=lid", "conv_pn_stated=no", "conv_lid_stated=no"} {
		if !strings.Contains(line, want) {
			t.Errorf("the linger line lacks %q: %s", want, line)
		}
	}
}

func TestAMalformedIdentityCarryingTheChatsOwnPrefixDoesNotMatch(t *testing.T) {
	// whatsmeow's parser keeps the first two segments and ignores the rest,
	// so a value like «<the chat>@s.whatsapp.net@anything» parses to the chat
	// itself (Codex r1). Counting such a conversation would put another
	// chat's messages on this chat's line — the corruption this whole rule
	// exists to end.
	at := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	malformed := customerChat().String() + "@anything"
	for name, shape := range map[string]func(*waHistorySync.Conversation){
		"as the key": func(conv *waHistorySync.Conversation) {
			conv.ID = proto.String(malformed)
			conv.PnJID = nil
		},
		"as the stated pn": func(conv *waHistorySync.Conversation) {
			conv.ID = proto.String(foreignChat.String())
			conv.PnJID = proto.String(malformed)
		},
		"as the stated lid": func(conv *waHistorySync.Conversation) {
			conv.ID = proto.String(foreignChat.String())
			conv.PnJID = nil
			conv.LidJID = proto.String(counterpartyLID.String() + "@anything")
		},
	} {
		t.Run(name, func(t *testing.T) {
			conv := conversationOf(foreignChat, at, at.Add(time.Hour))
			shape(conv)
			watcher := lidWatcher(t)

			watcher.HandleEvent(historySync(waHistorySync.HistorySync_ON_DEMAND, conv))

			got := watcher.Await(bound)
			if got.Matched != 0 || got.Messages != 0 {
				t.Errorf("matched = %d, messages = %d; want 0 and 0 — a malformed identity is not this chat",
					got.Matched, got.Messages)
			}
		})
	}
}

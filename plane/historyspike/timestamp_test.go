package historyspike_test

import (
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// The second structural suspect behind an answer that is always empty
// (#216): whatsmeow fills the request's `oldestMsgTimestampMS` with SECONDS
// and says so in a comment — "despite the field name saying MS". If this
// phone's build reads the field as milliseconds, our anchor is a moment in
// January 1970 and "the fifty messages before that" is legitimately empty in
// every configuration we have tried.

func TestTheSecondsUnitBuildsExactlyWhatTheLibraryBuilds(t *testing.T) {
	// The default must be the request runs 1 through E sent, to the byte:
	// the option exists to change ONE field, and this is what proves it did
	// not change anything else while the builder moved in-house.
	chat, anchor := customerChat(), inboundAnchor()

	mine := historyspike.BuildRequest(chat, anchor, historyspike.UnitSeconds, false)
	theirs := (&whatsmeow.Client{}).BuildHistorySyncRequest(
		&types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, IsFromMe: anchor.FromMe},
			ID:            anchor.MessageID,
			Timestamp:     anchor.At,
		},
		historyspike.MessagesPerRequest,
	)

	if !proto.Equal(mine, theirs) {
		t.Errorf("the seconds request differs from the library's:\nmine:   %v\ntheirs: %v", mine, theirs)
	}
}

func TestTheMillisUnitChangesTheInstantAndNothingElse(t *testing.T) {
	chat, anchor := customerChat(), inboundAnchor()

	millis := historyspike.BuildRequest(chat, anchor, historyspike.UnitMillis, false)
	seconds := historyspike.BuildRequest(chat, anchor, historyspike.UnitSeconds, false)

	asked := millis.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	if got, want := asked.GetOldestMsgTimestampMS(), anchor.At.UnixMilli(); got != want {
		t.Errorf("instant = %d, want %d milliseconds", got, want)
	}
	// Everything else identical: reset the one field and the two must agree.
	asked.OldestMsgTimestampMS = proto.Int64(anchor.At.Unix())
	if !proto.Equal(millis, seconds) {
		t.Errorf("the millis request differs by more than the instant:\nmillis:  %v\nseconds: %v", millis, seconds)
	}
}

func TestTheTimestampUnitOptionTakesBothWordsAndNothingElse(t *testing.T) {
	for spelling, want := range map[string]historyspike.TimestampUnit{
		"seconds": historyspike.UnitSeconds,
		"millis":  historyspike.UnitMillis,
	} {
		t.Run(spelling, func(t *testing.T) {
			got, err := historyspike.ParseTimestampUnit(spelling)
			if err != nil {
				t.Fatalf("parsing %q: %v", spelling, err)
			}
			if got != want {
				t.Errorf("unit = %q, want %q", got, want)
			}
		})
	}
	for _, spelling := range []string{"", "ms", "s", "SECONDS", "milliseconds"} {
		t.Run("refuses "+spelling, func(t *testing.T) {
			if _, err := historyspike.ParseTimestampUnit(spelling); err == nil {
				t.Errorf("%q was accepted as a timestamp unit", spelling)
			}
		})
	}
}

func TestTheInlineResponseFlagSetsExactlyThatField(t *testing.T) {
	// The one request field the official web client sets and no library does
	// (#216). Off, the request must stay byte-identical to the library's,
	// which the pin above is about; on, it must differ by this field alone.
	chat, anchor := customerChat(), inboundAnchor()

	inline := historyspike.BuildRequest(chat, anchor, historyspike.UnitSeconds, true)
	plain := historyspike.BuildRequest(chat, anchor, historyspike.UnitSeconds, false)

	asked := inline.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	if !asked.GetSupportInlineResponse() {
		t.Error("supportInlineResponse is not set")
	}
	if plain.GetProtocolMessage().GetPeerDataOperationRequestMessage().
		GetHistorySyncOnDemandRequest().SupportInlineResponse != nil {
		t.Error("supportInlineResponse is set with the flag off")
	}
	asked.SupportInlineResponse = nil
	if !proto.Equal(inline, plain) {
		t.Errorf("the inline request differs by more than that field:\ninline: %v\nplain:  %v", inline, plain)
	}
}

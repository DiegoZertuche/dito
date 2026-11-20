package historyspike

import (
	"fmt"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// TimestampUnit is the unit the request states the anchor's instant in, and
// it is a knob because the protocol's own field name disagrees with the
// library's use of it (#216).
//
// whatsmeow fills `oldestMsgTimestampMS` with SECONDS and says so where it
// does ("despite the field name saying MS", send.go). Every arm so far has
// asked that way, and every answer has come back inside three seconds with
// zero messages — on a chat whose history reaches back to March. If this
// phone's build reads the field as MILLISECONDS, the anchor it has been
// given is a moment in January 1970, and "the fifty messages before that"
// is legitimately empty however the rest of the request is addressed. This
// option asks the same question with the other unit.
type TimestampUnit string

const (
	// UnitSeconds is what the library sends, and the default: the arms
	// already run are only comparable against it.
	UnitSeconds TimestampUnit = "seconds"
	// UnitMillis states the instant in milliseconds, as the field's name
	// says.
	UnitMillis TimestampUnit = "millis"
)

// ParseTimestampUnit reads the option's value and takes nothing but the two
// words: a mistyped unit that fell back to a default would quietly re-run
// an arm that has already been measured.
func ParseTimestampUnit(spelling string) (TimestampUnit, error) {
	switch TimestampUnit(spelling) {
	case UnitSeconds:
		return UnitSeconds, nil
	case UnitMillis:
		return UnitMillis, nil
	default:
		return "", fmt.Errorf("%q is not a timestamp unit — it is %q or %q", spelling, UnitSeconds, UnitMillis)
	}
}

// BuildRequest composes the on-demand history request for one chat and
// anchor, in the given unit.
//
// IT IS A COPY OF THE LIBRARY'S BUILDER, DELIBERATELY, and the copy is the
// whole point: whatsmeow's BuildHistorySyncRequest hard-codes the unit, so
// the only way to ask the other way is to fill the same struct here. The
// fields are the library's, in the library's shapes, and a test asserts that
// the seconds request is byte-identical to what the library builds — so the
// copy cannot drift into a different request while nobody is looking.
func BuildRequest(chat types.JID, anchor Anchor, unit TimestampUnit, inlineResponse bool) *waE2E.Message {
	instant := anchor.At.Unix()
	if unit == UnitMillis {
		instant = anchor.At.UnixMilli()
	}
	// `supportInlineResponse` (field 7) is the one request field the official
	// web client sets and no library does — the phone may only answer inline
	// to a companion that says it can take the answer that way (#216). Left
	// unset, the request is what every arm so far sent, which is what keeps
	// the default byte-identical to the library's own builder.
	var inline *bool
	if inlineResponse {
		inline = proto.Bool(true)
	}
	return &waE2E.Message{
		ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_PEER_DATA_OPERATION_REQUEST_MESSAGE.Enum(),
			PeerDataOperationRequestMessage: &waE2E.PeerDataOperationRequestMessage{
				PeerDataOperationRequestType: waE2E.PeerDataOperationRequestType_HISTORY_SYNC_ON_DEMAND.Enum(),
				HistorySyncOnDemandRequest: &waE2E.PeerDataOperationRequestMessage_HistorySyncOnDemandRequest{
					ChatJID:               proto.String(chat.String()),
					OldestMsgID:           proto.String(anchor.MessageID),
					OldestMsgFromMe:       proto.Bool(anchor.FromMe),
					OnDemandMsgCount:      proto.Int32(int32(MessagesPerRequest)),
					OldestMsgTimestampMS:  proto.Int64(instant),
					SupportInlineResponse: inline,
				},
			},
		},
	}
}

package historyspike

import (
	"context"
	"errors"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// MessagesPerRequest is how many older messages one request asks for:
// fifty, which is the page size whatsmeow recommends where it builds the
// request (send.go's BuildHistorySyncRequest). The rig confirmed the phone
// serves exactly that many, in one chunk, about three seconds after the ask
// (#216, 2026-09-07) — so it is also the page size the ninety-day fill pages
// a chat's history in, and the number of iOS sync notifications a rep gets
// per fifty messages of their own past.
const MessagesPerRequest = 50

// PeerRail is the two library calls the request makes: whatsmeow builds the
// on-demand history request proto and sends it to the account's own primary
// device as a peer message. *whatsmeow.Client is the sole production
// implementation; a test records what the caller hands the builder and
// returns what the builder made of it.
//
// THIS IS THE ONE PLANE FILE OUTSIDE THE EXECUTOR THAT MAY TOUCH A SEND API
// (ADR-0006). The invariant scan names it by path and argues why a peer
// request leaves that wall standing (invariant_sole_sender_test.go's
// peerRequestException). The ninety-day fill (`plane/fill`, ticket #222)
// reaches the rail THROUGH `Request` below rather than through a send API of
// its own, so it adds a caller and not a path, and the scan stays exactly as
// narrow as it was.
type PeerRail interface {
	SendPeerMessage(ctx context.Context, message *waE2E.Message) (whatsmeow.SendResponse, error)
}

// Ask is one on-demand history request as this run will send it. Chat is
// the chat the operator asked about — the seam's own PN-canonical identity,
// which is what the finding and every trace line name — while Addressed is
// the identity the REQUEST names it by (AddressChat resolves it, and they
// are the same thing unless run 4's LID hypothesis is being tested).
//
// AccountLID is the account's own hidden-user identity, and the zero JID
// leaves the field unset, which is how runs 1 through 3 sent it. The
// protocol carries it (`accountLid`, field 6 of the on-demand request) and
// whatsmeow fills it NOWHERE, so a LID-migrated primary that resolves a peer
// request by the requesting account's LID would have nothing to resolve —
// which is one of the readings run 3's silence leaves open (#216). It is the
// BARE account identity: AccountLID makes one, and this shape drops a device
// number a caller left on anyway, because the wire value decides whether
// run 5 measures anything at all.
type Ask struct {
	Chat       types.JID
	Addressed  types.JID
	Anchor     Anchor
	AccountLID types.JID
	// Unit is what the request states the anchor's instant in; the zero value
	// is UnitSeconds, which is what the library sends and what every arm so
	// far asked with (TimestampUnit argues why it is a knob at all).
	Unit TimestampUnit
	// InlineResponse states that this companion can take the answer inline;
	// the zero value leaves the field unset, as every arm so far did
	// (BuildRequest says what the field is).
	InlineResponse bool
}

// Request asks the phone for the fifty messages immediately before the
// anchor, in the chat the request addresses, and returns the id the rail
// minted for it — which is the id the phone's answer or refusal names
// (Watcher.Asked). The proto is the LIBRARY's, from the library's own
// builder's own shape, field for field, with a test that pins the default
// unit's request byte-identical to what the library builds (BuildRequest
// says why the copy exists). The field the library leaves out is set on the
// proto afterwards, so nothing about the shape is invented here.
//
// THE RAIL'S OWN REASON IS NOT CARRIED (Codex r1/r3), and that is the output
// contract rather than tidiness. whatsmeow reports a send failure by
// DESTINATION — «failed to encrypt peer message for %s» — and a peer
// message's destination is the account's own JID, so wrapping the error
// would put an identity on the operator's terminal that this command must
// not name (#216 AC 2), whatever logger the client was given. What an
// operator needs from a rig command is which step failed, and that is what
// it says; the library's reason is one ordinary plane run away.
func Request(ctx context.Context, rail PeerRail, ask Ask) (types.MessageID, error) {
	message := BuildRequest(ask.Addressed, ask.Anchor, ask.Unit, ask.InlineResponse)
	if !ask.AccountLID.IsEmpty() {
		message.GetProtocolMessage().GetPeerDataOperationRequestMessage().
			GetHistorySyncOnDemandRequest().AccountLid = proto.String(ask.AccountLID.ToNonAD().String())
	}
	sent, err := rail.SendPeerMessage(ctx, message)
	if err != nil {
		return "", errors.New("the rail refused the on-demand history request (its own reason is withheld: it names the account's own JID)")
	}
	return sent.ID, nil
}

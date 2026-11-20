package historyspike_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// The rail is the system boundary here — the one thing a unit test may stub
// — and the spy records the proto that reached it, which is the proto the
// phone would have received. That the DEFAULT request is byte-identical to
// what whatsmeow's own builder makes is pinned separately
// (timestamp_test.go), so these tests read the real thing.
type recordingRail struct {
	sent    *waE2E.Message
	sendErr error
}

func (r *recordingRail) SendPeerMessage(_ context.Context, message *waE2E.Message) (whatsmeow.SendResponse, error) {
	r.sent = message
	return whatsmeow.SendResponse{ID: mintedID}, r.sendErr
}

// mintedID is the id the rail gives the request it sent — what the phone's
// refusal has to name.
const mintedID types.MessageID = "3EB0MINTEDBYTHERAIL"

func customerChat() types.JID {
	return types.NewJID("5215551234567", types.DefaultUserServer)
}

// pnAsk is the request run 1 through 3 sent: the chat as the seam holds it,
// addressed by phone number, with the account's own LID left unstated.
func pnAsk(anchor historyspike.Anchor) historyspike.Ask {
	return historyspike.Ask{Chat: customerChat(), Addressed: customerChat(), Anchor: anchor}
}

func inboundAnchor() historyspike.Anchor {
	return historyspike.Anchor{
		MessageID: "3EB0A1B2C3D4E5F60718",
		FromMe:    false,
		At:        time.Date(2026, 9, 4, 17, 23, 51, 0, time.UTC),
	}
}

func TestRequestFillsChatOldestIDDirectionInstantAndCountFromTheAnchor(t *testing.T) {
	rail := &recordingRail{}
	anchor := inboundAnchor()

	if _, err := historyspike.Request(context.Background(), rail, pnAsk(anchor)); err != nil {
		t.Fatalf("sending the request: %v", err)
	}

	peer := rail.sent.GetProtocolMessage().GetPeerDataOperationRequestMessage()
	if peer.GetPeerDataOperationRequestType() != waE2E.PeerDataOperationRequestType_HISTORY_SYNC_ON_DEMAND {
		t.Errorf("request type = %s, want HISTORY_SYNC_ON_DEMAND", peer.GetPeerDataOperationRequestType())
	}
	req := peer.GetHistorySyncOnDemandRequest()
	if got := req.GetChatJID(); got != customerChat().String() {
		t.Errorf("chat = %q, want %q", got, customerChat().String())
	}
	if got := req.GetOldestMsgID(); got != anchor.MessageID {
		t.Errorf("oldest message id = %q, want %q", got, anchor.MessageID)
	}
	if req.GetOldestMsgFromMe() {
		t.Error("oldest message direction = from me, want from the counterparty")
	}
	// Seconds, despite the field's name — whatsmeow says so where it fills it.
	if got, want := req.GetOldestMsgTimestampMS(), anchor.At.Unix(); got != want {
		t.Errorf("oldest message instant = %d, want %d", got, want)
	}
	if got := req.GetOnDemandMsgCount(); got != 50 {
		t.Errorf("count = %d, want 50", got)
	}
}

func TestRequestSendsTheRequestAndReportsItsID(t *testing.T) {
	rail := &recordingRail{}

	request, err := historyspike.Request(context.Background(), rail, pnAsk(inboundAnchor()))
	if err != nil {
		t.Fatalf("sending the request: %v", err)
	}

	if rail.sent == nil {
		t.Fatal("nothing was sent")
	}
	if request != mintedID {
		t.Errorf("request id = %q, want the rail's own %q", request, mintedID)
	}
}

func TestRequestCarriesAnOutboundAnchorsDirection(t *testing.T) {
	rail := &recordingRail{}
	anchor := inboundAnchor()
	anchor.FromMe = true

	if _, err := historyspike.Request(context.Background(), rail, pnAsk(anchor)); err != nil {
		t.Fatalf("sending the request: %v", err)
	}

	req := rail.sent.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	if !req.GetOldestMsgFromMe() {
		t.Error("oldest message direction = from the counterparty, want from me")
	}
}

func TestRequestReportsARailThatRefusedTheSendWithoutNamingTheAccount(t *testing.T) {
	// whatsmeow reports a peer-send failure by destination, and a peer
	// message's destination is the account's own JID.
	rail := &recordingRail{sendErr: errors.New("failed to encrypt peer message for 5215559999@s.whatsapp.net: no signal session")}

	_, err := historyspike.Request(context.Background(), rail, pnAsk(inboundAnchor()))
	if err == nil {
		t.Fatal("a rail that refused the send reported no error")
	}
	for _, forbidden := range []string{"5215559999@s.whatsapp.net", "5215559999", "no signal session"} {
		if strings.Contains(err.Error(), forbidden) {
			t.Errorf("the error carries %q: %v", forbidden, err)
		}
	}
	if !strings.Contains(err.Error(), "on-demand history request") {
		t.Errorf("the error does not say which step failed: %v", err)
	}
}

func TestRequestNamesTheChatByTheIdentityItWasAddressedTo(t *testing.T) {
	rail := &recordingRail{}
	// The anchor still comes from the seam's PN-keyed row; only the key the
	// phone is asked to look up changes (run 4's hypothesis, #216).
	ask := pnAsk(inboundAnchor())
	ask.Addressed = counterpartyLID

	if _, err := historyspike.Request(context.Background(), rail, ask); err != nil {
		t.Fatalf("sending the request: %v", err)
	}

	req := rail.sent.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	if got := req.GetChatJID(); got != counterpartyLID.String() {
		t.Errorf("chat = %q, want the addressed identity %q", got, counterpartyLID.String())
	}
	if got := req.GetOldestMsgID(); got != inboundAnchor().MessageID {
		t.Errorf("oldest message id = %q, want the seam's own %q — only the chat's key moves", got, inboundAnchor().MessageID)
	}
}

func TestRequestStatesTheAccountsOwnLIDOnlyWhenAskedTo(t *testing.T) {
	accountLID := types.NewJID("999888777666555", types.HiddenUserServer)
	rail := &recordingRail{}
	ask := pnAsk(inboundAnchor())
	// Device-qualified on the way in, because that is what the session store
	// holds (pair.go:213) and the wire value decides whether run 5 measures
	// anything (Codex r1).
	ask.AccountLID = accountLID
	ask.AccountLID.Device = 14

	if _, err := historyspike.Request(context.Background(), rail, ask); err != nil {
		t.Fatalf("sending the request: %v", err)
	}

	req := rail.sent.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	if got := req.GetAccountLid(); got != accountLID.String() {
		t.Errorf("accountLid = %q, want %q", got, accountLID.String())
	}
}

func TestRequestLeavesTheAccountsOwnLIDUnstatedByDefault(t *testing.T) {
	rail := &recordingRail{}

	if _, err := historyspike.Request(context.Background(), rail, pnAsk(inboundAnchor())); err != nil {
		t.Fatalf("sending the request: %v", err)
	}

	req := rail.sent.GetProtocolMessage().GetPeerDataOperationRequestMessage().GetHistorySyncOnDemandRequest()
	if req.AccountLid != nil {
		// The library leaves field 6 unset, and runs 1 through 3 sent it that
		// way: the option exists to change ONE thing at a time.
		t.Errorf("accountLid = %q, want the field unset", req.GetAccountLid())
	}
}

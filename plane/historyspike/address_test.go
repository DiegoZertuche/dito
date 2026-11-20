package historyspike_test

import (
	"context"
	"errors"
	"testing"

	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// Run 3 asked the phone for one chat's history from a re-paired device that
// advertised on-demand readiness, and the phone did nothing at all: no
// history, no refusal, no response of any kind (#216). One candidate is the
// key: the request names the chat, and the phone looks it up in its own
// store, which the LID migration may key by the counterparty's hidden-user
// identity rather than their phone number. These are the two things run 4
// needs — the choice of identity, and the map the plane already holds.

// counterpartyLID is the identity the phone's own history sync taught the
// plane's store (whatsmeow's storeHistoricalPNLIDMappings).
var counterpartyLID = types.NewJID("111222333444555", types.HiddenUserServer)

// knownLIDs is the plane's own PN↔LID map — whatsmeow's device store in the
// binary, a fixture here.
type knownLIDs struct {
	mapped map[types.JID]types.JID
	err    error
}

func (k knownLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	if k.err != nil {
		return types.JID{}, k.err
	}
	return k.mapped[pn], nil
}

func TestTheAddressingOptionTakesPnAndLid(t *testing.T) {
	for spelling, want := range map[string]historyspike.Addressing{
		"pn":  historyspike.AddressPN,
		"lid": historyspike.AddressLID,
	} {
		t.Run(spelling, func(t *testing.T) {
			got, err := historyspike.ParseAddressing(spelling)
			if err != nil {
				t.Fatalf("parsing %q: %v", spelling, err)
			}
			if got != want {
				t.Errorf("addressing = %q, want %q", got, want)
			}
		})
	}
}

func TestTheAddressingOptionRefusesAnythingElse(t *testing.T) {
	for _, spelling := range []string{"", "PN", "phone", "jid", "lid "} {
		t.Run(spelling, func(t *testing.T) {
			if _, err := historyspike.ParseAddressing(spelling); err == nil {
				t.Errorf("%q was accepted as an addressing", spelling)
			}
		})
	}
}

func TestAddressingByPhoneNumberNamesTheChatTheSeamHolds(t *testing.T) {
	// The default, and run 1 through 3's behaviour: the chat as the seam
	// canonicalized it. The map is not consulted at all.
	lids := knownLIDs{err: errors.New("the map must not be read for pn addressing")}

	addressed, err := historyspike.AddressChat(context.Background(), lids, customerChat(), historyspike.AddressPN)
	if err != nil {
		t.Fatalf("addressing by phone number: %v", err)
	}

	if addressed != customerChat() {
		t.Errorf("addressed = %q, want the seam's own chat %q", addressed, customerChat())
	}
}

func TestAddressingByLIDNamesTheCounterpartysHiddenUserIdentity(t *testing.T) {
	lids := knownLIDs{mapped: map[types.JID]types.JID{customerChat(): counterpartyLID}}

	addressed, err := historyspike.AddressChat(context.Background(), lids, customerChat(), historyspike.AddressLID)
	if err != nil {
		t.Fatalf("addressing by LID: %v", err)
	}

	if addressed != counterpartyLID {
		t.Errorf("addressed = %q, want %q", addressed, counterpartyLID)
	}
}

func TestAddressingByLIDRefusesWhenThePlaneKnowsNoLIDForTheChat(t *testing.T) {
	// The store learns the mapping from the phone's own history sync, so a
	// chat it has never seen one for cannot be addressed that way — and
	// asking with an empty JID would spend the rig session on a request the
	// phone cannot resolve either.
	lids := knownLIDs{mapped: map[types.JID]types.JID{}}

	_, err := historyspike.AddressChat(context.Background(), lids, customerChat(), historyspike.AddressLID)

	if !errors.Is(err, historyspike.ErrNoLIDForChat) {
		t.Fatalf("error = %v, want ErrNoLIDForChat", err)
	}
}

func TestAddressingByLIDReportsAMapItCouldNotRead(t *testing.T) {
	lids := knownLIDs{err: errors.New("session store unreachable")}

	_, err := historyspike.AddressChat(context.Background(), lids, customerChat(), historyspike.AddressLID)

	if err == nil {
		t.Fatal("a map that could not be read reported no error")
	}
	if errors.Is(err, historyspike.ErrNoLIDForChat) {
		t.Errorf("error = %v, want it kept apart from «no LID known» — a store that cannot be read is not an answer", err)
	}
}

func TestTheAccountLIDIsTheAccountsAndNeverTheDevices(t *testing.T) {
	// whatsmeow saves the LID the pairing handshake returned, device number
	// and all (pair.go:213), and the rig's own device is `:14`. Field 6 wants
	// the account.
	stored := types.NewJID("999888777666555", types.HiddenUserServer)
	stored.Device = 14

	account, err := historyspike.AccountLID(stored)
	if err != nil {
		t.Fatalf("normalizing the stored LID: %v", err)
	}

	if account.Device != 0 {
		t.Errorf("account LID = %q, want the device number dropped", account)
	}
	if account != types.NewJID("999888777666555", types.HiddenUserServer) {
		t.Errorf("account LID = %q, want the bare account identity", account)
	}
}

func TestTheAccountLIDRefusesWhatIsNotOne(t *testing.T) {
	for name, stored := range map[string]types.JID{
		"nothing stored": {},
		"a phone number": types.NewJID("5215559999", types.DefaultUserServer),
		"a server alone": types.NewJID("", types.HiddenUserServer),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := historyspike.AccountLID(stored); !errors.Is(err, historyspike.ErrNotAnAccountLID) {
				t.Errorf("error = %v, want ErrNotAnAccountLID", err)
			}
		})
	}
}

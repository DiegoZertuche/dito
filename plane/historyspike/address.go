package historyspike

import (
	"context"
	"errors"
	"fmt"

	"go.mau.fi/whatsmeow/types"
)

// Addressing is the identity the request names the chat by. The phone looks
// that name up in ITS OWN store, and the LID migration means the phone's
// canonical thread identity may be the counterparty's hidden-user id rather
// than their phone number — a history conversation carries both (`pnJID`
// field 39 and `lidJID` field 42 of waHistorySync.Conversation), and
// whatsmeow's ordinary send path rewrites a phone-number destination to the
// LID before it sends (send.go's SendMessage). The seam is PN-canonical
// (ingest's canonicalDMChat), so a request built from a seam anchor asks by
// phone number, and run 3 got silence: no history, no refusal, nothing
// (#216). This option is how run 4 asks the other way.
type Addressing string

const (
	// AddressPN names the chat by its phone-number JID — what the seam
	// holds, and what runs 1 through 3 asked with. The default, because
	// changing the default would change what the rig has been measuring.
	AddressPN Addressing = "pn"
	// AddressLID names the chat by the counterparty's hidden-user identity,
	// read out of the plane's own map.
	AddressLID Addressing = "lid"
)

// ErrNoLIDForChat marks a chat the plane holds no LID for. Asking with an
// empty identity would spend a rig session on a request the phone cannot
// resolve either, so the mode refuses instead and says which chat.
var ErrNoLIDForChat = errors.New("the plane's session store knows no LID for this chat")

// ParseAddressing reads the option's value, and takes nothing but the two
// words: a mistyped addressing that fell back to a default would make run 4
// measure run 3 again.
func ParseAddressing(spelling string) (Addressing, error) {
	switch Addressing(spelling) {
	case AddressPN:
		return AddressPN, nil
	case AddressLID:
		return AddressLID, nil
	default:
		return "", fmt.Errorf("%q is not an addressing — it is %q or %q", spelling, AddressPN, AddressLID)
	}
}

// LIDs is the phone-number-to-LID map the plane already holds:
// whatsmeow's own device store, which fills it from the mappings the PHONE
// sends inside its history sync (message.go's storeHistoricalPNLIDMappings)
// and from the LID migration messages it pushes. *store.Device's LIDs is the
// binary's implementation; nothing here reaches the network.
type LIDs interface {
	GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error)
}

// AddressChat resolves the identity the request will name the chat by. The
// ANCHOR still comes from the seam's own PN-keyed row either way (Seam.Anchor)
// — only the key the phone is asked to look up moves, which is what makes
// run 4 one experiment rather than two.
func AddressChat(ctx context.Context, lids LIDs, chat types.JID, address Addressing) (types.JID, error) {
	if address == AddressPN {
		return chat, nil
	}
	lid, err := lids.GetLIDForPN(ctx, chat)
	if err != nil {
		// Kept apart from ErrNoLIDForChat on purpose: a store that cannot be
		// read has told the operator nothing about the chat.
		return types.JID{}, fmt.Errorf("reading the plane's LID map for %s: %w", chat, err)
	}
	if lid.IsEmpty() {
		return types.JID{}, fmt.Errorf("%w: %s — the mapping arrives with the phone's own history sync, so a chat with no history here has none", ErrNoLIDForChat, chat)
	}
	return lid.ToNonAD(), nil
}

// ErrNotAnAccountLID marks a stored LID that is not usable as the account's
// own identity.
var ErrNotAnAccountLID = errors.New("this session's stored LID is not an account identity")

// AccountLID normalizes the account's own LID for the request's `accountLid`
// field — THE BARE ACCOUNT IDENTITY, never this device's.
//
// The distinction is not pedantic here (Codex r1). whatsmeow stores the LID
// the pairing handshake returned, device number and all: pair.go derives a
// `mainDeviceLID` with `Device = 0` for the identity work and then saves the
// device-qualified value on the store (pair.go:201-213). The rig's own device
// is `:14`, so `Store.GetLID()` there answers `…:14@lid` — and a request
// stating THAT in field 6 would be answered by nobody, for a reason that
// looks exactly like the silence run 3 already produced. A misleading
// negative is the one result this experiment cannot afford.
func AccountLID(stored types.JID) (types.JID, error) {
	account := stored.ToNonAD()
	if account.IsEmpty() || account.User == "" || account.Server != types.HiddenUserServer {
		return types.JID{}, fmt.Errorf("%w: %q", ErrNotAnAccountLID, stored)
	}
	return account, nil
}

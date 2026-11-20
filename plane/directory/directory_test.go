package directory_test

import (
	"testing"

	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/directory"
)

// The kind is read off the ADDRESS and the live session identity, which are
// the same two inputs the capture guard decides scope from — so a row's kind
// and its scope can never disagree about which chat is the twin thread
// (ticket #222).
func TestKindIsReadOffTheAddressAndTheSessionIdentity(t *testing.T) {
	self := types.NewJID("5215559999", types.DefaultUserServer)
	for _, c := range []struct {
		what string
		chat types.JID
		want directory.Kind
	}{
		{"the rep's own thread", self, directory.KindSelf},
		{"the rep's own thread on a device-qualified address", types.JID{
			User: self.User, Server: types.DefaultUserServer, Device: 14,
		}, directory.KindSelf},
		{"a counterparty by phone number", types.NewJID("5215550001", types.DefaultUserServer), directory.KindDM},
		{"a counterparty by LID", types.NewJID("111222333444555", types.HiddenUserServer), directory.KindDM},
		{"a group", types.NewJID("5215550001-1600000000", types.GroupServer), directory.KindGroup},
		{"a broadcast list", types.NewJID("status", types.BroadcastServer), directory.KindOther},
		// WhatsApp's OWN account, which is a reserved address in the rail's
		// space rather than a person: read as a `dm` it was offered for scoping
		// on the rig and its fill then refused `no_lid` (boundary #225, F32).
		{"WhatsApp's own system chat", types.NewJID(directory.SystemUser, types.DefaultUserServer), directory.KindOther},
		// ...and the same digits on the hidden server stay a counterparty: a
		// LID is an opaque identifier, so `0` there is reserved by nobody.
		{"a LID whose digits happen to read zero", types.NewJID(directory.SystemUser, types.HiddenUserServer), directory.KindDM},
		// ...as does a device-qualified address of the system account, because
		// the bare form is what the kind is read off.
		{"WhatsApp's own system chat, device-qualified", types.JID{
			User: directory.SystemUser, Server: types.DefaultUserServer, Device: 3,
		}, directory.KindOther},
	} {
		t.Run(c.what, func(t *testing.T) {
			if got := directory.KindOf(c.chat, self); got != c.want {
				t.Errorf("KindOf = %q, want %q", got, c.want)
			}
		})
	}
}

// Before the session identity is known nothing is the twin thread, and the
// rep's own chat reads as the counterparty it structurally is not. The kind is
// therefore REPLACED on every upsert rather than kept (Store.Upsert argues
// it): freezing this first answer would leave the rep's own thread on the
// scoping page as somebody to scope.
func TestWithoutASessionIdentityNoChatIsTheTwinThread(t *testing.T) {
	self := types.NewJID("5215559999", types.DefaultUserServer)
	if got := directory.KindOf(self, types.JID{}); got != directory.KindDM {
		t.Errorf("KindOf with no session identity = %q, want %q", got, directory.KindDM)
	}
}

// The closed set is the store's CHECK, `@dito/seam`'s CHAT_KINDS and this
// slice, and `migration-vocabulary.test.ts` sweeps the first two against each
// other. This is the third copy's own half: a word added here with no
// migration behind it is a kind the plane writes and the store refuses — a
// constraint violation on an ordinary history sync, which fail-stops the plane
// and takes capture down with it, over a chat nobody scoped.
func TestTheKindsAreExactlyTheFourTheStoreAccepts(t *testing.T) {
	want := []directory.Kind{"self", "dm", "group", "other"}
	if len(directory.Kinds) != len(want) {
		t.Fatalf("Kinds = %v, want %v", directory.Kinds, want)
	}
	for i, kind := range want {
		if directory.Kinds[i] != kind {
			t.Errorf("Kinds[%d] = %q, want %q", i, directory.Kinds[i], kind)
		}
	}
}

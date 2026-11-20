package historyspike_test

import (
	"testing"

	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/historyspike"
)

func TestTheChatFlagTakesAFullJID(t *testing.T) {
	for _, spelling := range []string{
		"5215551234567@s.whatsapp.net",
		"111222333444555@lid",
	} {
		t.Run(spelling, func(t *testing.T) {
			chat, err := historyspike.ParseChat(spelling)
			if err != nil {
				t.Fatalf("parsing %q: %v", spelling, err)
			}
			if chat.String() != spelling {
				t.Errorf("chat = %q, want %q", chat, spelling)
			}
		})
	}
}

func TestTheChatFlagRefusesAnythingButAFullJID(t *testing.T) {
	// A bare number is the mistype that costs a rig session: whatsmeow's own
	// parser reads it as a SERVER with no user and reports no error, so the
	// spike would ask about a chat nobody has.
	for _, spelling := range []string{"", "5215551234567", "@s.whatsapp.net", "not a jid"} {
		t.Run(spelling, func(t *testing.T) {
			if _, err := historyspike.ParseChat(spelling); err == nil {
				t.Errorf("%q was accepted as a chat", spelling)
			}
		})
	}
}

func TestTheChatFlagDropsADeviceSuffix(t *testing.T) {
	// A JID copied off a delivery can carry the device it came from; the chat
	// is the conversation, never one of its devices.
	chat, err := historyspike.ParseChat("5215551234567.0:3@s.whatsapp.net")
	if err != nil {
		t.Fatalf("parsing a device-qualified JID: %v", err)
	}
	if chat != types.NewJID("5215551234567", types.DefaultUserServer) {
		t.Errorf("chat = %q, want the bare conversation JID", chat)
	}
}

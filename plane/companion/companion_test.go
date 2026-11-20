package companion_test

import (
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/store"

	"github.com/Dito-Core/dito/plane/companion"
)

// The name the phone's own sync notifications carry, pinned (ticket #222).
//
// WHY A TEST FOR A CONSTANT. It is the one string in this repo whose reader is
// a screen nobody here controls — the notification the phone sends after every
// page of a fill — so a refactor that blanked it or a library default that came
// back would be invisible in every other lane: the plane would build, connect,
// capture and send, and the rep would find «whatsmeow» beside their own
// devices. (What the Dispositivos vinculados screen calls the device is what
// the rep types into WhatsApp's own prompt — boundary #225, F15.)
func TestTheCompanionIsNamedDito(t *testing.T) {
	if companion.Name != "Dito" {
		t.Fatalf("companion.Name = %q, want %q — the rep reads this on their phone", companion.Name, "Dito")
	}
}

// ...and Advertise puts exactly that string in the one device property that
// carries it, BARE. The pairing hello's display is a different field with a
// validator of its own (`plane/pairing`), and this one has no format at all.
func TestAdvertiseStatesTheNameInTheDeviceProperties(t *testing.T) {
	before := store.DeviceProps.GetOs()
	t.Cleanup(func() { store.DeviceProps.Os = &before })

	companion.Advertise()

	if got := store.DeviceProps.GetOs(); got != companion.Name {
		t.Errorf("DeviceProps.Os = %q, want the bare %q", got, companion.Name)
	}
	if strings.ContainsAny(store.DeviceProps.GetOs(), "()") {
		t.Errorf("DeviceProps.Os = %q carries a parenthesised slot — that shape is the pairing hello's, not this field's", store.DeviceProps.GetOs())
	}
	if before == companion.Name {
		// The library ships «whatsmeow» here, so a default that already said
		// «Dito» would mean this function is being tested against itself and
		// proves nothing.
		t.Errorf("the library's own default is already %q — this test would pass with Advertise doing nothing", companion.Name)
	}
}

// It sets ONE field. `store.SetOSInfo` would write three version numbers and
// two user-agent strings beside the name, and a companion that reported a
// made-up OS version to change a display name would be advertising something
// nobody decided (`capability.go`'s rule about every pairing switch).
func TestAdvertiseTouchesNothingButTheName(t *testing.T) {
	beforeOs := store.DeviceProps.GetOs()
	beforeVersion := store.DeviceProps.GetVersion().String()
	beforePlatform := store.DeviceProps.GetPlatformType()
	beforeHistory := store.DeviceProps.GetHistorySyncConfig().String()
	t.Cleanup(func() { store.DeviceProps.Os = &beforeOs })

	companion.Advertise()

	if got := store.DeviceProps.GetVersion().String(); got != beforeVersion {
		t.Errorf("the app version moved: %q, want %q", got, beforeVersion)
	}
	if got := store.DeviceProps.GetPlatformType(); got != beforePlatform {
		t.Errorf("the platform type moved: %v, want %v — one field per pairing, or nothing is measured", got, beforePlatform)
	}
	if got := store.DeviceProps.GetHistorySyncConfig().String(); got != beforeHistory {
		t.Errorf("the history sync config moved — this function has nothing to say about what the phone pushes at pairing")
	}
}

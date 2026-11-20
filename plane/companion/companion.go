// Package companion is what this device calls itself to the rep's phone
// (ticket #222).
//
// WHAT THE REP SEES, AND WHY IT MATTERED ENOUGH TO NAME. WhatsApp shows every
// linked device on its Dispositivos vinculados screen, and it names this one
// in the notification the phone sends after every history sync — one per page
// of a ninety-day fill (#216's readings of 2026-09-07). The library ships
// «whatsmeow»; the rig phone rendered the plane as «Portal» on the screen and
// «Other device» in those notifications. None of the three is anything the rep
// agreed to, and the fill is precisely the moment they get a burst of them.
//
// THE PRODUCT'S NAME, NOT AN OPERATOR'S CHOICE. It is a constant and set
// unconditionally at startup — not a rig flag beside the spike's knobs
// (`historyspike/capability.go`) — because the rep reads it on their own
// phone, and a companion whose name depended on how the plane was started
// would be a different product on every seat.
//
// CONTENT-FREE BY CONSTRUCTION: a constant, never composed from a seat, a twin
// or a number, so nothing about the rep can reach a screen through it.
//
// IT TAKES EFFECT AT THE NEXT PAIRING ONLY. The device properties are read
// once, when the pairing payload is composed, so this changes nothing about a
// live session and everything about the next one — the rig needs one QR
// re-scan to show it.
//
// AND NO PROPERTY HERE DECIDES THE LINKED-DEVICES NAME (boundary #225, F15).
// WhatsApp asks the rep to name the device when they link it, and what they
// type is what that screen shows — so a `PlatformType` stated here would change
// nothing anybody reads, and there is no experiment left to run. The name below
// is still stated, because it is the phone's own SYNC NOTIFICATIONS that carry
// it, and the rep did not agree to «whatsmeow» or «Other device» either.
//
// WHETHER THAT NAMING PROMPT APPEARS ON EVERY PHONE is open, and the pilot's own
// phones answer it — carried on the horizon ([#117]) rather than guessed at
// here.
package companion

import (
	"go.mau.fi/whatsmeow/store"
	"google.golang.org/protobuf/proto"
)

// Name is the companion's name as the phone's own sync notifications carry it,
// and it is what the device properties advertise for both link paths.
//
// IT IS NOT THE LINKED-DEVICES NAME, which the rep types themselves (see the
// package header), and it is not the pairing hello's display either: that field
// is validated against the server's own list of browsers and operating systems,
// so `plane/pairing` states a value out of that vocabulary and this name plays
// no part in it (#245 F3).
const Name = "Dito"

// Advertise states the name in the device properties whatsmeow sends in its
// registration payload. Call it before the link session and before connect;
// it changes the NEXT pairing and nothing about a live session.
//
// IT SETS EXACTLY ONE FIELD, and the version beside it is left alone
// deliberately: `store.SetOSInfo` would write the name AND three version
// numbers AND two user-agent strings, and a companion that reported a made-up
// OS version to change a display name would be advertising something nobody
// decided (the argument `capability.go` makes about every one of the spike's
// switches).
func Advertise() {
	store.DeviceProps.Os = proto.String(Name)
}

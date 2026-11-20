// Package railstatus defines the rail_status event vocabulary the connection
// plane emits (ADR-0005, job 3): plane status metadata that powers the
// connection state machines and surfaces the link QR. Never rep content.
package railstatus

import "time"

// Status is one of the closed set of rail lifecycle states.
type Status string

const (
	// StatusQR is a fresh link QR code offered for scanning; Detail carries
	// the raw code. Emitted only while no session is established.
	StatusQR Status = "qr"
	// StatusLinked is a live socket on an established session.
	StatusLinked Status = "linked"
	// StatusDropped is a lost socket on a still-established session — the
	// plane reconnects without re-scanning.
	StatusDropped Status = "dropped"
	// StatusLoggedOut is a severed session: the rail requires a fresh QR
	// link. Enforcement signals surface here (rig doctrine, #4).
	StatusLoggedOut Status = "logged_out"
	// StatusPairingCode is a fresh phone-pairing code offered for typing;
	// Detail carries the eight characters the rep types into WhatsApp. The
	// OTHER door into one link session, for a rep with no second screen — a
	// phone cannot scan a QR on its own (ADR-0031, which names the ~160-second
	// window). Emitted only while no session is established, exactly as the
	// QR is, and its Detail is a live credential: nothing but the plane holds
	// a grant on that column (…20260907100040, ticket #222).
	StatusPairingCode Status = "pairing_code"
)

// Statuses is the closed set in one place. `@dito/seam`'s RAIL_STATUSES is the
// second copy and `rail_status_events_status_check` the third; the sweep in
// `migration-vocabulary.test.ts` compares those two, and the test beside this
// file is what keeps this one from drifting out of both.
var Statuses = []Status{StatusQR, StatusLinked, StatusDropped, StatusLoggedOut, StatusPairingCode}

// Event is one rail_status transition as the plane observed it.
type Event struct {
	Status     Status
	Detail     string
	OccurredAt time.Time
}

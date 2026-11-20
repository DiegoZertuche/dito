// Package rail is the connection plane's linked-device-rail state machine
// (ticket #21): it translates raw whatsmeow events into rail_status events
// (ADR-0005, job 3). Pure translation — zero business logic. ("Rail" per
// CONTEXT.md's linked-device rail; "Session" is reserved for the twin's
// conversational thread.)
package rail

import (
	"context"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/railstatus"
)

// recordTimeout bounds each seam write so a hung database can never wedge
// whatsmeow's event-handler goroutine.
const recordTimeout = 5 * time.Second

// Recorder receives the rail_status events the rail emits — the Postgres
// seam in the binary, an in-memory sink in tests.
type Recorder interface {
	Record(ctx context.Context, e railstatus.Event) error
}

// Identity is the live whatsmeow session identity — the sole source of
// "self" for system_send and the capture guard's self-chat rule (ADR-0006:
// never a table or caller value). *store.Device satisfies it directly:
// GetJID and GetLID return the empty JID until the device is linked.
type Identity interface {
	GetJID() types.JID
	GetLID() types.JID
}

// Rail translates whatsmeow events into rail_status transitions.
type Rail struct {
	rec Recorder
	id  Identity

	mu   sync.Mutex
	last railstatus.Status
}

// New builds a rail that emits rail_status events into rec and derives self
// from id. id may be nil in tests that never derive self.
func New(rec Recorder, id Identity) *Rail {
	return &Rail{rec: rec, id: id}
}

// SelfJID derives the rep's self JID — the sole legal system_send
// destination (ADR-0006) — from the live session identity, reading through
// to the device store on every call. It is not derivable before the device
// links. The paired device JID is device-qualified; self is the bare user
// JID that addresses the self-chat.
func (r *Rail) SelfJID() (types.JID, bool) {
	if r.id == nil {
		return types.JID{}, false
	}
	jid := r.id.GetJID()
	if jid.IsEmpty() {
		return types.JID{}, false
	}
	return jid.ToNonAD(), true
}

// SelfLID derives the rep's hidden-user (LID) identity from the live
// session, reading through to the device store on every call — the same
// sole-source doctrine as SelfJID (ADR-0006). Modern rails can address the
// self-chat by LID, so the capture guard's always-in-scope rule (ADR-0023)
// must recognize both identities. Bare, like SelfJID.
func (r *Rail) SelfLID() (types.JID, bool) {
	if r.id == nil {
		return types.JID{}, false
	}
	lid := r.id.GetLID()
	if lid.IsEmpty() {
		return types.JID{}, false
	}
	return lid.ToNonAD(), true
}

// HandleEvent consumes one raw whatsmeow event. Wire it via
// whatsmeow.Client.AddEventHandler.
func (r *Rail) HandleEvent(evt any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch e := evt.(type) {
	case *events.TemporaryBan:
		// An enforcement signal must never be a silent outage (rig
		// doctrine #4; ADR-0017: enforcement signals arrive via
		// rail_status). The ban severs service, so it lands as logged_out
		// with the reason in the detail — recorded from any state.
		r.transition(railstatus.StatusLoggedOut, e.String())
	case *events.Connected:
		r.transition(railstatus.StatusLinked, "")
	case *events.LoggedOut:
		// The session is severed — only a fresh QR link restores the rail.
		// Enforcement signals surface as logouts, so this transition is the
		// one the rig doctrine (#4) watches (ADR-0017: enforcement signals
		// arrive via rail_status).
		r.transition(railstatus.StatusLoggedOut, "")
	case *events.Disconnected, *events.StreamReplaced:
		// dropped only applies to an established rail: a disconnect during
		// a never-linked QR flow (e.g. link-session timeout) is not a drop.
		// StreamReplaced is a drop by takeover — another process connected
		// on the same session keys.
		if r.last == railstatus.StatusLinked {
			r.transition(railstatus.StatusDropped, "")
		}
	case *events.KeepAliveTimeout:
		// whatsmeow's keepalive failure path eventually reconnects via a
		// manual Disconnect that emits no Disconnected event — the outage
		// surfaces here or not at all.
		if r.last == railstatus.StatusLinked {
			r.transition(railstatus.StatusDropped, "keepalive-timeout")
		}
	case *events.KeepAliveRestored:
		if r.last == railstatus.StatusDropped {
			r.transition(railstatus.StatusLinked, "")
		}
	}
}

// HandleLinkFailure records a link session that ended without pairing as
// logged_out — a fresh QR is required. The binary calls it when whatsmeow
// closes the QR channel without success, the library's one true terminal
// signal (individual items like passkey requests or a rescan keep the
// channel open). A live rail is never marked logged_out by the link
// session's end — an "unexpected event" closure can mean pairing already
// existed and Connected has spoken — and the return value says whether the
// failure was recorded: the rail's own linked state is the sole authority
// here (a populated device JID is not proof of completed pairing — the
// store save can fail after the JID is assigned).
func (r *Rail) HandleLinkFailure(reason string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last == railstatus.StatusLinked {
		return false
	}
	r.transition(railstatus.StatusLoggedOut, reason)
	return true
}

// HandleQRItem consumes one whatsmeow QR channel item. Fresh codes are
// recorded as qr rail_status events, each carrying its code — every rotated
// code is a distinct scan offer, so codes are never deduped. No other item
// records anything: success is followed by Connected, and failure is
// signalled by the channel closing, which the binary reports via
// HandleLinkFailure.
func (r *Rail) HandleQRItem(item whatsmeow.QRChannelItem) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if item.Event != whatsmeow.QRChannelEventCode {
		return
	}
	if err := r.write(railstatus.StatusQR, item.Code); err == nil {
		r.last = railstatus.StatusQR
	}
}

// HandleShutdown records the deliberate socket teardown of a plane stop as
// dropped — the session stays established and the restarted plane resumes it,
// so a restart reads linked → dropped → linked on the seam, distinguishable
// from a duplicate linked. Call it before disconnecting the client.
func (r *Rail) HandleShutdown() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last == railstatus.StatusLinked {
		r.transition(railstatus.StatusDropped, "")
	}
}

// transition records one state change while r.mu is held; a repeat of the
// current state is a no-op — rail_status is a transition record, not a
// heartbeat. The state advances only after the seam write succeeds, so a
// failed write leaves the transition pending and the next event re-records
// it; holding the lock across the write keeps concurrent whatsmeow
// callbacks from interleaving rows out of order.
func (r *Rail) transition(status railstatus.Status, detail string) {
	if r.last == status {
		return
	}
	if err := r.write(status, detail); err == nil {
		r.last = status
	}
}

// write performs one bounded seam write.
func (r *Rail) write(status railstatus.Status, detail string) error {
	ctx, cancel := context.WithTimeout(context.Background(), recordTimeout)
	defer cancel()
	return r.rec.Record(ctx, railstatus.Event{
		Status:     status,
		Detail:     detail,
		OccurredAt: time.Now().UTC(),
	})
}

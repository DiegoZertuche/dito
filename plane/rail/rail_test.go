package rail_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/rail"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// recordingSink captures the rail_status events the rail emits — the
// pre-agreed seam (spec #18): constructed whatsmeow events in, rail_status
// events out. Tests never reach inside the rail.
type recordingSink struct {
	events          []railstatus.Event
	lastHadDeadline bool
	failNext        int
	attempts        int
}

func (r *recordingSink) Record(ctx context.Context, e railstatus.Event) error {
	r.attempts++
	_, r.lastHadDeadline = ctx.Deadline()
	if r.failNext > 0 {
		r.failNext--
		return errors.New("seam unavailable")
	}
	r.events = append(r.events, e)
	return nil
}

// deviceIdentity fakes the whatsmeow device store's identity surface: a JID
// (and its LID counterpart) once linked, the empty JID before.
type deviceIdentity struct {
	jid types.JID
	lid types.JID
}

func (d *deviceIdentity) GetJID() types.JID {
	return d.jid
}

func (d *deviceIdentity) GetLID() types.JID {
	return d.lid
}

func statuses(events []railstatus.Event) []railstatus.Status {
	out := make([]railstatus.Status, len(events))
	for i, e := range events {
		out[i] = e.Status
	}
	return out
}

func assertStatuses(t *testing.T, got []railstatus.Event, want []railstatus.Status) {
	t.Helper()
	gotStatuses := statuses(got)
	if len(gotStatuses) != len(want) {
		t.Fatalf("statuses = %v, want %v", gotStatuses, want)
	}
	for i := range want {
		if gotStatuses[i] != want[i] {
			t.Fatalf("statuses = %v, want %v", gotStatuses, want)
		}
	}
}

func TestConnectedRecordsLinked(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})

	if len(sink.events) != 1 {
		t.Fatalf("recorded %d events, want 1", len(sink.events))
	}
	if got, want := sink.events[0].Status, railstatus.StatusLinked; got != want {
		t.Fatalf("status = %q, want %q", got, want)
	}
	if sink.events[0].OccurredAt.IsZero() {
		t.Fatal("occurred_at is zero, want stamped")
	}
}

func TestSelfJIDDerivesOnlyFromLiveSessionIdentity(t *testing.T) {
	rig := types.NewJID("5215512345678", types.DefaultUserServer)
	device := &deviceIdentity{}
	r := rail.New(&recordingSink{}, device)

	if _, ok := r.SelfJID(); ok {
		t.Fatal("SelfJID derivable before link, want not derivable")
	}

	// The rig device scans; whatsmeow stores the paired JID (device 3 of
	// the rig number). Self is the bare user JID that addresses the
	// self-chat (ADR-0006: derived from live session identity only).
	device.jid = types.JID{User: rig.User, Server: types.DefaultUserServer, Device: 3}
	got, ok := r.SelfJID()
	if !ok {
		t.Fatal("SelfJID not derivable after link, want derivable")
	}
	if got != rig {
		t.Fatalf("SelfJID = %s, want %s", got, rig)
	}
}

func TestSelfLIDDerivesOnlyFromLiveSessionIdentity(t *testing.T) {
	device := &deviceIdentity{}
	r := rail.New(&recordingSink{}, device)

	if _, ok := r.SelfLID(); ok {
		t.Fatal("SelfLID derivable before link, want not derivable")
	}

	// The rail assigns the account a hidden-user (LID) identity alongside
	// the phone number; modern deliveries can address the self-chat by it,
	// so the guard needs it from the same live-session source as SelfJID
	// (ADR-0006 — never a table or caller value).
	device.jid = types.JID{User: "5215512345678", Server: types.DefaultUserServer, Device: 3}
	device.lid = types.JID{User: "111222333444555", Server: types.HiddenUserServer, Device: 3}
	got, ok := r.SelfLID()
	if !ok {
		t.Fatal("SelfLID not derivable after link, want derivable")
	}
	if want := types.NewJID("111222333444555", types.HiddenUserServer); got != want {
		t.Fatalf("SelfLID = %s, want bare %s", got, want)
	}
}

func TestSocketDropAndReconnectRecordsLinkedDroppedLinked(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.Disconnected{})
	r.HandleEvent(&events.Connected{})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
		railstatus.StatusLinked,
	})
}

func TestQRCodesRecordQREventsCarryingTheCode(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleQRItem(whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@abc123"})
	r.HandleQRItem(whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@def456"})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusQR,
		railstatus.StatusQR,
	})
	if got, want := sink.events[0].Detail, "2@abc123"; got != want {
		t.Fatalf("detail = %q, want %q", got, want)
	}
	if got, want := sink.events[1].Detail, "2@def456"; got != want {
		t.Fatalf("detail = %q, want %q", got, want)
	}
}

func TestQRSuccessRecordsNothingBecauseConnectedFollows(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleQRItem(whatsmeow.QRChannelSuccess)

	if len(sink.events) != 0 {
		t.Fatalf("recorded %v, want none — success is followed by Connected", statuses(sink.events))
	}
}

func TestNonCodeQRItemsAloneRecordNothing(t *testing.T) {
	// Individual non-code items are not the link session's terminal signal:
	// whatsmeow keeps the channel open across passkey items, rescans, and
	// passkey errors, and closes it as the one true terminal. The binary
	// reacts to closure via HandleLinkFailure.
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	for _, item := range []whatsmeow.QRChannelItem{
		whatsmeow.QRChannelSuccess,
		whatsmeow.QRChannelTimeout,
		{Event: whatsmeow.QRChannelEventError},
		whatsmeow.QRChannelClientOutdated,
		whatsmeow.QRChannelScannedWithoutMultidevice,
		{Event: whatsmeow.QRChannelEventPasskeyRequest},
	} {
		r.HandleQRItem(item)
	}

	if len(sink.events) != 0 {
		t.Fatalf("recorded %v, want none", statuses(sink.events))
	}
}

func TestLinkFailureRecordsLoggedOutSoTheSeamNeverShowsADeadQR(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleQRItem(whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@abc123"})
	if !r.HandleLinkFailure("timeout") {
		t.Fatal("HandleLinkFailure = false on an unlinked rail, want true (failure recorded)")
	}

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusQR,
		railstatus.StatusLoggedOut,
	})
	if got := sink.events[1].Detail; got != "timeout" {
		t.Fatalf("detail = %q, want the failure reason", got)
	}
}

func TestLinkFailureAfterLinkedRecordsNothing(t *testing.T) {
	// An "unexpected event" closure can mean pairing already existed and
	// Connected has spoken — a live rail is never marked logged_out by the
	// link session's end.
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	if r.HandleLinkFailure("err-unexpected-state") {
		t.Fatal("HandleLinkFailure = true on a linked rail, want false (nothing recorded)")
	}

	assertStatuses(t, sink.events, []railstatus.Status{railstatus.StatusLinked})
}

func TestTemporaryBanSurfacesAsAnEnforcementSignal(t *testing.T) {
	// Rig doctrine (#4) and ADR-0017: enforcement signals arrive via
	// rail_status — a ban must never be a silent outage.
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.Disconnected{})
	r.HandleEvent(&events.TemporaryBan{Code: 101, Expire: 24 * time.Hour})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
		railstatus.StatusLoggedOut,
	})
	if got := sink.events[2].Detail; !strings.Contains(got, "banned") {
		t.Fatalf("detail = %q, want the ban reason surfaced", got)
	}
}

func TestKeepaliveOutageRecordsDroppedAndRestoreRelinks(t *testing.T) {
	// whatsmeow's keepalive failure path reconnects via a manual Disconnect
	// that emits no Disconnected event — the outage must surface from the
	// keepalive events themselves.
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.KeepAliveTimeout{ErrorCount: 1})
	r.HandleEvent(&events.KeepAliveTimeout{ErrorCount: 2})
	r.HandleEvent(&events.KeepAliveRestored{})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
		railstatus.StatusLinked,
	})
}

func TestKeepaliveEventsBeforeAnyLinkRecordNothing(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.KeepAliveTimeout{ErrorCount: 1})
	r.HandleEvent(&events.KeepAliveRestored{})

	if len(sink.events) != 0 {
		t.Fatalf("recorded %v, want none", statuses(sink.events))
	}
}

func TestStreamReplacedWhileLinkedRecordsDropped(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.StreamReplaced{})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
	})
}

func TestLoggedOutSeversTheRail(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.LoggedOut{OnConnect: false})
	// The socket close that follows a logout is not a drop — the rail is
	// already severed and only a fresh QR link restores it.
	r.HandleEvent(&events.Disconnected{})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusLoggedOut,
	})
}

func TestDisconnectBeforeAnyLinkRecordsNothing(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Disconnected{})

	if len(sink.events) != 0 {
		t.Fatalf("recorded %v, want none — dropped means a lost socket on an established rail", statuses(sink.events))
	}
}

func TestRepeatedSameStateEventsRecordOneTransition(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.Disconnected{})
	r.HandleEvent(&events.Disconnected{})

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
	})
}

func TestShutdownRecordsDroppedSoARestartShowsTheTransition(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})
	r.HandleShutdown()

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
	})
}

func TestShutdownBeforeAnyLinkRecordsNothing(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleShutdown()

	if len(sink.events) != 0 {
		t.Fatalf("recorded %v, want none — a never-linked plane stopping is not a drop", statuses(sink.events))
	}
}

func TestSeamWriteFailureRetriesTheTransitionOnTheNextEvent(t *testing.T) {
	sink := &recordingSink{failNext: 1}
	r := rail.New(sink, nil)

	// The first write fails; the transition must not be swallowed by the
	// same-state dedupe when whatsmeow re-emits the event.
	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.Connected{})

	if sink.attempts != 2 {
		t.Fatalf("recorder attempts = %d, want 2 — a failed transition must be retried, not deduped away", sink.attempts)
	}
	assertStatuses(t, sink.events, []railstatus.Status{railstatus.StatusLinked})
}

// blockingSink blocks its first Record call until released, so tests can
// hold one transition's seam write in flight while another event arrives.
type blockingSink struct {
	recordingSink
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingSink) Record(ctx context.Context, e railstatus.Event) error {
	blocked := false
	b.once.Do(func() {
		blocked = true
		close(b.entered)
		<-b.release
	})
	_ = blocked
	return b.recordingSink.Record(ctx, e)
}

func TestConcurrentEventsCannotReorderSeamRows(t *testing.T) {
	sink := &blockingSink{entered: make(chan struct{}), release: make(chan struct{})}
	r := rail.New(sink, nil)

	first := make(chan struct{})
	go func() {
		r.HandleEvent(&events.Connected{})
		close(first)
	}()
	<-sink.entered // the linked write is in flight, blocked

	second := make(chan struct{})
	go func() {
		r.HandleEvent(&events.Disconnected{})
		close(second)
	}()
	// Give the disconnect handler every chance to (wrongly) overtake the
	// in-flight linked write before it is released.
	time.Sleep(50 * time.Millisecond)
	close(sink.release)
	<-first
	<-second

	assertStatuses(t, sink.events, []railstatus.Status{
		railstatus.StatusLinked,
		railstatus.StatusDropped,
	})
}

func TestSeamWritesCarryABoundedContext(t *testing.T) {
	sink := &recordingSink{}
	r := rail.New(sink, nil)

	r.HandleEvent(&events.Connected{})

	if !sink.lastHadDeadline {
		t.Fatal("recorder context has no deadline — a hung seam would wedge whatsmeow's event-handler goroutine")
	}
}

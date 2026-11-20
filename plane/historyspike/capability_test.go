package historyspike_test

import (
	"fmt"
	"math"
	"testing"

	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"google.golang.org/protobuf/proto"

	"github.com/Dito-Core/dito/plane/historyspike"
)

// The device properties are a library-wide value read once, at pairing, so
// each test restores what it found — the switch is the plane's only lever on
// them and nothing else in the binary touches them.
func deviceProps(t *testing.T) *waCompanionReg.DeviceProps {
	t.Helper()
	before := proto.Clone(store.DeviceProps).(*waCompanionReg.DeviceProps)
	t.Cleanup(func() { store.DeviceProps = before })
	return before
}

func TestOnDemandReadinessIsOffUntilTheSwitchIsThrown(t *testing.T) {
	before := deviceProps(t)

	if before.GetHistorySyncConfig().OnDemandReady != nil {
		t.Errorf("on-demand readiness is advertised by default (%v) — the rig must pair as it does today unless the flag says otherwise",
			before.GetHistorySyncConfig().GetOnDemandReady())
	}
}

func TestTheSwitchAdvertisesOnDemandReadiness(t *testing.T) {
	deviceProps(t)

	historyspike.AdvertiseOnDemandHistory()

	if !store.DeviceProps.GetHistorySyncConfig().GetOnDemandReady() {
		t.Error("the switch did not advertise on-demand readiness")
	}
}

func TestTheSwitchChangesNothingElseAboutPairing(t *testing.T) {
	before := deviceProps(t)

	historyspike.AdvertiseOnDemandHistory()

	after := proto.Clone(store.DeviceProps).(*waCompanionReg.DeviceProps)
	after.GetHistorySyncConfig().OnDemandReady = nil
	if !proto.Equal(before, after) {
		t.Errorf("the switch changed more than on-demand readiness:\nbefore: %v\nafter:  %v", before, after)
	}
}

func TestTheInitialSyncCapIsUnadvertisedUntilTheSwitchIsThrown(t *testing.T) {
	before := deviceProps(t)

	if before.GetHistorySyncConfig().InitialSyncMaxMessagesPerChat != nil {
		t.Errorf("an initial-sync cap is advertised by default (%d) — the rig must pair as it does today unless the flag says otherwise",
			before.GetHistorySyncConfig().GetInitialSyncMaxMessagesPerChat())
	}
}

func TestTheInitialSyncCapAdvertisesTheNumberItWasGiven(t *testing.T) {
	deviceProps(t)

	historyspike.AdvertiseInitialSyncCap(1)

	if got := store.DeviceProps.GetHistorySyncConfig().GetInitialSyncMaxMessagesPerChat(); got != 1 {
		t.Errorf("initial-sync cap = %d, want 1", got)
	}
}

func TestTheInitialSyncCapChangesNothingElseAboutPairing(t *testing.T) {
	before := deviceProps(t)

	historyspike.AdvertiseInitialSyncCap(1)

	after := proto.Clone(store.DeviceProps).(*waCompanionReg.DeviceProps)
	after.GetHistorySyncConfig().InitialSyncMaxMessagesPerChat = nil
	if !proto.Equal(before, after) {
		t.Errorf("the cap changed more than one field:\nbefore: %v\nafter:  %v", before, after)
	}
}

func TestTheTwoPairingSwitchesAreIndependent(t *testing.T) {
	// The protocol run's last step throws both at one pairing, and a pairing
	// is too expensive to spend on a switch that quietly overwrote the other.
	deviceProps(t)

	historyspike.AdvertiseOnDemandHistory()
	historyspike.AdvertiseInitialSyncCap(1)

	config := store.DeviceProps.GetHistorySyncConfig()
	if !config.GetOnDemandReady() || config.GetInitialSyncMaxMessagesPerChat() != 1 {
		t.Errorf("on-demand ready = %t, cap = %d, want true and 1", config.GetOnDemandReady(), config.GetInitialSyncMaxMessagesPerChat())
	}
}

func TestTheInitialSyncCapTakesWhatTheDevicePropertyCanCarry(t *testing.T) {
	for requested, want := range map[uint64]uint32{
		0:              0,
		1:              1,
		math.MaxUint32: math.MaxUint32,
	} {
		t.Run(fmt.Sprint(requested), func(t *testing.T) {
			got, err := historyspike.ParseInitialSyncCap(requested)
			if err != nil {
				t.Fatalf("reading a cap of %d: %v", requested, err)
			}
			if got != want {
				t.Errorf("cap = %d, want %d", got, want)
			}
		})
	}
}

func TestTheInitialSyncCapRefusesWhatWouldBeAdvertisedTruncated(t *testing.T) {
	// A cap that overflowed would be advertised as something else while the
	// startup line said what was asked for — and the pairing that measured it
	// is the expensive act (Codex r1).
	if _, err := historyspike.ParseInitialSyncCap(math.MaxUint32 + 1); err == nil {
		t.Error("a cap above the field's ceiling was accepted")
	}
}

func TestTheRecentSyncWindowIsUnadvertisedUntilTheSwitchIsThrown(t *testing.T) {
	before := deviceProps(t)

	if before.GetHistorySyncConfig().RecentSyncDaysLimit != nil {
		t.Errorf("a recent-sync window is advertised by default (%d days) — every arm so far paired without one",
			before.GetHistorySyncConfig().GetRecentSyncDaysLimit())
	}
}

func TestTheRecentSyncWindowAdvertisesTheNumberOfDaysItWasGiven(t *testing.T) {
	deviceProps(t)

	historyspike.AdvertiseRecentSyncDays(1)

	if got := store.DeviceProps.GetHistorySyncConfig().GetRecentSyncDaysLimit(); got != 1 {
		t.Errorf("recent-sync window = %d days, want 1", got)
	}
}

func TestTheRecentSyncWindowChangesNothingElseAboutPairing(t *testing.T) {
	before := deviceProps(t)

	historyspike.AdvertiseRecentSyncDays(1)

	after := proto.Clone(store.DeviceProps).(*waCompanionReg.DeviceProps)
	after.GetHistorySyncConfig().RecentSyncDaysLimit = nil
	if !proto.Equal(before, after) {
		t.Errorf("the window changed more than one field:\nbefore: %v\nafter:  %v", before, after)
	}
}

func TestTheThreePairingSwitchesAreIndependent(t *testing.T) {
	// The re-pair may throw any combination, and a pairing is too expensive
	// to spend on a switch that quietly overwrote another.
	deviceProps(t)

	historyspike.AdvertiseOnDemandHistory()
	historyspike.AdvertiseInitialSyncCap(1)
	historyspike.AdvertiseRecentSyncDays(1)

	config := store.DeviceProps.GetHistorySyncConfig()
	if !config.GetOnDemandReady() || config.GetInitialSyncMaxMessagesPerChat() != 1 || config.GetRecentSyncDaysLimit() != 1 {
		t.Errorf("on-demand ready = %t, cap = %d, window = %d days; want true, 1 and 1",
			config.GetOnDemandReady(), config.GetInitialSyncMaxMessagesPerChat(), config.GetRecentSyncDaysLimit())
	}
}

func TestTheRecentSyncWindowTakesWhatTheDevicePropertyCanCarry(t *testing.T) {
	for requested, want := range map[uint64]uint32{0: 0, 1: 1, math.MaxUint32: math.MaxUint32} {
		t.Run(fmt.Sprint(requested), func(t *testing.T) {
			got, err := historyspike.ParseRecentSyncDays(requested)
			if err != nil {
				t.Fatalf("reading a window of %d: %v", requested, err)
			}
			if got != want {
				t.Errorf("window = %d, want %d", got, want)
			}
		})
	}
	if _, err := historyspike.ParseRecentSyncDays(math.MaxUint32 + 1); err == nil {
		t.Error("a window above the field's ceiling was accepted")
	}
}

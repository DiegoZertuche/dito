package main

import (
	"bytes"
	"context"
	"testing"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/wastore"
)

// The device the next client runs on after one was severed (ticket #403), on
// the real whatsmeow store in Postgres. A log-out on a running plane is the
// case that needs it: the library deletes the session and binds each client
// to one device, so the plane's next client needs a device that is not spent.

// pairedDevice saves the state QR pairing leaves behind, under a number in the
// fictional 555 range.
func pairedDevice(t *testing.T, container *sqlstore.Container) types.JID {
	t.Helper()
	jid := types.JID{User: "15555550177", Server: types.DefaultUserServer, Device: 4}
	device := container.NewDevice()
	device.ID = &jid
	device.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("test-details"),
		AccountSignature:    bytes.Repeat([]byte{0xA5}, 64),
		AccountSignatureKey: bytes.Repeat([]byte{0x5A}, 32),
		DeviceSignature:     bytes.Repeat([]byte{0xC3}, 64),
	}
	if err := container.PutDevice(context.Background(), device); err != nil {
		t.Fatalf("saving a paired device: %v", err)
	}
	return jid
}

func openStore(t *testing.T) *sqlstore.Container {
	t.Helper()
	dsn := testdb.DSN(t)
	container, err := wastore.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("opening the whatsmeow store: %v", err)
	}
	t.Cleanup(func() { _ = container.Close() })
	return container
}

func storedDevices(t *testing.T, container *sqlstore.Container) int {
	t.Helper()
	devices, err := container.GetAllDevices(context.Background())
	if err != nil {
		t.Fatalf("listing stored devices: %v", err)
	}
	return len(devices)
}

func TestALoggedOutDeviceIsReplacedAndItsSessionLeavesTheStore(t *testing.T) {
	ctx := context.Background()
	container := openStore(t)
	before := storedDevices(t, container)
	jid := pairedDevice(t, container)
	spent, err := container.GetDevice(ctx, jid)
	if err != nil || spent == nil {
		t.Fatalf("reading the paired device back: %v", err)
	}

	next, err := nextDevice(ctx, container, spent, true)
	if err != nil {
		t.Fatalf("choosing the next device: %v", err)
	}
	if next == spent {
		t.Fatal("the spent device was handed to the next client — its stores are the library's deleted ones")
	}
	// THE SPENT OBJECT IS LEFT ALONE: the library may be inside its own delete
	// of it, so the store is cleared through rows read fresh.
	if spent.ID == nil || spent.Deleted {
		t.Error("nextDevice touched the spent device object the library owns")
	}
	if next.ID != nil || next.Deleted {
		t.Errorf("the next device has ID %v and deleted=%t, want a fresh unpaired one", next.ID, next.Deleted)
	}
	// THE SPENT SESSION IS GONE FROM THE STORE, which is what lets the next
	// start find at most one device and resume it.
	if got := storedDevices(t, container); got != before {
		t.Errorf("the store holds %d devices, want %d — the logged-out session is still in it", got, before)
	}
}

func TestADeviceTheLibraryAlreadyDeletedIsReplaced(t *testing.T) {
	ctx := context.Background()
	container := openStore(t)
	jid := pairedDevice(t, container)
	spent, err := container.GetDevice(ctx, jid)
	if err != nil || spent == nil {
		t.Fatalf("reading the paired device back: %v", err)
	}
	// whatsmeow's own delete on the log-out signal.
	if err := spent.Delete(ctx); err != nil {
		t.Fatalf("the library's delete: %v", err)
	}

	next, err := nextDevice(ctx, container, spent, true)
	if err != nil {
		t.Fatalf("choosing the next device: %v", err)
	}
	if next == spent || next.Deleted {
		t.Error("a deleted device was handed to the next client")
	}
}

func TestADeviceThatNeverPairedIsKeptWhenOnlyTheDialFailed(t *testing.T) {
	container := openStore(t)
	if storedDevices(t, container) != 0 {
		t.Skip("this package's store already holds a device")
	}
	unpaired := container.NewDevice()

	next, err := nextDevice(context.Background(), container, unpaired, false)
	if err != nil {
		t.Fatalf("choosing the next device: %v", err)
	}
	if next != unpaired {
		t.Error("a device whose client only failed to dial was replaced — it has no session to lose and its keys are as good as new ones")
	}
}

func TestADeviceWhosePairingSaveFailedIsReplacedByWhatTheStoreHolds(t *testing.T) {
	container := openStore(t)
	if storedDevices(t, container) != 0 {
		t.Skip("this package's store already holds a device")
	}
	// The library gave the device an identity and then could not save it.
	half := container.NewDevice()
	jid := types.JID{User: "15555550178", Server: types.DefaultUserServer, Device: 5}
	half.ID = &jid

	next, err := nextDevice(context.Background(), container, half, false)
	if err != nil {
		t.Fatalf("choosing the next device: %v", err)
	}
	if next == half || next.ID != nil {
		t.Error("the next client was handed an identity the store never saved — every later ask would be refused already_linked")
	}
}

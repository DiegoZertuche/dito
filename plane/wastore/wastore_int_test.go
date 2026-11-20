package wastore_test

import (
	"bytes"
	"context"
	"database/sql"
	"strings"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/types"

	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/wastore"
)

// The whatsmeow session store is plane-internal infrastructure: it lives in
// the shared Postgres next to the seam, but inside its own `whatsmeow`
// schema, library-managed (ticket #21). These tests prove the two contracts
// the plane relies on: a paired device survives a store reopen — the plane
// restart resumes the session without re-scanning — and the store never
// touches the seam's schema. Real Postgres, never mocked (ADR-0028); skips
// loudly when unreachable unless DITO_REQUIRE_DB=1.

func TestPairedDeviceSurvivesStoreReopenWithoutRescan(t *testing.T) {
	dsn := testdb.DSN(t)
	ctx := context.Background()
	// A fictional-range number (555 prefix): no real WhatsApp account can
	// collide with it.
	rig := types.JID{User: "15555550100", Server: types.DefaultUserServer, Device: 3}

	container, err := wastore.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	// Refuse to touch a pre-existing device at this JID rather than upsert
	// over it — the store may be shared with a live rig session.
	if existing, err := container.GetDevice(ctx, rig); err != nil {
		t.Fatalf("checking for a pre-existing device: %v", err)
	} else if existing != nil {
		t.Fatalf("device %s already exists in this store — refusing to modify or delete it; point DITO_TEST_DATABASE_URL at a test database", rig)
	}

	// Construct the state QR pairing leaves behind: a device with its
	// paired JID and account identity, saved to the store.
	device := container.NewDevice()
	device.ID = &rig
	// Sizes per the store's own schema: 64-byte signatures, 32-byte key.
	device.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("test-details"),
		AccountSignature:    bytes.Repeat([]byte{0xA5}, 64),
		AccountSignatureKey: bytes.Repeat([]byte{0x5A}, 32),
		DeviceSignature:     bytes.Repeat([]byte{0xC3}, 64),
	}
	if err := container.PutDevice(ctx, device); err != nil {
		t.Fatalf("saving paired device: %v", err)
	}
	// The constructed device must not linger: the rig's live link may share
	// this store, and a leftover fake pairing would shadow it. Cleanup
	// addresses ONLY the constructed JID — never whatever else the store
	// holds — and runs even when an assertion below fails first.
	t.Cleanup(func() {
		cctx := context.Background()
		c, err := wastore.Open(cctx, dsn)
		if err != nil {
			t.Errorf("reopening store for cleanup: %v", err)
			return
		}
		defer c.Close()
		if d, err := c.GetDevice(cctx, rig); err == nil && d != nil {
			if err := c.DeleteDevice(cctx, d); err != nil {
				t.Errorf("deleting constructed device: %v", err)
			}
		}
	})
	if err := container.Close(); err != nil {
		t.Fatalf("closing first container: %v", err)
	}

	// The plane restart: a fresh open of the same store must yield the same
	// paired identity — no re-scan. Fetched by its exact JID, so a real rig
	// session sharing the store is never touched.
	reopened, err := wastore.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close()
	resumed, err := reopened.GetDevice(ctx, rig)
	if err != nil {
		t.Fatalf("loading device after reopen: %v", err)
	}
	if resumed == nil || resumed.ID == nil {
		t.Fatal("paired device missing after reopen, want the identity preserved")
	}
	if *resumed.ID != rig {
		t.Fatalf("device ID after reopen = %s, want %s", *resumed.ID, rig)
	}
}

func TestWhatsmeowTablesStayOutOfTheSeamSchema(t *testing.T) {
	dsn := testdb.DSN(t)
	ctx := context.Background()

	// Even a DSN that already pins search_path=public must not leak the
	// store into the seam's schema — Open overrides it, never appends.
	hostile := dsn + "&search_path=public"
	if !strings.Contains(dsn, "?") {
		hostile = dsn + "?search_path=public"
	}
	container, err := wastore.Open(ctx, hostile)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer container.Close()

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("connecting to inspect schemas: %v", err)
	}
	defer db.Close()

	var inOwn, inPublic int
	if err := db.QueryRow(
		"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'whatsmeow' AND table_name LIKE 'whatsmeow%'",
	).Scan(&inOwn); err != nil {
		t.Fatalf("counting whatsmeow-schema tables: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'whatsmeow%'",
	).Scan(&inPublic); err != nil {
		t.Fatalf("counting public-schema tables: %v", err)
	}
	if inOwn == 0 {
		t.Fatal("no whatsmeow tables in the whatsmeow schema, want the library store there")
	}
	if inPublic != 0 {
		t.Fatalf("%d whatsmeow tables in the seam's public schema, want 0 — the session store is plane-internal", inPublic)
	}
}

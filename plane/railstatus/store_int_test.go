package railstatus_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// The Postgres seam is the pre-agreed test seam (spec #18): the store writes
// rail_status_events rows and the assertions read what appears on the other
// side, exactly as the twin-side consumer will.

const testTwinID = "5cbe8779-40b1-4e39-8c9e-2f43b3f0f4ab"

func seamDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	if _, err := db.Exec("DELETE FROM rail_status_events WHERE twin_id = $1", testTwinID); err != nil {
		t.Fatalf("clearing test twin rows: %v", err)
	}
	return db
}

type seamRow struct {
	status     string
	detail     string
	occurredAt time.Time
}

func readSeam(t *testing.T, db *sql.DB) []seamRow {
	t.Helper()
	rows, err := db.Query(
		"SELECT status, detail, occurred_at FROM rail_status_events WHERE twin_id = $1 ORDER BY id",
		testTwinID,
	)
	if err != nil {
		t.Fatalf("reading seam: %v", err)
	}
	defer rows.Close()
	var out []seamRow
	for rows.Next() {
		var r seamRow
		if err := rows.Scan(&r.status, &r.detail, &r.occurredAt); err != nil {
			t.Fatalf("scanning seam row: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading seam: %v", err)
	}
	return out
}

func TestStatusOutsideTheClosedSetIsRefusedAtTheSeam(t *testing.T) {
	db := seamDB(t)
	store := railstatus.NewStore(db, testTwinID)

	err := store.Record(context.Background(), railstatus.Event{
		Status:     railstatus.Status("rebooting"),
		OccurredAt: time.Now().UTC(),
	})
	if err == nil {
		t.Fatal("out-of-set status accepted, want refused — the schema's closed set is the contract")
	}
	if got := readSeam(t, db); len(got) != 0 {
		t.Fatalf("seam holds %d rows after refusal, want 0", len(got))
	}
}

func TestRecordWritesTwinScopedRowsInEmissionOrder(t *testing.T) {
	db := seamDB(t)
	store := railstatus.NewStore(db, testTwinID)
	ctx := context.Background()

	occurred := time.Date(2026, 8, 27, 15, 4, 5, 0, time.UTC)
	events := []railstatus.Event{
		{Status: railstatus.StatusQR, Detail: "2@abc123", OccurredAt: occurred},
		{Status: railstatus.StatusLinked, OccurredAt: occurred.Add(20 * time.Second)},
		{Status: railstatus.StatusDropped, OccurredAt: occurred.Add(40 * time.Second)},
		{Status: railstatus.StatusLoggedOut, OccurredAt: occurred.Add(60 * time.Second)},
	}
	for _, e := range events {
		if err := store.Record(ctx, e); err != nil {
			t.Fatalf("Record(%s): %v", e.Status, err)
		}
	}

	got := readSeam(t, db)
	if len(got) != len(events) {
		t.Fatalf("seam holds %d rows, want %d", len(got), len(events))
	}
	for i, e := range events {
		if got[i].status != string(e.Status) {
			t.Fatalf("row %d status = %q, want %q", i, got[i].status, e.Status)
		}
		if got[i].detail != e.Detail {
			t.Fatalf("row %d detail = %q, want %q", i, got[i].detail, e.Detail)
		}
		if !got[i].occurredAt.Equal(e.OccurredAt) {
			t.Fatalf("row %d occurred_at = %s, want %s", i, got[i].occurredAt, e.OccurredAt)
		}
	}
}

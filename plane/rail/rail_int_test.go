package rail_test

import (
	"testing"

	"go.mau.fi/whatsmeow/types/events"

	"github.com/Dito-Core/dito/plane/internal/testdb"
	"github.com/Dito-Core/dito/plane/rail"
	"github.com/Dito-Core/dito/plane/railstatus"
)

// The full half-seam, exactly as the binary wires it: constructed whatsmeow
// events in, twin-stamped rail_status_events rows out on real Postgres
// (spec #18 testing doctrine; ADR-0028).

const intTwinID = "7d1f8f2e-3a54-4b1c-9a77-1c0d3f5b6a02"

func TestConstructedEventsLandAsTwinStampedSeamRows(t *testing.T) {
	dsn := testdb.DSN(t)
	testdb.Migrate(t, dsn)
	db := testdb.Open(t)
	if _, err := db.Exec("DELETE FROM rail_status_events WHERE twin_id = $1", intTwinID); err != nil {
		t.Fatalf("clearing test twin rows: %v", err)
	}

	r := rail.New(railstatus.NewStore(db, intTwinID), nil)
	r.HandleEvent(&events.Connected{})
	r.HandleEvent(&events.Disconnected{})
	r.HandleEvent(&events.Connected{})

	rows, err := db.Query(
		"SELECT status FROM rail_status_events WHERE twin_id = $1 ORDER BY id", intTwinID,
	)
	if err != nil {
		t.Fatalf("reading seam: %v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scanning: %v", err)
		}
		got = append(got, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("reading seam: %v", err)
	}

	want := []string{"linked", "dropped", "linked"}
	if len(got) != len(want) {
		t.Fatalf("seam rows = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("seam rows = %v, want %v", got, want)
		}
	}
}

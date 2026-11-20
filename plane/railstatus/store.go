package railstatus

import (
	"context"
	"database/sql"
)

// Store writes rail_status events to the Postgres seam (ADR-0005). Every row
// is stamped with the twin the linked number belongs to — a config read, the
// plane judges nothing.
type Store struct {
	db     *sql.DB
	twinID string
}

// NewStore builds a seam store recording for the configured twin.
func NewStore(db *sql.DB, twinID string) *Store {
	return &Store{db: db, twinID: twinID}
}

// Record appends one rail_status transition to the seam.
func (s *Store) Record(ctx context.Context, e Event) error {
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO rail_status_events (twin_id, status, detail, occurred_at) VALUES ($1, $2, $3, $4)",
		s.twinID, string(e.Status), e.Detail, e.OccurredAt,
	)
	return err
}

// Package historywindow reads how far back a twin's history may reach
// (ticket #222; spec #214 decision 8; FR-15).
//
// NINETY DAYS IS A PRIMITIVE, NOT A CONSTANT. Spec #214 decision 8 says it in
// as many words — "a product default owned as an ordinary primitive, tunable
// per twin later" — so the number lives in a `history_windows` row seeded at
// provisioning, and the plane reads it with one SELECT at every use. A number
// compiled into the plane cannot be tuned for one twin without a deploy, and a
// number cached in the plane cannot be tuned during a link day at all.
//
// READ AT EVERY USE, never held. That is ADR-0023's rule about guard rules
// applied to the one config value that decides what may rest: this bounds what
// enters twin memory, and a stale copy of it would keep writing history after
// the row that permits it changed.
//
// TWO CALLERS, ONE STORE, and they use it for the two halves of one promise:
// the fill STOPS when a page reaches past the line, and the capture guard does
// not WRITE a row from an on-demand page that is older than it. A stop without
// a filter leaves the crossing page's oldest fifty messages resting behind the
// line; a filter without a stop pages the whole of a chat's history for
// nothing.
//
// TIME IS THE CALLER'S. This package reads no clock — the floor is computed
// from the instant the caller passes, so a test states the moment and neither
// caller can drift into measuring the window from a different one.
package historywindow

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Store reads one twin's history window.
type Store struct {
	db     *sql.DB
	twinID string
}

// New builds a store for the configured twin.
func New(db *sql.DB, twinID string) *Store {
	return &Store{db: db, twinID: twinID}
}

// Days is how many days back this twin's history may reach; ok is false when
// no row says.
//
// NO ROW IS NOT NINETY. A missing row means nobody has said what this twin's
// window is, and the two callers answer that differently and deliberately: the
// fill REFUSES the scope-in by name (`no_history_window`) rather than filling
// to a guess, and the guard drops the on-demand page it cannot bound. Both are
// fail-closed, because the failure the other way is writing history the
// product never promised.
func (s *Store) Days(ctx context.Context) (int, bool, error) {
	var days int
	err := s.db.QueryRowContext(ctx,
		"SELECT days FROM history_windows WHERE twin_id = $1", s.twinID,
	).Scan(&days)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("reading the history window for twin %s: %w", s.twinID, err)
	}
	return days, true, nil
}

// Floor is the oldest instant this twin's history may reach, measured from the
// moment the caller states; ok is false when no row says.
//
// CALENDAR DAYS RATHER THAN A DURATION (`AddDate`, not `now.Add(-24h*n)`): a
// window is a promise a rep reads as «los últimos 90 días», and the two
// answers differ across a daylight-saving change in the rep's own zone.
func (s *Store) Floor(ctx context.Context, now time.Time) (time.Time, bool, error) {
	days, ok, err := s.Days(ctx)
	if err != nil || !ok {
		return time.Time{}, ok, err
	}
	return now.UTC().AddDate(0, 0, -days), true, nil
}

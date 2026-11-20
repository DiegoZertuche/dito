// Package wastore opens the whatsmeow session store — the persisted device
// identity and key material that lets a plane restart resume its session
// without re-scanning (ticket #21).
//
// Home: the shared Postgres next to the seam, inside a dedicated `whatsmeow`
// schema. The store is plane-internal transport credentials (noise/identity
// keys), not rep content — ADR-0008's DEK-encryption scope covers rep
// content from the capture guard onward, and the plane process is already a
// custody point for live session state. The schema split keeps the
// library-managed tables (whatsmeow ships and versions its own migrations)
// out of the Atlas-managed seam schema (ADR-0029).
package wastore

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// SchemaName is the Postgres schema holding the whatsmeow store.
const SchemaName = "whatsmeow"

// Open connects to the shared Postgres at dsn, ensures the dedicated
// whatsmeow schema exists, and returns the upgraded whatsmeow store
// container scoped to it. Close the container when done.
func Open(ctx context.Context, dsn string) (*sqlstore.Container, error) {
	// Mirror image of scripts/migrate.sh, which pins Atlas to
	// search_path=public for the same split: Atlas never sees this schema,
	// this store never sees the seam's. Parsing the DSN and forcing the
	// runtime parameter (rather than appending a query string) overrides
	// any search_path the DSN already carries and accepts keyword-form
	// DSNs, so the store can never land its tables in the seam's schema.
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing whatsmeow store DSN: %w", err)
	}
	if cfg.RuntimeParams == nil {
		cfg.RuntimeParams = map[string]string{}
	}
	cfg.RuntimeParams["search_path"] = SchemaName
	db := stdlib.OpenDB(*cfg)
	if _, err := db.ExecContext(ctx, "CREATE SCHEMA IF NOT EXISTS "+SchemaName); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ensuring whatsmeow schema: %w", err)
	}
	container := sqlstore.NewWithDB(db, "postgres", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		_ = container.Close()
		return nil, fmt.Errorf("upgrading whatsmeow store: %w", err)
	}
	return container, nil
}

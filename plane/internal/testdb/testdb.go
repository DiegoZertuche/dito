// Package testdb connects plane integration tests to the local seam
// Postgres (ADR-0028: real Postgres, never mocked). `pnpm db:up` provides
// it; when unreachable the caller's test SKIPS loudly — never a silent
// pass — unless DITO_REQUIRE_DB=1 turns absence into a failure (CI's
// integration lane sets it). The server is always named by
// DITO_TEST_DATABASE_URL: with it unset the test fails (ticket #305).
//
// A DATABASE PER PACKAGE (ticket #390). `go test ./...` runs packages at
// once, and a package that truncates the seam at setup would empty another's
// rows mid-test. So each test binary gets a database of its own on the named
// server — the base's name, `_go_`, the package's — created empty once per
// process and migrated by the package's own Migrate call through the pinned
// Atlas (ADR-0029), so the plane's suite stands on its own, with or without
// the TypeScript lane's template. Each run drops and recreates it; nothing
// else ever connects to it.
package testdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// errUnset is the refusal for a run that named no test database. No default,
// because the suites truncate and migrate what they are given, and the
// obvious default on a developer machine is a database something else uses.
var errUnset = errors.New("DITO_TEST_DATABASE_URL is unset — point it at a test database this run may reset; the test helpers have no default")

// maxDatabaseName is the longest identifier Postgres keeps whole.
const maxDatabaseName = 63

// dsnFrom answers the test database DSN the environment names, or errUnset.
func dsnFrom(getenv func(string) string) (string, error) {
	dsn := getenv("DITO_TEST_DATABASE_URL")
	if dsn == "" {
		return "", errUnset
	}
	return dsn, nil
}

var nonIdentifier = regexp.MustCompile(`[^a-z0-9]+`)

// packageDatabaseName is the database a test binary runs on: the base's
// name, `_go_`, and the binary's package (`go test` names it `<pkg>.test`).
func packageDatabaseName(baseName, binary string) (string, error) {
	pkg := strings.TrimSuffix(filepath.Base(binary), ".test")
	pkg = strings.Trim(nonIdentifier.ReplaceAllString(strings.ToLower(pkg), "_"), "_")
	name := baseName + "_go_" + pkg
	if len(name) > maxDatabaseName {
		return "", fmt.Errorf("test database name %q is %d characters; Postgres keeps %d — shorten the base", name, len(name), maxDatabaseName)
	}
	return name, nil
}

// withDatabase answers dsn with its database replaced by name.
func withDatabase(dsn, name string) (string, error) {
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.Scheme == "" {
		return "", fmt.Errorf("DITO_TEST_DATABASE_URL must be a postgres:// URL: %v", err)
	}
	parsed.Path = "/" + name
	return parsed.String(), nil
}

// resettable is the guard on every drop: only a database whose name says
// "test" may be replaced, unless DITO_ALLOW_DB_RESET=1.
func resettable(name string, getenv func(string) string) error {
	if !strings.Contains(strings.ToLower(name), "test") && getenv("DITO_ALLOW_DB_RESET") != "1" {
		return fmt.Errorf("refusing to reset non-test database %q (set DITO_ALLOW_DB_RESET=1 to override)", name)
	}
	return nil
}

var (
	created    sync.Once
	packageDSN string
	createErr  error
	unreached  bool
)

// createPackageDatabase drops and recreates this binary's database from a
// session on the server's `postgres` database — a database cannot be
// dropped from a session on itself.
func createPackageDatabase(base string) {
	parsed, err := url.Parse(base)
	if err != nil {
		createErr = fmt.Errorf("DITO_TEST_DATABASE_URL must be a postgres:// URL: %v", err)
		return
	}
	name, err := packageDatabaseName(strings.TrimPrefix(parsed.Path, "/"), os.Args[0])
	if err != nil {
		createErr = err
		return
	}
	if err := resettable(name, os.Getenv); err != nil {
		createErr = err
		return
	}
	maintenance, err := withDatabase(base, "postgres")
	if err != nil {
		createErr = err
		return
	}
	admin, err := sql.Open("pgx", maintenance)
	if err == nil {
		err = admin.Ping()
	}
	if err != nil {
		unreached = true
		createErr = err
		if admin != nil {
			_ = admin.Close()
		}
		return
	}
	defer admin.Close()
	quoted := `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
	if _, err := admin.Exec("DROP DATABASE IF EXISTS " + quoted + " WITH (FORCE)"); err != nil {
		createErr = fmt.Errorf("dropping %s: %v", name, err)
		return
	}
	if _, err := admin.Exec("CREATE DATABASE " + quoted); err != nil {
		createErr = fmt.Errorf("creating %s: %v", name, err)
		return
	}
	packageDSN, createErr = withDatabase(base, name)
}

// DSN returns this package's test database DSN, failing when none is named
// and skipping (or failing under DITO_REQUIRE_DB=1) when the server is
// unreachable.
func DSN(t *testing.T) string {
	t.Helper()
	base, err := dsnFrom(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	created.Do(func() { createPackageDatabase(base) })
	if unreached {
		if os.Getenv("DITO_REQUIRE_DB") == "1" {
			t.Fatalf("DITO_REQUIRE_DB=1 but Postgres is unreachable: %v", createErr)
		}
		t.Skipf("SKIPPED, not passed: Postgres unreachable (%v) — run `pnpm db:up` (ADR-0028: never mocked)", createErr)
	}
	if createErr != nil {
		t.Fatal(createErr)
	}
	return packageDSN
}

// Open returns an open connection to the test database, closed at test end.
func Open(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", DSN(t))
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// The role lock's advisory class and keys, the same three numbers the
// TypeScript lane's `packages/seam/src/testing/role-lock.ts` spells: USE,
// taken shared, and WRITE.
const (
	lockClass = 390
	lockUse   = 1
	lockWrite = 2
)

// Migrate applies the repo's seam migrations to dsn via the pinned Atlas
// (ADR-0029) — never hand-created DDL that could drift.
//
// UNDER THE ROLE LOCK: the migrations write cluster-global roles, and
// packages migrate their databases at once, so two `ALTER ROLE`s on one
// role would fail as "tuple concurrently updated". The lock lives on the
// server's `postgres` database, where every lane on the server takes it.
func Migrate(t *testing.T, dsn string) {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locating repo root")
	}
	root := filepath.Join(filepath.Dir(self), "..", "..", "..")
	maintenance, err := withDatabase(dsn, "postgres")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := sql.Open("pgx", maintenance)
	if err != nil {
		t.Fatalf("opening the lock session: %v", err)
	}
	defer admin.Close()
	ctx := context.Background()
	conn, err := admin.Conn(ctx)
	if err != nil {
		t.Fatalf("opening the lock session: %v", err)
	}
	// Closing the session releases both locks, whatever happened between.
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock_shared($1, $2)", lockClass, lockUse); err != nil {
		t.Fatalf("taking the role lock: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock($1, $2)", lockClass, lockWrite); err != nil {
		t.Fatalf("taking the role lock: %v", err)
	}
	out, err := exec.Command(filepath.Join(root, "scripts", "migrate.sh"), dsn).CombinedOutput()
	if err != nil {
		t.Fatalf("migrate.sh failed: %v\n%s", err, out)
	}
}

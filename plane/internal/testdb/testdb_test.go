package testdb

import (
	"strings"
	"testing"
)

func TestDSNRefusesAnUnsetVariable(t *testing.T) {
	_, err := dsnFrom(func(string) string { return "" })
	if err == nil || !strings.Contains(err.Error(), "DITO_TEST_DATABASE_URL") {
		t.Fatalf("want a refusal naming DITO_TEST_DATABASE_URL, got %v", err)
	}
}

func TestDSNAnswersTheNamedDatabase(t *testing.T) {
	const named = "postgres://dito:dito@localhost:5433/dito_9_go_test?sslmode=disable"
	got, err := dsnFrom(func(key string) string {
		if key == "DITO_TEST_DATABASE_URL" {
			return named
		}
		return ""
	})
	if err != nil || got != named {
		t.Fatalf("want %q, got %q (%v)", named, got, err)
	}
}

func TestPackageDatabaseIsTheBaseThenThePackage(t *testing.T) {
	got, err := packageDatabaseName("dito_9_go_test", "/tmp/go-build1/b001/railstatus.test")
	if err != nil || got != "dito_9_go_test_go_railstatus" {
		t.Fatalf("want dito_9_go_test_go_railstatus, got %q (%v)", got, err)
	}
}

func TestPackageDatabaseRefusesANameTooLongToKeep(t *testing.T) {
	_, err := packageDatabaseName(strings.Repeat("d", 60)+"_test", "ingest.test")
	if err == nil || !strings.Contains(err.Error(), "63") {
		t.Fatalf("want a refusal naming the 63-character limit, got %v", err)
	}
}

func TestOnlyATestDatabaseMayBeReset(t *testing.T) {
	none := func(string) string { return "" }
	if err := resettable("dito_rig_go_ingest", none); err == nil {
		t.Fatal("want a refusal for a database whose name does not say test")
	}
	if err := resettable("dito_test_go_ingest", none); err != nil {
		t.Fatalf("want a test database accepted, got %v", err)
	}
	allow := func(key string) string {
		if key == "DITO_ALLOW_DB_RESET" {
			return "1"
		}
		return ""
	}
	if err := resettable("dito_rig_go_ingest", allow); err != nil {
		t.Fatalf("want the override honoured, got %v", err)
	}
}

func TestWithDatabaseKeepsServerAndCredentials(t *testing.T) {
	got, err := withDatabase("postgres://dito:dito@localhost:5433/dito_test?sslmode=disable", "postgres")
	if err != nil || got != "postgres://dito:dito@localhost:5433/postgres?sslmode=disable" {
		t.Fatalf("got %q (%v)", got, err)
	}
}

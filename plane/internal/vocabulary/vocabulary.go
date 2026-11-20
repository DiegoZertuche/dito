// Package vocabulary reads a named CHECK constraint's value list out of
// `db/migrations` (ticket #222).
//
// WHY THE PLANE READS SQL AT ALL. Three of the plane's own closed sets — the
// rail's statuses and the request seam's kinds, outcomes, reasons and stops —
// have a copy in Go, a copy in `@dito/seam` and a copy in a migration's CHECK.
// `migration-vocabulary.test.ts` compares the last two; nothing compared the
// Go copy against either, and a word the plane WRITES that the store REFUSES
// is a constraint violation on a real rail transition or on a request that has
// already paged a chat's history.
//
// ONE READER, TWO CALLERS. `plane/railstatus` and `plane/planereq` each pin
// their own sets against the store, and a copy of this parser in each is how
// the two come to disagree about which cut stands.
//
// TEST PLUMBING, in `internal/` beside `testdb` and `testkms` for the same
// reason: it reads the repository's own files and belongs to no binary.
package vocabulary

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// commentLine strips SQL comments before the value list is read. A `--` line
// inside one may carry parentheses of its own («(ADR-0020)»), and a scan that
// stopped at the first `)` would read a TRUNCATED set and then certify it as
// the whole vocabulary — the TS sweep's own reason for doing this first.
var commentLine = regexp.MustCompile(`--[^\n]*`)

// literal matches one quoted value inside a list.
var literal = regexp.MustCompile(`'([^']*)'`)

// CheckSet is the value list the named constraint is given by the LAST
// migration that cuts it — the definition that stands once they have all
// applied, which is the rule `migration-vocabulary.test.ts` reads by.
//
// `ADD` IS OPTIONAL, because a closed set is born inline inside its
// `CREATE TABLE` and only a later cut says `ADD` — matching only the second
// shape would leave a constraint's FIRST cut invisible. It fails the test
// rather than returning empty when no migration defines the constraint under
// that name: a name nothing defines would sweep zero cuts and report green,
// which is the vacuous pass this exists to refuse (ADR-0028 doctrine).
func CheckSet(t *testing.T, migrations, constraint string) []string {
	t.Helper()
	entries, err := os.ReadDir(migrations)
	if err != nil {
		t.Fatalf("reading %s: %v", migrations, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	// Migrations apply in filename order, which is the order a value rides
	// forward through.
	sort.Strings(names)
	pattern := regexp.MustCompile(
		`(?is)(?:ADD\s+)?CONSTRAINT\s+` + regexp.QuoteMeta(constraint) + `\s+CHECK\s*\([^)]*IN\s*\(([^)]*)\)`)
	var latest []string
	for _, name := range names {
		sql, err := os.ReadFile(filepath.Join(migrations, name))
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		for _, match := range pattern.FindAllStringSubmatch(commentLine.ReplaceAllString(string(sql), ""), -1) {
			set := []string{}
			for _, value := range literal.FindAllStringSubmatch(match[1], -1) {
				set = append(set, value[1])
			}
			latest = set
		}
	}
	if len(latest) == 0 {
		t.Fatalf("no migration defines %s under that name — the sweep found nothing to compare, which is not a pass", constraint)
	}
	return latest
}

// Dir is `db/migrations` as a path from the caller's own file, so a package
// that moves does not have to count `..`s.
func Dir(callerFile string) string {
	return filepath.Join(filepath.Dir(callerFile), "..", "..", "db", "migrations")
}

// Same reports whether two vocabularies have the same MEMBERSHIP; the order a
// migration lists them in is cosmetic.
func Same(a, b []string) bool {
	left, right := append([]string(nil), a...), append([]string(nil), b...)
	sort.Strings(left)
	sort.Strings(right)
	return strings.Join(left, ",") == strings.Join(right, ",")
}

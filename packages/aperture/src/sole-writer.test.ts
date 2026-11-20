/**
 * The source-scan invariant behind ADR-0016 (ticket #50), in the shape of
 * the plane's sole-sender scan: **no reader anywhere selects from a Ledger
 * table where a view exists.**
 *
 * The shadow filter lives inside the finalized-view definitions, so a
 * reader that reaches a base table skips the launch gate entirely — and
 * worse, it is the thing that turns slice 4's flag flip from a `WHERE`
 * clause into a pipeline rebuild. The grant audit enforces this for the
 * `dito_twin_runtime` role at the database; this scan enforces it for
 * every line of source in the repository, including the ones that run as
 * the schema owner and would therefore succeed.
 *
 * The rule: outside `packages/aperture` (the single writer) and
 * `db/migrations` (where the objects are defined), the only `ledger.`
 * identifier that may appear in source is a finalized view. Views are
 * named `finalized_*` by convention precisely so this scan can be exact
 * rather than fuzzy.
 *
 * The exemption for `packages/aperture` is recorded, not incidental. Spec
 * #48's testing decisions say no test reads a `ledger` table directly
 * "where a view exists" — and every row this slice files is SHADOW, so
 * the views are correctly empty and cannot answer "did anything cross at
 * all?". The writer's own read surface (`reads.ts`) answers that instead,
 * and it lives inside this package for the same reason the writes do:
 * every statement naming a Ledger table is in one directory, so slice 4's
 * flag flip stays a `WHERE` clause in a view. Tests outside this package
 * go through that surface — see crossing.int.test.ts.
 *
 * Runs in the unit lane: no database, and a new file is covered the moment
 * it exists.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Where Ledger objects may be named directly. */
const WRITER_PATHS = [
  join("packages", "aperture"),
  join("db", "migrations"),
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".tools",
  "rig-data",
  ".claude",
  // Build output, and the one entry that is not merely noise (#129):
  // `next build` inlines `@dito/aperture` into its server chunks, so
  // `.next/` holds a copy of THIS PACKAGE's Ledger SQL under a path this
  // scan would read as a second writer. `dist/` is skipped for the same
  // reason and has been since this scan was written.
  ".next",
  // Agent scratch: ticket bodies and specs, never committed.
  ".scratch",
]);

const SCANNED_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".go", ".sql"];

/** `ledger.<identifier>` anywhere in a scanned file. */
const LEDGER_REFERENCE = /\bledger\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** The convention that makes the scan exact: every readable Ledger object is a finalized view. */
const FINALIZED_VIEW = /^finalized_/;

interface Reference {
  readonly file: string;
  readonly object: string;
  readonly line: number;
}

/** The rule itself, over one file's text — so it can be shown to bite. */
function offendingReferences(file: string, source: string): Reference[] {
  const found: Reference[] = [];
  source.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(LEDGER_REFERENCE)) {
      const object = match[1]!;
      if (FINALIZED_VIEW.test(object)) continue;
      found.push({ file, object, line: index + 1 });
    }
  });
  return found;
}

function scan(): Reference[] {
  const found: Reference[] = [];
  walk(REPO_ROOT, (absolute) => {
    const rel = relative(REPO_ROOT, absolute);
    if (WRITER_PATHS.some((p) => rel === p || rel.startsWith(p + sep))) return;
    if (!SCANNED_EXTENSIONS.some((ext) => absolute.endsWith(ext))) return;
    found.push(...offendingReferences(rel, readFileSync(absolute, "utf8")));
  });
  return found;
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) walk(absolute, visit);
    else if (stats.isFile()) visit(absolute);
  }
}

describe("the aperture is the sole writer, and the views are the sole reader surface (ADR-0003, ADR-0016)", () => {
  it("names no Ledger table outside the aperture and the migrations", () => {
    expect(
      scan().map((v) => `${v.file}:${v.line} names ledger.${v.object}`),
    ).toEqual([]);
  });

  it("catches a reader that reaches a fact table, and lets a finalized view through", () => {
    // The planted violation: proof the green above is a result, not a
    // regex that matches nothing.
    expect(
      offendingReferences(
        "reader.ts",
        [
          'const rows = await db.query("SELECT * FROM ledger.finalized_facts");',
          'const sneaky = await db.query("SELECT * FROM ledger.facts");',
        ].join("\n"),
      ),
    ).toEqual([{ file: "reader.ts", object: "facts", line: 2 }]);
  });

  it("scans something — an empty sweep is not a pass", () => {
    // The scan is only worth its green if it is actually reading the tree.
    // A misresolved repo root or a swallowed walk error would otherwise
    // report zero violations over zero files (ADR-0028 doctrine).
    let files = 0;
    walk(REPO_ROOT, (absolute) => {
      if (SCANNED_EXTENSIONS.some((ext) => absolute.endsWith(ext))) files += 1;
    });
    expect(files).toBeGreaterThan(50);
  });
});

/**
 * EVERY STAMP AN EXECUTION WRITES IS THE WRITE INSTANT (#200 hotfix 1;
 * …20260906100040).
 *
 * A stamp defaulted to `now()` is the TRANSACTION's start, and an execution's
 * transaction is older than its filing statements by every model round-trip
 * it made. The migration's header argues the whole of it, the rig's numbers
 * included; three sweeps hold it here.
 *
 * 1. **What the live schema will write, mid-transaction, for every in-scope
 *    column.** The transaction is held open past a `pg_sleep`, then each
 *    column's LIVE default is evaluated: `now()` returns the transaction's
 *    start and fails, `clock_timestamp()` returns the statement's and passes.
 *    Table-driven over `EXECUTION_STAMPS`, so the scope list IS the test.
 * 2. **A real row for the four in-scope tables that need no fixture graph.**
 *    Evaluating a default proves what the expression yields; inserting proves
 *    the column actually takes it. The other nine sit behind chains of foreign
 *    keys whose fixtures would be the thing under test, and sweep 1 already
 *    asks the live schema about all thirteen.
 * 3. **The structural pin**, a sibling of `binding-wall.test.ts`: the LATEST
 *    default each in-scope column is declared with across `db/migrations` is
 *    `clock_timestamp()`, so a later migration cannot restore `now()` in
 *    silence. It proves it can catch its violation before certifying the tree.
 *
 * SWEEP 3 READS THE FILESYSTEM AND NOT THE DATABASE, and lives here anyway so
 * that one scope list serves all three: a second copy of `EXECUTION_STAMPS`
 * in the unit lane is exactly the drift the pin exists to catch, and CI runs
 * both lanes on every push.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { resetAndMigrate, withClient } from "./testing/db.js";

const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/migrations",
);

interface StampColumn {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

/**
 * THE SCOPE RULE, ENUMERATED: a column is here when a REP-SIDE EXECUTION
 * writes its row inside the execution's transaction (#200 hotfix 1, and the
 * migration's header carries the exclusions and their reasons).
 *
 * Read it as the list the fix is about rather than as every stamp in the
 * schema — the sequential loop's rows, the seam's ingest, the config tables,
 * the break-glass merge scripts and the whole `owner` schema keep `now()` on
 * purpose, and sweep 3 says nothing about them.
 */
const EXECUTION_STAMPS: readonly StampColumn[] = [
  // The Ledger: what the crossing filed, and when the correction window on
  // it opens (ADR-0004).
  { schema: "ledger", table: "facts", column: "filed_at" },
  { schema: "ledger", table: "entities", column: "filed_at" },
  { schema: "ledger", table: "entity_grants", column: "granted_at" },
  // The chain: `created_at` is the append instant or it is nothing (ADR-0020).
  { schema: "public", table: "audit_chain", column: "created_at" },
  // The rep's thread, as the execution wrote it. `disclosure_posts.posted_at`
  // is NOT here and the migration's header argues it: the seal trigger admits
  // a line only while `posted_at = now()`, so that column's `now()` is how the
  // store says "one transaction wrote the post and its numbering" (ADR-0034),
  // and moving it would leave every disclosure post with no lines.
  { schema: "public", table: "notices", column: "created_at" },
  // The post the notice or the draft above it delivers (ticket #220). Its
  // stamp is what the feed orders by, so two posts of one transaction — a
  // draft and its binding question — must not share one: they would fall back
  // to comparing random uuids, and the rep's Inicio would show the ceremony
  // above the draft it followed.
  { schema: "public", table: "posts", column: "posted_at" },
  { schema: "public", table: "disclosure_attempts", column: "attempted_at" },
  // The disclosure's lines. Two stamps left this list at #218 with the
  // stores that held them — `question_posts.posted_at` and
  // `aperture_questions.asked_at`, the second of which #200's hotfix 1 had
  // moved onto a materialized `clock_timestamp()` beside FR-32's window.
  { schema: "public", table: "disclosure_lines", column: "filed_at" },
  // The run row, so its span is its span.
  { schema: "public", table: "extraction_runs", column: "started_at" },
  // What a drafting or a thread execution wrote.
  { schema: "public", table: "drafts", column: "created_at" },
  { schema: "public", table: "draft_dismissals", column: "created_at" },
  { schema: "public", table: "fact_retractions", column: "filed_at" },
];

/**
 * How long the probe transaction is held before it writes, and the gap a
 * statement-clock stamp must therefore show.
 *
 * The margin is below the hold rather than equal to it: `pg_sleep` guarantees
 * AT LEAST its argument, and the assertion has to survive a scheduler that
 * gives back a millisecond less than the wall clock suggests. Under `now()`
 * the gap is zero however long the hold is, so nothing about the red depends
 * on the margin's size.
 */
const HELD_SECONDS = 0.3;
const REQUIRED_SKEW_MS = 250;

/** `<schema>.<table>.<column>`, the key every sweep here agrees on. */
function nameOf(stamp: StampColumn): string {
  return `${stamp.schema}.${stamp.table}.${stamp.column}`;
}

/**
 * The default expression the LIVE catalog holds for one column — the thing a
 * row inserted right now would actually take.
 *
 * Read from `pg_attrdef` rather than restated here, which is what makes sweep
 * 1 a question about the migrated schema instead of about this file.
 */
async function liveDefault(
  db: pg.ClientBase,
  stamp: StampColumn,
): Promise<string> {
  const res = await db.query<{ expr: string }>(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
       FROM pg_attrdef d
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       JOIN pg_class c ON c.oid = d.adrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3`,
    [stamp.schema, stamp.table, stamp.column],
  );
  const expr = res.rows[0]?.expr;
  expect(expr, `${nameOf(stamp)} has no column default in the live schema`).
    toBeTypeOf("string");
  return expr!;
}

beforeAll(async () => {
  await resetAndMigrate();
});

describe("stamps written inside an execution's transaction (#200 hotfix 1)", () => {
  it("every in-scope column's live default is the statement's clock, not the transaction's start", async () => {
    await withClient(async (db) => {
      await db.query("BEGIN");
      try {
        // The transaction is now measurably older than any statement that
        // follows it — the shape an execution's own transaction has by the
        // time its filing statements run, only compressed.
        await db.query(`SELECT pg_sleep(${String(HELD_SECONDS)})`);
        for (const stamp of EXECUTION_STAMPS) {
          const expr = await liveDefault(db, stamp);
          const probe = await db.query<{ skew_ms: string }>(
            `SELECT (EXTRACT(EPOCH FROM ((${expr}) - transaction_timestamp()))
                     * 1000)::bigint AS skew_ms`,
          );
          expect(
            Number(probe.rows[0]!.skew_ms),
            `${nameOf(stamp)} defaults to ${expr}, which is the transaction's start`,
          ).toBeGreaterThanOrEqual(REQUIRED_SKEW_MS);
        }
      } finally {
        await db.query("ROLLBACK");
      }
    });
  });

  it("a real row takes the write instant: the chain entry, the twin post, the draft and the run", async () => {
    await withClient(async (db) => {
      const twinId = "11111111-1111-1111-1111-111111111111";
      await db.query("BEGIN");
      try {
        await db.query(`SELECT pg_sleep(${String(HELD_SECONDS)})`);
        // Four inserts that need nothing but their own NOT NULLs: the four
        // in-scope tables whose foreign keys are all nullable. Each relies on
        // the column default and on nothing this file passes in.
        const written = await db.query<{ stamp_of: string; skew_ms: string }>(
          `WITH chained AS (
             INSERT INTO audit_chain (caller, action, ref, outcome, entry_hash)
             VALUES ('execution', 'execution', 'ref:200', 'filed', '\\x00'::bytea)
             RETURNING 'public.audit_chain.created_at' AS stamp_of, created_at AS stamp
           ), posted AS (
             INSERT INTO notices (twin_id, kind, content_enc)
             VALUES ($1, 'daily_disclosure', '\\x00'::bytea)
             RETURNING 'public.notices.created_at' AS stamp_of, created_at AS stamp
           ), drafted AS (
             INSERT INTO drafts (twin_id, destination, content_enc)
             VALUES ($1, 'probe', '\\x00'::bytea)
             RETURNING 'public.drafts.created_at' AS stamp_of, created_at AS stamp
           ), claimed AS (
             INSERT INTO extraction_runs
               (twin_id, chat_jid, extraction_day, state, window_start, window_end)
             VALUES ($1, 'probe', DATE '2026-09-06', 'submitted',
                     TIMESTAMPTZ '2026-09-06T06:00:00Z',
                     TIMESTAMPTZ '2026-09-07T06:00:00Z')
             RETURNING 'public.extraction_runs.started_at' AS stamp_of, started_at AS stamp
           )
           SELECT stamp_of,
                  (EXTRACT(EPOCH FROM (stamp - transaction_timestamp()))
                   * 1000)::bigint AS skew_ms
             FROM chained
            UNION ALL SELECT stamp_of, (EXTRACT(EPOCH FROM (stamp - transaction_timestamp())) * 1000)::bigint FROM posted
            UNION ALL SELECT stamp_of, (EXTRACT(EPOCH FROM (stamp - transaction_timestamp())) * 1000)::bigint FROM drafted
            UNION ALL SELECT stamp_of, (EXTRACT(EPOCH FROM (stamp - transaction_timestamp())) * 1000)::bigint FROM claimed`,
          [twinId],
        );
        expect(written.rows).toHaveLength(4);
        for (const row of written.rows) {
          expect(
            Number(row.skew_ms),
            `${row.stamp_of} recorded the transaction's start on a real insert`,
          ).toBeGreaterThanOrEqual(REQUIRED_SKEW_MS);
        }
      } finally {
        // The probe rows are the point of the transaction and none of them is
        // the corpus's business — `audit_chain` is append-only besides, so a
        // committed probe entry would break the next chain append's tail.
        await db.query("ROLLBACK");
      }
    });
  });

  it("keeps `disclosure_posts.posted_at` on the transaction's clock, because the seal reads it as one (ADR-0034)", async () => {
    await withClient(async (db) => {
      // The one column the scope rule reaches that the fix leaves alone, and
      // the two halves of the reason are pinned TOGETHER: the trigger admits a
      // line only while the post's stamp equals `now()`, which is how ADR-0034
      // says "one transaction wrote the post and its numbering". Re-cut either
      // half alone and every disclosure post loses its lines. Giving the seal
      // another way to say it is open on the horizon (#117).
      expect(
        await liveDefault(db, {
          schema: "public",
          table: "disclosure_posts",
          column: "posted_at",
        }),
      ).toBe("now()");
      const seal = await db.query<{ body: string }>(
        "SELECT pg_get_functiondef(oid) AS body FROM pg_proc WHERE proname = 'disclosure_post_lines_sealed'",
      );
      expect(seal.rows[0]!.body).toContain("p.posted_at = now()");
    });
  });

  it("the migrations declare no in-scope stamp as `now()` — a later one cannot restore it in silence", () => {
    const declared = declaredStampDefaults();
    for (const stamp of EXECUTION_STAMPS) {
      const latest = declared.get(nameOf(stamp));
      expect(
        latest,
        `${nameOf(stamp)} is in scope but no migration declares a default for it — the sweep is reading the wrong name`,
      ).toBeDefined();
      expect(
        latest!.expr,
        `${latest!.file} leaves ${nameOf(stamp)} defaulting to the TRANSACTION's start, which an execution begins before its model calls (#200 hotfix 1)`,
      ).toMatch(/clock_timestamp\(\)/i);
    }
  });

  it("the sweep can catch its violation: a re-cut back to `now()` fails, and one to the statement clock passes", () => {
    const table = "public.notices.created_at";
    expect(
      parseStampDefaults(
        "ALTER TABLE notices ALTER COLUMN created_at SET DEFAULT now();",
      ).get(table),
    ).toEqual({ expr: "now()" });
    expect(
      parseStampDefaults(
        "ALTER TABLE notices ALTER COLUMN created_at SET DEFAULT clock_timestamp();",
      ).get(table),
    ).toEqual({ expr: "clock_timestamp()" });
    // A CREATE TABLE's own column line is the other shape every stamp here
    // was born in, and a bare table name means the `public` schema.
    expect(
      parseStampDefaults(
        "CREATE TABLE notices (\n    created_at timestamptz NOT NULL DEFAULT now(),\n);",
      ).get(table),
    ).toEqual({ expr: "now()" });
    // ...while a qualified one is attributed to ITS schema and to no other,
    // which is what keeps the owner side's identically named column out of a
    // sweep that says nothing about it.
    const ownerSide = parseStampDefaults(
      "CREATE TABLE owner.audit_chain (\n    created_at timestamptz NOT NULL DEFAULT now()\n);",
    );
    expect(ownerSide.get("owner.audit_chain.created_at")).toEqual({
      expr: "now()",
    });
    expect(ownerSide.get("public.audit_chain.created_at")).toBeUndefined();
  });
});

/**
 * The LAST default every stamp column is declared with across `db/migrations`,
 * in filename order — which is the order Atlas applies them, so the last
 * declaration is the live one.
 */
function declaredStampDefaults(): Map<string, { file: string; expr: string }> {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(files.length).toBeGreaterThan(20);
  const latest = new Map<string, { file: string; expr: string }>();
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const [column, declaration] of parseStampDefaults(sql)) {
      latest.set(column, { file, expr: declaration.expr });
    }
  }
  return latest;
}

/**
 * Every `timestamptz` default one migration declares, keyed
 * `<schema>.<table>.<column>`.
 *
 * LINE BY LINE, TRACKING THE TABLE IN HAND, because the same column name
 * lives on several tables — `filed_at` on the Ledger's facts, its entities and
 * the disclosure lines; `created_at` on the rep's chain and the OWNER's — so a
 * pattern that read columns alone would attribute a default to the wrong
 * table and could exempt the wrong one. Both shapes a default arrives in are
 * read: a `CREATE TABLE` column line, and a later `SET DEFAULT`.
 */
function parseStampDefaults(sql: string): Map<string, { expr: string }> {
  const found = new Map<string, { expr: string }>();
  let table: string | undefined;
  for (const raw of sql.split("\n")) {
    // Comments carry the argument, never the schema.
    const line = raw.replace(/--.*$/, "");
    const named = /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/i.exec(line);
    if (named !== null) table = qualified(named[1]!);
    const recut =
      /\bALTER\s+COLUMN\s+(\w+)\s+SET\s+DEFAULT\s+([^;]+);/i.exec(line);
    if (recut !== null && table !== undefined) {
      found.set(`${table}.${recut[1]!}`, { expr: recut[2]!.trim() });
      continue;
    }
    const born =
      /^\s*(\w+)\s+timestamptz\b[^,]*?\bDEFAULT\s+([^,]+?),?\s*$/i.exec(line);
    if (born !== null && table !== undefined) {
      found.set(`${table}.${born[1]!}`, { expr: born[2]!.trim() });
    }
  }
  return found;
}

/** `public` is the schema a bare table name means, in SQL and in this sweep. */
function qualified(name: string): string {
  return name.includes(".") ? name : `public.${name}`;
}

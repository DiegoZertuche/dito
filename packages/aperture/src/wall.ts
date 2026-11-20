/**
 * The wall, checked on the Ledger's own content (ticket #50; ADR-0004):
 * **no chat identity ever crosses.** Owner-visible provenance is
 * timestamp, confidence and source type — never which chat a fact came
 * from, and never a WhatsApp address of any kind.
 *
 * The structural half of this rule already exists: `binding-wall.test.ts`
 * proves no migration DEFINES a chat-shaped column. This is the other
 * half, and the one a migration cannot promise — that no row VALUE carries
 * a JID either, however it got there. It sweeps every text-ish column in
 * the `ledger` schema for WhatsApp's address shapes, so a fact payload
 * that quietly starts embedding a sender, or a display name filled from a
 * JID because a push-name was missing, fails an audit rather than
 * reaching an owner.
 *
 * Content-free by construction: the sweep asks the database for COUNTS of
 * matching rows and never reads a value back. It is custody tooling, not a
 * Ledger reader.
 *
 * Scope, stated so it is not mistaken for more than it is: this is DEFENCE
 * IN DEPTH over row values. The primary guard is structural — no migration
 * defines a chat-shaped column at all (binding-wall.test.ts) — and the
 * complete guard for fact payloads is a per-`(fact_type, payload_version)`
 * schema, which belongs with the extraction that first writes one. A
 * chat-derived identifier that is neither a WhatsApp address nor a
 * declared column would pass here.
 */
import pg from "pg";

export interface LedgerWallViolation {
  /** "column:<schema>.<table>.<column>". */
  readonly subject: string;
  readonly reason: string;
}

export interface LedgerWallReport {
  /** Columns examined. */
  readonly columnsChecked: number;
  /**
   * Rows that have actually crossed (entities + facts). A green sweep over
   * an empty Ledger proves nothing about content, so the caller can refuse
   * to treat it as a pass (ADR-0028 doctrine).
   */
  readonly crossedRows: number;
  readonly violations: readonly LedgerWallViolation[];
}

/**
 * WhatsApp's address shapes: user (`@s.whatsapp.net`), group (`@g.us`),
 * broadcast (`@broadcast`) and the LID addressing the plane canonicalizes
 * away (`@lid`). Matched as substrings, so an address embedded in prose or
 * in a JSON payload is caught as readily as one sitting in a column.
 */
const JID_SUFFIXES = [
  "@s.whatsapp.net",
  "@g.us",
  "@lid",
  "@broadcast",
] as const;

/**
 * The `public` tables this sweep covers besides the Ledger (ticket #127):
 * the ones an owner can read through a granted view. Only the TABLE is
 * listed — `seats_status` projects `rep_display_name` unchanged, and
 * sweeping both would report one violation twice and name the derived
 * object as the place the value lives.
 */
const OWNER_VISIBLE_REGISTRY_TABLES = ["seats"] as const;

/** Sweeps the Ledger for chat identity. */
export async function auditLedgerWall(
  client: pg.ClientBase,
): Promise<LedgerWallReport> {
  // pg_catalog, not information_schema: the SQL-standard views only show
  // what the CURRENT USER holds a privilege on, so a restricted caller
  // would sweep a subset and report green over the column it missed.
  const columns = await client.query<{
    schema_name: string;
    table_name: string;
    column_name: string;
    is_table: boolean;
  }>(
    `SELECT n.nspname AS schema_name, c.relname AS table_name,
            a.attname AS column_name,
            (c.relkind = 'r') AS is_table
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE (
              n.nspname = 'ledger'
              -- ...AND THE OWNER-VISIBLE REGISTRY (ticket #127). The wall is
              -- about what an OWNER can read, and since ADR-0004's
              -- amendment that is no longer only the Ledger: a seat's
              -- display name is projected through seats_status and sits
              -- beside every fact that seat filed. It is also the one
              -- free-text value on the owner's side that a PERSON types, so
              -- a rep registered from a JID because a name was missing is
              -- exactly the failure this sweep exists to catch — the same
              -- failure the entity display name had in slice 3. The store
              -- refuses the shape too (the …100010 CHECK); this is the half a
              -- constraint cannot promise, over rows written before it.
              OR (n.nspname = 'public' AND c.relname = ANY($1::text[]))
            )
        -- Tables AND views: a view is what a reader actually sees, and a
        -- computed column could carry an address the base table does not.
        AND c.relkind IN ('r', 'v', 'm')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND t.typname IN ('text', 'varchar', 'bpchar', 'json', 'jsonb')
      ORDER BY 1, 2, 3`,
    [[...OWNER_VISIBLE_REGISTRY_TABLES]],
  );

  const violations: LedgerWallViolation[] = [];
  if (columns.rows.length === 0) {
    return {
      columnsChecked: 0,
      crossedRows: 0,
      violations: [
        {
          subject: "column:ledger.*",
          reason:
            "no text-shaped Ledger columns found at all — refusing to pass on nothing (ADR-0028 doctrine)",
        },
      ],
    };
  }

  const crossed = await client.query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM ledger.entities)
           + (SELECT count(*) FROM ledger.facts))::int AS n`,
  );

  for (const { schema_name, table_name, column_name } of columns.rows) {
    // Identifiers come from the catalog, never from a caller; quoted all
    // the same so an exotic name cannot change the statement's shape.
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ${quoteIdent(schema_name)}.${quoteIdent(table_name)}
        -- ILIKE: the plane writes addresses lowercase, but a value that
      -- reached the store some other way need not have (Codex r1).
      WHERE ${quoteIdent(column_name)}::text ILIKE ANY($1::text[])`,
      [JID_SUFFIXES.map((suffix) => `%${suffix}%`)],
    );
    if (res.rows[0]!.n > 0) {
      violations.push({
        subject: `column:${schema_name}.${table_name}.${column_name}`,
        reason: `${res.rows[0]!.n} row(s) carry a WhatsApp address — chat identity never crosses the wall (ADR-0004)`,
      });
    }
  }

  // Tables only for the digit sweep: a view returns the same rows as the
  // table under it, so sweeping both would report one violation twice and
  // name the derived object as if it were the place the value lives.
  violations.push(
    ...(await sweepChatSubscriberNumbers(
      client,
      columns.rows
        .filter((row) => row.is_table)
        .map((row) => ({
          schema: row.schema_name,
          table: row.table_name,
          column: row.column_name,
        })),
    )),
  );

  return {
    columnsChecked: columns.rows.length,
    crossedRows: crossed.rows[0]!.n,
    violations,
  };
}

/**
 * The laundering path a suffix sweep cannot see (ticket #52; ADR-0004),
 * over every Ledger column that could store a number (ticket #55).
 *
 * FROM THE CATALOG, NOT FROM A LIST. The first version of this named
 * `ledger.facts.payload` because that was the only place a phone was stored;
 * ticket #55 added a second (a merge edge records the value its phone rung
 * fired on), and a hand-kept list of "columns that hold phone numbers" is
 * the cheapest thing in this repo to forget and the most expensive to
 * discover missing. So it sweeps every text-shaped column of every Ledger
 * TABLE, exactly as the suffix sweep above does — a Ledger column added
 * tomorrow is covered on the day it exists.
 *
 * `ContactEstablished` carries phone numbers, normalized to E.164 — and the
 * counterparty's own WhatsApp address is a phone number. A payload holding
 * it is chat identity in the Ledger wearing a different shape: an owner
 * comparing it against `scope_allowlist` recovers which chat a fact came
 * from, and can message the rep's customer directly. `@s.whatsapp.net`
 * never appears, so the sweep above passes it. A merge that fired on the
 * phone rung records the value that fired it, which is the same exposure
 * one table over.
 *
 * The aperture refuses this on the way in (`shapeContact`). This is the
 * independent auditor over that refusal — the same relationship FR-72's
 * reconciliation has to its constraint triggers.
 *
 * Compared on the last ten digits, because WhatsApp's Mexican addressing
 * carries a historical `1` after the country code that the same
 * subscriber's dialable number does not. Content-free: it counts matching
 * rows and reads no value back.
 *
 * A FALSE POSITIVE IS A REFUSAL, and that is the fail-safe direction. The
 * comparison runs over a whole column's digits, so a stored UUID could in
 * principle contribute a ten-digit run that collides with a real subscriber
 * — at odds around one in a hundred million per row, against the certainty
 * that a narrower sweep misses the next field somebody adds.
 *
 * SCOPE, stated so it is not mistaken for more: this compares against the
 * chats in the CAPTURE SCOPE, so it is vacuous on a database with no
 * `scope_allowlist` rows — which is a database where no chat was ever
 * captured, and therefore where no fact could have been extracted from
 * one. The audit's own `--require-corpus` flag is what refuses a green
 * over nothing.
 */
async function sweepChatSubscriberNumbers(
  client: pg.ClientBase,
  columns: readonly {
    readonly schema: string;
    readonly table: string;
    readonly column: string;
  }[],
): Promise<LedgerWallViolation[]> {
  const violations: LedgerWallViolation[] = [];
  for (const { schema, table, column } of columns) {
    // Identifiers come from the catalog, never from a caller; quoted all
    // the same, exactly as the suffix sweep quotes them.
    const res = await client.query<{ n: number }>(
      `WITH subscriber AS (
         SELECT DISTINCT right(
                  regexp_replace(split_part(chat_jid, '@', 1), '\\D', '', 'g'),
                  10) AS digits
           FROM scope_allowlist
          WHERE length(regexp_replace(split_part(chat_jid, '@', 1), '\\D', '', 'g')) >= 10
       )
       SELECT count(*)::int AS n
         FROM ${quoteIdent(schema)}.${quoteIdent(table)} t
        WHERE EXISTS (
                SELECT 1 FROM subscriber
                 -- The stored digits, with every separator stripped: a
                 -- number written ‘55 1234 5678’ in a commitment is the
                 -- same number as one stored ‘+525512345678’ in an
                 -- identifier, and only one of the two survives a literal
                 -- search (Codex r1).
                 WHERE position(
                         subscriber.digits
                         IN regexp_replace(t.${quoteIdent(column)}::text, '\\D', '', 'g')) > 0)`,
    );
    const n = res.rows[0]!.n;
    if (n === 0) continue;
    violations.push({
      subject: `column:${schema}.${table}.${column}`,
      reason: `${n} row(s) carry the subscriber number of a chat in the capture scope — a counterparty's own WhatsApp number is chat identity, not a business fact, and it never crosses the wall (ADR-0004)`,
    });
  }
  return violations;
}

/** Script entry: sweeps the database at `databaseUrl` with its own client. */
export async function auditLedgerWallAt(
  databaseUrl: string,
): Promise<LedgerWallReport> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await auditLedgerWall(client);
  } finally {
    await client.end();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

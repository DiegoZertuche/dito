/**
 * The binding wall, checked structurally (ticket #34 AC 5; ADR-0004), in
 * the spirit of the plane's sole-sender AST scan: bindings — the
 * rep-confirmed chat↔entity association — exist nowhere outside the
 * bundle. Two sweeps over the actual source of truth:
 *
 * 1. Shared Postgres holds no binding table or column: every migration in
 *    db/migrations, with comments and string literals stripped (CHECK
 *    values like 'binding_question' are vocabulary, not storage), defines
 *    no identifier that names entities, clientes, or bindings.
 * 2. The bundle's interior is reached only through the bundle API: no
 *    source file outside packages/bundle contains SQL addressing a bundle
 *    store — the store list derived from BUNDLE_MIGRATIONS itself, so a
 *    table added by a future bundle migration joins the sweep with no
 *    test change.
 *
 * Like the sole-sender scan, each sweep proves it can catch its violation
 * before certifying the tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BUNDLE_MIGRATIONS } from "@dito/bundle";
import { describe, expect, it } from "vitest";
import { SHARED_POSTGRES_STORES } from "./fr73-shared-stores.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * Substrings that would mean binding data escaped into shared Postgres —
 * substring, not word, matching, so compound identifiers (`chat_bindings`,
 * `entity_id`) are caught too. `entit` covers entity/entities; SQL's own
 * IDENTITY keyword is carved out before the sweep.
 */
const FORBIDDEN_SCHEMA_TOKENS = /bindings?|clientes?|entit/i;

/**
 * The crossing's migrations (ticket #50), exempted from the entity ban BY
 * NAME and never by loosening the pattern — because entities are Ledger
 * data (ADR-0003) and the Ledger is shared Postgres by design. This is the
 * one place ADR-0004's structural rule had to be told apart from what it
 * actually protects: the rule bans the chat↔entity BINDING from shared
 * Postgres, not the entity.
 *
 * The exemption is not free. Every file on this list is held to the
 * STRICTER rule below instead: it may name entities, and it may not name a
 * chat in any form. A migration that puts a chat beside an entity would
 * rebuild the binding table ADR-0004 forbids, whichever schema it landed
 * in — and adding a file here is a review decision, visible in the diff.
 */
const CROSSING_MIGRATIONS = new Set([
  "20260829100010_ledger_schema.sql",
  "20260829100011_aperture_rep_side_stores.sql",
  "20260829100012_ledger_roles_and_grants.sql",
  // Ticket #52. Extraction's own chat-carrying table (`extraction_runs`)
  // is a SEPARATE migration precisely so this exemption can stay strict:
  // the crossing's schema names entities and no chat, that one names a
  // chat and no entity, and neither file can quietly become the binding
  // table this rule exists to forbid.
  "20260829100026_fact_disclosure_lines.sql",
  // Ticket #55. The merge edge is entity-to-entity and nothing else: the
  // matcher decides on identifiers already filed against entities, so
  // nothing conversation-shaped has any business in this schema.
  "20260829100050_entity_merges.sql",
  // Ticket #62. The reversal names one merge edge and nothing else —
  // reversing a merge is entity-to-entity for exactly the reason making
  // one was.
  "20260830100120_entity_unmerges.sql",
  // Ticket #60. The kind determination's column grant. It names the
  // entity table and one of its columns, and nothing else — the
  // conversation the determination is MADE from stays in the bundle and
  // never reaches this schema.
  "20260831100040_entity_kind_grant.sql",
  // Ticket #127, the owner side. The finalized views name entities and the
  // facts filed against them, and the one join they gain is to the SEATS
  // registry — a seat, a company, a twin id and a rep's name, and no chat
  // in any form. That is the whole of ADR-0004's amendment: the seat
  // crosses BECAUSE it is not chat identity, and this rule is what keeps
  // the two apart. `filed_by_twin_id` is the join key and never a column.
  "20260902100030_owner_views.sql",
  // ...the policies over those same tables, keyed to a company and to
  // nothing about a conversation.
  "20260902100040_ledger_row_level_security.sql",
  // ...and the resolution function, which walks entity-to-entity merge
  // edges for exactly the reason making one was entity-to-entity.
  "20260902100050_resolve_entity_owner_execute.sql",
  // Ticket #129, the other half of that walk: which records' facts read
  // forward under the resolved one. It takes an entity, returns entity ids,
  // and follows the same entity-to-entity edges — no edge, no status, no
  // direction and, like its sibling, no chat in any form.
  "20260902100060_resolved_members_for_declared_company.sql",
  // #200 hotfix 1, whose header argues it: three of the stamp columns it
  // re-cuts are the Ledger's own, so the file names entities for the reason
  // the crossing's schema does — and it names no chat in any form, which is
  // the stricter rule the exemption is bought at.
  "20260906100040_execution_stamps_clock.sql",
]);

/**
 * What a crossing migration may never contain: anything chat-shaped. A
 * chat id beside an entity id IS the binding (ADR-0004), and owner-visible
 * provenance never carries chat identity.
 */
const FORBIDDEN_CROSSING_TOKENS = /chat|jid|bindings?/i;

/** Comments and single-quoted literals carry vocabulary, never storage. */
function strippedSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\bidentity\b/gi, "");
}

/** Every table the bundle's own migrations create — the interior stores. */
function bundleStoreNames(): string[] {
  const names: string[] = [];
  for (const migration of BUNDLE_MIGRATIONS) {
    for (const match of migration.sql.matchAll(
      /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(\w+)/gi,
    )) {
      names.push(match[1]!);
    }
  }
  expect(names.length).toBeGreaterThan(0);
  return names;
}

/** SQL-shaped reference to any of the named tables (reads or writes). */
function sqlReferencePattern(tables: string[]): RegExp {
  return new RegExp(
    `\\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\\s+(?:${tables.join("|")})\\b`,
    "i",
  );
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `.next` and `.scratch` joined the two with the first app (#129):
    // build output holds inlined copies of the packages this scan reads,
    // and scratch holds ticket text nobody committed.
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".next" ||
      entry.name === ".scratch"
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

describe("the binding wall is structural (ticket #34 AC 5; ADR-0004)", () => {
  it("shared Postgres defines no binding table or column — every migration, comments and literals stripped", () => {
    const dir = path.join(REPO_ROOT, "db/migrations");
    const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(20);
    for (const file of migrations) {
      const sql = strippedSql(readFileSync(path.join(dir, file), "utf8"));
      if (CROSSING_MIGRATIONS.has(file)) {
        expect(
          FORBIDDEN_CROSSING_TOKENS.test(sql),
          `${file} names a chat in the crossing's schema — a chat beside an entity IS the binding, and bindings live only in the bundle's entity mirror (ADR-0004)`,
        ).toBe(false);
        continue;
      }
      expect(
        FORBIDDEN_SCHEMA_TOKENS.test(sql),
        `${file} defines a binding/entity-shaped identifier in shared Postgres — bindings live only in the bundle's entity mirror (ADR-0004). If this is the crossing's own schema, add it to CROSSING_MIGRATIONS and it must then name no chat at all.`,
      ).toBe(false);
    }
  });

  it("every exempted crossing migration exists — the allowlist cannot outlive the file it excuses", () => {
    const present = new Set(
      readdirSync(path.join(REPO_ROOT, "db/migrations")).filter((f) =>
        f.endsWith(".sql"),
      ),
    );
    for (const file of CROSSING_MIGRATIONS) {
      expect(present.has(file), `${file} is exempted but does not exist`).toBe(
        true,
      );
    }
  });

  it("the sweep can catch its violation: a binding column in migration SQL fails, while quoted vocabulary passes", () => {
    expect(
      FORBIDDEN_SCHEMA_TOKENS.test(
        strippedSql("ALTER TABLE drafts ADD COLUMN entity_id uuid;"),
      ),
    ).toBe(true);
    expect(
      FORBIDDEN_SCHEMA_TOKENS.test(
        strippedSql("CREATE TABLE chat_bindings (chat_jid text);"),
      ),
    ).toBe(true);
    // The seam's vocabulary values and comments are not storage.
    expect(
      FORBIDDEN_SCHEMA_TOKENS.test(
        strippedSql(
          "-- the binding ceremony\nCHECK (kind IN ('binding_question'))",
        ),
      ),
    ).toBe(false);
    // And IDENTITY is not an entity.
    expect(
      FORBIDDEN_SCHEMA_TOKENS.test(
        strippedSql("id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY"),
      ),
    ).toBe(false);
  });

  it("the crossing's exemption catches its own violation: a chat column beside an entity fails", () => {
    // What an exempted migration may do.
    expect(
      FORBIDDEN_CROSSING_TOKENS.test(
        strippedSql(
          "CREATE TABLE entities (company_id uuid, entity_id uuid);",
        ),
      ),
    ).toBe(false);
    // And what it may never do — this is the binding table, rebuilt.
    expect(
      FORBIDDEN_CROSSING_TOKENS.test(
        strippedSql(
          "ALTER TABLE entities ADD COLUMN chat_jid text;",
        ),
      ),
    ).toBe(true);
    expect(
      FORBIDDEN_CROSSING_TOKENS.test(
        strippedSql("CREATE TABLE entity_bindings (entity_id uuid);"),
      ),
    ).toBe(true);
  });

  it("no source outside packages/bundle addresses a bundle store with SQL — the bundle API is the only door", () => {
    const stores = bundleStoreNames();
    const pattern = sqlReferencePattern(stores);
    // `apps/` joined the three with the first app (#129): the owner web
    // issues SQL of its own — it is the first process to authenticate as
    // an application role — and "the bundle API is the only door" has to
    // hold for the surface on the far side of the wall too.
    const roots = [
      path.join(REPO_ROOT, "packages"),
      path.join(REPO_ROOT, "plane"),
      path.join(REPO_ROOT, "scripts"),
      path.join(REPO_ROOT, "apps"),
    ];
    // The one named exception: the FR-73 suite PLANTS a rogue plaintext
    // store wearing a bundle store's name — the violation the audit must
    // catch — and asserts store names through the API.
    const allowed = new Set([
      path.join(REPO_ROOT, "packages/twin-runtime/src/fr73.int.test.ts"),
      // This scan names its own patterns.
      path.join(REPO_ROOT, "packages/twin-runtime/src/binding-wall.test.ts"),
    ]);
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!/\.(ts|mts|cts|tsx|go|mjs|cjs|js|sql)$/.test(file)) continue;
        if (file.startsWith(path.join(REPO_ROOT, "packages/bundle") + path.sep))
          continue;
        if (allowed.has(file)) continue;
        if (pattern.test(readFileSync(file, "utf8"))) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(
      offenders,
      "these files address a bundle interior store with SQL from outside packages/bundle — reach the mirror and the message store only through the bundle API (ADR-0004/0007)",
    ).toEqual([]);
  });

  it("the outside-the-bundle sweep can catch its violation too", () => {
    const pattern = sqlReferencePattern(bundleStoreNames());
    expect(pattern.test("SELECT chat_jid FROM entity_mirror")).toBe(true);
    expect(pattern.test("INSERT INTO conversation_messages VALUES (1)")).toBe(
      true,
    );
    expect(pattern.test('expect(stores).toContain("entity_mirror")')).toBe(
      false,
    );
  });

  /**
   * THE MATCHER RUNS LEDGER-SIDE ON LEDGER DATA ONLY (ticket #55; ADR-0004,
   * ADR-0035) — the third face of the same rule this file already checks
   * twice, and the one a migration cannot promise.
   *
   * A merge decides what two of the company's records MEAN. If that decision
   * could consult a rep-side store — the entity mirror, the capture scope,
   * the seam's own rows — then the wall's data would be deciding the
   * company's records, and an owner reading a merged timeline would be
   * reading a conclusion drawn from a conversation they may never see. So
   * the matcher's source is held to the crossing migrations' own rule: it
   * may name entities, and it may name nothing conversation-shaped at all.
   *
   * Checked over the source rather than at runtime for the reason the
   * sole-sender scan is: a new file is covered the moment it exists, and a
   * violation fails a fast unit lane rather than waiting for a code path.
   */
  const LEDGER_SIDE_ONLY_SOURCES = ["packages/aperture/src/merge.ts"];

  /** Comments carry vocabulary; the code and the SQL inside it are storage. */
  function strippedTs(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
  }

  it("the merge matcher names nothing conversation-shaped, and no rep-side store", () => {
    // The rep-side store list is DERIVED from FR-73's registry rather than
    // retyped, so a store added to shared Postgres tomorrow joins this
    // sweep with no test change — the same trick the bundle sweep plays on
    // BUNDLE_MIGRATIONS.
    const repSideStores = new RegExp(
      `\\b(${SHARED_POSTGRES_STORES.map((s) => s.table).join("|")})\\b`,
      "i",
    );
    for (const relative of LEDGER_SIDE_ONLY_SOURCES) {
      const source = strippedTs(
        readFileSync(path.join(REPO_ROOT, relative), "utf8"),
      );
      // A misresolved path or an over-eager comment strip would sweep an
      // empty string and report green over everything (ADR-0028 doctrine).
      expect(source.length, `${relative} swept as empty`).toBeGreaterThan(2000);
      expect(
        FORBIDDEN_CROSSING_TOKENS.test(source),
        `${relative} names something conversation-shaped — the matcher runs Ledger-side on Ledger data only and never reads a binding or a chat address (ADR-0004, ADR-0035)`,
      ).toBe(false);
      expect(
        repSideStores.test(source),
        `${relative} names a rep-side store — a merge decided on anything but Ledger data is the wall's own data deciding what the company's records mean (ADR-0004)`,
      ).toBe(false);
    }
  });

  it("that sweep catches its violations, and lets a comment saying the rule through", () => {
    // What it must catch: reaching for the mirror, or for the seam.
    expect(
      FORBIDDEN_CROSSING_TOKENS.test(
        strippedTs("const jid = binding.chatJid;"),
      ),
    ).toBe(true);
    expect(
      /\bwa_events\b/i.test(
        strippedTs('await db.query("SELECT payload_enc FROM wa_events");'),
      ),
    ).toBe(true);
    // ...and what it must let through: the rule, written down where the
    // next reader of the matcher will find it.
    expect(
      FORBIDDEN_CROSSING_TOKENS.test(
        strippedTs("// never reads a binding or a chat address\nconst x = 1;"),
      ),
    ).toBe(false);
    expect(
      FORBIDDEN_CROSSING_TOKENS.test(
        strippedTs("/** No chat identity here. */\nconst y = 2;"),
      ),
    ).toBe(false);
  });
});

/**
 * What the owner can see, observed from the owner's own connection (ticket
 * #127; spec #126 decisions 1, 3, 4, 13, 14 and 15).
 *
 * Every other suite in this package reads the database as the schema owner
 * — a superuser, which bypasses every grant and every policy this slice
 * adds. That is exactly the reader this suite must not be. Slice 4 is the
 * first slice in which a process AUTHENTICATES as an application role, so
 * the claims below are made from a second connection logged in as
 * `dito_owner`, with its company declared per connection the way the owner
 * app declares it.
 *
 * The corpus is seeded through the Postgres seam, as always: `wa_events`
 * rows the plane could have delivered, the aperture filing from them, the
 * real finalization writer closing the correction window. Two companies,
 * because tenant isolation is not observable with one.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LEDGER_VIEWS_ROLE,
  OWNER_COMPANY_SETTING,
  OWNER_ROLE,
} from "./grants.js";
import {
  countOwnerFacts,
  listOwnerEntities,
  readOwnerTimeline,
  resolveOwnerEntityByName,
} from "./owner-reads.js";
import {
  CORPUS_AGREEMENT,
  CORPUS_AFTER_LIFT_AMOUNT,
  CORPUS_WALL_SHAPED_NAME,
  seedOwnerCorpus,
  type OwnerCorpus,
} from "./testing/owner-corpus.js";
import {
  borrowOwnerPassword,
  OWNER_TEST_PASSWORD,
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withRoleClient,
  type BorrowedOwnerPassword,
} from "./testing/db.js";
import { boundTo, freshSeat, type Seat } from "./testing/ledger-fixtures.js";

/** The day the corpus is disclosed, and the day after, when it finalizes. */
const DISCLOSED_AT = new Date("2026-09-01T23:30:00Z");
const WINDOW_CLOSED = new Date("2026-09-03T00:00:00Z");

let db: pg.Client;
const fixtures = boundTo(() => db);

/** One company's whole corpus, and the ids a test asserts against. */
interface Corpus {
  readonly seat: Seat;
  readonly entityId: string;
  readonly factIds: readonly string[];
}

/**
 * The credential `dito_owner` had before this suite borrowed it (#133).
 *
 * ROLES ARE CLUSTER-GLOBAL, and this repo's test database and the rig's
 * live in the SAME local cluster — so setting a password here changes the
 * credential the rig's own `DITO_OWNER_DATABASE_URL` carries, in every
 * database on that server. Saving the stored SCRAM verifier and putting it
 * back is what keeps a test run from quietly breaking a steering session.
 * The value read is the verifier, never a plaintext, and it leaves neither
 * this process nor `pg_authid`. A run KILLED mid-suite still leaves the
 * test password behind; `rig-seed-owner.ts` is what puts the rig's back.
 */
let ownerPassword: BorrowedOwnerPassword | null = null;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
  ownerPassword = await borrowOwnerPassword(OWNER_ROLE);
});

afterAll(async () => {
  await ownerPassword?.restore();
  await db.end();
});

/**
 * A company with one rep, two customers' facts, disclosed and lifted.
 *
 * The seeding is `ledger-fixtures`' since ticket #132, shared with
 * `shadow-lift.int.test.ts`: the same corpus, seeded once, so two suites
 * asserting different things about the same shape cannot drift apart. The
 * LIFT is this suite's own, because everything below is about what an owner
 * of a lifted company reads.
 */
async function seedCompany(names: {
  company: string;
  rep: string;
  customer: string;
}): Promise<Corpus> {
  const corpus = await fixtures.seedCompany(names, DISCLOSED_AT, WINDOW_CLOSED);
  await fixtures.liftShadow(corpus.seat.companyId, WINDOW_CLOSED);
  return corpus;
}

/** Reads as the owner app does: its own login, its own company, per connection. */
async function asOwner<T>(
  companyId: string | null,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withRoleClient(OWNER_ROLE, OWNER_TEST_PASSWORD, async (client) => {
    if (companyId !== null) {
      await client.query("SELECT set_config($1, $2, false)", [
        OWNER_COMPANY_SETTING,
        companyId,
      ]);
    }
    return fn(client);
  });
}

describe("two companies, one owner connection", () => {
  let a: Corpus;
  let b: Corpus;

  beforeAll(async () => {
    a = await seedCompany({
      company: "Ferretería Fuentes",
      rep: "Mauricio Cantú",
      customer: "Ana García",
    });
    b = await seedCompany({
      company: "Materiales del Norte",
      rep: "Rosa Elena Treviño",
      customer: "Torres y Asociados",
    });
    expect(a.factIds).toHaveLength(2);
    expect(b.factIds).toHaveLength(2);
  });

  it("returns only company A's facts to a connection that declares company A", async () => {
    const rows = await asOwner(a.seat.companyId, (client) =>
      client.query<{ id: string; company_id: string }>(
        "SELECT id, company_id FROM ledger.finalized_facts ORDER BY occurred_at",
      ),
    );
    expect(rows.rows.map((r) => r.id).sort()).toEqual([...a.factIds].sort());
    expect(new Set(rows.rows.map((r) => r.company_id))).toEqual(
      new Set([a.seat.companyId]),
    );
  });

  it("returns only company B's facts to the same query on the same role", async () => {
    const rows = await asOwner(b.seat.companyId, (client) =>
      client.query<{ id: string }>("SELECT id FROM ledger.finalized_facts"),
    );
    expect(rows.rows.map((r) => r.id).sort()).toEqual([...b.factIds].sort());
  });

  it("returns only company A's clientes and only company A's seats", async () => {
    const seen = await asOwner(a.seat.companyId, async (client) => ({
      entities: await client.query<{ entity_id: string; display_name: string }>(
        "SELECT entity_id, display_name FROM ledger.finalized_entities",
      ),
      seats: await client.query<{ seat_id: string; display_name: string }>(
        "SELECT seat_id, display_name FROM seats_status",
      ),
    }));
    expect(seen.entities.rows).toEqual([
      { entity_id: a.entityId, display_name: "Ana García" },
    ]);
    expect(seen.seats.rows).toEqual([
      { seat_id: a.seat.seatId, display_name: "Mauricio Cantú" },
    ]);
  });

  it("returns nothing at all to a connection that declares no company", async () => {
    // A missing setting is NULL, and `company_id = NULL` is NULL, so the
    // policy filters the row. The failure mode this rules out is the other
    // one: an unset tenant reading everything.
    const seen = await asOwner(null, async (client) => ({
      facts: await client.query("SELECT id FROM ledger.finalized_facts"),
      entities: await client.query(
        "SELECT entity_id FROM ledger.finalized_entities",
      ),
      seats: await client.query("SELECT seat_id FROM seats_status"),
    }));
    expect(seen.facts.rows).toEqual([]);
    expect(seen.entities.rows).toEqual([]);
    expect(seen.seats.rows).toEqual([]);
  });

  it("cannot reach a Ledger table, a registry, the seam or the aperture's stores", async () => {
    // Not "returns nothing": FAILS ON PRIVILEGE. The owner app's whole
    // reach is three named views (ADR-0002), and a table it could select
    // from would hand it shadow rows and the twin id its views exist to
    // withhold.
    //
    // `audit_chain` IS BACK ON THIS LIST (ticket #165; the decision on #157,
    // 2026-09-03). #130's ruling took it off — the owner twin is an
    // execution, every execution owes a chain one content-free entry — having
    // weighed what the grant let a compromised owner web WRITE. #157 weighed
    // what it let it READ: the shared chain is a same-company rep-activity
    // record, `twin:<id>` refs and every send's timing included (ADR-0025,
    // ADR-0004 as amended). So the owner appends to its OWN chain,
    // `owner.audit_chain`, under its own key — and holds nothing here.
    const forbidden = [
      "SELECT * FROM ledger.facts",
      "SELECT * FROM ledger.entities",
      "SELECT * FROM ledger.entity_grants",
      "SELECT * FROM ledger.entity_merges",
      "SELECT * FROM seats",
      "SELECT * FROM companies",
      "SELECT * FROM wa_events",
      "SELECT * FROM disclosure_lines",
      // `aperture_questions` is absent and nothing replaces it (ticket
      // #218): this list is about a PRIVILEGE the owner must not hold, and a
      // relation that is not in the schema raises 42P01 rather than 42501 —
      // so an entry for it would assert the wrong refusal.
      "SELECT * FROM twin_keys",
      "SELECT * FROM audit_chain",
    ];
    const codes = await asOwner(a.seat.companyId, async (client) => {
      const seen: string[] = [];
      for (const statement of forbidden) {
        try {
          await client.query(statement);
          seen.push("ALLOWED");
        } catch (err) {
          seen.push(pgErrorCode(err) ?? "unknown");
        }
      }
      return seen;
    });
    expect(codes).toEqual(forbidden.map(() => "42501"));
  });

  it("reaches its OWN chain to extend it, and cannot touch what is in it (tickets #130, #165)", async () => {
    // EXACTLY TWO PRIVILEGES, ON THE OWNER'S OWN CHAIN. `appendOwnerAuditEntry`
    // reads and authenticates this company's tail under the OWNER's HMAC key
    // before extending it, so SELECT is as load-bearing as INSERT — and
    // UPDATE, DELETE and TRUNCATE are refused on PRIVILEGE here, not only by
    // the table's own append-only trigger, so a migration that handed the
    // owner one would show up in the grant diff (`grants.ts`, planted against
    // in `invariants.int.test.ts`) rather than at run time.
    //
    // THE REP SIDE'S CHAIN IS IN THE FORBIDDEN LIST ABOVE (#157). This test
    // moved table rather than changing shape, which is exactly what the
    // decision was: the owner keeps the same two privileges, on a chain that
    // holds only what it wrote.
    const codes = await asOwner(a.seat.companyId, async (client) => {
      const seen: Record<string, string> = {};
      const statements: readonly (readonly [string, string])[] = [
        ["select", "SELECT caller, action FROM owner.audit_chain LIMIT 1"],
        ["update", "UPDATE owner.audit_chain SET outcome = 'x'"],
        ["delete", "DELETE FROM owner.audit_chain"],
        ["truncate", "TRUNCATE owner.audit_chain"],
      ];
      for (const [what, statement] of statements) {
        // Each statement in its own transaction: a refusal aborts the one
        // it was in, and the next would fail as 25P02 rather than on its
        // own privilege.
        await client.query("BEGIN");
        try {
          await client.query(statement);
          seen[what] = "ALLOWED";
        } catch (err) {
          seen[what] = pgErrorCode(err) ?? "unknown";
        }
        await client.query("ROLLBACK");
      }
      return seen;
    });
    expect(codes).toEqual({
      select: "ALLOWED",
      update: "42501",
      delete: "42501",
      truncate: "42501",
    });
  });

  it("cannot call the Ledger functions that would let it choose a company", async () => {
    // `active_entity_merges` returns the merge graph itself, and
    // `resolve_entity` takes a company the caller names — which is exactly
    // what a read's parameters may never do (spec #126 decision 6). The
    // owner gets the wrapper that takes no company instead.
    const codes = await asOwner(a.seat.companyId, async (client) => {
      const seen: (string | undefined)[] = [];
      for (const [sql, params] of [
        ["SELECT * FROM ledger.active_entity_merges($1)", [a.seat.companyId]],
        [
          "SELECT ledger.resolve_entity($1, $2)",
          [b.seat.companyId, b.entityId],
        ],
      ] as const) {
        try {
          await client.query(sql, [...params]);
          seen.push("ALLOWED");
        } catch (err) {
          seen.push(pgErrorCode(err));
        }
      }
      return seen;
    });
    expect(codes).toEqual(["42501", "42501"]);
  });

  it("resolves an entity of the company its connection declared", async () => {
    // The wrapper is SECURITY DEFINER, so it reads merge tables the owner
    // holds nothing on, and it takes no company: the one it walks is the
    // one this connection declared.
    const resolved = await asOwner(a.seat.companyId, (client) =>
      client.query<{ resolved: string | null }>(
        "SELECT ledger.resolve_entity_for_declared_company($1) AS resolved",
        [a.entityId],
      ),
    );
    expect(resolved.rows[0]!.resolved).toBe(a.entityId);
  });

  it("refuses to resolve anything at all when the connection declared no company", async () => {
    // The hole a company PARAMETER left open: with no tenant declared, a
    // guard that only compares a declared company against the argument
    // never fires, and a definer function answers about whichever company
    // it was handed. There is no argument to hand it any more, and no
    // tenant is a refusal rather than a default.
    const code = await asOwner(null, async (client) => {
      try {
        await client.query(
          "SELECT ledger.resolve_entity_for_declared_company($1)",
          [b.entityId],
        );
        return "ALLOWED";
      } catch (err) {
        return pgErrorCode(err);
      }
    });
    expect(code).toBe("42501");
  });
});

describe("the filing seat crosses and the twin does not", () => {
  let a: Corpus;

  beforeAll(async () => {
    a = await seedCompany({
      company: "Ferretería Fuentes",
      rep: "Mauricio Cantú",
      customer: "Ana García",
    });
  });

  it("names the seat a fact was filed under, and renders it through the seats view", async () => {
    const rendered = await asOwner(a.seat.companyId, (client) =>
      client.query<{ display_name: string }>(
        `SELECT s.display_name
           FROM ledger.finalized_facts f
           JOIN seats_status s ON s.seat_id = f.filed_by_seat_id
          GROUP BY s.display_name`,
      ),
    );
    expect(rendered.rows).toEqual([{ display_name: "Mauricio Cantú" }]);
  });

  it("exposes no column that names a twin, a shadow flag or a retraction", async () => {
    const columns = await asOwner(a.seat.companyId, (client) =>
      client.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = 'ledger' AND c.relname = 'finalized_facts'
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
      ),
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).toContain("filed_by_seat_id");
    expect(names).not.toContain("filed_by_twin_id");
    expect(names).not.toContain("shadow");
    expect(names).not.toContain("retracted_at");
  });

  it("shows a fact filed by an unregistered twin, with its seat not recorded", async () => {
    // Every fact filed before ticket #127 was filed by a twin with no seat
    // row, because the registry did not exist. An INNER JOIN would have
    // made all of them vanish from the owner's view with nothing to say so;
    // the LEFT JOIN renders the seat as *not recorded* (ADR-0034) and keeps
    // the fact.
    const unregistered = freshSeat(a.seat.companyId);
    const entityId = await fixtures.bindCustomer(unregistered, "Torres");
    await fixtures.quote(unregistered, entityId, "5215559999@s.whatsapp.net", 900);
    const filed = await fixtures.discloseAndFinalize(
      unregistered,
      DISCLOSED_AT,
      WINDOW_CLOSED,
    );
    // NOTHING LIFTS ANYTHING HERE ANY MORE (ticket #132). Company A was
    // lifted in `seedCompany`, and since the aperture stamps `shadow` at
    // filing from the company's mode, these rows landed visible on their
    // own — which is the amendment's whole point. The second lift this line
    // used to carry is now refused, correctly: a launch gate opens once.

    const rows = await asOwner(a.seat.companyId, (client) =>
      client.query<{ id: string; filed_by_seat_id: string | null }>(
        "SELECT id, filed_by_seat_id FROM ledger.finalized_facts WHERE id = ANY($1::uuid[])",
        [filed],
      ),
    );
    expect(rows.rows).toEqual(
      filed.map((id) => ({ id, filed_by_seat_id: null })),
    );
  });

  it("returns exactly the rows the view returned before the seat joined it", async () => {
    // The independent source of truth is …100010's definition, written out
    // here: same predicate, same columns, straight off the table. If the
    // join ever multiplied or dropped a row, these two disagree.
    const throughTheView = await asOwner(a.seat.companyId, (client) =>
      client.query<Record<string, unknown>>(
        `SELECT id, company_id, entity_id, fact_type, payload_version, payload,
                occurred_at, confidence, source_type, filed_at, finalized_at
           FROM ledger.finalized_facts
          ORDER BY id`,
      ),
    );
    const beforeTheSeat = await db.query<Record<string, unknown>>(
      `SELECT id, company_id, entity_id, fact_type, payload_version, payload,
              occurred_at, confidence, source_type, filed_at, finalized_at
         FROM ledger.facts
        WHERE company_id = $1
          AND shadow = false
          AND finalized_at IS NOT NULL
          AND retracted_at IS NULL
        ORDER BY id`,
      [a.seat.companyId],
    );
    expect(throughTheView.rows.length).toBeGreaterThan(0);
    expect(throughTheView.rows).toEqual(beforeTheSeat.rows);
  });

  it("still hides a fact whose company has not been lifted", async () => {
    // The launch gate is a WHERE clause and the owner role changes nothing
    // about it: a company whose Ledger was never lifted is invisible to its
    // own owner (ADR-0016).
    const unlifted = freshSeat();
    await fixtures.registerSeat(unlifted, {
      company: "Aceros del Bajío",
      rep: "Job Hernández",
    });
    const entityId = await fixtures.bindCustomer(unlifted, "Constructora Vega");
    await fixtures.quote(unlifted, entityId, "5215558888@s.whatsapp.net", 1200);
    await fixtures.discloseAndFinalize(unlifted, DISCLOSED_AT, WINDOW_CLOSED);

    const seen = await asOwner(unlifted.companyId, async (client) => ({
      facts: await client.query("SELECT id FROM ledger.finalized_facts"),
      entities: await client.query(
        "SELECT entity_id FROM ledger.finalized_entities",
      ),
      // ...and the seat is there, because a seat is not a Ledger row and
      // has no shadow flag: the owner of an unlifted company can see who
      // works for it and nothing they filed.
      seats: await client.query("SELECT seat_id FROM seats_status"),
    }));
    expect(seen.facts.rows).toEqual([]);
    expect(seen.entities.rows).toEqual([]);
    expect(seen.seats.rows).toHaveLength(1);
  });
});

describe("the role the views run as", () => {
  it("cannot log in, so the only way through the views is the owner's own connection", async () => {
    const row = await db.query<{ rolcanlogin: boolean; rolbypassrls: boolean }>(
      "SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [LEDGER_VIEWS_ROLE],
    );
    expect(row.rows).toEqual([{ rolcanlogin: false, rolbypassrls: false }]);
  });

  it("refuses to register a rep whose name is a WhatsApp address or a raw number", async () => {
    // The one free-text value on the owner's side that a person types, and
    // it sits beside every fact that seat filed. The suffix half and the
    // digit half are separate failures: the wall sweep can catch the first
    // over old rows and can never catch the rep's OWN number, because the
    // rep's own thread is not in the capture scope.
    const seat = freshSeat();
    await db.query("INSERT INTO companies (id, display_name) VALUES ($1, $2)", [
      seat.companyId,
      "Ferretería Fuentes",
    ]);
    const codes: (string | undefined)[] = [];
    for (const name of ["5215550001@s.whatsapp.net", "5215550001"]) {
      try {
        await db.query(
          `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
           VALUES ($1, $2, $3, $4, 'linked')`,
          [randomUUID(), seat.companyId, randomUUID(), name],
        );
        codes.push("ACCEPTED");
      } catch (err) {
        codes.push(pgErrorCode(err));
      }
    }
    // 23514 is a CHECK violation.
    expect(codes).toEqual(["23514", "23514"]);
    await db.query("DELETE FROM companies WHERE id = $1", [seat.companyId]);
  });

  it("refuses a company setting that is not a company", async () => {
    // A garbage setting is an error, never everything: the cast fails and
    // the query stops, which is the failure a silent empty result would
    // have hidden.
    const code = await withRoleClient(
      OWNER_ROLE,
      OWNER_TEST_PASSWORD,
      async (client) => {
        await client.query("SELECT set_config($1, $2, false)", [
          OWNER_COMPANY_SETTING,
          randomUUID().slice(0, 8),
        ]);
        try {
          await client.query("SELECT id FROM ledger.finalized_facts");
          return "ALLOWED";
        } catch (err) {
          return pgErrorCode(err);
        }
      },
    );
    expect(code).toBe("22P02");
  });
});


/**
 * THE OWNER READ MODULE, at the same seam and from the same connection
 * (ticket #129; spec #126 decisions 2, 15, 16).
 *
 * Everything above asserts what the GRANT lets through. What follows
 * asserts what `owner-reads.ts` does with it — the merge resolution the
 * views cannot do, the six fact types, and the two tools #130 inherits.
 * Same corpus discipline: ordinary traffic through the aperture, read back
 * over a real `dito_owner` login.
 */
describe("the owner read module", () => {
  let a: OwnerCorpus;
  // The second company is seeded by the SMALLER helper on purpose: one
  // customer, one quote, one promise. Two identical corpora would make
  // every count assertion below pass for the wrong reason.
  let b: Corpus;

  beforeAll(async () => {
    a = await seedOwnerCorpus(db, {
      company: "Ferretería Fuentes",
      rep: "Mauricio Cantú",
      customer: "Ana García",
      mergedWinner: "Torres Hnos.",
      mergedLoser: "Torres Hermanos",
    });
    b = await seedCompany({
      company: "Materiales del Norte",
      rep: "Rosa Elena Treviño",
      customer: "Beatriz Lozano",
    });
  });

  it("lists the company's clientes, and no other company's", async () => {
    const names = await asOwner(a.seat.companyId, async (client) =>
      (await listOwnerEntities(client)).map((e) => e.displayName),
    );
    // The wall-shaped name is in the LIST because the read module returns
    // what is stored; refusing to SAY it is the renderer's job, asserted in
    // `owner-render.test.ts` and at the HTTP seam.
    expect(names).toEqual([
      CORPUS_WALL_SHAPED_NAME,
      "Ana García",
      "Torres Hnos.",
    ]);
  });

  it("lists a merged pair as ONE cliente, under the surviving record", async () => {
    // Two records were bound and the matcher joined them on a shared RFC.
    // Both rows are still in `finalized_entities` — a merge moves nothing —
    // so a list that did not resolve would show this customer twice.
    const listed = await asOwner(a.seat.companyId, (client) =>
      listOwnerEntities(client),
    );
    const ids = listed.map((e) => e.entityId);
    expect(ids).toContain(a.merged.winner);
    expect(ids).not.toContain(a.merged.loser);
  });

  it("reads a merged cliente as one timeline containing both members' facts", async () => {
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.merged.winner),
    );
    expect(timeline.entity?.displayName).toBe("Torres Hnos.");
    expect([...timeline.memberEntityIds].sort()).toEqual(
      [a.merged.winner, a.merged.loser].sort(),
    );
    // The two quotes were filed against DIFFERENT records and neither moved.
    expect(new Set(timeline.facts.map((f) => f.entityId))).toEqual(
      new Set([a.merged.winner, a.merged.loser]),
    );
    expect([...timeline.facts.map((f) => f.id)].sort()).toEqual(
      [...a.merged.factIds].sort(),
    );
  });

  it("opens the same page from the losing record's id", async () => {
    const fromLoser = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.merged.loser),
    );
    expect(fromLoser.requestedEntityId).toBe(a.merged.loser);
    expect(fromLoser.entity?.entityId).toBe(a.merged.winner);
    expect([...fromLoser.facts.map((f) => f.id)].sort()).toEqual(
      [...a.merged.factIds].sort(),
    );
  });

  it("returns no cliente at all for another company's entity id", async () => {
    // Not B's data and not an error: the same answer an id that never
    // existed gets, so the shape of the refusal says nothing about another
    // tenant.
    const seen = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, b.entityId),
    );
    expect(seen.entity).toBeNull();
    expect(seen.facts).toEqual([]);
  });

  it("carries all six fact types with their payloads on one cliente", async () => {
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    expect(new Set(timeline.facts.map((f) => f.factType))).toEqual(
      new Set([
        "QuoteGiven",
        "OrderRequested",
        "OrderTaken",
        "DatePromised",
        "ContactEstablished",
        "CustomerPattern",
      ]),
    );
  });

  it("shows an OrderTaken's quoted agreement, composed off the rep's own message", async () => {
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    const taken = timeline.facts.find((f) => f.factType === "OrderTaken")!;
    expect(taken.payload["agreement"]).toBe(CORPUS_AGREEMENT);
    expect(taken.payloadVersion).toBe(3);
  });

  it("leaves an absent optional field absent rather than defaulting it", async () => {
    // ADR-0034: a new reader treats an absent field as *not recorded then*,
    // never as a default. The `OrderRequested` was filed with no amount and
    // no date, so the payload must carry neither key — not a null, not a
    // zero, not a currency.
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    const requested = timeline.facts.find(
      (f) => f.factType === "OrderRequested",
    )!;
    expect(requested.payload).toEqual({
      item: "mortero",
      quantity: 40,
      unit: "bultos",
    });
  });

  it("names the filing seat's display name on every fact", async () => {
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    expect(timeline.facts).not.toHaveLength(0);
    for (const fact of timeline.facts) {
      expect(fact.filedBySeatId).toBe(a.seat.seatId);
      expect(fact.filedBySeatName).toBe("Mauricio Cantú");
    }
  });

  it("returns the facts in occurred_at order", async () => {
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    const instants = timeline.facts.map((f) => f.occurredAt.getTime());
    expect(instants).toEqual([...instants].sort((x, y) => x - y));
    // ...and the order is observable rather than accidental: three of the
    // six were seeded on separate days.
    expect(new Set(instants).size).toBeGreaterThan(1);
  });

  it("narrows a timeline by window and by fact type, and never by company", async () => {
    const narrowed = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId, {
        factType: "CustomerPattern",
      }),
    );
    expect(narrowed.facts.map((f) => f.factType)).toEqual(["CustomerPattern"]);

    const windowed = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId, {
        from: new Date("2026-08-28T00:00:00Z"),
      }),
    );
    expect(windowed.facts).not.toHaveLength(0);
    for (const fact of windowed.facts) {
      expect(fact.occurredAt.getTime()).toBeGreaterThanOrEqual(
        Date.parse("2026-08-28T00:00:00Z"),
      );
    }
    expect(windowed.facts.length).toBeLessThan(
      (
        await asOwner(a.seat.companyId, (client) =>
          readOwnerTimeline(client, a.customer.entityId),
        )
      ).facts.length,
    );
  });

  it("resolves a name to candidates, ignoring case and accents", async () => {
    const found = await asOwner(a.seat.companyId, (client) =>
      resolveOwnerEntityByName(client, "  ana garcia "),
    );
    expect(found.map((e) => e.entityId)).toEqual([a.customer.entityId]);
  });

  it("resolves another company's cliente name to nothing", async () => {
    const found = await asOwner(a.seat.companyId, (client) =>
      resolveOwnerEntityByName(client, "Beatriz Lozano"),
    );
    expect(found).toEqual([]);
  });

  it("counts facts of one type, narrowed by seat and window", async () => {
    // The independent source of truth is the seed: Ana got one quote and
    // the two Torres records one each, and since ticket #132 the quote filed
    // AFTER the lift is visible too — so the company shows four, where it
    // showed three while every row the aperture filed was shadow.
    const counted = await asOwner(a.seat.companyId, (client) =>
      countOwnerFacts(client, { factType: "QuoteGiven" }),
    );
    expect(counted).toBe(4);

    const bySeat = await asOwner(a.seat.companyId, (client) =>
      countOwnerFacts(client, {
        factType: "QuoteGiven",
        seatId: a.seat.seatId,
      }),
    );
    expect(bySeat).toBe(4);

    const anotherSeat = await asOwner(a.seat.companyId, (client) =>
      countOwnerFacts(client, {
        factType: "QuoteGiven",
        seatId: b.seat.seatId,
      }),
    );
    expect(anotherSeat).toBe(0);
  });

  it("counts nothing of another company's, on the same role", async () => {
    const inB = await asOwner(b.seat.companyId, (client) =>
      countOwnerFacts(client, { factType: "QuoteGiven" }),
    );
    expect(inB).toBe(1);
  });

  it("returns a fact filed after the lift, which the stamp filed visible", async () => {
    // TURNED OVER BY TICKET #132, and this test's own note said it would be:
    // it used to assert that a fact filed after the lift stayed shadow,
    // "because the aperture stamps `shadow` unconditionally until #132". It
    // does not any more — it stamps from the company's mode — so the row a
    // lifted company files afterwards lands `shadow = false` and appears the
    // moment its correction window closes, with nobody touching it. That is
    // the half of ADR-0016's amendment a one-off `UPDATE` could not deliver.
    const timeline = await asOwner(a.seat.companyId, (client) =>
      readOwnerTimeline(client, a.customer.entityId),
    );
    const amounts = timeline.facts.map((f) => f.payload["amount"]);
    expect(amounts).toContain(CORPUS_AFTER_LIFT_AMOUNT);
    // ...and it is on the table unflagged, which is what the view is
    // reading. THE INVISIBILITY CLAIM DID NOT MOVE OUT OF THIS SUITE: it is
    // "still hides a fact whose company has not been lifted" above, over an
    // unlifted company — which since #132 is the only way a finalized fact
    // is shadow at all.
    const filed = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger.facts
        WHERE company_id = $1 AND shadow = false
          AND payload->>'amount' = $2`,
      [a.seat.companyId, String(CORPUS_AFTER_LIFT_AMOUNT)],
    );
    expect(Number(filed.rows[0]!.n)).toBe(1);
  });

  it("reads nothing at all when the connection declared no company", async () => {
    // TWO DIFFERENT SHAPES OF NOTHING, and both are correct. The list is
    // empty because the view is: the company policy filters every row, so
    // the merge filter in its WHERE clause is never reached. The timeline
    // REFUSES, because it asks the definer function before it has a row to
    // ask about — and a definer function with no tenant declared raises
    // rather than resolving against a company nobody named.
    const listed = await asOwner(null, (client) => listOwnerEntities(client));
    expect(listed).toEqual([]);

    const refused = await asOwner(null, async (client) => {
      try {
        await readOwnerTimeline(client, a.customer.entityId);
        return "ALLOWED";
      } catch (err) {
        return pgErrorCode(err);
      }
    });
    expect(refused).toBe("42501");
  });
});

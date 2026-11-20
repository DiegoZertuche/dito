/**
 * The shadow flag lifts per company (ticket #132; spec #126 decisions 9 and
 * 19; ADR-0016 as amended, ADR-0003, ADR-0020, ADR-0038).
 *
 * OBSERVED AT THE POSTGRES SEAM, which spec #126's testing decisions make
 * the input seam and this ticket's only one: facts and entities reach the
 * Ledger as they always have — a `wa_events` row the plane could have
 * delivered, the aperture filing from it, the real finalization writer
 * closing the correction window — and what is asserted is WHAT THE
 * FINALIZED VIEWS RETURN. Never the `shadow` column read straight off a
 * base table: the flag is not the claim, the owner's visibility is, and the
 * views are where ADR-0016 puts the filter.
 *
 * THE ACT IS DRIVEN THROUGH ITS OWN EXPORTED FUNCTION, never through a
 * hand-written `UPDATE` standing in for it. That is the same testing
 * decision, and it is also what makes the audit assertions mean anything:
 * an entry is owed by the act, so a test that wrote the two columns itself
 * would be asserting against a Ledger the writer never touched.
 *
 * THE VIEWS ARE DEFINER-RIGHTS (#127): they run as `dito_ledger_views`,
 * which is not a superuser, so the company policy applies even to this
 * suite's schema-owner connection. Every read below therefore DECLARES ITS
 * COMPANY, exactly as the owner app does — which is also what makes the
 * two-company isolation assertion a real one rather than a `WHERE` clause
 * the test wrote.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChainInDb } from "@dito/audit";
import {
  ShadowAlreadyLiftedError,
  ShadowLiftUnknownCompanyError,
  liftCompanyShadow,
} from "./shadow-lift.js";
import { APERTURE_ROLE } from "./grants.js";
import {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { TEST_AUDIT_HMAC_KEY } from "./testing/context.js";
import {
  boundTo,
  freshSeat,
  quote,
  type SeededCompany,
} from "./testing/ledger-fixtures.js";

/** The day the corpus is disclosed, and the day after, when it finalizes. */
const DISCLOSED_AT = new Date("2026-09-01T23:30:00Z");
const WINDOW_CLOSED = new Date("2026-09-03T00:00:00Z");
/** When the developer runs the act — after the window above has closed. */
const LIFTED_AT = new Date("2026-09-03T01:00:00Z");

let db: pg.Client;
const fixtures = boundTo(() => db);

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

/**
 * One company with a rep, a customer and two facts, disclosed and final —
 * and NOT lifted, because whether it is lifted is what every test here is
 * about. The seeding itself is `ledger-fixtures`', shared with the owner
 * suite so the two cannot drift into different Ledgers.
 */
async function seedCompany(names: {
  company: string;
  rep: string;
  customer: string;
}): Promise<SeededCompany> {
  return fixtures.seedCompany(names, DISCLOSED_AT, WINDOW_CLOSED);
}

/**
 * What the owner's own view returns for one company.
 *
 * The company is declared per read, because the finalized views are
 * definer-rights and the policy binds the role they run as: a session that
 * declares nothing reads nothing through them, superuser or not (#127).
 */
async function visibleFacts(companyId: string): Promise<string[]> {
  return fixtures.withDeclaredCompany(companyId, async () => {
    const res = await db.query<{ id: string }>(
      "SELECT id FROM ledger.finalized_facts ORDER BY id",
    );
    return res.rows.map((r) => r.id);
  });
}

async function visibleEntities(companyId: string): Promise<string[]> {
  return fixtures.withDeclaredCompany(companyId, async () => {
    const res = await db.query<{ entity_id: string }>(
      "SELECT entity_id FROM ledger.finalized_entities ORDER BY entity_id",
    );
    return res.rows.map((r) => r.entity_id);
  });
}

/** Every chain entry this act wrote, in order. */
async function liftEntries(): Promise<
  { caller: string; ref: string | null; outcome: string }[]
> {
  const res = await db.query<{
    caller: string;
    ref: string | null;
    outcome: string;
  }>(
    `SELECT caller, ref, outcome FROM audit_chain
      WHERE action = 'shadow_lift' ORDER BY id`,
  );
  return res.rows;
}

describe("the lift act (ADR-0016 as amended)", () => {
  it("makes a company's already-finalized facts and entities owner-visible", async () => {
    const corpus = await seedCompany({
      company: "Ferretería Fuentes",
      rep: "Mauricio Ríos",
      customer: "Constructora Vega",
    });
    // Filed, disclosed, corrected-window-closed — and invisible, because
    // the company's Ledger has never been lifted.
    expect(await visibleFacts(corpus.seat.companyId)).toEqual([]);
    expect(await visibleEntities(corpus.seat.companyId)).toEqual([]);

    const result = await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: corpus.seat.companyId, now: LIFTED_AT },
    );

    expect(result).toEqual({
      companyId: corpus.seat.companyId,
      liftedAt: LIFTED_AT,
      entities: 1,
      facts: 2,
    });
    expect(await visibleFacts(corpus.seat.companyId)).toEqual(
      [...corpus.factIds].sort(),
    );
    expect(await visibleEntities(corpus.seat.companyId)).toEqual([
      corpus.entityId,
    ]);
  });

  it("refuses a second run on the same company, and writes nothing", async () => {
    const corpus = await seedCompany({
      company: "Aceros del Bajío",
      rep: "Job Hernández",
      customer: "Talleres Ruiz",
    });
    const ctx = { db, hmacKey: TEST_AUDIT_HMAC_KEY };
    await liftCompanyShadow(ctx, {
      companyId: corpus.seat.companyId,
      now: LIFTED_AT,
    });
    const entriesAfterTheAct = await liftEntries();

    const again = new Date("2026-09-04T09:00:00Z");
    const refusal = await liftCompanyShadow(ctx, {
      companyId: corpus.seat.companyId,
      now: again,
    }).catch((err: unknown) => err);

    // A CLEAR MESSAGE is half of the acceptance criterion, so it is asserted
    // rather than assumed: the refusal names the company and the instant the
    // gate really opened, which is what an operator who lost the first run's
    // output needs and what "already lifted" alone would not tell them.
    expect(refusal).toBeInstanceOf(ShadowAlreadyLiftedError);
    expect((refusal as ShadowAlreadyLiftedError).message).toContain(
      corpus.seat.companyId,
    );
    expect((refusal as ShadowAlreadyLiftedError).message).toContain(
      LIFTED_AT.toISOString(),
    );
    expect((refusal as ShadowAlreadyLiftedError).liftedAt).toEqual(LIFTED_AT);

    // WRITES NOTHING is the acceptance criterion, and it has two halves: the
    // instant on the registry row is still the FIRST one — a launch gate
    // opens once, and a second run must not restate when it opened — and the
    // chain grew by nothing at all.
    const registry = await db.query<{ shadow_lifted_at: Date }>(
      "SELECT shadow_lifted_at FROM companies WHERE id = $1",
      [corpus.seat.companyId],
    );
    expect(registry.rows[0]?.shadow_lifted_at).toEqual(LIFTED_AT);
    expect(await liftEntries()).toEqual(entriesAfterTheAct);
  });

  it("refuses a company that was never registered, and says which one", async () => {
    // A DIFFERENT REFUSAL FROM THE ONE ABOVE, on purpose: this is a mistyped
    // id or a rig whose seed script has not run, and collapsing it into
    // "already lifted" or into a silent no-op would let a typo read as a
    // launched company.
    const stranger = freshSeat();
    const refusal = await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: stranger.companyId, now: LIFTED_AT },
    ).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ShadowLiftUnknownCompanyError);
    expect((refusal as Error).message).toContain(
      `no company ${stranger.companyId} is registered`,
    );
    expect(
      (await liftEntries()).some((e) => e.ref?.includes(stranger.companyId)),
    ).toBe(false);
  });

  it("chains the company id the way the store spells it, whatever the operator typed", async () => {
    // A UUID HAS MANY SPELLINGS AND ONE CANONICAL ONE (Codex r3). An
    // operator pasting capitals would otherwise put that spelling into an
    // APPEND-ONLY chain entry, while the coverage check derives its token
    // from `uuid::text` — lowercase — and matches case-sensitively: the
    // lift would succeed, the chain would verify, and the coverage check
    // would report the act missing forever, with no second run allowed to
    // repair it.
    const corpus = await seedCompany({
      company: "Maderas Ontiveros",
      rep: "Fabián Godoy",
      customer: "Carpintería Sauces",
    });
    const shouted = corpus.seat.companyId.toUpperCase();
    expect(shouted).not.toBe(corpus.seat.companyId);

    const result = await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: shouted },
    );

    expect(result.companyId).toBe(corpus.seat.companyId);
    const written = (await liftEntries()).filter((e) =>
      e.ref?.includes(corpus.seat.companyId),
    );
    expect(written).toHaveLength(1);
    expect(written[0]!.ref).not.toContain(shouted);
    expect(await visibleFacts(corpus.seat.companyId)).toEqual(
      [...corpus.factIds].sort(),
    );
  });

  it("lifts one company and leaves the other where it was", async () => {
    // TENANT ISOLATION AT THE ACT, which is not observable with one company:
    // the flip is scoped by `company_id`, and the only way to see that is a
    // second company sitting beside the first with its own corpus.
    const a = await seedCompany({
      company: "Distribuidora Poniente",
      rep: "Lucía Márquez",
      customer: "Abarrotes El Puente",
    });
    const b = await seedCompany({
      company: "Refacciones Sur",
      rep: "Ernesto Padilla",
      customer: "Taller Hidalgo",
    });

    await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: a.seat.companyId, now: LIFTED_AT },
    );

    expect(await visibleFacts(a.seat.companyId)).toEqual(
      [...a.factIds].sort(),
    );
    expect(await visibleFacts(b.seat.companyId)).toEqual([]);
    expect(await visibleEntities(b.seat.companyId)).toEqual([]);
    const bRegistry = await db.query<{ shadow_lifted_at: Date | null }>(
      "SELECT shadow_lifted_at FROM companies WHERE id = $1",
      [b.seat.companyId],
    );
    expect(bRegistry.rows[0]?.shadow_lifted_at).toBeNull();
  });

  it("lets the database stamp the instant when the caller names none", async () => {
    // WHAT PRODUCTION DOES (Codex r2). `rig-lift-shadow.ts` passes no time
    // at all: the transaction that makes a company's Ledger readable is a
    // database transaction, so the store writes `now()` — the ticket's own
    // wording — and the act reports what the registry actually holds rather
    // than echoing an argument back.
    //
    // It also closes the one way the one-shot state could be corrupted: an
    // untyped caller handing `null` would otherwise write the registry's
    // UNLIFTED sentinel while flipping the rows and chaining the act, and
    // the company would then be liftable again. Absent and null both take
    // the database's clock.
    const corpus = await seedCompany({
      company: "Lácteos Robledo",
      rep: "Marisol Ocampo",
      customer: "Cremería Delgado",
    });
    const before = new Date();
    const result = await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: corpus.seat.companyId },
    );

    expect(result.liftedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 60_000,
    );
    const registry = await db.query<{ shadow_lifted_at: Date | null }>(
      "SELECT shadow_lifted_at FROM companies WHERE id = $1",
      [corpus.seat.companyId],
    );
    expect(registry.rows[0]?.shadow_lifted_at).toEqual(result.liftedAt);
    // ...and the company is really lifted, so the act refuses a second run
    // rather than accepting one over a NULL sentinel.
    await expect(
      liftCompanyShadow(
        { db, hmacKey: TEST_AUDIT_HMAC_KEY },
        { companyId: corpus.seat.companyId },
      ),
    ).rejects.toThrow(ShadowAlreadyLiftedError);
    expect(await visibleFacts(corpus.seat.companyId)).toEqual(
      [...corpus.factIds].sort(),
    );
  });

  it("writes exactly one content-free chain entry, naming the company and the counts", async () => {
    const corpus = await seedCompany({
      company: "Plásticos del Norte",
      rep: "Rosario Beltrán",
      customer: "Empaques Lira",
    });
    const before = (await liftEntries()).length;

    const result = await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: corpus.seat.companyId, now: LIFTED_AT },
    );

    const written = (await liftEntries()).filter((e) =>
      e.ref?.includes(corpus.seat.companyId),
    );
    expect((await liftEntries()).length).toBe(before + 1);
    expect(written).toEqual([
      {
        caller: "aperture",
        ref: `company:${corpus.seat.companyId} entities:1 facts:2`,
        outcome: "lifted",
      },
    ]);
    expect(result.entities).toBe(1);
    expect(result.facts).toBe(2);
    // CONTENT-FREE (ADR-0020), asserted rather than described: the customer
    // this company filed facts about is named nowhere in the entry, and
    // neither is the rep.
    expect(written[0]!.ref).not.toContain(corpus.entityId);
    for (const factId of corpus.factIds) {
      expect(written[0]!.ref).not.toContain(factId);
    }

    // ...and the chain still verifies across the act, under this run's key.
    const verified = await verifyAuditChainInDb(db, TEST_AUDIT_HMAC_KEY);
    expect(verified.valid).toBe(true);
    expect(verified.entries).toBeGreaterThan(0);
  });
});

/** A customer chat nobody else in this suite is using. */
function freshChat(): string {
  return `52155${Math.floor(Math.random() * 1e7)}@s.whatsapp.net`;
}

/** Resolves after `ms`, so a test can observe that something is WAITING. */
function after(ms: number): Promise<"waiting"> {
  return new Promise((resolve) => setTimeout(() => resolve("waiting"), ms));
}

/**
 * The lift and a crossing in flight (ticket #132, Codex r1).
 *
 * THE FAILURE THESE EXIST FOR: the stamp is a snapshot read, so without the
 * company-scoped lock a filing could read «unlifted», the act could flip
 * everything it can see and commit, and the filing could then commit a
 * `shadow = true` row into a LIFTED company — invisible to its owner
 * forever, with nothing to say so and no second run to repair it, because
 * the act refuses to run twice.
 *
 * Both orders are driven deterministically over TWO CONNECTIONS, with the
 * slower half held open inside its own transaction: nothing here sleeps and
 * hopes.
 */
describe("the lift and a crossing in flight", () => {
  it("makes a crossing that starts mid-lift wait, and files it visible", async () => {
    const corpus = await seedCompany({
      company: "Cementos Ibarra",
      rep: "Noé Estrada",
      customer: "Constructora Lerma",
    });
    const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    try {
      // The act inside a caller's open transaction takes a SAVEPOINT rather
      // than committing, so this holds the company's exclusive lock exactly
      // as a real lift holds it between its first statement and its commit.
      await other.query("BEGIN");
      await liftCompanyShadow(
        { db: other, hmacKey: TEST_AUDIT_HMAC_KEY },
        { companyId: corpus.seat.companyId, now: LIFTED_AT },
      );

      const filing = fixtures.quote(
        corpus.seat,
        corpus.entityId,
        freshChat(),
        7700,
      );
      expect(
        await Promise.race([filing.then(() => "filed" as const), after(300)]),
      ).toBe("waiting");

      await other.query("COMMIT");
      const factId = await filing;
      await fixtures.discloseAndFinalize(
        corpus.seat,
        new Date("2026-09-03T02:00:00Z"),
        new Date("2026-09-04T03:00:00Z"),
      );
      expect(await visibleFacts(corpus.seat.companyId)).toContain(factId);
    } finally {
      await other.end();
    }
  });

  it("makes the lift wait for a crossing already in flight, and flips it too", async () => {
    const corpus = await seedCompany({
      company: "Papelera Quiroz",
      rep: "Sofía Bermúdez",
      customer: "Imprenta del Valle",
    });
    const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      const inFlight = await quote(
        other,
        corpus.seat,
        corpus.entityId,
        freshChat(),
        5200,
      );

      const lift = liftCompanyShadow(
        { db, hmacKey: TEST_AUDIT_HMAC_KEY },
        { companyId: corpus.seat.companyId, now: LIFTED_AT },
      );
      expect(
        await Promise.race([lift.then(() => "lifted" as const), after(300)]),
      ).toBe("waiting");

      await other.query("COMMIT");
      const result = await lift;
      // THREE, not two: the row that was still uncommitted when the operator
      // typed the command is flipped with the rest of them.
      expect(result.facts).toBe(3);
      await fixtures.discloseAndFinalize(
        corpus.seat,
        new Date("2026-09-03T02:00:00Z"),
        new Date("2026-09-04T03:00:00Z"),
      );
      expect(await visibleFacts(corpus.seat.companyId)).toContain(inFlight);
    } finally {
      await other.end();
    }
  });
});

describe("filing after the lift (ADR-0016 as amended: stamped at filing)", () => {
  it("files a later fact visible, so it appears the moment its window closes", async () => {
    // THE HALF THE ONE-OFF `UPDATE` COULD NOT DO, and the reason ADR-0016's
    // amendment rejects one: "the steering surface goes stale the next day,
    // when new facts arrive shadow". Nobody touches this fact after the act,
    // and it is owner-visible as soon as it finalizes.
    const corpus = await seedCompany({
      company: "Herrajes Camacho",
      rep: "Verónica Salas",
      customer: "Constructora Ébano",
    });
    await liftCompanyShadow(
      { db, hmacKey: TEST_AUDIT_HMAC_KEY },
      { companyId: corpus.seat.companyId, now: LIFTED_AT },
    );

    const laterChat = freshChat();
    const laterCustomer = await fixtures.bindCustomer(
      corpus.seat,
      "Vidrios Anáhuac",
    );
    const laterFact = await fixtures.quote(
      corpus.seat,
      laterCustomer,
      laterChat,
      9800,
    );

    // Filed but not yet final: the correction window is the other condition
    // the view asks for, and lifting does not shorten it (ADR-0004).
    expect(await visibleFacts(corpus.seat.companyId)).toEqual(
      [...corpus.factIds].sort(),
    );

    await fixtures.discloseAndFinalize(
      corpus.seat,
      new Date("2026-09-03T02:00:00Z"),
      new Date("2026-09-04T03:00:00Z"),
    );

    expect(await visibleFacts(corpus.seat.companyId)).toEqual(
      [...corpus.factIds, laterFact].sort(),
    );
    // ...and the entity the rep bound after the lift, likewise: entities
    // carry the same flag and the same stamp (ADR-0016).
    expect(await visibleEntities(corpus.seat.companyId)).toEqual(
      [corpus.entityId, laterCustomer].sort(),
    );
  });

  it("keeps filing for a company no registry row names, and keeps it invisible", async () => {
    // THE RULE THE STAMP RESTS ON, and it is not a defensive default: the
    // registries arrived with #127 and every company that filed before them
    // has no row, so an unregistered company is UNLIFTED BY DEFINITION. A
    // bare subquery would yield NULL and break the NOT NULL column for every
    // one of them, which is why the stamp coalesces to `true`.
    const stranger = freshSeat();
    const entityId = await fixtures.bindCustomer(stranger, "Cristales Toledo");
    const factId = await fixtures.quote(stranger, entityId, freshChat(), 3100);
    await fixtures.discloseAndFinalize(
      stranger,
      new Date("2026-09-03T02:00:00Z"),
      new Date("2026-09-04T03:00:00Z"),
    );

    expect(factId).toBeTruthy();
    expect(await visibleFacts(stranger.companyId)).toEqual([]);
    expect(await visibleEntities(stranger.companyId)).toEqual([]);
  });
});

describe("the aperture's own reach into the registry (ticket #132's migration)", () => {
  it("reads a company's mode and is refused when it tries to set one", async () => {
    // THE ASYMMETRY THE MIGRATION ARGUES FOR, asserted rather than described.
    // Every rep-side process connects as the superuser schema owner today, so
    // this is the only place the grant and the policy are actually exercised
    // as `dito_aperture` — `SET ROLE` drops the superuser's bypass, which is
    // what makes both halves real. It is what #115 will find when the
    // aperture becomes a connection of its own.
    const corpus = await seedCompany({
      company: "Tornillería Zamora",
      rep: "Ignacio Peña",
      customer: "Muebles Castro",
    });
    await db.query(`SET ROLE ${APERTURE_ROLE}`);
    try {
      const read = await db.query<{ shadow_lifted_at: Date | null }>(
        "SELECT shadow_lifted_at FROM companies WHERE id = $1",
        [corpus.seat.companyId],
      );
      expect(read.rows).toEqual([{ shadow_lifted_at: null }]);

      // ...and the launch gate is not the writer's to open. 42501 is
      // insufficient_privilege: the SELECT-only grant refuses this before
      // any policy is consulted.
      const wrote = await db
        .query("UPDATE companies SET shadow_lifted_at = now() WHERE id = $1", [
          corpus.seat.companyId,
        ])
        .then(
          () => "ACCEPTED",
          (err: unknown) => pgErrorCode(err),
        );
      expect(wrote).toBe("42501");
    } finally {
      await db.query("RESET ROLE");
    }
  });
});

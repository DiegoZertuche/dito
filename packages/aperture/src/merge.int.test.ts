/**
 * Merge, at the seam (ticket #55; spec #48 grilling decision 11; ADR-0035,
 * ADR-0036, ADR-0003 as amended, ADR-0004).
 *
 * Two records of the same customer become one, automatically, and nobody is
 * asked. Every test here seeds ORDINARY TRAFFIC — `wa_events` rows for two
 * chats, whose `ContactEstablished` payloads go through the real aperture —
 * and then asks what the Ledger holds. Nothing constructs a merge by hand
 * except where the point is to prove the store refuses it.
 *
 * What is being verified is not "the merge happened" but that it is
 * REVERSIBLE BY CONSTRUCTION: the edge is immutable, the effect set is
 * recorded at merge time, facts never move, and both ids stay resolvable
 * forever. That is what makes it safe to merge without asking anyone
 * (ADR-0036), so those are the assertions that carry the weight.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileFr72 } from "./fr72.js";
import { TEST_AUDIT_HMAC_KEY } from "./testing/context.js";
import {
  fileMerge,
  MergeAlreadyRecordedError,
  MergeCycleError,
  readEntityMerges,
  readResolvedTimeline,
  resolveEntity,
  runMergeMatcher,
} from "./merge.js";
import {
  readEntityGrants,
  readFiledEntity,
  readFiledFacts,
} from "./reads.js";
import {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { boundTo, type Seat } from "./testing/ledger-fixtures.js";

let db: pg.Client;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

/**
 * The seeding fixtures live in `testing/ledger-fixtures.ts` (#62), shared
 * with the unmerge suite so the two cannot drift into seeding subtly
 * different Ledgers. Bound to this file's client here, so every call site
 * below reads exactly as it did when they were local.
 */
const {
  freshSeat,
  bindCustomer,
  establishContact,
  quote,
  promise,
  grantOwnerAssigned,
  countFacts,
  countGrants,
  countDisclosureLines,
} = boundTo(() => db);

describe("two records of the same customer become one (ADR-0035)", () => {
  it("merges on a shared RFC, stamped machine, with the loser still standing and still resolvable", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    // Two chats the rep bound separately — the same customer, twice.
    const first = await bindCustomer(seat, "Ferretería Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const second = await bindCustomer(seat, "Fuentes, Ferretería", {
      confirmedAt: new Date("2026-08-27T10:00:00Z"),
    });
    await establishContact(seat, first, "5215559101@s.whatsapp.net", {
      rfcs: ["FUE850101AB1"],
    });
    await establishContact(seat, second, "5215559102@s.whatsapp.net", {
      rfcs: ["fue850101ab1"],
    });

    const report = await runMergeMatcher(ctx, { companyId: seat.companyId });

    expect(report.merged).toHaveLength(1);
    const edge = report.merged[0]!;
    // Survivorship is a WRITTEN RULE, not whichever row came back first:
    // the older `created_at` wins, so the first record of the customer is
    // the one that survives.
    expect(edge.winnerEntityId).toBe(first);
    expect(edge.loserEntityId).toBe(second);
    expect(edge.status).toBe("merged");
    expect(edge.performedBy).toBe("machine");
    expect(edge.matchedOn).toBe("rfc");

    // The loser keeps its row...
    const loser = await readFiledEntity(ctx, {
      companyId: seat.companyId,
      entityId: second,
    });
    expect(loser?.displayName).toBe("Fuentes, Ferretería");
    // ...and its id stays resolvable forever.
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: second }),
    ).resolves.toBe(first);
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: first }),
    ).resolves.toBe(first);
  });

  it("records the effect set at merge time — the thing that cannot be reconstructed afterwards", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const winner = await bindCustomer(seat, "Aceros del Norte", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const loser = await bindCustomer(seat, "Aceros Norte", {
      confirmedAt: new Date("2026-08-27T10:00:00Z"),
    });
    const winnerFact = await establishContact(
      seat,
      winner,
      "5215559111@s.whatsapp.net",
      { emails: ["Ventas@AcerosNorte.MX"] },
    );
    const loserFact = await establishContact(
      seat,
      loser,
      "5215559112@s.whatsapp.net",
      { emails: ["ventas@acerosnorte.mx"] },
    );

    const report = await runMergeMatcher(ctx, { companyId: seat.companyId });
    const edge = report.merged[0]!;
    expect(edge.matchedOn).toBe("email");
    expect(edge.effectSet.matchedValue).toBe("ventas@acerosnorte.mx");
    expect(edge.effectSet.winner.entityId).toBe(winner);
    expect(edge.effectSet.winner.factIds).toEqual([winnerFact]);
    expect(edge.effectSet.loser.entityId).toBe(loser);
    expect(edge.effectSet.loser.factIds).toEqual([loserFact]);
    // The grants each side held at merge time. Later grants and later
    // facts change both sides, which is exactly why this is recorded.
    expect(edge.effectSet.loser.grants).toEqual([
      { entityId: loser, twinId: seat.twinId, source: "creation" },
    ]);

    // A fact filed AFTER the merge does not retroactively join the effect
    // set: the edge is immutable and says what was true when it was made.
    await quote(seat, loser, "5215559112@s.whatsapp.net", 4500);
    const [reread] = await readEntityMerges(ctx, seat.companyId);
    expect(reread!.effectSet.loser.factIds).toEqual([loserFact]);
  });

  it("breaks a survivorship tie by id, so one Ledger always produces the same edges", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    // Two confirmations at the same instant: a real state, and one random
    // UUIDs give no order to. The rule decides, not the query plan.
    const sameInstant = new Date("2026-08-21T09:00:00Z");
    const one = await bindCustomer(seat, "Refaccionaria Lupita", {
      confirmedAt: sameInstant,
    });
    const two = await bindCustomer(seat, "Lupita Refacciones", {
      confirmedAt: sameInstant,
    });
    await establishContact(seat, one, "5215559121@s.whatsapp.net", {
      rfcs: ["LUP900202CD2"],
    });
    await establishContact(seat, two, "5215559122@s.whatsapp.net", {
      rfcs: ["LUP900202CD2"],
    });

    const edge = (await runMergeMatcher(ctx, { companyId: seat.companyId }))
      .merged[0]!;
    const [expectedWinner, expectedLoser] = [one, two].sort();
    expect(edge.winnerEntityId).toBe(expectedWinner);
    expect(edge.loserEntityId).toBe(expectedLoser);
  });
});

describe("a matching name is never sufficient (ADR-0035)", () => {
  it("leaves two Ferretería Fuentes in different cities as two customers", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const monterrey = await bindCustomer(seat, "Ferretería Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const puebla = await bindCustomer(seat, "Ferretería Fuentes", {
      confirmedAt: new Date("2026-08-21T10:00:00Z"),
    });
    // Both carry identifiers, so both are records the ladder can see. What
    // they share is only the name.
    await establishContact(seat, monterrey, "5215559131@s.whatsapp.net", {
      rfcs: ["FFM880303EF3"],
      emails: ["compras@ffmonterrey.mx"],
    });
    await establishContact(seat, puebla, "5215559132@s.whatsapp.net", {
      rfcs: ["FFP880404GH4"],
      emails: ["compras@ffpuebla.mx"],
    });

    const report = await runMergeMatcher(ctx, { companyId: seat.companyId });
    expect(report.merged).toEqual([]);
    expect(report.entitiesConsidered).toBe(2);
    // Both records persist, and each still resolves to itself.
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: monterrey }),
    ).resolves.toBe(monterrey);
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: puebla }),
    ).resolves.toBe(puebla);
  });
});

describe("the phone rung carries its extra condition (ADR-0035)", () => {
  /** A number belonging to neither conversation — a switchboard, as written. */
  const SWITCHBOARD = "55 5555 0000";

  it("merges two records of the same kind that share a phone", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const first = await bindCustomer(seat, "Distribuidora Sur", {
      kind: "business",
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const second = await bindCustomer(seat, "Distribuidora del Sur", {
      kind: "business",
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(seat, first, "5215559201@s.whatsapp.net", {
      phones: [SWITCHBOARD],
    });
    await establishContact(seat, second, "5215559202@s.whatsapp.net", {
      phones: [`+52 ${SWITCHBOARD}`],
    });

    const report = await runMergeMatcher(ctx, { companyId: seat.companyId });
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]!.matchedOn).toBe("phone");
    expect(report.merged[0]!.effectSet.matchedValue).toBe("+525555550000");
    expect(report.merged[0]!.loserEntityId).toBe(second);
  });

  it("refuses to fuse a person and a business reachable on one switchboard, and says so", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const business = await bindCustomer(seat, "Distribuidora Norte", {
      kind: "business",
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const person = await bindCustomer(seat, "Marisol Fuentes", {
      kind: "person",
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(seat, business, "5215559211@s.whatsapp.net", {
      phones: ["55 4444 0000"],
    });
    await establishContact(seat, person, "5215559212@s.whatsapp.net", {
      phones: ["55 4444 0000"],
    });

    const report = await runMergeMatcher(ctx, { companyId: seat.companyId });
    expect(report.merged).toEqual([]);
    // A merge that silently does not happen is the failure nobody notices.
    expect(report.skipped).toContainEqual({
      reason: "kind_mismatch",
      matchedOn: "phone",
      matchedValue: "+525544440000",
      entityIds: [business, person].sort(),
    });
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: person }),
    ).resolves.toBe(person);
  });
});

describe("the edge is never rewritten (ADR-0035)", () => {
  it("keeps A→B→C as two edges and answers C for A — the flattening MediaWiki removed", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const c = await bindCustomer(seat, "Tornillos Fuentes", {
      confirmedAt: new Date("2026-08-18T10:00:00Z"),
    });
    const b = await bindCustomer(seat, "Tornillos Fuentes SA", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const a = await bindCustomer(seat, "Fuentes Tornillos", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });

    // First A and B turn out to be one, on an email.
    await establishContact(seat, a, "5215559301@s.whatsapp.net", {
      emails: ["ventas@tornillosfuentes.mx"],
    });
    await establishContact(seat, b, "5215559302@s.whatsapp.net", {
      emails: ["ventas@tornillosfuentes.mx"],
    });
    expect(
      (await runMergeMatcher(ctx, { companyId: seat.companyId })).merged,
    ).toHaveLength(1);

    // ...and later B and C turn out to be one too, on a tax ID.
    await establishContact(seat, b, "5215559302@s.whatsapp.net", {
      rfcs: ["TOF910505IJ5"],
    });
    await establishContact(seat, c, "5215559303@s.whatsapp.net", {
      rfcs: ["TOF910505IJ5"],
    });
    expect(
      (await runMergeMatcher(ctx, { companyId: seat.companyId })).merged,
    ).toHaveLength(1);

    const edges = await readEntityMerges(ctx, seat.companyId);
    expect(
      edges.map((e) => `${e.loserEntityId}->${e.winnerEntityId}`),
    ).toEqual([`${a}->${b}`, `${b}->${c}`]);
    // The one thing not to do: an A→C edge is a merge nobody performed.
    expect(
      edges.some((e) => e.loserEntityId === a && e.winnerEntityId === c),
    ).toBe(false);
    // ...and the transitive answer is derived from the two that exist.
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: a }),
    ).resolves.toBe(c);

    // Running the ladder again files nothing: two records that already
    // resolve to one root are not two records.
    const again = await runMergeMatcher(ctx, { companyId: seat.companyId });
    expect(again.merged).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toContain("already_resolved");
    expect(await readEntityMerges(ctx, seat.companyId)).toHaveLength(2);
  });

  it("decides survivorship on a record's real age, even when it carries no live key of its own", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    // B is the oldest record and the one that must survive throughout.
    const b = await bindCustomer(seat, "Cortinas Fuentes", {
      confirmedAt: new Date("2026-08-16T10:00:00Z"),
    });
    const a = await bindCustomer(seat, "Fuentes Cortinas", {
      confirmedAt: new Date("2026-08-18T10:00:00Z"),
    });
    const c = await bindCustomer(seat, "Cortinas y Fuentes", {
      confirmedAt: new Date("2026-08-24T10:00:00Z"),
    });
    await establishContact(seat, a, "5215559321@s.whatsapp.net", {
      emails: ["hola@cortinasfuentes.mx"],
      rfcs: ["COF970707UV7"],
    });
    const bContact = await establishContact(seat, b, "5215559322@s.whatsapp.net", {
      emails: ["hola@cortinasfuentes.mx"],
    });
    await runMergeMatcher(ctx, { companyId: seat.companyId });

    // The rep corrects B's contact fact away. B is now a record with no
    // live match key at all — and still the oldest record there is.
    await db.query(
      "UPDATE ledger.facts SET retracted_at = now() WHERE id = $1",
      [bContact],
    );
    await establishContact(seat, c, "5215559323@s.whatsapp.net", {
      rfcs: ["COF970707UV7"],
    });

    // A resolves to B, so the pair on the tax ID is B and C — and B is
    // older. Reading age off the surviving RECORD rather than off whatever
    // fact happened to match is what makes that answer stable.
    const edge = (await runMergeMatcher(ctx, { companyId: seat.companyId }))
      .merged[0]!;
    expect(edge.winnerEntityId).toBe(b);
    expect(edge.loserEntityId).toBe(c);
  });

  it("files an id a caller names against its SURVIVING id, and records the component that id actually carries", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const b = await bindCustomer(seat, "Lonas Fuentes", {
      confirmedAt: new Date("2026-08-18T10:00:00Z"),
    });
    const a = await bindCustomer(seat, "Fuentes Lonas", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const c = await bindCustomer(seat, "Lonas F.", {
      confirmedAt: new Date("2026-08-24T10:00:00Z"),
    });
    const aFact = await quote(seat, a, "5215559341@s.whatsapp.net", 300);
    await fileMerge(ctx, {
      companyId: seat.companyId,
      loserEntityId: a,
      winnerEntityId: b,
      status: "merged",
      performedBy: "machine",
      matchedOn: "rfc",
      matchedValue: "LOF980808WX8",
    });

    // A caller names customers, not rows — and the id it names may already
    // have merged. Taken at face value, this edge would name A as the
    // winner while C actually resolves to B, and its effect set would
    // describe A's component rather than the one C joined (Codex r3).
    const edge = await fileMerge(ctx, {
      companyId: seat.companyId,
      loserEntityId: c,
      winnerEntityId: a,
      status: "merged",
      performedBy: "human",
    });
    expect(edge.winnerEntityId).toBe(b);
    expect(edge.loserEntityId).toBe(c);
    expect([...edge.effectSet.winner.memberEntityIds].sort()).toEqual(
      [a, b].sort(),
    );
    expect(edge.effectSet.winner.factIds).toContain(aFact);
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: c }),
    ).resolves.toBe(b);
    // ...and the chain that already existed is untouched: two edges, never
    // one restated.
    expect(await readEntityMerges(ctx, seat.companyId)).toHaveLength(2);
  });

  it("refuses a merge of two ids that already resolve together — they are one customer already", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const winner = await bindCustomer(seat, "Toldos Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const loser = await bindCustomer(seat, "Fuentes Toldos", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await fileMerge(ctx, {
      companyId: seat.companyId,
      loserEntityId: loser,
      winnerEntityId: winner,
      status: "merged",
      performedBy: "machine",
      matchedOn: "rfc",
      matchedValue: "TOF990101AA1",
    });

    await expect(
      fileMerge(ctx, {
        companyId: seat.companyId,
        loserEntityId: loser,
        winnerEntityId: winner,
        status: "merged",
        performedBy: "machine",
        matchedOn: "email",
        matchedValue: "hola@toldosfuentes.mx",
      }),
    ).rejects.toBeInstanceOf(MergeAlreadyRecordedError);
    expect(await readEntityMerges(ctx, seat.companyId)).toHaveLength(1);
  });

  it("records the whole component a chained merge carried, not just the two rows named on the edge", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const other = freshSeat(seat.companyId);
    const c = await bindCustomer(seat, "Rejas Fuentes", {
      confirmedAt: new Date("2026-08-16T10:00:00Z"),
    });
    const b = await bindCustomer(seat, "Rejas Fuentes SA", {
      confirmedAt: new Date("2026-08-18T10:00:00Z"),
    });
    const a = await bindCustomer(seat, "Fuentes Rejas", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    await establishContact(seat, a, "5215559331@s.whatsapp.net", {
      emails: ["hola@rejasfuentes.mx"],
    });
    await establishContact(seat, b, "5215559332@s.whatsapp.net", {
      emails: ["hola@rejasfuentes.mx"],
    });
    await runMergeMatcher(ctx, { companyId: seat.companyId });

    // A goes on collecting facts and grants AFTER it stopped being a root —
    // and they read forward through B, so the next merge carries them.
    const lateFact = await quote(seat, a, "5215559331@s.whatsapp.net", 2200);
    await grantOwnerAssigned(seat.companyId, a, other.twinId);

    await establishContact(seat, b, "5215559332@s.whatsapp.net", {
      rfcs: ["REF960909YZ9"],
    });
    await establishContact(seat, c, "5215559333@s.whatsapp.net", {
      rfcs: ["REF960909YZ9"],
    });
    const second = (await runMergeMatcher(ctx, { companyId: seat.companyId }))
      .merged[0]!;

    expect(second.loserEntityId).toBe(b);
    expect(second.winnerEntityId).toBe(c);
    // The loser side of the second merge is B AND everything reading
    // forward through it — which is the only record of what that merge
    // actually did, once A's grant is revoked.
    expect([...second.effectSet.loser.memberEntityIds].sort()).toEqual(
      [a, b].sort(),
    );
    expect(second.effectSet.loser.factIds).toContain(lateFact);
    expect(second.effectSet.loser.grants).toContainEqual({
      entityId: a,
      twinId: other.twinId,
      source: "owner_assigned",
    });
  });

  it("refuses an UPDATE or a DELETE of a filed edge — reversal is another append, never an erasure", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const winner = await bindCustomer(seat, "Plomería Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const loser = await bindCustomer(seat, "Fuentes Plomería", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(seat, winner, "5215559311@s.whatsapp.net", {
      rfcs: ["PLF920606KL6"],
    });
    await establishContact(seat, loser, "5215559312@s.whatsapp.net", {
      rfcs: ["PLF920606KL6"],
    });
    const edge = (await runMergeMatcher(ctx, { companyId: seat.companyId }))
      .merged[0]!;

    await expect(
      db.query("UPDATE ledger.entity_merges SET status = $1 WHERE id = $2", [
        "created_in_error",
        edge.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query("DELETE FROM ledger.entity_merges WHERE id = $1", [edge.id]),
    ).rejects.toThrow(/immutable/);
  });
});

describe("a cycle is refused loudly (ADR-0035)", () => {
  async function twoMerged(seat: Seat, rfc: string): Promise<[string, string]> {
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const winner = await bindCustomer(seat, "Cristales Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const loser = await bindCustomer(seat, "Fuentes Cristales", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(seat, winner, "5215559401@s.whatsapp.net", {
      rfcs: [rfc],
    });
    await establishContact(seat, loser, "5215559402@s.whatsapp.net", {
      rfcs: [rfc],
    });
    await runMergeMatcher(ctx, { companyId: seat.companyId });
    return [winner, loser];
  }

  it("refuses the edge that would close the ring", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const [winner, loser] = await twoMerged(seat, "CRF930707MN7");
    await expect(
      fileMerge(ctx, {
        companyId: seat.companyId,
        loserEntityId: winner,
        winnerEntityId: loser,
        status: "merged",
        performedBy: "machine",
        matchedOn: "rfc",
        matchedValue: "CRF930707MN7",
      }),
    ).rejects.toBeInstanceOf(MergeCycleError);
    expect(await readEntityMerges(ctx, seat.companyId)).toHaveLength(1);
  });

  it("refuses a record merged into itself", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const only = await bindCustomer(seat, "Vidrios Fuentes");
    await expect(
      fileMerge(ctx, {
        companyId: seat.companyId,
        loserEntityId: only,
        winnerEntityId: only,
        status: "merged",
        performedBy: "machine",
        matchedOn: "rfc",
        matchedValue: "VIF940808OP8",
      }),
    ).rejects.toBeInstanceOf(MergeCycleError);
  });

  it("refuses the ring even when both halves are written at once, from two connections", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const one = await bindCustomer(seat, "Espejos Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const two = await bindCustomer(seat, "Fuentes Espejos", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });

    // The race the reachability check cannot see on its own: under READ
    // COMMITTED neither transaction sees the other's uncommitted edge, and
    // the unique index does not collide because their LOSERS differ. Both
    // would commit, and the graph would hold a ring the mandatory check was
    // supposed to make unrepresentable (Codex r1).
    const other = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    try {
      const insert = (client: pg.ClientBase, loser: string, winner: string) =>
        client.query(
          `INSERT INTO ledger.entity_merges
             (company_id, loser_entity_id, winner_entity_id, status,
              performed_by, matched_on, effect_set)
           VALUES ($1, $2, $3, 'merged', 'human', NULL, '{}'::jsonb)`,
          [seat.companyId, loser, winner],
        );
      const outcomes = await Promise.allSettled([
        (async () => {
          await db.query("BEGIN");
          await insert(db, one, two);
          await db.query("COMMIT");
        })(),
        (async () => {
          await other.query("BEGIN");
          await insert(other, two, one);
          await other.query("COMMIT");
        })(),
      ]);
      // Exactly one survives, whichever won the lock.
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === "rejected");
      expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/cycle/);
    } finally {
      await db.query("ROLLBACK").catch(() => undefined);
      await other.query("ROLLBACK").catch(() => undefined);
      await other.end();
    }

    // ...and the survivor's resolution still terminates.
    const edges = await readEntityMerges(ctx, seat.companyId);
    expect(edges).toHaveLength(1);
    await expect(
      resolveEntity(ctx, {
        companyId: seat.companyId,
        entityId: edges[0]!.loserEntityId,
      }),
    ).resolves.toBe(edges[0]!.winnerEntityId);
  });

  it("refuses it in the store too, so no path can produce a walk that does not terminate", async () => {
    const seat = freshSeat();
    const [winner, loser] = await twoMerged(seat, "CRF950909QR9");
    // Straight at the table, past the writer entirely — a repair script, a
    // future human verb, a hand-run statement.
    let code: string | undefined;
    try {
      await db.query(
        `INSERT INTO ledger.entity_merges
           (company_id, loser_entity_id, winner_entity_id, status,
            performed_by, matched_on, effect_set)
         VALUES ($1, $2, $3, 'merged', 'human', NULL, '{}'::jsonb)`,
        [seat.companyId, winner, loser],
      );
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe("23514");
  });
});

describe("a merge never moves or deduplicates facts (ADR-0035)", () => {
  it("keeps two reps' identical promises as two assertions with separate provenance", async () => {
    const companyId = randomUUID();
    const ana = freshSeat(companyId);
    const beto = freshSeat(companyId);
    const ctx = { db, dek: ana.dek, hmacKey: TEST_AUDIT_HMAC_KEY };

    const anaEntity = await bindCustomer(ana, "Ferretería Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const betoEntity = await bindCustomer(beto, "Ferretería Fuentes", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(ana, anaEntity, "5215559501@s.whatsapp.net", {
      rfcs: ["FUE850101AB1"],
    });
    await establishContact(beto, betoEntity, "5215559502@s.whatsapp.net", {
      rfcs: ["FUE850101AB1"],
    });
    // The same promise, filed by two reps from two conversations. Both are
    // true, and each carries its own provenance.
    const anaPromise = await promise(ana, anaEntity, "5215559501@s.whatsapp.net");
    const betoPromise = await promise(
      beto,
      betoEntity,
      "5215559502@s.whatsapp.net",
    );

    const factsBefore = await countFacts(companyId);
    await runMergeMatcher(ctx, { companyId });
    expect(await countFacts(companyId)).toBe(factsBefore);

    // Facts never move: each still names the record it was filed against.
    const anaFacts = await readFiledFacts(ctx, ana.twinId);
    expect(anaFacts.every((f) => f.entityId === anaEntity)).toBe(true);
    const betoFacts = await readFiledFacts({ db, dek: beto.dek }, beto.twinId);
    expect(betoFacts.every((f) => f.entityId === betoEntity)).toBe(true);

    // ...and a reader the owner has granted both sides sees BOTH promises.
    await grantOwnerAssigned(companyId, betoEntity, ana.twinId);
    const timeline = await readResolvedTimeline(ctx, {
      companyId,
      entityId: betoEntity,
      twinId: ana.twinId,
    });
    expect(timeline.entityId).toBe(anaEntity);
    expect([...timeline.memberEntityIds].sort()).toEqual(
      [anaEntity, betoEntity].sort(),
    );
    const promises = timeline.facts.filter((f) => f.factType === "DatePromised");
    expect(promises.map((f) => f.id).sort()).toEqual(
      [anaPromise, betoPromise].sort(),
    );
  });
});

describe("a merge is not privilege escalation (ADR-0035)", () => {
  it("never hands one rep another rep's facts, and creates no grant at all", async () => {
    const companyId = randomUUID();
    const ana = freshSeat(companyId);
    const beto = freshSeat(companyId);
    const anaCtx = { db, dek: ana.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const betoCtx = { db, dek: beto.dek };

    const anaEntity = await bindCustomer(ana, "Herrería Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const betoEntity = await bindCustomer(beto, "Fuentes Herrería", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(ana, anaEntity, "5215559601@s.whatsapp.net", {
      emails: ["contacto@herreriafuentes.mx"],
    });
    await establishContact(beto, betoEntity, "5215559602@s.whatsapp.net", {
      emails: ["contacto@herreriafuentes.mx"],
    });
    const anaQuote = await quote(ana, anaEntity, "5215559601@s.whatsapp.net", 4500);
    const betoQuote = await quote(
      beto,
      betoEntity,
      "5215559602@s.whatsapp.net",
      9800,
    );

    const grantsBefore = await countGrants(companyId);
    const merged = (await runMergeMatcher(anaCtx, { companyId })).merged;
    expect(merged).toHaveLength(1);
    // The merge writes no grant. Nothing about who may read what changed.
    expect(await countGrants(companyId)).toBe(grantsBefore);
    expect(await readEntityGrants(anaCtx, { companyId, entityId: anaEntity }))
      .toEqual([
        expect.objectContaining({ twinId: ana.twinId, source: "creation" }),
      ]);
    expect(await readEntityGrants(anaCtx, { companyId, entityId: betoEntity }))
      .toEqual([
        expect.objectContaining({ twinId: beto.twinId, source: "creation" }),
      ]);

    // Ana asks for the surviving record and sees ONLY what her own
    // conversation filed — never Beto's, however the records were merged.
    const anaTimeline = await readResolvedTimeline(anaCtx, {
      companyId,
      entityId: anaEntity,
      twinId: ana.twinId,
    });
    expect([...anaTimeline.memberEntityIds].sort()).toEqual(
      [anaEntity, betoEntity].sort(),
    );
    expect(anaTimeline.facts.map((f) => f.id)).toContain(anaQuote);
    expect(anaTimeline.facts.map((f) => f.id)).not.toContain(betoQuote);
    expect(anaTimeline.facts.every((f) => f.entityId === anaEntity)).toBe(true);

    // ...and Beto, whose record is now the loser, still reads his own —
    // through the surviving id, and no further.
    const betoTimeline = await readResolvedTimeline(betoCtx, {
      companyId,
      entityId: betoEntity,
      twinId: beto.twinId,
    });
    expect(betoTimeline.entityId).toBe(anaEntity);
    expect(betoTimeline.facts.map((f) => f.id)).toContain(betoQuote);
    expect(betoTimeline.facts.map((f) => f.id)).not.toContain(anaQuote);

    // Cross-rep reading stays owner-assigned and deliberate.
    await grantOwnerAssigned(companyId, betoEntity, ana.twinId);
    const widened = await readResolvedTimeline(anaCtx, {
      companyId,
      entityId: anaEntity,
      twinId: ana.twinId,
    });
    expect(widened.facts.map((f) => f.id)).toContain(betoQuote);
  });
});

describe("the two statuses mean opposite things for reading forward (ADR-0035)", () => {
  it("resolves a created_in_error id but does not read its facts forward", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const real = await bindCustomer(seat, "Pinturas Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const mistake = await bindCustomer(seat, "Pinturas Fuentes", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    const realQuote = await quote(seat, real, "5215559701@s.whatsapp.net", 1200);
    const mistakeQuote = await quote(
      seat,
      mistake,
      "5215559702@s.whatsapp.net",
      1300,
    );

    await fileMerge(ctx, {
      companyId: seat.companyId,
      loserEntityId: mistake,
      winnerEntityId: real,
      status: "created_in_error",
      performedBy: "human",
    });

    // The id still resolves — no reference anywhere dangles.
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: mistake }),
    ).resolves.toBe(real);
    // ...and its facts stop at the edge.
    const timeline = await readResolvedTimeline(ctx, {
      companyId: seat.companyId,
      entityId: mistake,
      twinId: seat.twinId,
    });
    expect(timeline.memberEntityIds).toEqual([real]);
    expect(timeline.facts.map((f) => f.id)).toEqual([realQuote]);
    expect(timeline.facts.map((f) => f.id)).not.toContain(mistakeQuote);
  });
});

/**
 * THE EDGE'S VOCABULARY, PINNED (#54's warning, carried here).
 *
 * A sibling ticket re-cut a shared CHECK from the wrong ancestor and silently
 * dropped a value another branch had added — nothing failed, because a
 * narrower value set is still a valid constraint. Three branches off #52 are
 * merged by hand, so a narrowing resolution is a real way to lose one of
 * these words with no test going red.
 *
 * This states the WHOLE set for every CHECK on the merge edge, read from the
 * live catalog. Adding a value is one line here; losing one is a failure.
 */
describe("the merge edge's vocabulary (ADR-0035)", () => {
  const EXPECTED: Readonly<Record<string, readonly string[]>> = {
    ledger_entity_merges_status_check: ["created_in_error", "merged"],
    ledger_entity_merges_performed_by_check: ["human", "machine"],
    ledger_entity_merges_matched_on_check: ["email", "phone", "rfc"],
  };

  it("carries exactly the values ADR-0035 names, and a merge cannot be filed outside them", async () => {
    const res = await db.query<{ conname: string; definition: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger' AND t.relname = 'entity_merges'
          AND c.contype = 'c'`,
    );
    const byName = new Map(res.rows.map((r) => [r.conname, r.definition]));
    for (const [name, values] of Object.entries(EXPECTED)) {
      const definition = byName.get(name);
      expect(definition, `${name} is gone from the store`).toBeDefined();
      const quoted = [...definition!.matchAll(/'([a-z_]+)'/gu)]
        .map((m) => m[1]!)
        .sort();
      expect(
        [...new Set(quoted)],
        `${name} no longer allows exactly ${values.join(", ")} — a narrowed value set is still a valid constraint, which is why it is stated here`,
      ).toEqual([...values]);
    }
  });
});

describe("a struck-out record decides nothing (ADR-0035)", () => {
  it("does not lend its identifiers to the survivor it merged into", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const real = await bindCustomer(seat, "Techos Fuentes", {
      confirmedAt: new Date("2026-08-18T10:00:00Z"),
    });
    const mistake = await bindCustomer(seat, "Techos Fuentes (dup)", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const unrelated = await bindCustomer(seat, "Techos del Bajío", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    // The struck record carries an email. So does an unrelated customer.
    // The survivor carries neither.
    await establishContact(seat, mistake, "5215559901@s.whatsapp.net", {
      emails: ["ventas@proveedor.mx"],
    });
    await establishContact(seat, unrelated, "5215559902@s.whatsapp.net", {
      emails: ["ventas@proveedor.mx"],
    });
    await fileMerge(ctx, {
      companyId: seat.companyId,
      loserEntityId: mistake,
      winnerEntityId: real,
      status: "created_in_error",
      performedBy: "human",
    });

    // A record that should never have existed must not go on deciding that
    // two real customers are one, on a key neither of them ever carried.
    const report = await runMergeMatcher(ctx, { companyId: seat.companyId });
    expect(report.merged).toEqual([]);
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: unrelated }),
    ).resolves.toBe(unrelated);
    await expect(
      resolveEntity(ctx, { companyId: seat.companyId, entityId: real }),
    ).resolves.toBe(real);
  });
});

describe("a creation grant is self-scoped (CONTEXT.md, Grant)", () => {
  it("returns only what that rep's own conversation filed, on an entity two reps file against", async () => {
    const companyId = randomUUID();
    const ana = freshSeat(companyId);
    const beto = freshSeat(companyId);
    const anaCtx = { db, dek: ana.dek, hmacKey: TEST_AUDIT_HMAC_KEY };

    const entityId = await bindCustomer(ana, "Cancelería Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const anaQuote = await quote(ana, entityId, "5215559911@s.whatsapp.net", 700);
    // The owner points Beto at the same customer, and he files against it.
    await grantOwnerAssigned(companyId, entityId, beto.twinId);
    const betoQuote = await quote(beto, entityId, "5215559912@s.whatsapp.net", 800);

    // Ana holds the CREATION grant, which is self-scoped: binding a chat is
    // not a claim on everything anyone will ever file against that customer.
    const anaTimeline = await readResolvedTimeline(anaCtx, {
      companyId,
      entityId,
      twinId: ana.twinId,
    });
    expect(anaTimeline.facts.map((f) => f.id)).toContain(anaQuote);
    expect(anaTimeline.facts.map((f) => f.id)).not.toContain(betoQuote);

    // Beto's is owner-assigned, which is exactly what lets one rep read
    // what another filed.
    // `{ db }` and no key: the resolved read is Ledger-side, like the
    // matcher, and the type says so.
    const betoTimeline = await readResolvedTimeline(
      { db },
      { companyId, entityId, twinId: beto.twinId },
    );
    expect(betoTimeline.facts.map((f) => f.id).sort()).toEqual(
      [anaQuote, betoQuote].sort(),
    );
  });
});

describe("a merge is not disclosed (ADR-0003 as amended)", () => {
  it("files no fact and no disclosure line — it rearranges what already crossed", async () => {
    const seat = freshSeat();
    const ctx = { db, dek: seat.dek, hmacKey: TEST_AUDIT_HMAC_KEY };
    const winner = await bindCustomer(seat, "Maderas Fuentes", {
      confirmedAt: new Date("2026-08-20T10:00:00Z"),
    });
    const loser = await bindCustomer(seat, "Fuentes Maderas", {
      confirmedAt: new Date("2026-08-22T10:00:00Z"),
    });
    await establishContact(seat, winner, "5215559801@s.whatsapp.net", {
      rfcs: ["MAF960101ST1"],
    });
    await establishContact(seat, loser, "5215559802@s.whatsapp.net", {
      rfcs: ["MAF960101ST1"],
    });

    const linesBefore = await countDisclosureLines(seat.companyId);
    const factsBefore = await countFacts(seat.companyId);
    expect(
      (await runMergeMatcher(ctx, { companyId: seat.companyId })).merged,
    ).toHaveLength(1);
    expect(await countDisclosureLines(seat.companyId)).toBe(linesBefore);
    expect(await countFacts(seat.companyId)).toBe(factsBefore);
    // ...and FR-72's claim is untouched: a merge is not a crossing, so
    // there is nothing for the reconciliation to have missed.
    expect((await reconcileFr72(db)).violations).toEqual([]);
  });
});


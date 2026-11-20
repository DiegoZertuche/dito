/**
 * Unmerge, at the seam (ticket #62; ADR-0035, ADR-0036, ADR-0020,
 * ADR-0003 as amended, ADR-0004).
 *
 * ADR-0036 justifies merging without asking anyone by appealing to
 * reversibility — "automation that cannot be undone does not get to skip
 * the human; automation that can be undone should." What slice 3 shipped
 * was UNDOABLE DATA, NOT AN UNDO. This suite is the undo.
 *
 * The whole mechanism is one sentence: a merge redirects at READ time,
 * through `ledger.resolve_entity`, and facts are filed against the entity
 * they were filed against and stay there — so an unmerge is DEACTIVATING
 * THE REDIRECT and nothing else. Every fact falls back where it always
 * was, because it never left. That is why the crux that defeats Reltio and
 * Informatica — who owns facts written AFTER the merge — does not arise
 * here at all, and it is what these tests assert over and over.
 *
 * Everything is observed through the aperture's public surface — the same
 * seam the merge suite uses. Nothing here asks the edge table what it
 * holds except where the point is to prove the store refuses something.
 */
import { randomUUID } from "node:crypto";
import { verifyAuditChainInDb } from "@dito/audit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fileMerge,
  fileUnmerge,
  MergeAlreadyReversedError,
  MergeCycleError,
  MergeUnknownEdgeError,
  readEntityMerges,
  readResolvedTimeline,
  resolveEntity,
  runMergeMatcher,
} from "./merge.js";
import { auditChainCoverageInDb } from "./audit-coverage.js";
import { reconcileFr72 } from "./fr72.js";
import { readEntityGrants, readFiledFacts } from "./reads.js";
import {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { boundTo, type Seat } from "./testing/ledger-fixtures.js";
import { TEST_AUDIT_HMAC_KEY } from "./testing/context.js";

let db: pg.Client;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

/** The same bound set the merge suite drives, so both seed one Ledger. */
const {
  freshSeat,
  bindCustomer,
  establishContact,
  quote,
  grantOwnerAssigned,
  countFacts,
  countGrants,
  countDisclosureLines,
} = boundTo(() => db);

/** The operator's context: a Postgres client and the chain key, no twin DEK. */
function unmergeCtx() {
  return { db, hmacKey: TEST_AUDIT_HMAC_KEY };
}

/**
 * Two records of one customer, merged automatically on a shared tax ID —
 * the ordinary case, and the one an unmerge has to be able to take back.
 */
async function mergedPair(
  seat: Seat,
  rfc: string,
  chatSuffix: number,
): Promise<{ winner: string; loser: string; mergeId: string }> {
  const winner = await bindCustomer(seat, "Ferretería Fuentes", { confirmedAt: new Date("2026-08-20T10:00:00Z") });
  const loser = await bindCustomer(seat, "Fuentes, Ferretería", { confirmedAt: new Date("2026-08-27T10:00:00Z") });
  await establishContact(seat, winner, `52155596${chatSuffix}1@s.whatsapp.net`, {
    rfcs: [rfc],
  });
  await establishContact(seat, loser, `52155596${chatSuffix}2@s.whatsapp.net`, {
    rfcs: [rfc],
  });
  const report = await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId });
  expect(report.merged).toHaveLength(1);
  const edge = report.merged[0]!;
  expect(edge.winnerEntityId).toBe(winner);
  expect(edge.loserEntityId).toBe(loser);
  return { winner, loser, mergeId: edge.id };
}

describe("an unmerge deactivates the redirect (ticket #62; ADR-0035, ADR-0036)", () => {
  it("makes the loser resolve to itself again, and stops the winner reading its facts forward", async () => {
    const seat = freshSeat();
    const { winner, loser, mergeId } = await mergedPair(seat, "FUE850101AB1", 1);
    const loserQuote = await quote(seat, loser, "5215559612@s.whatsapp.net", 4500);
    const winnerQuote = await quote(seat, winner, "5215559611@s.whatsapp.net", 1200);

    // While the merge stands, the winner's timeline reads the loser's facts.
    const merged = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: winner, twinId: seat.twinId },
    );
    expect(merged.facts.map((f) => f.id)).toContain(loserQuote);

    const reversed = await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });
    expect(reversed.id).toBe(mergeId);
    expect(reversed.reversal?.performedBy).toBe("human");

    // The redirect is off: each id resolves to itself.
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: loser }),
    ).resolves.toBe(loser);
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: winner }),
    ).resolves.toBe(winner);

    // ...and the winner's timeline no longer reads the loser's facts.
    const split = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: winner, twinId: seat.twinId },
    );
    expect(split.memberEntityIds).toEqual([winner]);
    expect(split.facts.map((f) => f.id)).toContain(winnerQuote);
    expect(split.facts.map((f) => f.id)).not.toContain(loserQuote);

    // The loser's own timeline is its own again — every fact it ever had,
    // still on the id it was filed against.
    const back = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: loser, twinId: seat.twinId },
    );
    expect(back.entityId).toBe(loser);
    expect(back.facts.map((f) => f.id)).toContain(loserQuote);
  });
});

describe("the merge edge is never mutated (ticket #62; ADR-0035)", () => {
  it("appends the reversal and leaves the edge exactly as it was filed", async () => {
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE850202CD2", 2);
    const [before] = await readEntityMerges({ db }, seat.companyId);
    expect(before!.reversal).toBeNull();

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    const [after] = await readEntityMerges({ db }, seat.companyId);
    // Everything the edge said, it goes on saying: the store recorded the
    // merge that actually happened, and an undo that rewrote it would erase
    // the only evidence the automatic matcher was ever wrong.
    expect({ ...after!, reversal: null }).toEqual(before);
    expect(after!.reversal).not.toBeNull();
    // ...and the edge is still one edge. A reversal is not a second row on
    // this table wearing the other direction.
    expect(await readEntityMerges({ db }, seat.companyId)).toHaveLength(1);
  });

  it("refuses an UPDATE or a DELETE of the reversal itself — an undo that could be erased puts the graph somewhere nothing recorded", async () => {
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE850303EF3", 3);
    const edge = await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });
    const reversalId = edge.reversal!.id;

    await expect(
      db.query("UPDATE ledger.entity_unmerges SET performed_by = $1 WHERE id = $2", [
        "machine",
        reversalId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query("DELETE FROM ledger.entity_unmerges WHERE id = $1", [reversalId]),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses a second reversal of one edge — a merge either stands or it does not", async () => {
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE850404GH4", 4);
    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });
    await expect(
      fileUnmerge(unmergeCtx(), {
        companyId: seat.companyId,
        mergeId,
        performedBy: "human",
      }),
    ).rejects.toBeInstanceOf(MergeAlreadyReversedError);
  });

  it("refuses to reverse a merge another company recorded — a bare id never addresses a row", async () => {
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE850505IJ5", 5);
    await expect(
      fileUnmerge(unmergeCtx(), {
        companyId: randomUUID(),
        mergeId,
        performedBy: "human",
      }),
    ).rejects.toBeInstanceOf(MergeUnknownEdgeError);
  });
});

describe("no fact moves, is deleted, or is reassigned (ticket #62; ADR-0035)", () => {
  it("leaves every fact on the entity it was filed against — including facts filed AFTER the merge", async () => {
    const seat = freshSeat();
    const { winner, loser, mergeId } = await mergedPair(seat, "FUE850606KL6", 6);
    const filedBefore = await readFiledFacts({ db, dek: seat.dek }, seat.twinId);
    const onLoserBefore = filedBefore
      .filter((f) => f.entityId === loser)
      .map((f) => f.id)
      .sort();

    // The crux every MDM vendor fails on: a fact written AFTER the merge.
    // Reltio refuses to unmerge it and Informatica deletes it — and neither
    // problem arises here, because the fact already names its own entity.
    const afterMerge = await quote(seat, loser, "5215559662@s.whatsapp.net", 7700);
    const factsBefore = await countFacts(seat.companyId);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    expect(await countFacts(seat.companyId)).toBe(factsBefore);
    const filedAfter = await readFiledFacts({ db, dek: seat.dek }, seat.twinId);
    expect(filedAfter.map((f) => f.id).sort()).toEqual(
      filedBefore.map((f) => f.id).concat(afterMerge).sort(),
    );
    // Every id still names the entity it was filed against, the post-merge
    // one included.
    expect(
      filedAfter
        .filter((f) => f.entityId === loser)
        .map((f) => f.id)
        .sort(),
    ).toEqual([...onLoserBefore, afterMerge].sort());
    expect(filedAfter.every((f) => f.entityId === winner || f.entityId === loser))
      .toBe(true);
    // ...and the post-merge fact reads on the loser's own timeline now.
    const back = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: loser, twinId: seat.twinId },
    );
    expect(back.facts.map((f) => f.id)).toContain(afterMerge);
  });
});

describe("the reversal is audit-chained and stamped (ticket #62; ADR-0020, ADR-0035)", () => {
  it("names the aperture, the edge and the two records, with no content and a verifying chain", async () => {
    const seat = freshSeat();
    const { winner, loser, mergeId } = await mergedPair(seat, "FUE850707MN7", 7);
    const edge = await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    const entries = await db.query<{
      caller: string;
      action: string;
      ref: string;
      outcome: string;
    }>(
      `SELECT caller, action, ref, outcome
         FROM audit_chain
        WHERE action = 'entity_unmerge' AND ref LIKE '%' || $1 || '%'
        ORDER BY id`,
      [mergeId],
    );
    expect(entries.rows).toEqual([
      {
        caller: "aperture",
        action: "entity_unmerge",
        ref: `unmerge:${edge.reversal!.id} merge:${mergeId} loser:${loser} winner:${winner}`,
        outcome: "reversed",
      },
    ]);
    // The chain is whole after the append (ADR-0020).
    const verified = await verifyAuditChainInDb(db, TEST_AUDIT_HMAC_KEY);
    expect(verified.valid).toBe(true);
    expect(verified.entries).toBeGreaterThan(0);
  });

  it("chains the refusals too — a break-glass verb is where a refused attempt matters most", async () => {
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE851515CD3", 15);
    const bogus = randomUUID();

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });
    // The repeat the rig's hand trigger treats as already-done...
    await expect(
      fileUnmerge(unmergeCtx(), {
        companyId: seat.companyId,
        mergeId,
        performedBy: "human",
      }),
    ).rejects.toBeInstanceOf(MergeAlreadyReversedError);
    // ...and an operator naming an edge that is not there.
    await expect(
      fileUnmerge(unmergeCtx(), {
        companyId: seat.companyId,
        mergeId: bogus,
        performedBy: "human",
      }),
    ).rejects.toBeInstanceOf(MergeUnknownEdgeError);

    // Both landed, with their own outcomes — the typed error the caller
    // sees is not the chain rolling back.
    const outcomes = await db.query<{ outcome: string }>(
      `SELECT outcome FROM audit_chain
        WHERE action = 'entity_unmerge' AND ref LIKE '%' || $1 || '%'
        ORDER BY id`,
      [mergeId],
    );
    expect(outcomes.rows.map((r) => r.outcome)).toEqual([
      "reversed",
      "already_reversed",
    ]);
    const unknown = await db.query<{ ref: string; outcome: string }>(
      `SELECT ref, outcome FROM audit_chain
        WHERE action = 'entity_unmerge' AND ref LIKE '%' || $1 || '%'`,
      [bogus],
    );
    expect(unknown.rows).toEqual([
      { ref: `merge:${bogus}`, outcome: "refused:unknown_edge" },
    ]);
    expect((await verifyAuditChainInDb(db, TEST_AUDIT_HMAC_KEY)).valid).toBe(
      true,
    );
  });

  it("stores and reads back both halves of the human-or-machine stamp", async () => {
    const seat = freshSeat();
    const byHuman = await mergedPair(seat, "FUE850808OP8", 8);
    const byMachine = await mergedPair(seat, "FUE851414AB2", 14);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: byHuman.mergeId,
      performedBy: "human",
    });
    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: byMachine.mergeId,
      performedBy: "machine",
    });

    // Read back off the store rather than off the return value: the stamp is
    // what makes a claim about automation provable in the DATA (ADR-0035),
    // so what matters is that the row says it.
    const edges = await readEntityMerges({ db }, seat.companyId);
    const stampOf = (mergeId: string) =>
      edges.find((e) => e.id === mergeId)!.reversal!.performedBy;
    expect(stampOf(byHuman.mergeId)).toBe("human");
    expect(stampOf(byMachine.mergeId)).toBe("machine");
    // Nothing today writes `machine` on a reversal — no detector exists that
    // could reverse a merge on its own — exactly as nothing writes `human`
    // on the edge itself.
    expect(edges.every((e) => e.performedBy === "machine")).toBe(true);
  });

  it("is COVERED, not merely chained: a reversal filed past the aperture is reported (ticket #78)", async () => {
    // Integrity says nobody touched the entries that ARE here. Coverage is
    // the other half — that the acts which owed one have one — and a
    // reversal is one of the two acts on this surface with a row to join
    // against (ADR-0035: "The operator invokes it, audit-chained").
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE851616EF4", 16);
    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });
    const green = await auditChainCoverageInDb(db);
    expect(
      green.violations.filter((v) => v.class === "entity_unmerge_reversed"),
    ).toEqual([]);

    // THE FAILURE THE CHECK EXISTS FOR, in the shape it would actually
    // arrive: a second operator path that writes the reversal and forgets
    // the chain. Planted inside a transaction and rolled back, because the
    // store refuses UPDATE and DELETE on a reversal — an unremovable plant
    // would leave every later run of this invariant red.
    await db.query("BEGIN");
    try {
      const planted = await db.query<{ id: string }>(
        `INSERT INTO ledger.entity_unmerges (company_id, merge_id, performed_by)
         VALUES ($1, $2, 'machine') RETURNING id`,
        [seat.companyId, (await mergedPair(seat, "FUE851717GH5", 17)).mergeId],
      );
      const red = await auditChainCoverageInDb(db);
      expect(red.violations).toContainEqual({
        class: "entity_unmerge_reversed",
        subject: `entity_unmerge ${planted.rows[0]!.id}`,
        reason:
          "no `entity_unmerge` chain entry records this act (ADR-0020, spec #48 decision 18)",
      });
    } finally {
      await db.query("ROLLBACK");
    }

    expect(
      (await auditChainCoverageInDb(db)).violations.filter(
        (v) => v.class === "entity_unmerge_reversed",
      ),
    ).toEqual([]);
  });
});

describe("A→B→C unmerges at either edge (ticket #62; ADR-0035)", () => {
  /** Three records of one customer, chained the way the ladder chains them. */
  async function chain(
    seat: Seat,
  ): Promise<{ a: string; b: string; c: string; ab: string; bc: string }> {
    const c = await bindCustomer(seat, "Tornillos Fuentes", { confirmedAt: new Date("2026-08-18T10:00:00Z") });
    const b = await bindCustomer(seat, "Tornillos Fuentes SA", { confirmedAt: new Date("2026-08-20T10:00:00Z") });
    const a = await bindCustomer(seat, "Fuentes Tornillos", { confirmedAt: new Date("2026-08-22T10:00:00Z") });
    const ab = await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: a,
        winnerEntityId: b,
        status: "merged",
        performedBy: "machine",
        matchedOn: "email",
        matchedValue: "ventas@tornillosfuentes.mx",
      },
    );
    const bc = await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: b,
        winnerEntityId: c,
        status: "merged",
        performedBy: "machine",
        matchedOn: "rfc",
        matchedValue: "TOF910505IJ5",
      },
    );
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: a }),
    ).resolves.toBe(c);
    return { a, b, c, ab: ab.id, bc: bc.id };
  }

  it("takes back the FIRST edge, and the transitive answer rebuilds from the one that remains", async () => {
    const seat = freshSeat();
    const { a, b, c, ab } = await chain(seat);
    const aQuote = await quote(seat, a, "5215559671@s.whatsapp.net", 100);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: ab,
      performedBy: "human",
    });

    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: a }),
    ).resolves.toBe(a);
    // B→C is untouched and still answers for both of them.
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: b }),
    ).resolves.toBe(c);
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: c }),
    ).resolves.toBe(c);
    // Both edges are still on the record; one of them no longer stands.
    const edges = await readEntityMerges({ db }, seat.companyId);
    expect(edges).toHaveLength(2);
    expect(edges.filter((e) => e.reversal !== null).map((e) => e.id)).toEqual([ab]);
    // The surviving component rebuilt from the edge that remains: C reads B
    // forward and no longer reads A.
    const timeline = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: c, twinId: seat.twinId },
    );
    expect([...timeline.memberEntityIds].sort()).toEqual([b, c].sort());
    expect(timeline.facts.map((f) => f.id)).not.toContain(aQuote);
  });

  it("takes back the LAST edge, and the first still stands", async () => {
    const seat = freshSeat();
    const { a, b, c, bc } = await chain(seat);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: bc,
      performedBy: "human",
    });

    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: a }),
    ).resolves.toBe(b);
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: b }),
    ).resolves.toBe(b);
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: c }),
    ).resolves.toBe(c);
    const timeline = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: b, twinId: seat.twinId },
    );
    expect([...timeline.memberEntityIds].sort()).toEqual([a, b].sort());
  });

  it("records the component a LATER merge carries from the edges that still stand", async () => {
    const seat = freshSeat();
    const { a, b, c, ab } = await chain(seat);
    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: ab,
      performedBy: "human",
    });
    const d = await bindCustomer(seat, "Fuentes y Tornillos", { confirmedAt: new Date("2026-08-16T10:00:00Z") });

    // C joins D. The effect set is the record of what THIS merge did — and
    // A is no longer part of what C carries.
    const edge = await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: c,
        winnerEntityId: d,
        status: "merged",
        performedBy: "human",
      },
    );
    expect([...edge.effectSet.loser.memberEntityIds].sort()).toEqual(
      [b, c].sort(),
    );
    expect(edge.effectSet.loser.memberEntityIds).not.toContain(a);
  });
});

describe("the cycle check still holds (ticket #62; ADR-0035)", () => {
  it("refuses the ring while the edge stands, and lets the other direction be decided once it is taken back", async () => {
    const seat = freshSeat();
    const { winner, loser, mergeId } = await mergedPair(seat, "FUE850909QR9", 9);

    await expect(
      fileMerge(
        unmergeCtx(),
        {
          companyId: seat.companyId,
          loserEntityId: winner,
          winnerEntityId: loser,
          status: "merged",
          performedBy: "human",
        },
      ),
    ).rejects.toBeInstanceOf(MergeCycleError);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    // The ring is gone with the edge, so the operator may now decide the
    // OTHER direction — which is the case an undo exists for: the matcher
    // kept the wrong survivor.
    await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: winner,
        winnerEntityId: loser,
        status: "merged",
        performedBy: "human",
      },
    );
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: winner }),
    ).resolves.toBe(loser);
    // ...and the ring is refused again, now the other way round.
    await expect(
      fileMerge(
        unmergeCtx(),
        {
          companyId: seat.companyId,
          loserEntityId: loser,
          winnerEntityId: winner,
          status: "merged",
          performedBy: "human",
        },
      ),
    ).rejects.toBeInstanceOf(MergeCycleError);
  });

  it("still refuses a second out-edge for a loser that already points somewhere — straight at the table", async () => {
    const seat = freshSeat();
    const { loser } = await mergedPair(seat, "FUE851010ST1", 10);
    const third = await bindCustomer(seat, "Fuentes Tercero", { confirmedAt: new Date("2026-08-15T10:00:00Z") });

    // Past the writer entirely — a repair script, a hand-run statement.
    // …100050 held this with a unique index, which an unmerge had to give
    // up (a loser could then never merge again); the rule moved into the
    // trigger and is still the rule.
    let code: string | undefined;
    try {
      await db.query(
        `INSERT INTO ledger.entity_merges
           (company_id, loser_entity_id, winner_entity_id, status,
            performed_by, matched_on, effect_set)
         VALUES ($1, $2, $3, 'merged', 'human', NULL, '{}'::jsonb)`,
        [seat.companyId, loser, third],
      );
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe("23505");
  });
});

describe("re-merging after an unmerge (ticket #62; ADR-0035)", () => {
  it("files a NEW edge and never resurrects the reversed one", async () => {
    const seat = freshSeat();
    const { winner, loser, mergeId } = await mergedPair(seat, "FUE851111UV7", 11);
    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    const again = await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: loser,
        winnerEntityId: winner,
        status: "merged",
        performedBy: "human",
      },
    );
    expect(again.id).not.toBe(mergeId);
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: loser }),
    ).resolves.toBe(winner);

    const edges = await readEntityMerges({ db }, seat.companyId);
    expect(edges).toHaveLength(2);
    // The reversal stands: the first merge is still a merge that happened
    // and was taken back, and the second is a decision of its own.
    expect(edges.find((e) => e.id === mergeId)!.reversal).not.toBeNull();
    expect(edges.find((e) => e.id === again.id)!.reversal).toBeNull();
  });

  it("does not let the ladder redo what a human took back", async () => {
    const seat = freshSeat();
    const { winner, loser, mergeId } = await mergedPair(seat, "FUE851212WX8", 12);
    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    // The shared tax ID is still filed against both records — nothing about
    // the facts changed, because an unmerge moves nothing. Without this the
    // undo would last until the next daily pass and no longer.
    const report = await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId });
    expect(report.merged).toEqual([]);
    expect(report.skipped).toContainEqual({
      reason: "unmerge_standing",
      matchedOn: "rfc",
      matchedValue: "FUE851212WX8",
      entityIds: [loser, winner].sort(),
    });
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: loser }),
    ).resolves.toBe(loser);
  });

  it("keeps a reversed pair apart even after the other record has merged onward", async () => {
    const seat = freshSeat();
    // C is the oldest record; B merges into it later. A and B are the pair
    // somebody takes apart.
    const c = await bindCustomer(seat, "Rejas Fuentes", { confirmedAt: new Date("2026-08-16T10:00:00Z") });
    const b = await bindCustomer(seat, "Rejas Fuentes SA", { confirmedAt: new Date("2026-08-18T10:00:00Z") });
    const a = await bindCustomer(seat, "Fuentes Rejas", { confirmedAt: new Date("2026-08-20T10:00:00Z") });
    await establishContact(seat, a, "5215559721@s.whatsapp.net", {
      emails: ["hola@rejasfuentes.mx"],
    });
    await establishContact(seat, b, "5215559722@s.whatsapp.net", {
      emails: ["hola@rejasfuentes.mx"],
    });
    const ab = (await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId }))
      .merged[0]!;
    expect(ab.loserEntityId).toBe(a);
    expect(ab.winnerEntityId).toBe(b);

    await establishContact(seat, b, "5215559722@s.whatsapp.net", {
      rfcs: ["REJ960909YZ9"],
    });
    await establishContact(seat, c, "5215559723@s.whatsapp.net", {
      rfcs: ["REJ960909YZ9"],
    });
    expect(
      (await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId })).merged,
    ).toHaveLength(1);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: ab.id,
      performedBy: "human",
    });

    // A stands alone; B has moved on into C. The shared email is still
    // filed against A and B both, so the ladder's next candidate is A and
    // C — a DIFFERENT pair of ids that would put A back in exactly the
    // component it was taken out of. What a reversal says is that these two
    // RECORDS are not one customer, and a record is a component.
    const report = await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId });
    expect(report.merged).toEqual([]);
    expect(report.skipped).toContainEqual({
      reason: "unmerge_standing",
      matchedOn: "email",
      matchedValue: "hola@rejasfuentes.mx",
      entityIds: [a, c].sort(),
    });
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: a }),
    ).resolves.toBe(a);
  });
});

describe("an unmerge is not privilege escalation either (ticket #62; ADR-0035)", () => {
  it("gives nobody a read they did not have, and takes away no read they legitimately had", async () => {
    const companyId = randomUUID();
    const ana = freshSeat(companyId);
    const beto = freshSeat(companyId);

    const anaEntity = await bindCustomer(ana, "Herrería Fuentes", { confirmedAt: new Date("2026-08-20T10:00:00Z") });
    const betoEntity = await bindCustomer(beto, "Fuentes Herrería", { confirmedAt: new Date("2026-08-22T10:00:00Z") });
    await establishContact(ana, anaEntity, "5215559681@s.whatsapp.net", {
      emails: ["contacto@herreriafuentes.mx"],
    });
    await establishContact(beto, betoEntity, "5215559682@s.whatsapp.net", {
      emails: ["contacto@herreriafuentes.mx"],
    });
    const anaQuote = await quote(ana, anaEntity, "5215559681@s.whatsapp.net", 4500);
    const betoQuote = await quote(beto, betoEntity, "5215559682@s.whatsapp.net", 9800);
    const merged = await runMergeMatcher(unmergeCtx(), { companyId });
    expect(merged.merged).toHaveLength(1);
    const mergeId = merged.merged[0]!.id;

    // The owner points Ana at Beto's record on purpose — the only thing
    // that ever widens a read.
    await grantOwnerAssigned(companyId, betoEntity, ana.twinId);
    const before = await readResolvedTimeline(
      { db },
      { companyId, entityId: anaEntity, twinId: ana.twinId },
    );
    expect(before.facts.map((f) => f.id)).toContain(anaQuote);
    expect(before.facts.map((f) => f.id)).toContain(betoQuote);
    const anaGrantsBefore = await readEntityGrants({ db, dek: ana.dek }, {
      companyId,
      entityId: anaEntity,
    });
    const betoGrantsBefore = await readEntityGrants({ db, dek: ana.dek }, {
      companyId,
      entityId: betoEntity,
    });
    const grantsBefore = await countGrants(companyId);

    await fileUnmerge(unmergeCtx(), {
      companyId,
      mergeId,
      performedBy: "human",
    });

    // NOT ONE GRANT MOVED. They attach to the entity a fact was filed
    // against, and no fact changed entity — so there is nothing for an
    // unmerge to have rewritten.
    expect(await countGrants(companyId)).toBe(grantsBefore);
    expect(
      await readEntityGrants({ db, dek: ana.dek }, { companyId, entityId: anaEntity }),
    ).toEqual(anaGrantsBefore);
    expect(
      await readEntityGrants({ db, dek: ana.dek }, { companyId, entityId: betoEntity }),
    ).toEqual(betoGrantsBefore);

    // DIRECTION ONE — nothing widens. Beto holds a creation grant on his
    // own record and nothing else, and coming apart hands him none of
    // Ana's, on either id.
    const betoOnHisOwn = await readResolvedTimeline(
      { db },
      { companyId, entityId: betoEntity, twinId: beto.twinId },
    );
    expect(betoOnHisOwn.facts.map((f) => f.id)).toContain(betoQuote);
    expect(betoOnHisOwn.facts.map((f) => f.id)).not.toContain(anaQuote);
    const betoOnAnas = await readResolvedTimeline(
      { db },
      { companyId, entityId: anaEntity, twinId: beto.twinId },
    );
    expect(betoOnAnas.facts).toEqual([]);

    // DIRECTION TWO — nothing narrows. Ana's owner-assigned grant on
    // Beto's record is exactly as deliberate as it was, so she still reads
    // it; what changed is that the two records are two again, so she reads
    // it BY ASKING FOR IT rather than through Ana's own timeline.
    const anaOnBetos = await readResolvedTimeline(
      { db },
      { companyId, entityId: betoEntity, twinId: ana.twinId },
    );
    expect(anaOnBetos.entityId).toBe(betoEntity);
    expect(anaOnBetos.facts.map((f) => f.id)).toContain(betoQuote);
    const anaOnHerOwn = await readResolvedTimeline(
      { db },
      { companyId, entityId: anaEntity, twinId: ana.twinId },
    );
    expect(anaOnHerOwn.memberEntityIds).toEqual([anaEntity]);
    expect(anaOnHerOwn.facts.map((f) => f.id)).toContain(anaQuote);
    expect(anaOnHerOwn.facts.map((f) => f.id)).not.toContain(betoQuote);
    expect(anaOnHerOwn.facts.every((f) => f.entityId === anaEntity)).toBe(true);
  });
});

describe("created_in_error keeps meaning what it means (ticket #62; ADR-0035)", () => {
  /**
   * The two statuses mean OPPOSITE things for whether the loser's facts read
   * forward — which is what makes them worth telling apart at all, and what
   * a reversal has to preserve on both sides.
   */
  async function struckAndGenuine(seat: Seat) {
    const real = await bindCustomer(seat, "Pinturas Fuentes", { confirmedAt: new Date("2026-08-18T10:00:00Z") });
    const mistake = await bindCustomer(seat, "Pinturas Fuentes (dup)", { confirmedAt: new Date("2026-08-20T10:00:00Z") });
    const realQuote = await quote(seat, real, "5215559691@s.whatsapp.net", 1200);
    const mistakeQuote = await quote(seat, mistake, "5215559692@s.whatsapp.net", 1300);
    const edge = await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: mistake,
        winnerEntityId: real,
        status: "created_in_error",
        performedBy: "human",
      },
    );
    return { real, mistake, realQuote, mistakeQuote, mergeId: edge.id };
  }

  it("reads differently from a genuine same-customer merge, and reverses to a record in full standing", async () => {
    const seat = freshSeat();
    const { real, mistake, realQuote, mistakeQuote, mergeId } =
      await struckAndGenuine(seat);

    // BEFORE. The id resolves — no reference dangles — and the facts stop
    // at the edge. That is the whole difference from `merged`, where the
    // loser's facts read forward under the winner.
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: mistake }),
    ).resolves.toBe(real);
    const struck = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: mistake, twinId: seat.twinId },
    );
    expect(struck.memberEntityIds).toEqual([real]);
    expect(struck.facts.map((f) => f.id)).toEqual([realQuote]);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    // AFTER. Taking back a `created_in_error` merge is the statement that
    // the record should have existed after all, so it comes back in full
    // standing: its own id, its own facts, and the rep who filed them
    // reading them again — which is the read the merge had taken away and
    // the grant had never stopped covering.
    await expect(
      resolveEntity({ db }, { companyId: seat.companyId, entityId: mistake }),
    ).resolves.toBe(mistake);
    const restored = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: mistake, twinId: seat.twinId },
    );
    expect(restored.entityId).toBe(mistake);
    expect(restored.facts.map((f) => f.id)).toEqual([mistakeQuote]);
    // ...and the survivor keeps exactly what was always its own.
    const survivor = await readResolvedTimeline(
      { db },
      { companyId: seat.companyId, entityId: real, twinId: seat.twinId },
    );
    expect(survivor.facts.map((f) => f.id)).toEqual([realQuote]);
    // The edge still says what it said: a record struck out, not a merge.
    const edges = await readEntityMerges({ db }, seat.companyId);
    expect(edges.find((e) => e.id === mergeId)!.status).toBe("created_in_error");
  });

  it("decides nothing while it is struck out, and decides again once it is taken back", async () => {
    const seat = freshSeat();
    const real = await bindCustomer(seat, "Techos Fuentes", { confirmedAt: new Date("2026-08-18T10:00:00Z") });
    const mistake = await bindCustomer(seat, "Techos Fuentes (dup)", { confirmedAt: new Date("2026-08-20T10:00:00Z") });
    const unrelated = await bindCustomer(seat, "Techos del Bajío", { confirmedAt: new Date("2026-08-22T10:00:00Z") });
    // The struck record carries an email. So does an unrelated customer.
    // The survivor carries neither.
    await establishContact(seat, mistake, "5215559701@s.whatsapp.net", {
      emails: ["ventas@proveedor.mx"],
    });
    await establishContact(seat, unrelated, "5215559702@s.whatsapp.net", {
      emails: ["ventas@proveedor.mx"],
    });
    const edge = await fileMerge(
      unmergeCtx(),
      {
        companyId: seat.companyId,
        loserEntityId: mistake,
        winnerEntityId: real,
        status: "created_in_error",
        performedBy: "human",
      },
    );

    // A record that should never have existed decides nothing.
    expect(
      (await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId })).merged,
    ).toEqual([]);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId: edge.id,
      performedBy: "human",
    });

    // ...and once it is a record again, its identifiers are keys again.
    // The reversal binds the pair it separated and nothing else.
    const report = await runMergeMatcher(unmergeCtx(), { companyId: seat.companyId });
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]!.matchedOn).toBe("email");
    expect([
      report.merged[0]!.loserEntityId,
      report.merged[0]!.winnerEntityId,
    ].sort()).toEqual([mistake, unrelated].sort());
  });
});

describe("an unmerge is not disclosed (ticket #62; ADR-0003 as amended)", () => {
  it("files no fact and no disclosure line — it rearranges what already crossed", async () => {
    const seat = freshSeat();
    const { mergeId } = await mergedPair(seat, "FUE851313YZ9", 13);
    const linesBefore = await countDisclosureLines(seat.companyId);
    const factsBefore = await countFacts(seat.companyId);

    await fileUnmerge(unmergeCtx(), {
      companyId: seat.companyId,
      mergeId,
      performedBy: "human",
    });

    expect(await countDisclosureLines(seat.companyId)).toBe(
      linesBefore,
    );
    expect(await countFacts(seat.companyId)).toBe(factsBefore);
    // FR-72's claim is untouched: an unmerge is not a crossing, so there is
    // nothing for the reconciliation to have missed.
    expect((await reconcileFr72(db)).violations).toEqual([]);
  });
});

/**
 * THE REVERSAL'S VOCABULARY, PINNED (#54's warning, as the merge edge's is).
 *
 * Three branches off one ancestor are merged by hand, and a narrowing
 * resolution of a shared CHECK is a real way to lose a value with no test
 * going red — a narrower value set is still a valid constraint.
 */
describe("the reversal's vocabulary (ADR-0035)", () => {
  it("carries exactly human and machine, read from the live catalog", async () => {
    const res = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger' AND t.relname = 'entity_unmerges'
          AND c.conname = 'ledger_entity_unmerges_performed_by_check'`,
    );
    expect(res.rows).toHaveLength(1);
    const quoted = [...res.rows[0]!.definition.matchAll(/'([a-z_]+)'/gu)]
      .map((m) => m[1]!)
      .sort();
    expect([...new Set(quoted)]).toEqual(["human", "machine"]);
  });
});

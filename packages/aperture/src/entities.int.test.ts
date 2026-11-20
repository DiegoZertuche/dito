/**
 * The first crossing, tested across the primary Postgres seam (spec #48's
 * testing decisions: one seam, the same one slices 1 and 2 use). A rep act
 * goes in as a raw `wa_events` row; what appears on the other side — the
 * Ledger entity, its creation grant, and the rep-side disclosure line — is
 * read back the way a real reader would.
 *
 * Real Postgres, real envelope crypto (ADR-0028: the crypto path is never
 * mocked), zero model involvement — a model can never mint a rep act.
 *
 * Governing ADRs: 0003 (the single aperture writer, as amended), 0004,
 * 0016, 0034, 0035.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EntityIdCollisionError,
  fileEntityCreate,
  RepActNotEvidenceBoundError,
} from "./entities.js";
import {
  EntityKindUnknownEntityError,
  fileEntityKind,
} from "./entity-kind.js";
import {
  classifyApertureInput,
  // THE CONCRETE ARM, not the union: every claim in this file is about the
  // twin thread's evidence, and the callers read its `sourceEventId` back.
  type ThreadMessageEvidence,
} from "./inputs.js";
import { readFiledEntity } from "./reads.js";
import {
  insertWaEventFixture,
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
} from "./testing/db.js";
import { apertureCtx } from "./testing/context.js";

const SELF_CHAT = "5215550000@s.whatsapp.net";

let db: pg.Client;

beforeAll(async () => {
  await resetAndMigrate();
  db = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

interface Seat {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
}

function freshSeat(): Seat {
  return {
    twinId: randomUUID(),
    companyId: randomUUID(),
    seatId: randomUUID(),
    dek: createDekFromMaterial(randomBytes(32)),
  };
}

/** When the plane stamped the rep's «va» — the entity's valid time. */
const CONFIRMED_AT = new Date("2026-08-29T18:53:00Z");

/**
 * The rep's own «va» on the binding question, delivered raw by the plane —
 * the class-2 evidence an entity create must reference (ADR-0003).
 */
async function repConfirmation(
  seat: Seat,
  messageId: string,
  occurredAt: Date = CONFIRMED_AT,
): Promise<ThreadMessageEvidence> {
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: "va",
    quotedMessageId: "WAMID-QUESTION-1",
    occurredAt,
  });
  // TAGGED, because class-2 evidence is one of two surfaces (#224): this
  // helper is the twin thread's, which is the arm every claim in this file is
  // about.
  return { surface: "twin_thread", sourceEventId, waMessageId: messageId };
}

describe("the aperture files an entity create", () => {
  it("carries the client-minted id unchanged, scopes it to the company on the rep-act evidence, and writes the creating rep's grant", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-1");
    const entityId = randomUUID();

    const result = await fileEntityCreate(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        kind: "person",
        displayName: "Diego Zertuche",
        evidence,
        disclosureText: "Lo di de alta como cliente.",
      },
    );

    expect(result.filed).toBe(true);
    expect(result.entityId).toBe(entityId);
    expect(result.companyId).toBe(seat.companyId);

    const entity = await db.query(
      `SELECT company_id, entity_id, kind, display_name, created_at, shadow
         FROM ledger.entities WHERE entity_id = $1`,
      [entityId],
    );
    expect(entity.rows).toEqual([
      {
        company_id: seat.companyId,
        entity_id: entityId,
        kind: "person",
        display_name: "Diego Zertuche",
        // Valid time off the verified act, not off any caller's clock.
        created_at: CONFIRMED_AT,
        shadow: true,
      },
    ]);

    const grant = await db.query(
      `SELECT twin_id, source FROM ledger.entity_grants
        WHERE company_id = $1 AND entity_id = $2`,
      [seat.companyId, entityId],
    );
    expect(grant.rows).toEqual([
      { twin_id: seat.twinId, source: "creation" },
    ]);
  });

  it("writes the disclosure line in the same transaction, plaintext and rendered, bound to its rep-act evidence", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-2");
    const entityId = randomUUID();

    const result = await fileEntityCreate(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        kind: "business",
        displayName: "Ferretería Fuentes",
        evidence,
        disclosureText: "Lo di de alta como cliente.",
      },
    );

    const line = await db.query(
      `SELECT id, company_id, seat_id, twin_id, subject_kind, entity_id,
              fact_id, rendered_text, source_event_id
         FROM disclosure_lines WHERE id = $1`,
      [result.disclosureLineId],
    );
    expect(line.rows).toEqual([
      {
        id: result.disclosureLineId,
        company_id: seat.companyId,
        seat_id: seat.seatId,
        twin_id: seat.twinId,
        subject_kind: "entity_create",
        entity_id: entityId,
        fact_id: null,
        rendered_text: "Lo di de alta como cliente.",
        source_event_id: evidence.sourceEventId,
      },
    ]);
  });

  it("refuses a rep act whose evidence is not a rep-authored, raw plane-delivered message of this twin", async () => {
    const seat = freshSeat();
    // The counterparty's message, not the rep's: from_me is false.
    const notRepAuthored = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: "5215550001@s.whatsapp.net",
      senderJid: "5215550001@s.whatsapp.net",
      fromMe: false,
      messageId: "WAMID-CUSTOMER-1",
      text: "va",
    });

    await expect(
      fileEntityCreate(
        apertureCtx(db, seat.dek),
        {
          twinId: seat.twinId,
          entityId: randomUUID(),
          kind: "person",
          displayName: "Diego Zertuche",
          evidence: {
            surface: "twin_thread",
            sourceEventId: notRepAuthored,
            waMessageId: "WAMID-CUSTOMER-1",
          },
          disclosureText: "Lo di de alta como cliente.",
        },
      ),
    ).rejects.toThrow(RepActNotEvidenceBoundError);
  });
});

describe("the entity create and its disclosure line are one transaction", () => {
  it("rolls back the entity and its grant when the disclosure line fails", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-ROLLBACK");
    const entityId = randomUUID();

    await expect(
      fileEntityCreate(
        apertureCtx(db, seat.dek),
        {
          twinId: seat.twinId,
          entityId,
          kind: "person",
          displayName: "Diego Zertuche",
          evidence,
          // A line with nothing in it is not a disclosure: the CHECK
          // refuses it, which is the failure this test needs.
          disclosureText: "   ",
        },
      ),
    ).rejects.toThrow();

    const entity = await db.query(
      "SELECT 1 FROM ledger.entities WHERE entity_id = $1",
      [entityId],
    );
    expect(entity.rows).toEqual([]);
    const grant = await db.query(
      "SELECT 1 FROM ledger.entity_grants WHERE entity_id = $1",
      [entityId],
    );
    expect(grant.rows).toEqual([]);
  });

  it("cannot commit an entity that crossed without a disclosure line — FR-72 is a state the database will not hold", async () => {
    const seat = freshSeat();
    // The aperture's own write, minus its disclosure line: exactly the shape FR-72
    // exists to make impossible. Written straight at the table so the
    // refusal is the database's, not the aperture's.
    await db.query("BEGIN");
    let code: string | undefined;
    try {
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'person', 'Nadie', now())`,
        [seat.companyId, randomUUID()],
      );
      await db.query("COMMIT");
    } catch (err) {
      code = pgErrorCode(err);
      await db.query("ROLLBACK");
    }
    // raise_exception — the deferred FR-72 constraint trigger at COMMIT.
    expect(code).toBe("P0001");
  });

  it("holds the pair together inside a caller's own transaction too", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-NESTED");
    const entityId = randomUUID();

    await db.query("BEGIN");
    await fileEntityCreate(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        kind: "person",
        displayName: "Diego Zertuche",
        evidence,
        disclosureText: "Lo di de alta como cliente.",
      },
    );
    await db.query("ROLLBACK");

    const entity = await db.query(
      "SELECT 1 FROM ledger.entities WHERE entity_id = $1",
      [entityId],
    );
    const line = await db.query(
      "SELECT 1 FROM disclosure_lines WHERE entity_id = $1",
      [entityId],
    );
    expect(entity.rows).toEqual([]);
    expect(line.rows).toEqual([]);
  });
});

describe("the client-minted id is client-supplied data", () => {
  it("is idempotent on a repeat of the same create — one entity, one grant, one line", async () => {
    const seat = freshSeat();
    const first = await repConfirmation(seat, "WAMID-VA-REPEAT-1");
    const second = await repConfirmation(seat, "WAMID-VA-REPEAT-2");
    const entityId = randomUUID();
    const request = {
      twinId: seat.twinId,
      entityId,
      kind: "person" as const,
      displayName: "Diego Zertuche",
      disclosureText: "Lo di de alta como cliente.",
    };

    const a = await fileEntityCreate(
      apertureCtx(db, seat.dek),
      { ...request, evidence: first },
    );
    const b = await fileEntityCreate(
      apertureCtx(db, seat.dek),
      { ...request, evidence: second },
    );

    expect(a.filed).toBe(true);
    expect(b.filed).toBe(false);
    expect(b.disclosureLineId).toBe(a.disclosureLineId);

    const counts = await db.query<{
      entities: string;
      grants: string;
      lines: string;
    }>(
      `SELECT (SELECT count(*) FROM ledger.entities WHERE entity_id = $1) AS entities,
              (SELECT count(*) FROM ledger.entity_grants WHERE entity_id = $1) AS grants,
              (SELECT count(*) FROM disclosure_lines WHERE entity_id = $1) AS lines`,
      [entityId],
    );
    expect(counts.rows[0]).toEqual({ entities: "1", grants: "1", lines: "1" });
  });

  it("refuses a filed id offered again under a different name", async () => {
    const seat = freshSeat();
    const first = await repConfirmation(seat, "WAMID-VA-COLLIDE-1");
    const second = await repConfirmation(seat, "WAMID-VA-COLLIDE-2");
    const entityId = randomUUID();

    await fileEntityCreate(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        kind: "person",
        displayName: "Diego Zertuche",
        evidence: first,
        disclosureText: "Lo di de alta como cliente.",
      },
    );

    await expect(
      fileEntityCreate(
        apertureCtx(db, seat.dek),
        {
          twinId: seat.twinId,
          entityId,
          kind: "business",
          displayName: "Ferretería Fuentes",
          evidence: second,
          disclosureText: "Lo di de alta como cliente.",
        },
      ),
    ).rejects.toThrow(EntityIdCollisionError);
  });

  it("takes the company scope from the evidence row the plane stamped, never from the caller", async () => {
    // Two seats in two companies. The rep act belongs to seat B, so the
    // entity is company B's — there is no parameter through which a device
    // could say otherwise (ADR-0035).
    const seatA = freshSeat();
    const seatB = freshSeat();
    const evidence = await repConfirmation(seatB, "WAMID-VA-SCOPE");
    const entityId = randomUUID();

    const result = await fileEntityCreate(
      apertureCtx(db, seatB.dek),
      {
        twinId: seatB.twinId,
        entityId,
        kind: "person",
        displayName: "Diego Zertuche",
        evidence,
        disclosureText: "Lo di de alta como cliente.",
      },
    );

    expect(result.companyId).toBe(seatB.companyId);
    expect(result.companyId).not.toBe(seatA.companyId);
  });

  it("refuses a rep act cited by one twin against another twin's message", async () => {
    const seatA = freshSeat();
    const seatB = freshSeat();
    const evidence = await repConfirmation(seatB, "WAMID-VA-FOREIGN");

    await expect(
      fileEntityCreate(
        apertureCtx(db, seatA.dek),
        {
          twinId: seatA.twinId,
          entityId: randomUUID(),
          kind: "person",
          displayName: "Diego Zertuche",
          evidence,
          disclosureText: "Lo di de alta como cliente.",
        },
      ),
    ).rejects.toThrow(RepActNotEvidenceBoundError);
  });
});

describe("anything not evidence-bound is processed as class 1 (ADR-0003)", () => {
  it("demotes a fabricated event id — the shape injected model output would take", async () => {
    const seat = freshSeat();
    const input = await classifyApertureInput(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        // A model can emit any number it likes; it cannot put a row on the seam.
        evidence: { surface: "twin_thread", sourceEventId: "999999999", waMessageId: "WAMID-INVENTED" },
      },
    );
    expect(input.inputClass).toBe(1);
  });

  it("demotes junk in the event-id slot rather than crashing on it", async () => {
    const seat = freshSeat();
    for (const sourceEventId of ["", "abc", "1; DROP TABLE taps", "-1", "0"]) {
      const input = await classifyApertureInput(
        apertureCtx(db, seat.dek),
        {
          twinId: seat.twinId,
          evidence: { surface: "twin_thread", sourceEventId, waMessageId: "WAMID-JUNK" },
        },
      );
      expect(input.inputClass).toBe(1);
    }
  });

  it("demotes a real rep message cited under the wrong WA message id", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-MISMATCH");
    const input = await classifyApertureInput(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        evidence: {
          surface: "twin_thread",
          sourceEventId: evidence.sourceEventId,
          waMessageId: "WAMID-SOMETHING-ELSE",
        },
      },
    );
    expect(input.inputClass).toBe(1);
  });

  it("demotes backfilled history — a normalized blob is not an act the rep just performed", async () => {
    const seat = freshSeat();
    const sourceEventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: "WAMID-BACKFILL",
      text: "va",
      backfill: true,
    });
    const input = await classifyApertureInput(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        evidence: { surface: "twin_thread", sourceEventId, waMessageId: "WAMID-BACKFILL" },
      },
    );
    expect(input.inputClass).toBe(1);
  });

  it("promotes the rep's own live confirmation, and hands back the scope and instant the plane stamped", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-CLASS2");
    const input = await classifyApertureInput(
      apertureCtx(db, seat.dek),
      { twinId: seat.twinId, evidence },
    );
    expect(input).toEqual({
      inputClass: 2,
      repAct: {
        // THE SURFACE IS PART OF WHAT WAS VERIFIED (#224). A class-2 act can
        // arrive from the twin thread or from a card, and everything
        // downstream writes the evidence column that matches — so the tag
        // travels with the act rather than being re-derived from the shape of
        // the object, which is what an untagged union would force.
        surface: "twin_thread",
        sourceEventId: evidence.sourceEventId,
        waMessageId: "WAMID-VA-CLASS2",
        companyId: seat.companyId,
        seatId: seat.seatId,
        twinId: seat.twinId,
        chatJid: SELF_CHAT,
        occurredAt: CONFIRMED_AT,
      },
    });
  });
});

/**
 * THE KIND DETERMINATION (ticket #60; ADR-0035, ADR-0003 as amended).
 *
 * Every entity's `kind` is now something a determination made rather than
 * a default nobody chose — so some of them are wrong, and a wrong one
 * changes merge eligibility. These are the aperture's half: the correction
 * verb, what it may touch, and what it records.
 */
describe("a kind determination is recorded and correctable (ticket #60)", () => {
  it("corrects a kind the model got wrong, and touches nothing else about the entity", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-KIND-1");
    const entityId = randomUUID();
    await fileEntityCreate(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      // The model read «Ferretería Fuentes» as a person — the determination
      // this ticket exists to make, got wrong.
      kind: "person",
      displayName: "Ferretería Fuentes",
      evidence,
      disclosureText: "Lo di de alta como cliente.",
    });
    const before = await readFiledEntity(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
    });

    const outcome = await fileEntityKind(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
      kind: "business",
      determinedBy: "human",
    });

    expect(outcome).toEqual({
      entityId,
      kind: "business",
      previousKind: "person",
      changed: true,
      deferredToHuman: false,
    });
    const after = await readFiledEntity(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
    });
    expect(after).toEqual({ ...before!, kind: "business" });
  });

  it("chains every determination — the model's at the create, and the human's correcting it", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-KIND-2");
    const entityId = randomUUID();
    await fileEntityCreate(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      kind: "person",
      displayName: "Ferretería Fuentes",
      evidence,
      disclosureText: "Lo di de alta como cliente.",
    });
    await fileEntityKind(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
      kind: "business",
      determinedBy: "human",
    });
    // ...and again, saying the same thing: a second look that agreed is a
    // different event from a change of mind.
    const repeat = await fileEntityKind(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
      kind: "business",
      determinedBy: "model",
    });
    expect(repeat).toEqual({
      entityId,
      kind: "business",
      previousKind: "business",
      changed: false,
      // A person set this one, so the model's second look defers to it —
      // even though it agreed.
      deferredToHuman: true,
    });

    const chained = await db.query<{
      caller: string;
      action: string;
      ref: string;
      outcome: string;
    }>(
      `SELECT caller, action, ref, outcome FROM audit_chain
        WHERE action = 'entity_kind' AND ref LIKE $1 ORDER BY id`,
      [`%entity:${entityId}%`],
    );
    expect(chained.rows).toEqual([
      {
        caller: "aperture",
        action: "entity_kind",
        ref: `company:${seat.companyId} entity:${entityId} by:model`,
        outcome: "determined:person",
      },
      {
        caller: "aperture",
        action: "entity_kind",
        ref: `company:${seat.companyId} entity:${entityId} by:human`,
        outcome: "determined:business",
      },
      {
        caller: "aperture",
        action: "entity_kind",
        ref: `company:${seat.companyId} entity:${entityId} by:model`,
        // The model looked again and AGREED, and it still defers: a person
        // set this one, and only a person changes it. The outcome records
        // WHAT THE MODEL SAID — this entry is about its determination.
        outcome: "deferred:business",
      },
    ]);
  });

  it("finds a human determination recorded under an id spelled another way (ticket #176, Codex r2/r3)", async () => {
    // THE REACHABLE FAILURE. This ref is composed from the ids a caller
    // supplied, and Postgres resolves `A1B2…` and `a1b2…` to ONE uuid while
    // an exact text comparison does not — so a correction a person made
    // under an id they pasted in upper case was invisible to the check, and
    // the next model determination filed straight over it. The chain is
    // append-only, so a canonicalizing writer could not have fixed the
    // entries already on it; the READ folds case instead, which can only
    // ever find more human determinations and never fewer.
    const seat = freshSeat();
    const entityId = randomUUID();
    await fileEntityCreate(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      kind: "person",
      displayName: "Ferretería Fuentes",
      evidence: await repConfirmation(seat, "WAMID-VA-KIND-CASE-1"),
      disclosureText: "Lo di de alta como cliente.",
    });

    // The person corrects it, with the id typed in upper case.
    const shouted = await fileEntityKind(apertureCtx(db, seat.dek), {
      companyId: seat.companyId.toUpperCase(),
      entityId: entityId.toUpperCase(),
      kind: "business",
      determinedBy: "human",
    });
    expect(shouted.kind).toBe("business");

    // ...and the model, later, with the ids as Postgres hands them back.
    const model = await fileEntityKind(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
      kind: "person",
      determinedBy: "model",
    });
    expect(model.deferredToHuman).toBe(true);
    expect(
      (await readFiledEntity(apertureCtx(db, seat.dek), {
        companyId: seat.companyId,
        entityId,
      }))!.kind,
    ).toBe("business");
  });

  it("treats a repeat whose determination flipped as a repeat, and keeps the standing kind", async () => {
    // THE REACHABLE FAILURE this replaces. `kind` used to be one of the
    // axes that told a repeat from a client-supplied-id collision, which
    // was safe while it was a constant the caller supplied. It is a MODEL
    // DETERMINATION now, made fresh on every pass — so a repeat «va», or
    // the crash-replay between the mirror write and the processing marker,
    // can arrive with a determination that changed its mind. Refusing that
    // would throw before the marker was written and replay the event
    // forever; it would also let the next «va» undo a human's correction.
    const seat = freshSeat();
    const entityId = randomUUID();
    const request = {
      twinId: seat.twinId,
      entityId,
      displayName: "Ferretería Fuentes",
      disclosureText: "Lo di de alta como cliente.",
    };
    const first = await fileEntityCreate(apertureCtx(db, seat.dek), {
      ...request,
      kind: "business",
      evidence: await repConfirmation(seat, "WAMID-VA-KIND-FLIP-1"),
    });

    const repeat = await fileEntityCreate(apertureCtx(db, seat.dek), {
      ...request,
      kind: "person",
      evidence: await repConfirmation(seat, "WAMID-VA-KIND-FLIP-2"),
    });

    expect(repeat.filed).toBe(false);
    expect(repeat.disclosureLineId).toBe(first.disclosureLineId);
    expect(
      (await readFiledEntity(apertureCtx(db, seat.dek), {
        companyId: seat.companyId,
        entityId,
      }))!.kind,
    ).toBe("business");
    // A DIFFERENT NAME is still a collision: that axis is the customer.
    await expect(
      fileEntityCreate(apertureCtx(db, seat.dek), {
        ...request,
        displayName: "Otra Ferretería",
        kind: "business",
        evidence: await repConfirmation(seat, "WAMID-VA-KIND-FLIP-3"),
      }),
    ).rejects.toThrow(EntityIdCollisionError);
  });

  it("refuses to determine a kind for an entity nobody filed, and chains the attempt", async () => {
    const seat = freshSeat();
    const entityId = randomUUID();

    await expect(
      fileEntityKind(apertureCtx(db, seat.dek), {
        companyId: seat.companyId,
        entityId,
        kind: "business",
        determinedBy: "model",
      }),
    ).rejects.toThrow(EntityKindUnknownEntityError);

    // Nothing was created — a class-1 determination annotates a record a
    // rep act already made, and never mints one (ADR-0003).
    await expect(
      readFiledEntity(apertureCtx(db, seat.dek), {
        companyId: seat.companyId,
        entityId,
      }),
    ).resolves.toBeUndefined();
    const chained = await db.query<{ outcome: string }>(
      `SELECT outcome FROM audit_chain
        WHERE action = 'entity_kind' AND ref LIKE $1`,
      [`%entity:${entityId}%`],
    );
    expect(chained.rows).toEqual([{ outcome: "refused:unknown_entity" }]);
  });

  it("discloses nothing — a kind flip carries no name across and files no fact", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-KIND-3");
    const entityId = randomUUID();
    await fileEntityCreate(apertureCtx(db, seat.dek), {
      twinId: seat.twinId,
      entityId,
      kind: "person",
      displayName: "Ferretería Fuentes",
      evidence,
      disclosureText: "Lo di de alta como cliente.",
    });
    const before = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM disclosure_lines WHERE company_id = $1",
      [seat.companyId],
    );

    await fileEntityKind(apertureCtx(db, seat.dek), {
      companyId: seat.companyId,
      entityId,
      kind: "business",
      determinedBy: "human",
    });

    // ADR-0003 as amended: an entity mutation is disclosed when it carries
    // rep-derived content across, not when it restructures what already
    // crossed. The create's own line stands and no second line joins it.
    const after = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM disclosure_lines WHERE company_id = $1",
      [seat.companyId],
    );
    expect(after.rows).toEqual(before.rows);
    const facts = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM ledger.facts WHERE company_id = $1",
      [seat.companyId],
    );
    expect(facts.rows).toEqual([{ n: "0" }]);
  });
});

describe("the shadow filter lives inside the finalized-view definitions (ADR-0016)", () => {
  it("hides a filed entity from the finalized view, and the launch gate is one WHERE clause away", async () => {
    const seat = freshSeat();
    const evidence = await repConfirmation(seat, "WAMID-VA-SHADOW");
    const entityId = randomUUID();
    await fileEntityCreate(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        kind: "person",
        displayName: "Diego Zertuche",
        evidence,
        disclosureText: "Lo di de alta como cliente.",
      },
    );

    const shadowed = await db.query(
      "SELECT 1 FROM ledger.finalized_entities WHERE entity_id = $1",
      [entityId],
    );
    expect(shadowed.rows).toEqual([]);

    // Flipping the flag — and nothing else — is what makes it visible.
    await db.query(
      "UPDATE ledger.entities SET shadow = false WHERE entity_id = $1",
      [entityId],
    );
    // ...and saying which company is reading. Since ticket #127 the
    // finalized views run as `dito_ledger_views`, and the row-level policy
    // binding that role is keyed to `dito.company_id` — so a session naming
    // no company reads nothing THROUGH A VIEW, which is the same answer the
    // owner app gets and the point of the mechanism. Reads of the tables
    // underneath are untouched, as the rest of this suite shows.
    await db.query("SELECT set_config('dito.company_id', $1, false)", [
      seat.companyId,
    ]);
    let visible;
    try {
      visible = await db.query<{ display_name: string }>(
        "SELECT display_name FROM ledger.finalized_entities WHERE entity_id = $1",
        [entityId],
      );
    } finally {
      await db.query("RESET dito.company_id");
    }
    expect(visible.rows).toEqual([{ display_name: "Diego Zertuche" }]);
  });
});

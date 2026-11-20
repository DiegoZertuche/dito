/**
 * The crossing's CI invariants (ticket #50), each proven the way FR-70's
 * script is: build the corpus at the seam, plant the violation the
 * invariant exists to catch, watch it go red, restore, watch it go green.
 * An invariant nobody has seen fail is a comment.
 *
 *  - FR-72: every filed item has exactly one disclosure line, and every
 *    line maps to a filed item.
 *  - The Ledger grant audit: the aperture writes `ledger.*`, the twin
 *    runtime holds nothing there, and the shadow filter lives inside the
 *    finalized-view definitions (ADR-0016).
 *  - ADR-0033's exclusion (ticket #52): no extraction run or fact row ever
 *    carries the twin thread as its source.
 *  - The wall over a fact payload's identifiers (ticket #52): the
 *    counterparty's own WhatsApp number is chat identity in a shape the
 *    JID-suffix sweep cannot see.
 *  - The audit chain's COVERAGE (ticket #78): everything that should have
 *    been chained was. Integrity — which `audit-verify` proves — cannot
 *    see a link nobody asked for, so this is the second claim.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "@dito/audit";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditChainCoverageInDb,
  SEAM_DISPOSITIONS,
} from "./audit-coverage.js";
import { fileEntityCreate } from "./entities.js";
import { fileCandidateFact } from "./facts.js";
import { reconcileFr72 } from "./fr72.js";
import {
  APERTURE_ROLE,
  auditLedgerGrants,
  auditRepWebGrants,
  LEDGER_VIEWS_ROLE,
  OWNER_COMPANY_SETTING,
  OWNER_ROLE,
  OWNER_SCHEMA,
  OWNER_VISIBLE_COLUMNS,
  REP_WEB_ROLE,
  TWIN_RUNTIME_ROLE,
} from "./grants.js";
import { auditSelfChatExclusion } from "./self-chat-exclusion.js";
import { auditLedgerWall } from "./wall.js";
import {
  borrowOwnerPassword,
  insertWaEventFixture,
  OWNER_TEST_PASSWORD,
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withRoleClient,
  type BorrowedOwnerPassword,
} from "./testing/db.js";
import { apertureCtx, TEST_AUDIT_HMAC_KEY } from "./testing/context.js";

const SELF_CHAT = "5215550000@s.whatsapp.net";

let db: pg.Client;
/**
 * ROLES ARE CLUSTER-GLOBAL, and this repo's test database shares a server
 * with the rig's, so the stored SCRAM verifier is saved and put back (#133).
 * The owner password is needed here because the ruling on #130 is checked AS
 * `dito_owner` and not only over the catalog.
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

/** One real crossing: a rep-confirmed binding filed through the aperture. */
async function crossOnce(
  seat: Seat,
  messageId: string,
): Promise<{
  entityId: string;
  disclosureLineId: string;
  /** The seam row the crossing was read in — every line names one (ticket #52). */
  sourceEventId: string;
}> {
  const sourceEventId = await insertWaEventFixture(db, seat.dek, {
    twinId: seat.twinId,
    companyId: seat.companyId,
    seatId: seat.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId,
    text: "va",
  });
  const entityId = randomUUID();
  const result = await fileEntityCreate(
    apertureCtx(db, seat.dek),
    {
      twinId: seat.twinId,
      entityId,
      kind: "person",
      displayName: "Diego Zertuche",
      evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
      disclosureText: "Lo di de alta como cliente.",
    },
  );
  return {
    entityId,
    disclosureLineId: result.disclosureLineId,
    sourceEventId,
  };
}

describe("FR-72 disclosure reconciliation", () => {
  it("is green over a corpus of real crossings, and counts them", async () => {
    const seat = freshSeat();
    await crossOnce(seat, "WAMID-FR72-1");
    await crossOnce(seat, "WAMID-FR72-2");

    const report = await reconcileFr72(db);
    expect(report.violations).toEqual([]);
    expect(report.entityCreates).toBeGreaterThanOrEqual(2);
    expect(report.disclosureLines).toBe(report.entityCreates + report.facts);
  });

  it("goes red on a planted undisclosed crossing, and green again once it is gone", async () => {
    const seat = freshSeat();
    const { entityId } = await crossOnce(seat, "WAMID-FR72-PLANT");

    // The planted violation. The deferred triggers make this
    // unrepresentable through any ordinary path, so the plant is exactly
    // what the audit exists for: a superuser turning the enforcement off.
    await db.query("ALTER TABLE ledger.entities DISABLE TRIGGER ALL");
    const undisclosed = randomUUID();
    try {
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'business', 'Ferretería Fuentes', now())`,
        [seat.companyId, undisclosed],
      );
    } finally {
      await db.query("ALTER TABLE ledger.entities ENABLE TRIGGER ALL");
    }

    const red = await reconcileFr72(db);
    expect(red.violations).toContainEqual({
      subject: `entity:${undisclosed}`,
      reason:
        "entity created with no disclosure line — the name crossed undisclosed (ADR-0003 as amended)",
    });
    // The disclosed one is untouched: the audit names the offender, not the corpus.
    expect(
      red.violations.some((v) => v.subject === `entity:${entityId}`),
    ).toBe(false);

    await db.query("DELETE FROM ledger.entities WHERE entity_id = $1", [
      undisclosed,
    ]);
    const green = await reconcileFr72(db);
    expect(green.violations).toEqual([]);
  });

  it("goes red on a planted fact filed with no disclosure line", async () => {
    const seat = freshSeat();
    const { entityId } = await crossOnce(seat, "WAMID-FR72-FACT");

    await db.query(
      "ALTER TABLE ledger.facts DISABLE TRIGGER ledger_facts_disclosed",
    );
    let factId: string;
    try {
      const planted = await db.query<{ id: string }>(
        `INSERT INTO ledger.facts
           (company_id, entity_id, fact_type, payload_version, payload,
            occurred_at, confidence, source_type, filed_by_twin_id)
         VALUES ($1, $2, 'QuoteGiven', 1, '{"amount":"100"}'::jsonb,
                 now(), 0.9, 'extraction', $3)
         RETURNING id`,
        [seat.companyId, entityId, seat.twinId],
      );
      factId = planted.rows[0]!.id;
    } finally {
      await db.query(
        "ALTER TABLE ledger.facts ENABLE TRIGGER ledger_facts_disclosed",
      );
    }

    const red = await reconcileFr72(db);
    expect(red.violations).toContainEqual({
      subject: `fact:${factId}`,
      reason:
        "fact filed with no disclosure line — it crossed the wall undisclosed (FR-72)",
    });

    await db.query("DELETE FROM ledger.facts WHERE id = $1", [factId]);
    expect((await reconcileFr72(db)).violations).toEqual([]);
  });

  it("cannot even hold a disclosure line scoped to a different company than its fact", async () => {
    const seat = freshSeat();
    const { entityId, sourceEventId } = await crossOnce(seat, "WAMID-FR72-SCOPE");
    const otherCompany = randomUUID();

    await db.query(
      "ALTER TABLE ledger.facts DISABLE TRIGGER ledger_facts_disclosed",
    );
    let factId: string;
    try {
      factId = (
        await db.query<{ id: string }>(
          `INSERT INTO ledger.facts
             (company_id, entity_id, fact_type, payload_version, payload,
              occurred_at, source_type, filed_by_twin_id)
           VALUES ($1, $2, 'OrderTaken', 1, '{}'::jsonb, now(), 'extraction', $3)
           RETURNING id`,
          [seat.companyId, entityId, seat.twinId],
        )
      ).rows[0]!.id;
    } finally {
      await db.query(
        "ALTER TABLE ledger.facts ENABLE TRIGGER ledger_facts_disclosed",
      );
    }

    // The company-scoped foreign key, doing the work an audit would
    // otherwise have to: a line disclosing another company's fact is not a
    // state to catch afterwards.
    let code: string | undefined;
    try {
      await db.query(
        `INSERT INTO disclosure_lines
           (company_id, seat_id, twin_id, subject_kind, fact_id, entity_id,
            rendered_text, source_event_id)
         VALUES ($1, $2, $3, 'fact', $4, $5, 'Le confirmaste el pedido.', $6)`,
        [
          otherCompany,
          seat.seatId,
          seat.twinId,
          factId,
          entityId,
          sourceEventId,
        ],
      );
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe("23503");

    await db.query("DELETE FROM ledger.facts WHERE id = $1", [factId]);
    expect((await reconcileFr72(db)).violations).toEqual([]);
  });

  it("catches a fact disclosed into a different rep's journal", async () => {
    const seat = freshSeat();
    const stranger = freshSeat();
    const { entityId, sourceEventId } = await crossOnce(
      seat,
      "WAMID-FR72-WRONG-REP",
    );

    await db.query(
      "ALTER TABLE ledger.facts DISABLE TRIGGER ledger_facts_disclosed",
    );
    let factId: string;
    let lineId: string;
    try {
      factId = (
        await db.query<{ id: string }>(
          `INSERT INTO ledger.facts
             (company_id, entity_id, fact_type, payload_version, payload,
              occurred_at, source_type, filed_by_twin_id)
           VALUES ($1, $2, 'DatePromised', 1, '{}'::jsonb, now(), 'extraction', $3)
           RETURNING id`,
          [seat.companyId, entityId, seat.twinId],
        )
      ).rows[0]!.id;
      // Same company, so the foreign key is satisfied — and the line lands
      // in a twin's journal that did not file it.
      lineId = (
        await db.query<{ id: string }>(
          `INSERT INTO disclosure_lines
             (company_id, seat_id, twin_id, subject_kind, fact_id, entity_id,
              rendered_text, source_event_id)
           VALUES ($1, $2, $3, 'fact', $4, $5, 'Le prometiste el sábado.', $6)
           RETURNING id`,
          [
            seat.companyId,
            stranger.seatId,
            stranger.twinId,
            factId,
            entityId,
            sourceEventId,
          ],
        )
      ).rows[0]!.id;
    } finally {
      await db.query(
        "ALTER TABLE ledger.facts ENABLE TRIGGER ledger_facts_disclosed",
      );
    }

    const red = await reconcileFr72(db);
    expect(red.violations).toContainEqual({
      subject: `line:${lineId}`,
      reason:
        "disclosure line twin differs from the twin that filed the fact it discloses",
    });

    await db.query("DELETE FROM disclosure_lines WHERE id = $1", [lineId]);
    await db.query("DELETE FROM ledger.facts WHERE id = $1", [factId]);
    expect((await reconcileFr72(db)).violations).toEqual([]);
  });
});

describe("what the schema will not hold at all", () => {
  it("refuses an entity with no creation grant — at most one creator was never the claim", async () => {
    const seat = freshSeat();
    // The disclosure line is there; only the grant is missing. Written
    // straight at the tables so the refusal is the database's.
    const sourceEventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: "WAMID-NO-CREATOR",
      text: "va",
    });
    const entityId = randomUUID();
    await db.query("BEGIN");
    let message = "";
    try {
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'person', 'Diego Zertuche', now())`,
        [seat.companyId, entityId],
      );
      await db.query(
        `INSERT INTO disclosure_lines
           (company_id, seat_id, twin_id, subject_kind, entity_id, rendered_text, source_event_id)
         VALUES ($1, $2, $3, 'entity_create', $4, 'Lo di de alta como cliente.', $5)`,
        [seat.companyId, seat.seatId, seat.twinId, entityId, sourceEventId],
      );
      await db.query("COMMIT");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      await db.query("ROLLBACK");
    }
    expect(message).toContain("no creation grant");

    const filed = await db.query(
      "SELECT 1 FROM ledger.entities WHERE entity_id = $1",
      [entityId],
    );
    expect(filed.rows).toEqual([]);
  });

  it("refuses a create whose recorded creator is not the rep it was disclosed to", async () => {
    const creator = freshSeat();
    const other = freshSeat();
    // Same company, two reps: `other` is told about a crossing that
    // `creator` is recorded as having made. Both twins are real, both
    // events are real, and every existence check would pass.
    const sourceEventId = await insertWaEventFixture(db, other.dek, {
      twinId: other.twinId,
      companyId: creator.companyId,
      seatId: other.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: "WAMID-WRONG-CREATOR",
      text: "va",
    });
    const entityId = randomUUID();

    await db.query("BEGIN");
    let message = "";
    try {
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'person', 'Diego Zertuche', now())`,
        [creator.companyId, entityId],
      );
      await db.query(
        `INSERT INTO ledger.entity_grants (company_id, entity_id, twin_id, source)
         VALUES ($1, $2, $3, 'creation')`,
        [creator.companyId, entityId, creator.twinId],
      );
      await db.query(
        `INSERT INTO disclosure_lines
           (company_id, seat_id, twin_id, subject_kind, entity_id, rendered_text, source_event_id)
         VALUES ($1, $2, $3, 'entity_create', $4, 'Lo di de alta como cliente.', $5)`,
        [
          creator.companyId,
          other.seatId,
          other.twinId,
          entityId,
          sourceEventId,
        ],
      );
      await db.query("COMMIT");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      await db.query("ROLLBACK");
    }
    expect(message).toContain("discloses the create to a different rep");

    expect(
      (
        await db.query("SELECT 1 FROM ledger.entities WHERE entity_id = $1", [
          entityId,
        ])
      ).rows,
    ).toEqual([]);
  });

  it("refuses a second entity create evidenced by the same rep act — one «va», one crossing", async () => {
    const seat = freshSeat();
    const messageId = "WAMID-REUSED-VA";
    const sourceEventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId,
      text: "va",
    });
    const ctx = apertureCtx(db, seat.dek);
    await fileEntityCreate(ctx, {
      twinId: seat.twinId,
      entityId: randomUUID(),
      kind: "person",
      displayName: "Diego Zertuche",
      evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
      disclosureText: "Lo di de alta como cliente.",
    });

    // A DIFFERENT customer, cited on the SAME confirmation. The rep said
    // one thing about one chat.
    await expect(
      fileEntityCreate(ctx, {
        twinId: seat.twinId,
        entityId: randomUUID(),
        kind: "business",
        displayName: "Ferretería Fuentes",
        evidence: { surface: "twin_thread", sourceEventId, waMessageId: messageId },
        disclosureText: "Lo di de alta como cliente.",
      }),
    ).rejects.toThrow();

    expect((await reconcileFr72(db)).violations).toEqual([]);
  });
});

/** Puts `ledger.finalized_facts` back exactly as …100030 defines it. */
async function restoreFinalizedFacts(): Promise<void> {
  await db.query(`
    CREATE OR REPLACE VIEW ledger.finalized_facts WITH (security_barrier = true) AS
    SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version,
           f.payload, f.occurred_at, f.confidence, f.source_type, f.filed_at,
           f.finalized_at, s.id AS filed_by_seat_id
      FROM ledger.facts f
      LEFT JOIN seats s
        ON s.company_id = f.company_id AND s.twin_id = f.filed_by_twin_id
     WHERE f.shadow = false
       AND f.finalized_at IS NOT NULL
       AND f.retracted_at IS NULL`);
  await db.query(
    `GRANT SELECT ON ledger.finalized_facts TO ${TWIN_RUNTIME_ROLE}`,
  );
  await db.query(`GRANT SELECT ON ledger.finalized_facts TO ${OWNER_ROLE}`);
}

describe("the Ledger grant audit", () => {
  it("is green on the migrated schema, and enumerates what it checked", async () => {
    const report = await auditLedgerGrants(db);
    expect(report.violations).toEqual([]);
    expect(report.ledgerTables).toEqual([
      "ledger.entities",
      "ledger.entity_grants",
      // Ticket #55: the merge edge. Aperture-writable, twin-runtime-invisible
      // and — like every Ledger table — never aperture-deletable.
      "ledger.entity_merges",
      // Ticket #62: the appended reversal, held to the same three rules —
      // and to append-only most of all, since an undo that could itself be
      // erased puts the graph in a state nothing recorded.
      "ledger.entity_unmerges",
      "ledger.facts",
    ]);
    expect(report.ledgerViews).toEqual([
      "ledger.finalized_entities",
      "ledger.finalized_facts",
    ]);
  });

  it("goes red the moment the twin runtime is handed a Ledger write", async () => {
    await db.query(`GRANT INSERT ON ledger.facts TO ${TWIN_RUNTIME_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:ledger.facts",
        reason: `${TWIN_RUNTIME_ROLE} holds INSERT on a Ledger table — the twin runtime holds no Ledger write, and reads through the finalized views (ADR-0016)`,
      });
    } finally {
      await db.query(`REVOKE INSERT ON ledger.facts FROM ${TWIN_RUNTIME_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red the moment the aperture is handed a way to erase the Ledger", async () => {
    await db.query(`GRANT DELETE ON ledger.facts TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:ledger.facts",
        reason: `${APERTURE_ROLE} holds DELETE — the Ledger is append-only and corrections annotate, never erase (FR-33)`,
      });
    } finally {
      await db.query(`REVOKE DELETE ON ledger.facts FROM ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  /**
   * The annotation grants (ticket #54). Migration …100012 refused
   * table-wide UPDATE on the Ledger and promised the annotation paths would
   * arrive with COLUMN-LEVEL grants instead, "a reviewable migration each,
   * rather than a privilege nobody notices". This is what makes that a
   * property rather than a promise: exactly those columns, checked in both
   * directions, because a table-wide UPDATE can be assembled one column at
   * a time and the table-wide probe would never see it.
   */
  it("goes red when the aperture loses the column grant an annotation path needs", async () => {
    await db.query(`REVOKE UPDATE (retracted_at) ON ledger.facts FROM ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:ledger.facts.retracted_at",
      );
    } finally {
      await db.query(`GRANT UPDATE (retracted_at) ON ledger.facts TO ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the aperture loses the column grant the kind determination needs", async () => {
    // Ticket #60. The model determines person-vs-business and always
    // records its determination, so the value is sometimes wrong and a
    // wrong one changes merge eligibility — correcting it is an UPDATE, and
    // #52 found this role holding INSERT and SELECT only. An UPDATE nobody
    // granted is a live runtime failure, not a hypothetical.
    await db.query(`REVOKE UPDATE (kind) ON ledger.entities FROM ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:ledger.entities.kind",
      );
    } finally {
      await db.query(`GRANT UPDATE (kind) ON ledger.entities TO ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  /**
   * THE CLASS-1 FENCE IS A PRIVILEGE, not a convention (ticket #60;
   * ADR-0003). The kind is model output, and model output may never create
   * or rename an entity — so this asks the database, as the aperture's own
   * role, rather than trusting that no code path ever composes the rename.
   */
  it("lets the aperture set a kind and refuses to let it rename the customer", async () => {
    const seat = freshSeat();
    const { entityId } = await crossOnce(seat, "WAMID-KIND-GRANT");
    await db.query(`SET ROLE ${APERTURE_ROLE}`);
    try {
      await db.query(
        "UPDATE ledger.entities SET kind = 'business' WHERE entity_id = $1",
        [entityId],
      );
      await expect(
        db.query(
          "UPDATE ledger.entities SET display_name = 'Otro' WHERE entity_id = $1",
          [entityId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("RESET ROLE");
    }
    const row = await db.query<{ kind: string; display_name: string }>(
      "SELECT kind, display_name FROM ledger.entities WHERE entity_id = $1",
      [entityId],
    );
    expect(row.rows).toEqual([
      { kind: "business", display_name: "Diego Zertuche" },
    ]);
  });

  it("goes red when the aperture cannot append to the chain its own acts land on", async () => {
    // Real, and found by this check rather than by a test: …100012 gave the
    // aperture SELECT on every `public` table and INSERT on its own two
    // stores, which was enough while nothing it did was audit-chained. The
    // day a process actually authenticates as this role, a crossing would
    // fail on a privilege rather than on anything about the crossing.
    await db.query(`REVOKE INSERT ON audit_chain FROM ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:public.audit_chain",
        reason: `${APERTURE_ROLE} cannot append to the audit chain — rep acts and refusals are audit-chained (ADR-0020), and the aperture is what performs them`,
      });
    } finally {
      await db.query(`GRANT INSERT ON audit_chain TO ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  // THE REGISTRY GRANT #132 ADDED, NOW PINNED (ticket #130; the obligation
  // recorded on the horizon, #117). …100070's own header says the privilege
  // "sits outside FR-71a's diff altogether today" — so until this, a
  // migration handing the aperture the lift act's own write would have
  // passed every check in this file.
  it("goes red the moment the aperture can write the company mode it only reads", async () => {
    await db.query(`GRANT UPDATE ON companies TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:public.companies",
        reason: `${APERTURE_ROLE} holds UPDATE on the company registry — it READS a company's mode at filing and never sets one, and \`shadow_lifted_at\` is written by the lift act as the schema owner (spec #126 decision 9)`,
      });
    } finally {
      await db.query(`REVOKE UPDATE ON companies FROM ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the aperture loses the company read its shadow stamp needs", async () => {
    await db.query(`REVOKE SELECT ON companies FROM ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("cannot read the company registry"),
      );
    } finally {
      await db.query(`GRANT SELECT ON companies TO ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on any grant at all to the aperture on the seat registry", async () => {
    // The seat registry carries the seat-to-twin mapping, which is the join
    // the owner's views exist to keep on the far side of. Nothing in the
    // filing path reads it.
    await db.query(`GRANT SELECT ON seats TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.seats",
      );
    } finally {
      await db.query(`REVOKE SELECT ON seats FROM ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red the moment the aperture can rewrite a chain link", async () => {
    await db.query(`GRANT UPDATE ON audit_chain TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.audit_chain",
      );
    } finally {
      await db.query(`REVOKE UPDATE ON audit_chain FROM ${APERTURE_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a Ledger column grant nobody declared — a table-wide UPDATE arriving one column at a time", async () => {
    // `display_name` is exactly the column ADR-0003's amendment is about: a
    // rename puts a name from the rep's conversation into the Ledger and IS
    // disclosed, so a silent UPDATE on it is a crossing nobody was told
    // about.
    await db.query(`GRANT UPDATE (display_name) ON ledger.entities TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:ledger.entities.display_name",
      );
    } finally {
      await db.query(
        `REVOKE UPDATE (display_name) ON ledger.entities FROM ${APERTURE_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a finalized view stops filtering shadow — the ADR-0016 rebuild, caught as a WHERE clause", async () => {
    await db.query(`
      CREATE OR REPLACE VIEW ledger.finalized_entities WITH (security_barrier = true) AS
      SELECT company_id, entity_id, kind, display_name, created_at
        FROM ledger.entities`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_entities",
      );
    } finally {
      await db.query(`
        CREATE OR REPLACE VIEW ledger.finalized_entities WITH (security_barrier = true) AS
        SELECT company_id, entity_id, kind, display_name, created_at
          FROM ledger.entities
         WHERE shadow = false`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a filter the view can route around — presence is not the property", async () => {
    // The false green this check exists for: the filter is right there in
    // the definition, and the view returns every shadow row anyway.
    await db.query(`
      CREATE OR REPLACE VIEW ledger.finalized_entities WITH (security_barrier = true) AS
      SELECT company_id, entity_id, kind, display_name, created_at
        FROM ledger.entities
       WHERE shadow = false OR shadow = true`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_entities",
      );
    } finally {
      await db.query(`
        CREATE OR REPLACE VIEW ledger.finalized_entities WITH (security_barrier = true) AS
        SELECT company_id, entity_id, kind, display_name, created_at
          FROM ledger.entities
         WHERE shadow = false`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red the moment the twin runtime can write the seam the aperture trusts", async () => {
    // The aperture reads company, seat, twin and rep authorship OFF a
    // wa_events row. A principal that can write one can forge all four.
    await db.query(`GRANT UPDATE ON wa_events TO ${TWIN_RUNTIME_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.wa_events",
      );
    } finally {
      await db.query(`REVOKE UPDATE ON wa_events FROM ${TWIN_RUNTIME_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a table-wide UPDATE for the aperture — that is a rename with no disclosure", async () => {
    await db.query(`GRANT UPDATE ON ledger.entities TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:ledger.entities",
        reason: `${APERTURE_ROLE} holds table-wide UPDATE — a blanket UPDATE can rename an entity without disclosing it (ADR-0003 as amended) and rewrite provenance in an append-only store; annotation paths take column-level grants in their own migration`,
      });
    } finally {
      // A TABLE-WIDE REVOKE TAKES THE COLUMN GRANTS WITH IT — including
      // …100020's `UPDATE (kind)`, which the determination path needs
      // (ticket #60). Restoring both is what puts the schema back; the
      // audit's declared-but-missing arm is what would have caught it in
      // production, and it is the arm this suite tripped first.
      await db.query(
        `REVOKE UPDATE ON ledger.entities FROM ${APERTURE_ROLE}`,
      );
      await db.query(
        `GRANT UPDATE (kind) ON ledger.entities TO ${APERTURE_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the aperture is handed a way to delete a disclosure line", async () => {
    await db.query(`GRANT DELETE ON disclosure_lines TO ${APERTURE_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.disclosure_lines",
      );
    } finally {
      await db.query(
        `REVOKE DELETE ON disclosure_lines FROM ${APERTURE_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a SECOND Ledger writer — one writer means one, not two named ones", async () => {
    // The audit knew two role names and asked about those. A third role
    // with INSERT could file crossings the aperture never saw, and the
    // single-writer claim would still report green.
    await db.query("CREATE ROLE dito_rogue_writer NOLOGIN");
    try {
      await db.query("GRANT INSERT ON ledger.facts TO dito_rogue_writer");
      const red = await auditLedgerGrants(db);
      expect(
        red.violations.some(
          (v) =>
            v.subject === "table:ledger.facts" &&
            v.reason.includes("dito_rogue_writer"),
        ),
      ).toBe(true);
    } finally {
      await db.query(
        "REVOKE ALL ON ALL TABLES IN SCHEMA ledger FROM dito_rogue_writer",
      );
      await db.query("DROP ROLE dito_rogue_writer");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a role that inherits the aperture's credentials rather than being granted them", async () => {
    await db.query("CREATE ROLE dito_rogue_member NOLOGIN");
    try {
      await db.query(`GRANT ${APERTURE_ROLE} TO dito_rogue_member`);
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "role:dito_rogue_member",
        reason: `dito_rogue_member is a member of ${APERTURE_ROLE} and inherits its Ledger write credentials — membership is the same credential by another route (ADR-0003)`,
      });
    } finally {
      await db.query(`REVOKE ${APERTURE_ROLE} FROM dito_rogue_member`);
      await db.query("DROP ROLE dito_rogue_member");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a duplicated predicate standing in for a missing one", async () => {
    // Two filters, two source tables, no OR — and every shadow FACT
    // visible through `f`. Counting was never the property.
    await db.query(`
      CREATE OR REPLACE VIEW ledger.finalized_facts WITH (security_barrier = true) AS
      SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version,
             f.payload, f.occurred_at, f.confidence, f.source_type,
             f.filed_at, f.finalized_at, NULL::uuid AS filed_by_seat_id
        FROM ledger.facts f
        JOIN ledger.entities e
          ON e.company_id = f.company_id AND e.entity_id = f.entity_id
       WHERE e.shadow = false AND e.shadow = false`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_facts",
      );
    } finally {
      await restoreFinalizedFacts();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a view that filters only one side of a join — the other side's shadow rows come through", async () => {
    // The exact laundering a presence test allows: the entity side is
    // filtered, the FACT side is not, and every shadow fact is visible.
    await db.query(`
      CREATE OR REPLACE VIEW ledger.finalized_facts WITH (security_barrier = true) AS
      SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version,
             f.payload, f.occurred_at, f.confidence, f.source_type,
             f.filed_at, f.finalized_at, NULL::uuid AS filed_by_seat_id
        FROM ledger.facts f
        JOIN ledger.entities e
          ON e.company_id = f.company_id AND e.entity_id = f.entity_id
       WHERE e.shadow = false`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_facts",
      );
    } finally {
      await restoreFinalizedFacts();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("refuses to pass when the aperture role does not exist", async () => {
    // Probed without dropping the cluster-global role: the audit's own
    // "refusing to pass on nothing" branch, driven by a role name that
    // was never created.
    const report = await auditLedgerGrants({
      query: ((text: string, values?: unknown[]) => {
        if (text.includes("FROM pg_roles WHERE rolname")) {
          // EVERY AUDITED ROLE BUT ONE, so the missing one is the claim.
          // `dito_rep_web` is here because the list grew at #221 and a role
          // this stub forgot would report as a second absence.
          return Promise.resolve({
            rows: [
              { rolname: TWIN_RUNTIME_ROLE },
              { rolname: OWNER_ROLE },
              { rolname: LEDGER_VIEWS_ROLE },
              { rolname: "dito_owner_state" },
              { rolname: REP_WEB_ROLE },
            ],
          });
        }
        return db.query(text, values as never);
      }) as pg.ClientBase["query"],
    } as pg.ClientBase);
    expect(report.violations).toEqual([
      {
        subject: `role:${APERTURE_ROLE}`,
        reason:
          "role does not exist — the single-writer claim is enforced by grants, and a missing role enforces nothing",
      },
    ]);
  });
});

/**
 * FR-71a's own half (ticket #127; spec #126 decisions 3, 4, 14 and 20).
 *
 * The four claims above are about the rep side: one writer, no runtime
 * write, the shadow filter where ADR-0016 puts it. These are about the
 * OWNER side, and they exist because slice 4 is the first slice in which a
 * process authenticates as an application role — so for the first time the
 * wall is a live credential rather than a posture, and a grant nobody
 * noticed is a company reading another company's Ledger.
 *
 * Each test plants the violation its claim exists to catch, exactly as the
 * suite above does: red, restore, green.
 */
describe("the owner's half of the grant audit (FR-71a)", () => {
  it("is green on the migrated schema, and enumerates the roles and the views it pinned", async () => {
    const report = await auditLedgerGrants(db);
    expect(report.violations).toEqual([]);
    expect(report.auditedRoles).toEqual([
      APERTURE_ROLE,
      TWIN_RUNTIME_ROLE,
      OWNER_ROLE,
      LEDGER_VIEWS_ROLE,
      // The role that OWNS the owner's own state, so nothing that connects
      // can disable the policies binding it (Diego's ruling on #130).
      "dito_owner_state",
      // ...and the rep dashboard's, the second role a process authenticates
      // as (claim 10, ticket #221).
      REP_WEB_ROLE,
    ]);
    expect(report.ownerViews).toEqual([
      "ledger.finalized_entities",
      "ledger.finalized_facts",
      "public.seats_status",
    ]);
  });

  it("goes red the moment the owner is handed a Ledger table", async () => {
    // The wall in one statement: with SELECT on the table the owner reads
    // `filed_by_twin_id` and every shadow row, and the view's projection
    // stops being what it can see.
    await db.query(`GRANT SELECT ON ledger.facts TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:ledger.facts",
        reason: `${OWNER_ROLE} holds SELECT — the owner role is granted named views with pinned column lists ONLY, and a table hands it the shadow rows and the twin id its views exist to withhold (ADR-0002, ADR-0004 as amended)`,
      });
    } finally {
      await db.query(`REVOKE SELECT ON ledger.facts FROM ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a seam table handed to the owner, not only a Ledger one", async () => {
    await db.query(`GRANT SELECT ON wa_events TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.wa_events",
      );
    } finally {
      await db.query(`REVOKE SELECT ON wa_events FROM ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when row-level security is switched off on one Ledger table", async () => {
    await db.query("ALTER TABLE ledger.facts DISABLE ROW LEVEL SECURITY");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:ledger.facts",
        reason:
          "row-level security is not ENABLED — every shared table carries company_id under Postgres RLS (ADR-0002), and a cross-company read must return nothing even with a missing WHERE clause",
      });
    } finally {
      await db.query("ALTER TABLE ledger.facts ENABLE ROW LEVEL SECURITY");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a registry has row-level security enabled but not forced", async () => {
    await db.query("ALTER TABLE seats NO FORCE ROW LEVEL SECURITY");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:public.seats",
        reason:
          "row-level security is not FORCED — an unforced policy stops applying to the table's own owner, which is where the next reader will connect from",
      });
    } finally {
      await db.query("ALTER TABLE seats FORCE ROW LEVEL SECURITY");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a column the owner can see that nobody pinned", async () => {
    // A handy migration column becoming owner-visible by accident is the
    // exact failure ADR-0002 calls a spine change, and the pinned list is
    // what makes it a red build rather than a discovery.
    await db.query(`
      CREATE OR REPLACE VIEW seats_status WITH (security_barrier = true) AS
      SELECT s.id AS seat_id, s.rep_display_name AS display_name, s.state,
             s.twin_id
        FROM seats s`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "column:public.seats_status.twin_id",
        reason:
          "the owner can see a column nobody pinned — adding an owner-visible column is a spine change (ADR-0002), and the pinned list in code is the diff that says so",
      });
    } finally {
      await restoreSeatsStatus();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a pinned owner column stops existing", async () => {
    await db.query("DROP VIEW seats_status");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:public.seats_status",
      );
    } finally {
      await restoreSeatsStatus();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red the moment the owner role can bypass the policies", async () => {
    // The isolation evaporates and nothing about the grant diff looks
    // different: same views, same columns, every company's rows.
    await db.query(`ALTER ROLE ${OWNER_ROLE} BYPASSRLS`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: `role:${OWNER_ROLE}`,
        reason: `${OWNER_ROLE} holds BYPASSRLS — the company policy is the whole of this slice's tenant isolation, and a role that bypasses it reads every company through the same granted views`,
      });
    } finally {
      await db.query(`ALTER ROLE ${OWNER_ROLE} NOBYPASSRLS`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red the moment the role the views RUN as can bypass the policies", async () => {
    // The subtler half of the same hole: the owner is still policy-bound
    // and every read it makes goes through a view that is not.
    await db.query(`ALTER ROLE ${LEDGER_VIEWS_ROLE} BYPASSRLS`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        `role:${LEDGER_VIEWS_ROLE}`,
      );
    } finally {
      await db.query(`ALTER ROLE ${LEDGER_VIEWS_ROLE} NOBYPASSRLS`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner can call a Ledger function nobody granted it", async () => {
    // `active_entity_merges` returns the merge graph itself. The owner asks
    // which record a record is now and is answered; it does not get to read
    // who was merged with whom.
    await db.query(
      `GRANT EXECUTE ON FUNCTION ledger.active_entity_merges(uuid) TO ${OWNER_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:ledger.active_entity_merges(uuid)",
      );
    } finally {
      await db.query(
        `REVOKE EXECUTE ON FUNCTION ledger.active_entity_merges(uuid) FROM ${OWNER_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a Ledger function goes back to being PUBLIC-executable", async () => {
    // PostgreSQL's own default, and the reason "exactly the named function"
    // was unclaimable until …100050 revoked it.
    await db.query(
      "GRANT EXECUTE ON FUNCTION ledger.resolve_entity(uuid, uuid) TO PUBLIC",
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason).join(" ")).toContain("PUBLIC");
    } finally {
      await db.query(
        "REVOKE EXECUTE ON FUNCTION ledger.resolve_entity(uuid, uuid) FROM PUBLIC",
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a company policy that stops naming a company", async () => {
    // The failure ENABLED + FORCED cannot see: every switch on, every grant
    // unchanged, and every company readable by every owner.
    await db.query(
      `ALTER POLICY ledger_facts_company_read ON ledger.facts USING (true)`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "policy:ledger.facts.ledger_facts_company_read",
      );
    } finally {
      await db.query(
        `ALTER POLICY ledger_facts_company_read ON ledger.facts
           USING (company_id = ledger.declared_company())`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a table the owner's views read loses its company policy entirely", async () => {
    await db.query("DROP POLICY seats_company_read ON seats");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.seats",
      );
    } finally {
      await db.query(`
        CREATE POLICY seats_company_read ON seats
            FOR SELECT TO ${LEDGER_VIEWS_ROLE}
            USING (company_id = ledger.declared_company())`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a policy handed to PUBLIC, which every role is in", async () => {
    await db.query(
      `CREATE POLICY ledger_facts_everyone ON ledger.facts FOR SELECT USING (true)`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "policy:ledger.facts.ledger_facts_everyone",
      );
    } finally {
      await db.query("DROP POLICY ledger_facts_everyone ON ledger.facts");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a role that INHERITS the views role rather than being granted anything", async () => {
    // NOLOGIN on the group prevents nothing: it is the member that logs in,
    // and it reads `ledger.facts` directly — shadow rows and twin ids — while
    // every relation's ACL still names only the group.
    await db.query("CREATE ROLE dito_rogue_reader LOGIN");
    try {
      await db.query(`GRANT ${LEDGER_VIEWS_ROLE} TO dito_rogue_reader`);
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "role:dito_rogue_reader",
      );
    } finally {
      await db.query(`REVOKE ${LEDGER_VIEWS_ROLE} FROM dito_rogue_reader`);
      await db.query("DROP ROLE dito_rogue_reader");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when an owner view stops running as the policy-bound role", async () => {
    // Same grants, same columns, every company: a definer view owned by a
    // superuser bypasses row-level security for every caller.
    await db.query("ALTER VIEW ledger.finalized_facts OWNER TO dito");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_facts",
      );
    } finally {
      await db.query(
        `ALTER VIEW ledger.finalized_facts OWNER TO ${LEDGER_VIEWS_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when an owner view loses its security barrier", async () => {
    await db.query(
      "ALTER VIEW seats_status SET (security_barrier = false)",
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:public.seats_status",
      );
    } finally {
      await db.query("ALTER VIEW seats_status SET (security_barrier = true)");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner's SELECT on a view narrows to a column subset", async () => {
    // The pinned projection IS the grant. A column subset leaves the owner
    // able to read part of its own view and fail on the rest — and the
    // column list is checked against the catalog, so nothing else notices.
    await db.query(`REVOKE SELECT ON seats_status FROM ${OWNER_ROLE}`);
    await db.query(`GRANT SELECT (seat_id) ON seats_status TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:public.seats_status",
      );
    } finally {
      await db.query(
        `REVOKE SELECT (seat_id) ON seats_status FROM ${OWNER_ROLE}`,
      );
      await db.query(`GRANT SELECT ON seats_status TO ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner loses EXECUTE on the function its timeline needs", async () => {
    // The direction that stays silent otherwise: the owner surface resolves
    // no merges and the grant diff has nothing to say about it.
    await db.query(
      `REVOKE EXECUTE ON FUNCTION ledger.resolve_entity_for_declared_company(uuid) FROM ${OWNER_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:ledger.resolve_entity_for_declared_company(uuid)",
      );
    } finally {
      await db.query(
        `GRANT EXECUTE ON FUNCTION ledger.resolve_entity_for_declared_company(uuid) TO ${OWNER_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a shadow filter that only ever ran in the projection", async () => {
    // Present in the definition, and every shadow row returned: the
    // predicate decides a rendered value and gates no row at all.
    await db.query(`
      CREATE OR REPLACE VIEW ledger.finalized_facts WITH (security_barrier = true) AS
      SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version,
             f.payload, f.occurred_at, f.confidence,
             CASE WHEN f.shadow = false THEN f.source_type ELSE f.source_type END
               AS source_type,
             f.filed_at, f.finalized_at, NULL::uuid AS filed_by_seat_id
        FROM ledger.facts f`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_facts",
      );
    } finally {
      await restoreFinalizedFacts();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a twin id wearing the seat's name — the same catalog shape, a different source", async () => {
    // Every other check passes: the column names are the pinned ones, the
    // view is owned by the right role, RLS is on and forced, the shadow
    // filter is a qualifier. What changed is where one column comes FROM.
    await db.query(`
      CREATE OR REPLACE VIEW ledger.finalized_facts WITH (security_barrier = true) AS
      SELECT f.id, f.company_id, f.entity_id, f.fact_type, f.payload_version,
             f.payload, f.occurred_at, f.confidence, f.source_type,
             f.filed_at, f.finalized_at,
             f.filed_by_twin_id AS filed_by_seat_id
        FROM ledger.facts f
       WHERE f.shadow = false
         AND f.finalized_at IS NOT NULL
         AND f.retracted_at IS NULL`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_facts",
      );
    } finally {
      await restoreFinalizedFacts();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the function every company policy calls stops reading the connection", async () => {
    // The policy text is unchanged and names the same function; the
    // function answers with somebody else's company.
    await db.query(`
      CREATE OR REPLACE FUNCTION ledger.declared_company() RETURNS uuid
      LANGUAGE sql STABLE PARALLEL SAFE
      AS $fn$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $fn$`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:ledger.declared_company()",
      );
    } finally {
      await db.query(`
        CREATE OR REPLACE FUNCTION ledger.declared_company() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $fn$ SELECT NULLIF(current_setting('dito.company_id', true), '')::uuid; $fn$`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a view in the owner's own schema — the default privileges make it owner-readable", async () => {
    // The escape hatch nothing else looks at: a view here is created by the
    // migration role and therefore evaluated as one, and `ALTER DEFAULT
    // PRIVILEGES … ON TABLES` covers views, so the owner reads every
    // tenant's facts through an object no grant in any migration mentions.
    await db.query(
      "CREATE VIEW owner.everything AS SELECT * FROM ledger.facts",
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "relation:owner.everything",
      );
    } finally {
      await db.query("DROP VIEW owner.everything");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a second reader of an owner view — dito_owner's own reach is unchanged", async () => {
    // A login with SELECT on the view and EXECUTE on the policy's function
    // declares whatever company it likes and reads that tenant. Every
    // claim about `dito_owner` stays true throughout.
    await db.query("CREATE ROLE dito_rogue_owner LOGIN");
    try {
      await db.query("GRANT SELECT ON ledger.finalized_facts TO dito_rogue_owner");
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "grant:ledger.finalized_facts",
      );
    } finally {
      await db.query(
        "REVOKE ALL ON ledger.finalized_facts FROM dito_rogue_owner",
      );
      await db.query("DROP ROLE dito_rogue_owner");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when an owner surface becomes a materialized view — the same columns, a snapshot no policy filters", async () => {
    await db.query("DROP VIEW seats_status");
    await db.query(`
      CREATE MATERIALIZED VIEW seats_status AS
      SELECT s.id AS seat_id, s.rep_display_name AS display_name, s.state
        FROM seats s`);
    await db.query(`GRANT SELECT ON seats_status TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:public.seats_status",
      );
    } finally {
      await db.query("DROP MATERIALIZED VIEW seats_status");
      await restoreSeatsStatus();
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the policy's function is given a company of its own", async () => {
    // `ALTER FUNCTION … SET dito.company_id` leaves the body byte-for-byte
    // identical and makes EVERY policy in the database resolve that
    // company, whatever the connection declared.
    await db.query(
      "ALTER FUNCTION ledger.declared_company() SET dito.company_id = '00000000-0000-0000-0000-000000000009'",
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:ledger.declared_company()",
      );
    } finally {
      await db.query(
        "ALTER FUNCTION ledger.declared_company() RESET dito.company_id",
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner's resolution function keeps its signature and changes its body", async () => {
    await db.query(`
      CREATE OR REPLACE FUNCTION ledger.resolve_entity_for_declared_company(p_entity_id uuid)
      RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
      SET search_path = pg_catalog
      AS $fn$
      BEGIN
          RETURN p_entity_id;
      END;
      $fn$`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:ledger.resolve_entity_for_declared_company(uuid)",
      );
    } finally {
      await db.query(`
        CREATE OR REPLACE FUNCTION ledger.resolve_entity_for_declared_company(p_entity_id uuid)
        RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = pg_catalog
        AS $fn$
        DECLARE
            company uuid := ledger.declared_company();
        BEGIN
            IF company IS NULL THEN
                RAISE EXCEPTION
                    'ledger.resolve_entity_for_declared_company refused: this connection declared no company'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN ledger.resolve_entity(company, p_entity_id);
        END;
        $fn$`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("lets the twin runtime actually read the finalized view its grant names", async () => {
    // The grant has been asserted since …100012 and, since the views run
    // under a policy, it is only true if that role can evaluate the policy
    // too. Asked by reading, not by reading an ACL.
    const seat = freshSeat();
    const { entityId } = await crossOnce(seat, "WAMID-RUNTIME-READ");
    await db.query(
      "UPDATE ledger.entities SET shadow = false WHERE entity_id = $1",
      [entityId],
    );
    await db.query("SELECT set_config('dito.company_id', $1, false)", [
      seat.companyId,
    ]);
    await db.query(`SET ROLE ${TWIN_RUNTIME_ROLE}`);
    try {
      const seen = await db.query<{ entity_id: string }>(
        "SELECT entity_id FROM ledger.finalized_entities",
      );
      expect(seen.rows).toEqual([{ entity_id: entityId }]);
    } finally {
      await db.query("RESET ROLE");
      await db.query("RESET dito.company_id");
      await db.query(
        "UPDATE ledger.entities SET shadow = true WHERE entity_id = $1",
        [entityId],
      );
    }
  });

  it("goes red when the owner's own schema stops being the state role's", async () => {
    await db.query(`ALTER SCHEMA owner OWNER TO ${TWIN_RUNTIME_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain("schema:owner");
    } finally {
      await db.query("ALTER SCHEMA owner OWNER TO dito_owner_state");
      // `ALTER SCHEMA … OWNER TO` rewrites the ACL, so the owner's USAGE
      // goes with the old owner and is put back by hand.
      await db.query(`GRANT USAGE ON SCHEMA owner TO ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  // THE OWNER'S OWN SCHEMA, PINNED BY SHAPE AND NOT ONLY BY OWNERSHIP
  // (ticket #130, Codex r1). "A table owned by dito_owner" let a fourth
  // relation in, and let RLS be switched off on one of the three.
  // THE RULING OF 2026-09-02 (#130 remainder 2), planted from both sides.
  // `dito_owner` must own nothing it is policy-bound on, because a
  // relation's owner may disable its row-level security and FORCE does not
  // reach that.
  it("refuses, as `dito_owner` itself, to disable the policies that bind it", async () => {
    // THE FAILURE THIS SHAPE CLOSES, exercised as the login rather than
    // argued: before the ruling this statement SUCCEEDED, and with it every
    // company's questions and answers came into reach of one deployment.
    const refused = await withRoleClient(
      OWNER_ROLE,
      OWNER_TEST_PASSWORD,
      async (client) => {
        const seen: Record<string, string> = {};
        const statements: readonly (readonly [string, string])[] = [
          ["disable_rls", "ALTER TABLE owner.questions DISABLE ROW LEVEL SECURITY"],
          ["drop_policy", "DROP POLICY owner_questions_company_read ON owner.questions"],
          ["create_table", "CREATE TABLE owner.mine (id uuid)"],
          ["update_answer", "UPDATE owner.answers SET prose = 'x'"],
          ["delete_question", "DELETE FROM owner.questions"],
        ];
        for (const [what, statement] of statements) {
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
      },
    );
    expect(Object.entries(refused).sort()).toEqual([
      ["create_table", "42501"],
      ["delete_question", "42501"],
      ["disable_rls", "42501"],
      ["drop_policy", "42501"],
      ["update_answer", "42501"],
    ]);
  });

  it("goes red the moment a relation here is owned by the login it binds", async () => {
    await db.query(`ALTER TABLE owner.questions OWNER TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining(`owned by ${OWNER_ROLE} rather than by dito_owner_state`),
      );
    } finally {
      // AND THE GRANTS ARE PUT BACK BY HAND, because `ALTER TABLE … OWNER
      // TO` REWRITES the ACL: the old owner's explicit entries are folded
      // into the new owner's, so handing the table to `dito_owner` and back
      // silently takes its SELECT and INSERT with it. That is worth knowing
      // beyond this test — it is how a future migration could leave the
      // owner app unable to read its own state while looking like a
      // no-op — and the audit's declared-but-missing arm is what catches it.
      await db.query("ALTER TABLE owner.questions OWNER TO dito_owner_state");
      await db.query(`GRANT SELECT, INSERT ON owner.questions TO ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner's own SCHEMA goes back to the login", async () => {
    // A schema's owner may CREATE in it, and a table it created it would
    // own — the identical hole one level up.
    await db.query(`ALTER SCHEMA owner OWNER TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain("schema:owner");
    } finally {
      await db.query("ALTER SCHEMA owner OWNER TO dito_owner_state");
      await db.query(`GRANT USAGE ON SCHEMA owner TO ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on an UPDATE or a DELETE granted to the owner on its own state", async () => {
    for (const privilege of ["UPDATE", "DELETE"]) {
      await db.query(`GRANT ${privilege} ON owner.answers TO ${OWNER_ROLE}`);
      try {
        const red = await auditLedgerGrants(db);
        expect(red.violations.map((v) => v.reason), privilege).toContainEqual(
          expect.stringContaining(`holds ${privilege} on its own state`),
        );
      } finally {
        await db.query(`REVOKE ${privilege} ON owner.answers FROM ${OWNER_ROLE}`);
      }
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner loses a grant it no longer owns its way around", async () => {
    await db.query(`REVOKE INSERT ON owner.questions FROM ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("cannot INSERT it"),
      );
    } finally {
      await db.query(`GRANT INSERT ON owner.questions TO ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a default privilege that would hand the next table too much", async () => {
    // The widening that was already there: …100020 granted ALL, so the
    // three tables arrived with UPDATE, DELETE and TRUNCATE on them.
    await db.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT ALL ON TABLES TO ${OWNER_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "default-privilege:owner",
      );
    } finally {
      await db.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA owner REVOKE ALL ON TABLES FROM ${OWNER_ROLE}`,
      );
      await db.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT SELECT, INSERT ON TABLES TO ${OWNER_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red the moment anything could connect as the role that owns the state", async () => {
    await db.query("ALTER ROLE dito_owner_state LOGIN");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "role:dito_owner_state",
      );
    } finally {
      await db.query("ALTER ROLE dito_owner_state NOLOGIN");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a fourth relation in the owner's own schema", async () => {
    // The escape hatch ownership alone did not close: a table created here
    // by a later migration is owner-readable through this schema's default
    // privileges, whatever it carries.
    await db.query("CREATE TABLE owner.seam_dump (chat_jid text)");
    await db.query("ALTER TABLE owner.seam_dump OWNER TO dito_owner_state");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "relation:owner.seam_dump",
      );
    } finally {
      await db.query("DROP TABLE owner.seam_dump");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a column nobody pinned in an owner table (Codex r2)", async () => {
    // The owner LOGIN sees every column of a table it owns, so a `chat_jid`
    // added here by a convenient migration is owner-readable the moment it
    // exists — with no grant to diff and, until this, nothing looking.
    await db.query("ALTER TABLE owner.answers ADD COLUMN chat_jid text");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:owner.answers.chat_jid",
      );
    } finally {
      await db.query("ALTER TABLE owner.answers DROP COLUMN chat_jid");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a second reader of the owner's own conversation (Codex r3)", async () => {
    // The relation-reach scan asks what `dito_owner` can reach and excludes
    // this schema, correctly. Nothing asked the other direction until now:
    // the rep side reading the owner's questions left FR-71a green.
    await db.query(`GRANT USAGE ON SCHEMA owner TO ${TWIN_RUNTIME_ROLE}`);
    await db.query(`GRANT SELECT ON owner.answers TO ${TWIN_RUNTIME_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "relation:owner.answers",
      );
      expect(red.violations.map((v) => v.subject)).toContain("schema:owner");
    } finally {
      await db.query(`REVOKE SELECT ON owner.answers FROM ${TWIN_RUNTIME_ROLE}`);
      await db.query(`REVOKE USAGE ON SCHEMA owner FROM ${TWIN_RUNTIME_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on the owner's questions handed to PUBLIC", async () => {
    await db.query("GRANT SELECT ON owner.questions TO PUBLIC");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("PUBLIC holds SELECT on the owner's own state"),
      );
    } finally {
      await db.query("REVOKE SELECT ON owner.questions FROM PUBLIC");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when row-level security stops being FORCED on an owner table", async () => {
    // `dito_owner` OWNS these tables, so ENABLE alone exempts the one role
    // that ever reads through them.
    await db.query("ALTER TABLE owner.answers NO FORCE ROW LEVEL SECURITY");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("enabled but not FORCED"),
      );
    } finally {
      await db.query("ALTER TABLE owner.answers FORCE ROW LEVEL SECURITY");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on an owner policy that lets a stored answer be rewritten", async () => {
    await db.query(
      "CREATE POLICY owner_answers_rewrite ON owner.answers FOR UPDATE USING (true)",
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("it permits UPDATE"),
      );
    } finally {
      await db.query("DROP POLICY owner_answers_rewrite ON owner.answers");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on an owner policy that stops naming a company", async () => {
    await db.query("DROP POLICY owner_questions_company_read ON owner.questions");
    await db.query(
      "CREATE POLICY owner_questions_company_read ON owner.questions FOR SELECT USING (true)",
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("not the pinned company predicate"),
      );
    } finally {
      await db.query("DROP POLICY owner_questions_company_read ON owner.questions");
      await db.query(
        "CREATE POLICY owner_questions_company_read ON owner.questions FOR SELECT USING (company_id = ledger.declared_company())",
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  // THE EXCEPTION IS GONE, AND THE PLANTS FLIP WITH IT (ticket #165; the
  // decision on #157). Claim 6 is back to "no privilege of any kind on any
  // relation outside its own schema" with no named exception at all — the
  // shared chain is a same-company rep-activity record, and the owner twin
  // appends to `owner.audit_chain` under its own key instead. The two grants
  // …100080 wrote are the ones planted here: SELECT is the READ #157 is
  // about, INSERT is the write that went with it.
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
    it(`goes red on ${privilege} handed to the owner on the rep side's chain (#157)`, async () => {
      await db.query(`GRANT ${privilege} ON audit_chain TO ${OWNER_ROLE}`);
      try {
        const red = await auditLedgerGrants(db);
        expect(red.violations, privilege).toContainEqual({
          subject: "table:public.audit_chain",
          reason: `${OWNER_ROLE} holds ${privilege} on the rep side's audit chain — the owner side may read only what it wrote (#157), and this chain is a same-company rep-activity record: every \`customer_send\` with its outcome and its timestamp, every refusal, and the \`twin:<id>\` refs the seats view withholds (ADR-0025, ADR-0004 as amended). The owner twin appends to \`${OWNER_SCHEMA}.audit_chain\` under its own key`,
        });
      } finally {
        await db.query(`REVOKE ${privilege} ON audit_chain FROM ${OWNER_ROLE}`);
      }
      expect((await auditLedgerGrants(db)).violations).toEqual([]);
    });
  }

  it("goes red on the rep chain's SEQUENCE, which counts it exactly (#165, Codex r1)", async () => {
    // THE SIGNAL WITH THE TABLE TAKEN AWAY. `audit_chain.id` is GENERATED
    // ALWAYS AS IDENTITY, so `public.audit_chain_id_seq` exists — and
    // `SELECT last_value` from it is an EXACT running count of the rep side's
    // chain entries, pollable to time every rep act, with no privilege on the
    // table at all. Claim 6's table sweep knows nothing about sequences, so
    // this one grant left FR-71a green over exactly the signal #157 revoked
    // the table grant over.
    await db.query(
      `GRANT SELECT ON SEQUENCE public.audit_chain_id_seq TO ${OWNER_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "sequence:public.audit_chain_id_seq",
      );
      // ...and it really is readable, which is what makes the grant a leak
      // rather than a tidiness question.
      const seen = await withRoleClient(
        OWNER_ROLE,
        OWNER_TEST_PASSWORD,
        async (client) => {
          const res = await client.query<{ last_value: string }>(
            "SELECT last_value FROM public.audit_chain_id_seq",
          );
          return res.rows[0]!.last_value;
        },
      );
      expect(seen).toBeDefined();
    } finally {
      await db.query(
        `REVOKE ALL ON SEQUENCE public.audit_chain_id_seq FROM ${OWNER_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  for (const privilege of ["USAGE", "UPDATE"] as const) {
    it(`goes red on ${privilege} on a rep-side sequence too — all three are reads or writes of it`, async () => {
      await db.query(
        `GRANT ${privilege} ON SEQUENCE public.wa_events_id_seq TO ${OWNER_ROLE}`,
      );
      try {
        const red = await auditLedgerGrants(db);
        expect(red.violations.map((v) => v.subject), privilege).toContain(
          "sequence:public.wa_events_id_seq",
        );
      } finally {
        await db.query(
          `REVOKE ALL ON SEQUENCE public.wa_events_id_seq FROM ${OWNER_ROLE}`,
        );
      }
      expect((await auditLedgerGrants(db)).violations).toEqual([]);
    });
  }

  it("holds NOTHING on its own chain's sequence either — RLS does not reach one (#165, Codex r1)", async () => {
    // ROW-LEVEL SECURITY DOES NOT APPLY TO SEQUENCES, so
    // `owner.audit_chain_id_seq` is a GLOBAL allocation counter: one
    // company's connection reading `last_value` learns how many entries EVERY
    // company has written, and polling it times their executions — inside the
    // schema the owner is supposed to own. `…100090`'s sequence default had
    // granted exactly that, on the premise that an identity column needs it.
    const held = await db.query<{ privilege: string }>(
      `SELECT p.privilege
         FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
        WHERE has_sequence_privilege($1, 'owner.audit_chain_id_seq', p.privilege)
        ORDER BY 1`,
      [OWNER_ROLE],
    );
    expect(held.rows).toEqual([]);
    // ...AND THE PREMISE WAS FALSE, which is what makes the revoke free: a
    // column GENERATED ALWAYS AS IDENTITY is allocated by the system with no
    // privilege check, so the owner still appends and still cannot count.
    const inserted = await withRoleClient(
      OWNER_ROLE,
      OWNER_TEST_PASSWORD,
      async (client) => {
        const company = randomUUID();
        await client.query("SELECT set_config($1, $2, false)", [
          OWNER_COMPANY_SETTING,
          company,
        ]);
        const res = await client.query<{ id: string }>(
          `INSERT INTO owner.audit_chain
             (company_id, caller, action, ref, outcome, entry_hash)
           VALUES ($1, 'execution', 'execution', NULL, 'answered', '\\x00')
           RETURNING id`,
          [company],
        );
        return res.rows[0]!.id;
      },
    );
    expect(inserted).toBeDefined();
    const refused = await withRoleClient(
      OWNER_ROLE,
      OWNER_TEST_PASSWORD,
      async (client) => {
        try {
          await client.query("SELECT last_value FROM owner.audit_chain_id_seq");
          return null;
        } catch (err) {
          return pgErrorCode(err);
        }
      },
    );
    expect(refused).toBe("42501");
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a SECOND ROLE handed the owner's sequence — the leak in the other direction (#165, Codex r2)", async () => {
    // THE INVERSE OF THE LEAK ABOVE. The sequence sweep pins what
    // `dito_owner` may hold; nothing looked at what anybody ELSE may hold, so
    // one line would have handed the REP side a global counter of every
    // company's owner appends while every invariant stayed green — against
    // this file's own sentence that nobody but the state role holds anything
    // in the owner's schema.
    for (const grantee of [TWIN_RUNTIME_ROLE, "PUBLIC"]) {
      await db.query(
        `GRANT SELECT ON SEQUENCE owner.audit_chain_id_seq TO ${grantee}`,
      );
      try {
        const red = await auditLedgerGrants(db);
        expect(red.violations.map((v) => v.subject), grantee).toContain(
          `sequence:${OWNER_SCHEMA}.audit_chain_id_seq`,
        );
      } finally {
        await db.query(
          `REVOKE ALL ON SEQUENCE owner.audit_chain_id_seq FROM ${grantee}`,
        );
      }
      expect((await auditLedgerGrants(db)).violations, grantee).toEqual([]);
    }
  });

  it("goes red if the owner's own sequence is handed back, and on the default that would do it", async () => {
    await db.query(
      `GRANT SELECT ON SEQUENCE owner.audit_chain_id_seq TO ${OWNER_ROLE}`,
    );
    try {
      expect((await auditLedgerGrants(db)).violations.map((v) => v.subject)).toContain(
        "sequence:owner.audit_chain_id_seq",
      );
    } finally {
      await db.query(
        `REVOKE ALL ON SEQUENCE owner.audit_chain_id_seq FROM ${OWNER_ROLE}`,
      );
    }
    // ...and the default privilege that would put it on the NEXT table's
    // sequence, which no sweep over existing relations could see.
    await db.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT USAGE, SELECT ON SEQUENCES TO ${OWNER_ROLE}`,
    );
    try {
      expect((await auditLedgerGrants(db)).violations.map((v) => v.subject)).toContain(
        "default-privilege:owner",
      );
    } finally {
      await db.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA owner REVOKE ALL ON SEQUENCES FROM ${OWNER_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on ANY public table handed to the owner — there is no named exception left", async () => {
    await db.query(`GRANT SELECT ON companies TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.companies",
      );
    } finally {
      await db.query(`REVOKE SELECT ON companies FROM ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("reports zero owner privileges outside the owner's own schema (#157 decision 2)", async () => {
    // The claim stated positively, over the catalog, rather than only as the
    // absence of a violation: `dito_owner` reaches exactly the three pinned
    // views and nothing else anywhere — no `public` table at all, the chain
    // included. `has_table_privilege` answers the EFFECTIVE question, so a
    // privilege arriving through PUBLIC or a role membership counts here.
    const reachable = await db.query<{ qualified: string; privilege: string }>(
      `SELECT n.nspname || '.' || c.relname AS qualified, p.privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
                    AS p(privilege)
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', $2)
          AND n.nspname NOT LIKE 'pg\\_%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (has_table_privilege($1, c.oid, p.privilege)
               OR CASE WHEN p.privilege IN ('SELECT', 'INSERT', 'UPDATE',
                                            'REFERENCES')
                       THEN has_any_column_privilege($1, c.oid, p.privilege)
                       ELSE false END)
        ORDER BY 1, 2`,
      [OWNER_ROLE, OWNER_SCHEMA],
    );
    expect(
      [...new Set(reachable.rows.map((row) => row.qualified))].sort(),
    ).toEqual(Object.keys(OWNER_VISIBLE_COLUMNS).sort());
    expect([...new Set(reachable.rows.map((row) => row.privilege))]).toEqual([
      "SELECT",
    ]);
  });

  // ...AND THE OWNER'S OWN CHAIN IS COVERED BY ENUMERATION, not by a second
  // named exception: it is a fourth `OWNER_RELATIONS` entry, so every claim
  // this file already makes about the owner's own state is made about it too.
  it("goes red on an UPDATE granted to the owner on its OWN chain — append-only, in the grant diff", async () => {
    await db.query(`GRANT UPDATE ON owner.audit_chain TO ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.reason)).toContainEqual(
        expect.stringContaining("holds UPDATE on its own state"),
      );
    } finally {
      await db.query(`REVOKE UPDATE ON owner.audit_chain FROM ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the owner loses the SELECT its own tail read needs", async () => {
    // `appendOwnerAuditEntry` reads the tail and AUTHENTICATES it under the
    // owner key before extending it, so INSERT alone is an owner twin that
    // fails on a privilege the first time it chains anything.
    await db.query(`REVOKE SELECT ON owner.audit_chain FROM ${OWNER_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: `relation:${OWNER_SCHEMA}.audit_chain`,
        reason: expect.stringContaining("cannot SELECT it"),
      });
    } finally {
      await db.query(`GRANT SELECT ON owner.audit_chain TO ${OWNER_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when row-level security stops being FORCED on the owner's chain", async () => {
    // The one that partitions the table into one chain per company. Without
    // FORCE the state role would be exempt, and the day ownership moved back
    // every company's chain would be readable through one connection.
    await db.query("ALTER TABLE owner.audit_chain NO FORCE ROW LEVEL SECURITY");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        `relation:${OWNER_SCHEMA}.audit_chain`,
      );
    } finally {
      await db.query("ALTER TABLE owner.audit_chain FORCE ROW LEVEL SECURITY");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a column nobody pinned in the owner's chain", async () => {
    // The chain's refs are content-free and its columns are pinned like every
    // other owner table's: a `twin_id` added here by a convenient migration
    // is owner-readable the moment it exists.
    await db.query("ALTER TABLE owner.audit_chain ADD COLUMN twin_id uuid");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        `column:${OWNER_SCHEMA}.audit_chain.twin_id`,
      );
    } finally {
      await db.query("ALTER TABLE owner.audit_chain DROP COLUMN twin_id");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });
});

/**
 * THE REP-WEB CLAUSE (ticket #221 AC 2; spec #214 *Roles and grants*;
 * ADR-0002, ADR-0006, ADR-0008, ADR-0010).
 *
 * "The grants check is green with the rep-web clause and red on a planted
 * grant to a sealed column or a key table" — so each of those is planted
 * here, watched red, and restored, the way every other invariant in this
 * file is proven. An invariant nobody has seen fail is a comment.
 */
describe("the rep dashboard's clause (claim 10, ticket #221)", () => {
  it("is green on the migrated schema and names the role it audited", async () => {
    const report = await auditLedgerGrants(db);
    expect(report.violations).toEqual([]);
    expect(report.auditedRoles).toContain(REP_WEB_ROLE);
  });

  it("goes red on a planted grant to a SEALED COLUMN of drafts", async () => {
    // `content_enc` is the body a tap releases and the runtime is the only
    // process that may open it (ADR-0008, ADR-0010). A column-level grant is
    // how a table-wide read arrives one column at a time, which is why
    // `has_table_privilege` alone cannot see this one.
    await db.query(`GRANT SELECT (content_enc) ON drafts TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.drafts.content_enc",
      );
    } finally {
      await db.query(
        `REVOKE SELECT (content_enc) ON drafts FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to the KEY TABLE", async () => {
    // The wrapped DEK. rep-web holding no key is not the reason this is a
    // violation: ADR-0008's custody of two says the process that may unseal
    // is the lease holder, so the row naming a key is not rep-web's to read.
    await db.query(`GRANT SELECT ON twin_keys TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:public.twin_keys",
        reason: `${REP_WEB_ROLE} holds SELECT — rep-web holds no key and reads plaintext seam rows only: everything sealed or bundle-resident is served by the twin runtime's local API, because the lease holder is the only process that may unseal (ADR-0008, ADR-0010; spec #214 *Roles and grants*)`,
      });
    } finally {
      await db.query(`REVOKE SELECT ON twin_keys FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to a Ledger object", async () => {
    // ADR-0010's letter: dashboards are clients of the lease holder's API,
    // never store readers — and the Ledger is the far side of the wall from
    // rep-web in the other direction as well (ADR-0003).
    await db.query(`GRANT SELECT ON ledger.finalized_facts TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "view:ledger.finalized_facts",
      );
    } finally {
      await db.query(
        `REVOKE SELECT ON ledger.finalized_facts FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a table-wide SELECT where only plaintext columns are pinned", async () => {
    // The other shape of the sealed-column violation, and the one a reviewer
    // would more plausibly write: `GRANT SELECT ON drafts` looks exactly like
    // the grant beside it for `rail_status_events` and hands over both sealed
    // columns at once.
    await db.query(`GRANT SELECT ON drafts TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.drafts",
      );
    } finally {
      await db.query(`REVOKE SELECT ON drafts FROM ${REP_WEB_ROLE}`);
      // A REVOKE on the whole relation takes the column grants with it, so
      // the pinned four go back explicitly — …20260907100040's own statement.
      await db.query(
        `GRANT SELECT (id, twin_id, destination, created_at) ON drafts TO ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to the rail's `detail` column", async () => {
    // On a `qr` row `detail` is the raw pairing code the plane generated — a
    // LIVE CREDENTIAL for linking a WhatsApp account — and the table carries
    // no company and no row-level security, so a grant here hands one login
    // role every twin in the fleet's pairing tokens.
    await db.query(
      `GRANT SELECT (detail) ON rail_status_events TO ${REP_WEB_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.rail_status_events.detail",
      );
    } finally {
      await db.query(
        `REVOKE SELECT (detail) ON rail_status_events FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to `posts` — the store the API exists to serve", async () => {
    // THE SHARPEST OF THE ABSENCES (ticket #224). A post's parts are sealed
    // under the twin DEK and the whole reason the runtime carries a local API
    // is that only the lease holder may open one (ADR-0010). rep-web renders
    // cards from that API's answer, so a grant here would make the door
    // decorative — and it is the grant somebody would plausibly add to save a
    // round trip.
    await db.query(`GRANT SELECT ON posts TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.posts",
      );
    } finally {
      await db.query(`REVOKE SELECT ON posts FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to the chat directory's SEALED NAME (ticket #223)", async () => {
    // `name_enc` IS WHAT A REP'S PHONE CALLS A PERSON, under the twin DEK —
    // and rep-web holds no key at all (ADR-0008's custody of two), so a grant
    // here would hand it ciphertext it can never open AND make the pin unable
    // to say so. The names reach the scoping page OPENED, through the
    // runtime's local API (ADR-0010), which is the whole reason that read
    // exists.
    await db.query(
      `GRANT SELECT (name_enc) ON chat_directory TO ${REP_WEB_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.chat_directory.name_enc",
      );
    } finally {
      await db.query(
        `REVOKE SELECT (name_enc) ON chat_directory FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted UPDATE of a seat column nobody pinned (ticket #223)", async () => {
    // THE SEAT'S STATE IS THE LEASE HOLDER'S, written from the rail's own row
    // (`seat-state.ts`). rep-web writes exactly two columns — the address the
    // rep types and the stamp link day's last step leaves — and a dashboard
    // that could write `state` could claim a number was linked that never was,
    // which is the one fact on link day nothing downstream re-checks.
    await db.query(`GRANT UPDATE (state) ON seats TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.seats.state",
      );
    } finally {
      await db.query(`REVOKE UPDATE (state) ON seats FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted INSERT of `invitations` (ticket #223)", async () => {
    // ISSUING AN INVITATION IS AN OPERATOR'S DECISION ABOUT A SEAT. rep-web
    // CONSUMES one — SELECT to find it by digest, UPDATE to stamp it — and a
    // login surface that could mint one could invite itself.
    await db.query(`GRANT INSERT ON invitations TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.invitations",
      );
    } finally {
      await db.query(`REVOKE INSERT ON invitations FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted UPDATE of `acknowledgments` (ticket #223)", async () => {
    // A CONSENT RECORD A LOGIN CAN REWRITE IS NOT A CONSENT RECORD. The
    // trigger refuses it too — even from the schema owner — and this is the
    // half that says so in the grant diff, which is where a later migration's
    // convenience would show up.
    await db.query(`GRANT UPDATE ON acknowledgments TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.acknowledgments",
      );
    } finally {
      await db.query(`REVOKE UPDATE ON acknowledgments FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to `plane_requests` — the ask it may not write (ticket #223)", async () => {
    // "A rep-web that could INSERT here could ask the plane to fill a chat
    // with no act, no allowlist row and no audit entry behind it"
    // (…20260908100050's own words). The link ask and the two scope switches
    // all write this table, and all three go through the lease holder.
    await db.query(`GRANT INSERT ON plane_requests TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.plane_requests",
      );
    } finally {
      await db.query(`REVOKE INSERT ON plane_requests FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to `dashboard_acts` — the evidence it may not write", async () => {
    // The dashboard does not record its own acts: it asks the lease holder to
    // perform them, and the runtime records that it was asked (ADR-0003's
    // class-2 evidence, on the surface that is not the twin thread). A role
    // that could INSERT here could mint its own evidence, which is exactly
    // what the whole class-2 rule exists to prevent.
    await db.query(`GRANT INSERT ON dashboard_acts TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.dashboard_acts",
      );
    } finally {
      await db.query(`REVOKE INSERT ON dashboard_acts FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to a column of `send_commands` nobody pinned", async () => {
    // The send lock's writer WRITES `destination` and `payload_ref` and never
    // reads them, so neither is pinned: a destination is chat identity
    // (ADR-0004) and a `payload_ref` is the plane executor's contract rather
    // than a page's. A column grant is how a table-wide read arrives one
    // column at a time.
    await db.query(
      `GRANT SELECT (destination) ON send_commands TO ${REP_WEB_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.send_commands.destination",
      );
    } finally {
      await db.query(
        `REVOKE SELECT (destination) ON send_commands FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a pinned read the writer needs has been revoked", async () => {
    // THE OTHER DIRECTION, which is what makes the pin a diff rather than a
    // ceiling: a privilege this list names and the catalog lacks is a page
    // that fails on a grant. `send_allowlist` is the hard allowlist the writer
    // reads before it mints anything (ADR-0017), so without it Enviar refuses
    // every send with a Postgres error rather than a reason.
    await db.query(`REVOKE SELECT ON send_allowlist FROM ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.send_allowlist",
      );
    } finally {
      await db.query(`GRANT SELECT ON send_allowlist TO ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a pinned COLUMN the writer needs has been revoked", async () => {
    // `taps.id` is the column `INSERT … RETURNING id` returns, and RETURNING
    // needs SELECT on it — so this is the grant whose absence would make the
    // send lock fail after the tap row was already written.
    await db.query(`REVOKE SELECT (id) ON taps FROM ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.taps.id",
      );
    } finally {
      await db.query(`GRANT SELECT (id) ON taps TO ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted SELECT of `send_refusals` — it writes them and never reads them", async () => {
    // The dashboard records a refusal because it holds no chain key; it has no
    // business reading one back, and a role that could would be able to count
    // another twin's refusals (the table carries no company and no
    // row-level security).
    await db.query(`GRANT SELECT ON send_refusals TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.send_refusals",
      );
    } finally {
      await db.query(`REVOKE SELECT ON send_refusals FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to a privileged built-in", async () => {
    // THE HOLE EVERY OTHER ARM MISSES (Codex r1). This grant changes no table
    // grant, no column grant, no policy and no role membership — and
    // `SELECT pg_read_binary_file('base/…')` then reads the FILES under
    // `twin_keys` and under every Ledger table, past every privilege this
    // audit pins. The claim is list-free: rep-web may execute no built-in
    // PUBLIC cannot, so any privileged routine granted to it shows up.
    await db.query(
      `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) TO ${REP_WEB_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:pg_catalog.pg_read_binary_file(text)",
      );
    } finally {
      await db.query(
        `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a planted grant to a system CATALOG", async () => {
    // CODEX r2. `pg_statistic` holds sampled VALUES from every analyzed
    // column — the counterparty names in `disclosure_lines`, a rep's address
    // on `seats` — so reading it reads a sample of what this role may not
    // read, which is why PostgreSQL ships it restricted. The relation sweep
    // excludes `pg_catalog` and cannot see this one.
    await db.query(
      `GRANT SELECT ON pg_catalog.pg_statistic TO ${REP_WEB_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:pg_catalog.pg_statistic",
      );
    } finally {
      await db.query(
        `REVOKE SELECT ON pg_catalog.pg_statistic FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red on a file reader granted to PUBLIC, not only to the role", async () => {
    // CODEX r2, and this is the one that made the r1 fix worth re-attacking.
    // The first shape of that check asked whether rep-web could execute a
    // built-in PUBLIC could not — so a grant TO PUBLIC made the predicate
    // false and the audit blind at the exact moment the hole was widest.
    // Both routes are planted here.
    for (const grantee of ["PUBLIC", REP_WEB_ROLE]) {
      await db.query(
        `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) TO ${grantee}`,
      );
      try {
        const red = await auditLedgerGrants(db);
        expect(
          red.violations.map((v) => v.subject),
          `granted to ${grantee}`,
        ).toContain("function:pg_catalog.pg_read_binary_file");
      } finally {
        await db.query(
          `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text) FROM ${grantee}`,
        );
      }
      expect((await auditLedgerGrants(db)).violations).toEqual([]);
    }
  });

  it("goes red on a sequence, which the relation sweep cannot see", async () => {
    // #165's finding, one role over: `last_value` is an exact running count
    // of the table it numbers, and `has_table_privilege` knows nothing about
    // sequences. `rail_status_events` numbers itself with an identity column,
    // so the sequence exists and nothing needs a privilege on it.
    const sequence = "public.rail_status_events_id_seq";
    await db.query(`GRANT SELECT ON SEQUENCE ${sequence} TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        `sequence:${sequence}`,
      );
    } finally {
      await db.query(
        `REVOKE SELECT ON SEQUENCE ${sequence} FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a login store's company policy is widened to true", async () => {
    // ENABLED and FORCED are claims about the switch; this is the claim about
    // the rule. A `USING (true)` policy leaves every flag and every grant
    // exactly as they were and makes every company's sessions readable by
    // every deployment.
    await db.query("DROP POLICY sessions_rep_web ON sessions");
    try {
      await db.query(
        `CREATE POLICY sessions_rep_web ON sessions FOR ALL TO ${REP_WEB_ROLE} USING (true) WITH CHECK (true)`,
      );
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "policy:public.sessions.sessions_rep_web",
      );
    } finally {
      await db.query("DROP POLICY IF EXISTS sessions_rep_web ON sessions");
      await db.query(
        `CREATE POLICY sessions_rep_web ON sessions FOR ALL TO ${REP_WEB_ROLE} USING (company_id = ledger.declared_company()) WITH CHECK (company_id = ledger.declared_company())`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when a login store's row-level security is switched off", async () => {
    await db.query("ALTER TABLE login_codes DISABLE ROW LEVEL SECURITY");
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "table:public.login_codes",
      );
    } finally {
      await db.query("ALTER TABLE login_codes ENABLE ROW LEVEL SECURITY");
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when rep-web loses a privilege its own login needs", async () => {
    // The other direction of the same diff. A page that fails on a grant
    // fails on nothing a rep can act on — and for `login_codes` it is the
    // login itself that stops working.
    await db.query(`REVOKE INSERT ON login_codes FROM ${REP_WEB_ROLE}`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations).toContainEqual({
        subject: "table:public.login_codes",
        reason: `${REP_WEB_ROLE} cannot INSERT it — the dashboard's whole reach is this list, and a missing privilege is a page that fails on a grant`,
      });
    } finally {
      await db.query(`GRANT INSERT ON login_codes TO ${REP_WEB_ROLE}`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when rep-web is handed a SECURITY DEFINER function", async () => {
    // A definer routine runs with its definer's privileges, so a login that
    // can call one holds whatever the definer holds — which is how a
    // plaintext-only role reaches a sealed store with no grant on it at all.
    // `ledger.resolve_entity` is the definer function this schema already
    // has, and nothing rep-web does goes near it.
    await db.query(
      `GRANT EXECUTE ON FUNCTION ledger.resolve_entity(uuid, uuid) TO ${REP_WEB_ROLE}`,
    );
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "function:ledger.resolve_entity(uuid,uuid)",
      );
    } finally {
      await db.query(
        `REVOKE EXECUTE ON FUNCTION ledger.resolve_entity(uuid, uuid) FROM ${REP_WEB_ROLE}`,
      );
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });

  it("goes red when the role bypasses its own policies", async () => {
    // Claim 5, for the second login. BYPASSRLS is the sharper half: the
    // company policy is the whole of rep-web's tenant isolation, and a role
    // that bypasses it reads every company through the same grants with
    // nothing in the diff to show it.
    await db.query(`ALTER ROLE ${REP_WEB_ROLE} BYPASSRLS`);
    try {
      const red = await auditLedgerGrants(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        `role:${REP_WEB_ROLE}`,
      );
    } finally {
      await db.query(`ALTER ROLE ${REP_WEB_ROLE} NOBYPASSRLS`);
    }
    expect((await auditLedgerGrants(db)).violations).toEqual([]);
  });
});

/**
 * THE FIRST CLIENT INVARIANT, AS ITS OWN CHECK (ticket #263; spec #258
 * decision 5).
 *
 * Claim 10 run alone, the way CI runs it beside the Ledger audit
 * (`scripts/rep-web-grants-check.mjs`): green over the migrated schema and
 * red over a grant on something twin-side — here the bar's own store, whose
 * rows are the rep's words sealed under the twin key, and the posts the bar's
 * replies are. The script is driven too, because its exit code is what CI
 * reads.
 */
describe("the rep dashboard's grants, checked on their own (ticket #263)", () => {
  const CHECK = fileURLToPath(
    new URL("../../../scripts/rep-web-grants-check.mjs", import.meta.url),
  );

  /** Runs the script CI runs, over this suite's database. */
  function check(): { code: number; out: string } {
    const run = spawnSync(process.execPath, [CHECK], {
      encoding: "utf8",
      env: { ...process.env, DITO_DATABASE_URL: TEST_DATABASE_URL },
    });
    return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
  }

  it("is green over the migrated schema, and the script says so", async () => {
    const report = await auditRepWebGrants(db);
    expect(report.present).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.relations).toContain("public.sessions");
    expect(check().code).toBe(0);
  });

  it("goes red on a planted grant to the bar's own store, and to the posts", async () => {
    await db.query(`GRANT SELECT ON dashboard_messages TO ${REP_WEB_ROLE}`);
    await db.query(`GRANT SELECT ON posts TO ${REP_WEB_ROLE}`);
    try {
      const red = await auditRepWebGrants(db);
      expect(red.violations.map((v) => v.subject)).toEqual(
        expect.arrayContaining([
          "table:public.dashboard_messages",
          "table:public.posts",
        ]),
      );
      const ran = check();
      expect(ran.code).toBe(1);
      expect(ran.out).toContain("table:public.dashboard_messages");
    } finally {
      await db.query(`REVOKE SELECT ON dashboard_messages FROM ${REP_WEB_ROLE}`);
      await db.query(`REVOKE SELECT ON posts FROM ${REP_WEB_ROLE}`);
    }
    expect((await auditRepWebGrants(db)).violations).toEqual([]);
  });
});

/** Puts `public.seats_status` back exactly as …100030 defines it. */
async function restoreSeatsStatus(): Promise<void> {
  await db.query("DROP VIEW IF EXISTS seats_status");
  await db.query(`
    CREATE VIEW seats_status WITH (security_barrier = true) AS
    SELECT s.id AS seat_id, s.rep_display_name AS display_name, s.state
      FROM seats s`);
  await db.query(`GRANT CREATE ON SCHEMA public TO ${LEDGER_VIEWS_ROLE}`);
  await db.query(`ALTER VIEW seats_status OWNER TO ${LEDGER_VIEWS_ROLE}`);
  await db.query(`REVOKE CREATE ON SCHEMA public FROM ${LEDGER_VIEWS_ROLE}`);
  await db.query(`GRANT SELECT ON seats_status TO ${OWNER_ROLE}`);
}

describe("the wall, swept over the Ledger's content (ADR-0004)", () => {
  it("is green over real crossings, and reports what it swept", async () => {
    const seat = freshSeat();
    await crossOnce(seat, "WAMID-WALL-1");
    const report = await auditLedgerWall(db);
    expect(report.violations).toEqual([]);
    expect(report.columnsChecked).toBeGreaterThan(0);
    expect(report.crossedRows).toBeGreaterThan(0);
  });

  it("goes red on a name that is a chat — the failure mode where a push-name was missing and a JID was used instead", async () => {
    const seat = freshSeat();
    const evidence = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: "WAMID-WALL-PLANT",
      text: "va",
    });
    const entityId = randomUUID();
    await fileEntityCreate(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        kind: "person",
        // Exactly what a careless fallback would produce.
        displayName: "5215550001@s.whatsapp.net",
        evidence: { surface: "twin_thread", sourceEventId: evidence, waMessageId: "WAMID-WALL-PLANT" },
        disclosureText: "Lo di de alta como cliente.",
      },
    );

    const red = await auditLedgerWall(db);
    expect(red.violations.map((v) => v.subject)).toContain(
      "column:ledger.entities.display_name",
    );

    await db.query("DELETE FROM disclosure_lines WHERE entity_id = $1", [
      entityId,
    ]);
    await db.query("DELETE FROM ledger.entity_grants WHERE entity_id = $1", [
      entityId,
    ]);
    await db.query("DELETE FROM ledger.entities WHERE entity_id = $1", [
      entityId,
    ]);
    expect((await auditLedgerWall(db)).violations).toEqual([]);
  });

  it("sweeps the seat registry the owner reads, not only the Ledger (ticket #127)", async () => {
    // ADR-0004's amendment made a rep's display name owner-visible, and it
    // is the one free-text value on the owner's side that a PERSON types.
    // The store refuses the shape (the …100010 CHECK); this proves the
    // sweep would have caught a row written before that constraint existed,
    // which is the half a constraint cannot promise.
    const seat = freshSeat();
    await db.query("INSERT INTO companies (id, display_name) VALUES ($1, $2)", [
      seat.companyId,
      "Ferretería Fuentes",
    ]);
    await db.query(
      `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
       VALUES ($1, $2, $3, 'Mauricio', 'linked')`,
      [seat.seatId, seat.companyId, seat.twinId],
    );
    expect((await auditLedgerWall(db)).violations).toEqual([]);

    await db.query(
      "ALTER TABLE seats DROP CONSTRAINT seats_rep_display_name_not_an_address",
    );
    try {
      await db.query("UPDATE seats SET rep_display_name = $2 WHERE id = $1", [
        seat.seatId,
        "5215550001@s.whatsapp.net",
      ]);
      const red = await auditLedgerWall(db);
      expect(red.violations.map((v) => v.subject)).toContain(
        "column:public.seats.rep_display_name",
      );
    } finally {
      await db.query(
        "UPDATE seats SET rep_display_name = 'Mauricio' WHERE id = $1",
        [seat.seatId],
      );
      await db.query(
        "ALTER TABLE seats ADD CONSTRAINT seats_rep_display_name_not_an_address" +
          " CHECK (rep_display_name !~* '@(s\\.whatsapp\\.net|g\\.us|lid|broadcast)')",
      );
    }
    expect((await auditLedgerWall(db)).violations).toEqual([]);
    await db.query("DELETE FROM seats WHERE id = $1", [seat.seatId]);
    await db.query("DELETE FROM companies WHERE id = $1", [seat.companyId]);
  });
});

/**
 * THE ADR-0033 EXCLUSION INVARIANT (ticket #52; spec #48 grilling decision
 * 4): no extraction run or fact row ever carries the twin thread as its
 * source.
 *
 * TWO CLASSES OF ROW, AND THERE IS NO THIRD. The candidate-question store was
 * class-1 material under the same rule and is retired with its route (ticket
 * #218; spec #214 decision 3), so there is no clause about it to plant a
 * violation against.
 *
 * This is the rule that stops the rep's own notes to their twin being
 * disclosed to their employer, and it is the kind that rots silently — so
 * the suite proves the check CATCHES a planted violation, not merely that
 * it is green on a corpus that never had one.
 */
describe("the ADR-0033 exclusion invariant", () => {
  /** One extracted fact in a real customer chat, filed through the aperture. */
  async function extractOnce(
    seat: Seat,
    chatJid: string,
    messageId: string,
    entityId: string,
  ): Promise<string> {
    const sourceEventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid,
      // The REP's own message: «Le cotizaste …» is the rep's act (#71).
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId,
      text: "te las dejo en 4500",
    });
    const outcome = await fileCandidateFact(
      apertureCtx(db, seat.dek),
      {
        twinId: seat.twinId,
        entityId,
        sourceEventId,
        factType: "QuoteGiven",
        payload: { item: "cajas", amount: 4500, currency: "MXN" },
        confidence: 0.95,
        reading: "stated",
        renderDisclosureLine: () => "Le cotizaste cajas en 4,500 MXN.",
      },
    );
    if (!outcome.filed) throw new Error(`fixture did not file: ${outcome.reason}`);
    return outcome.factId;
  }

  /**
   * The twin thread, as the invariant finds it: a `system_send` command's
   * destination. ADR-0006 permits that class only to the rep's self-chat,
   * so the seam names the thread rather than a config value doing it.
   */
  async function twinThread(seat: Seat): Promise<void> {
    await db.query(
      `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref)
       VALUES ($1, 'system_send', $2, 'notice:fixture')`,
      [seat.twinId, SELF_CHAT],
    );
  }

  it("is green over a corpus where extraction ran, and counts what it examined", async () => {
    const seat = freshSeat();
    const chatJid = "5215559001@s.whatsapp.net";
    await twinThread(seat);
    const { entityId } = await crossOnce(seat, "WAMID-0033-1");
    await db.query(
      `INSERT INTO extraction_runs
         (twin_id, chat_jid, extraction_day, state, window_start, window_end, settled_at)
       VALUES ($1, $2, '2026-08-29', 'filed', '2026-08-29T06:00:00Z', '2026-08-30T06:00:00Z', now())`,
      [seat.twinId, chatJid],
    );
    await extractOnce(seat, chatJid, "WAMID-0033-Q1", entityId);

    const report = await auditSelfChatExclusion(db);
    expect(report.violations).toEqual([]);
    expect(report.selfChats).toBeGreaterThan(0);
    expect(report.extractionRuns).toBeGreaterThan(0);
    expect(report.extractedFacts).toBeGreaterThan(0);
  });

  it("does NOT flag an entity create evidenced in the twin thread — the rep's own «si» is exactly what is supposed to arrive there", async () => {
    const seat = freshSeat();
    await twinThread(seat);
    await crossOnce(seat, "WAMID-0033-CREATE");
    expect((await auditSelfChatExclusion(db)).violations).toEqual([]);
  });

  it("goes red on a planted extraction run over the twin thread, and green again once it is gone", async () => {
    const seat = freshSeat();
    await twinThread(seat);
    const planted = await db.query<{ id: string }>(
      `INSERT INTO extraction_runs
         (twin_id, chat_jid, extraction_day, state, window_start, window_end, settled_at)
       VALUES ($1, $2, '2026-08-29', 'filed', '2026-08-29T06:00:00Z', '2026-08-30T06:00:00Z', now())
       RETURNING id`,
      [seat.twinId, SELF_CHAT],
    );
    const runId = planted.rows[0]!.id;

    const red = await auditSelfChatExclusion(db);
    expect(red.violations).toContainEqual({
      subject: `run:${runId}`,
      reason:
        "extraction ran over the twin thread — the rep's own notes are never an extraction input (ADR-0033)",
    });

    // `extraction_runs` is bookkeeping, not a record made to the rep, so
    // the planted row can be removed and the audit go green again.
    await db.query("DELETE FROM extraction_runs WHERE id = $1", [runId]);
    expect((await auditSelfChatExclusion(db)).violations).toEqual([]);
  });

  it("goes red on a twin whose own thread cannot be identified — an uncheckable twin is not a passing one", async () => {
    const seat = freshSeat();
    // No `system_send` for this twin, so the derivation finds no thread and
    // every other check joins against nothing. Silence would be the worst
    // possible answer for an invariant whose job is to notice.
    await db.query(
      `INSERT INTO extraction_runs
         (twin_id, chat_jid, extraction_day, state, window_start, window_end, settled_at)
       VALUES ($1, '5215559002@s.whatsapp.net', '2026-08-29', 'filed',
               '2026-08-29T06:00:00Z', '2026-08-30T03:30:00Z', now())`,
      [seat.twinId],
    );

    const red = await auditSelfChatExclusion(db);
    expect(red.violations.map((v) => v.subject)).toContain(
      `twin:${seat.twinId}`,
    );

    await db.query("DELETE FROM extraction_runs WHERE twin_id = $1", [
      seat.twinId,
    ]);
    expect((await auditSelfChatExclusion(db)).violations).toEqual([]);
  });

  it("goes red on a fact extracted from the twin thread — the rep's own notes disclosed to their employer", async () => {
    const seat = freshSeat();
    await twinThread(seat);
    const { entityId } = await crossOnce(seat, "WAMID-0033-2");
    // A note the rep typed to their own twin. Nothing in this repo files a
    // fact from one — which is why the invariant has to prove it would be
    // caught if something ever did.
    const noteEventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: "WAMID-0033-NOTE",
      text: "recuerda: con Fuentes siempre de usted",
    });

    // Planted directly, both rows in one transaction so the deferred FR-72
    // trigger is satisfied — no trigger is disabled, because this is a
    // state the SCHEMA permits and only the enumeration prevents.
    await db.query("BEGIN");
    const factId = (
      await db.query<{ id: string }>(
        `INSERT INTO ledger.facts
           (company_id, entity_id, fact_type, payload_version, payload,
            occurred_at, confidence, source_type, filed_by_twin_id)
         VALUES ($1, $2, 'ContactEstablished', 1,
                 '{"identifiers":{"phones":[],"emails":["x@y.mx"],"rfcs":[]}}'::jsonb,
                 now(), 0.99, 'extraction', $3)
         RETURNING id`,
        [seat.companyId, entityId, seat.twinId],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO disclosure_lines
         (company_id, seat_id, twin_id, subject_kind, fact_id, entity_id,
          rendered_text, source_event_id)
       VALUES ($1, $2, $3, 'fact', $4, $5, 'Guardé sus datos de contacto.', $6)`,
      [
        seat.companyId,
        seat.seatId,
        seat.twinId,
        factId,
        entityId,
        noteEventId,
      ],
    );
    await db.query("COMMIT");

    const red = await auditSelfChatExclusion(db);
    expect(red.violations).toContainEqual({
      subject: `fact:${factId}`,
      reason:
        "a fact was extracted from the twin thread and crossed to the company — provenance decides what crosses, and a rep-stated item never does (ADR-0033)",
    });
  });

});

/**
 * The wall's other half over fact payloads (ticket #52; ADR-0004): the
 * counterparty's own WhatsApp number is chat identity in a shape the JID
 * suffix sweep cannot see.
 */
describe("the wall over a fact payload's identifiers", () => {
  it("goes red when a fact payload carries the subscriber number of a chat in the capture scope", async () => {
    const seat = freshSeat();
    const chatJid = "5215559777@s.whatsapp.net";
    await db.query(
      "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
      [seat.twinId, chatJid],
    );
    const { entityId } = await crossOnce(seat, "WAMID-WALL-PHONE");
    const sourceEventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid,
      senderJid: chatJid,
      fromMe: false,
      messageId: "WAMID-WALL-PHONE-SRC",
      text: "hola",
    });

    // Planted, because the aperture refuses to file it — which is the
    // point: this audit is the independent check over that refusal.
    await db.query("BEGIN");
    const factId = (
      await db.query<{ id: string }>(
        `INSERT INTO ledger.facts
           (company_id, entity_id, fact_type, payload_version, payload,
            occurred_at, confidence, source_type, filed_by_twin_id)
         VALUES ($1, $2, 'ContactEstablished', 1,
                 '{"identifiers":{"phones":["+525215559777"],"emails":[],"rfcs":[]}}'::jsonb,
                 now(), 0.99, 'extraction', $3)
         RETURNING id`,
        [seat.companyId, entityId, seat.twinId],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO disclosure_lines
         (company_id, seat_id, twin_id, subject_kind, fact_id, entity_id,
          rendered_text, source_event_id)
       VALUES ($1, $2, $3, 'fact', $4, $5, 'Guardé su teléfono.', $6)`,
      [seat.companyId, seat.seatId, seat.twinId, factId, entityId, sourceEventId],
    );
    await db.query("COMMIT");

    const red = await auditLedgerWall(db);
    expect(red.violations.map((v) => v.subject)).toContain(
      "column:ledger.facts.payload",
    );

    await db.query("DELETE FROM disclosure_lines WHERE fact_id = $1", [factId]);
    await db.query("DELETE FROM ledger.facts WHERE id = $1", [factId]);
    await db.query("DELETE FROM scope_allowlist WHERE twin_id = $1", [
      seat.twinId,
    ]);
  });

  /**
   * The merge edge is the OTHER place a phone number is now stored (ticket
   * #55): a merge that fired on the phone rung records the value that fired
   * it, in its effect set. If that value were ever a counterparty's own
   * address, the same owner join that the fact sweep exists to stop would
   * work against `entity_merges` instead — so the sweep covers it too, or
   * the merge edge is simply the hole the fact sweep closed.
   */
  it("goes red when a merge edge's effect set carries the subscriber number of a chat in the capture scope", async () => {
    const seat = freshSeat();
    const chatJid = "5215559778@s.whatsapp.net";
    await db.query(
      "INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2)",
      [seat.twinId, chatJid],
    );
    const { entityId: winner } = await crossOnce(seat, "WAMID-WALL-MERGE-W");
    const { entityId: loser } = await crossOnce(seat, "WAMID-WALL-MERGE-L");

    // Planted, because the aperture refuses to file the fact this value
    // would have had to come from — which is exactly why the audit is the
    // independent check rather than a restatement of the writer.
    const planted = await db.query<{ id: string }>(
      `INSERT INTO ledger.entity_merges
         (company_id, loser_entity_id, winner_entity_id, status,
          performed_by, matched_on, effect_set)
       VALUES ($1, $2, $3, 'merged', 'machine', 'phone',
               '{"matchedOn":"phone","matchedValue":"+525215559778"}'::jsonb)
       RETURNING id`,
      [seat.companyId, loser, winner],
    );

    const red = await auditLedgerWall(db);
    expect(red.violations.map((v) => v.subject)).toContain(
      "column:ledger.entity_merges.effect_set",
    );

    // The edge is immutable, so the plant is cleared the only way an
    // append-only table allows: with the trigger off, as the FR-72 suite
    // does for its own planted rows.
    await db.query("ALTER TABLE ledger.entity_merges DISABLE TRIGGER ALL");
    try {
      await db.query("DELETE FROM ledger.entity_merges WHERE id = $1", [
        planted.rows[0]!.id,
      ]);
    } finally {
      await db.query("ALTER TABLE ledger.entity_merges ENABLE TRIGGER ALL");
    }
    await db.query("DELETE FROM scope_allowlist WHERE twin_id = $1", [
      seat.twinId,
    ]);
    expect((await auditLedgerWall(db)).violations).toEqual([]);
  });
});

describe("the audit chain's coverage (ticket #78; ADR-0020, spec #48 decision 18)", () => {
  /** The seam's own marker for an act, as the consumer writes one. */
  async function markProcessed(
    seat: Seat,
    eventId: string,
    disposition: string,
  ): Promise<void> {
    await db.query(
      "INSERT INTO wa_event_processing (event_id, twin_id, disposition) VALUES ($1, $2, $3)",
      [eventId, seat.twinId, disposition],
    );
  }

  async function violationsFor(cls: string): Promise<readonly unknown[]> {
    const report = await auditChainCoverageInDb(db);
    return report.violations.filter((v) => v.class === cls);
  }

  function missing(
    cls: string,
    action: string,
    subject: string,
    // The class's own citation, when the coverage claim's usual pair does
    // not govern it — a kind determination is neither a rep act nor a
    // refusal of one, so decision 18 has nothing to say about it.
    citation = "ADR-0020, spec #48 decision 18",
  ) {
    return {
      class: cls,
      subject,
      reason: `no \`${action}\` chain entry records this act (${citation})`,
    };
  }

  /** What a filed entity with no traceable determination reads as. */
  function missingKind(companyId: string, entityId: string) {
    return missing(
      "entity_kind",
      "entity_kind",
      `entity ${companyId}/${entityId}`,
      "ADR-0020, ADR-0035 as amended",
    );
  }

  it("does not accept a retraction that SUCCEEDED as the record of one that was refused", async () => {
    // A refusal writes no row anywhere else to join against — a successful
    // entity create leaves an entity, a retraction leaves a retraction, and
    // `correction_refused` leaves only this disposition and a notice. So an
    // entry saying the fact WAS retracted must not satisfy the marker that
    // says the rep was told no.
    const seat = freshSeat();
    const eventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: `COVERAGE-REFUSED-${seat.twinId.slice(0, 8)}`,
      text: "9 no",
    });
    await db.query("BEGIN");
    try {
      await markProcessed(seat, eventId, "correction_refused");
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "aperture",
        action: "fact_retraction",
        ref: `twin:${seat.twinId} event:${eventId}`,
        outcome: "retracted",
      });
      expect(await violationsFor("fact_retraction_refused")).toEqual([
        missing("fact_retraction_refused", "fact_retraction", `wa_event ${eventId}`),
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await violationsFor("fact_retraction_refused")).toEqual([]);
  });

  it("does not accept a REFUSED determination as the record that somebody judged an entity", async () => {
    // `fileEntityKind` chains `refused:unknown_entity` when a determination
    // names an entity nobody filed, and that entry carries the SAME
    // company/entity pair a real determination would (ticket #60). So an
    // entity created after such a refusal would read as judged, and the
    // label sitting in its column would trace back to nobody — which is the
    // one question the entry exists to answer (ADR-0035 as amended).
    const seat = freshSeat();
    const entityId = randomUUID();
    await db.query("BEGIN");
    try {
      // The entity's own triggers are DEFERRED to COMMIT, so a rolled-back
      // plant never fires them — the same shape the FR-72 plants beside
      // this one use.
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'business', 'Ferretería Fuentes', now())`,
        [seat.companyId, entityId],
      );
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "aperture",
        action: "entity_kind",
        ref: `company:${seat.companyId} entity:${entityId} by:model`,
        outcome: "refused:unknown_entity",
      });
      expect(await violationsFor("entity_kind")).toEqual([
        missingKind(seat.companyId, entityId),
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await violationsFor("entity_kind")).toEqual([]);
  });

  it("refuses a determination entry that names no determiner, because the ADR promises one", async () => {
    // ADR-0035 as amended: every determination is chained "with a
    // `model`-or-`human` stamp, so «which of these did anybody actually
    // look at» is answerable from the chain". `KIND_DETERMINERS` fences the
    // TypeScript call sites; nothing fences a `.mjs` script, a psql session
    // or an older build, which is the same gap the vocabulary sweep exists
    // for. An entry with no stamp answers the question the entry is for.
    const seat = freshSeat();
    const entityId = randomUUID();
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'business', 'Ferretería Fuentes', now())`,
        [seat.companyId, entityId],
      );
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "aperture",
        action: "entity_kind",
        ref: `company:${seat.companyId} entity:${entityId}`,
        outcome: "determined:business",
      });
      expect(await violationsFor("entity_kind")).toEqual([
        missingKind(seat.companyId, entityId),
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await violationsFor("entity_kind")).toEqual([]);
  });

  it("does NOT see a second determination go unchained — the limit of this join, pinned", async () => {
    // THE HONEST BOUNDARY (Codex r1 on the #60↔#78 reconciliation), written
    // as a test so it is a property somebody can watch change rather than a
    // paragraph somebody can stop believing.
    //
    // `ledger.entities.kind` is a MUTABLE column holding only the standing
    // value, so a re-determination — a backfill's, a human's correction —
    // leaves no second row to join against, and the first entry still
    // satisfies the token. The check therefore proves that every filed
    // entity HAS a determination in the chain, never that every
    // determination was chained.
    //
    // Flipping this test is what closing the gap looks like: an immutable
    // row per determination whose id the ref names, which is a change to
    // what the WRITER stores and belongs to whoever needs it.
    const seat = freshSeat();
    const { entityId } = await crossOnce(
      seat,
      `COVERAGE-KIND-LIMIT-${seat.twinId.slice(0, 8)}`,
    );
    await db.query("BEGIN");
    try {
      // A correction landing with its chain append simply not there — the
      // shape a future writer's omission would actually arrive in.
      await db.query(
        `UPDATE ledger.entities SET kind = 'business'
          WHERE company_id = $1 AND entity_id = $2`,
        [seat.companyId, entityId],
      );
      expect(await violationsFor("entity_kind")).toEqual([]);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("keys a determination on the company AND the entity, because the entity id is client-minted", async () => {
    // A Ledger entity's identity is the PAIR: the id is minted rep-side, so
    // the same UUID may stand for two customers of two companies (ticket
    // #60, Codex r1). An entry naming one company's entity must not cover
    // the other's, or two determinations nobody can tell apart read as one.
    const seat = freshSeat();
    const other = freshSeat();
    const { entityId } = await crossOnce(
      seat,
      `COVERAGE-KIND-${seat.twinId.slice(0, 8)}`,
    );
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO ledger.entities (company_id, entity_id, kind, display_name, created_at)
         VALUES ($1, $2, 'person', 'Diego Zertuche', now())`,
        [other.companyId, entityId],
      );
      expect(await violationsFor("entity_kind")).toEqual([
        missingKind(other.companyId, entityId),
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await violationsFor("entity_kind")).toEqual([]);
  });

  it("matches the ref token WHOLE — an entry about event 120 does not cover event 12", async () => {
    // `ref` is a space-delimited list of `label:value` tokens, and a
    // substring match would let one act's entry silently cover another's:
    // `position('event:12' in 'event:120')` is true, and the shorter act
    // would read as chained forever.
    const seat = freshSeat();
    const eventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: `COVERAGE-TOKEN-${seat.twinId.slice(0, 8)}`,
      text: "9 no",
    });
    await db.query("BEGIN");
    try {
      await markProcessed(seat, eventId, "correction_refused");
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "correction_matcher",
        action: "fact_retraction",
        ref: `twin:${seat.twinId} index:9 event:${eventId}0`,
        outcome: "refused:unknown_line",
      });
      expect(await violationsFor("fact_retraction_refused")).toEqual([
        missing("fact_retraction_refused", "fact_retraction", `wa_event ${eventId}`),
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("keeps counting the chain's ANSWERED-QUESTION entries after the store they joined was dropped (#218)", async () => {
    // THE PROPERTY THE RETIREMENT HAD TO KEEP. The chain is append-only, so
    // a corpus can hold `question_answer` entries from before the route was
    // retired — and the vocabulary fence goes red on an entry whose action
    // or caller no class declares. The class therefore outlives its writers
    // and its store: it is `unjoinable` now (no second row exists to join
    // against), its callers still name both historical writers, and the
    // entries are counted rather than reported as a component writing to the
    // chain that nothing accounts for.
    const seat = freshSeat();
    await db.query("BEGIN");
    try {
      const questionId = randomUUID();
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "answer_aperture_question",
        action: "question_answer",
        ref: `twin:${seat.twinId} question:${questionId}`,
        outcome: "declined",
      });
      const report = await auditChainCoverageInDb(db);
      const tally = report.mustChain.find((t) => t.class === "question_answer")!;
      expect(tally.join).toBe("unjoinable");
      expect(tally.entries).toBeGreaterThan(0);
      // No violation of any kind — not a missing act, and not the
      // vocabulary's "no class declares this caller for this action".
      expect(
        report.violations.filter((v) => v.reason.includes("question_answer")),
      ).toEqual([]);
      expect(
        report.violations.filter((v) => v.class === "vocabulary"),
      ).toEqual([]);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("counts refused answers against their entries, where the walk back to the question is not stored", async () => {
    // A refused answer updates no question row, so there is no id the entry
    // also names. The arithmetic is what is left, and it still catches a
    // writer that stopped chaining.
    const seat = freshSeat();
    const eventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: `COVERAGE-QREFUSED-${seat.twinId.slice(0, 8)}`,
      text: "si",
    });
    await db.query("BEGIN");
    try {
      await markProcessed(seat, eventId, "question_answer_refused");
      expect(await violationsFor("question_answer_refused")).toEqual([
        {
          class: "question_answer_refused",
          subject: "1 act(s), 0 entries",
          reason:
            "1 `question_answer` act(s) of this class have no chain entry (ADR-0020, spec #48 decision 18)",
        },
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("leaves `send_in_flight` out of the refusals it counts, without touching the writer", async () => {
    // THE ENTRY COUNT IS THE ONLY THING A RUN CAN SAY about an unjoinable
    // class, so it has to be the right population. Since the ruling of
    // 2026-08-31 `send_in_flight` is outside `customer_send_refused` —
    // ticket #24's ACs and spec #29 decision 1 name the three that are in —
    // while `writer.ts` still chains it, on the strength of a review answer
    // during ticket #25's build. That divergence is RECORDED and not
    // repaired; what must not happen is the enumeration quietly counting it
    // as a refusal it says is owed (Codex r2).
    const tally = async () =>
      (await auditChainCoverageInDb(db)).mustChain.find(
        (t) => t.class === "customer_send_refused",
      )!.entries;
    const before = await tally();

    await db.query("BEGIN");
    try {
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "affirmation_matcher",
        action: "customer_send",
        ref: `twin:${randomUUID()} draft:${randomUUID()}`,
        outcome: "refused:send_in_flight",
      });
      expect(await tally()).toBe(before);
      // ...and a CITED refusal in the same shape still counts, so the
      // exclusion is one named outcome rather than a broken predicate.
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "affirmation_matcher",
        action: "customer_send",
        ref: `twin:${randomUUID()} draft:${randomUUID()}`,
        outcome: "refused:off_allowlist",
      });
      expect(await tally()).toBe(before + 1);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await tally()).toBe(before);
  });

  it("counts the exclusions and demands an entry for none of them", async () => {
    // A coverage check with no exclusion list would demand an entry per
    // extracted fact — extraction files them by the hundred — and bury the
    // rep acts the chain exists to make auditable. So the numbers are
    // reported, and produce no violation.
    const seat = freshSeat();
    await crossOnce(seat, `COVERAGE-EXCLUDED-${seat.twinId.slice(0, 8)}`);
    const report = await auditChainCoverageInDb(db);
    const counted = (cls: string) =>
      report.mustNotChain.find((c) => c.class === cls)!.acts;
    expect(counted("class_1_candidate_facts")).toBeGreaterThan(0);
    // `class_1_questions_asked` counted the second class-1 store, and its
    // route is retired (ticket #218) — so the exclusions this corpus can
    // still show a number for are the facts and the finalizations, and
    // BOTH have to be non-zero or the claim below is about nothing.
    expect(counted("finalization")).not.toBeNull();
    expect(
      report.violations.filter((v) =>
        report.mustNotChain.some((c) => c.class === v.class),
      ),
    ).toEqual([]);
  });

  it("has a verdict for EVERY disposition the live schema allows — the check the vocabulary cannot make of itself", async () => {
    // THE CIRCULARITY THIS BREAKS (Codex r3). "Every action word has a
    // must-chain class" is green by construction for the one case that
    // matters: an act whose writer forgot `appendAuditEntry` introduces no
    // action word, so it is absent from both sides.
    //
    // So the enumeration is held to a vocabulary it does not own — the
    // `wa_event_processing` disposition set, read HERE out of the live
    // CHECK constraint rather than from a copy. "Dispositions grow,
    // machinery doesn't" (spec #48 decision 18), and the day one grows
    // without a verdict is the day somebody has to say whether the new act
    // owes the chain an entry.
    const constraint = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'wa_event_processing_disposition_check'`,
    );
    expect(constraint.rows).toHaveLength(1);
    const allowed = [...constraint.rows[0]!.def.matchAll(/'([a-z_]+)'::text/gu)]
      .map((m) => m[1]!)
      .sort();
    expect(allowed.length).toBeGreaterThan(10);
    expect(Object.keys(SEAM_DISPOSITIONS).sort()).toEqual(allowed);
  });

  it("reports an action word this build does not declare", async () => {
    // The type on `AuditEntry.action` stops a TypeScript call site inventing
    // a word; it cannot reach a `.mjs` script, a psql session, or a chain
    // written by an older build. So a word in the store that nothing
    // declares is a finding of its own — planted the only way it can be,
    // straight past the type, which is the case being simulated.
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO audit_chain (caller, action, ref, outcome, prev_hash, entry_hash)
         VALUES ('some_new_writer', 'expungement', 'entity:x', 'done', NULL, $1)`,
        [randomBytes(32)],
      );
      expect(await violationsFor("vocabulary")).toEqual([
        {
          class: "vocabulary",
          subject: 'action "expungement"',
          reason:
            "not in AUDIT_ACTIONS — a word this build does not declare, so nothing states which acts owe it an entry (ticket #78)",
        },
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await violationsFor("vocabulary")).toEqual([]);
  });

  it("reports a component writing to the chain that no class accounts for", async () => {
    // The caller half of the fence (ADR-0020 records caller identity;
    // `audit.ts`: "a chain entry naming any other caller for these actions
    // is itself the finding"). A declared ACTION performed by an
    // undeclared component is a writer nothing in the enumeration accounts
    // for — and, before this, one whose entries would still have satisfied
    // a per-act join.
    await db.query("BEGIN");
    try {
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "some_new_writer",
        action: "entity_create",
        ref: "twin:x entity:y event:1",
        outcome: "filed",
      });
      expect(await violationsFor("vocabulary")).toEqual([
        {
          class: "vocabulary",
          subject: 'caller "some_new_writer" on entity_create',
          reason:
            "no must-chain class declares this caller for this action — a component is writing to the chain that the enumeration does not account for (ADR-0020, ticket #78)",
        },
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
    expect(await violationsFor("vocabulary")).toEqual([]);
  });

  it("does not accept the right act recorded against the wrong component", async () => {
    // A per-act join that matched on action and ref alone would report an
    // act covered by an entry naming a component that had no business
    // performing it.
    const seat = freshSeat();
    const eventId = await insertWaEventFixture(db, seat.dek, {
      twinId: seat.twinId,
      companyId: seat.companyId,
      seatId: seat.seatId,
      chatJid: SELF_CHAT,
      senderJid: SELF_CHAT,
      fromMe: true,
      messageId: `COVERAGE-CALLER-${seat.twinId.slice(0, 8)}`,
      text: "va",
    });
    await db.query("BEGIN");
    try {
      await markProcessed(seat, eventId, "binding_confirmed");
      await appendAuditEntry(db, TEST_AUDIT_HMAC_KEY, {
        caller: "correction_matcher",
        action: "entity_create",
        ref: `twin:${seat.twinId} event:${eventId}`,
        outcome: "filed",
      });
      expect(await violationsFor("entity_create")).toEqual([
        missing("entity_create", "entity_create", `wa_event ${eventId}`),
      ]);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});

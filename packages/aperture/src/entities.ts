/**
 * The first crossing: an entity create (ticket #50; ADR-0003 as amended,
 * ADR-0035, FR-72).
 *
 * A rep-confirmed binding is the only thing that mints an entity. The id is
 * client-minted rep-side and carried into the Ledger UNCHANGED — so the
 * bundle's entity mirror stays a mirror rather than a translation table,
 * and a confirmation retried over a flaky mobile network is idempotent
 * rather than duplicating a customer. What the device does NOT supply is
 * the company: client-supplied ids are client-supplied data, so the scope
 * is read off the rep-act evidence row the plane stamped, server-side.
 *
 * Entity create is DISCLOSED (ADR-0003's 2026-08-29 amendment): it puts a
 * name taken from the rep's conversation into the Ledger for the first
 * time, which is the field most likely to carry something personal and
 * exactly what the disclosure and its correction window exist to catch. The
 * entity, its creation grant and its disclosure line therefore commit
 * TOGETHER — and the deferred FR-72 trigger on `ledger.entities` means a
 * transaction that files one without the other cannot commit at all.
 *
 * AND IT IS AUDIT-CHAINED (ticket #54; ADR-0020; spec #48 decision 18).
 * #50 built the crossing without the chain and #51 sized closing it, both
 * recording it rather than half-doing it, because the vocabulary was
 * undecided and the retraction was going to need the same one. It is
 * decided in `audit.ts` now and both acts wear it: the chain link commits
 * inside the same aperture unit as the crossing, so "a crossing with no
 * audit link" is not a state this can leave behind.
 */
import { apertureRef, chainApertureAct } from "./audit.js";
import { entityKindRef } from "./entity-kind.js";
import {
  classifyApertureInput,
  type RepActContext,
  repActEvidenceColumns,
  type RepActEvidence,
  type VerifiedRepAct,
} from "./inputs.js";
import { shadowAtFiling } from "./shadow-lift.js";
import { withApertureUnit } from "./unit.js";

/** person | business — display and merge safety, and nothing else (ADR-0035). */
export const ENTITY_KINDS = ["person", "business"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * A class-2 act arrived without verifiable rep-act evidence, so ADR-0003
 * demotes it to class 1 — and a class-1 input is a candidate fact, which
 * can never be an entity create. The aperture refuses rather than filing.
 */
export class RepActNotEvidenceBoundError extends Error {
  override readonly name = "RepActNotEvidenceBoundError";
  constructor(reason: string) {
    super(
      `refusing an entity create that is not evidence-bound (ADR-0003 class 2): ${reason}`,
    );
  }
}

/**
 * The same client-minted id came back naming a DIFFERENT CUSTOMER. Under
 * ADR-0035 a repeat is idempotent, but only of the same create — a
 * different name under a filed id is a client-supplied-id collision, and
 * silently keeping the first would hide it.
 *
 * `kind` IS NOT ONE OF THE AXES, and it stopped being one with ticket #60.
 * It was, while it was a constant the caller supplied along with the id;
 * now it is a MODEL DETERMINATION made fresh on every pass, so a repeat
 * «va» — or the documented crash-replay between the mirror write and the
 * marker — can arrive with a determination that flipped. That is a model
 * changing its mind about one customer, not two customers under one id:
 * treating it as a collision would throw before the event's processing
 * marker was written and replay the same event forever. The standing
 * determination stands, which is also what keeps a human's correction from
 * being undone by the next «va».
 */
export class EntityIdCollisionError extends Error {
  override readonly name = "EntityIdCollisionError";
  constructor(entityId: string, filed: string, offered: string) {
    super(
      `entity ${entityId} is already filed as ${filed}; refusing to treat a create for ${offered} as a repeat of it (ADR-0035: client-supplied ids are client-supplied data)`,
    );
  }
}

/**
 * Another transaction is filing this exact id right now and has not
 * committed. Not an error in the data — a race the caller retries, since
 * every path into an entity create is already idempotent.
 */
export class EntityCreateInFlightError extends Error {
  override readonly name = "EntityCreateInFlightError";
  constructor(entityId: string) {
    super(
      `a create for entity ${entityId} is in flight in another transaction — nothing was filed here; retry`,
    );
  }
}

export interface EntityCreateRequest {
  readonly twinId: string;
  /** The UUID minted rep-side at the rep's confirmation — carried unchanged. */
  readonly entityId: string;
  /**
   * What kind of customer this is — the MODEL's determination (ticket
   * #60), made from the name the rep confirmed and that chat's own words
   * before this call. The rep's «va» says WHICH customer the chat is and
   * says nothing about this, and ADR-0036 refuses to add a second question
   * to the one ceremony a rep must answer — so nothing but a model
   * produces the kind on a create, which is why the chain entry below
   * stamps `model` rather than asking the caller to say so.
   */
  readonly kind: EntityKind;
  /** The entity's name as the rep confirmed it. */
  readonly displayName: string;
  /** The rep's own act, re-verified by the aperture (ADR-0003 class 2). */
  readonly evidence: RepActEvidence;
  /**
   * The disclosure line, already rendered. Rendering happens at the twin's
   * one grammar point; the aperture stores the rendered text and no version
   * (ADR-0034) — re-rendering later from a changed template would
   * retroactively rewrite what a rep was told.
   */
  readonly disclosureText: string;
}

export interface EntityCreateResult {
  readonly entityId: string;
  /** Applied server-side from the evidence row (ADR-0035). */
  readonly companyId: string;
  readonly disclosureLineId: string;
  /** False when this call found the create already filed — an idempotent repeat. */
  readonly filed: boolean;
}

/**
 * Files one entity create, with its creation grant and its disclosure line,
 * as one atomic aperture unit.
 */
export async function fileEntityCreate(
  ctx: RepActContext,
  request: EntityCreateRequest,
): Promise<EntityCreateResult> {
  const input = await classifyApertureInput(ctx, {
    twinId: request.twinId,
    evidence: request.evidence,
  });
  if (input.inputClass === 1) {
    throw new RepActNotEvidenceBoundError(input.reason);
  }
  const { repAct } = input;

  return withApertureUnit(ctx.db, async () => {
    // `shadow` IS STAMPED HERE TOO (ticket #132; ADR-0016 as amended, which
    // says "flip that company's existing ENTITY and fact rows" and means the
    // flag lives on both). An entity bound after the lift is a cliente the
    // owner can see the day it is created.
    const shadow = await shadowAtFiling(ctx.db, repAct.companyId);
    const inserted = await ctx.db.query<{ entity_id: string }>(
      // ON CONFLICT DO NOTHING leaves a standing row untouched, stamp
      // included, which is right: an idempotent repeat is not a new
      // crossing, and re-stamping one would let a replay quietly restate a
      // decision the lift act already recorded.
      `INSERT INTO ledger.entities
         (company_id, entity_id, kind, display_name, created_at, shadow)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, entity_id) DO NOTHING
       RETURNING entity_id`,
      [
        repAct.companyId,
        request.entityId,
        request.kind,
        request.displayName,
        // Valid time comes off the verified act, never from the caller: it
        // is WHEN THE REP CONFIRMED, and a runtime that picks a queued
        // confirmation up hours later would otherwise write its own
        // processing time into an append-only store — where it becomes the
        // survivorship rule's input (ADR-0035) and the disclosure's
        // provenance, both of them wrong and neither of them correctable.
        repAct.occurredAt,
        shadow,
      ],
    );

    if (inserted.rows.length === 0) {
      return standingCreateFor(ctx, repAct, request);
    }

    // Binding a chat auto-grants the creating rep (schema session): the
    // grant is self-scoped — it returns only what that rep's own
    // conversation filed. Everything cross-rep stays owner-assigned.
    await ctx.db.query(
      `INSERT INTO ledger.entity_grants
         (company_id, entity_id, twin_id, source)
       VALUES ($1, $2, $3, 'creation')`,
      [repAct.companyId, request.entityId, repAct.twinId],
    );

    // EXACTLY ONE OF THE TWO EVIDENCE COLUMNS, from the surface that
    // authorized this create (ticket #224; `repActEvidenceColumns` argues why
    // the pair is produced in one place). A binding confirmed from the
    // dashboard's card and one confirmed with «va» in the thread file the same
    // line; what differs is which act row it names.
    const evidenceColumns = repActEvidenceColumns(repAct);
    const line = await ctx.db.query<{ id: string }>(
      `INSERT INTO disclosure_lines
         (company_id, seat_id, twin_id, subject_kind, entity_id,
          rendered_text, source_event_id, dashboard_act_id)
       VALUES ($1, $2, $3, 'entity_create', $4, $5, $6, $7)
       RETURNING id`,
      [
        repAct.companyId,
        repAct.seatId,
        repAct.twinId,
        request.entityId,
        request.disclosureText,
        evidenceColumns.sourceEventId,
        evidenceColumns.dashboardActId,
      ],
    );

    await chainApertureAct(ctx, {
      action: "entity_create",
      ref: apertureRef(repAct, { entity: request.entityId }),
      outcome: "filed",
    });
    // ...and the KIND its own entry (ticket #60), in the same unit. The
    // rep's «va» authorized the create; it said nothing about whether this
    // customer is a person or a business, and every value in that column is
    // now a determination something made. A determination nobody can find
    // afterwards is worse than one nobody can correct, so each one appends
    // a link — here, at the backfill, and at a human's correction alike.
    await chainApertureAct(ctx, {
      action: "entity_kind",
      ref: entityKindRef({
        companyId: repAct.companyId,
        entityId: request.entityId,
        determinedBy: "model",
      }),
      outcome: `determined:${request.kind}`,
    });

    return {
      entityId: request.entityId,
      companyId: repAct.companyId,
      disclosureLineId: line.rows[0]!.id,
      filed: true,
    };
  });
}

/**
 * The idempotent repeat: the id is already filed for this company. Returns
 * the standing create — after checking it really is the SAME create, on
 * both axes that can differ. A client-minted id naming a different customer
 * is a collision rather than a retry; and so is one naming the same
 * customer for a DIFFERENT REP, because "already filed" would otherwise
 * hand the caller another twin's disclosure line, leave the caller with no
 * grant of its own, and bind its bundle to someone else's entity.
 */
async function standingCreateFor(
  ctx: RepActContext,
  repAct: VerifiedRepAct,
  request: EntityCreateRequest,
): Promise<EntityCreateResult> {
  const standing = await ctx.db.query<{
    kind: string;
    display_name: string;
    creator_twin_id: string | null;
    line_id: string | null;
  }>(
    `SELECT e.kind, e.display_name, g.twin_id AS creator_twin_id, d.id AS line_id
       FROM ledger.entities e
       LEFT JOIN ledger.entity_grants g
         ON g.company_id = e.company_id
        AND g.entity_id = e.entity_id
        AND g.source = 'creation'
       LEFT JOIN disclosure_lines d
         ON d.subject_kind = 'entity_create'
        AND d.company_id = e.company_id
        AND d.entity_id = e.entity_id
      WHERE e.company_id = $1 AND e.entity_id = $2`,
    [repAct.companyId, request.entityId],
  );
  const row = standing.rows[0];
  if (row === undefined) {
    // `ON CONFLICT DO NOTHING` does not wait on an UNCOMMITTED conflicting
    // row: under READ COMMITTED the loser of a race writes nothing and
    // then cannot see what beat it. Refusing typed is the honest outcome —
    // the create is in flight, not lost, and the caller's own replay (a
    // repeat «va», an unmarked event re-processed) files it.
    throw new EntityCreateInFlightError(request.entityId);
  }
  if (row.display_name !== request.displayName) {
    throw new EntityIdCollisionError(
      request.entityId,
      `"${row.display_name}"`,
      `"${request.displayName}"`,
    );
  }
  if (row.creator_twin_id !== repAct.twinId) {
    throw new EntityIdCollisionError(
      request.entityId,
      `created by twin ${row.creator_twin_id ?? "nobody"}`,
      `a create from twin ${repAct.twinId}`,
    );
  }
  if (row.line_id === null) {
    // Unrepresentable while the FR-72 trigger stands: an entity cannot
    // commit without its line. Reached only if someone disabled it, and
    // "the crossing is undisclosed" is never something to pass over.
    throw new Error(
      `FR-72: entity ${request.entityId} is filed with no disclosure line — the crossing is undisclosed and this aperture will not build on it`,
    );
  }
  // Chained, with its own outcome. A replay that filed nothing is not the
  // same event as a first filing, and a chain that recorded them
  // identically would make a retry indistinguishable from a duplicate
  // crossing — which is exactly the question a reader of the chain is
  // asking.
  await chainApertureAct(ctx, {
    action: "entity_create",
    ref: apertureRef(repAct, { entity: request.entityId }),
    outcome: "already_filed",
  });

  return {
    entityId: request.entityId,
    companyId: repAct.companyId,
    disclosureLineId: row.line_id,
    filed: false,
  };
}

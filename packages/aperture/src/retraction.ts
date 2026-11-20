/**
 * The correction (ticket #54; spec #48 grilling decision 14; ADR-0003,
 * ADR-0004, ADR-0020; FR-33).
 *
 * Being wrong stays fixable. The rep reads their daily disclosure, sees a
 * line that is wrong, quotes the post and says «N no» — and the fact that
 * line disclosed is annotated RETRACTED. It keeps its row and stays in the
 * timeline: the record shows what happened rather than pretending it did
 * not (FR-33), and a retracted fact never finalizes (the CHECK on
 * `ledger.facts` makes that unrepresentable rather than remembered).
 *
 * THE TARGET IS A DISCLOSURE LINE, NEVER A FACT ID, and that is the whole
 * design. The twin resolves quoted message id → disclosure post → line
 * index → disclosure line in stored rows, with no model anywhere in the
 * path (ADR-0003; the walk lives in `disclosure.ts` and the quoted-id half
 * is the twin-post registry's one join). What arrives here is the id of a
 * line the aperture WROTE ITSELF — so the aperture re-reads its own store
 * to find the fact, rather than accepting a fact id a caller chose. A
 * caller that could name the fact directly could retract a fact the rep
 * never saw, which is the same failure ADR-0003's class-2 evidence rule
 * exists to prevent, arriving by the other door.
 *
 * THE WINDOW IS FINALIZATION, NOT A CLOCK READ HERE, and that is a choice
 * rather than an omission. CONTEXT.md words the correction window as "the
 * 24 hours after a fact's disclosure line is rep-reachable, during which
 * corrections apply BEFORE IT FINALIZES — a window, not an approval gate",
 * so what this module asks is whether the fact has finalized, not what time
 * it is. The consequence is visible and intended: if the finalization pass
 * has not run — the laptop was shut for a week — a «N no» arriving late is
 * ACCEPTED, because the fact it names is still provisional and annotating a
 * provisional fact is exactly what a correction does. Refusing it would
 * mean telling a rep their correction came too late for a record that has
 * not gone anywhere. Both directions of the failure are the safe one: an
 * unfinalized fact is still correctable, and a shadow fact is unreadable by
 * any owner either way.
 *
 * THE OTHER EDGE OF THAT CHOICE IS A BOUNDARY RACE, and it is recorded
 * rather than hidden (Codex r1). A rep who types «N no» a minute BEFORE the
 * window closes, whose reply the plane delivers a minute after, meets a
 * finalization pass that already ran: the fact is final, and they are told
 * so. They were in time and were refused. Closing it means letting an
 * in-window act UNDO a finalization — a mechanism with its own undecided
 * question (a fact that went final and then did not is a thing an owner
 * surface would have to be able to show), which this ticket has no mandate
 * to invent. What the rep is told stays true either way: the fact really is
 * firm.
 *
 * EXPUNGEMENT IS A DIFFERENT MECHANISM (ADR-0026) and is not this. A
 * correction annotates a fact the aperture was right to accept and wrong
 * about; expungement replaces the content of a fact that should never have
 * crossed at all, is sev-1 only, is never owner-invoked, and arrives with
 * the closing window. Nothing here removes anything.
 */
import { createHash } from "node:crypto";
import { apertureRef, chainApertureAct } from "./audit.js";
import {
  classifyApertureInput,
  repActEvidenceColumns,
  type RepActContext,
  type RepActEvidence,
  type VerifiedRepAct,
} from "./inputs.js";
import { withApertureUnit } from "./unit.js";

/**
 * Why a correction that resolved to a real line still retracts nothing.
 * Total, and every arm is reachable from the rep's own thread:
 *
 * `not_a_fact` — the line disclosed an ENTITY CREATE. It is the first line
 *   every rep ever reads («Lo di de alta como cliente.»), so this is not a
 *   corner: no rep verb undoes a binding yet (a «no» on a binding question
 *   deliberately does not unbind, ticket #49), and inventing one from a
 *   correction would let a stale post undo a confirmation.
 * `window_closed` — the fact already finalized. The correction window is
 *   the 24 hours after the line was rep-reachable (ADR-0004); after it, the
 *   remedy is expungement (ADR-0026), which is a different mechanism and
 *   out of scope. Refusing is the honest answer; the alternative is a
 *   database CHECK violation taking the runtime down over a rep typing a
 *   late «1 no».
 */
export type RetractionRefusal = "not_a_fact" | "window_closed";

export interface FactRetractionRequest {
  readonly twinId: string;
  /**
   * The line the rep pointed at — resolved rep-side, in code, from the
   * quoted message id and the number they typed.
   */
  readonly disclosureLineId: string;
  /** The rep's own «N no», re-verified here (ADR-0003 class 2). */
  readonly evidence: RepActEvidence;
}

export type FactRetractionOutcome =
  | {
      readonly retracted: true;
      readonly factId: string;
      /** True when this call found the fact already retracted — a repeat «N no». */
      readonly alreadyRetracted: boolean;
    }
  | { readonly retracted: false; readonly reason: RetractionRefusal };

/**
 * A class-2 act arrived without verifiable rep-act evidence, so ADR-0003
 * demotes it to class 1 — and a class-1 input is a candidate fact, which can
 * never be a retraction. Loud, like the entity create's: every path into
 * this function comes from the twin thread's own live, rep-authored,
 * plane-delivered reply, so a demotion means the seam is broken, not that
 * the rep did something odd.
 */
export class RetractionNotEvidenceBoundError extends Error {
  override readonly name = "RetractionNotEvidenceBoundError";
  constructor(reason: string) {
    super(
      `refusing a retraction that is not evidence-bound (ADR-0003 class 2): ${reason}`,
    );
  }
}

/**
 * The correction named a disclosure line this aperture does not hold under
 * the scope of the rep act that authorized it.
 *
 * Unreachable through the twin's own resolution on the TWIN axis — the walk
 * starts from a post of this twin and `disclosure_post_lines` is twin-scoped
 * in the schema — so reaching it that way means a caller composed the target
 * itself, which is exactly what must never quietly succeed.
 *
 * It is reachable on the COMPANY axis, and loud is deliberate there too: it
 * means one twin's `wa_events` rows carry two different companies, so the
 * column the aperture reads every tenancy decision off is wrong. That is a
 * broken seam, and this runtime's doctrine for a broken seam is to stop —
 * the same choice `assembleDisclosureGroups` makes for a mirror that cannot
 * name an entity. The blast radius (a rep's ordinary reply taking the twin
 * down until the seam is fixed) is real and is recorded with #51's remainder
 * 4, which is the same argument about the same doctrine.
 */
export class UnknownDisclosureLineError extends Error {
  override readonly name = "UnknownDisclosureLineError";
  constructor(lineId: string, twinId: string, companyId: string) {
    super(
      `disclosure line ${lineId} is not this aperture's under twin ${twinId} / company ${companyId} — a correction names a line the twin was shown, and the aperture re-reads its own store rather than trusting a caller's target (ADR-0003). If the line exists for this twin under a DIFFERENT company, the seam has stamped one twin with two companies and every tenancy decision downstream of that column is unsound`,
    );
  }
}

/**
 * Retracts the fact one disclosure line disclosed — or says why it did not.
 *
 * Refusals come back as VALUES, because both of them are things the rep can
 * legitimately do and the twin has to tell them so. What THROWS is a broken
 * seam: evidence that is not the rep's act, a line this aperture never
 * wrote. That is the runtime's doctrine for a store that disagrees with
 * itself, and it is the same split `fileCandidateFact` draws.
 */
export async function retractDisclosedFact(
  ctx: RepActContext,
  request: FactRetractionRequest,
): Promise<FactRetractionOutcome> {
  const input = await classifyApertureInput(ctx, {
    twinId: request.twinId,
    evidence: request.evidence,
  });
  if (input.inputClass === 1) {
    throw new RetractionNotEvidenceBoundError(input.reason);
  }
  const { repAct } = input;

  return withApertureUnit(ctx.db, async () => {
    // The aperture's own store, scoped by the act it just verified: the
    // company and twin come off the seam row the plane stamped, never off a
    // parameter (ADR-0035), so a line belonging to another rep or another
    // company cannot be addressed from here at all.
    const line = await ctx.db.query<{
      subject_kind: "fact" | "entity_create";
      fact_id: string | null;
    }>(
      `SELECT subject_kind, fact_id
         FROM disclosure_lines
        WHERE id = $1 AND twin_id = $2 AND company_id = $3`,
      [request.disclosureLineId, repAct.twinId, repAct.companyId],
    );
    const row = line.rows[0];
    if (row === undefined) {
      throw new UnknownDisclosureLineError(
        request.disclosureLineId,
        repAct.twinId,
        repAct.companyId,
      );
    }
    if (row.subject_kind !== "fact" || row.fact_id === null) {
      return refuse(ctx, repAct, request, "not_a_fact");
    }
    const factId = row.fact_id;

    // The annotation. Guarded rather than checked-then-written: the
    // finalization pass annotates the same rows, and `retracted_at IS NULL
    // OR finalized_at IS NULL` is a CHECK — so a read-then-update would
    // race a window closing between the two statements and abort the whole
    // transaction on a constraint violation. One statement, row-locked by
    // Postgres, tells the truth under any interleaving.
    //
    // Valid time is WHEN THE REP SAID IT, off the verified act — never this
    // pass's clock. A runtime that picks the reply up hours later must not
    // record its own processing time as the moment the rep corrected the
    // record, for the same reason the entity create takes its `created_at`
    // off the confirmation.
    const annotated = await ctx.db.query<{ id: string }>(
      `UPDATE ledger.facts
          SET retracted_at = $3
        WHERE company_id = $1 AND id = $2
          AND retracted_at IS NULL
          AND finalized_at IS NULL
        RETURNING id`,
      [repAct.companyId, factId, repAct.occurredAt],
    );

    if (annotated.rows.length === 0) {
      return standingRetractionFor(ctx, repAct, request, factId);
    }

    // The evidence, rep-side (…100040). `ledger.facts` says THAT the fact
    // was retracted; this row says by which rep act — and it may not live in
    // `ledger`, because a `wa_events` id dereferences to chat identity
    // (ADR-0004).
    // EXACTLY ONE OF THE THREE EVIDENCE COLUMNS, from the surface the rep
    // retracted on: «1 no» in their thread, **Retirar** on the card (ticket
    // #224), or the line edited in place on the card, which reaches the twin
    // as a message through the dashboard's door (ticket #344).
    //
    // THE CORRECTED WORDS ARE THE DOOR ROW'S OWN SEALED BYTES, copied by this
    // statement and never handed in by a caller: a correction edited on the
    // card is the rep's line, and the line says what the fact should read.
    // Only a message that names the line it edits carries them — any other
    // evidence says a line is wrong without saying what it should be.
    const evidenceColumns = retractionEvidenceColumns(repAct);
    const written = await ctx.db.query<{ correction_enc: Buffer | null }>(
      `INSERT INTO fact_retractions
         (company_id, seat_id, twin_id, fact_id, disclosure_line_id,
          source_event_id, dashboard_act_id, dashboard_message_id,
          correction_enc, retracted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               (SELECT m.text_enc FROM dashboard_messages m
                 WHERE m.id = $8 AND m.twin_id = $3
                   AND m.about_post_id IS NOT NULL),
               $9)
       RETURNING correction_enc`,
      [
        repAct.companyId,
        repAct.seatId,
        repAct.twinId,
        factId,
        request.disclosureLineId,
        evidenceColumns.sourceEventId,
        evidenceColumns.dashboardActId,
        evidenceColumns.dashboardMessageId,
        repAct.occurredAt,
      ],
    );
    const correction = written.rows[0]?.correction_enc ?? null;

    await chainApertureAct(ctx, {
      action: "fact_retraction",
      ref: apertureRef(repAct, {
        fact: factId,
        line: request.disclosureLineId,
        // THE CHAIN COVERS THE CORRECTED WORDS by the digest of the sealed
        // bytes kept (ADR-0020: refs, never content) — ciphertext under a
        // fresh nonce, so the digest says nothing about the words and still
        // pins exactly which bytes this act stored.
        ...(correction === null ? {} : { correction: sealedDigest(correction) }),
      }),
      outcome: "retracted",
    });

    return { retracted: true as const, factId, alreadyRetracted: false };
  });
}

/**
 * The evidence columns a retraction row carries: the two every aperture store
 * has, and the door's message, which only this store takes — a line edited on
 * the card is the one door message that names a target (ticket #344;
 * `repActEvidenceColumns` argues why the other stores refuse one).
 */
function retractionEvidenceColumns(repAct: VerifiedRepAct): {
  readonly sourceEventId: string | null;
  readonly dashboardActId: string | null;
  readonly dashboardMessageId: string | null;
} {
  return repAct.surface === "dashboard_message"
    ? { sourceEventId: null, dashboardActId: null, dashboardMessageId: repAct.dashboardMessageId }
    : { ...repActEvidenceColumns(repAct), dashboardMessageId: null };
}

/** The hex SHA-256 of sealed bytes — what the chain names them by. */
function sealedDigest(sealed: Buffer): string {
  return createHash("sha256").update(sealed).digest("hex");
}

/**
 * The annotation wrote nothing: the fact is either already retracted (a
 * repeat «N no», or the same reply replayed) or already finalized (the
 * window closed). Which one it is decides whether the rep is told "done" or
 * "too late", so it is read back rather than guessed at.
 */
async function standingRetractionFor(
  ctx: RepActContext,
  repAct: VerifiedRepAct,
  request: FactRetractionRequest,
  factId: string,
): Promise<FactRetractionOutcome> {
  const standing = await ctx.db.query<{
    retracted: boolean;
    finalized: boolean;
  }>(
    `SELECT retracted_at IS NOT NULL AS retracted,
            finalized_at IS NOT NULL AS finalized
       FROM ledger.facts
      WHERE company_id = $1 AND id = $2`,
    [repAct.companyId, factId],
  );
  const row = standing.rows[0];
  if (row === undefined) {
    // Unrepresentable: the disclosure line's foreign key names this fact.
    // Reached only if someone deleted a Ledger row, which nothing holds the
    // privilege to do — and "the fact this line disclosed is gone" is never
    // something to pass over.
    throw new Error(
      `disclosure line ${request.disclosureLineId} names fact ${factId}, which is not filed for company ${repAct.companyId} — the line's foreign key makes that unrepresentable, so the store disagrees with itself`,
    );
  }
  if (row.retracted) {
    // Terminal and idempotent: the FIRST correction stands, with its own
    // instant and its own evidence row. Chained anyway, because a second
    // rep act happened and the chain records acts, not state changes.
    await chainApertureAct(ctx, {
      action: "fact_retraction",
      ref: apertureRef(repAct, {
        fact: factId,
        line: request.disclosureLineId,
      }),
      outcome: "already_retracted",
    });
    return { retracted: true as const, factId, alreadyRetracted: true };
  }
  return refuse(ctx, repAct, request, "window_closed");
}

/**
 * A refused rep act, chained. Spec #48 decision 18 says rep acts AND
 * REFUSALS are audit-chained, and it is the refusals that matter most: a
 * correction the system declined is exactly the event a rep would later
 * dispute.
 */
async function refuse(
  ctx: RepActContext,
  repAct: VerifiedRepAct,
  request: FactRetractionRequest,
  reason: RetractionRefusal,
): Promise<FactRetractionOutcome> {
  await chainApertureAct(ctx, {
    action: "fact_retraction",
    ref: apertureRef(repAct, { line: request.disclosureLineId }),
    outcome: `refused:${reason}`,
  });
  return { retracted: false as const, reason };
}

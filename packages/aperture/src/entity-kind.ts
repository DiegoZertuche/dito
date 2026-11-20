/**
 * The entity kind determination (ticket #60; ADR-0035, ADR-0003 as
 * amended, ADR-0020).
 *
 * Slice 3 filed every entity as `person`, because nothing inferred it. So
 * ADR-0035's phone rung — which merges two records on a shared normalized
 * phone ONLY WHEN `kind` MATCHES, because a business switchboard is shared
 * by many people — was comparing two placeholders and doing nothing. The
 * fix is not a third value: an entity claiming nothing and an entity
 * claiming `person` produce the same outcome at the rung. The model
 * determines the kind at binding confirmation and ALWAYS records its best
 * determination, so the column holds two real values and the condition can
 * be evaluated at all.
 *
 * WHICH MEANS SOME OF THEM ARE WRONG, and a wrong one changes merge
 * eligibility. That is why this module exists: a determination that cannot
 * be corrected is a guess nobody can take back, and the ticket's own
 * argument for guessing at all is that the error is recoverable.
 *
 * THE FENCE IS A DATABASE GRANT, not a convention (ADR-0003; migration
 * …100020). The inference is class-1 model output, and class-1 output may
 * never create or rename an entity — so the aperture holds a COLUMN-LEVEL
 * `UPDATE (kind)` on `ledger.entities` and nothing else there. It cannot
 * touch `display_name`; the day a process actually authenticates as
 * `dito_aperture`, a laundered rename fails on a privilege rather than on
 * anybody's discipline. Creating still takes class-2 rep-act evidence, and
 * this verb creates nothing: an entity nobody filed is a refusal.
 *
 * THE DETERMINATION IS AUDIT-CHAINED, which is where a wrong one is found
 * later. Every determination this system makes — the model's at create,
 * the model's again at backfill, a human's correction — appends one
 * `entity_kind` entry naming the entity, who determined it, and what they
 * decided. The chain is the sequence, so «what did this entity's kind used
 * to be, and who changed it» is answerable without storing a second copy
 * of the value anywhere.
 *
 * A KIND CHANGE IS NOT DISCLOSED (the open question, settled). ADR-0003 as
 * amended discloses an entity mutation when it CARRIES REP-DERIVED CONTENT
 * ACROSS THE WALL, not when it restructures what already crossed — create
 * and rename are disclosed because both put a name from the rep's
 * conversation into the Ledger for the first time. A kind flip carries no
 * name and files no fact. What it does change is merge eligibility, which
 * is the argument for disclosing it — and it fails, because the merge
 * itself is not disclosed: a change to the eligibility of an undisclosed
 * act cannot owe the rep more of a disclosure than the act itself does.
 * Asserted by a test rather than left to omission.
 */
import { chainApertureAct, type ChainingContext } from "./audit.js";
import type { EntityKind } from "./entities.js";
import { lockCompanyForMerge } from "./merge.js";
import { withApertureUnit } from "./unit.js";

/**
 * Who decided an entity's kind.
 *
 * `model` and `human` rather than ADR-0035's `machine`/`human` merge stamp,
 * and the difference is the point: the merge ladder is deterministic code,
 * while this is an inference that can simply be wrong. A reader of the
 * chain asking "which of these did anybody actually look at?" is asking
 * exactly this question.
 */
export const KIND_DETERMINERS = ["model", "human"] as const;
export type KindDeterminer = (typeof KIND_DETERMINERS)[number];

export interface EntityKindRequest {
  readonly companyId: string;
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly determinedBy: KindDeterminer;
}

export interface EntityKindOutcome {
  readonly entityId: string;
  /** What the entity's kind is now — the standing one when nothing changed. */
  readonly kind: EntityKind;
  /** What it said before this call. Equal to `kind` when nothing changed. */
  readonly previousKind: EntityKind;
  readonly changed: boolean;
  /**
   * A MODEL determination that a person's standing one outranked. Not an
   * error: the sweep asked, the answer was declined, and the value a human
   * chose stands.
   */
  readonly deferredToHuman: boolean;
}

/**
 * A determination naming an entity this company has not filed. Refused
 * rather than filed: this verb determines an attribute of a record a rep
 * act already created, and creating one from model output is precisely
 * what ADR-0003 forbids.
 */
export class EntityKindUnknownEntityError extends Error {
  override readonly name = "EntityKindUnknownEntityError";
  constructor(companyId: string, entityId: string) {
    super(
      `no entity ${entityId} is filed for company ${companyId}; a kind determination annotates a filed entity and never creates one (ADR-0003)`,
    );
  }
}

/**
 * Records one entity's kind determination.
 *
 * Idempotent: a determination that agrees with what is already filed
 * writes no row and chains `unchanged`, because "the model looked again
 * and said the same thing" is a different event from "the model changed
 * its mind" and a chain that recorded them identically would answer
 * neither question.
 *
 * AND A MODEL NEVER OVERRULES A PERSON (Codex r2). Once a human has said
 * what a customer is, only another human changes it — otherwise the
 * operator's correction path and the model's re-inference undo each other
 * and the model wins the argument, silently un-fixing a kind somebody went
 * and corrected and moving merge eligibility with it. Enforced HERE, inside
 * the unit and under the row lock, rather than by a caller that read a set
 * of hand-corrected ids before its model call and acted on it afterwards:
 * the window between those two is exactly when an operator types the
 * correction.
 */
export async function fileEntityKind(
  ctx: ChainingContext,
  request: EntityKindRequest,
): Promise<EntityKindOutcome> {
  // The refusal is chained and then thrown, as `fileUnmerge` does: throwing
  // from inside the unit would roll the entry back with it, and "somebody
  // determined a kind for an entity that does not exist" is exactly what a
  // reader of the chain is looking for.
  const outcome = await withApertureUnit(ctx.db, async () => {
    // THE SAME LOCK A MERGE TAKES (Codex r3). `kind` is not an ordinary
    // attribute: it decides whether the phone rung may fuse two records, and
    // the matcher reads the kinds, decides, and writes inside ONE
    // transaction. A correction committing between that read and that write
    // leaves the run merging on a kind that stopped being true while it was
    // deciding — a business fused into a person on a switchboard, which is
    // the fusion the condition exists to refuse. Serializing the change with
    // the decision is what makes the correction path safe to run while the
    // runtime is up.
    await lockCompanyForMerge(ctx, request.companyId);
    const standing = await ctx.db.query<{ kind: EntityKind }>(
      `SELECT kind FROM ledger.entities
        WHERE company_id = $1 AND entity_id = $2
        FOR UPDATE`,
      [request.companyId, request.entityId],
    );
    const previousKind = standing.rows[0]?.kind;
    if (previousKind === undefined) {
      await chainApertureAct(ctx, {
        action: "entity_kind",
        ref: entityKindRef(request),
        outcome: "refused:unknown_entity",
      });
      return { unknown: true } as const;
    }

    if (
      request.determinedBy === "model" &&
      (await hasHumanDetermination(ctx, request))
    ) {
      // WHAT THE MODEL SAID, not what stands (Codex r3). The entry is
      // about this determination — its ref says `by:model` — so recording
      // the standing value here would make it unable to answer the one
      // question it exists for. What stands is the preceding `by:human`
      // entry, which is what a chain is: a sequence.
      await chainApertureAct(ctx, {
        action: "entity_kind",
        ref: entityKindRef(request),
        outcome: `deferred:${request.kind}`,
      });
      return { unknown: false, previousKind, changed: false, deferred: true } as const;
    }

    const changed = previousKind !== request.kind;
    if (changed) {
      // The one statement this module runs against the Ledger, and the
      // only column the aperture's grant lets it name.
      await ctx.db.query(
        `UPDATE ledger.entities SET kind = $3
          WHERE company_id = $1 AND entity_id = $2`,
        [request.companyId, request.entityId, request.kind],
      );
    }
    await chainApertureAct(ctx, {
      action: "entity_kind",
      ref: entityKindRef(request),
      outcome: `${changed ? "determined" : "unchanged"}:${request.kind}`,
    });
    return { unknown: false, previousKind, changed, deferred: false } as const;
  });

  if (outcome.unknown) {
    throw new EntityKindUnknownEntityError(request.companyId, request.entityId);
  }
  return {
    entityId: request.entityId,
    // A deferred determination changed nothing, so what the entity IS is
    // still what the human left there.
    kind: outcome.deferred ? outcome.previousKind : request.kind,
    previousKind: outcome.previousKind,
    changed: outcome.changed,
    deferredToHuman: outcome.deferred,
  };
}

/**
 * Has a person ever determined this entity's kind? Read off the chain,
 * which is where the `by:` half of every determination's ref already says
 * so — a provenance question, which is the question a chain exists to
 * answer. Called inside the unit, after the row lock, so the answer cannot
 * go stale between the read and the write.
 *
 * THE MATCH IS CASE-INSENSITIVE, AND THAT IS ABOUT UUID SPELLING (ticket
 * #176, Codex rounds 2 and 3). This ref is composed from the ids a caller
 * supplied, and Postgres resolves `A1B2…` and `a1b2…` to one uuid while an
 * exact text comparison does not — so a determination a person made under an
 * id they pasted in upper case was invisible here, and the next model
 * determination would file straight over it. That is the one thing ADR-0035
 * says a model may never do, so the read fails SAFE: a fold that could only
 * ever find MORE human determinations, never fewer.
 *
 * IT CHANGES NOTHING THAT IS WRITTEN. The chain is append-only and its refs
 * keep the spelling they were appended with, including the ones already on
 * it — which is the half a canonicalizing WRITER could not have fixed. A ref
 * holds uuids and lowercase words and nothing else, so folding case cannot
 * make two different entities look like one.
 */
async function hasHumanDetermination(
  ctx: Pick<ChainingContext, "db">,
  target: { readonly companyId: string; readonly entityId: string },
): Promise<boolean> {
  const res = await ctx.db.query<{ found: number }>(
    `SELECT 1 AS found FROM audit_chain
      WHERE action = 'entity_kind' AND lower(ref) = lower($1)
      LIMIT 1`,
    [entityKindRef({ ...target, determinedBy: "human" })],
  );
  return res.rows.length > 0;
}

/**
 * One determination's `ref`, as opaque ids plus who determined it (ADR-0020:
 * chain entries are content-free — the name that was judged is never in
 * here, and neither is a word of the conversation it was judged from).
 *
 * COMPANY FIRST, because a Ledger entity's identity is the PAIR (Codex r1).
 * The entity id is a client-minted UUID and client-supplied ids are
 * client-supplied data, so the same UUID may stand for two customers of two
 * companies — and two determinations that cannot be told apart are two
 * determinations nobody can audit, which is the thing this entry exists to
 * make possible.
 *
 * Deliberately the SAME shape at every call site, the create included: a
 * chain whose `entity_kind` entries read differently depending on where the
 * determination came from is a chain nobody can scan for the determination
 * they are looking for — and `hasHumanDetermination` matches on it exactly,
 * so this is the one place the format is written.
 */
export function entityKindRef(determination: {
  readonly companyId: string;
  readonly entityId: string;
  readonly determinedBy: KindDeterminer;
}): string {
  return `company:${determination.companyId} entity:${determination.entityId} by:${determination.determinedBy}`;
}


/**
 * Merge: two entity rows turn out to be one customer (ticket #55; spec #48
 * grilling decision 11; ADR-0035, ADR-0036, ADR-0003 as amended, ADR-0004).
 *
 * Nobody is asked. The rep who could judge a cross-rep duplicate is
 * structurally prevented from seeing it, and the owner who can see both has
 * no interest in adjudicating entity rows all day — so the system decides on
 * deterministic identifiers and tells nobody (ADR-0036). WHAT MAKES THAT
 * SAFE IS REVERSIBILITY, NOT CONFIRMATION: the edge is immutable, the
 * effect set is recorded at merge time, facts never move, and both ids stay
 * resolvable forever. Those are load-bearing, not bookkeeping.
 *
 * AND THE UNDO IS HERE TOO (ticket #62). Until `fileUnmerge` existed,
 * "reversible" was a property of the RECORDS and not of the system: enough
 * data to reconstruct the pre-merge state, and no verb that performed it —
 * so ADR-0036's argument for asking nobody was spending a mechanism nobody
 * had built. It is an APPENDED REVERSAL, which is why the edge above is
 * still never rewritten, and every walk in this file reads the edges that
 * still stand.
 *
 * THIS MODULE READS LEDGER DATA AND NOTHING ELSE (ADR-0004). It compares
 * identifiers already filed against entities. It opens no envelope, reads
 * no rep-side store, and touches nothing carrying a WhatsApp address — a
 * merge decided on conversation metadata would be the wall's own data
 * deciding what the company's entities mean. The rule is checked
 * structurally, over this file's source, by the binding-wall sweep.
 *
 * THE LADDER (ADR-0035). Within one company, two entities merge on a shared
 * RFC, a shared normalized email, or a shared normalized phone WITH MATCHING
 * `kind` — a switchboard number is not entity-unique, so the phone rung
 * carries the extra condition. **A matching name is never sufficient**: two
 * *Ferretería Fuentes* in different cities is the case that must not fuse,
 * and a name is therefore never a key here at all rather than a key that is
 * checked and rejected.
 *
 * Deterministic keys rather than a scored threshold, because with no
 * entities in existence any threshold would be invented rather than
 * derived; the ladder needs no tuning and is explainable in one sentence.
 */
import { chainApertureAct, type ChainingContext } from "./audit.js";
import type { EntityKind } from "./entities.js";
import type { NormalizedIdentifiers } from "./identifiers.js";
import type { ApertureContext, EntityRef } from "./inputs.js";
import { withApertureUnit } from "./unit.js";

/**
 * What the edge means for whether the loser's facts read forward.
 *
 *  `merged`           — a genuine same-customer: one history recorded twice,
 *                       so the loser's facts read forward under the winner.
 *  `created_in_error` — an entity that should never have existed: the id
 *                       still resolves, and its facts do NOT read forward.
 *
 * They mean opposite things for exactly that question (ADR-0035), which is
 * why the resolved timeline consults the status and the id resolution does
 * not.
 */
export type MergeStatus = "merged" | "created_in_error";

/**
 * The human-or-machine stamp — what makes any claim about automation
 * provable in the data rather than asserted in a document. Everything this
 * slice files is `machine`; no human merge verb exists.
 */
export type MergePerformer = "human" | "machine";

/** The rungs of ADR-0035's ladder, in the order the matcher climbs them. */
export const MERGE_RUNGS = ["rfc", "email", "phone"] as const;
export type MergeRung = (typeof MERGE_RUNGS)[number];

/**
 * Everything one side of a merge carried at the instant it happened.
 *
 * A SIDE IS A COMPONENT, NOT A ROW (Codex r2). By the time B merges into C,
 * B may already be the survivor of A→B — and A's facts read forward through
 * B, so C's timeline gains them and they are part of what THIS merge did.
 * An effect set naming only B's own rows would omit most of its own effect,
 * and once A's grants are revoked the immutable edge could never say what it
 * had reached.
 */
export interface MergeSide {
  /** The surviving id: this side's root. */
  readonly entityId: string;
  readonly kind: EntityKind;
  readonly displayName: string;
  /** ISO-8601. Valid time: when the rep confirmed the binding that minted the id. */
  readonly createdAt: string;
  /**
   * Every id whose facts read forward into this side — itself, plus whatever
   * merged into it across `merged` edges only. A `created_in_error` record
   * is not here, because its facts stop at its edge.
   */
  readonly memberEntityIds: readonly string[];
  /** The facts filed against those ids, at merge time. */
  readonly factIds: readonly string[];
  /** Who could read them, at merge time, and on which id. */
  readonly grants: readonly {
    readonly entityId: string;
    readonly twinId: string;
    readonly source: "creation" | "owner_assigned";
  }[];
}

/**
 * The effect set, recorded because it is UNRECONSTRUCTABLE AFTERWARDS
 * (ADR-0035; FHIR and Reltio both record one).
 *
 * Facts keep being filed against the loser after a merge, and grants are
 * added and revoked — so "which facts did this merge actually affect, and
 * who could read them?" has no answer a year later unless it is written
 * down now.
 *
 * IT IS NOT WHAT THE UNDO RESTORES TO, which …100050 guessed it would be
 * (ticket #62). An unmerge restores to nothing at all: the merge only ever
 * redirected at read time, so taking it back leaves every fact where it
 * already was. What the effect set answers is the other question — WHAT DID
 * THIS MERGE AFFECT, and who could read it — which is unanswerable a year
 * later either way, and is the raw material for "how often was the matcher
 * wrong?"
 */
export interface MergeEffectSet {
  /** Null only for a human merge, which is decided by judgement, not a key. */
  readonly matchedOn: MergeRung | null;
  readonly matchedValue: string | null;
  readonly winner: MergeSide;
  readonly loser: MergeSide;
}

/**
 * A merge taken back (ticket #62).
 *
 * NOT A COLUMN ON THE EDGE. The edge is immutable and stays immutable: the
 * store recorded the merge that actually happened and goes on recording
 * it, so a reversal is a SECOND ROW that says the edge no longer stands,
 * joined here at read time. An edge that could be marked reversed in place
 * is an edge that could be marked back, which is a history nobody can read.
 */
export interface MergeReversal {
  readonly id: string;
  /** The human-or-machine stamp again (ADR-0035) — on the undo as on the act. */
  readonly performedBy: MergePerformer;
  readonly unmergedAt: Date;
}

/** One recorded merge. Immutable: the store refuses UPDATE and DELETE. */
export interface MergeEdge {
  readonly id: string;
  readonly companyId: string;
  readonly loserEntityId: string;
  readonly winnerEntityId: string;
  readonly status: MergeStatus;
  readonly performedBy: MergePerformer;
  readonly matchedOn: MergeRung | null;
  readonly effectSet: MergeEffectSet;
  readonly mergedAt: Date;
  /**
   * The reversal that took this edge out of the graph, or null while it
   * still stands. Derived by join — see `MergeReversal`.
   */
  readonly reversal: MergeReversal | null;
}

/**
 * A merge whose edge would close a ring. Refused loudly and never filed: a
 * cycle is a broken store, not a candidate-quality problem, and a resolution
 * walk that does not terminate is worse than a wrong answer.
 */
export class MergeCycleError extends Error {
  override readonly name = "MergeCycleError";
  constructor(loserEntityId: string, winnerEntityId: string) {
    super(
      `refusing a merge that closes a cycle: ${winnerEntityId} already resolves through ${loserEntityId} (ADR-0035: a cycle check is mandatory)`,
    );
  }
}

/**
 * The loser already points somewhere that STILL STANDS. One live out-edge
 * per entity is what makes resolution a walk rather than a search, and a
 * second edge would silently overwrite the first one's answer — so it is
 * refused rather than resolved. Once that edge is reversed the record is
 * free to merge again (ticket #62): the rule is about the graph the walks
 * follow, not about an id being spent.
 */
export class MergeAlreadyRecordedError extends Error {
  override readonly name = "MergeAlreadyRecordedError";
  constructor(loserEntityId: string, standingWinnerId: string) {
    super(
      `${loserEntityId} already resolves to ${standingWinnerId}; a second edge would rewrite a merge that already happened (ADR-0035: the edge is never rewritten)`,
    );
  }
}

/** An entity named in a merge that this company has not filed. */
export class MergeUnknownEntityError extends Error {
  override readonly name = "MergeUnknownEntityError";
  constructor(companyId: string, entityId: string) {
    super(`no entity ${entityId} is filed for company ${companyId}`);
  }
}

export interface MergeRequest {
  readonly companyId: string;
  readonly loserEntityId: string;
  readonly winnerEntityId: string;
  readonly status: MergeStatus;
  readonly performedBy: MergePerformer;
  /** Required for a `machine` merge — the store refuses one without it. */
  readonly matchedOn?: MergeRung;
  readonly matchedValue?: string;
}

/**
 * Files one merge edge, with the effect set read at that instant.
 *
 * The effect set is COMPUTED HERE and never accepted from a caller: it is
 * the record of what was true when the merge happened, and a caller-supplied
 * one would be a claim rather than an observation.
 *
 * MERGE IS NOT DISCLOSED (ADR-0003 as amended). This writes exactly one row
 * and no disclosure line: it files no fact, moves nothing across the wall,
 * and rearranges company data that already crossed and already had its
 * window. The disclosure is the crossing receipt, and a merge is not a
 * crossing.
 */
export async function fileMerge(
  ctx: MergeWriteContext,
  request: MergeRequest,
): Promise<MergeEdge> {
  return withApertureUnit(ctx.db, async () => {
    // The company-scoped lock, taken here as well as in the store's own
    // trigger: this writer READS the graph before it writes, and a lock
    // acquired only at INSERT time would leave the read stale. Re-entrant,
    // so the trigger's own acquisition costs nothing.
    await ctx.db.query(LOCK_COMPANY_SQL, [request.companyId]);

    // THE CYCLE CHECK, ON THE IDS AS GIVEN and before anything is resolved,
    // so the caller gets a typed refusal for the thing it actually asked
    // for: «merge B into A» when A already resolves through B is a ring, and
    // so is merging a record into itself. The store asks again in a trigger
    // — that is not redundancy but the difference between a rule this writer
    // keeps and a rule the graph has.
    if (
      await reaches(
        ctx,
        request.companyId,
        request.winnerEntityId,
        request.loserEntityId,
      )
    ) {
      throw new MergeCycleError(request.loserEntityId, request.winnerEntityId);
    }

    // BOTH ENDS ARE CANONICALIZED TO THEIR SURVIVING IDS (Codex r3). A
    // caller names customers, not rows — and the id it names may already
    // have merged. Take it at face value and two things go wrong at once:
    // the edge records a winner that is not the surviving id, and the
    // effect set describes the component under the id NAMED rather than the
    // one actually joined, which is the whole record of what the merge
    // affected. So `C is a duplicate of A` where A already resolves to B is
    // filed as what it is: C joins B.
    //
    // This is NOT the flattening ADR-0035 forbids. Flattening rewrites
    // edges that exist — `A→B→C` restated as `A→C`. Nothing here is
    // rewritten: the chain that already exists is untouched, and the ONE new
    // edge says which two surviving records became one.
    //
    // The matcher already resolves before it calls, so for the shipped path
    // this is a no-op. It is the human merge verb, when one arrives, that
    // will hand this function a member of a component.
    const companyId = request.companyId;
    const winnerEntityId = await resolveEntity(ctx, {
      companyId,
      entityId: request.winnerEntityId,
    });
    const loserEntityId = await resolveEntity(ctx, {
      companyId,
      entityId: request.loserEntityId,
    });
    if (winnerEntityId === loserEntityId) {
      throw new MergeAlreadyRecordedError(
        request.loserEntityId,
        winnerEntityId,
      );
    }

    const sides = await sidesAt(ctx, companyId, [
      winnerEntityId,
      loserEntityId,
    ]);
    const winner = sides.get(winnerEntityId)!;
    const loser = sides.get(loserEntityId)!;

    const effectSet: MergeEffectSet = {
      matchedOn: request.matchedOn ?? null,
      matchedValue: request.matchedValue ?? null,
      winner,
      loser,
    };
    let inserted;
    try {
      inserted = await ctx.db.query<MergeRow>(
        `INSERT INTO ledger.entity_merges
           (company_id, loser_entity_id, winner_entity_id, status,
            performed_by, matched_on, effect_set)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, company_id, loser_entity_id, winner_entity_id, status,
                   performed_by, matched_on, effect_set, merged_at,
                   -- An edge just filed stands, by construction: a reversal
                   -- names a merge, so there is nothing yet that could name
                   -- this one.
                   NULL::uuid AS reversal_id,
                   NULL::text AS reversal_performed_by,
                   NULL::timestamptz AS reversal_unmerged_at`,
        [
          companyId,
          loserEntityId,
          winnerEntityId,
          request.status,
          request.performedBy,
          request.matchedOn ?? null,
          JSON.stringify(effectSet),
        ],
      );
    } catch (err) {
      // The store's own refusals, said in this module's words. The checks
      // above ask the same two questions and answer from what THIS
      // transaction can see; these are the answers from what actually
      // committed, and a caller must not have to tell a race apart from a
      // raw constraint name to know which of the two happened.
      throw translateRefusal(err, request);
    }
    const edge = toEdge(inserted.rows[0]!);

    // AUDIT-CHAINED, INSIDE THE SAME UNIT AS THE EDGE, so the merge and its
    // record commit together or not at all — exactly as `entity_create` and
    // `entity_unmerge` do.
    //
    // THE ACT THAT ASKED NOBODY. The ladder performs this with no user in
    // the loop, which is #62's own stated reason for chaining the reversal
    // — "an act performed with no user in the loop is the one a reader of
    // the chain most needs to find" — and it applies harder here than to
    // taking it back. The edge records the OUTCOME; nothing else anywhere
    // records that a decision was made without a human, which is the
    // question a reader of the chain is actually asking. That is the
    // principle ticket #78 settled: the chain covers acts whose only trace
    // it would be.
    //
    // CONTENT-FREE (ADR-0020): opaque ids only. `matchedValue` is the
    // identifier that fired the rung — AN EMAIL OR A PHONE — and it must
    // never reach the chain. The RUNG is a category rather than a value, so
    // it rides in the outcome: a reader asking "why did these two become
    // one?" gets an answer without the chain holding a customer identifier.
    await chainApertureAct(ctx, {
      action: "entity_merge",
      ref: mergeRef(edge),
      outcome: `performed:${edge.performedBy}:${edge.matchedOn ?? "none"}`,
    });

    return edge;
  });
}

/**
 * The `ref` for a merge, mirroring `unmergeRef` so the two read the same way
 * down a printed chain.
 *
 * The merge id is server-minted, so it needs no company prefix to be
 * unambiguous — unlike `entity_kind`, whose subject is a client-minted
 * entity id and is therefore scoped by company. The two entity ids ride
 * along for the reader; the JOIN keys on `merge:` alone.
 */
function mergeRef(edge: MergeEdge): string {
  return `merge:${edge.id} loser:${edge.loserEntityId} winner:${edge.winnerEntityId}`;
}

/** Postgres: uniqueness refused the row. */
const UNIQUE_VIOLATION = "23505";

/**
 * The store's refusal for the ONE question this writer asked and could get a
 * stale answer to.
 *
 * "One out-edge per loser that still stands" is the only refusal reachable
 * through this function that the checks above cannot see coming: they run
 * under READ COMMITTED, so an edge another transaction has written and not
 * yet committed is invisible to them and visible to the store. It was an
 * index and is now the trigger's own check (ticket #62 — no index can carry
 * a predicate over the reversals table), raising the SAME SQLSTATE for the
 * same reason, so this translation is unchanged.
 *
 * A cycle is deliberately NOT translated here — the trigger's
 * `check_violation` shares a SQLSTATE with every declarative CHECK on the
 * table, so guessing would relabel "a machine merge that named no rung" as a
 * cycle, and the cycle check above already gives every reachable caller a
 * typed error.
 */
function translateRefusal(err: unknown, request: MergeRequest): unknown {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;
  if (code === UNIQUE_VIOLATION) {
    return new MergeAlreadyRecordedError(
      request.loserEntityId,
      "a winner another transaction filed",
    );
  }
  return err;
}

/**
 * The surviving id for any id, forever (ADR-0035).
 *
 * Derived, never stored: the walk runs over the edges THAT STILL STAND
 * every time, so there is no projection to rebuild and — the part that
 * matters — no row anywhere claiming a merge nobody performed. `A→B→C`
 * answers `C` for `A` while remaining two edges, and reversing either one
 * of them re-answers both without touching a row (ticket #62).
 *
 * Status is deliberately not consulted. A `created_in_error` id still
 * resolves, because "the loser's id stays resolvable forever" is about
 * references never dangling; what its status changes is whether its facts
 * read forward, which is `readResolvedTimeline`'s question.
 */
export async function resolveEntity(
  ctx: MergeContext,
  target: EntityRef,
): Promise<string> {
  const res = await ctx.db.query<{ resolved: string | null }>(
    "SELECT ledger.resolve_entity($1, $2) AS resolved",
    [target.companyId, target.entityId],
  );
  return res.rows[0]?.resolved ?? target.entityId;
}

/**
 * One recorded merge and its reversal if it has one — the projection every
 * read of the edge shares, so "does this edge still stand?" is answered the
 * same way everywhere.
 */
const MERGE_EDGE_SELECT = `
  SELECT m.id, m.company_id, m.loser_entity_id, m.winner_entity_id, m.status,
         m.performed_by, m.matched_on, m.effect_set, m.merged_at,
         u.id AS reversal_id,
         u.performed_by AS reversal_performed_by,
         u.unmerged_at AS reversal_unmerged_at
    FROM ledger.entity_merges m
    LEFT JOIN ledger.entity_unmerges u
      ON u.company_id = m.company_id AND u.merge_id = m.id`;

/**
 * Every merge one company has recorded, oldest first — INCLUDING the ones
 * that have since been reversed.
 *
 * A reversed merge is not a merge that did not happen. The store recorded
 * the decision the system actually made, and an undo that made it
 * disappear from this read would erase the only evidence that the automatic
 * matcher got something wrong — which is the number ADR-0035 gates the
 * fuzzy matcher's expansion on (surfaced / merged / REVERSED per company
 * per week).
 */
export async function readEntityMerges(
  ctx: MergeContext,
  companyId: string,
): Promise<MergeEdge[]> {
  const res = await ctx.db.query<MergeRow>(
    `${MERGE_EDGE_SELECT}
      WHERE m.company_id = $1
      ORDER BY m.merged_at, m.id`,
    [companyId],
  );
  return res.rows.map(toEdge);
}

/**
 * The context a reversal needs: a Postgres client and the chain key
 * (ADR-0020) — which is exactly `ChainingContext`, named again here for the
 * caller that asks for it. No twin DEK: an unmerge decides what two of the
 * company's records mean, exactly as the merge did, and may not open an
 * envelope to do it (ADR-0004).
 */
export type UnmergeContext = ChainingContext;

export interface UnmergeRequest {
  readonly companyId: string;
  /** The edge to take back, by id. */
  readonly mergeId: string;
  readonly performedBy: MergePerformer;
}

/** A reversal naming an edge this company has not recorded. */
export class MergeUnknownEdgeError extends Error {
  override readonly name = "MergeUnknownEdgeError";
  constructor(companyId: string, mergeId: string) {
    super(`no merge ${mergeId} is recorded for company ${companyId}`);
  }
}

/**
 * The edge has already been taken back. Refused rather than repeated: a
 * merge either stands or it does not, and a second reversal would record a
 * state change that did not happen. Re-merging is a NEW edge, not this one
 * switched back on.
 */
export class MergeAlreadyReversedError extends Error {
  override readonly name = "MergeAlreadyReversedError";
  constructor(mergeId: string, reversalId: string) {
    super(
      `merge ${mergeId} was already reversed by ${reversalId}; an edge is taken back once (ADR-0035: the record of what happened is never rewritten)`,
    );
  }
}

/**
 * Takes one merge back (ticket #62; ADR-0035, ADR-0036).
 *
 * WHAT THIS DOES IS DEACTIVATE A REDIRECT. Merge redirects at READ time and
 * moves nothing; facts are filed against the entity they were filed against
 * and stay there, before the merge and after it. So the undo appends one
 * row saying the edge no longer stands, and every fact falls back where it
 * always was — because it never left. Nothing is reassigned, reinstated or
 * deleted, and a fact written AFTER the merge needs no special handling,
 * which is the crux Reltio refuses and Informatica deletes its way out of.
 *
 * THE EDGE IS NOT TOUCHED. It is immutable by trigger and by privilege, and
 * that is the point rather than an obstacle: the store recorded the merge
 * that actually happened and must go on recording it, because "how often is
 * the automatic matcher wrong?" is unanswerable from a graph that quietly
 * forgets its mistakes.
 *
 * WHO INVOKES IT (the decision, ticket #62). The OPERATOR does, stamped
 * `human` and audit-chained, in ADR-0016's break-glass shape. Not the rep:
 * ADR-0036 is explicit that the rep who could judge a cross-rep duplicate
 * is structurally prevented from seeing it, and work that exists only
 * because of how Dito is built is Dito's work. Not the owner: there is no
 * owner entity surface until slice 4, and the same rule says the owner does
 * not adjudicate records. Not the machine: nothing detects a wrong merge
 * yet — the `reversed` count ADR-0035 gates expansion on does not exist
 * until this function does — so an automatic reverser would need a detector
 * that has to be invented rather than derived. The stamp carries `machine`
 * anyway, for the day one arrives, exactly as the edge carried `human` for
 * the day a human merge verb would.
 *
 * AN UNMERGE IS NOT DISCLOSED, for the reason a merge is not (ADR-0003 as
 * amended): it files no fact, moves nothing across the wall, and rearranges
 * company data that already crossed and already had its correction window.
 * The disclosure is the crossing receipt, and an unmerge is not a crossing.
 */
export async function fileUnmerge(
  ctx: UnmergeContext,
  request: UnmergeRequest,
): Promise<MergeEdge> {
  // THE ATTEMPT IS CHAINED, NOT JUST THE ACT (Codex r2). A refusal and an
  // idempotent repeat get their own outcomes here exactly as they do for an
  // entity create and a retraction (`audit.ts`; spec #48 decision 18) — and
  // a break-glass verb is where that matters most, because "somebody tried
  // to reverse edge X and was told no" is precisely what a reader of the
  // chain is looking for when misuse or operator error is being
  // investigated (ADR-0020).
  //
  // Which is why the refusals are RETURNED out of the unit and thrown
  // afterwards: throwing from inside would roll the unit back and take the
  // chain entry with it. The caller still gets its typed error; the chain
  // has already committed.
  const outcome = await withApertureUnit(ctx.db, async () => {
    // The company-scoped lock, as the merge writer takes it: this reads the
    // edge before it writes, and the store's own trigger takes the same
    // re-entrant key.
    await ctx.db.query(LOCK_COMPANY_SQL, [request.companyId]);

    const res = await ctx.db.query<MergeRow>(
      `${MERGE_EDGE_SELECT} WHERE m.company_id = $1 AND m.id = $2`,
      [request.companyId, request.mergeId],
    );
    const row = res.rows[0];
    if (row === undefined) {
      await chainApertureAct(ctx, {
        action: "entity_unmerge",
        ref: `merge:${request.mergeId}`,
        outcome: "refused:unknown_edge",
      });
      return { refusal: "unknown_edge" } as const;
    }
    const edge = toEdge(row);
    if (edge.reversal !== null) {
      await chainApertureAct(ctx, {
        action: "entity_unmerge",
        ref: unmergeRef(edge, edge.reversal.id),
        outcome: "already_reversed",
      });
      return { refusal: "already_reversed", edge } as const;
    }

    const inserted = await ctx.db.query<{
      id: string;
      performed_by: MergePerformer;
      unmerged_at: Date;
    }>(
      `INSERT INTO ledger.entity_unmerges (company_id, merge_id, performed_by)
       VALUES ($1, $2, $3)
       RETURNING id, performed_by, unmerged_at`,
      [request.companyId, request.mergeId, request.performedBy],
    );
    const reversal: MergeReversal = {
      id: inserted.rows[0]!.id,
      performedBy: inserted.rows[0]!.performed_by,
      unmergedAt: inserted.rows[0]!.unmerged_at,
    };

    // AUDIT-CHAINED, through the aperture's own `ApertureAction` vocabulary
    // rather than a fourth path straight to the chain — three call sites
    // already bypass that supposedly-closed set, and ticket #78 exists to
    // fence it.
    //
    // WHO the operator was is not a field here: there is no operator
    // identity in the Ledger. It is the audited session ADR-0016 requires
    // for reaching production at all, feeding this same chain.
    await chainApertureAct(ctx, {
      action: "entity_unmerge",
      ref: unmergeRef(edge, reversal.id),
      outcome: "reversed",
    });

    return { refusal: null, edge: { ...edge, reversal } } as const;
  });

  if (outcome.refusal === "unknown_edge") {
    throw new MergeUnknownEdgeError(request.companyId, request.mergeId);
  }
  if (outcome.refusal === "already_reversed") {
    throw new MergeAlreadyReversedError(
      outcome.edge.id,
      outcome.edge.reversal!.id,
    );
  }
  return outcome.edge;
}

/**
 * One reversal's `ref`, as opaque ids: which reversal, which edge, and the
 * two records it is about.
 *
 * Not `apertureRef`, which anchors on a twin and the `wa_events` row that
 * evidenced the act — an unmerge has neither, because a merge is not a rep
 * act (ADR-0003 as amended) and its reversal is not either. What this
 * anchors on is the rows. Content-free either way (ADR-0020): the
 * identifier that fired the merge is never in here.
 */
function unmergeRef(edge: MergeEdge, reversalId: string): string {
  return `unmerge:${reversalId} merge:${edge.id} loser:${edge.loserEntityId} winner:${edge.winnerEntityId}`;
}

/** One fact on a resolved timeline, still naming the entity it was filed against. */
export interface TimelineFact {
  readonly id: string;
  /**
   * THE ENTITY IT WAS FILED AGAINST — not the resolved one. This is the id
   * a grant attaches to, and keeping it visible is what makes the
   * privilege-escalation question answerable rather than implicit.
   */
  readonly entityId: string;
  readonly factType: string;
  readonly payloadVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly confidence: number | null;
  readonly sourceType: "extraction" | "rep_act";
}

export interface ResolvedTimeline {
  /** The id that was asked about. */
  readonly requestedEntityId: string;
  /** The surviving id it resolves to. */
  readonly entityId: string;
  /**
   * Every id whose facts read forward into this timeline — the resolved id
   * plus everything that merged into it through `merged` edges only. A
   * `created_in_error` entity resolves here and contributes nothing.
   */
  readonly memberEntityIds: readonly string[];
  /** What this twin may read, oldest first. */
  readonly facts: readonly TimelineFact[];
}

/**
 * One entity's timeline as one twin may read it (ADR-0035, FR-32).
 *
 * GRANTS ATTACH TO THE ENTITY A FACT WAS FILED AGAINST, NEVER THE RESOLVED
 * ONE. That is the whole reason a merge is not privilege escalation: a rep's
 * creation grant returns the facts that rep's own conversation filed, and
 * merging two entities never hands them another rep's. It is expressed here
 * as a join key — the grant is joined on the FACT's entity id — so the
 * property is structural rather than a filter someone could reorder.
 *
 * A CREATION GRANT IS SELF-SCOPED (CONTEXT.md, Grant): it returns only what
 * that rep's own conversation filed. Confirming which customer a
 * conversation belongs to is not a claim on everything anyone will ever file
 * against that customer — every cross-rep read is owner-assigned and
 * deliberate. Treating any grant as a full read is the cross-rep escalation
 * ADR-0035 says a merge must never create (Codex r2).
 *
 * A MERGE NEVER DEDUPLICATES FACTS. Two reps who each filed the same
 * promised date filed two true assertions with separate provenance, and both
 * appear. Collapsing them would destroy provenance and invent a fact nobody
 * filed.
 */
export async function readResolvedTimeline(
  ctx: MergeContext,
  target: EntityRef & { readonly twinId: string },
): Promise<ResolvedTimeline> {
  // ONE STATEMENT, ONE SNAPSHOT (Codex r3). Resolution, membership and the
  // grant-filtered facts were three statements, and three statements under
  // READ COMMITTED are three snapshots: a merge committing between the fact
  // read and the member read produced a timeline naming a member whose facts
  // it had already decided not to return — an answer that was never true of
  // the database. The whole read is one statement so the answer is a state
  // that existed.
  const res = await ctx.db.query<{
    resolved_id: string;
    member_ids: string[];
    facts: TimelineRow[] | null;
  }>(
    `WITH RECURSIVE resolved (entity_id) AS (
         SELECT ledger.resolve_entity($1, $2)
     ),
     members (entity_id) AS (
         SELECT entity_id FROM resolved
       UNION
         SELECT e.loser_entity_id
           FROM ledger.active_entity_merges($1) e
           JOIN members m ON m.entity_id = e.winner_entity_id
          WHERE e.status = 'merged'
     )
     SELECT (SELECT entity_id FROM resolved) AS resolved_id,
            (SELECT array_agg(entity_id ORDER BY entity_id) FROM members)
              AS member_ids,
            (SELECT jsonb_agg(
                      jsonb_build_object(
                        'id', f.id,
                        'entityId', f.entity_id,
                        'factType', f.fact_type,
                        'payloadVersion', f.payload_version,
                        'payload', f.payload,
                        'occurredAt', f.occurred_at,
                        'confidence', f.confidence,
                        'sourceType', f.source_type)
                      ORDER BY f.occurred_at, f.id)
               FROM ledger.facts f
               JOIN members m ON m.entity_id = f.entity_id
               -- The grant is joined on the FACT's entity, never on the
               -- resolved one. A twin holding no grant on the entity a fact
               -- was filed against does not see it, however the entities
               -- were later merged.
               JOIN ledger.entity_grants g
                 ON g.company_id = f.company_id
                AND g.entity_id = f.entity_id
                AND g.twin_id = $3
              WHERE f.company_id = $1
                AND f.retracted_at IS NULL
                -- The creation grant's self-scoping — see the note above.
                AND (g.source = 'owner_assigned'
                     OR f.filed_by_twin_id = g.twin_id)) AS facts`,
    [target.companyId, target.entityId, target.twinId],
  );
  const row = res.rows[0]!;
  return {
    requestedEntityId: target.entityId,
    entityId: row.resolved_id,
    memberEntityIds: row.member_ids,
    facts: (row.facts ?? []).map((fact) => ({
      id: fact.id,
      entityId: fact.entityId,
      factType: fact.factType,
      payloadVersion: fact.payloadVersion,
      payload: fact.payload,
      // Through JSON, so the instant arrives as text and is parsed here
      // rather than left for each caller to remember.
      occurredAt: new Date(fact.occurredAt),
      confidence: fact.confidence === null ? null : Number(fact.confidence),
      sourceType: fact.sourceType,
    })),
  };
}

/** One fact as the single-statement timeline read returns it, through JSON. */
interface TimelineRow {
  id: string;
  entityId: string;
  factType: string;
  payloadVersion: number;
  payload: Record<string, unknown>;
  occurredAt: string;
  confidence: number | string | null;
  sourceType: "extraction" | "rep_act";
}

/**
 * Why the ladder saw two entities and left them alone.
 *
 * `unmerge_standing` is the one that carries a decision rather than a
 * condition: somebody took this exact merge back, and the ladder does not
 * get to make it again.
 */
export type MergeSkipReason =
  | "kind_mismatch"
  | "already_resolved"
  | "unmerge_standing";

export interface MergeSkip {
  readonly reason: MergeSkipReason;
  readonly matchedOn: MergeRung;
  readonly matchedValue: string;
  readonly entityIds: readonly string[];
}

export interface MergeMatcherReport {
  readonly companyId: string;
  /** Entities carrying at least one match key — everything the ladder could see. */
  readonly entitiesConsidered: number;
  readonly merged: readonly MergeEdge[];
  /**
   * Every group the ladder examined and left alone, with why. A merge that
   * silently does not happen is the failure mode nobody notices — a
   * name-only collision leaves no trace here because a name is never a key
   * at all, but a phone rung blocked on `kind` does, and that is exactly the
   * one worth watching while `kind` has a single value in practice.
   */
  readonly skipped: readonly MergeSkip[];
}

interface MatchKey {
  readonly rung: MergeRung;
  readonly value: string;
}

/**
 * What the matcher needs, and deliberately nothing more (ADR-0004).
 *
 * A Postgres client, no twin DEK. The matcher decides what two of the
 * company's entities MEAN, and it may not open an envelope to do it — so the
 * key is out of scope rather than merely unused, and "Ledger data only"
 * becomes something the type says. An `ApertureContext` satisfies this, so
 * every caller passes one unchanged.
 */
export type MergeContext = Pick<ApertureContext, "db">;

/**
 * What the merge WRITE path needs: a client, and the chain key.
 *
 * Separate from `MergeContext` on purpose, and the split is the property
 * rather than a tidiness (`audit.ts` states it): a path that chains asks
 * for the HMAC key IN ITS SIGNATURE, and a path that does not cannot chain
 * by accident. Every read here — `resolveEntity`, `readEntityMerges`,
 * `readResolvedTimeline` — keeps the narrow one and is unchanged.
 */
export type MergeWriteContext = MergeContext & ChainingContext;

/**
 * The matcher (ADR-0035). Deterministic and idempotent: run it twice and the
 * second run files nothing, because two entities that already resolve to one
 * root are not two entities.
 *
 * Ordering is total and written down rather than inherited from a query
 * plan — rungs in ladder order, values sorted, entities ordered by the
 * survivorship rule — so the same Ledger always produces the same edges.
 */
export async function runMergeMatcher(
  ctx: MergeWriteContext,
  target: { readonly companyId: string },
): Promise<MergeMatcherReport> {
  // ONE MATCHER AT A TIME PER COMPANY. The run reads the graph, decides on
  // what it read, and writes — and two reps of one company file facts at the
  // same time, so two runs overlap for real. Under READ COMMITTED neither
  // sees the other's uncommitted edge, so both resolve the same pair to the
  // same two roots and both try to file the edge; the second would hit the
  // store's one-out-edge-per-loser refusal instead of skipping. The
  // company-scoped lock makes read-decide-write one step, which is the
  // property the run's determinism was claiming all along.
  //
  // A cycle is NOT what that race produces, and the reason is worth stating:
  // every edge runs from the younger entity to the older one, so the graph is
  // a DAG by construction and two racing runs agree on the direction. The
  // cycle check guards the paths that are not this one.
  return withApertureUnit(ctx.db, () => matchWithinCompany(ctx, target));
}

async function matchWithinCompany(
  ctx: MergeWriteContext,
  target: { readonly companyId: string },
): Promise<MergeMatcherReport> {
  await ctx.db.query(LOCK_COMPANY_SQL, [target.companyId]);
  const index = await readMatchKeys(ctx, target.companyId);

  // Rung → value → the entities carrying it. Nested rather than keyed by a
  // composed string, so the two halves of a key never have to be parsed back
  // out of one and a value containing a separator is not a thing that can
  // happen.
  const groups = new Map<MergeRung, Map<string, Set<string>>>();
  for (const [entityId, keys] of index.keys) {
    for (const key of keys) {
      const byValue = groups.get(key.rung) ?? new Map<string, Set<string>>();
      groups.set(key.rung, byValue);
      const carrying = byValue.get(key.value) ?? new Set<string>();
      byValue.set(key.value, carrying);
      carrying.add(entityId);
    }
  }

  const merged: MergeEdge[] = [];
  const skipped: MergeSkip[] = [];
  // Ladder order, then value order: a total order over the groups, so the
  // same Ledger always produces the same edges in the same sequence.
  for (const rung of MERGE_RUNGS) {
    const byValue = groups.get(rung);
    if (byValue === undefined) continue;
    for (const value of [...byValue.keys()].sort()) {
      const carrying = [...byValue.get(value)!];
      if (carrying.length < 2) continue;
      const group: MatchGroup = { rung, value, index, skipped };
      for (const partition of partitionByKind(group, carrying)) {
        await mergePartition(ctx, target.companyId, group, partition, merged);
      }
    }
  }

  return {
    companyId: target.companyId,
    entitiesConsidered: index.keys.size,
    merged,
    skipped,
  };
}

/**
 * The company-scoped serialization every merge takes, writer and store
 * alike. The cast is not decoration: `ledger.entity_merges`'s own trigger
 * takes this lock as `NEW.company_id::text`, and a key that differed by so
 * much as letter case would be a different lock and no serialization at all.
 */
const LOCK_COMPANY_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('dito:merge:company:' || $1::uuid::text, 0))";

/**
 * Takes that lock, for the paths outside this module that decide what the
 * ladder is allowed to do (ticket #60).
 *
 * A `kind` change is one: it decides whether the phone rung may fuse two
 * records, and without this it can commit BETWEEN the matcher's read and
 * its write — leaving the run to merge on a kind that stopped being true
 * while it was deciding, which is the exact fusion the condition exists to
 * refuse. Exported rather than duplicated so there is one lock key; the
 * cast is not decoration (see above).
 */
export async function lockCompanyForMerge(
  ctx: MergeContext,
  companyId: string,
): Promise<void> {
  await ctx.db.query(LOCK_COMPANY_SQL, [companyId]);
}

/** One (rung, value) the ladder is working, and where its outcomes go. */
interface MatchGroup {
  readonly rung: MergeRung;
  readonly value: string;
  readonly index: MatchKeyIndex;
  readonly skipped: MergeSkip[];
}

function skip(
  group: MatchGroup,
  reason: MergeSkipReason,
  entityIds: readonly string[],
): void {
  group.skipped.push({
    reason,
    matchedOn: group.rung,
    matchedValue: group.value,
    entityIds: [...entityIds].sort(),
  });
}

/** One group of entities sharing one key, reduced to at most one survivor. */
async function mergePartition(
  ctx: MergeWriteContext,
  companyId: string,
  group: MatchGroup,
  members: readonly string[],
  merged: MergeEdge[],
): Promise<void> {
  if (members.length < 2) return;
  // Resolve FIRST, and merge the survivors rather than the members. Two
  // entities that already resolve to one root are already one customer, and
  // an edge between them would be the flattening ADR-0035 forbids — `A→B→C`
  // re-recorded as `A→C`, a merge nobody performed.
  const roots = new Set<string>();
  for (const member of members) {
    roots.add(await resolveEntity(ctx, { companyId, entityId: member }));
  }
  if (roots.size < 2) {
    skip(group, "already_resolved", members);
    return;
  }

  const { created, kinds } = group.index;
  const ordered = [...roots].sort((a, b) =>
    bySurvivorship(created.get(a), a, created.get(b), b),
  );
  const winner = ordered[0]!;
  for (const loser of ordered.slice(1)) {
    // The condition again, on the entities that actually become one. A person
    // and a business can only reach this point through an earlier merge on a
    // different rung, and fusing them here would undo the very separation the
    // phone rung's condition exists to keep.
    if (group.rung === "phone" && kinds.get(loser) !== kinds.get(winner)) {
      skip(group, "kind_mismatch", [loser, winner]);
      continue;
    }
    // THE LADDER DOES NOT REDO WHAT WAS TAKEN BACK (ticket #62). An
    // unmerge moves no fact, so the identifier that fired the merge is
    // still filed against both records and the ladder would find it again
    // on the very next pass — the undo would last until that evening and
    // no longer, which is not an undo at all. A reversal is therefore a
    // standing statement that these two are not one customer, and it binds
    // the automation; a human may still decide otherwise, deliberately,
    // through `fileMerge`.
    //
    // Asked HERE, of the two roots actually about to become one, rather
    // than off a set read at the start of the run: a reversal separates two
    // RECORDS, and a record is a component. Reverse `A→B` while `B→C`
    // stands and the next candidate pair is A and C — different ids, and
    // merging them puts A back in exactly the component it was taken out
    // of. Resolving at decision time also keeps the answer true after this
    // very run has filed an edge of its own.
    if (await hasStandingUnmerge(ctx, companyId, loser, winner)) {
      skip(group, "unmerge_standing", [loser, winner]);
      continue;
    }
    merged.push(
      await fileMerge(ctx, {
        companyId,
        loserEntityId: loser,
        winnerEntityId: winner,
        // Everything the ladder files is a genuine same-customer. There is no
        // automatic way to know an entity should never have existed — that is
        // a judgement, and it arrives with a human verb.
        status: "merged",
        performedBy: "machine",
        matchedOn: group.rung,
        matchedValue: group.value,
      }),
    );
  }
}

/**
 * The phone rung's partition. Entities of different `kind` never share a
 * partition, so they are never candidates for one another — and the survivor
 * within each `kind` is the oldest OF THAT KIND, which is why this is a
 * partition rather than a filter over one ordered list.
 *
 * `kind` IS A REAL VALUE NOW (ticket #60). It was uniformly `person` for the
 * whole of slice 3, which made this partition a single group and the
 * condition vacuous on live data; the model determines it at the binding
 * confirmation, so the two groups can actually differ and the skip this
 * emits is a number somebody can read.
 */
function partitionByKind(
  group: MatchGroup,
  members: readonly string[],
): string[][] {
  if (group.rung !== "phone") return [[...members]];
  const byKind = new Map<EntityKind, string[]>();
  for (const member of members) {
    const kind = group.index.kinds.get(member);
    if (kind === undefined) {
      // NO DEFAULT HERE, and that is the point (ticket #60). The kinds map
      // and the match keys come out of ONE statement over a store whose
      // facts carry a foreign key to their entity, so a member with no kind
      // is not a state this can reach — and the fallback it replaces
      // (`?? "person"`) would have decided the phone rung's condition on a
      // value nobody determined, which is the whole defect this ticket
      // fixes. A store that reaches it is broken and says so.
      throw new Error(
        `merge matcher: entity ${member} carries a match key but no kind — the snapshot is inconsistent, and the phone rung will not be decided on a guess (ADR-0035)`,
      );
    }
    byKind.set(kind, [...(byKind.get(kind) ?? []), member]);
  }
  if (byKind.size > 1) skip(group, "kind_mismatch", members);
  return [...byKind.keys()].sort().map((kind) => byKind.get(kind)!);
}

/**
 * SURVIVORSHIP, AS A WRITTEN RULE (ADR-0035) rather than as whichever row a
 * query returns first: the older entity wins, because it is the first record
 * the customer had. Random UUIDs carry no ordering, so the id breaks a tie —
 * arbitrary but TOTAL, which is what makes two runs over one Ledger produce
 * the same edges.
 */
function bySurvivorship(
  leftCreatedAt: Date | undefined,
  leftId: string,
  rightCreatedAt: Date | undefined,
  rightId: string,
): number {
  const left = leftCreatedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = rightCreatedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

interface MatchKeyIndex {
  /** Entity → its keys. An entity with no key is not in this map at all. */
  readonly keys: ReadonlyMap<string, readonly MatchKey[]>;
  /** Every entity in the company, keyed or not — see `readMatchKeys`. */
  readonly kinds: ReadonlyMap<string, EntityKind>;
  readonly created: ReadonlyMap<string, Date>;
}

/**
 * Whether a reversal stands between these two records (ticket #62).
 *
 * BETWEEN THE COMPONENTS, not between the ids. A reversal says two RECORDS
 * are not one customer, and a record is whatever resolves to it — so each
 * end of every reversed edge is resolved to its surviving id and compared
 * with the two roots about to be joined. Direction-free, because
 * survivorship decides which of two ids is the winner and the statement is
 * about the pair.
 *
 * A reversed edge whose two ends now resolve TOGETHER says nothing here:
 * that is somebody having deliberately merged them again, which is a
 * decision this check has no business overriding.
 */
async function hasStandingUnmerge(
  ctx: MergeContext,
  companyId: string,
  one: string,
  other: string,
): Promise<boolean> {
  const res = await ctx.db.query<{ standing: boolean }>(
    `SELECT EXISTS (
        SELECT 1
          FROM ledger.entity_merges m
          JOIN ledger.entity_unmerges u
            ON u.company_id = m.company_id AND u.merge_id = m.id
         WHERE m.company_id = $1
           AND ARRAY[ledger.resolve_entity($1, m.loser_entity_id),
                     ledger.resolve_entity($1, m.winner_entity_id)]
               <@ ARRAY[$2::uuid, $3::uuid]
           AND ledger.resolve_entity($1, m.loser_entity_id)
               <> ledger.resolve_entity($1, m.winner_entity_id)
     ) AS standing`,
    [companyId, one, other],
  );
  return res.rows[0]!.standing;
}

/**
 * Every match key one company has filed, read off the Ledger.
 *
 * `ContactEstablished` payloads only, and never a name: **a matching name is
 * never sufficient**, so `display_name` is not read here at all. A name that
 * is not a key cannot become one by accident.
 *
 * A RETRACTED fact contributes no key. Its content is what the rep said was
 * wrong (FR-33), and an identifier the rep withdrew must not go on deciding
 * that two customers are one.
 */
async function readMatchKeys(
  ctx: MergeContext,
  companyId: string,
): Promise<MatchKeyIndex> {
  // AGE AND KIND COME OFF THE ENTITY, NOT OFF THE FACT THAT MATCHED. Read
  // them from the join instead, and an entity with no LIVE match key of its
  // own drops out of both maps — which is reachable the moment a rep
  // retracts the contact fact that once matched (FR-33). Survivorship would
  // then treat the oldest entity in the company as the youngest, and the
  // phone rung's `kind` condition would have nothing to compare. Both are
  // silent wrong answers in an append-only store, so the company's entities
  // are read whole.
  //
  // AND ONE STATEMENT, NOT TWO (ticket #60, Codex r1). This used to read the
  // entities and then the facts, which under READ COMMITTED are two
  // snapshots — and the company lock above serializes MATCHERS, not entity
  // creates or fact filings. So a customer bound by a second twin of the
  // same company between the two reads could arrive carrying a match key
  // with no row in the kind map, and the fallback below bucketed it as
  // `person`: a business fused into a person on a shared switchboard, which
  // is the exact merge the phone rung's condition exists to refuse. It was
  // harmless only while every entity was `person`; this ticket is what makes
  // it bite. Two JSON arrays out of one statement is the medicine this
  // module already took for the effect set.
  const snapshot = await ctx.db.query<{
    entities: {
      entityId: string;
      kind: EntityKind;
      createdAt: string;
    }[] | null;
    contacts:
      | { entityId: string; payload: { identifiers?: Record<string, unknown> } }[]
      | null;
  }>(
    // AND A FACT THAT DOES NOT READ FORWARD CARRIES NO KEY (Codex r2). An
    // entity merged as `created_in_error` should never have existed, so its
    // facts stop at that edge — and so must its identifiers. Left in, they
    // become the SURVIVOR's match keys: a duplicate that was struck out
    // would go on deciding that two real customers are one, on a value
    // neither of them ever carried. Whatever merged into it stops there
    // too, which is what makes this a walk rather than a filter.
    // A REVERSED EDGE STRIKES NOTHING OUT (ticket #62). Taking back a
    // `created_in_error` merge is precisely the statement that the record
    // should have existed after all — so its identifiers become live match
    // keys again, and whatever merged into it comes back with it.
    `WITH RECURSIVE struck (entity_id) AS (
         SELECT loser_entity_id
           FROM ledger.active_entity_merges($1)
          WHERE status = 'created_in_error'
       UNION
         SELECT m.loser_entity_id
           FROM ledger.active_entity_merges($1) m
           JOIN struck s ON s.entity_id = m.winner_entity_id
     ),
     ents AS (
       SELECT entity_id, kind, created_at
         FROM ledger.entities
        WHERE company_id = $1
     ),
     contacts AS (
       SELECT f.entity_id, f.payload
         FROM ledger.facts f
        WHERE f.company_id = $1
          AND f.fact_type = 'ContactEstablished'
          AND f.retracted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM struck s WHERE s.entity_id = f.entity_id)
        ORDER BY f.entity_id, f.id
     )
     SELECT
       (SELECT json_agg(json_build_object(
                 'entityId', entity_id, 'kind', kind, 'createdAt', created_at))
          FROM ents) AS entities,
       (SELECT json_agg(json_build_object(
                 'entityId', entity_id, 'payload', payload))
          FROM contacts) AS contacts`,
    [companyId],
  );

  const kinds = new Map<string, EntityKind>();
  const created = new Map<string, Date>();
  for (const row of snapshot.rows[0]?.entities ?? []) {
    kinds.set(row.entityId, row.kind);
    created.set(row.entityId, new Date(row.createdAt));
  }

  const keys = new Map<string, MatchKey[]>();
  for (const row of snapshot.rows[0]?.contacts ?? []) {
    const arms = row.payload.identifiers ?? {};
    const found = keys.get(row.entityId) ?? [];
    for (const [arm, rung] of ARMS) {
      for (const value of stringArm(arms[arm])) {
        // Values were normalized on the way in, at the aperture (#52):
        // E.164, lowercased email, uppercased RFC. Nothing is normalized
        // here — a match key normalized at read time would mean the stored
        // one was wrong, and ADR-0034 forbids restructuring it.
        found.push({ rung, value });
      }
    }
    if (found.length > 0) keys.set(row.entityId, found);
  }
  return { keys, kinds, created };
}

/**
 * Which payload arm carries which rung.
 *
 * Typed against `NormalizedIdentifiers` rather than against `string`, so
 * renaming an arm where the payload is SHAPED fails this file's typecheck
 * instead of quietly producing a matcher that finds nothing.
 */
const ARMS: readonly (readonly [keyof NormalizedIdentifiers, MergeRung])[] = [
  ["rfcs", "rfc"],
  ["emails", "email"],
  ["phones", "phone"],
];

function stringArm(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v !== "");
}

/**
 * Both sides' state at merge time, in ONE STATEMENT (Codex r1).
 *
 * The effect set claims to be what was true AT THE INSTANT of the merge, and
 * it is immutable once written — so it has to be read from a single instant.
 * Six statements under READ COMMITTED each take their own snapshot: a fact
 * committed against the winner after the winner's read and before the
 * loser's produces an effect set holding the loser's new fact and missing
 * the winner's, a combination that was never the state of anything. Two reps
 * of one company filing while a pass merges is all that takes.
 *
 * One statement is one snapshot, so what it returns is a state that existed.
 */
async function sidesAt(
  ctx: MergeContext,
  companyId: string,
  entityIds: readonly string[],
): Promise<Map<string, MergeSide>> {
  const res = await ctx.db.query<{
    entity_id: string;
    kind: EntityKind;
    display_name: string;
    created_at: Date;
    member_ids: string[];
    fact_ids: string[] | null;
    grants:
      | {
          entityId: string;
          twinId: string;
          source: "creation" | "owner_assigned";
        }[]
      | null;
  }>(
    // The component each side brings with it, walked backwards over `merged`
    // edges only — the same membership rule the resolved timeline reads by,
    // so the effect set records exactly what the merge made readable.
    `WITH RECURSIVE members (root_id, entity_id) AS (
         SELECT id, id FROM unnest($2::uuid[]) AS seed(id)
       UNION
         SELECT m.root_id, e.loser_entity_id
           FROM ledger.active_entity_merges($1) e
           JOIN members m ON m.entity_id = e.winner_entity_id
          WHERE e.status = 'merged'
     )
     SELECT e.entity_id, e.kind, e.display_name, e.created_at,
            mem.member_ids, f.fact_ids, g.grants
       FROM ledger.entities e
       JOIN LATERAL (
         SELECT array_agg(entity_id ORDER BY entity_id) AS member_ids
           FROM members WHERE root_id = e.entity_id
       ) mem ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(x.id ORDER BY x.occurred_at, x.id) AS fact_ids
           FROM ledger.facts x
           JOIN members mm
             ON mm.entity_id = x.entity_id AND mm.root_id = e.entity_id
          WHERE x.company_id = $1
       ) f ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object('entityId', y.entity_id,
                                     'twinId', y.twin_id,
                                     'source', y.source)
                  ORDER BY y.entity_id, y.granted_at, y.twin_id) AS grants
           FROM ledger.entity_grants y
           JOIN members mm
             ON mm.entity_id = y.entity_id AND mm.root_id = e.entity_id
          WHERE y.company_id = $1
       ) g ON true
      WHERE e.company_id = $1 AND e.entity_id = ANY($2::uuid[])`,
    [companyId, entityIds],
  );
  const sides = new Map<string, MergeSide>();
  for (const row of res.rows) {
    sides.set(row.entity_id, {
      entityId: row.entity_id,
      kind: row.kind,
      displayName: row.display_name,
      createdAt: row.created_at.toISOString(),
      memberEntityIds: row.member_ids,
      factIds: row.fact_ids ?? [],
      grants: row.grants ?? [],
    });
  }
  for (const entityId of entityIds) {
    if (!sides.has(entityId)) {
      throw new MergeUnknownEntityError(companyId, entityId);
    }
  }
  return sides;
}

/**
 * Whether `from` reaches `to` by following the edges that STILL STAND — the
 * cycle question. A reversed edge closes no ring, which is what makes a
 * deliberate B→A legal once A→B has been taken back.
 */
async function reaches(
  ctx: MergeContext,
  companyId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const res = await ctx.db.query<{ found: boolean }>(
    `WITH RECURSIVE walk (entity_id) AS (
         SELECT $2::uuid
       UNION ALL
         SELECT e.winner_entity_id
           FROM ledger.active_entity_merges($1) e
           JOIN walk w ON w.entity_id = e.loser_entity_id
     ) CYCLE entity_id SET is_cycle USING path
     SELECT EXISTS (SELECT 1 FROM walk WHERE entity_id = $3::uuid) AS found`,
    [companyId, from, to],
  );
  return res.rows[0]!.found;
}

interface MergeRow {
  id: string;
  company_id: string;
  loser_entity_id: string;
  winner_entity_id: string;
  status: MergeStatus;
  performed_by: MergePerformer;
  matched_on: MergeRung | null;
  effect_set: MergeEffectSet;
  merged_at: Date;
  /** The joined reversal, all three null together while the edge stands. */
  reversal_id: string | null;
  reversal_performed_by: MergePerformer | null;
  reversal_unmerged_at: Date | null;
}

function toEdge(row: MergeRow): MergeEdge {
  return {
    id: row.id,
    companyId: row.company_id,
    loserEntityId: row.loser_entity_id,
    winnerEntityId: row.winner_entity_id,
    status: row.status,
    performedBy: row.performed_by,
    matchedOn: row.matched_on,
    effectSet: row.effect_set,
    mergedAt: row.merged_at,
    reversal:
      row.reversal_id === null ||
      row.reversal_performed_by === null ||
      row.reversal_unmerged_at === null
        ? null
        : {
            id: row.reversal_id,
            performedBy: row.reversal_performed_by,
            unmergedAt: row.reversal_unmerged_at,
          },
  };
}

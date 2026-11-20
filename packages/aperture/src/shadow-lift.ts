/**
 * The lift act: one company's Ledger becomes owner-visible (ticket #132;
 * spec #126 decisions 9 and 19; ADR-0016 as amended, ADR-0003, ADR-0020,
 * ADR-0038).
 *
 * ADR-0016 as amended states the whole of it: "**Lifting is one audited act
 * per company**: set the timestamp and flip that company's existing entity
 * and fact rows, in one transaction, chained under ADR-0020, refusing to
 * run twice." This is that act. `rig-lift-shadow.ts` is the hand trigger
 * that invokes it, in the `rig-unmerge.ts` break-glass family, and it holds
 * no logic of its own for the same reason every sibling does not: the act
 * is a Ledger write, and every statement naming a Ledger object lives in
 * the single writer's package (ADR-0003, enforced by `sole-writer.test.ts`).
 *
 * WHY IT IS AN ACT AND NOT AN `UPDATE`. The ADR rejects the one-off by
 * name — "the steering surface goes stale the next day, when new facts
 * arrive shadow" — which is why the timestamp on `companies` is the
 * durable half of this act and the row flip is only the catch-up: from the
 * moment it is set, `facts.ts`, `questions.ts` and `entities.ts` stamp
 * every new row `shadow = false` for this company on their own. The two
 * halves are one transaction because half of them is a company stamped as
 * lifted whose rows are still shadow, or rows nothing will ever explain.
 *
 * IT REFUSES TO RUN TWICE, AND WRITES NOTHING WHEN IT DOES. That is the
 * ticket's own acceptance criterion, and it is a departure from
 * `fileUnmerge` beside it, which chains its refusals because ADR-0035
 * asks it to — "the chain records the refused and repeated attempts too".
 * Nothing asks that here, and the silence buys a property worth having: a
 * refused lift leaves no entry, so `shadow_lift` entries and lifted
 * companies stay 1:1 and the coverage check can join them per act rather
 * than counting. An operator who runs it twice is told, in the script, in
 * plain words.
 *
 * NO BUNDLE, NO TWIN KEY — the `fileUnmerge` shape, and for its reason
 * (ADR-0004): deciding that a company's records may be read by their owner
 * opens no envelope and needs no seam row. What it needs is the Ledger and
 * the chain key, which is exactly `ChainingContext`.
 *
 * WHO the operator was is not recorded, deliberately and for the third
 * time in this family: there is no operator identity in the Ledger, and
 * reaching production at all is an audited session (ADR-0016) feeding this
 * same chain. That session is the answer to "who".
 *
 * KNOWN CONSEQUENCE, said here because this is the code that causes it:
 * ADR-0038's payload-migration window closes for a company the moment it
 * lifts. That ADR's `OrderTaken` migration "refuses, loudly, if a single
 * non-shadow `OrderTaken` row exists", and this is what makes one exist.
 */
import type pg from "pg";
import { chainApertureAct, type ChainingContext } from "./audit.js";
import { withApertureUnit } from "./unit.js";

/**
 * THE COMPANY-SCOPED LOCK BOTH HALVES OF THE LAUNCH GATE TAKE (ticket #132,
 * Codex r1).
 *
 * THE RACE IT CLOSES, which is the whole reason it exists. The stamp is a
 * snapshot read: without a lock, a filing transaction can read `NULL`,
 * insert `shadow = true`, and commit AFTER the lift act has already
 * finished flipping every row it could see. The result is a row that is
 * invisible to its own owner forever, in a company that IS lifted, with
 * nothing anywhere to say so — and the act refuses to run twice, so there
 * is no second pass to repair it. Silent, permanent, and reachable the next
 * time a lift lands while the twin runtime is up.
 *
 * SHARED FOR FILING, EXCLUSIVE FOR THE LIFT. Filings do not contend with
 * each other at all; the only thing that ever blocks is the once-per-company
 * act, in one of two orders, and both are correct. A filing that gets the
 * lock first makes the lift WAIT, so the lift's catch-up sees the new row.
 * A lift that gets it first makes the filing wait, and the filing's next
 * statement — READ COMMITTED takes a fresh snapshot per statement — reads
 * the committed timestamp and stamps `false`.
 *
 * THE SHAPE IS `merge.ts`'s `LOCK_COMPANY_SQL`, which fences the same class
 * of read-then-write race for the merge ladder and states the same reason
 * ("a lock acquired only at INSERT time would leave the read stale"). The
 * KEY NAMESPACE is this gate's own, deliberately: a lift must not serialize
 * against the merge matcher, and the matcher must not serialize against
 * every crossing. No path takes both locks, so there is no order to get
 * wrong.
 *
 * IT RESTS ON READ COMMITTED, said out loud (Codex r3). The blocked-filing
 * case is correct because a statement issued after the lock is granted
 * takes a fresh snapshot; under REPEATABLE READ the transaction's snapshot
 * would predate the lift and the mode read would still see NULL. Nothing in
 * this repository sets a transaction isolation level and PostgreSQL's
 * default is READ COMMITTED, so no such transaction exists — and the merge
 * ladder's own lock has rested on exactly this since ticket #62. The
 * isolation-independent fence would be a locking read of the registry row
 * (`FOR SHARE`), and it is unavailable on purpose: PostgreSQL requires a
 * WRITE privilege for one, and the aperture holds SELECT on `companies` and
 * must keep holding only that. Recorded rather than papered over.
 */
const LOCK_COMPANY_SQL = (mode: "shared" | "exclusive"): string =>
  `SELECT pg_advisory_xact_lock${mode === "shared" ? "_shared" : ""}(
            hashtextextended('dito:shadow:company:' || $1::uuid::text, 0))`;

/**
 * THE STAMP: what `shadow` a row filed right now for this company gets.
 *
 * ADR-0016 as amended: "the aperture stamps `shadow` at filing from the
 * company's mode — `true` while unlifted, `false` after — so facts filed
 * after a lift land visible without anyone touching them." Before this
 * ticket the column's `DEFAULT true` did the work and every writer omitted
 * it, which was correct while nothing could ever lift.
 *
 * INSIDE THE FILING TRANSACTION, which spec #126 decision 19 requires: both
 * statements run inside whatever `withApertureUnit` opened — a transaction,
 * or a savepoint in the caller's — so the lock is held until the row is
 * committed and the mode the row was stamped from cannot change underneath
 * it.
 *
 * `COALESCE(…, true)` IS THE RULE, NOT A DEFENSIVE DEFAULT. The registry
 * arrived with ticket #127, and an id in `companies` is a NAME for a
 * company that already existed: every company that filed before that
 * migration has no row, and on any database but the rig most never will.
 * A company with no registry row is UNLIFTED BY DEFINITION — nothing could
 * have lifted it — so the honest value is `true`. Without the coalesce the
 * subquery would return NULL for exactly those companies and the `NOT NULL`
 * column would refuse the crossing, which is the whole Ledger going down
 * for a registry nobody asked them to have.
 *
 * ONE FUNCTION, THREE WRITERS. `facts.ts`, `questions.ts` (the «si» answer
 * path) and `entities.ts` all stamp with it. It is one call rather than a
 * lock the caller must remember to take and a subquery it must remember to
 * paste: a writer that took one without the other would be exactly the
 * defect this closes, and there is no way to spell that here.
 */
export async function shadowAtFiling(
  db: pg.ClientBase,
  companyId: string,
): Promise<boolean> {
  await db.query(LOCK_COMPANY_SQL("shared"), [companyId]);
  const mode = await db.query<{ shadow: boolean }>(
    `SELECT COALESCE((SELECT c.shadow_lifted_at IS NULL
                        FROM public.companies c
                       WHERE c.id = $1), true) AS shadow`,
    [companyId],
  );
  return mode.rows[0]!.shadow;
}

/**
 * What the lift needs: a Postgres client and the chain key — which is
 * exactly `ChainingContext`, named again here for the caller that asks for
 * it, as `UnmergeContext` is.
 */
export type ShadowLiftContext = ChainingContext;

export interface ShadowLiftRequest {
  readonly companyId: string;
  /**
   * WHEN THE LAUNCH GATE OPENED — OMITTED IN PRODUCTION, so the DATABASE
   * stamps it (ticket #132's "set `shadow_lifted_at = now()`"; Codex r2).
   *
   * The instant is the record of when a company's Ledger became readable,
   * and the transaction that made it readable is a database transaction —
   * so `now()` in SQL is both the ticket's literal instruction and the
   * truthful value, immune to the app host's clock and consistent with the
   * `created_at` the chain entry beside it gets. `rig-lift-shadow.ts` passes
   * nothing.
   *
   * A CALLER MAY STILL PIN IT, and exactly one kind does: a suite that has
   * to assert which instant landed. That is the `finalizeDueFacts` rule kept
   * where it earns its keep — "no clock seam, no fake timers" — without
   * putting an ambient clock in the module, because the default is the
   * database's own.
   *
   * `COALESCE` IS WHAT MAKES BOTH SAFE. `null` is the registry's
   * unlifted sentinel, so an untyped caller handing this `null` would
   * otherwise flip a company's rows visible, chain the act, and leave the
   * company reading as never lifted — a corrupted one-shot state the act
   * would then happily repeat. Absent and null both fall through to the
   * database clock, so that state is unreachable rather than merely
   * unlikely.
   *
   * IT SURVIVES rather than being deleted (Codex r3 asked for its removal).
   * A future caller could pass a wrong instant, and that is a review's job:
   * removing the field would take the pinned instant away from every suite
   * that has to assert which one landed, and from `ledger-fixtures`'
   * `liftShadow`, whose `(companyId, liftedAt)` signature two owner-side
   * suites already call. Nothing computes with the value — every reader
   * asks `IS NULL` — so what a wrong one costs is a wrong sentence in a
   * report, not a wrong visibility.
   */
  readonly now?: Date;
}

export interface ShadowLiftResult {
  readonly companyId: string;
  /** The instant now standing on the company's registry row. */
  readonly liftedAt: Date;
  /** Entity rows this act flipped out of shadow. */
  readonly entities: number;
  /** Fact rows this act flipped out of shadow. */
  readonly facts: number;
}

/**
 * The company's Ledger has already been lifted, and a launch gate opens
 * once.
 *
 * Refused rather than repeated, and refused rather than treated as an
 * idempotent no-op the way `rig-unmerge`'s already-reversed is: a second
 * lift would rewrite the instant the company's Ledger became readable,
 * which is a fact about the past in a store whose whole discipline is that
 * the past is not rewritten (ADR-0034). It carries the ORIGINAL instant so
 * the operator is told when it really happened.
 */
export class ShadowAlreadyLiftedError extends Error {
  override readonly name = "ShadowAlreadyLiftedError";
  constructor(
    readonly companyId: string,
    readonly liftedAt: Date,
  ) {
    super(
      `company ${companyId} was already lifted at ${liftedAt.toISOString()}; a launch gate opens once (ADR-0016 as amended: the act refuses to run twice)`,
    );
  }
}

/**
 * No registry row names this company.
 *
 * A SEPARATE ERROR from the one above, because the two are different
 * operator mistakes with different remedies: one is a company already
 * launched, the other is a company id that has never been registered — a
 * typo, or a rig whose `rig-seed-owner.ts` has not been run. Collapsing
 * them into "nothing to do" would let a mistyped id read as success.
 */
export class ShadowLiftUnknownCompanyError extends Error {
  override readonly name = "ShadowLiftUnknownCompanyError";
  constructor(readonly companyId: string) {
    super(
      `no company ${companyId} is registered; the lift act sets a column on a registry row that has to exist first (ticket #127's rig-seed-owner.ts writes it)`,
    );
  }
}

/**
 * Lifts one company's shadow flag: the timestamp, that company's existing
 * rows, and one chain entry, in a single transaction.
 *
 * THE COMPANY ROW IS LOCKED BEFORE IT IS READ, which is what makes "refuses
 * to run twice" true of two concurrent operators rather than only of two
 * sequential ones. Without it both would read NULL, both would pass the
 * check, and the second would overwrite the first one's instant — the exact
 * rewrite the refusal exists to prevent. With it the second blocks, re-reads
 * the committed row under READ COMMITTED, and refuses.
 */
export async function liftCompanyShadow(
  ctx: ShadowLiftContext,
  request: ShadowLiftRequest,
): Promise<ShadowLiftResult> {
  return withApertureUnit(ctx.db, async () => {
    // THE EXCLUSIVE HALF OF THE FILING LOCK, taken before anything is read.
    // It is what makes "facts filed after the act land visible" true of the
    // wall clock and not only of a quiet database: every filing path holds
    // the shared half for as long as its row is uncommitted, so after this
    // returns there is no crossing in flight that this act could miss.
    await ctx.db.query(LOCK_COMPANY_SQL("exclusive"), [request.companyId]);
    // THE ID COMES BACK OUT OF THE STORE, and that is not decoration (Codex
    // r3). A UUID has many spellings and one canonical one: an operator who
    // pastes `A3F4…` in capitals would otherwise have that spelling written
    // into an APPEND-ONLY chain entry, while the coverage check derives its
    // token from `uuid::text` — lowercase — and matches with a
    // case-sensitive LIKE. The lift would succeed, the chain would verify,
    // and `audit-coverage-check` would report the act missing forever, with
    // no second run allowed to repair it. Reading the id back makes every
    // caller's spelling irrelevant, at the one door they all pass through.
    const registered = await ctx.db.query<{
      id: string;
      shadow_lifted_at: Date | null;
    }>(
      "SELECT id, shadow_lifted_at FROM public.companies WHERE id = $1 FOR UPDATE",
      [request.companyId],
    );
    const row = registered.rows[0];
    if (row === undefined) {
      throw new ShadowLiftUnknownCompanyError(request.companyId);
    }
    const companyId = row.id;
    if (row.shadow_lifted_at !== null) {
      throw new ShadowAlreadyLiftedError(companyId, row.shadow_lifted_at);
    }
    // THROWN FROM INSIDE THE UNIT, unlike `fileUnmerge`'s refusals, and the
    // difference is the whole of what a refusal writes: an unmerge returns
    // its refusal out of the unit so the chain entry it already appended
    // survives the throw, and a refused lift appends nothing, so rolling the
    // unit back is exactly the "writes nothing" the ticket asks for.

    const stamped = await ctx.db.query<{ shadow_lifted_at: Date }>(
      `UPDATE public.companies
          SET shadow_lifted_at = COALESCE($2::timestamptz, now())
        WHERE id = $1
      RETURNING shadow_lifted_at`,
      [companyId, request.now ?? null],
    );
    const liftedAt = stamped.rows[0]!.shadow_lifted_at;
    // `AND shadow` on both: the count reported and chained is what this act
    // CHANGED, not how big the company is. Everything is shadow on a first
    // lift, so the two numbers agree today — and the day they do not, the
    // honest one is the one that says what the act did.
    const entities = await ctx.db.query(
      "UPDATE ledger.entities SET shadow = false WHERE company_id = $1 AND shadow",
      [companyId],
    );
    const facts = await ctx.db.query(
      "UPDATE ledger.facts SET shadow = false WHERE company_id = $1 AND shadow",
      [companyId],
    );
    const result: ShadowLiftResult = {
      companyId,
      // READ BACK, never echoed: what the act reports is what the registry
      // now holds, which is the only value anything else will ever see.
      liftedAt,
      entities: entities.rowCount ?? 0,
      facts: facts.rowCount ?? 0,
    };

    // INSIDE THE UNIT, so the crossing's own rule holds for this act too:
    // the chain entry and the thing it records commit together or not at
    // all (`chainApertureAct` refuses outright outside a transaction).
    await chainApertureAct(ctx, {
      action: "shadow_lift",
      ref: shadowLiftRef(result),
      outcome: "lifted",
    });
    return result;
  });
}

/**
 * One lift's `ref`: the company, and the two counts.
 *
 * CONTENT-FREE (ADR-0020: "chain entries are content-free… application logs
 * carry opaque ids only"). A company id is an opaque id and the counts are
 * arithmetic — how many entity and fact rows stopped being shadow — which
 * is what makes the entry answer the question a reader of the chain brings
 * to it: not "what does this company sell" but "how much of its Ledger
 * became readable, and when". No entity id, no fact id, no name.
 *
 * The company token is spelled the way `entityKindRef` spells it, so the
 * coverage check's whole-token match (`% company:<id> %`) finds it.
 */
function shadowLiftRef(result: ShadowLiftResult): string {
  return `company:${result.companyId} entities:${result.entities} facts:${result.facts}`;
}

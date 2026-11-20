/**
 * The aperture's audit vocabulary (ticket #54; ADR-0020; spec #48 decision
 * 18: "Rep acts and refusals are audit-chained").
 *
 * #50 built the crossing and #51 sized this: an entity create is a class-2
 * rep act and was not chained, while #54's retraction must be. Doing both at
 * once is the whole reason this module exists — one vocabulary covers both
 * acts, decided once, rather than two tickets each inventing their own
 * `caller`/`action`/`ref`/`outcome` words and leaving the chain unreadable.
 *
 * THE VOCABULARY, and why each field says what it says:
 *
 *   caller  — WHO PERFORMED THE ACT, as the send-lock writer already uses
 *             it (`caller: req.minter`). Every entry here is the aperture,
 *             because the aperture is the only component that may write the
 *             Ledger (ADR-0003) — so a chain entry naming any other caller
 *             for these actions is itself the finding.
 *   action  — WHAT WAS ATTEMPTED, one of a closed set. Closed on purpose:
 *             the chain is read by a human when trust is questioned, and a
 *             free-text action is a chain nobody can scan.
 *   ref     — OPAQUE IDS ONLY, never content (ADR-0020: "chain entries are
 *             content-free — same rule as application logs"). The rep act's
 *             own `wa_events` id rides along, because "which rep act
 *             authorized this crossing" is the question the chain exists to
 *             answer and an id is not content. The shape follows the
 *             writer's: space-separated `label:value` pairs, twin first.
 *   outcome — WHAT HAPPENED, including the idempotent repeats. A replay
 *             that filed nothing is not the same event as a first filing,
 *             and an audit log that recorded them identically would make a
 *             retry indistinguishable from a duplicate crossing. Refusals
 *             wear the writer's own `refused:<reason>` shape.
 *
 * WHAT IS DELIBERATELY NOT CHAINED. Class-1 candidate facts: extraction
 * files them by the hundred and they are not rep acts, so chaining them
 * would bury the acts the chain exists to make auditable (decision 18 says
 * rep acts and refusals, and means it). Finalization: it is the clock, not
 * anybody's act.
 *
 * CORRECTED 2026-08-30 (ticket #78, Diego's ruling). This block used to
 * carry a third item — the twin-side "that number names no line" refusal,
 * which it said "posts a notice and chains nothing" — and THAT SENTENCE WAS
 * FALSE. It IS chained, in `packages/twin-runtime/src/consumer.ts`, with
 * `CORRECTION_MATCHER_CALLER` as its caller, and it has been since #54.
 * Spec #48 decision 18 says rep acts AND REFUSALS are chained, and a
 * mistyped number is a rep act that was refused: "what did the rep try to
 * do" is the question the chain exists to answer, and from outside a
 * mistyped number is indistinguishable from an attempt to retract a line
 * that is not there. The code was right and this comment was stale.
 *
 * `unresolved_draft` WAS GROUPED WITH IT HERE, AND IS A DIFFERENT CASE.
 * It is the affirmation matcher refusing a quoted «va» whose draft post the
 * executor never recorded a message id for. Split out rather than flipped
 * with the clause — and SETTLED THE OTHER WAY on 2026-08-31: it chains
 * nothing, because the «va» never resolved to any act, so there is no rep
 * act to record. The contrast is the point: the correction refusal chains
 * because the rep named a definite line and the system declined; here
 * nothing definite was attempted. See `MUST_NOT_CHAIN` in
 * `audit-coverage.ts` beside this file, which is where the whole
 * enumeration — must chain, must not chain, and not yet checked — lives
 * with a citation against each entry.
 */
import { appendAuditEntry, type AuditAction } from "@dito/audit";
import type { RepActContext, VerifiedRepAct } from "./inputs.js";

/** The single Ledger writer, as the chain names it (ADR-0003). */
export const APERTURE_CALLER = "aperture";

/**
 * The aperture acts that land on the chain. `entity_create` is the rep
 * confirming a binding; `fact_retraction` is the rep correcting a
 * disclosure line; `entity_unmerge` is an operator taking back a merge the
 * system made without asking anybody (ticket #62); `entity_kind` is a
 * determination of whether a filed entity is a person or a business
 * (ticket #60) — the model's, at the create and again at the backfill, or a
 * human's correcting one it got wrong; `shadow_lift` is the operator
 * opening one company's launch gate (ticket #132).
 *
 * NOT ALL OF THEM ARE CLASS-2 REP ACTS, and `entity_unmerge` is where that
 * stopped being true. A merge is machine-performed and evidence-free
 * (ADR-0003 as amended, ADR-0035), so its reversal has no rep act to bind
 * to — but it is still the aperture writing the Ledger, and ADR-0020 wants
 * caller, action, refs and outcome for exactly this: an act performed with
 * no user in the loop is the one a reader of the chain most needs to find.
 * `shadow_lift` is the same shape with an even shorter list of actors: no
 * rep, no model, one operator, once per company for the life of that
 * company (ADR-0016 as amended).
 *
 * Rename, merge and expungement are still deliberately absent rather than
 * reserved — a word in this set with no writer is a chain entry nobody can
 * produce.
 *
 * DERIVED FROM THE CHAIN'S OWN SET rather than restated (ticket #78). The
 * aperture's words are a SUBSET of `AuditAction` — `question_answer` and
 * `customer_send` are chained by the twin runtime, not here — and `Extract`
 * is what makes that provable: a word the aperture claims and the chain
 * does not declare fails to typecheck here, and a word dropped from
 * `AUDIT_ACTIONS` takes its aperture callers down with it.
 */
export type ApertureAction = Extract<
  AuditAction,
  | "entity_create"
  | "entity_kind"
  | "fact_retraction"
  | "entity_merge"
  | "entity_unmerge"
  | "shadow_lift"
>;

/**
 * What appending needs, and deliberately nothing more (ticket #62).
 *
 * The chain key and a client. NOT a `RepActContext`: an unmerge is not a
 * rep act and holds no twin DEK — the merge module may not open an
 * envelope to decide what two of the company's records mean (ADR-0004) —
 * and demanding a key it has no business with to write one chain entry
 * would be the wrong pressure entirely. A `RepActContext` satisfies this,
 * so every existing caller passes one unchanged, and the property that
 * matters is untouched: a path that chains asks for the HMAC key IN ITS
 * SIGNATURE, and a path that does not cannot chain by accident.
 */
export type ChainingContext = Pick<RepActContext, "db" | "hmacKey">;

/**
 * Appends one aperture act to the chain.
 *
 * MUST be called inside the same transaction as the act it records — which
 * is what `withApertureUnit` gives it, in both of that unit's shapes. The
 * append refuses outright outside a transaction (the store's own contract),
 * so "the crossing and its audit link commit together or not at all" is
 * enforced rather than intended.
 */
export async function chainApertureAct(
  ctx: ChainingContext,
  entry: {
    readonly action: ApertureAction;
    readonly ref: string;
    readonly outcome: string;
  },
): Promise<void> {
  await appendAuditEntry(ctx.db, ctx.hmacKey, {
    caller: APERTURE_CALLER,
    action: entry.action,
    ref: entry.ref,
    outcome: entry.outcome,
  });
}

/**
 * The `ref` for an act, as opaque ids: the twin, the subject, and the rep
 * act that authorized it. Built here so both acts read the same way down a
 * printed chain.
 *
 * THE LAST TOKEN NAMES THE SURFACE, AND IT HAS TO (tickets #224 and #261). A
 * rep act arrives from the twin thread, from a button on the dashboard or from
 * the dashboard's door, and the id that authorized it lives in a different
 * table in each case — `event:<seam row>`, `act:<dashboard act>` or
 * `message:<door message>`. Rendering them alike would put a uuid where a
 * reader expects a bigint and send them to a store that has no such row, which
 * on an append-only chain is a wrong reference that can never be corrected
 * (ADR-0020).
 */
export function apertureRef(
  repAct: VerifiedRepAct,
  subject: Readonly<Record<string, string>>,
): string {
  const parts = [`twin:${repAct.twinId}`];
  for (const [label, value] of Object.entries(subject)) {
    parts.push(`${label}:${value}`);
  }
  parts.push(evidenceToken(repAct));
  return parts.join(" ");
}

/** Which id authorized the act, labelled by the store it dereferences in. */
function evidenceToken(repAct: VerifiedRepAct): string {
  switch (repAct.surface) {
    case "twin_thread":
      return `event:${repAct.sourceEventId}`;
    case "dashboard":
      return `act:${repAct.dashboardActId}`;
    case "dashboard_message":
      return `message:${repAct.dashboardMessageId}`;
  }
}

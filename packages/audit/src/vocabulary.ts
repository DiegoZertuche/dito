/**
 * THE AUDIT VOCABULARY: the closed set of action words (ticket #78).
 *
 * `ApertureAction` was documented as a closed set and three call sites
 * bypassed it — `consumer.ts` twice (`fact_retraction`, and
 * `question_answer`, which was not in that type at all) and
 * `send-lock/writer.ts` once (`customer_send`). A closed set nobody has to
 * pass through is a comment.
 *
 * So the words live HERE, at the chain itself, and `AuditEntry.action` is
 * typed by them: every writer goes through `appendAuditEntry`, so an
 * unlisted word does not typecheck at ANY call site, including the three
 * that used to bypass. Adding one is a deliberate edit to this file.
 *
 * The chain is read by a human when trust is questioned, and a free-text
 * action is a chain nobody can scan (the reasoning ADR-0020 and
 * `packages/aperture/src/audit.ts` already give).
 *
 * WHICH ACTS OWE AN ENTRY UNDER EACH WORD is the other half of the claim,
 * and it lives in `@dito/aperture`'s `audit-coverage.ts` rather than here:
 * the enumeration joins `ledger.*` rows, and ADR-0003 puts every statement
 * naming a Ledger object inside the single writer's own package (enforced
 * by `sole-writer.test.ts`, which is what moved it). The two halves are
 * bound by `AuditAction`: a class there must name a word from here.
 */

export const AUDIT_ACTIONS = [
  /** The rep confirmed a chat↔entity binding; the aperture filed the entity. */
  "entity_create",
  /**
   * The model determined an entity's `kind` (ticket #60), or a human
   * overruled it. Class-1 model output, and chained anyway: unlike a
   * candidate fact it is never disclosed, it GATES MERGE ELIGIBILITY
   * (ADR-0035's phone rung fires only when kinds match), and nothing else
   * records who determined it or when. A wrong one silently blocks or
   * permits a merge, and this is the only place that question can be
   * answered later.
   */
  "entity_kind",
  /** The rep's «N no» on the daily disclosure — performed or refused. */
  "fact_retraction",
  /** The rep answered an aperture question — affirmed, declined or refused. */
  "question_answer",
  /**
   * The system merged two of a company's records into one (ADR-0035).
   * THE ACT THAT ASKED NOBODY: the matcher performs it with no user in the
   * loop, so the edge records the outcome and nothing anywhere records that
   * a decision was made without a human. Chained for #62's own stated
   * reason for chaining the reversal — "an act performed with no user in
   * the loop is the one a reader of the chain most needs to find" — which
   * applies harder to the merge than to taking it back.
   */
  "entity_merge",
  /** An operator took a merge back (ticket #62). */
  "entity_unmerge",
  /**
   * The launch gate opened for one company: its Ledger's existing entity
   * and fact rows stopped being shadow, and everything filed for it
   * afterwards lands visible (ADR-0016 as amended; ticket #132).
   *
   * ONE ACT PER COMPANY, EVER, which is why it carries a word of its own
   * rather than riding on somebody else's. Nobody is in the loop on the
   * owner's side and there is no rep act underneath it — the operator runs
   * it by hand, as they run the unmerge — and it is the single switch that
   * decides whether an owner can read anything at all. "When did this
   * company's Ledger become readable, and how much of it" is answerable
   * from the chain and nowhere else: the registry keeps the instant and
   * nothing anywhere keeps the counts.
   */
  "shadow_lift",
  /** The send-lock writer refused a customer send (ticket #24). */
  "customer_send",
  /**
   * An execution ran (ticket #130; ADR-0014 as amended; spec #126 decision
   * 5(f)). One content-free entry per execution, whatever its disposition —
   * `answered`, `wall-refused`, `schema-miss`, `no-action` or `failed` —
   * carrying the trigger's opaque ids and the instructions digest, and
   * nothing the owner asked or the twin said.
   *
   * IT WAITED FOR ITS FIRST WRITER, which is this vocabulary's own standing
   * rule: a word here with no `MUST_CHAIN` class turns the coverage
   * enumeration's completeness test red, and such a class needs a relation
   * to join acts against. #128 built the runtime and deliberately left the
   * word out; #130 built `owner.executions` and adds the word and its class
   * together.
   */
  "execution",
  /**
   * The rep scoped a chat in or out (ticket #222; spec #214 decision 7).
   *
   * ADR-0003 CLASS 2 IS WHAT PUTS IT HERE. Scoping is the rep saying what the
   * twin may read — the act every other rep act rests on, since a fact can
   * only be filed from a conversation the rep admitted — and it is reversible
   * by the same rep in one tap.
   *
   * AND THE CHAIN IS THE ONLY TRACE IT WOULD LEAVE, which is Diego's rule of
   * 2026-08-31 applied rather than reached for. `scope_allowlist` is CURRENT
   * state and keeps no history of its own, so a chat scoped in and back out
   * leaves that store looking exactly as it did before: "what did the rep let
   * the twin read, and when" is answerable here and, after the row is gone,
   * nowhere else. The scope-IN is chained beside it because a direction with
   * an entry and a direction without one would make the pair unreadable.
   */
  "scope_change",
] as const;

/** One of the closed action words. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Whether a word read back out of the store is one this build knows. */
export function isAuditAction(word: string): word is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(word);
}


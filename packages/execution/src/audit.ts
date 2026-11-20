/**
 * One content-free audit entry per execution (ADR-0020; spec #126 decision
 * 5(f); user story 37 — "one content-free audit-chain entry per execution
 * and per lift act, so that ADR-0020 covers the owner side from its first
 * day").
 *
 * THE CHAIN IS INJECTED, NOT HELD. `@dito/audit`'s only writer takes a `pg`
 * client, and this package holds no database connection — so what lives
 * here is the interface the owning app implements over its own transaction,
 * and the entry type is `@dito/audit`'s, imported `import type` and
 * therefore erased under `verbatimModuleSyntax`.
 *
 * PRECISELY WHAT THAT MEANS, since it is easy to overclaim: no VALUE of
 * `@dito/audit` reaches the emitted JavaScript, so nothing here can pull in
 * `pg`. The emitted `.d.ts` still NAMES the type — declarations must — so a
 * consumer of these types resolves `@dito/audit` itself. Both consumers do:
 * a package that implements this interface writes through
 * `appendAuditEntry`, and cannot not depend on it.
 */
import type { AuditAction, AuditEntry } from "@dito/audit";
import type { Disposition } from "./record.js";
import { triggerRef, type Trigger } from "./trigger.js";

/**
 * The caller identity on every entry this package writes (ADR-0020: "caller
 * identity + action type + opaque refs + outcome per entry"). The aperture
 * writes `aperture`; the execution runtime writes this, and an entry under
 * this action naming any other caller is itself the finding.
 */
export const EXECUTION_CALLER = "execution";

/**
 * The action word for "an execution ran".
 *
 * THE #128 TODO IS CLOSED (ticket #130). The word is now in `AUDIT_ACTIONS`
 * and its class is in `MUST_CHAIN`, over `owner.executions` — the first real
 * writer, which is what the vocabulary's own rule was waiting for. So the
 * local widening this type used to carry is gone: `ExecutionAuditEntry` is
 * `AuditEntry`, and the two ways this constant could drift from the closed
 * set are both closed by the `satisfies` below.
 *
 * `satisfies` RATHER THAN AN IMPORTED VALUE, deliberately, and it is the
 * whole reason this constant still exists here. `AuditAction` is a TYPE, so
 * `import type` erases it and this file emits the string and nothing else —
 * which is what keeps the module header's claim true: no VALUE of
 * `@dito/audit` reaches the emitted JavaScript, so this package cannot pull
 * in `pg` (`@dito/audit`'s index imports it, and `dependency-wall.test.ts`
 * refuses that here). Importing `AUDIT_ACTIONS` as a value to index into
 * would give the same word and break that, for nothing: the annotation
 * already makes a word outside the closed set a compile error.
 */
export const EXECUTION_AUDIT_ACTION = "execution" satisfies AuditAction;

/**
 * A content-free entry as this package writes one: `@dito/audit`'s four
 * fields, exactly.
 *
 * An alias rather than a retype, so the day ADR-0020's four fields change
 * this stops compiling instead of drifting. It was a widened union until
 * #130 put `execution` in the vocabulary; the name stays because it is what
 * `ExecutionAuditChain` is declared over and what the owning app implements.
 */
export type ExecutionAuditEntry = AuditEntry;

/**
 * Where an execution's entry goes. Implemented by the owning app over its
 * own `pg` client and HMAC key — `appendAuditEntry(db, hmacKey, entry)` —
 * inside the transaction that persists the record.
 */
export interface ExecutionAuditChain {
  append(entry: ExecutionAuditEntry): Promise<void>;
}

/**
 * The one entry an execution owes.
 *
 * `ref` CARRIES THE INSTRUCTIONS DIGEST as well as the trigger's ids, and
 * that is the point of putting it here rather than only in the record: the
 * record is a row in the owning app's own table and can be edited; the
 * chain cannot. "Which instructions produced this refusal" is answerable
 * later only if the stamp is somewhere append-only.
 *
 * `outcome` is the disposition and nothing else — five words, one of which
 * is `failed`. The question, the answer, the rows the tools served and the
 * prose the twin composed are the owning app's rows; not one of them is
 * reachable from here.
 */
export function executionAuditEntry(
  trigger: Trigger,
  instructionsDigest: string,
  disposition: Disposition,
): ExecutionAuditEntry {
  return {
    caller: EXECUTION_CALLER,
    action: EXECUTION_AUDIT_ACTION,
    ref: `${triggerRef(trigger)} instructions:${instructionsDigest}`,
    outcome: disposition,
  };
}

/**
 * The execution's audit entry, checked against `@dito/audit`'s own
 * vocabulary (ticket #128 AC 6: "Exactly one audit entry per execution,
 * content-free, verified through the audit vocabulary").
 *
 * VERIFIED AT THE TYPE LEVEL, and that is the whole verification available
 * today rather than a shortcut taken. `@dito/audit` is a value this package
 * may not hold — it depends on `pg` — so nothing here can call
 * `isAuditAction` or `appendAuditEntry`. What the types still prove is
 * everything the vocabulary declares that does not need a running value:
 * the four content-free fields, exactly, and the action union the widening
 * in `audit.ts` is measured against. `pnpm typecheck` is what runs it.
 *
 * The remaining half — that `execution` is one of `AUDIT_ACTIONS` — is
 * unprovable until the word is in the fence, which is #130's to do (see
 * `EXECUTION_AUDIT_ACTION`). The alias below is what will collapse the day
 * it happens.
 */
import type { AuditAction, AuditEntry } from "@dito/audit";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_AUDIT_ACTION,
  EXECUTION_CALLER,
  executionAuditEntry,
  type ExecutionAuditEntry,
} from "./audit.js";
import { DISPOSITIONS } from "./record.js";
import type { Trigger } from "./trigger.js";

const TRIGGER: Trigger = {
  kind: "owner_question",
  mechanism: "request",
  companyId: "11111111-1111-4111-8111-111111111111",
  ownerQuestionId: "22222222-2222-4222-8222-222222222222",
};

const DIGEST = "0123456789abcdef0123456789abcdef";

describe("the entry is @dito/audit's own shape (ADR-0020)", () => {
  it("carries the four content-free fields the chain declares, and no fifth", () => {
    const entry = executionAuditEntry(TRIGGER, DIGEST, "answered");

    // THE CHECK THAT IS NOT A STRING LITERAL: assignable to the chain's own
    // entry type minus the one field this build widens. A field added,
    // renamed or dropped in `@dito/audit` stops this compiling, which a
    // hand-written list of four names never would.
    const asChainEntry: Omit<AuditEntry, "action"> = entry;
    expect(asChainEntry.caller).toBe(EXECUTION_CALLER);
    expect(asChainEntry.outcome).toBe("answered");
    expect(asChainEntry.ref).toContain(TRIGGER.ownerQuestionId);

    expect(Object.keys(entry).sort()).toEqual([
      "action",
      "caller",
      "outcome",
      "ref",
    ]);
  });

  it("types its action against the vocabulary, widened by exactly one word", () => {
    const entry = executionAuditEntry(TRIGGER, DIGEST, "failed");
    // The widening, written out: the day #130 puts the word in
    // `AUDIT_ACTIONS`, the right-hand side becomes redundant and this line
    // narrows to `AuditAction` on its own.
    const action: AuditAction | typeof EXECUTION_AUDIT_ACTION = entry.action;
    expect(action).toBe("execution");
  });

  it("says only which execution and how it ended", () => {
    // Content-free means the ref is ids and the outcome is one of the five
    // words. Nothing an owner asked, nothing a twin composed, nothing a
    // tool served.
    const entry = executionAuditEntry(TRIGGER, DIGEST, "wall-refused");
    expect(entry.ref).toBe(
      `trigger:owner_question mechanism:request company:${TRIGGER.companyId} owner_question:${TRIGGER.ownerQuestionId} instructions:${DIGEST}`,
    );
    expect([...DISPOSITIONS]).toContain(entry.outcome);
  });

  it("stamps every disposition, so a failure is as visible as an answer", () => {
    for (const disposition of DISPOSITIONS) {
      const entry: ExecutionAuditEntry = executionAuditEntry(
        TRIGGER,
        DIGEST,
        disposition,
      );
      expect(entry.outcome).toBe(disposition);
      expect(entry.caller).toBe(EXECUTION_CALLER);
    }
  });
});

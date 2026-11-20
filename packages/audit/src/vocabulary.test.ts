/**
 * The vocabulary fence and the enumeration behind it (ticket #78).
 *
 * `ApertureAction` was documented as a closed set and three call sites
 * bypassed it, so "closed" was a comment. These tests are about what makes
 * it a fence instead: an unlisted word does not typecheck at the one door
 * every writer goes through, and a word read back out of the store is
 * recognisable as declared or not.
 *
 * The other half of the claim — that every declared word has an act class
 * saying which acts owe an entry under it, each citing an ADR or a spec
 * line — is asserted in `@dito/aperture`'s `audit-coverage.test.ts`, where
 * the enumeration lives (ADR-0003 keeps `ledger.*` inside the writer's own
 * package).
 */
import { describe, expect, it } from "vitest";
import { appendEntry } from "./chain.js";
import { AUDIT_ACTIONS, isAuditAction } from "./vocabulary.js";

const HMAC_KEY = new TextEncoder().encode(
  "dito-test-audit-hmac-key-32-bytes-plus",
);

describe("the fence: an unlisted action word", () => {
  it("does not typecheck at the chain's own door", () => {
    // THE FENCE ITSELF, and `pnpm typecheck` is what runs it:
    // `@ts-expect-error` fails the build if the error ever stops firing, so
    // this is red both when a rogue word starts typechecking and when
    // somebody quietly adds one to `AUDIT_ACTIONS` to make it compile.
    //
    // Stated at `appendEntry` rather than at a bare object literal because
    // that is the real door — every writer in the repo reaches the chain
    // through this signature or through `appendAuditEntry`, which takes the
    // same type.
    const chained = appendEntry(HMAC_KEY, null, {
      caller: "some_new_writer",
      // @ts-expect-error — "expungement" is not in AUDIT_ACTIONS (ticket #78)
      action: "expungement",
      ref: "entity:11111111-1111-4111-8111-111111111111",
      outcome: "done",
    });
    // The fence is a TYPE, not a runtime refusal — the value still hashes,
    // and saying so is part of the record. What stops a rogue word reaching
    // the store is the line above; what catches one already there (a `.mjs`
    // script, a psql session, an older build) is the coverage check's own
    // vocabulary sweep.
    expect(chained.entryHash).toHaveLength(32);
  });

  it("is recognisable at runtime, for words read back out of the store", () => {
    for (const word of AUDIT_ACTIONS) expect(isAuditAction(word)).toBe(true);
    expect(isAuditAction("send_refused_pacing")).toBe(false);
    expect(isAuditAction("")).toBe(false);
  });
});

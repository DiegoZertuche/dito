/**
 * The enumeration behind the coverage check (ticket #78; ADR-0020; spec
 * #48 decision 18).
 *
 * These assert the properties that keep the list honest rather than any
 * behaviour: that every declared action word has a class saying which acts
 * owe an entry under it, and that every class in all three lists cites a
 * sentence somebody wrote down — because a must-chain list derived from the
 * writers could never disagree with them.
 *
 * What the check DOES over rows is asserted in `invariants.int.test.ts`
 * beside the crossing's other CI invariants, and over acts the product
 * really performed in `packages/twin-runtime/src/audit-coverage.int.test.ts`.
 */
import { AUDIT_ACTIONS } from "@dito/audit";
import { describe, expect, it } from "vitest";
import {
  MUST_CHAIN,
  MUST_NOT_CHAIN,
  SEAM_DISPOSITIONS,
  UNDECIDED,
} from "./audit-coverage.js";

describe("the enumeration (ADR-0020, spec #48 decision 18)", () => {
  it("says, for every word in the vocabulary, which acts owe an entry under it", () => {
    // A word with no class behind it is a chain entry nobody can account
    // for: the reader sees the action and nothing states what should have
    // produced it.
    const claimed = new Set(MUST_CHAIN.map((cls) => cls.action));
    expect([...AUDIT_ACTIONS].filter((word) => !claimed.has(word))).toEqual([]);
  });

  it("cites an accepted ADR or spec line against every decided entry", () => {
    // THE PROPERTY THIS WHOLE TICKET RESTS ON. A must-chain list derived
    // from the writers can never disagree with the writers; the citation is
    // what makes it an independent statement of intent. An entry that
    // cannot name a sentence belongs in UNDECIDED, not in either set.
    //
    // WHAT COUNTS: an ADR, or a spec issue, or a closed ticket's acceptance
    // criteria — all of them sentences accepted BEFORE this build. What
    // does not count is #78 itself: a class whose only warrant is something
    // written while implementing it is exactly the self-referential case
    // the enumeration exists to avoid, so the lookahead excludes this
    // ticket's own number and nothing else.
    const accepted = /ADR-\d{4}|(?:spec|ticket) #(?!78\b)\d+/i;
    for (const cls of MUST_CHAIN) {
      expect(cls.source, `MUST_CHAIN ${cls.id}`).toMatch(accepted);
    }
    for (const cls of MUST_NOT_CHAIN) {
      expect(cls.source, `MUST_NOT_CHAIN ${cls.id}`).toMatch(accepted);
    }
    // UNDECIDED is the one list that may rest on anything, because it holds
    // what the check does NOT verify — but it must still name what pulls in
    // each direction, and say in one line where the question stands, since
    // that line is what every run prints.
    for (const open of UNDECIDED) {
      expect(open.tension.length, `UNDECIDED ${open.id}`).toBeGreaterThan(80);
      expect(open.settles.length, `UNDECIDED ${open.id}`).toBeGreaterThan(40);
      expect(open.standing.length, `UNDECIDED ${open.id}`).toBeGreaterThan(40);
    }
  });

  it("does not park a ruled act in the open list — it enforces it", () => {
    // THE LINE THE REPORT PRINTS IS THE CLAIM. `entity_merge` was ruled
    // MUST CHAIN on 2026-08-31 and sat in UNDECIDED while the merge path
    // chained nothing: a run then printed "an act this enumeration does not
    // check" over an act somebody HAD ruled on. `fileMerge` chains now, so
    // the class is CHECKED rather than declared, and the honest place for a
    // ruled-and-obeyed act is the list a green actually covers.
    expect(UNDECIDED.map((o) => o.id)).not.toContain("entity_merge");
    const merge = MUST_CHAIN.find((c) => c.id === "entity_merge_performed");
    expect(merge, "the merge must be a checked class").toBeDefined();
    // Checked means JOINED. A must-chain class that cannot be joined is a
    // declaration wearing a check's clothes, which is the failure this
    // whole ticket exists to refuse.
    expect(merge!.join.kind).toBe("per_act");
    expect(merge!.action).toBe("entity_merge");
  });

  it("never puts one act in both a decided list and the open one", () => {
    // Undecided and must-not-chain are incompatible claims: one says a
    // sentence settles it, the other says none does. `merge` was in both
    // until this test existed.
    const decided = new Set([
      ...MUST_CHAIN.map((c) => c.what),
      ...MUST_NOT_CHAIN.map((c) => c.what),
    ]);
    for (const open of UNDECIDED) {
      expect(decided.has(open.what), `UNDECIDED ${open.id}`).toBe(false);
    }
    // ...and the merge, specifically: named here because it is the case
    // that got it wrong twice — first filed in two lists at once, then left
    // in the open one after it had been ruled on. It is now in exactly one.
    expect(MUST_NOT_CHAIN.map((c) => c.id)).not.toContain("merge");
    expect(MUST_CHAIN.map((c) => c.id)).toContain("entity_merge_performed");
    expect(UNDECIDED).toHaveLength(0);
  });

  it("watches executions on both sides of the wall, with two classes that partition the word (#172)", () => {
    // TWO CLASSES ON ONE ACTION WORD, the `fact_retraction` pair's shape.
    // The owner's executions live in `owner.executions` behind row-level
    // security and the rep's in `public.executions`; one class cannot join
    // both, and `--require-acts` takes a class id — so a CI step that exists
    // to make the rep side non-vacuous has to be able to name it.
    const owner = MUST_CHAIN.find((c) => c.id === "execution");
    const rep = MUST_CHAIN.find((c) => c.id === "rep_execution");
    expect(owner, "the owner side's class").toBeDefined();
    expect(rep, "the rep side's class").toBeDefined();
    expect(rep!.action).toBe("execution");
    expect(rep!.callers).toEqual(["execution"]);
    // THE PREDICATES ARE DISJOINT AND TOTAL over the word's entries, which
    // is what makes each class's entry TALLY a statement about its own side
    // rather than about the whole chain. The owner's occasion is the one
    // token an owner-side reference always carries and a rep-side one never
    // can (`triggerRef`).
    expect(owner!.entryPredicate).toContain("owner_question:");
    expect(rep!.entryPredicate).toContain("owner_question:");
    expect(rep!.entryPredicate).toContain("NOT LIKE");
  });

  it("joins the rep side by count, because no token in the reference names one run (#172)", () => {
    // WHY NOT `per_act`. A reference names the TRIGGER, and one trigger can
    // run twice: a kind classification the model refuses is asked again from
    // the uncrossed binding at the next start, and its reference renders from
    // the twin, the chat and the entity, so the second run's is identical to
    // the first's (`crossPendingBindings`; ticket #240 closed the drafting
    // case #172 AC 8 named, and left this one standing). So two records can
    // share one trigger, and a per-act join on any token of that reference
    // would let one entry satisfy both. The owner side's answer, a UNIQUE on
    // the occasion's own id, is not available where asking again is the
    // design.
    const rep = MUST_CHAIN.find((c) => c.id === "rep_execution")!;
    expect(rep.join.kind).toBe("count");
    if (rep.join.kind === "count") {
      expect(rep.join.relation).toBe("public.executions");
    }
    // ...and it reads the REP chain only. There is no writer that can put a
    // rep-side execution entry anywhere else, and a widened join is how a
    // missing entry hides.
    expect(rep.chains).toEqual(["public.audit_chain"]);
  });

  it("keeps every class id distinct, so a report can name one", () => {
    const ids = [
      ...MUST_CHAIN.map((c) => c.id),
      ...MUST_NOT_CHAIN.map((c) => c.id),
      ...UNDECIDED.map((c) => c.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("says why, for every class no join can reach", () => {
    for (const cls of MUST_CHAIN) {
      if (cls.join.kind !== "unjoinable") continue;
      // An unjoinable class is the one place a green says nothing. It is
      // only honest if the run prints WHY, so the reason is required.
      expect(cls.join.why.length, `MUST_CHAIN ${cls.id}`).toBeGreaterThan(40);
    }
  });
});

describe("the vocabulary the enumeration does NOT own", () => {
  it("declares a verdict for every seam disposition, and invents none", () => {
    // THE CIRCULARITY THIS BREAKS (Codex r3). "Every action word has a
    // must-chain class" proves nothing about an act whose writer forgot to
    // chain: that act introduces no action word, so it is missing from both
    // sides and the test is green — the exact failure #78 exists to detect.
    //
    // The disposition set is not this module's to define. It lives in a
    // CHECK constraint in `db/migrations` and grows whenever a new kind of
    // processed rep message ships. The integration test reads it out of the
    // live schema; this one holds the shape.
    for (const [disposition, entry] of Object.entries(SEAM_DISPOSITIONS)) {
      expect(entry.why.length, disposition).toBeGreaterThan(30);
      if (entry.verdict !== "must_chain") {
        expect(entry.joinedBy, disposition).toBeUndefined();
        continue;
      }
      // A must-chain disposition must name the class that actually watches
      // it — otherwise "must chain" is an opinion with no check behind it.
      expect(
        MUST_CHAIN.map((c) => c.id),
        `${disposition} names a class that exists`,
      ).toContain(entry.joinedBy);
    }
  });

  it("points every undecided disposition at an entry in UNDECIDED", () => {
    // A disposition marked undecided with nothing in UNDECIDED to read is
    // a shrug. Each one must be somebody's open question.
    //
    // Vacuous since the rulings of 2026-08-31 emptied `undecided` of
    // dispositions, and kept for the same reason UNDECIDED itself is kept:
    // the next disposition that ships without a verdict has to land
    // somewhere a reader can follow.
    const open = UNDECIDED.map((o) => o.id).join(" ");
    for (const [disposition, entry] of Object.entries(SEAM_DISPOSITIONS)) {
      if (entry.verdict !== "undecided") continue;
      expect(
        UNDECIDED.some((o) => entry.why.includes(o.id)) ||
          entry.why.includes("UNDECIDED"),
        `${disposition} should name one of: ${open}`,
      ).toBe(true);
    }
  });

  it("points every deliberately-unchained disposition at an entry in MUST_NOT_CHAIN", () => {
    // The mirror of the two rules above, and the one the 2026-08-31 rulings
    // made load-bearing: a disposition that says "this rep act owes the
    // chain nothing" is an opinion until it names the class that counts it,
    // and the count is what turns a green into a readable statement.
    const excluded = MUST_NOT_CHAIN.map((c) => c.id).join(" ");
    for (const [disposition, entry] of Object.entries(SEAM_DISPOSITIONS)) {
      if (entry.verdict !== "must_not_chain") continue;
      expect(
        MUST_NOT_CHAIN.some((c) => entry.why.includes(c.id)),
        `${disposition} should name one of: ${excluded}`,
      ).toBe(true);
    }
  });
});

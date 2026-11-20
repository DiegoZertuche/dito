/**
 * The record, its closed disposition set, and the store contract (spec
 * #126's testing decision: "the disposition set is closed; the store
 * interface round-trips a record").
 */
import { describe, expect, it } from "vitest";
import {
  DISPOSITIONS,
  isDisposition,
  type Disposition,
  type ExecutionRecord,
  type ExecutionStore,
  type ReadDisposition,
} from "./record.js";
import { triggerRef, type Trigger } from "./trigger.js";

const TRIGGER: Trigger = {
  kind: "owner_question",
  mechanism: "request",
  companyId: "11111111-1111-4111-8111-111111111111",
  ownerQuestionId: "22222222-2222-4222-8222-222222222222",
};

const RECORD: ExecutionRecord = {
  trigger: TRIGGER,
  instructionsDigest: "0123456789abcdef0123456789abcdef",
  toolNames: ["read_timeline", "count_facts", "submit_answer"],
  startedAt: new Date("2026-09-02T15:04:05.000Z"),
  endedAt: new Date("2026-09-02T15:04:13.900Z"),
  iterations: 4,
  tokens: { input: 4210, output: 318 },
  disposition: "answered",
  lane: "realtime",
};

describe("the disposition set is closed (ticket #128; spec #171 decision 11)", () => {
  it("is the twelve words the spec names, in its order", () => {
    // The literal list, not one recomputed from the type: a set asserted
    // against itself would pass however it drifted. Three joined at #178
    // (spec #171 decision 11) and nothing assigned them yet — the rep side
    // does, in #172; extraction's two joined at #194, the disclosure's one at
    // #198 (spec #193 decisions 19 and 24) and the nudge's at #268 (spec #258
    // decision 7) and the ask's (spec #318 decision 23).
    expect([...DISPOSITIONS]).toEqual([
      "answered",
      "wall-refused",
      "schema-miss",
      "no-action",
      "failed",
      "drafted",
      "acted",
      "classified",
      "filed",
      "nothing-to-file",
      "posted",
      "asked",
    ]);
  });

  it("recognises a word read back out of a store, and refuses one it does not declare", () => {
    for (const word of DISPOSITIONS) expect(isDisposition(word)).toBe(true);
    // The seam has a `disposition` column of its own on
    // `wa_event_processing` with entirely unrelated values (ticket #128
    // fact 7). A word from there must not read as one of these.
    expect(isDisposition("binding_confirmed")).toBe(false);
    expect(isDisposition("")).toBe(false);
  });

  it("keeps `failed` out of what an owning app may assign", () => {
    // `failed` is the runner's alone: a definition reads every other word off
    // what its turn did, and this is the type that says so.
    const read: ReadDisposition = "wall-refused";
    expect(read).toBe("wall-refused");
    // @ts-expect-error — only the runner assigns `failed` (ticket #128)
    const forged: ReadDisposition = "failed";
    expect<Disposition>(forged).toBe("failed");
  });
});

describe("the store interface (defined here, implemented by the owning app)", () => {
  it("round-trips one record unchanged", async () => {
    // The whole contract: what the runner produced is what the app is
    // handed. Written against a store this test implements, because the
    // package deliberately implements none — #130's is the first.
    const kept: ExecutionRecord[] = [];
    const store: ExecutionStore = {
      recordExecution: (record) => {
        kept.push(record);
        return Promise.resolve();
      },
    };

    await store.recordExecution(RECORD);

    expect(kept).toEqual([RECORD]);
    expect(kept[0]?.disposition).toBe("answered");
    expect(kept[0]?.tokens).toEqual({ input: 4210, output: 318 });
    expect(kept[0]?.toolNames).toEqual([
      "read_timeline",
      "count_facts",
      "submit_answer",
    ]);
    // THE LANE IS ON THE RECORD (spec #171 decision 3; ticket #178 AC 4).
    // Content-free like everything else here, and the one field that says
    // how the runtime scheduled this run rather than what it did.
    expect(kept[0]?.lane).toBe("realtime");
  });
});

describe("the trigger creates the execution (ADR-0014 as amended)", () => {
  it("references the origin by its ids and its kind, and carries no content", () => {
    expect(triggerRef(TRIGGER)).toBe(
      "trigger:owner_question mechanism:request company:11111111-1111-4111-8111-111111111111 owner_question:22222222-2222-4222-8222-222222222222",
    );
  });
});

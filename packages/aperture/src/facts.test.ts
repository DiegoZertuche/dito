/**
 * THE GATE'S VERDICT, AS A UNIT (ticket #218; spec #214 decision 1;
 * ADR-0003 as amended, ADR-0039).
 *
 * One function decides whether a candidate may cross, and BOTH of its answers
 * are the same ending: nothing is recorded, and the value says which test
 * stopped it. That is the whole of "below the gate, drop" (ticket #218) — the
 * twin does not ask the rep to settle its own uncertainty, so a
 * below-threshold candidate goes exactly where an unresolved reference
 * goes.
 *
 * A UNIT RATHER THAN A SEAM TEST, and the only one this ticket adds: the
 * verdict is a pure function of two model-supplied values, and the seam
 * suites pin what the FILING does with it (`facts.int.test.ts`,
 * `extraction.int.test.ts`). The exported function is also what the eval's
 * *dropped below gate* row classifies by, so there is one gate rather than a
 * second copy in `@dito/evals`.
 */
import { describe, expect, it } from "vitest";
import {
  EXTRACTION_CONFIDENCE_THRESHOLD,
  gateVerdict,
} from "./facts.js";

describe("the aperture's confidence gate (#218)", () => {
  it("drops a stated candidate below the threshold", () => {
    const stopped = gateVerdict("stated", 0.79);
    expect(stopped?.outcome).toBe("below_threshold");
    // The sentence a reader of a run row is sent to. It says DROPPED, and
    // that is the ticket: nothing is recorded and nobody is asked.
    expect(stopped?.reason).toContain("dropped");
  });

  it("drops a resolved reference below the threshold, on the same test", () => {
    // The reading that #196 made producible and ADR-0039's 2026-09-06
    // amendment routed to a question. Under the question principle it is not
    // a reason to ask either: a resolution the model was unsure of is a
    // record the twin was unsure of, and the rep is not the twin's proofreader.
    expect(gateVerdict("resolved_reference", 0.79)?.outcome).toBe(
      "below_threshold",
    );
  });

  it("lets a candidate exactly at the threshold cross", () => {
    // `confidence < threshold`, so 0.80 is above the gate and files as it
    // always has. The literal is the one the boundary is written from, not a
    // recomputation of it (the threshold is 0.8).
    expect(EXTRACTION_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(gateVerdict("stated", 0.8)).toBeUndefined();
    expect(gateVerdict("resolved_reference", 1)).toBeUndefined();
  });

  it("reads the REFERENCE first, so an unresolved one is dropped as that", () => {
    // Both tests apply to an unresolved reference at 0.4, and the order
    // decides only which reason the run's reader is given — the more
    // specific one. The two outcomes are counted apart on the run row, so
    // the order is what keeps those two counts meaning what they say.
    expect(gateVerdict("unresolved_reference", 0.4)?.outcome).toBe(
      "unresolved_reference",
    );
    expect(gateVerdict("unresolved_reference", 1)?.outcome).toBe(
      "unresolved_reference",
    );
  });
});

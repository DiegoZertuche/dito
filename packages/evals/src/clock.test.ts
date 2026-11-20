/**
 * The run's fixed clock, and the one boundary it must get right
 * (ticket #56; Codex round 2).
 *
 * `LAST_READABLE_MINUTE` is what `corpus.test.ts` holds every seed message
 * to, so an error here is silent in exactly the worst way: a message past
 * the window is seeded, never shown to the model, never scored, and still
 * counted in the corpus totals the report prints. The first cut of the
 * constant was off by one — it returned the window's own exclusive end.
 *
 * So the boundary is asserted against the SAME predicate extraction uses
 * (`occurred_at < window.end`), from the same imported lag, rather than
 * against a number typed here.
 */
import { SEAM_SETTLING_LAG_MS } from "@dito/twin-runtime";
import { describe, expect, it } from "vitest";
import {
  DAY_START_UTC,
  EVAL_NOW,
  EVAL_TIME_ZONE,
  LAST_READABLE_MINUTE,
} from "./clock.ts";

/** The instant a message at this minute of the eval day carries. */
function at(minute: number): Date {
  return new Date(DAY_START_UTC + minute * 60_000);
}

/** Extraction's own predicate: the window's end is EXCLUSIVE. */
const windowEnd = new Date(EVAL_NOW.getTime() - SEAM_SETTLING_LAG_MS);
const isRead = (minute: number): boolean =>
  at(minute).getTime() >= DAY_START_UTC && at(minute) < windowEnd;

describe("the advertised last readable minute is the last one actually read", () => {
  it("is read", () => {
    expect(isRead(LAST_READABLE_MINUTE)).toBe(true);
  });

  it("...and the next minute is not — the endpoint is exclusive", () => {
    expect(isRead(LAST_READABLE_MINUTE + 1)).toBe(false);
  });

  it("the day's first minute is read, so the window is not empty", () => {
    expect(isRead(0)).toBe(true);
    expect(LAST_READABLE_MINUTE).toBeGreaterThan(0);
  });

  it("moves with the runtime's lag rather than with a copy of it", () => {
    // The constant is derived, not typed: if the pass lengthens its
    // settling lag, the corpus guard tightens with it. Asserted as the
    // relationship rather than as today's 1288, so this test does not have
    // to be edited when that number legitimately changes.
    expect(at(LAST_READABLE_MINUTE + 1).getTime()).toBeGreaterThanOrEqual(
      EVAL_NOW.getTime() - SEAM_SETTLING_LAG_MS,
    );
  });

  it("the trigger is after the settle hour, so the pass would run at all", () => {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: EVAL_TIME_ZONE,
        hour: "numeric",
        hour12: false,
      }).format(EVAL_NOW),
    );
    // The disclosure hour the pass gates on (#51's default is 21).
    expect(hour).toBeGreaterThanOrEqual(21);
  });
});

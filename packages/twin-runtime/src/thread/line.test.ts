/**
 * THE LINE ON INICIO KEEPS THE ARRIVAL LINE'S FENCE (ticket #320; spec #258
 * decision 15).
 */
import { describe, expect, it } from "vitest";
import { LINE_MAX, lineViolations } from "./line.js";
import type { ServedAnswerState } from "./served.js";

/** What a turn was shown, as the fence reads it. */
function shown(grounds: readonly string[]): ServedAnswerState {
  return {
    hits: new Map(),
    unconfirmed: new Map(),
    customers: () => undefined,
    grounds,
  };
}

describe("a line nobody asked for", () => {
  const CANVAS = "2 cards wait on the rep's dashboard right now, oldest first:";

  it("takes one short line whose figures were shown", () => {
    expect(lineViolations("Buenos días: te esperan 2, empieza por [c1].", shown([CANVAS]))).toEqual([]);
  });

  it("refuses a line past its bound, a second line, a link and an invented figure", () => {
    expect(lineViolations("a".repeat(LINE_MAX + 1), shown([]))).toHaveLength(1);
    expect(lineViolations("Hola.\nAdiós.", shown([]))).toEqual([
      "your line is one line, with no line break",
    ]);
    expect(lineViolations("Mira dito.mx", shown([]))).toHaveLength(1);
    expect(lineViolations("Te esperan 57 cosas.", shown([CANVAS]))).toEqual([
      expect.stringContaining("the number 57"),
    ]);
    // A REFERENCE'S DIGITS ARE NOT A FIGURE THE LINE STATES (ticket #321).
    expect(lineViolations("Empieza por [c57].", shown([CANVAS]))).toEqual([]);
  });
});

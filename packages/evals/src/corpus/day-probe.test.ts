/**
 * THE DAY PROBE'S TALLY (ticket #148).
 *
 * The lane it serves needs a real model and cannot run in CI, so what is
 * pinned here is everything that does NOT: which field a fact's day lives
 * in, how one case's run is classified, how the counts add up, and the
 * decision rule the PR body quotes.
 *
 * The outcomes are LITERAL. Every expected value below is a date a human
 * wrote on a corpus label or a count anybody can do by hand — never
 * recomputed the way the code computes it, which would pass by
 * construction and could never disagree with the tally it is checking.
 */
import { describe, expect, it } from "vitest";
import { SEED_TRANSCRIPTS } from "./transcripts.ts";
import {
  classifyDayCase,
  DAY_PROBE_CASES,
  dayCaseKey,
  dayProbeExpectations,
  probeDate,
  probeHeld,
  tallyDayProbe,
  type ObservedDatedFact,
} from "./day-probe.ts";

const R3_03 = {
  transcriptId: "d-lunes-y-martes",
  messageId: "R3-03",
  factType: "OrderRequested",
};

function fact(date: string | null): ObservedDatedFact {
  return { ...R3_03, date };
}

describe("which field a fact's day lives in", () => {
  it("reads a promise's day out of dueOn and an order's out of requestedFor", () => {
    // The two names are the two CLAIMS (#70), and a probe that looked in
    // one field would read a laundered date as a missing one.
    expect(probeDate("DatePromised", { dueOn: "2026-09-07" })).toBe("2026-09-07");
    expect(
      probeDate("OrderRequested", { requestedFor: "2026-09-08" }),
    ).toBe("2026-09-08");
    expect(probeDate("OrderTaken", { requestedFor: "2026-08-31" })).toBe(
      "2026-08-31",
    );
  });

  it("reports no day rather than reaching into the other field for one", () => {
    expect(probeDate("DatePromised", { commitment: "que te los mando" })).toBeNull();
    // A promise whose day landed in the ORDER's field is not this promise's
    // day, and must not be read as one.
    expect(probeDate("DatePromised", { requestedFor: "2026-09-07" })).toBeNull();
    expect(probeDate("OrderRequested", { quantity: 30 })).toBeNull();
  });
});

describe("how one case's run is classified", () => {
  it("is right when the fact lands on the day the label states", () => {
    expect(classifyDayCase("2026-09-08", [fact("2026-09-08")])).toBe("right");
  });

  it("is wrong on any other day — a week out reads exactly like a day out", () => {
    // #102 filed «jueves 3 de septiembre» for this one, and #139's arms
    // answered 2 September. Both are simply wrong.
    expect(classifyDayCase("2026-09-08", [fact("2026-09-02")])).toBe("wrong");
    expect(classifyDayCase("2026-09-08", [fact("2026-09-15")])).toBe("wrong");
  });

  it("is undated when the fact crossed carrying no day at all", () => {
    expect(classifyDayCase("2026-09-06", [fact(null)])).toBe("undated");
  });

  it("is absent when the fact never crossed — not wrong, and not right", () => {
    // A recall wobble is not a date error, and #139's own tally counts
    // "right / times the fact crossed at all" for this reason.
    expect(classifyDayCase("2026-09-06", [])).toBe("absent");
  });

  it("needs EVERY dated fact on the day — one right and one wrong is wrong", () => {
    expect(
      classifyDayCase("2026-09-08", [fact("2026-09-08"), fact("2026-09-02")]),
    ).toBe("wrong");
  });

  it("lets an undated fact sit beside a dated one without spoiling it", () => {
    expect(
      classifyDayCase("2026-09-08", [fact("2026-09-08"), fact(null)]),
    ).toBe("right");
  });
});

describe("the tally over several runs", () => {
  const cases = [
    {
      transcriptId: "d-lunes-y-martes",
      messageId: "R3-03",
      factType: "OrderRequested" as const,
      exercises: "«el martes» on a Tuesday",
      undatedAllowed: false,
    },
    {
      transcriptId: "d-domingo-en-domingo",
      messageId: "H1-01",
      factType: "OrderRequested" as const,
      exercises: "«para el domingo» on a Sunday",
      undatedAllowed: true,
    },
  ];
  const expected = {
    "d-lunes-y-martes/R3-03/OrderRequested": "2026-09-08",
    "d-domingo-en-domingo/H1-01/OrderRequested": "2026-09-06",
  };
  const h1 = (date: string | null): ObservedDatedFact => ({
    transcriptId: "d-domingo-en-domingo",
    messageId: "H1-01",
    factType: "OrderRequested",
    date,
  });

  it("counts the four outcomes per case and keeps the dates it was answered with", () => {
    const table = tallyDayProbe(cases, expected, [
      [fact("2026-09-08"), h1(null)],
      [fact("2026-09-02"), h1("2026-09-06")],
      [h1(null)],
    ]);
    expect(table["d-lunes-y-martes/R3-03/OrderRequested"]).toEqual({
      right: 1,
      undated: 0,
      wrong: 1,
      absent: 1,
      answered: ["2026-09-08", "2026-09-02"],
    });
    expect(table["d-domingo-en-domingo/H1-01/OrderRequested"]).toEqual({
      right: 1,
      undated: 2,
      wrong: 0,
      absent: 0,
      answered: ["2026-09-06"],
    });
  });

  it("refuses a case it has no expected date for, rather than scoring it as absent", () => {
    expect(() => tallyDayProbe(cases, {}, [[]])).toThrow(/no expected date/u);
  });
});

describe("the decision rule an arm has to hold", () => {
  const cases = [
    {
      transcriptId: "t",
      messageId: "A",
      factType: "OrderRequested" as const,
      exercises: "a weekday case",
      undatedAllowed: false,
    },
    {
      transcriptId: "t",
      messageId: "B",
      factType: "OrderRequested" as const,
      exercises: "H1's own case",
      undatedAllowed: true,
    },
  ];
  const table = (
    a: { right: number; undated: number; wrong: number; absent: number },
    b: { right: number; undated: number; wrong: number; absent: number },
  ) => ({
    "t/A/OrderRequested": { ...a, answered: [] },
    "t/B/OrderRequested": { ...b, answered: [] },
  });

  it("holds when every weekday case is right in all three runs", () => {
    expect(
      probeHeld(
        cases,
        table(
          { right: 3, undated: 0, wrong: 0, absent: 0 },
          { right: 3, undated: 0, wrong: 0, absent: 0 },
        ),
        3,
      ),
    ).toBe(true);
  });

  it("allows undated only where the case allows it", () => {
    // H1 undated in all three is a pass; the same on a weekday case is not.
    expect(
      probeHeld(
        cases,
        table(
          { right: 3, undated: 0, wrong: 0, absent: 0 },
          { right: 0, undated: 3, wrong: 0, absent: 0 },
        ),
        3,
      ),
    ).toBe(true);
    expect(
      probeHeld(
        cases,
        table(
          { right: 0, undated: 3, wrong: 0, absent: 0 },
          { right: 3, undated: 0, wrong: 0, absent: 0 },
        ),
        3,
      ),
    ).toBe(false);
  });

  it("does not let an arm hold by saying nothing", () => {
    // An absent fact was never answered. Without this, an arm that stopped
    // filing the fact would score as though it had got the date right.
    expect(
      probeHeld(
        cases,
        table(
          { right: 2, undated: 0, wrong: 0, absent: 1 },
          { right: 3, undated: 0, wrong: 0, absent: 0 },
        ),
        3,
      ),
    ).toBe(false);
  });
});

describe("the cases are graded against the corpus, not against this file", () => {
  it("reads every expected date off the label that states it", () => {
    const expected = dayProbeExpectations(DAY_PROBE_CASES, SEED_TRANSCRIPTS);
    // The seven literals, as the labels in `transcripts.ts` state them.
    // «el lunes» said on Tuesday 1 September is the 7th; «el martes» said
    // on that Tuesday is the 8th; «el domingo» said on Sunday 30 August is
    // 6 September; «el lunes» said on that Sunday is 31 August.
    expect(expected).toEqual({
      "d-lunes-en-martes/R1-03/DatePromised": "2026-09-07",
      "d-pedido-para-el-lunes/R2-01/OrderRequested": "2026-09-07",
      "d-pedido-para-el-lunes/R2-02/DatePromised": "2026-09-07",
      "d-lunes-y-martes/R3-02/DatePromised": "2026-09-07",
      "d-lunes-y-martes/R3-03/OrderRequested": "2026-09-08",
      "d-domingo-en-domingo/H1-01/OrderRequested": "2026-09-06",
      "d-lunes-desde-el-domingo/H2-01/OrderRequested": "2026-08-31",
    });
  });

  it("refuses a case whose label the corpus no longer states a date on", () => {
    // The failure mode this closes: a relabelling that leaves the probe
    // running and quietly measuring something else.
    expect(() =>
      dayProbeExpectations(
        [
          {
            transcriptId: "d-lunes-en-martes",
            // A message with no DatePromised label on it.
            messageId: "R1-04",
            factType: "DatePromised",
            exercises: "not a labelled day",
            undatedAllowed: false,
          },
        ],
        SEED_TRANSCRIPTS,
      ),
    ).toThrow(/no longer states one dueOn date/u);
  });

  it("refuses a transcript the corpus does not have", () => {
    expect(() =>
      dayProbeExpectations(
        [
          {
            transcriptId: "d-que-no-existe",
            messageId: "X-01",
            factType: "OrderRequested",
            exercises: "gone",
            undatedAllowed: false,
          },
        ],
        SEED_TRANSCRIPTS,
      ),
    ).toThrow(/which the corpus does not have/u);
  });

  it("names each case once, and names the seven the ticket asks for", () => {
    const keys = DAY_PROBE_CASES.map(dayCaseKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(7);
    // Exactly one case may answer «undated» without missing: H1's.
    expect(
      DAY_PROBE_CASES.filter((c) => c.undatedAllowed).map((c) => c.messageId),
    ).toEqual(["H1-01"]);
  });
});

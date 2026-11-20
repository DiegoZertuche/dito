/**
 * The scorer (ticket #56). Deterministic, and that is the whole design
 * claim: no model judges whether a filed fact matched its label, because a
 * measurement whose judge is the thing being measured is not a
 * measurement.
 *
 * What is pinned here:
 *
 * 1. A crossing matching a label on the same message and type, whose every
 *    check passes, is a TRUE POSITIVE.
 * 2. A crossing matching no label — wrong type, wrong message, or a check
 *    that failed — is a FALSE POSITIVE. The unlabeled-message case is the
 *    aperture-breach detector and gets its own test.
 * 3. A label with no crossing is NOT a precision failure. It is recall, and
 *    it is reported separately: the gate turning a candidate into a
 *    question is FR-31 working, not failing.
 * 4. Precision is reported PER FACT TYPE and overall (AC 4), with a Wilson
 *    interval, because a bare proportion on a small n is the thing
 *    `MIN_CROSSINGS_FOR_CONFIDENCE` exists to prevent.
 * 5. One label is claimed by at most one crossing — so filing the same
 *    fact twice costs a false positive rather than scoring twice.
 */
import { describe, expect, it } from "vitest";
import type { FactLabel, SeedTranscript } from "./corpus.ts";
import {
  labelDrops,
  scoreCrossings,
  scoreLooking,
  wilsonInterval,
  type ScoredCrossing,
} from "./scoring.ts";

function crossing(over: Partial<ScoredCrossing> = {}): ScoredCrossing {
  return {
    factId: "f1",
    transcriptId: "t1",
    messageId: "M2",
    factType: "QuoteGiven",
    payload: { item: "cajas", quantity: 100, amount: 4500, currency: "MXN" },
    disclosureText: "Le cotizaste 100 cajas en $4,500 MXN.",
    confidence: 0.9,
    ...over,
  };
}

function label(over: Partial<FactLabel> = {}): FactLabel {
  return {
    messageId: "M2",
    factType: "QuoteGiven",
    because: "the rep states the price",
    checks: [
      { path: "amount", equals: 4500 },
      { path: "currency", equals: "MXN" },
    ],
    ...over,
  };
}

describe("what counts as a correct crossing", () => {
  it("a crossing whose message, type and every check agree is correct", () => {
    const report = scoreCrossings({
      crossings: [crossing()],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.crossed).toBe(1);
    expect(report.overall.correct).toBe(1);
    expect(report.overall.precision).toBe(1);
    expect(report.wrong).toEqual([]);
  });

  it("a crossing on a message NO label names is a false positive — the aperture-breach case", () => {
    // The rep's own tactic, filed as a fact about the customer. Nothing in
    // the corpus labels M9, and this day states no OrderTaken anywhere, so
    // nothing can rescue it — not even the misattribution arm.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "f9", messageId: "M9", factType: "OrderTaken" }),
      ],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.correct).toBe(0);
    expect(report.overall.precision).toBe(0);
    expect(report.wrong).toHaveLength(1);
    expect(report.wrong[0]!.reason).toBe("no_label_for_message");
  });

  it("names a MISATTRIBUTED crossing distinctly — right content, wrong message", () => {
    // The rep's «sale» acknowledging an order stated one message earlier.
    // The order is real and the twin read it; it filed it against the ack.
    // Still a false positive — the cited message is the provenance the rep
    // would open — but a different defect from inventing one, and the
    // report has to be able to say which.
    const report = scoreCrossings({
      crossings: [crossing({ messageId: "M9" })],
      labels: [{ transcriptId: "t1", label: label({ messageId: "M2" }) }],
      dropped: [],
    });
    expect(report.overall.precision).toBe(0);
    expect(report.wrong[0]!.reason).toBe("misattributed");
    expect(report.wrong[0]!.detail).toContain("QuoteGiven");
  });

  it("...and does not confuse it with a kind the day never states", () => {
    const report = scoreCrossings({
      crossings: [crossing({ messageId: "M9", factType: "DatePromised" })],
      labels: [{ transcriptId: "t1", label: label({ messageId: "M2" }) }],
      dropped: [],
    });
    expect(report.wrong[0]!.reason).toBe("no_label_for_message");
  });

  it("a crossing of the WRONG TYPE on a labeled message is a false positive", () => {
    const report = scoreCrossings({
      crossings: [crossing({ factType: "OrderTaken" })],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.precision).toBe(0);
    expect(report.wrong[0]!.reason).toBe("no_label_for_type");
  });

  it("a crossing whose checked VALUE is wrong is a false positive, and the failing check is named", () => {
    const report = scoreCrossings({
      crossings: [
        crossing({ payload: { amount: 5400, currency: "MXN" } }),
      ],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.precision).toBe(0);
    expect(report.wrong[0]!.reason).toBe("check_failed");
    expect(report.wrong[0]!.detail).toContain("amount");
  });

  it("`contains` folds accents and case, because the prose is the model's", () => {
    const ok = scoreCrossings({
      crossings: [crossing({ payload: { commitment: "Que TIENE disponible el sábado" } })],
      labels: [
        {
          transcriptId: "t1",
          label: label({ checks: [{ path: "commitment", contains: "sabado" }] }),
        },
      ],
      dropped: [],
    });
    expect(ok.overall.precision).toBe(1);

    const notOk = scoreCrossings({
      crossings: [crossing({ payload: { commitment: "que tiene disponible el lunes" } })],
      labels: [
        {
          transcriptId: "t1",
          label: label({ checks: [{ path: "commitment", contains: "sabado" }] }),
        },
      ],
      dropped: [],
    });
    expect(notOk.overall.precision).toBe(0);
  });

  it("`absent` catches an invented value the transcript never stated", () => {
    const report = scoreCrossings({
      crossings: [crossing({ payload: { amount: 4500, currency: "MXN", dueOn: "2026-09-05" } })],
      labels: [
        {
          transcriptId: "t1",
          label: label({
            checks: [
              { path: "amount", equals: 4500 },
              { path: "dueOn", absent: true },
            ],
          }),
        },
      ],
      dropped: [],
    });
    expect(report.overall.precision).toBe(0);
    expect(report.wrong[0]!.detail).toContain("dueOn");
  });

  it("reads a nested path — identifiers are where the merge keys live", () => {
    const report = scoreCrossings({
      crossings: [
        crossing({
          factType: "ContactEstablished",
          payload: { identifiers: { emails: ["compras@fuentes.mx"] } },
        }),
      ],
      labels: [
        {
          transcriptId: "t1",
          label: label({
            factType: "ContactEstablished",
            checks: [{ path: "identifiers.emails.0", equals: "compras@fuentes.mx" }],
          }),
        },
      ],
      dropped: [],
    });
    expect(report.overall.precision).toBe(1);
  });

  it("`equalsAll` catches a FABRICATED extra merge key, which `.0` could not", () => {
    // Codex round 3. Every element of an identifier arm is a key ADR-0035's
    // ladder fires on, so an invented second email can automatically merge
    // two unrelated customers. A check on element 0 says nothing about it.
    const contact = (emails: string[]) =>
      scoreCrossings({
        crossings: [
          crossing({
            factType: "ContactEstablished",
            payload: { identifiers: { emails } },
          }),
        ],
        labels: [
          {
            transcriptId: "t1",
            label: label({
              factType: "ContactEstablished",
              checks: [
                { path: "identifiers.emails", equalsAll: ["ventas@beltran.com.mx"] },
              ],
            }),
          },
        ],
        dropped: [],
      });

    expect(contact(["ventas@beltran.com.mx"]).overall.precision).toBe(1);
    const fabricated = contact([
      "ventas@beltran.com.mx",
      "invented@victim.mx",
    ]);
    expect(fabricated.overall.precision).toBe(0);
    expect(fabricated.wrong[0]!.detail).toContain("invented@victim.mx");
  });

  it("`equalsAll: []` treats a missing arm and an empty arm as the same claim", () => {
    const noPhone = (payload: Record<string, unknown>) =>
      scoreCrossings({
        crossings: [crossing({ factType: "ContactEstablished", payload })],
        labels: [
          {
            transcriptId: "t1",
            label: label({
              factType: "ContactEstablished",
              checks: [{ path: "identifiers.phones", equalsAll: [] }],
            }),
          },
        ],
        dropped: [],
      });
    expect(noPhone({ identifiers: {} }).overall.precision).toBe(1);
    expect(noPhone({ identifiers: { phones: [] } }).overall.precision).toBe(1);
    expect(
      noPhone({ identifiers: { phones: ["+525560010002"] } }).overall.precision,
    ).toBe(0);
  });

  it("`absentOrEquals` lets a carried price through and still refuses a wrong one", () => {
    const order = (payload: Record<string, unknown>) =>
      scoreCrossings({
        crossings: [crossing({ factType: "OrderTaken", payload })],
        labels: [
          {
            transcriptId: "t1",
            label: label({
              factType: "OrderTaken",
              checks: [{ path: "amount", absentOrEquals: 14250 }],
            }),
          },
        ],
        dropped: [],
      });
    expect(order({ quantity: 3 }).overall.precision).toBe(1);
    expect(order({ amount: 14250 }).overall.precision).toBe(1);
    expect(order({ amount: 99999 }).overall.precision).toBe(0);
  });

  it("`lacks` refuses a clause that carried prohibited content along with the pinned token (#61)", () => {
    // THE HOLE `contains` LEAVES, closed (Codex r1 on ticket #61).
    // `CustomerPattern`'s whole payload is a model-composed clause, so a
    // check that only says what must SURVIVE a paraphrase says nothing
    // about what else rode along — and the thing that rides along on this
    // type is FR-30's excluded class, crossing the wall on a row scored
    // correct. `lacks` is the dual, and an absent field satisfies it
    // because a field nobody filed carries nothing.
    const graded = (payload: Record<string, unknown>) =>
      scoreCrossings({
        crossings: [crossing({ factType: "CustomerPattern", payload })],
        labels: [
          {
            transcriptId: "t1",
            label: label({
              factType: "CustomerPattern",
              checks: [
                { path: "pattern", contains: "30" },
                { path: "pattern", lacks: "tarda" },
              ],
            }),
          },
        ],
        dropped: [],
      });
    expect(graded({ pattern: "paga a 30 días" }).overall.precision).toBe(1);
    // The pinned token is there, and so is a judgment about the rep.
    const leaked = graded({
      pattern: "paga a 30 días, aunque el rep siempre se tarda",
    });
    expect(leaked.overall.precision).toBe(0);
    expect(leaked.wrong[0]!.reason).toBe("check_failed");
    expect(leaked.wrong[0]!.detail).toContain("should NOT contain");
    // Accent- and case-folded like every other prose check.
    expect(
      graded({ pattern: "paga a 30 días, el rep se TARDÁ" }).overall.precision,
    ).toBe(0);
  });

  it("one label is claimed once: the same fact filed twice costs a false positive", () => {
    const report = scoreCrossings({
      crossings: [crossing({ factId: "f1" }), crossing({ factId: "f2" })],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.crossed).toBe(2);
    expect(report.overall.correct).toBe(1);
    expect(report.wrong[0]!.reason).toBe("label_already_matched");
  });

  it("a crossing in transcript B never matches a label in transcript A", () => {
    const report = scoreCrossings({
      crossings: [crossing({ transcriptId: "t2" })],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.precision).toBe(0);
  });
});

describe("the count does not depend on the order anything was written in", () => {
  // Codex r1. Two labels on one message, one BROAD and one SPECIFIC, and
  // two crossings: A satisfies both, B satisfies only the broad one. A
  // first-come scan can hand A the broad label and leave B unmatched,
  // scoring 1 where 2 are right — and which happens depends on the order
  // the labels were typed. Maximum matching makes the count a property of
  // the group. AC 4 says the run is reproducible; this is what that means.
  const broad = (): FactLabel =>
    label({ messageId: "M5", checks: [{ path: "currency", equals: "MXN" }] });
  const specific = (): FactLabel =>
    label({
      messageId: "M5",
      checks: [
        { path: "currency", equals: "MXN" },
        { path: "amount", equals: 4500 },
      ],
    });
  const both = (): ScoredCrossing =>
    crossing({ factId: "a", messageId: "M5", payload: { amount: 4500, currency: "MXN" } });
  const broadOnly = (): ScoredCrossing =>
    crossing({ factId: "b", messageId: "M5", payload: { amount: 999, currency: "MXN" } });

  it("matches both crossings whichever order the LABELS are in", () => {
    for (const labels of [
      [broad(), specific()],
      [specific(), broad()],
    ]) {
      const report = scoreCrossings({
        crossings: [both(), broadOnly()],
        labels: labels.map((l) => ({ transcriptId: "t1", label: l })),
        dropped: [],
      });
      expect(report.overall.correct).toBe(2);
      expect(report.wrong).toEqual([]);
    }
  });

  it("...and whichever order the CROSSINGS are in", () => {
    for (const crossings of [
      [both(), broadOnly()],
      [broadOnly(), both()],
    ]) {
      const report = scoreCrossings({
        crossings,
        labels: [
          { transcriptId: "t1", label: broad() },
          { transcriptId: "t1", label: specific() },
        ],
        dropped: [],
      });
      expect(report.overall.correct).toBe(2);
    }
  });

  it("a genuine duplicate still costs a false positive — matching is not forgiveness", () => {
    const report = scoreCrossings({
      crossings: [both(), both()],
      labels: [{ transcriptId: "t1", label: specific() }],
      dropped: [],
    });
    expect(report.overall.correct).toBe(1);
    expect(report.wrong[0]!.reason).toBe("label_already_matched");
  });
});

describe("what a label that never crossed means", () => {
  it("is recall, reported separately, and never a precision failure", () => {
    const labels = [
      { transcriptId: "t1", label: label() },
      { transcriptId: "t1", label: label({ messageId: "M4" }) },
    ];
    const dropped = [
      {
        transcriptId: "t1",
        messageId: "M2",
        factType: "QuoteGiven",
        confidence: 0.6,
        reading: "stated",
      } as const,
    ];
    const report = scoreCrossings({ crossings: [], labels, dropped });
    // No crossing means no precision denominator at all — deliberately
    // undefined rather than 0 or 1, both of which would be a claim.
    expect(report.overall.crossed).toBe(0);
    expect(report.overall.precision).toBeUndefined();
    expect(report.labelsTotal).toBe(2);
    expect(report.recall).toBe(0);
    // ONE OF THE TWO LABELS WAS LOST TO THE GATE, and the row says which
    // (ticket #218). `recall` alone counts every label nothing filed for
    // ANY reason; this drop cites M2, the message the first label names, so
    // the row attributes that half of the recall loss to the THRESHOLD.
    const row = labelDrops({ dropped, labels });
    expect(row.total).toBe(1);
    expect(row.labelled).toBe(1);
  });

  it("recall counts labels that crossed correctly, over all labels", () => {
    const report = scoreCrossings({
      crossings: [crossing()],
      labels: [
        { transcriptId: "t1", label: label() },
        { transcriptId: "t1", label: label({ messageId: "M4" }) },
      ],
      dropped: [],
    });
    expect(report.recall).toBe(0.5);
  });
});

describe("the cluster interval is honest about small and perfect samples", () => {
  // Codex round 3, and both halves were real.
  const twoDays = (correct: boolean): ScoredCrossing[] => [
    crossing({ factId: "a", transcriptId: "t1", messageId: "M1" }),
    crossing({ factId: "b", transcriptId: "t2", messageId: "M1" }),
  ].map((c) => ({ ...c, payload: correct ? c.payload : { amount: 1 } }));

  const labelsFor = (ids: string[]) =>
    ids.map((id) => ({ transcriptId: id, label: label({ messageId: "M1" }) }));

  it("a perfect two-day run does NOT report [100%, 100%]", () => {
    // The percentile bootstrap cannot see variability a sample does not
    // exhibit: every resample of two all-correct days is 1. Reporting
    // [1, 1] would recreate the exact small-perfect-run overclaim Wilson
    // was chosen to prevent — on the interval the report says to quote.
    const report = scoreCrossings({
      crossings: twoDays(true),
      labels: labelsFor(["t1", "t2"]),
      dropped: [],
      clusterIds: ["t1", "t2"],
    });
    expect(report.overall.precision).toBe(1);
    expect(report.overallClusterInterval!.low).toBeLessThan(0.6);
    expect(report.overallClusterInterval!.high).toBeCloseTo(1, 6);
  });

  it("an all-wrong two-day run does not report [0%, 0%] either", () => {
    const report = scoreCrossings({
      crossings: twoDays(false),
      labels: labelsFor(["t1", "t2"]),
      dropped: [],
      clusterIds: ["t1", "t2"],
    });
    expect(report.overall.precision).toBe(0);
    expect(report.overallClusterInterval!.high).toBeGreaterThan(0.4);
  });

  it("counts chat-days that crossed NOTHING — the frame is the corpus slice, not the winners", () => {
    // A day the gate emptied is a real draw from the population the corpus
    // samples. Deriving the frame from crossings alone conditioned the
    // interval on "days that filed something".
    const report = scoreCrossings({
      crossings: twoDays(true),
      labels: labelsFor(["t1", "t2"]),
      dropped: [],
      clusterIds: ["t1", "t2", "t3-quiet", "t4-quiet"],
    });
    expect(report.clusters).toBe(4);
  });

  it("without a frame it falls back to the transcripts that crossed", () => {
    const report = scoreCrossings({
      crossings: twoDays(true),
      labels: labelsFor(["t1", "t2"]),
      dropped: [],
    });
    expect(report.clusters).toBe(2);
  });
});

describe("precision per fact type, and the interval", () => {
  it("reports each type separately as well as overall (AC 4)", () => {
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "a", messageId: "M2" }),
        crossing({ factId: "b", messageId: "M3", factType: "OrderTaken" }),
        crossing({ factId: "c", messageId: "M4", factType: "OrderTaken" }),
      ],
      labels: [
        { transcriptId: "t1", label: label({ messageId: "M2" }) },
        {
          transcriptId: "t1",
          label: label({ messageId: "M3", factType: "OrderTaken", checks: [] }),
        },
      ],
      dropped: [],
    });
    expect(report.overall.crossed).toBe(3);
    expect(report.overall.correct).toBe(2);
    expect(report.byFactType["QuoteGiven"]).toMatchObject({
      crossed: 1,
      correct: 1,
      precision: 1,
    });
    expect(report.byFactType["OrderTaken"]).toMatchObject({
      crossed: 2,
      correct: 1,
      precision: 0.5,
    });
    // A type with no crossings is present and honest about it, rather than
    // missing — a missing row reads as "fine" and an empty one does not.
    expect(report.byFactType["DatePromised"]).toMatchObject({
      crossed: 0,
      precision: undefined,
    });
  });

  it("the Wilson interval widens as n shrinks — which is why n is reported with p", () => {
    const wide = wilsonInterval(19, 20)!;
    const narrow = wilsonInterval(76, 80)!;
    expect(wide.low).toBeLessThan(narrow.low);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
    // Both estimate 0.95; only one of them is a statement about the bar.
    expect(wide.low).toBeLessThan(0.8);
    expect(narrow.low).toBeGreaterThan(0.85);
  });

  it("a perfect run still has a lower bound below 1 — n is never ignored", () => {
    expect(wilsonInterval(10, 10)!.low).toBeLessThan(1);
    // Exactly 1 in arithmetic, one ulp short of it in doubles. Left
    // unrounded rather than nudged: the interval is reported to three
    // decimals and rounding inside the computation would be hiding the
    // approximation rather than making it.
    expect(wilsonInterval(10, 10)!.high).toBeCloseTo(1, 12);
  });

  it("an empty denominator has no interval, rather than a misleading one", () => {
    expect(wilsonInterval(0, 0)).toBeUndefined();
  });
});

/**
 * THE CONFIDENCE BAND (ticket #66 — the diagnosis half).
 *
 * #66's complaint is that the gate stopped NOTHING in three rig runs, and
 * its third hypothesis is the interesting one: not that 0.8 is
 * the wrong number, but that "uncertain" may not be REPRESENTABLE — a
 * conditional is not a low-confidence order, it is not an order.
 *
 * None of that is arguable without the numbers, and #56 left `confidence`
 * off `ScoredCrossing`, so the report could not say whether the six wrong
 * crossings sat beside the gate or far above it. These tests pin the band
 * at the scoring seam.
 *
 * EVERY EXPECTED VALUE BELOW IS WORKED BY HAND from the literal
 * confidences the test writes in. A summary that recomputed its inputs the
 * way the code does would agree with any implementation, including a
 * broken one.
 */
describe("the confidence distribution (#66)", () => {
  it("summarises the graded candidates per fact type, with hand-worked values", () => {
    // Five QuoteGiven crossings at 0.99, 0.95, 0.90, 0.82, 0.75 — sorted,
    // the median is the third, 0.90. Two OrderTaken at 0.60 and 0.80: an
    // even count, so the median is the mean of the middle pair, 0.70.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "a", messageId: "M2", confidence: 0.99 }),
        crossing({ factId: "b", messageId: "M2", confidence: 0.95 }),
        crossing({ factId: "c", messageId: "M2", confidence: 0.9 }),
        crossing({ factId: "d", messageId: "M2", confidence: 0.82 }),
        crossing({ factId: "e", messageId: "M2", confidence: 0.75 }),
        crossing({
          factId: "f",
          messageId: "M3",
          factType: "OrderTaken",
          confidence: 0.6,
        }),
        crossing({
          factId: "g",
          messageId: "M3",
          factType: "OrderTaken",
          confidence: 0.8,
        }),
      ],
      labels: [],
      dropped: [],
    });

    const quotes = report.confidence.byFactType["QuoteGiven"]!.graded;
    expect(quotes.n).toBe(5);
    expect(quotes.min).toBe(0.75);
    expect(quotes.max).toBe(0.99);
    expect(quotes.median).toBe(0.9);

    const orders = report.confidence.byFactType["OrderTaken"]!.graded;
    expect(orders.n).toBe(2);
    expect(orders.median).toBeCloseTo(0.7, 12);

    // Seven graded candidates overall; sorted they are 0.60 0.75 0.80 0.82
    // 0.90 0.95 0.99, so the median is the fourth, 0.82.
    expect(report.confidence.overall.graded.n).toBe(7);
    expect(report.confidence.overall.graded.median).toBe(0.82);
  });

  it("names the DISTINCT values, which is how a clustered emitter shows itself", () => {
    // Four crossings taking two values. If the live corpus does this, the
    // question is not where the threshold sits — there is nowhere to put it.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "a", confidence: 0.95 }),
        crossing({ factId: "b", confidence: 0.95 }),
        crossing({ factId: "c", confidence: 0.95 }),
        crossing({ factId: "d", confidence: 0.9 }),
      ],
      labels: [],
      dropped: [],
    });
    expect(report.confidence.overall.graded.distinct).toEqual([
      { value: 0.9, n: 1 },
      { value: 0.95, n: 3 },
    ]);
  });

  it("a crossing the Ledger holds with no confidence is counted, never averaged", () => {
    // A filed fact's confidence is nullable in the Ledger — a rep act has
    // no model confidence. Folding a null in as a 0 would invent a low
    // reading.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "a", confidence: 0.9 }),
        crossing({ factId: "b", confidence: null }),
      ],
      labels: [],
      dropped: [],
    });
    expect(report.confidence.overall.graded.n).toBe(1);
    expect(report.confidence.overall.graded.min).toBe(0.9);
    expect(report.confidence.ungradedCrossings).toBe(1);
  });

  it("has no summary at all when nothing was graded, rather than a zero", () => {
    const report = scoreCrossings({ crossings: [], labels: [], dropped: [] });
    expect(report.confidence.overall.graded.n).toBe(0);
    expect(report.confidence.overall.graded.min).toBeUndefined();
    expect(report.confidence.overall.graded.median).toBeUndefined();
  });

  it("separates where the CORRECT crossings sat from where the WRONG ones did", () => {
    // The whole decision this ticket feeds: a false positive at 0.99 is out
    // of any gate's reach, and one at 0.81 is a threshold away.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "ok", messageId: "M2", confidence: 0.93 }),
        // M9 carries no label at all, and this day labels no OrderTaken
        // anywhere — a false positive, filed very confidently.
        crossing({
          factId: "bad",
          messageId: "M9",
          factType: "OrderTaken",
          confidence: 0.99,
        }),
      ],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [],
    });
    expect(report.overall.correct).toBe(1);
    expect(report.confidence.overall.correct.distinct).toEqual([
      { value: 0.93, n: 1 },
    ]);
    expect(report.confidence.overall.wrong.distinct).toEqual([
      { value: 0.99, n: 1 },
    ]);
    // And per false positive, not only in aggregate: a reader asking "could
    // a threshold have caught THIS one" gets an answer on the line itself.
    expect(report.wrong[0]).toMatchObject({
      factId: "bad",
      confidence: 0.99,
    });
  });

  it("counts a DROPPED candidate below the gate, never in the crossings", () => {
    const report = scoreCrossings({
      crossings: [crossing({ factId: "a", confidence: 0.95 })],
      labels: [{ transcriptId: "t1", label: label() }],
      dropped: [
        {
          transcriptId: "t1",
          messageId: "M5",
          factType: "OrderTaken",
          confidence: 0.55,
          reading: "stated",
        },
      ],
    });
    expect(report.confidence.overall.filed.n).toBe(1);
    expect(report.confidence.overall.dropped.distinct).toEqual([
      { value: 0.55, n: 1 },
    ]);
    // Both sides of the gate, in one population: two graded candidates.
    expect(report.confidence.overall.graded.n).toBe(2);
    // A dropped candidate is neither correct nor wrong — it never crossed,
    // so it was never judged against a label. Only the crossing appears on
    // either side.
    expect(report.confidence.overall.correct.n).toBe(1);
    expect(report.confidence.overall.wrong.n).toBe(0);
    // And it lands under its own kind, not the crossing's.
    expect(report.confidence.byFactType["OrderTaken"]!.dropped.n).toBe(1);
  });

  it("NAMES each dropped candidate and says whether a label backed it (#218)", () => {
    // THE ROW'S WHOLE POINT. A drop is silent — no fact, no question, no
    // line — so a bare count of drops cannot be argued with: which
    // message, which kind of claim, how sure, and whether the corpus says
    // a fact of that kind was stated there. The last is the recall the
    // gate cost, which is what spec #214 decision 1 asks to be measured.
    const row = labelDrops({
      labels: [
        { transcriptId: "t1", label: label({ messageId: "M5", factType: "OrderTaken" }) },
      ],
      dropped: [
        {
          transcriptId: "t1",
          messageId: "M5",
          factType: "OrderTaken",
          confidence: 0.55,
          reading: "stated",
        },
        // The same message, a kind no label names there: proposed,
        // stopped, and NOT a recall loss.
        {
          transcriptId: "t1",
          messageId: "M5",
          factType: "DatePromised",
          confidence: 0.4,
          reading: "resolved_reference",
        },
      ],
    });
    expect(row.candidates).toEqual([
      {
        transcriptId: "t1",
        messageId: "M5",
        factType: "OrderTaken",
        confidence: 0.55,
        reading: "stated",
        labelled: true,
      },
      {
        transcriptId: "t1",
        messageId: "M5",
        factType: "DatePromised",
        confidence: 0.4,
        reading: "resolved_reference",
        labelled: false,
      },
    ]);
    expect(row.total).toBe(2);
    expect(row.labelled).toBe(1);
  });

  it("counts the MIDDLE BAND around the gate — #66's question, answerable as a number", () => {
    // The gate is 0.8, so the band is [0.7, 0.9). Of these five: 0.55 is
    // below it, 0.72 and 0.85 are inside it, 0.9 is the exclusive top edge
    // and 0.97 is above. Two.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "a", confidence: 0.85 }),
        crossing({ factId: "b", confidence: 0.9 }),
        crossing({ factId: "c", confidence: 0.97 }),
      ],
      labels: [],
      dropped: [
        {
          transcriptId: "t1",
          messageId: "M5",
          factType: "OrderTaken",
          confidence: 0.72,
          reading: "stated",
        },
        {
          transcriptId: "t1",
          messageId: "M6",
          factType: "OrderTaken",
          confidence: 0.55,
          reading: "stated",
        },
      ],
    });
    expect(report.confidence.gate).toBe(0.8);
    expect(report.confidence.middleBand).toEqual({ from: 0.7, to: 0.9 });
    expect(report.confidence.inMiddleBand).toBe(2);
  });

  it("bins into bands whose edges include the gate, so the two sides never share one", () => {
    // 0.79 is below the gate, 0.80 is at it. A histogram that put them in
    // one bucket could not show a threshold anything.
    const report = scoreCrossings({
      crossings: [
        crossing({ factId: "a", confidence: 0.8 }),
        crossing({ factId: "b", confidence: 1 }),
      ],
      labels: [],
      dropped: [
        {
          transcriptId: "t1",
          messageId: "M5",
          factType: "OrderTaken",
          confidence: 0.79,
          reading: "stated",
        },
      ],
    });
    const bands = report.confidence.overall.graded.bands;
    expect(bands.find((b) => b.from === 0.7 && b.to === 0.8)!.n).toBe(1);
    expect(bands.find((b) => b.from === 0.8 && b.to === 0.85)!.n).toBe(1);
    // The top band closes at 1, so a confidence of exactly 1 is counted
    // rather than falling off the end.
    expect(bands.find((b) => b.from === 0.95 && b.to === 1)!.n).toBe(1);
    expect(bands.reduce((n, b) => n + b.n, 0)).toBe(3);
  });
});

/**
 * THE LOOKING ROW (ticket #199; spec #193 decision 11).
 *
 * The four days whose facts can only be read by resolving a reference are
 * new material, so folding them into the overall number would move it by
 * being ADDED rather than by anything the extractor did. They are scored the
 * same way as any other day — a resolved fact's checks are the goods the
 * referent named — and reported apart, with the one thing only these days
 * can measure beside them: whether the referent leaked into what was filed.
 */
describe("the looking row (#199)", () => {
  /**
   * A looking day, as the row's frame: the id the crossings carry and the
   * tokens the leak sweep reads. The messages and labels are the scorer's
   * business and it is handed them separately.
   */
  const day = (id: string, neverFiled: readonly string[]): SeedTranscript => ({
    id,
    exercises: "a day whose fact can only be read by resolving a reference",
    counterparty: "Ferretería Ochoa",
    neverFiled,
    messages: [],
    labels: [],
    silent: [],
  });
  const BACK = day("l-pedido-pasado-mismo-chat", ["Ochoa", "pedido"]);
  const NADA = day("l-referencia-a-nada", ["Robles", "pedido"]);
  const DOS = day("l-dos-candidatos-distintos", ["Lucero", "pedido"]);

  const resolved = (over: Partial<ScoredCrossing> = {}): ScoredCrossing =>
    crossing({
      factId: "fl",
      transcriptId: "l-pedido-pasado-mismo-chat",
      messageId: "LA-D1",
      factType: "OrderRequested",
      payload: { item: "bultos de cemento gris", quantity: 300 },
      disclosureText:
        "Te pidió 300 bultos de cemento gris — sin precio, sin fecha. (por referencia)",
      confidence: 0.95,
      ...over,
    });

  const lookingLabel = (): FactLabel => ({
    messageId: "LA-D1",
    factType: "OrderRequested",
    because: "the customer asks for the same as their previous order",
    checks: [
      { path: "quantity", equals: 300 },
      { path: "item", lacks: "Ochoa" },
    ],
  });

  it("names the failing check's shape, so a leak can be told from a wrong value", () => {
    // The two failures a looking day can have are different findings: a
    // wrong QUANTITY is a misreading the rep corrects, and a referent's NAME
    // in `item` is chat identity crossing the wall (ADR-0004). The reason is
    // `check_failed` for both — what tells them apart is which predicate
    // failed.
    const leaked = scoreCrossings({
      crossings: [
        resolved({ payload: { item: "cemento gris del chat de Ochoa", quantity: 300 } }),
      ],
      labels: [
        { transcriptId: "l-pedido-pasado-mismo-chat", label: lookingLabel() },
      ],
      dropped: [],
    });
    expect(leaked.wrong).toHaveLength(1);
    expect(leaked.wrong[0]!.reason).toBe("check_failed");
    expect(leaked.wrong[0]!.failedCheck).toBe("lacks");

    const misread = scoreCrossings({
      crossings: [resolved({ payload: { item: "cemento gris", quantity: 200 } })],
      labels: [
        { transcriptId: "l-pedido-pasado-mismo-chat", label: lookingLabel() },
      ],
      dropped: [],
    });
    expect(misread.wrong[0]!.failedCheck).toBe("equals");
  });

  it("reports a resolved-and-right case, its own n and its interval", () => {
    const crossings = [resolved()];
    const report = scoreCrossings({
      crossings,
      labels: [
        { transcriptId: "l-pedido-pasado-mismo-chat", label: lookingLabel() },
      ],
      dropped: [],
      clusterIds: ["l-pedido-pasado-mismo-chat", "l-referencia-a-nada"],
    });
    const row = scoreLooking({
      report,
      crossings,
      transcripts: [BACK, NADA],
    });
    expect(row.crossed).toBe(1);
    expect(row.correct).toBe(1);
    expect(row.precision).toBe(1);
    // Its own interval, over its own n — one crossing says almost nothing,
    // and the row must not be readable as though it did.
    expect(row.interval).toEqual(wilsonInterval(1, 1));
    expect(row.leaks).toBe(0);
    expect(row.cases).toEqual([
      { transcriptId: "l-pedido-pasado-mismo-chat", outcome: "resolved-right", leaked: false },
      // A day that filed nothing is a real outcome, not a missing row: the
      // two drop cases are the half of ADR-0039 as amended that this corpus
      // exists to prove.
      { transcriptId: "l-referencia-a-nada", outcome: "dropped", leaked: false },
    ]);
  });

  it("counts a leaked referent as its own number beside the precision", () => {
    const crossings = [
      resolved({ payload: { item: "cemento gris, el de Ochoa", quantity: 300 } }),
    ];
    const report = scoreCrossings({
      crossings,
      labels: [
        { transcriptId: "l-pedido-pasado-mismo-chat", label: lookingLabel() },
      ],
      dropped: [],
      clusterIds: ["l-pedido-pasado-mismo-chat"],
    });
    const row = scoreLooking({
      report,
      crossings,
      transcripts: [BACK],
    });
    expect(row.precision).toBe(0);
    expect(row.leaks).toBe(1);
    expect(row.cases).toEqual([
      {
        transcriptId: "l-pedido-pasado-mismo-chat",
        outcome: "resolved-wrong",
        leaked: true,
      },
    ]);
  });

  it("reads a day the gate STOPPED as dropped, and names the drop in the row (#218)", () => {
    // ADR-0039's 2026-09-06 amendment routed a resolved candidate below the
    // gate to a question, and this row called that ending `questioned` so a
    // reader could not mistake the gate working for the looking failing.
    // The question principle supersedes that amendment: an unsure
    // resolution is still a hole in the twin's record, so the candidate is
    // dropped like any other. NOTHING IS LOST BY THE COLLAPSE — the
    // *dropped below gate* row names the drop, says how sure the model was
    // and whether a label backed it, which is more than the fourth word
    // ever said.
    const labels = [
      { transcriptId: "l-pedido-pasado-mismo-chat", label: lookingLabel() },
    ];
    const dropped = [
      {
        transcriptId: "l-pedido-pasado-mismo-chat",
        messageId: "LA-D1",
        factType: "OrderRequested",
        confidence: 0.5,
        reading: "resolved_reference",
      } as const,
    ];
    const report = scoreCrossings({
      crossings: [],
      labels,
      dropped,
      clusterIds: ["l-pedido-pasado-mismo-chat"],
    });
    const row = scoreLooking({
      report,
      crossings: [],
      transcripts: [BACK],
    });
    expect(row.crossed).toBe(0);
    expect(row.precision).toBeUndefined();
    expect(row.cases).toEqual([
      {
        transcriptId: "l-pedido-pasado-mismo-chat",
        outcome: "dropped",
        leaked: false,
      },
    ]);
    // ...and the drop is not invisible: the row says the corpus labelled
    // this very message, so the recall this day lost is a number. It is
    // built over the WHOLE RUN rather than over one scored partition, which
    // is what makes a looking day's drop reach the report at all.
    expect(labelDrops({ dropped, labels }).labelled).toBe(1);
  });

  it("counts a leak whose first failing check was something else (Codex r1)", () => {
    // `firstFailure` stops at the first predicate that fails, so a crossing
    // with a wrong quantity AND the referent's name in `item` recorded
    // `failedCheck: "equals"` and the leak beside it went uncounted. The
    // sweep is over what was FILED, so the order of the label's checks
    // cannot hide it.
    const crossings = [
      resolved({ payload: { item: "cemento gris del chat de Ochoa", quantity: 200 } }),
    ];
    const report = scoreCrossings({
      crossings,
      labels: [
        { transcriptId: "l-pedido-pasado-mismo-chat", label: lookingLabel() },
      ],
      dropped: [],
      clusterIds: [BACK.id],
    });
    expect(report.wrong[0]!.failedCheck).toBe("equals");
    const row = scoreLooking({
      report,
      crossings,
      transcripts: [BACK],
    });
    expect(row.leaks).toBe(1);
    expect(row.cases[0]).toEqual({
      transcriptId: BACK.id,
      outcome: "resolved-wrong",
      leaked: true,
    });
    // ...and it is wrong ONCE. Two entries for one fact would read as two
    // false positives, and the label already named this one.
    expect(row.correct).toBe(0);
    expect(row.wrong).toHaveLength(1);
  });

  it("counts a leak on a day that labels NOTHING — the two drop cases", () => {
    // The sharp half of the same finding: the days that must file nothing
    // have no labels, so no check runs at all and a fact naming another
    // customer reached the record with nothing to catch it.
    const crossings = [
      resolved({
        transcriptId: DOS.id,
        messageId: "LC-D1",
        payload: { item: "rollos de alambre del pedido de Lucero", quantity: 500 },
      }),
    ];
    const report = scoreCrossings({
      crossings,
      labels: [],
      dropped: [],
      clusterIds: [DOS.id],
    });
    // No label anywhere, so the scorer ran no predicate on it.
    expect(report.wrong[0]!.failedCheck).toBeUndefined();
    const row = scoreLooking({
      report,
      crossings,
      transcripts: [DOS],
    });
    expect(row.leaks).toBe(1);
    expect(row.cases[0]!.leaked).toBe(true);
    // Named, with the predicate the sweep fired and the tokens it found.
    const leak = row.wrong.find((w) => w.failedCheck === "lacks")!;
    expect(leak.detail).toContain("Lucero");
    expect(leak.detail).toContain("pedido");
  });

  it("sweeps every filed field, not only the ones a label would pin", () => {
    // A type this day labels nowhere runs no checks, and a field nobody
    // classified as prose is still a field the referent can reach — so the
    // sweep reads every string the aperture stored, which is the fail-closed
    // direction (ADR-0004).
    const crossings = [
      resolved({
        factType: "CustomerPattern",
        payload: { pattern: "siempre pide lo mismo que Ochoa" },
      }),
    ];
    const report = scoreCrossings({
      crossings,
      labels: [],
      dropped: [],
      clusterIds: [BACK.id],
    });
    const row = scoreLooking({
      report,
      crossings,
      transcripts: [BACK],
    });
    expect(row.leaks).toBe(1);
  });

  it("keeps the cases in the order the corpus declares them", () => {
    // A row whose order came from a Map or from which day happened to file
    // something would read differently between two runs over identical data,
    // which is the reproducibility the fixed corpus and the fixed clock exist
    // to provide.
    const report = scoreCrossings({
      crossings: [],
      labels: [],
      dropped: [],
      clusterIds: ["l-referencia-a-nada", "l-dos-candidatos-distintos"],
    });
    const row = scoreLooking({
      report,
      crossings: [],
      transcripts: [NADA, DOS],
    });
    expect(row.cases.map((c) => c.transcriptId)).toEqual([
      "l-referencia-a-nada",
      "l-dos-candidatos-distintos",
    ]);
  });
});

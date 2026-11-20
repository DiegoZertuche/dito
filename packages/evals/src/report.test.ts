/**
 * The report (ticket #56 ACs 4, 5 and 6).
 *
 * What is pinned is what the report must NOT do, because the failure modes
 * here are all failures of overclaiming:
 *
 * 1. It never announces a pass or a fail against the ≥95% bar. This slice's
 *    number gates nothing (AC 6) and a line saying PASS or FAIL would be
 *    read as though it did.
 * 2. It never prints a bare proportion. Every cell carries its n and its
 *    interval — "100% precision" over four crossings is the sentence a
 *    measurement exists to prevent.
 * 3. It says so when the run is UNDERPOWERED, rather than letting a small
 *    n hide inside a confident-looking percentage.
 * 4. It records the excluded fact types IN THE DOCUMENT, so the artifact a
 *    reader finds six months from now says for itself what the number does
 *    and does not cover (AC 5). Since ticket #61 the manifest is empty and
 *    the line says «none», which is a stronger claim than the one it
 *    replaced — and `CustomerPattern` has a row of its own in the table,
 *    because an aperture breach must not be able to hide inside a healthy
 *    overall figure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACTION_CONFIDENCE_THRESHOLD } from "@dito/aperture";
import { extractionDigest } from "@dito/twin-runtime";
import { describe, expect, it } from "vitest";
import {
  corpusDigest,
  EXCLUDED_FACT_TYPES,
  MIN_CROSSINGS_FOR_CONFIDENCE,
} from "./corpus.ts";
import { LOOKING_TRANSCRIPTS } from "./corpus/looking.ts";
import { ALL_TRANSCRIPTS, SEED_TRANSCRIPTS } from "./corpus/transcripts.ts";
import {
  buildReport,
  renderReport,
  type BeforeSide,
  type ChatDayCost,
  type EvalReportDocument,
  type RetryCounts,
} from "./report.ts";
import {
  labelDrops,
  scoreCrossings,
  type DroppedBelowGateRow,
  type LookingRow,
  type PlacedLabel,
  type ScoredCrossing,
} from "./scoring.ts";

/**
 * `retries` defaults to a clean run (#146). `buildReport` REQUIRES it — a
 * lane running today always knows the answer — so a fixture for a report
 * recorded BEFORE the ticket is made by dropping the key afterwards, which
 * is what `preRetryCounting` below does.
 */
const NO_RETRIES: RetryCounts = { total: 0, byTranscript: {} };

/** A chat-day that cost one round, one submission and no reads (#199). */
const ONE_ROUND: ChatDayCost = {
  toolCalls: 1,
  reads: 0,
  iterations: 1,
  tokensIn: 1_000,
  tokensOut: 100,
};

/**
 * A run the gate stopped nothing in — the *dropped below gate* row's empty
 * value.
 *
 * It arrives as an INPUT like `looking` and `pass` do, because the row is
 * over every chat the run read while the precision report beside it is over
 * the original labels alone (ticket #218; Codex r1).
 */
const NO_DROPS: DroppedBelowGateRow = {
  candidates: [],
  total: 0,
  labelled: 0,
};

/**
 * A looking row with nothing in it (#199) — the shape a fixture whose
 * subject is the ORIGINAL number still has to carry, because a run today
 * always knows the answer and `buildReport` requires it.
 */
const NO_LOOKING: LookingRow = {
  cases: [],
  crossed: 0,
  correct: 0,
  precision: undefined,
  interval: undefined,
  leaks: 0,
  unmarked: 0,
  wrong: [],
};

/**
 * The committed before side, as a fixture (#199).
 *
 * Its corpus digest is the fixture's ORIGINAL-labels digest, because that is
 * what `buildReport` refuses a pair over: two sides scored against different
 * labels are the unreadable comparison #83 taught this corpus to refuse.
 */
const ORIGINAL_DIGEST = "1".repeat(32);
const BEFORE: BeforeSide = {
  report: "extraction-precision-before-6a.json",
  // THE TREE'S OWN STAMP, which is what makes #218's pair controlled: the
  // extractor is held still on both sides (`extraction-precision.ts` argues
  // it). Read from the code rather than written as a literal, so this
  // fixture cannot describe an extractor the tree does not have.
  extractorDigest: extractionDigest({ model: "claude-sonnet-5" }),
  corpusDigest: ORIGINAL_DIGEST,
  model: "claude-sonnet-5",
  overall: {
    crossed: 148,
    correct: 144,
    precision: 144 / 148,
    interval: { low: 0.93, high: 0.99 },
  },
  overallClusterInterval: { low: 0.94, high: 0.99 },
};

function run(crossed: number, correct: number, retries: RetryCounts = NO_RETRIES) {
  const labels: PlacedLabel[] = [];
  const crossings: ScoredCrossing[] = [];
  for (let i = 0; i < crossed; i += 1) {
    const messageId = `M${i}`;
    if (i < correct) {
      labels.push({
        transcriptId: "t",
        label: {
          messageId,
          factType: "QuoteGiven",
          because: "the rep states a price for a stated quantity",
          // A label that ASSERTS something, even in a fixture whose
          // subject is the report rather than the scorer. #59 records
          // `checks: []` as a corpus hazard — "a label that asserts
          // nothing passes everything" — and a fixture that keeps the
          // shape teaches it back into the corpus the next time somebody
          // copies one.
          checks: [{ path: "amount", equals: 4500 }],
        },
      });
    }
    crossings.push({
      factId: `f${i}`,
      transcriptId: "t",
      messageId,
      factType: "QuoteGiven",
      payload: { amount: 4500 },
      disclosureText: `Le cotizaste algo (${i}).`,
      // The correct ones at 0.95 and the wrong ones at 0.99, so a test can
      // tell the two populations apart in the rendered band.
      confidence: i < correct ? 0.95 : 0.99,
    });
  }
  return buildReport({
    report: scoreCrossings({ crossings, labels, dropped: [] }),
    looking: NO_LOOKING,
    droppedBelowGate: NO_DROPS,
    before: BEFORE,
    cost: { total: ONE_ROUND, byTranscript: { t: ONE_ROUND } },
    model: "claude-sonnet-5",
    // The two knobs #148 added, recorded beside the model because a
    // number produced at one effort says nothing about another.
    maxTokens: 16_000,
    ranAt: new Date("2026-08-29T17:24:25.871Z"),
    corpus: {
      transcripts: 34,
      messages: 186,
      labels: labels.length,
      digest: "0".repeat(32),
      originalDigest: ORIGINAL_DIGEST,
    },
    // Every crossing here came from a candidate the pass proposed and the
    // gate let through — no refusals, no drops — so the pass's counts and
    // the band's agree by construction in this fixture.
    pass: {
      messages: crossed,
      candidates: crossed,
      filed: crossed,
      belowThreshold: 0,
      unresolvedReference: 0,
      resolvedReference: 0,
      refused: 0,
    },
    retries,
  });
}

/**
 * A document shaped like one of the three artifacts recorded before #146:
 * everything the reader needs, and no `retries` key at all.
 */
function preRetryCounting(): EvalReportDocument {
  const older = { ...run(10, 10) };
  delete older.retries;
  return older;
}

describe("the report never overclaims", () => {
  it("prints no PASS and no FAIL, however good the number is", () => {
    const text = renderReport(run(100, 100));
    expect(text).not.toMatch(/\bPASS(ED)?\b/u);
    expect(text).not.toMatch(/\bFAIL(ED|URE)?\b/u);
    // ...and says outright that it gates nothing.
    expect(text).toContain("NOT A GATE");
    expect(text).toContain("Test 4 gates the flag flip");
  });

  it("prints the bar beside the estimate rather than judging against it", () => {
    const text = renderReport(run(100, 60));
    expect(text).toContain("the bar          95.0%");
    expect(text).toContain("60.0%");
    expect(text).not.toMatch(/\bbelow the bar\b/iu);
  });

  it("never prints a proportion without its n and its interval", () => {
    const text = renderReport(run(20, 19));
    expect(text).toContain("( 19/20 )");
    expect(text).toMatch(/\[\s*\d+\.\d%\s*–\s*\d+\.\d%\]/u);
  });

  it("says so when the run is underpowered, rather than hiding a small n", () => {
    const small = run(20, 19);
    expect(small.underpowered).toBe(true);
    const text = renderReport(small);
    expect(text).toContain("UNDERPOWERED");
    expect(text).toContain(`under the ${MIN_CROSSINGS_FOR_CONFIDENCE}`);
    expect(text).toContain("too wide to say whether the bar is met");
  });

  it("stays quiet about power when the run has enough crossings", () => {
    const big = run(MIN_CROSSINGS_FOR_CONFIDENCE, MIN_CROSSINGS_FOR_CONFIDENCE - 7);
    expect(big.underpowered).toBe(false);
    expect(renderReport(big)).not.toContain("UNDERPOWERED");
  });

  it("shows a cell with no crossings as a dash, never as 0% or 100%", () => {
    const text = renderReport(run(10, 10));
    // DatePromised crossed nothing in this run.
    expect(text).toMatch(/DatePromised\s+—/u);
    expect(text).not.toMatch(/DatePromised\s+0\.0%/u);
  });
});

/**
 * WHAT THE MODEL WAS ASKED FOR, NOT ONLY WHICH MODEL (ticket #148, AC 3).
 *
 * The report already recorded the model name and the extractor digest, on
 * the argument that a number and the extractor that produced it must not
 * be separable after the fact. #148 makes two more knobs load-bearing: the
 * effort the request asked for, and the token ceiling the answer had to
 * fit in. Both change the number, neither is in either digest, and this
 * ticket's own table is three arms that differ in nothing else — so a
 * report recording only «claude-sonnet-5» would leave its own two Sonnet
 * arms indistinguishable in the artifact, which is the hole
 * `extractorDigest` was added to close on the prompt side.
 */
describe("the document says what the model was asked for (#148)", () => {
  it("records the effort when one was asked for, and its absence when none was", () => {
    // ABSENCE IS A VALUE HERE. Unset means the model's own default —
    // adaptive thinking on Sonnet 5 — which is one of the two arms, so it
    // has to be readable as "no effort was sent" rather than as a field
    // somebody forgot to write.
    expect(run(10, 10).effort).toBeUndefined();
    const low = buildReport({
      report: scoreCrossings({ crossings: [], labels: [], dropped: [] }),
      looking: NO_LOOKING,
      droppedBelowGate: NO_DROPS,
      before: BEFORE,
      cost: { total: ONE_ROUND, byTranscript: {} },
      model: "claude-sonnet-5",
      effort: "low",
      maxTokens: 16_000,
      ranAt: new Date("2026-09-02T00:00:00.000Z"),
      corpus: {
        transcripts: 1,
        messages: 1,
        labels: 0,
        digest: "0".repeat(32),
        originalDigest: ORIGINAL_DIGEST,
      },
      pass: {
        messages: 0,
        candidates: 0,
        filed: 0,
        belowThreshold: 0,
        unresolvedReference: 0,
        resolvedReference: 0,
        refused: 0,
      },
      // A clean run, said rather than omitted (#146): the input is
      // required precisely so a lane cannot drop the count by accident.
      retries: NO_RETRIES,
    });
    expect(low.effort).toBe("low");
    expect(renderReport(low)).toContain("effort           low");
  });

  it("prints the model's own default in words, so an unset effort is not a blank", () => {
    expect(renderReport(run(10, 10))).toContain(
      "effort           (the model's own default)",
    );
  });

  it("records the token ceiling the answer had to fit in", () => {
    // The 2,048 Sonnet 5's thinking block spent in full is the whole
    // reason this ticket exists, so the artifact says which ceiling its
    // number was measured under.
    const doc = run(10, 10);
    expect(doc.maxTokens).toBe(16_000);
    expect(renderReport(doc)).toContain("max_tokens       16000");
  });
});

describe("the document carries the corpus's own claims (AC 5)", () => {
  it("records the excluded fact types in the artifact itself, and says so when there are none", () => {
    // AC 5's artifact half. It used to carry `CustomerPattern`'s absence;
    // ticket #61 extracted it, so the manifest is empty and the line has to
    // keep MEANING something — «none» is the claim that every type the
    // aperture files is labeled, which is what a reader six months from now
    // needs before trusting the table above to cover the system. A blank
    // after the colon would have read as an artifact that lost a field.
    const doc = run(10, 10);
    expect(doc.corpus.excludedFactTypes).toEqual(EXCLUDED_FACT_TYPES);
    expect(Object.keys(doc.corpus.excludedFactTypes)).toEqual([]);
    expect(renderReport(doc)).toContain("absent from the corpus: none");
  });

  it("gives CustomerPattern its own row, so an aperture breach cannot hide inside a healthy overall figure (#61)", () => {
    // THE OBLIGATION THE OLD EXCLUSION ENTRY LEFT BEHIND, in its own words:
    // `CustomerPattern` joins "with its own labels and — this is the part
    // that must not be skipped — its own reported number beside the others,
    // never folded in". A wrong `QuoteGiven` is a wrong number the rep can
    // correct; a wrong `CustomerPattern` is the rep's employer reading a
    // judgment about the rep, and averaging the two reports one reassuring
    // figure over a recoverable error and an unrecoverable one.
    //
    // The row is printed even when NOTHING crossed on it — as a dash, never
    // as 0% or 100% — because a missing row reads as "fine" and a run that
    // filed no pattern at all is not the same statement as a run that filed
    // ten correct ones.
    const doc = run(10, 10);
    expect(Object.keys(doc.byFactType)).toContain("CustomerPattern");
    const text = renderReport(doc);
    expect(text).toMatch(/CustomerPattern\s+—/u);
    expect(text).not.toMatch(/CustomerPattern\s+100\.0%/u);
  });

  it("lists every wrong crossing with the sentence the rep would have read", () => {
    const text = renderReport(run(3, 1));
    expect(text).toContain("WHAT CROSSED WRONG (2");
    expect(text).toContain("the rep would have read:");
  });

  it("leads with the CLUSTER interval, and says what the binomial one assumes", () => {
    // Codex round 2. The rows treat crossings as independent trials; the
    // pass reads one chat per model call, so they are not. The report must
    // print the chat-day count and the wider interval, and must not present
    // the binomial one as the answer.
    const text = renderReport(run(20, 18));
    expect(text).toContain("clusters");
    expect(text).toContain("one read each");
    expect(text).toContain("binomial over crossings");
  });

  it("counts the MISATTRIBUTED ones in the heading — right content, wrong message", () => {
    // `run()` labels the first `correct` messages and crosses all of them,
    // so every extra crossing is a QuoteGiven on an unlabeled message of a
    // day that states QuoteGiven elsewhere: misattribution, by construction.
    expect(renderReport(run(3, 1))).toContain("of which 2 MISATTRIBUTED");
    // ...and the heading stays plain when none of them are.
    expect(renderReport(run(3, 3))).not.toContain("MISATTRIBUTED");
  });

  it("says nothing about wrong crossings when there are none", () => {
    expect(renderReport(run(3, 3))).not.toContain("WHAT CROSSED WRONG");
  });
});

/**
 * THE CONFIDENCE BAND IN THE REPORT (ticket #66, diagnosis half).
 *
 * #56 left `confidence` off `ScoredCrossing`, so the report could not
 * answer the first question anyone asks before touching a threshold: did
 * the wrong crossings sit near the gate. These pin that it now can — and
 * that it still refuses to propose a new gate, which is the second
 * dispatch's job and not this one's.
 */
describe("the confidence band (#66)", () => {
  it("records the gate the run was scored under, and proposes no other", () => {
    const doc = run(10, 8);
    expect(doc.confidence.gate).toBe(0.8);
    const text = renderReport(doc);
    expect(text).toContain("CONFIDENCE BAND");
    expect(text).toContain("recorded, not proposed");
    // No recommendation, no verdict on the threshold: this half of the
    // ticket is a diagnosis and a report that pre-committed to its own
    // remedy would not be one.
    expect(text).not.toMatch(/\brecommend/iu);
    expect(text).not.toMatch(/should be (raised|lowered|moved)/iu);
  });

  it("prints where the WRONG crossings sat, apart from where the correct ones did", () => {
    // Eight correct at 0.95 and two wrong at 0.99 — the shape that says a
    // threshold move could not have caught them.
    const text = renderReport(run(10, 8));
    expect(text).toMatch(/correct\s+8\s+95\.0%/u);
    expect(text).toMatch(/WRONG\s+2\s+99\.0%/u);
  });

  it("counts the middle band, and says zero when it is zero", () => {
    // Every candidate here is at 0.95 or 0.99, both above the band's top
    // edge of 0.9 — so nothing a threshold move could reach.
    const doc = run(10, 8);
    expect(doc.confidence.inMiddleBand).toBe(0);
    expect(renderReport(doc)).toMatch(/middle band\s+0 of 10/u);
  });

  it("brackets the top histogram band as CLOSED, because a 1.0 is counted", () => {
    // A `)` there would tell a reader that a confidence of exactly 1 fell
    // off the end of the histogram, which is the one value an emitter
    // suspected of living at the extremes is most likely to produce.
    const text = renderReport(run(10, 8));
    expect(text).toContain("[0.95, 1.00]");
    expect(text).not.toContain("[0.95, 1.00)");
  });

  it("prints the APERTURE's count of drops beside the workings (#218)", () => {
    // TWO COUNTS OF ONE THING. The workings are the candidates this run
    // read off its own submissions; the aperture's count is what the run
    // row recorded. The report says which is which, so a reader is never
    // left guessing whose number they are quoting.
    const doc = {
      ...run(10, 8),
      pass: {
        messages: 10,
        candidates: 13,
        filed: 10,
        belowThreshold: 3,
        unresolvedReference: 0,
        resolvedReference: 0,
        refused: 0,
      },
    };
    const text = renderReport(doc);
    expect(text).toContain("DROPPED BELOW GATE");
    expect(text).toContain("The aperture counted 3");
  });

  it("says so LOUDLY when the workings OVER-COUNT what the aperture recorded (#218)", () => {
    // THE ONE WAY THE TWO CAN DISAGREE NOW. The workings read every
    // candidate the model submitted below the gate; the aperture REFUSES
    // some before the gate reads them — a malformed payload, the
    // authorship fence, a message outside the window — and counts those
    // under `refused`. So the workings can exceed the pass's count, and a
    // reader comparing two adjacent numbers should not have to do the
    // subtraction to find out why.
    const base = run(10, 8);
    const doc = {
      ...base,
      droppedBelowGate: {
        candidates: [
          {
            transcriptId: "t1",
            messageId: "M9",
            factType: "OrderTaken",
            confidence: 0.5,
            reading: "stated" as const,
            labelled: true,
          },
        ],
        total: 1,
        labelled: 1,
      },
      pass: { ...base.pass, belowThreshold: 0, refused: 1 },
    };
    const text = renderReport(doc);
    expect(text).toContain("OVER-COUNTS BY 1");
    // ...and the drop itself is named, with the answer sheet's verdict.
    expect(text).toContain("M9");
    expect(text).toContain("LABELLED");
  });

  it("...and stays quiet when the two agree", () => {
    expect(renderReport(run(10, 8))).not.toContain("OVER-COUNTS");
  });

  it("refuses to call a SHORT count an over-count (Codex r1)", () => {
    // THE LINE THAT WAS FALSE IN BOTH THE WORD AND THE SIGN. While the row
    // was built over the scored slice and `pass` over every chat the run
    // read, a drop in the OTHER slice printed «OVER-COUNTS BY -1» beside
    // «the gate stopped nothing» — a durable artifact saying the workings
    // exceeded a count they were short of, next to a labelled total that
    // had quietly lost a drop. The aggregation is fixed at the source
    // (`labelDrops` over the whole run); this is the renderer refusing to
    // write the sentence at all.
    const base = run(10, 8);
    const doc = {
      ...base,
      droppedBelowGate: NO_DROPS,
      pass: { ...base.pass, belowThreshold: 1 },
    };
    const text = renderReport(doc);
    expect(text).not.toContain("OVER-COUNTS");
    expect(text).toContain("SHORT BY 1, WHICH THESE WORKINGS CANNOT BE");
    // ...and it does not claim the gate stopped nothing either, because the
    // aperture says it stopped one.
    expect(text).not.toContain("the gate stopped nothing");
  });

  it("carries a drop from a day the precision number does not cover (Codex r1)", () => {
    // The case the fix is FOR, through the renderer: `run()` scores one
    // transcript, and this row's drop is from another chat-day entirely —
    // a looking case, which the precision number deliberately excludes. It
    // still has to be in the row, and it still has to reconcile with the
    // aperture's count, because the gate read that day too.
    const base = run(10, 8);
    const doc = {
      ...base,
      droppedBelowGate: labelDrops({
        dropped: [
          {
            transcriptId: "l-pedido-pasado-mismo-chat",
            messageId: "LA-D1",
            factType: "OrderRequested",
            confidence: 0.79,
            reading: "resolved_reference" as const,
          },
        ],
        labels: [
          {
            transcriptId: "l-pedido-pasado-mismo-chat",
            label: {
              messageId: "LA-D1",
              factType: "OrderRequested",
              because: "the customer asks for the goods of a past order",
              checks: [{ path: "quantity", equals: 300 }],
            },
          },
        ],
      }),
      pass: { ...base.pass, belowThreshold: 1 },
    };
    const text = renderReport(doc);
    expect(text).toContain("labelled         1 of 1");
    expect(text).toContain("l-pedido-pasado-mismo-chat");
    expect(text).toContain("resolved_reference");
    // The two counts agree, so neither disagreement line prints.
    expect(text).not.toContain("OVER-COUNTS");
    expect(text).not.toContain("SHORT BY");
  });

  it("names the distinct values, so a vocabulary cannot pass for a scale", () => {
    const text = renderReport(run(10, 8));
    expect(text).toContain("distinct values");
    expect(text).toContain("0.95×8");
    expect(text).toContain("0.99×2");
  });

  it("breaks the band down per fact type, as AC 1 asks", () => {
    const text = renderReport(run(10, 8));
    expect(text).toMatch(/QuoteGiven\s+10 graded/u);
    // A type nothing was graded on is present and empty, never missing —
    // the same rule the precision table keeps.
    expect(text).toMatch(/DatePromised\s+0 graded/u);
  });
});

/**
 * The checked-in artifact, as a shape it can actually satisfy.
 *
 * `confidence` and `pass` stay OPTIONAL although the recorded run now
 * carries both (#121 re-ran the lane, and every run since #66 writes
 * them). The looseness is what let this file keep compiling across the two
 * tickets that could not re-run it, and it costs nothing: the tests below
 * assert the band's contents when it is there and say so when it is not,
 * which is a stronger claim than a type that insists.
 *
 * `maxTokens` joins them for the same reason (ticket #148): the two
 * `-before-*` reports below were frozen before the field existed and do
 * not carry one, and a type insisting on it would be describing those
 * files as something they are not.
 */
type RecordedReport = Omit<
  EvalReportDocument,
  | "confidence"
  | "pass"
  | "maxTokens"
  | "looking"
  | "cost"
  | "comparison"
  | "droppedBelowGate"
> &
  Partial<
    Pick<
      EvalReportDocument,
      | "confidence"
      | "pass"
      | "maxTokens"
      | "looking"
      | "cost"
      | "comparison"
      // The row ticket #218 added: every artifact frozen before it lacks
      // one, and a type insisting on it would describe those files as
      // something they are not.
      | "droppedBelowGate"
    >
  > & {
    /**
     * The corpus block a report frozen before #199 carries: no
     * `originalDigest`, because until the corpus widened there was one
     * corpus and one digest.
     */
    readonly corpus: Omit<EvalReportDocument["corpus"], "originalDigest"> &
      Partial<Pick<EvalReportDocument["corpus"], "originalDigest">>;
  };


describe("the checked-in report is the run it claims to be (AC 6)", () => {
  // The number is recorded in the repo so it is a DIFF somebody reviews
  // rather than a terminal line that scrolled away. That only works if the
  // file cannot drift from the corpus it was scored against, so the two are
  // compared here — a corpus edited without a re-run fails.
  //
  // TYPED AS WHAT IT IS, not as `EvalReportDocument` (spec review, #66).
  // The type promises only what a recorded artifact is guaranteed to hold:
  // a run older than #66's band carries no `confidence` and no `pass`, and
  // a cast to the full document type would be a claim the file might not
  // support. The run recorded here does carry both (#121 re-ran the lane),
  // and the band's own test asserts them rather than assuming them.
  const recorded = JSON.parse(
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../reports/extraction-precision.json",
      ),
      "utf8",
    ),
  ) as RecordedReport;

  /**
   * THE EQUALITY GUARD (tickets #66, #71, #99, #121; re-shaped at #194,
   * collapsed to one answer at #199).
   *
   * The guard says the recorded number and the shipped extractor are the same
   * pair — the corpus digest catches a label edited without a re-run, this
   * catches an EXTRACTOR edited without one, and together they stop a
   * recorded number describing an extractor the tree no longer has. It does
   * not assert the WORDING: ADR-0028 keeps extraction prose out of CI and
   * nothing here changes that.
   *
   * ONE ANSWER, AND WHAT IT TOOK TO GET BACK TO ONE. #194 moved the stamp
   * from the deleted harness's `EXTRACTION_CONTRACT_DIGEST` to the
   * automation's own and could not re-measure the corpus (the live lane needs
   * an API key), so for one ticket this accepted either — an artifact
   * measured against one extractor standing in as the result for another,
   * which is the very thing #71 and #99 each refused. The harness's side is
   * FROZEN as `extraction-precision-before-5b.json`, the committed report is
   * the automation's own live run, and the two were read as a PAIR until
   * #218 froze its own before and ended that pairing (the cases below).
   *
   * WHAT THE DIGEST STILL CANNOT SEE: what the model is SHOWN. #121 changed
   * the rendered turn without touching a byte the stamp covers, and the
   * automation's stamp has the same shape of limit — it covers the recipe
   * NAMES and never their rendered text. `extraction/definition.ts` records
   * it beside `extractionDigest`, and the answer to it is the
   * re-measurement this pair is.
   */
  it("was produced by the extractor in the tree, and by nothing else (#199, #364)", () => {
    expect(recorded.extractorDigest).toBe(
      extractionDigest({ model: recorded.model }),
    );
    // ...and the recorded run sent no effort, so the stamp above is computed
    // over the same arm the artifact names. A report carrying one would need
    // it in the digest's input, which is what `buildReport` does.
    expect(Object.hasOwn(recorded, "effort")).toBe(false);
  });

  /**
   * THE HARNESS'S OWN STAMP, AS A LITERAL (ticket #194).
   *
   * It is written down rather than computed because the code that computed
   * it is deleted: `EXTRACTION_CONTRACT_DIGEST` was sha256 over the system
   * prompt and the tool schema, and both went with the harness. Every report
   * in `reports/` predating #194 carries this value, and the assertions
   * below are what keep those artifacts readable — a frozen before-side whose
   * stamp nothing in the tree could name would be a number with no extractor.
   */
  const FROZEN_BEFORE_5B_DIGEST = "656dc5045290fcd6a9fafa2d8d96e427";

  /** The extractor the committed report measured — the last before #364's. */
  const FROZEN_BEFORE_364_DIGEST = "e2c885a2283128d763b83486297bbb0e";

  it("the frozen before-5b report is no longer the pair — #218 ended it, as #148 ended #139's", () => {
    // #199's PAIR IS OVER. `extraction-precision-before-5b.json` is the
    // harness's own stamp over these labels and this model, so what moved
    // across that pair was the runtime under the extractor. The current
    // report is read against #218's before instead, and reading it against
    // this one would put two changes inside one comparison — the mistake
    // #83 taught this corpus to refuse. Nothing rewrites the file; it stays
    // readable from the two digests recorded on #199.
    const before = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision-before-5b.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    expect(before.extractorDigest).toBe(FROZEN_BEFORE_5B_DIGEST);
    // It holds the labels and the model still, which is what made it a
    // pair; the report names a different file as its before.
    expect(before.corpus.digest).toBe(recorded.corpus.originalDigest);
    expect(before.model).toBe(recorded.model);
    expect(recorded.comparison?.beforeReport).toBe(
      "extraction-precision-before-364.json",
    );
  });

  it("the frozen before-6a report is no longer the pair — #364 ended it, moving the extractor (#218)", () => {
    // #218's PAIR HELD THE EXTRACTOR STILL, so what moved across it was the
    // aperture alone. #364 moved the extractor — the day's read became a run
    // of Dito's extraction, one child per chat-day filing through
    // `file_facts` — and the current report is read against #364's own
    // before. The file is still read: same labels, same model, the extractor
    // the before-364 side also carries.
    const before = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision-before-6a.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    expect(before.corpus.originalDigest).toBe(recorded.corpus.originalDigest);
    expect(before.model).toBe(recorded.model);
    expect(before.extractorDigest).toBe(FROZEN_BEFORE_364_DIGEST);
    expect(before.extractorDigest).not.toBe(recorded.extractorDigest);
    expect(recorded.comparison?.beforeReport).toBe(
      "extraction-precision-before-364.json",
    );
  });

  it("froze the before-364 side at the extractor #364 replaced, over the same labels, model and ceiling (#364)", () => {
    // THE PAIR IS A CLAIM ABOUT ONE MOVE: the committed report as it stood
    // when #364 opened, copied rather than re-run, against the live run of
    // the new extractor. The labels, the model and the ceiling are held
    // still; what is left between the two figures besides the move is the
    // live model's own variance.
    const before = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision-before-364.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    // THE ORIGINAL LABELS' DIGEST, not the widened corpus's (#199): the pair
    // is read over the days both sides share, which is what `buildReport`
    // refuses a report without.
    expect(before.corpus.originalDigest).toBe(recorded.corpus.originalDigest);
    expect(recorded.corpus.originalDigest).toBe(
      corpusDigest(SEED_TRANSCRIPTS),
    );
    expect(before.model).toBe(recorded.model);
    expect(before.maxTokens).toBe(recorded.maxTokens);
    expect(before.extractorDigest).toBe(FROZEN_BEFORE_364_DIGEST);
    expect(before.extractorDigest).not.toBe(recorded.extractorDigest);
    // ...and the artifact says which file it read as its before, so the pair
    // is named in the record rather than reconstructed by a reader.
    expect(recorded.comparison?.beforeReport).toBe(
      "extraction-precision-before-364.json",
    );
    expect(recorded.comparison?.beforeExtractorDigest).toBe(
      before.extractorDigest,
    );
  });

  it("the frozen before-59 report is a PRIOR corpus, so the pair is no longer controlled (#83)", () => {
    // `extraction-precision-before-59.json` was frozen to make ONE
    // comparison readable: same labels, older prompt, so #59's number was a
    // claim about the extractor and nothing else. An artifact whose whole
    // purpose is a controlled comparison should not be the one thing nobody
    // verifies (Codex r2 found it had no reader at all) — so it is still
    // read, and what it is checked against has changed.
    //
    // #83's RULING MOVED THE LABELS, and that ends the pairing rather than
    // weakening it. Four messages that were `silent` are `OrderRequested`
    // now, so the two files no longer share a corpus, and reading them side
    // by side would mix a grading change into an extractor result — which is
    // exactly the unreadable thing this file was frozen to prevent. The
    // check therefore asserts the CURRENT truth: same model, different
    // extractor, and a corpus the tree no longer has. #59's before/after is
    // still verifiable, from the two digests recorded on that issue and the
    // commits that carry them; what is gone is the ability to make the pair
    // out of one of these files and whatever the live lane wrote last.
    const before = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision-before-59.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    expect(before.corpus.digest).not.toBe(recorded.corpus.digest);
    expect(before.extractorDigest).not.toBe(recorded.extractorDigest);
    // THE MODEL PARTED COMPANY TOO, at #148. This used to assert
    // `before.model === recorded.model` — the one thing the pair still
    // had in common after #83 moved the labels. Extraction has since left
    // Haiku 4.5 for Sonnet 5, so the two files now differ in the corpus,
    // the extractor AND the model, and there is nothing left of the
    // controlled comparison this file was frozen to make. It is still
    // read, because an artifact nobody reads is one nobody notices
    // rotting (Codex r2 on #59 found exactly that), and what is asserted
    // is the current truth rather than a sameness that ended twice.
    expect(before.model).toBe("claude-haiku-4-5");
    expect(recorded.model).not.toBe(before.model);
  });

  /**
   * THE #139 PAIR, AND EXACTLY WHAT IT BINDS — which is the whole reason it
   * is a checked-in artifact rather than a number in a PR body (spec
   * review, #139).
   *
   * `extraction-precision-before-139.json` is the SAME corpus this tree
   * has, scored by the extractor as it stood at `origin/main` before this
   * ticket: same model, same labels. A precision claim is a claim about a
   * DIFFERENCE, and a difference reported only in prose is one nobody can
   * re-read against the tree — #59 froze its own before-side for exactly
   * that reason, and this asserts here what that file no longer can.
   *
   * THE EXTRACTOR DIGEST IS THE SAME ON BOTH SIDES, and that is the honest
   * shape of this pair rather than a defect in it. #139 briefly put a
   * paragraph in the prompt and then took it out on the owner's ruling, so
   * what ships is `renderDay` alone — every transcript beat stamped on the
   * rep's calendar — and the prompt is byte-identical either side. The
   * digest hashed the prompt and the tool schema and explicitly NOT
   * `renderDay` or `renderRepDay` (#121's remainder 6 named the limit
   * first), so these two files carry one digest and two numbers.
   *
   * WHICH MEANS THE PAIR RECORDS THE DIFFERENCE AND CANNOT BIND IT (Codex
   * r2/r3 on #139). Nothing in either artifact proves the before-side was
   * run without the beat stamps; its provenance is the commit it was made
   * at. The evidence that carries the rendering claim is the focused probe
   * recorded on #139, and the corpus days name their own instrument.
   * Widening the digest to cover the rendered turn would close it and is
   * NOT done: that is the tax `extractionDigest` argues against
   * beside itself, as the harness's digest did before it — every unrelated
   * refactor would invalidate the recorded number and demand an API-key
   * re-run to go green.
   *
   * The three properties below are asserted rather than described so the
   * artifact cannot quietly decay: edit the corpus without re-freezing this
   * side and the first goes red, and a prompt edit that lands without a
   * re-freeze reddens the third.
   */
  it("the frozen before-139 report shares the corpus and the PROMPT, and no longer the model — #148 ended that pair", () => {
    const before = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision-before-139.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    expect(before.corpus.digest).toBe(recorded.corpus.originalDigest);
    expect(before.extractorDigest).toBe(FROZEN_BEFORE_5B_DIGEST);
    // AND #148 BROKE THE THIRD LEG. The pair's whole claim was "same
    // corpus, same model, same prompt — so the difference is the
    // renderer". Extraction moved to Sonnet 5, so reading these two side
    // by side now mixes a MODEL change into a rendering result, which is
    // precisely the unreadable comparison #59 froze its own before-side to
    // avoid and which #83 had already inflicted on that file. The pair is
    // recorded as ended rather than quietly left to be misread; #139's
    // rendering claim is still carried by the focused probe on that issue
    // and by the days that name their own instrument.
    expect(before.model).toBe("claude-haiku-4-5");
    expect(recorded.model).not.toBe(before.model);
  });

  /**
   * THE #148 PAIR, AND IT IS THE BEST-CONTROLLED ONE IN THE DIRECTORY.
   *
   * `extraction-precision-before-148.json` is a Haiku 4.5 run of the
   * corpus in this tree, made on THIS branch — after `max_tokens` was
   * raised and the runner capped at one iteration, and against the
   * byte-identical prompt. So the before and after sides differ in ONE
   * variable, the model, which is more than #121's pair or #139's could
   * say: those two moved the renderer while the digest that would have
   * seen it looked elsewhere.
   *
   * WHICH OF THREE RUNS IS FROZEN, said plainly because it is a choice
   * somebody could otherwise make look better than it was: the MEDIAN of
   * the arm's three by precision (87.2 / 83.8 / 87.1 — the 87.1). Whole-
   * corpus precision is a noisy instrument, and freezing the best run
   * would have flattered the switch while the worst would have oversold
   * it. All three are recorded on #148.
   */
  it("the frozen before-148 report differs from the current one in the MODEL and nothing else", () => {
    const before = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision-before-148.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    // Held still: the labels and the extractor.
    expect(before.corpus.digest).toBe(recorded.corpus.originalDigest);
    expect(before.extractorDigest).toBe(FROZEN_BEFORE_5B_DIGEST);
    // ...and the ceiling, which is what makes this pair the model alone
    // rather than the model plus the budget it was given.
    expect(before.maxTokens).toBe(recorded.maxTokens);
    // Moved: the model, and only the model.
    expect(before.model).toBe("claude-haiku-4-5");
    expect(recorded.model).toBe("claude-sonnet-5");
    // Neither side sent an effort: the shipped arm is the model's own
    // default, so an effort on either would be a second moving part.
    // THE KEY IS ABSENT, not merely undefined (Codex r1). `toBeUndefined`
    // passes for a document that never had the field and for one that
    // carries it explicitly empty, and the default arm's whole claim is
    // that no effort was SENT. Own-property absence is what says that.
    expect(Object.hasOwn(before, "effort")).toBe(false);
    expect(Object.hasOwn(recorded, "effort")).toBe(false);
  });

  it("was scored against the corpus that is in the tree", () => {
    // The DIGEST is the load-bearing half (Codex r1). Counts do not move
    // when a label's expected value changes, a check is tightened, or a
    // transcript is reworded — so a report that matched only counts could
    // present an old number as the result for labels that no longer exist.
    expect(recorded.corpus.digest).toBe(corpusDigest(ALL_TRANSCRIPTS));
    expect(recorded.corpus.transcripts).toBe(ALL_TRANSCRIPTS.length);
    expect(recorded.corpus.messages).toBe(
      ALL_TRANSCRIPTS.reduce((n, t) => n + t.messages.length, 0),
    );
    expect(recorded.corpus.labels).toBe(
      ALL_TRANSCRIPTS.reduce((n, t) => n + t.labels.length, 0),
    );
  });

  it("carries the exclusions the manifest carries", () => {
    expect(recorded.corpus.excludedFactTypes).toEqual(EXCLUDED_FACT_TYPES);
  });

  it("names a real model and reaches the sizing rule", () => {
    expect(recorded.model.length).toBeGreaterThan(0);
    // THE SHIPPED CONFIGURATION, recorded (ticket #148 AC 3). The number
    // in this file must be the one the tree's own defaults produce, or the
    // artifact describes an extractor nobody runs.
    expect(recorded.model).toBe("claude-sonnet-5");
    expect(recorded.maxTokens).toBe(16_000);
    expect(Object.hasOwn(recorded, "effort")).toBe(false);
    expect(recorded.overall.crossed).toBeGreaterThanOrEqual(
      MIN_CROSSINGS_FOR_CONFIDENCE,
    );
    expect(recorded.underpowered).toBe(false);
  });

  it("carries the cluster count and interval, not only the binomial one", () => {
    // The recorded artifact has to show what the uncertainty rests on, or a
    // reader six months from now quotes the narrow number (Codex r2).
    expect(recorded.clusters).toBeGreaterThan(1);
    expect(recorded.clusters).toBeLessThanOrEqual(SEED_TRANSCRIPTS.length);
    expect(recorded.overallClusterInterval).toBeDefined();
    // It BRACKETS the estimate, and that is all that can be claimed. A
    // cluster bootstrap is wider than the binomial interval when facts
    // within a chat-day are correlated and about the same when they are
    // not — so "always wider" is not a property, and asserting it once
    // failed on real data. What matters is that the reported uncertainty
    // is computed over the right sampling unit, not that it is bigger.
    const cluster = recorded.overallClusterInterval!;
    expect(cluster.low).toBeLessThanOrEqual(recorded.overall.precision!);
    expect(cluster.high).toBeGreaterThanOrEqual(recorded.overall.precision!);
  });

  it("once the band HAS been measured, it agrees with the run it reports (#66)", () => {
    // Conditional on purpose. The recorded artifact predates the band, and
    // a test asserting its presence would be red until somebody with an
    // API key runs the live lane — which is a broken build, not a finding.
    // What it must never be is present and WRONG: a band whose filed count
    // disagreed with the crossings it was computed from would be a second
    // number about the same run, and the report's whole claim is that it
    // has one.
    const band = recorded.confidence;
    if (band === undefined) return;
    expect(band.gate).toBe(EXTRACTION_CONFIDENCE_THRESHOLD);
    expect(band.overall.filed.n + band.ungradedCrossings).toBe(
      recorded.overall.crossed,
    );
    expect(band.overall.correct.n).toBe(recorded.overall.correct);
    expect(band.overall.wrong.n + band.ungradedCrossings).toBe(
      recorded.wrong.length,
    );
    // THE ROW THIS TICKET ADDED (#218), and how it relates to the band
    // beside it — CONTAINMENT, not equality (Codex r1). The band grades the
    // candidates this report's own crossings came from, which is the
    // original labels' slice; the row is over every chat the run read,
    // because that is the population the aperture's `below_threshold`
    // counts. Asserting equality would be asserting that no looking day
    // ever loses a candidate to the gate, which is not a property of
    // anything.
    const row = recorded.droppedBelowGate;
    expect(row, "the recorded report carries the dropped-below-gate row").toBeDefined();
    expect(band.overall.dropped.n).toBeLessThanOrEqual(row!.total);
    // ...and the row's own reconciliation, in the only direction it can go:
    // the workings read every candidate the model submitted below the gate
    // and the aperture judged a subset of those submissions, so they can
    // over-count it and never fall short.
    if (recorded.pass !== undefined) {
      expect(row!.total).toBeGreaterThanOrEqual(recorded.pass.belowThreshold);
    }
    // Every false positive carries its own confidence, which is the number
    // the second dispatch is decided from.
    for (const wrong of recorded.wrong) {
      expect(wrong.confidence).not.toBeUndefined();
    }
  });

  it("names every wrong crossing it counted — a number with no workings is not a measurement", () => {
    expect(recorded.wrong.length).toBe(
      recorded.overall.crossed - recorded.overall.correct,
    );
    for (const wrong of recorded.wrong) {
      expect(wrong.disclosureText.length).toBeGreaterThan(0);
      expect(
        ALL_TRANSCRIPTS.some((t) => t.id === wrong.transcriptId),
        `${wrong.transcriptId} is not in the corpus`,
      ).toBe(true);
    }
  });
});

/**
 * WHAT THE RUN HAD TO ASK TWICE (ticket #146).
 *
 * The lane used to die when one chat's model call came back without the
 * tool, and the number that eventually got recorded came from whichever
 * rerun happened to go smoothly — so every figure in `reports/` is drawn
 * from the easy draws and no artifact says so. The retry is what makes the
 * run finish; this field is what stops it finishing silently.
 */
describe("the artifact says what the run had to ask twice (#146)", () => {
  it("records the retries and names the day each one cost", () => {
    const doc = run(10, 10, {
      total: 3,
      byTranscript: { "q-cotizacion-directa": 2, "n-tácticas-del-rep": 1 },
    });

    expect(doc.retries).toEqual({
      total: 3,
      byTranscript: { "q-cotizacion-directa": 2, "n-tácticas-del-rep": 1 },
    });
    const text = renderReport(doc);
    expect(text).toMatch(/retries\s+3 —/u);
    // NAMED, not just counted: a total tells a reader the run was rough
    // and nothing about where to go and look.
    expect(text).toContain("q-cotizacion-directa×2");
    expect(text).toContain("n-tácticas-del-rep×1");
  });

  it("prints a ZERO rather than staying silent, so a clean run is on the record", () => {
    // Silence would be indistinguishable from an artifact that predates
    // the field, which is the one thing this line must never be.
    expect(renderReport(run(10, 10, { total: 0, byTranscript: {} }))).toMatch(
      /retries\s+0 — every chat filed on its first read/u,
    );
  });

  it("reads a report recorded before #146, and calls it NOT RECORDED rather than zero", () => {
    // The three checked-in reports have no such field and none of them is
    // being regenerated for this ticket — regenerating one needs a key and
    // a model, and the frozen pair is a fixed comparison. So the reader
    // tolerates its absence, and says which of the two silences it is.
    const doc = preRetryCounting();
    expect(doc.retries).toBeUndefined();
    expect(renderReport(doc)).toMatch(/retries\s+not recorded — this report predates #146/u);
  });
});

/**
 * THE PAIR, THE LOOKING ROW AND WHAT LOOKING COST (ticket #199; spec #193
 * decisions 6, 11 and 30).
 *
 * #194 left one obligation open on this ticket by name: the committed report
 * carried the deleted harness's stamp, so the digest guard had to accept two
 * answers. Collapsing it to one equality is above; what is pinned here is
 * everything the artifact needs to make the pair READABLE — both digests,
 * the before's own numbers beside the after's, the looking row apart from
 * them, and the per-chat-day cost of the reads that the pair is about.
 */
describe("the pair is readable from the artifact alone (#199)", () => {
  it("refuses a pair whose two sides were scored against different labels", () => {
    // #83's lesson as a guard rather than a paragraph: relabelling moved four
    // messages and ended the #59 pair, because reading two numbers over two
    // corpora mixes a grading change into an extractor result. The corpus
    // WIDENED for this ticket, which is the same hazard arriving by the other
    // door — so the document may only be built when the before's digest is
    // this run's ORIGINAL-labels digest.
    expect(() =>
      buildReport({
        report: scoreCrossings({ crossings: [], labels: [], dropped: [] }),
        looking: NO_LOOKING,
        droppedBelowGate: NO_DROPS,
        before: { ...BEFORE, corpusDigest: "9".repeat(32) },
        cost: { total: ONE_ROUND, byTranscript: {} },
        model: "claude-sonnet-5",
        maxTokens: 16_000,
        ranAt: new Date("2026-09-06T00:00:00.000Z"),
        corpus: {
          transcripts: 1,
          messages: 1,
          labels: 0,
          digest: "0".repeat(32),
          originalDigest: ORIGINAL_DIGEST,
        },
        pass: {
          messages: 0,
          candidates: 0,
          filed: 0,
          belowThreshold: 0,
          unresolvedReference: 0,
          resolvedReference: 0,
          refused: 0,
        },
        retries: NO_RETRIES,
      }),
    ).toThrow(/scored against different labels/u);
  });

  it("refuses a pair whose two sides ran on different models", () => {
    // The pair holds the corpus and the MODEL still so the difference is the
    // extractor. #148 ended two earlier pairs exactly by moving the model,
    // and a document that recorded such a pair as a no-regression comparison
    // would be reporting a model switch as a migration result.
    expect(() =>
      buildReport({
        report: scoreCrossings({ crossings: [], labels: [], dropped: [] }),
        looking: NO_LOOKING,
        droppedBelowGate: NO_DROPS,
        before: { ...BEFORE, model: "claude-haiku-4-5" },
        cost: { total: ONE_ROUND, byTranscript: {} },
        model: "claude-sonnet-5",
        maxTokens: 16_000,
        ranAt: new Date("2026-09-06T00:00:00.000Z"),
        corpus: {
          transcripts: 1,
          messages: 1,
          labels: 0,
          digest: "0".repeat(32),
          originalDigest: ORIGINAL_DIGEST,
        },
        pass: {
          messages: 0,
          candidates: 0,
          filed: 0,
          belowThreshold: 0,
          unresolvedReference: 0,
          resolvedReference: 0,
          refused: 0,
        },
        retries: NO_RETRIES,
      }),
    ).toThrow(/different models/u);
  });

  it("states 'not below' without judging it, and says what else moved", () => {
    // ADR-0028 as amended: a drop is a finding for the boundary, never a
    // block. So the document carries the comparison and the renderer states
    // it — and neither may read as a verdict, which the PASS/FAIL guards
    // above already hold over the whole text.
    const doc = run(148, 148);
    expect(doc.comparison.notBelow).toBe(true);
    const text = renderReport(doc);
    expect(text).toContain("NOT BELOW");
    expect(text).toContain("97.3%");
    // The before's own interval is printed beside the after's, because a
    // point estimate without one is the sentence this report exists to
    // prevent somebody writing.
    expect(text).toMatch(/before\s+97\.3%\s+\[/u);
    // ...and what changed between the two runs, in the artifact's own
    // words. This pair holds the labels, the model and the ceiling still and
    // moves the extractor (ticket #364), so the note says what moved and what
    // did not.
    expect(doc.comparison.alsoChanged.length).toBeGreaterThan(2);
    expect(text).toContain("the extractor moved (#364)");
    expect(text).toContain("did NOT move");
  });

  it("says BELOW when the after estimate drops, and still blocks nothing", () => {
    const doc = run(148, 100);
    expect(doc.comparison.notBelow).toBe(false);
    const text = renderReport(doc);
    expect(text).toContain("BELOW the committed before");
    // IT STATES AND IT DOES NOT JUDGE: the boundary session reads the drop
    // and decides what it means, and nothing here blocks on it.
    expect(text).toContain("the boundary session reads this and decides");
    expect(text).toContain("nothing here blocks on it");
    expect(text).not.toMatch(/\bFAIL(ED|URE)?\b/u);
  });

  it("prints the looking row apart from the overall number, with its own n", () => {
    const doc = {
      ...run(10, 10),
      looking: {
        cases: [
          {
            transcriptId: "l-pedido-pasado-mismo-chat",
            outcome: "resolved-right" as const,
            leaked: false,
          },
          {
            transcriptId: "l-referencia-a-otro-cliente",
            outcome: "resolved-wrong" as const,
            leaked: true,
          },
          {
            transcriptId: "l-dos-candidatos-distintos",
            outcome: "dropped" as const,
            leaked: false,
          },
          {
            transcriptId: "l-referencia-a-nada",
            outcome: "dropped" as const,
            leaked: false,
          },
        ],
        crossed: 2,
        correct: 1,
        precision: 0.5,
        interval: { low: 0.09, high: 0.91 },
        leaks: 1,
        unmarked: 0,
        wrong: [
          {
            factId: "f-leak",
            transcriptId: "l-referencia-a-otro-cliente",
            messageId: "LB-D1",
            factType: "OrderRequested",
            reason: "check_failed" as const,
            detail: 'item should NOT contain "Ochoa", was "cemento de Ochoa"',
            failedCheck: "lacks" as const,
            disclosureText: "Te pidió 300 bultos de cemento de Ochoa.",
            confidence: 0.95,
          },
        ],
      },
    };
    const text = renderReport(doc);
    expect(text).toContain("LOOKING");
    expect(text).toContain("(  1/2  )");
    // Each case named with how it ended: a bare row cannot be argued with,
    // and the two drop cases are half of what these days measure.
    expect(text).toContain("l-dos-candidatos-distintos");
    expect(text).toContain("dropped");
    // The leak has its own line, because it is a different cost from a wrong
    // number: no correction unreads another customer's name (ADR-0004).
    expect(text).toMatch(/LEAKED\s+1/u);
    // ...and it is NAMED, with the predicate that caught it: a count nobody
    // can argue with is believed rather than read, which is the same
    // obligation the wrong-crossing list discharges for the original days.
    expect(text).toContain("(lacks)");
    expect(text).toContain('should NOT contain "Ochoa"');
    // ...and the overall number is untouched by any of it.
    expect(text).toContain("OVERALL");
    expect(doc.overall.crossed).toBe(10);
  });

  it("says zero leaks rather than staying silent about them", () => {
    // Silence would be indistinguishable from a report that does not measure
    // leaks at all, which is the one thing this line must never be.
    expect(renderReport(run(10, 10))).toMatch(/LEAKED\s+0/u);
  });

  it("records what each chat-day cost, and a total that equals its parts", () => {
    const doc = {
      ...run(10, 10),
      cost: {
        total: {
          toolCalls: 5,
          reads: 2,
          iterations: 5,
          tokensIn: 9_000,
          tokensOut: 400,
        },
        byTranscript: {
          "q-cotizacion-directa": {
            toolCalls: 2,
            reads: 1,
            iterations: 2,
            tokensIn: 4_000,
            tokensOut: 200,
          },
          "l-pedido-pasado-mismo-chat": {
            toolCalls: 3,
            reads: 1,
            iterations: 3,
            tokensIn: 5_000,
            tokensOut: 200,
          },
        },
      },
    };
    const text = renderReport(doc);
    expect(text).toContain("WHAT LOOKING COST");
    // The three the spec asks for, per chat-day and in total.
    expect(text).toMatch(/tool calls\s+5/u);
    expect(text).toMatch(/reads\s+2/u);
    expect(text).toMatch(/iterations\s+5/u);
    expect(text).toContain("9000 in");
    expect(text).toContain("400 out");
    // Per chat-day, because "the price of looking" is a claim about a day and
    // an average over a corpus where most days search nothing is not one.
    expect(text).toContain("l-pedido-pasado-mismo-chat");
  });

  it("carries a looking row and a cost for every chat-day the corpus has", () => {
    // THE ARTIFACT'S OWN CLAIM, over the file in the tree, and NOT conditional
    // on the fields being there: a committed report without them describes a
    // corpus the run did not cover, which is the defect this asserts against.
    // The three older `-before-*` artifacts predate the fields and are read
    // through `RecordedReport`, which is where the optionality belongs.
    const recorded = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../reports/extraction-precision.json",
        ),
        "utf8",
      ),
    ) as RecordedReport;
    const row = recorded.looking;
    expect(row).toBeDefined();
    expect(row!.cases.map((c) => c.transcriptId)).toEqual(
      LOOKING_TRANSCRIPTS.map((t) => t.id),
    );
    // A LEAK IS A WRONG CROSSING, by construction: the `lacks` predicate that
    // caught it is one of the label's own checks, so a day that leaked cannot
    // also have scored right — and a row saying otherwise would be reporting
    // a leak inside a healthy number.
    for (const one of row!.cases) {
      if (one.leaked) expect(one.outcome).toBe("resolved-wrong");
    }
    expect(row!.leaks).toBeLessThanOrEqual(row!.crossed);
    expect(row!.correct).toBeLessThanOrEqual(row!.crossed);
    // ...and no resolved fact went unmarked, or the rep was not told which
    // line to check harder (user story 2).
    expect(row!.unmarked).toBeLessThanOrEqual(row!.crossed);

    // EVERY CHAT-DAY, BY NAME, WITH EVERY FIELD, AND A TOTAL THAT EQUALS ITS
    // PARTS (Codex r2). Counting keys passes over a report whose every entry
    // is `{}` and whose totals are absent — a promised cost contract that the
    // rendering test cannot enforce, because that one builds its own complete
    // fixture.
    const cost = recorded.cost;
    expect(cost).toBeDefined();
    expect(Object.keys(cost!.byTranscript).sort()).toEqual(
      ALL_TRANSCRIPTS.map((t) => t.id).sort(),
    );
    const fields = [
      "toolCalls",
      "reads",
      "iterations",
      "tokensIn",
      "tokensOut",
    ] as const;
    const summed = { toolCalls: 0, reads: 0, iterations: 0, tokensIn: 0, tokensOut: 0 };
    for (const [transcriptId, day] of Object.entries(cost!.byTranscript)) {
      for (const field of fields) {
        expect(
          typeof day[field],
          `${transcriptId} carries no ${field}`,
        ).toBe("number");
        summed[field] += day[field];
      }
    }
    for (const field of fields) {
      expect(cost!.total[field], `the total's ${field}`).toBe(summed[field]);
    }
    // A run that read fifty-one chat-days made at least one round each, or
    // the corpus did not land — and the lane exits non-zero on that.
    expect(cost!.total.iterations).toBeGreaterThanOrEqual(
      ALL_TRANSCRIPTS.length,
    );
  });
});

/**
 * THE FOCUSED PER-DAY PROBE (ticket #148, AC 2 — the second instrument).
 *
 * WHY IT IS A SECOND INSTRUMENT AT ALL. Whole-corpus precision is one
 * number over 34 chat-days and roughly a hundred crossings, and the thing
 * this ticket is deciding — whether a weekday resolves to the right
 * calendar date — is seven of them. Three corpus runs on one unchanged
 * tree gave 89.9 / 85.1 / 90.0, so a two-point move in the date cases is
 * inside the corpus number's own noise and cannot be read off it. The
 * probe asks the narrow question directly and answers it per case, which
 * is what #121 and #139 both did and what makes their tables comparable
 * to this one.
 *
 * WHY IT IS IN THE TREE THIS TIME. #139 ran the same shape from a one-off
 * script that was deliberately not checked in, and the numbers recorded on
 * that issue therefore cannot be remade from this repository. Every number
 * this ticket reports has to be reproducible, so the instrument ships:
 * `pnpm --filter @dito/evals eval:probe-days`.
 *
 * THE CASES ARE NAMED HERE AND THE ANSWERS ARE NOT. Which labels are the
 * day cases is a judgement — these seven are the weekday readings the
 * three live sessions got wrong (#57, #69, #102) plus the two synthetic
 * days #139 authored before any wording existed. What each one should
 * answer is read out of the CORPUS LABEL, so a relabelling moves the probe
 * with it and a probe expectation can never quietly disagree with the
 * number the same tree reports. `dayProbeExpectations` throws rather than
 * skipping when a named label is gone: a probe that silently dropped a
 * case would report a smaller, cleaner table about less.
 *
 * NOTHING HERE RESOLVES A WEEKDAY. The expected dates are literals a human
 * wrote on the labels, read back; there is no calendar arithmetic in this
 * file and none anywhere else (Diego's standing ruling on #139, ADR-0037).
 */
import type { FactType } from "@dito/aperture";
import type { SeedTranscript } from "../corpus.ts";

/**
 * How one case came out in one run.
 *
 * FOUR, NOT THREE, and the fourth is the one a bare right/wrong table
 * hides. `absent` is the fact not crossing at all — the model said nothing
 * of that kind about that message, or the aperture refused it — which is
 * neither a right date nor a wrong one. #139's tally is "right / times the
 * fact crossed at all" for exactly this reason, and folding an absence
 * into `wrong` would blame a date reading for a recall wobble.
 *
 * `undated` is the fact crossing with no day in it. It is a legitimate
 * answer in one place only — H1's «para el domingo», which #139 measured
 * as sometimes dated and sometimes not, and never wrong — so it is
 * reported as its own column rather than scored, and the decision rule
 * says where it is allowed.
 */
export type DayOutcome = "right" | "undated" | "wrong" | "absent";

/** One weekday reading the probe grades, named by the label it grades. */
export interface DayProbeCase {
  readonly transcriptId: string;
  readonly messageId: string;
  readonly factType: FactType;
  /** What the case exercises, for the person reading the table. */
  readonly exercises: string;
  /**
   * True where a fact carrying no day is an allowed answer rather than a
   * miss — H1's «para el domingo» alone (#139: 0 of 4, then 2 of 4, then
   * 0 of 5 and 0 of 7 dated, never wrong).
   */
  readonly undatedAllowed: boolean;
}

/**
 * The seven readings, in the order they are reported.
 *
 * The first five are said on the corpus's Tuesday; the last two are said
 * on the Sunday two days earlier, which the pass reaches through an owed
 * window (`owedFromDaysAgo`). Between them they cover the three shapes:
 * a weekday said on a DIFFERENT weekday, a weekday said on ITS OWN
 * weekday, and a weekday whose answer is the very next day rather than the
 * next one after the pass's own.
 */
export const DAY_PROBE_CASES: readonly DayProbeCase[] = [
  {
    transcriptId: "d-lunes-en-martes",
    messageId: "R1-03",
    factType: "DatePromised",
    exercises: "«te los mando para el lunes», said on the Tuesday — #57's shape",
    undatedAllowed: false,
  },
  {
    transcriptId: "d-pedido-para-el-lunes",
    messageId: "R2-01",
    factType: "OrderRequested",
    exercises: "«te pido 50 bultos … para el lunes» — the customer's own day (#69)",
    undatedAllowed: false,
  },
  {
    transcriptId: "d-pedido-para-el-lunes",
    messageId: "R2-02",
    factType: "DatePromised",
    exercises: "«va, te los mando el lunes» — the rep's promise on the same day (#69)",
    undatedAllowed: false,
  },
  {
    transcriptId: "d-lunes-y-martes",
    messageId: "R3-02",
    factType: "DatePromised",
    exercises: "«Y mandártelos el lunes», said on the Tuesday (#102)",
    undatedAllowed: false,
  },
  {
    transcriptId: "d-lunes-y-martes",
    messageId: "R3-03",
    factType: "OrderRequested",
    exercises:
      "«Y unos 30 para el martes» — a weekday said on ITS OWN weekday (#102), right in no arm yet",
    undatedAllowed: false,
  },
  {
    transcriptId: "d-domingo-en-domingo",
    messageId: "H1-01",
    factType: "OrderRequested",
    exercises:
      "«para el domingo», said on a Sunday — the own-weekday convention off Tuesday (#139)",
    // The one case where an undated reading is an answer rather than a
    // miss: it has been dated and undated across #139's arms and wrong in
    // none of them.
    undatedAllowed: true,
  },
  {
    transcriptId: "d-lunes-desde-el-domingo",
    messageId: "H2-01",
    factType: "OrderRequested",
    exercises:
      "«el lunes», said on the Sunday and read on the Tuesday — the BEAT's own day (#139)",
    undatedAllowed: false,
  },
];

/**
 * Which payload field carries a fact's day.
 *
 * The same split `toPayload` makes and for the same reason (#70): the wire
 * has one date field, and it lands as a promise's `dueOn` or a commercial
 * fact's `requestedFor` because the two are different CLAIMS. A probe that
 * looked in one field would read a laundered date as a missing one.
 */
export function dateFieldOf(factType: string): "dueOn" | "requestedFor" {
  return factType === "DatePromised" ? "dueOn" : "requestedFor";
}

export function probeDate(
  factType: string,
  payload: Readonly<Record<string, unknown>>,
): string | null {
  const value = payload[dateFieldOf(factType)];
  return typeof value === "string" ? value : null;
}

/** One filed fact, as a probe run sees it after the walk back to its message. */
export interface ObservedDatedFact {
  readonly transcriptId: string;
  readonly messageId: string;
  readonly factType: string;
  /** The day it carries, or null when it carries none. */
  readonly date: string | null;
}

/** A case's key in every table this lane prints. */
export function dayCaseKey(probeCase: {
  readonly transcriptId: string;
  readonly messageId: string;
  readonly factType: string;
}): string {
  return `${probeCase.transcriptId}/${probeCase.messageId}/${probeCase.factType}`;
}

/**
 * The date each case must answer, read off the corpus label.
 *
 * NOT WRITTEN HERE, deliberately — see this file's docblock. It throws on a
 * case whose label is gone or carries no `equals` on its date field,
 * because both are a corpus edit that has silently changed what the probe
 * measures.
 */
export function dayProbeExpectations(
  cases: readonly DayProbeCase[],
  transcripts: readonly SeedTranscript[],
): Readonly<Record<string, string>> {
  const expected: Record<string, string> = {};
  for (const probeCase of cases) {
    const transcript = transcripts.find((t) => t.id === probeCase.transcriptId);
    if (transcript === undefined) {
      throw new Error(
        `the day probe names transcript ${probeCase.transcriptId}, which the corpus does not have`,
      );
    }
    const field = dateFieldOf(probeCase.factType);
    const dates = transcript.labels
      .filter(
        (label) =>
          label.messageId === probeCase.messageId &&
          label.factType === probeCase.factType,
      )
      .flatMap((label) =>
        label.checks.filter(
          (check) => check.path === field && "equals" in check,
        ),
      )
      .map((check) => (check as { readonly equals: string | number }).equals);
    if (dates.length !== 1 || typeof dates[0] !== "string") {
      throw new Error(
        `the day probe grades ${dayCaseKey(probeCase)} against its corpus label, and that label no longer states one ${field} date (found ${dates.length}) — a relabelling has changed what this probe measures`,
      );
    }
    expected[dayCaseKey(probeCase)] = dates[0];
  }
  return expected;
}

/**
 * How one case came out in one run.
 *
 * "Right when EVERY dated fact lands on the expected date": a message can
 * carry two readings of one kind, and one right and one wrong is not a
 * right answer. An undated fact beside a dated one does not spoil it —
 * the claim is about the days that were stated, and the undated column
 * exists for the case where NONE was.
 */
export function classifyDayCase(
  expected: string,
  facts: readonly ObservedDatedFact[],
): DayOutcome {
  if (facts.length === 0) return "absent";
  const dated = facts.filter((fact) => fact.date !== null);
  if (dated.length === 0) return "undated";
  return dated.every((fact) => fact.date === expected) ? "right" : "wrong";
}

/** One case's four counts over however many runs the lane made. */
export interface DayCaseTally {
  readonly right: number;
  readonly undated: number;
  readonly wrong: number;
  readonly absent: number;
  /** Every distinct date this case was answered with — the workings. */
  readonly answered: readonly string[];
}

/**
 * The whole table: every case, over every run.
 *
 * `runs` is one entry per run, each holding every dated fact that run
 * filed. A case with no facts in a run is `absent` for it, which is why
 * the runs are passed whole rather than pre-filtered per case.
 */
export function tallyDayProbe(
  cases: readonly DayProbeCase[],
  expected: Readonly<Record<string, string>>,
  runs: readonly (readonly ObservedDatedFact[])[],
): Readonly<Record<string, DayCaseTally>> {
  const table: Record<string, DayCaseTally> = {};
  for (const probeCase of cases) {
    const key = dayCaseKey(probeCase);
    const want = expected[key];
    if (want === undefined) {
      throw new Error(`the day probe has no expected date for ${key}`);
    }
    let right = 0;
    let undated = 0;
    let wrong = 0;
    let absent = 0;
    const answered: string[] = [];
    for (const run of runs) {
      const facts = run.filter(
        (fact) =>
          fact.transcriptId === probeCase.transcriptId &&
          fact.messageId === probeCase.messageId &&
          fact.factType === probeCase.factType,
      );
      for (const fact of facts) {
        if (fact.date !== null && !answered.includes(fact.date)) {
          answered.push(fact.date);
        }
      }
      switch (classifyDayCase(want, facts)) {
        case "right":
          right += 1;
          break;
        case "undated":
          undated += 1;
          break;
        case "wrong":
          wrong += 1;
          break;
        case "absent":
          absent += 1;
          break;
      }
    }
    table[key] = { right, undated, wrong, absent, answered };
  }
  return table;
}

/**
 * Whether an arm HOLDS the probe — the ticket's decision rule, in one
 * place so the PR body and the lane cannot disagree about it.
 *
 * THE PROBE HALF ONLY. The ticket's rule has a second half — "and does
 * not regress corpus precision below the worst of the Haiku arm's three
 * runs" — which is the OTHER instrument's to answer, so nothing here
 * reports it and the lane says which half it is printing. A function that
 * announced a verdict on half the evidence would be the lane deciding
 * something the ticket reserved for the person reading both tables.
 *
 * "Every weekday case right in all three runs; undated allowed only for
 * H1." An `absent` is not a pass: a case whose fact never crossed was
 * never answered, and an arm that stopped filing the fact would otherwise
 * hold the probe by saying nothing.
 */
export function probeHeld(
  cases: readonly DayProbeCase[],
  table: Readonly<Record<string, DayCaseTally>>,
  runs: number,
): boolean {
  return cases.every((probeCase) => {
    const cell = table[dayCaseKey(probeCase)];
    if (cell === undefined) return false;
    const acceptable =
      cell.right + (probeCase.undatedAllowed ? cell.undated : 0);
    return acceptable === runs;
  });
}

/**
 * THE SCORER (ticket #56). Deterministic, and that is the design claim:
 * nothing here consults a model. A measurement whose judge is the thing
 * being measured is not a measurement, and this number is the one NFR-3's
 * ≥95% bar is denominated in.
 *
 * PRECISION IS OVER WHAT CROSSED. The denominator is facts the aperture
 * FILED — read back out of the Ledger, through the aperture's own reader,
 * after the confidence gate has had its say. A candidate the gate STOPPED
 * is not in it: it never crossed, so it was never a precision failure. It
 * cost the record a fact the twin was unsure of, which is the trade FR-31
 * makes on purpose, and it is reported separately as `droppedBelowGate` so
 * the trade is a number rather than merely honoured (ticket #218).
 *
 * RECALL IS REPORTED AND IS NOT THE BAR. A label nothing filed is a
 * missed fact, and this slice's whole fail-safe direction prefers that to
 * a wrong one. It is here so a later tightening of the gate cannot buy
 * precision by crossing almost nothing and have the report look better
 * for it.
 */
import {
  EXTRACTION_CONFIDENCE_THRESHOLD,
  FACT_TYPES,
  type CandidateReading,
  type FactType,
} from "@dito/aperture";
import {
  distributionOf,
  gradedCrossings,
  type ConfidenceDistribution,
  type GradedCandidate,
} from "./confidence.ts";
import { BY_REFERENCE_MARK } from "@dito/twin-runtime";
import type { FactCheck, FactLabel, SeedTranscript } from "./corpus.ts";

/**
 * One fact that CROSSED, as read back out of the Ledger and walked to the
 * message it was read in.
 *
 * `messageId` is the join: the aperture stamps every fact with the seam
 * row it was read in, and the seam row carries the WhatsApp message id.
 * So the walk from a Ledger row to the transcript line that produced it is
 * stored data end to end, with no model and no heuristic in it.
 */
export interface ScoredCrossing {
  readonly factId: string;
  readonly transcriptId: string;
  readonly messageId: string;
  readonly factType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** What the rep was told, carried so a wrong crossing can be read as prose. */
  readonly disclosureText: string;
  /**
   * What the model said about its own reading — the confidence the
   * aperture stored on the filed fact, which is the number the gate judged
   * (ticket #66; #56 remainder, #59).
   *
   * NULLABLE because the column is: a fact filed by a REP ACT has no model
   * confidence, and #66's question is about the ones that do. A null is
   * counted apart and never folded in as a zero.
   */
  readonly confidence: number | null;
}

/**
 * ONE CANDIDATE THE GATE STOPPED BELOW THE THRESHOLD, as a run can observe
 * it (ticket #218).
 *
 * READ OFF THE SUBMISSION THE MODEL MADE, and classified by the aperture's
 * own `gateVerdict` — because there is nowhere else to read it. A dropped
 * candidate reaches no store: the question store was the only place the
 * below-gate half could be read back, and it went with the route (spec #214
 * decision 3). The run row's `below_threshold` counts the drops and names
 * none of them.
 *
 * IT IS BETTER EVIDENCE THAN A STORE, in the one way that matters here. The
 * candidate-question store asked once per (message, KIND of claim), so a
 * second below-gate reading of one sentence left no row and no sample. The
 * submission carries every candidate the model proposed, so the band holds
 * one sample per candidate; what the report says instead is when the WORKINGS
 * exceed the pass's count, which is a candidate the aperture refused before
 * the gate ever read it.
 */
export interface ObservedDrop {
  readonly transcriptId: string;
  readonly messageId: string;
  /** The kind of claim the twin was unsure about — for the per-type band. */
  readonly factType: string;
  /**
   * The confidence the candidate carried — the number the gate judged, as
   * the model put it on the words.
   */
  readonly confidence: number;
  /**
   * How the model read the message, as the aperture's own closed set names
   * it: `stated` or `resolved_reference`, never `unresolved_reference` — that
   * reading is the gate's OTHER ending and is counted apart.
   */
  readonly reading: CandidateReading;
}

/** A label, carrying the transcript it belongs to. */
export interface PlacedLabel {
  readonly transcriptId: string;
  readonly label: FactLabel;
}

/**
 * Why a crossing did not count. Named, so a low number can be READ rather
 * than merely believed — which matters most for a measurement that gates
 * nothing and exists to be argued with.
 *
 * `misattributed` was added after the first live run, and it does NOT
 * soften the rule: a crossing must match a label on the message it CITES,
 * because the cited message is what the disclosure line's provenance shows
 * the rep («su chat, 27 ago 19:23») and what they would open to check the
 * claim. A fact whose content is right and whose provenance is one message
 * off still sends the rep to the wrong moment, and that citation is still
 * the anchor the ADR-0033 invariant walks.
 *
 * What it changes is only that the report can SAY which kind of wrong a
 * crossing was. The first live run had 2 of 7 false positives be an order
 * read correctly and filed against the acknowledgement that answered it
 * («sale», «perfecto») — a different defect from resolving a date nobody
 * stated, and a reader who cannot tell them apart cannot act on either.
 */
export type WrongReason =
  /** Nothing in the corpus says this message states any fact. */
  | "no_label_for_message"
  /**
   * Nothing labels the cited message, but this transcript labels the same
   * KIND of fact on another one — the content may well be right and the
   * provenance is wrong. Still a false positive; see the note above.
   */
  | "misattributed"
  /** The message states facts, but none of this kind. */
  | "no_label_for_type"
  /** A label of this kind exists here and one of its checks failed. */
  | "check_failed"
  /** Its label was already claimed by an earlier crossing — a duplicate. */
  | "label_already_matched"
  /**
   * A LOOKING day's fact whose LINE does not say the goods were inferred
   * (ticket #199; spec #193 decision 2; user story 2).
   *
   * The scorer's own arms above all judge the PAYLOAD against a label. This
   * one judges the sentence the rep reads, and only on the days whose values
   * can only have come from an earlier day: a model that submits the right
   * goods under `reading: "stated"` gets no «(por referencia)» mark, so the
   * rep is not told which line to check more carefully — and grading the
   * payload alone would score that as a clean resolution. Produced by
   * `scoreLooking` and by nothing else.
   */
  | "unmarked_reference";

/**
 * WHICH PREDICATE A LABEL'S FAILING CHECK WAS — `FactCheck`'s six shapes,
 * named (ticket #199).
 *
 * A `check_failed` says the values disagreed and not HOW, and on a looking
 * day the how is two different findings: a wrong quantity is a misreading the
 * rep corrects inside the window, and the referent's name in `item` is chat
 * identity crossing the wall (ADR-0004; Diego's ruling on #206's remainder
 * 3). Only the `lacks` shape carries that second claim, so the looking row
 * counts leaks off this word rather than off the detail sentence.
 */
export type FactCheckShape =
  | "equals"
  | "equalsAll"
  | "absentOrEquals"
  | "contains"
  | "lacks"
  | "absent";

export interface WrongCrossing {
  readonly factId: string;
  readonly transcriptId: string;
  readonly messageId: string;
  readonly factType: string;
  readonly reason: WrongReason;
  /** What disagreed, or the empty string when the reason needs no sentence. */
  readonly detail: string;
  /**
   * The shape of the check that failed, on a `check_failed` — see
   * `FactCheckShape`. Absent when the reason needs no check.
   */
  readonly failedCheck?: FactCheckShape;
  /** What the rep was told — the sentence a reviewer actually judges. */
  readonly disclosureText: string;
  /**
   * How sure the twin was about the thing it got WRONG (ticket #66).
   *
   * Carried per false positive, not only as a summary, because the summary
   * cannot answer the question a reader actually has: could a threshold
   * have caught THIS one. A wrong crossing at 0.99 is out of any gate's
   * reach; one at 0.81 is a different ticket entirely.
   */
  readonly confidence: number | null;
}

/**
 * ONE DROP, WITH THE ANSWER SHEET'S VERDICT ON IT (ticket #218).
 *
 * The workings behind the *dropped below gate* row, the way `wrong` is the
 * workings behind the precision number. A bare count of drops cannot be
 * argued with, and the one thing a reader most wants to know about a drop
 * is whether the corpus says there was a fact there.
 *
 * NO TEXT. The candidate's own words are the model's and the diagnosis does
 * not need them; where it was read, what kind of claim it was, how sure the
 * twin was, how it read the message and whether a label backs it are the
 * whole of what a reader wants.
 */
export interface DroppedCandidate extends ObservedDrop {
  /**
   * WHETHER THE CORPUS LABELS A FACT OF THIS KIND ON THIS MESSAGE — the
   * recall the gate cost, per drop.
   *
   * IT IS NOT THE SAME CLAIM AS `recall`, and the difference is worth
   * stating: `recall` is correct crossings over every label, so it counts
   * every label nothing filed for ANY reason — a refusal, a message the
   * extractor said nothing about, a wrong value. This says the narrower
   * thing, which is the one the gate is answerable for: the model proposed
   * this fact, the corpus agrees a fact of this kind was stated here, and
   * the THRESHOLD is what stopped it.
   */
  readonly labelled: boolean;
}

/**
 * THE *DROPPED BELOW GATE* ROW (ticket #218; spec #214 decision 1 — "the
 * eval report gains a labelled *dropped below gate* row so recall loss is
 * measured").
 *
 * ITS OWN ROW AND NEVER INSIDE THE PRECISION TABLE. Precision is over what
 * CROSSED (ADR-0016; NFR-3), and a drop crossed nothing — folding drops in
 * would let a gate that dropped everything post a beautiful number about
 * almost nothing, which is the failure the row exists to make visible.
 *
 * IT IS OVER THE WHOLE RUN AND IS NOT A PRECISION FIGURE, which is why
 * `labelDrops` builds it once rather than `scoreCrossings` building one per
 * scored slice (Codex r1). The precision number is deliberately over the
 * original labels alone — that is what makes the before/after pair a claim
 * about the extractor rather than about a corpus that grew — but the gate
 * reads every chat the run reads, and `extraction_runs.below_threshold`
 * counts every one of them. A row scoped to one slice would leave a drop in
 * the OTHER slice invisible while the aperture's count included it, and the
 * looking cases are exactly where the reading this ticket newly drops lives.
 */
export interface DroppedBelowGateRow {
  /** Every drop this run observed, in the order the submissions made them. */
  readonly candidates: readonly DroppedCandidate[];
  /** How many — the workings' own total, read against the pass's count. */
  readonly total: number;
  /** ...and of those, how many a label backs. THE recall-loss number. */
  readonly labelled: number;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/**
 * THE *DROPPED BELOW GATE* ROW, BUILT ONCE OVER THE WHOLE RUN (ticket #218;
 * Codex r1).
 *
 * ONE POPULATION, ONE ROW. The two numbers a reader compares are this row's
 * `total` and `extraction_runs.below_threshold`, and the aperture counted
 * every chat the run read. So this is handed EVERY drop and EVERY label the
 * run has — not one scored slice's — and the two arrive from the same list
 * of placed chats, which is what keeps a partition from ever separating
 * them again. A slice-scoped row hid a labelled drop in the looking cases
 * while the aperture's count included it, and printed a negative over-count
 * beside "the gate stopped nothing".
 *
 * IT IS NOT A PRECISION FIGURE and it is not the scorer: no label is
 * claimed, no crossing is judged, and nothing here reaches `overall`. The
 * guarantee that a looking day cannot move the before/after number is
 * `scoreCrossings` never being shown those labels, and that is untouched.
 */
export function labelDrops(input: {
  readonly dropped: readonly ObservedDrop[];
  readonly labels: readonly PlacedLabel[];
}): DroppedBelowGateRow {
  // Keyed on (transcript, message, type), which is what a CROSSING has to
  // match to claim a label — so asking it about a drop asks the same
  // question of the same answer sheet: did the corpus say a fact of this
  // kind was stated in this message.
  const claimable = new Set(
    input.labels.map((placed) =>
      key(placed.transcriptId, placed.label.messageId, placed.label.factType),
    ),
  );
  const candidates = input.dropped.map(
    (drop): DroppedCandidate => ({
      ...drop,
      labelled: claimable.has(
        key(drop.transcriptId, drop.messageId, drop.factType),
      ),
    }),
  );
  return {
    candidates,
    total: candidates.length,
    labelled: candidates.filter((drop) => drop.labelled).length,
  };
}

export interface PrecisionCell {
  readonly crossed: number;
  readonly correct: number;
  /** Undefined when nothing crossed — an empty denominator is not a 0 or a 1. */
  readonly precision: number | undefined;
  /** 95% Wilson interval on `precision`, absent when there is no denominator. */
  readonly interval: Interval | undefined;
}

export interface PrecisionReport {
  readonly overall: PrecisionCell;
  /**
   * INDEPENDENT UNITS behind the overall number — transcripts that produced
   * at least one crossing, which is the same as MODEL CALLS, because the
   * pass reads one chat per call.
   *
   * Reported because it is the n that the uncertainty actually rests on
   * (Codex round 2). 89 crossings from 34 chat-days are not 89 independent
   * trials: a busy day contributes four or five facts from ONE call, and
   * when that call goes wrong they tend to go wrong together.
   */
  readonly clusters: number;
  /**
   * A 95% interval on overall precision that treats each TRANSCRIPT as the
   * sampling unit — the one computed over the right thing. It is WIDER than
   * the binomial interval on `overall` when facts within a chat-day are
   * correlated, and about the same when they are not; "always wider" is not
   * a property and is not claimed. Undefined when nothing crossed.
   */
  readonly overallClusterInterval: Interval | undefined;
  /** Total over every fact type, INCLUDING the ones nothing crossed on. */
  readonly byFactType: Readonly<Record<string, PrecisionCell>>;
  readonly wrong: readonly WrongCrossing[];
  /** Labels in the corpus slice this run covered. */
  readonly labelsTotal: number;
  /** Correct crossings over labels — recall. Reported, never the bar. */
  readonly recall: number | undefined;
  /**
   * HOW SURE THE TWIN WAS, over every graded candidate this run can see
   * (ticket #66).
   *
   * Beside the precision table rather than inside it, because it answers a
   * different question. Precision says how often what crossed was right;
   * this says whether the gate had anything to work with — and #66's claim
   * is that it did not, in three runs.
   */
  readonly confidence: ConfidenceDistribution;
}

/**
 * ONE COMPOSITE KEY BUILDER, and it exists because the alternative bit.
 *
 * Three lookups here key on a tuple — (transcript, message), (transcript,
 * kind), (transcript, message, kind) — and each was building its own
 * template literal. Two of them ended up with different separators, so a
 * label went into one index and could not be found in another, and every
 * correct crossing scored as a false positive. The number was WRONG and
 * nothing about it looked wrong.
 *
 * NUL because no id in this system can contain one, so `("a b", "c")` and
 * `("a", "b c")` cannot collide — and one function because the separator
 * being consistent is the whole property.
 */
function key(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

/**
 * THE 95% WILSON SCORE INTERVAL on a proportion.
 *
 * Wilson rather than the textbook normal approximation, and the reason is
 * this exact measurement: the normal interval is worthless near p = 1 —
 * at 10/10 it reports [1, 1], which would let a ten-crossing run claim the
 * bar outright. Wilson does not degenerate there, so a perfect small run
 * reports a lower bound well below 1 and the reader can see that n is
 * doing the work.
 *
 * Undefined on an empty denominator, deliberately: there is no interval
 * on nothing, and returning [0, 1] would read as a measurement.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
): Interval | undefined {
  if (trials <= 0) return undefined;
  const z = 1.959963984540054; // two-sided 95%
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const spread =
    (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) /
    denom;
  return {
    low: Math.max(0, centre - spread),
    high: Math.min(1, centre + spread),
  };
}

/**
 * A small deterministic PRNG (mulberry32). Seeded from a constant, because
 * a bootstrap whose interval moved between two runs over identical data
 * would undo the reproducibility the fixed corpus and fixed clock exist to
 * provide.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A 95% CLUSTER BOOTSTRAP interval on precision, resampling TRANSCRIPTS
 * rather than crossings (Codex round 2).
 *
 * The Wilson interval on `overall` treats every crossing as an independent
 * trial. They are not: the pass reads one chat per model call, so a busy
 * day's four or five facts share a call, and a call that misreads the day
 * moves them together. Pooling them into a binomial interval reports more
 * confidence than the design supports — and `underpowered: false` would be
 * resting on it.
 *
 * So the unit resampled here is the chat-day. It is the interval the report
 * leads with — not because it is always wider (it is wider exactly when the
 * correlation is real) but because it is the one computed over the unit the
 * sampling actually has.
 */
function clusterInterval(
  outcomes: readonly { transcriptId: string; correct: boolean }[],
  /**
   * EVERY chat-day the run evaluated, including the ones that produced no
   * crossing at all (Codex round 3). Building the frame from outcomes alone
   * conditioned the interval on "days that filed something" — the checked
   * report had 34 model calls and 29 clusters — which is a different
   * population from the one the corpus samples, and a narrower one.
   */
  frame: readonly string[],
): Interval | undefined {
  if (outcomes.length === 0) return undefined;
  const byCluster = new Map<string, boolean[]>();
  // Seeded with the WHOLE frame, so a day that crossed nothing is a real
  // draw that contributes no trials rather than a day that did not happen.
  for (const id of frame) byCluster.set(id, []);
  for (const o of outcomes) {
    const bucket = byCluster.get(o.transcriptId);
    if (bucket === undefined) byCluster.set(o.transcriptId, [o.correct]);
    else bucket.push(o.correct);
  }
  // Sorted, so the resample depends on the DATA and not on Map ordering.
  const clusters = [...byCluster.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  if (clusters.length < 2) return undefined;

  const RESAMPLES = 4000;
  // A fixed seed: the interval must not move between two runs over
  // identical data.
  const random = mulberry32(0x5eed_c0de);
  const estimates: number[] = [];
  for (let b = 0; b < RESAMPLES; b += 1) {
    let correct = 0;
    let total = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const picked = clusters[Math.floor(random() * clusters.length)]!;
      for (const ok of picked) {
        total += 1;
        if (ok) correct += 1;
      }
    }
    // A resample that drew only empty days has no estimate to contribute —
    // discarded rather than counted as 0, which would be a precision claim
    // about a sample containing no crossings.
    if (total > 0) estimates.push(correct / total);
  }
  if (estimates.length === 0) return undefined;

  // THE DEGENERATE CASE, and it is the one that matters most (Codex round
  // 3). When every outcome agrees, every resample is identical and the
  // percentile bootstrap returns [1, 1] — recreating exactly the
  // small-perfect-run overclaim Wilson was chosen to avoid, on the interval
  // the report tells the reader to quote. A bootstrap cannot see
  // uncertainty a sample does not exhibit, so when it exhibits none the
  // answer comes from the cluster COUNT instead: Wilson over k chat-days,
  // which at two all-correct days is about [0.34, 1] rather than [1, 1].
  const first = estimates[0]!;
  if (estimates.every((e) => e === first)) {
    const successes = first >= 1 ? clusters.length : 0;
    return wilsonInterval(successes, clusters.length);
  }

  estimates.sort((a, b) => a - b);
  const pick = (q: number): number =>
    estimates[
      Math.min(estimates.length - 1, Math.max(0, Math.round(q * (estimates.length - 1))))
    ]!;
  return { low: pick(0.025), high: pick(0.975) };
}

function cell(correct: number, crossed: number): PrecisionCell {
  return {
    crossed,
    correct,
    precision: crossed === 0 ? undefined : correct / crossed,
    interval: wilsonInterval(correct, crossed),
  };
}

/**
 * Folds accents and case so a `contains` check survives the model's own
 * orthography. The transcripts are es-MX and the model writes es-MX back;
 * «sábado» and «SABADO» are the same word and a scorer that disagreed
 * would be measuring keyboards.
 *
 * EXPORTED so `corpus.test.ts`'s guards compare a label's token the way the
 * scorer will actually grade it (ticket #61). It held a byte-for-byte copy
 * under the comment «the scorer's own folding», which stops being true the
 * day this function changes — a guard that claims to speak for the scorer
 * has to be the scorer.
 */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Reads `a.b.0` out of a stored payload. Undefined for any missing step. */
function at(
  payload: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  let cursor: unknown = payload;
  for (const step of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(step);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return cursor;
}

/**
 * A failing check: what disagreed, and which of `FactCheck`'s shapes said so.
 *
 * The SHAPE rides beside the sentence rather than being parsed back out of
 * it (ticket #199): the looking row's leak count is a claim about the `lacks`
 * predicate, and a count that matched «should NOT contain» in prose would
 * change meaning the day somebody reworded a message.
 */
interface CheckFailure {
  readonly detail: string;
  readonly shape: FactCheckShape;
}

/** The first failing check, described — or undefined when every one passes. */
function firstFailure(
  payload: Readonly<Record<string, unknown>>,
  checks: readonly FactCheck[],
): CheckFailure | undefined {
  for (const check of checks) {
    const actual = at(payload, check.path);
    // FIRST, because it is the only shape that reads a SECOND field and its
    // operator is `contains`: the plain `contains` arm at the bottom would
    // otherwise claim it and judge one field alone.
    if ("orIn" in check) {
      const also = at(payload, check.orIn);
      const wanted = fold(check.contains);
      const carries = (value: unknown): boolean =>
        typeof value === "string" && fold(value).includes(wanted);
      if (!carries(actual) && !carries(also)) {
        return {
          shape: "contains",
          detail: `${check.path} or ${check.orIn} should contain ${JSON.stringify(check.contains)}, and neither does: ${JSON.stringify(actual)} / ${JSON.stringify(also)}`,
        };
      }
      continue;
    }
    if ("absent" in check) {
      if (actual !== undefined && actual !== null) {
        return {
          shape: "absent",
          detail: `${check.path} should be absent, was ${JSON.stringify(actual)}`,
        };
      }
      continue;
    }
    if ("equalsAll" in check) {
      // A missing arm and an empty arm are the same claim: nothing of this
      // kind crossed. Order does not matter; MEMBERSHIP and COUNT do, since
      // every element is a merge key.
      const got =
        actual === undefined || actual === null
          ? []
          : Array.isArray(actual)
            ? actual
            : [actual];
      const want = [...check.equalsAll].map(fold).sort();
      const have = got.map((v) => fold(String(v))).sort();
      if (have.length !== want.length || have.some((v, i) => v !== want[i])) {
        return {
          shape: "equalsAll",
          detail: `${check.path} should be exactly ${JSON.stringify(check.equalsAll)}, was ${JSON.stringify(actual ?? [])}`,
        };
      }
      continue;
    }
    if ("absentOrEquals" in check) {
      // Absent is fine; present-and-different is not. The predicate for a
      // value the day states but the twin need not repeat.
      if (actual === undefined || actual === null) continue;
      const same =
        typeof check.absentOrEquals === "number"
          ? Number(actual) === check.absentOrEquals
          : typeof actual === "string" &&
            fold(actual) === fold(check.absentOrEquals);
      if (!same) {
        return {
          shape: "absentOrEquals",
          detail: `${check.path} should be absent or equal ${JSON.stringify(check.absentOrEquals)}, was ${JSON.stringify(actual)}`,
        };
      }
      continue;
    }
    if ("equals" in check) {
      // Numbers compare numerically: a `numeric` column round-trips as a
      // string through pg, and 4500 and "4500" are the same price.
      const same =
        typeof check.equals === "number"
          ? Number(actual) === check.equals
          : typeof actual === "string" && fold(actual) === fold(check.equals);
      if (!same) {
        return {
          shape: "equals",
          detail: `${check.path} should equal ${JSON.stringify(check.equals)}, was ${JSON.stringify(actual)}`,
        };
      }
      continue;
    }
    if ("lacks" in check) {
      // The dual of `contains`, and the only check whose job is what a
      // model-composed clause must NOT have picked up (ticket #61, Codex
      // r1). An ABSENT field satisfies it: a field that was never filed
      // carries nothing, and the shapes that judge presence are the other
      // four.
      if (
        typeof actual === "string" &&
        fold(actual).includes(fold(check.lacks))
      ) {
        return {
          shape: "lacks",
          detail: `${check.path} should NOT contain ${JSON.stringify(check.lacks)}, was ${JSON.stringify(actual)}`,
        };
      }
      continue;
    }
    if (typeof actual !== "string" || !fold(actual).includes(fold(check.contains))) {
      return {
        shape: "contains",
        detail: `${check.path} should contain ${JSON.stringify(check.contains)}, was ${JSON.stringify(actual)}`,
      };
    }
  }
  return undefined;
}

/**
 * Scores one run: every crossing against the labels of the transcript it
 * came from.
 *
 * A LABEL IS CLAIMED AT MOST ONCE. Two crossings of the same fact are one
 * true positive and one false positive — filing a thing twice is filing a
 * thing wrong, and an append-only store makes the second one permanent.
 *
 * Crossings are scored in the order given, which the caller fixes
 * (transcript id, then fact id) so the run is reproducible: with two
 * identical crossings, WHICH one is the duplicate is arbitrary but the
 * COUNT never is.
 */
export function scoreCrossings(input: {
  readonly crossings: readonly ScoredCrossing[];
  readonly labels: readonly PlacedLabel[];
  /**
   * What the gate stopped below the threshold among THESE crossings'
   * candidates, off the run's own submissions (ticket #218) — see
   * `ObservedDrop`.
   *
   * FOR THE CONFIDENCE BAND, which is the only thing here that reads them:
   * the band is over the candidates this report's crossings came from, so
   * its drops are that same population's. The *dropped below gate* ROW is a
   * different population and is built by `labelDrops` over the whole run
   * (Codex r1) — see `DroppedBelowGateRow`.
   */
  readonly dropped: readonly ObservedDrop[];
  /**
   * Every transcript the run EVALUATED — one model call each — including
   * those that produced no crossing.
   *
   * The sampling frame, and it has to be given rather than derived: a day
   * whose facts the gate all stopped, or one that correctly filed nothing,
   * is a real draw from the population the corpus samples, and inferring
   * the frame from the crossings drops it (Codex round 3).
   * Defaults to the transcripts that did cross, so a caller with no frame
   * gets the old behaviour rather than a crash.
   */
  readonly clusterIds?: readonly string[];
}): PrecisionReport {
  const { crossings, labels, dropped } = input;

  // (transcript, message) → this message's labels, and (transcript,
  // message, type) → the ones a crossing of that type may claim.
  const byMessage = new Set(
    labels.map((l) => key(l.transcriptId, l.label.messageId)),
  );
  // Which kinds this transcript labels ANYWHERE — what separates "the twin
  // invented a fact" from "the twin read a real fact off the wrong line".
  const kindInTranscript = new Set(
    labels.map((l) => key(l.transcriptId, l.label.factType)),
  );
  const claimable = new Map<string, PlacedLabel[]>();
  for (const placed of labels) {
    const bucketKey = key(
      placed.transcriptId,
      placed.label.messageId,
      placed.label.factType,
    );
    const bucket = claimable.get(bucketKey);
    if (bucket === undefined) claimable.set(bucketKey, [placed]);
    else bucket.push(placed);
  }
  const claimed = new Set<PlacedLabel>();

  const wrong: WrongCrossing[] = [];
  /**
   * Per crossing: which chat-day it came from, whether it was right, and
   * how sure the twin was — one record, because the cluster bootstrap and
   * the confidence band are two readings of the same per-crossing outcome
   * and keeping two parallel arrays is how they drift apart.
   */
  const outcomes: {
    transcriptId: string;
    correct: boolean;
    factType: string;
    confidence: number | null;
  }[] = [];
  const correctByType = new Map<string, number>();
  const crossedByType = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };

  const record = (
    crossing: ScoredCrossing,
    reason: WrongReason,
    detail: string,
    /**
     * Which predicate said so, on a `check_failed` and nowhere else: the
     * other reasons run no check, and a shape on one of them would claim a
     * predicate failed that never ran (ticket #199).
     */
    failedCheck?: FactCheckShape,
  ): void => {
    wrong.push({
      factId: crossing.factId,
      transcriptId: crossing.transcriptId,
      messageId: crossing.messageId,
      factType: crossing.factType,
      reason,
      detail,
      // Spread, so a wrong crossing that failed no CHECK carries no key
      // rather than an explicit null. The distinction survives into the
      // committed artifact, where a leak is counted off this word (#199).
      ...(failedCheck === undefined ? {} : { failedCheck }),
      disclosureText: crossing.disclosureText,
      confidence: crossing.confidence,
    });
  };

  /**
   * One crossing's outcome, in the one shape both readings consume.
   *
   * Named for the SCORER's verdict, not the pass's: `settleRun` in the
   * extraction pass means something else entirely — moving an
   * `extraction_runs` row to its final state — and two "settles" in one
   * domain is one too many.
   */
  const recordOutcome = (crossing: ScoredCrossing, correct: boolean): void => {
    outcomes.push({
      transcriptId: crossing.transcriptId,
      correct,
      factType: crossing.factType,
      confidence: crossing.confidence,
    });
  };

  // GROUPED BEFORE MATCHING, because which crossing claims which label is a
  // MATCHING problem and not a scan (Codex r1). Where a message states two
  // facts of one kind and one crossing satisfies both labels, a
  // first-come scan can hand it the label the other crossing needed and
  // score one where two were right — and the answer would then depend on
  // the order the labels happen to be written in, which is not a property
  // a reported number may have (AC 4: the run is reproducible).
  const groups = new Map<string, ScoredCrossing[]>();
  for (const crossing of crossings) {
    const typeKey = key(
      crossing.transcriptId,
      crossing.messageId,
      crossing.factType,
    );
    const bucket = groups.get(typeKey);
    if (bucket === undefined) groups.set(typeKey, [crossing]);
    else bucket.push(crossing);
  }

  for (const [typeKey, group] of groups) {
    for (const crossing of group) bump(crossedByType, crossing.factType);
    const candidates = claimable.get(typeKey) ?? [];
    if (candidates.length === 0) {
      for (const crossing of group) unlabeled(crossing);
      continue;
    }

    // Which labels each crossing could honestly claim, and why it could not
    // claim the ones it could not — kept so a loser can still be told
    // WHICH check failed rather than only that it lost.
    const satisfies: number[][] = [];
    const failures: (CheckFailure | undefined)[] = [];
    for (const crossing of group) {
      const ok: number[] = [];
      let lastFailure: CheckFailure | undefined;
      for (const [index, candidate] of candidates.entries()) {
        const failure = firstFailure(crossing.payload, candidate.label.checks);
        if (failure === undefined) ok.push(index);
        else lastFailure = failure;
      }
      satisfies.push(ok);
      failures.push(lastFailure);
    }

    // MAXIMUM MATCHING (Kuhn's augmenting paths). Exact rather than greedy,
    // so the number of correct crossings in this group is a property of the
    // group and not of the order anything was written in. Groups are two or
    // three items, so the cost is irrelevant and the exactness is not.
    const labelTakenBy = new Array<number>(candidates.length).fill(-1);
    const tryAssign = (crossingIndex: number, seen: boolean[]): boolean => {
      for (const labelIndex of satisfies[crossingIndex]!) {
        if (seen[labelIndex] === true) continue;
        seen[labelIndex] = true;
        const holder = labelTakenBy[labelIndex]!;
        if (holder === -1 || tryAssign(holder, seen)) {
          labelTakenBy[labelIndex] = crossingIndex;
          return true;
        }
      }
      return false;
    };
    const matchedCrossing = new Array<boolean>(group.length).fill(false);
    for (let i = 0; i < group.length; i += 1) {
      if (tryAssign(i, new Array<boolean>(candidates.length).fill(false))) {
        // Recomputed from the assignment afterwards: an augmenting path can
        // move an EARLIER crossing onto a different label, so "did i get
        // one" is only answerable once the whole group has run.
      }
    }
    for (const holder of labelTakenBy) {
      if (holder !== -1) matchedCrossing[holder] = true;
    }

    for (const [index, crossing] of group.entries()) {
      if (matchedCrossing[index] === true) {
        claimed.add(candidates[labelTakenBy.indexOf(index)]!);
        bump(correctByType, crossing.factType);
        recordOutcome(crossing, true);
        continue;
      }
      recordOutcome(crossing, false);
      // Unmatched, and the two reasons are different things to a reader: it
      // satisfied no label here at all, or it satisfied one that another
      // crossing of this group had the better claim to — which is the
      // duplicate case, and filing a thing twice in an append-only store is
      // filing it wrong.
      if (satisfies[index]!.length === 0) {
        record(
          crossing,
          "check_failed",
          failures[index]?.detail ?? "",
          failures[index]?.shape,
        );
      } else {
        record(crossing, "label_already_matched", "");
      }
    }
  }

  /** A crossing whose (message, kind) carries no label at all: why not. */
  function unlabeled(crossing: ScoredCrossing): void {
    recordOutcome(crossing, false);
    const messageKey = key(crossing.transcriptId, crossing.messageId);
    if (byMessage.has(messageKey)) {
      record(crossing, "no_label_for_type", "");
      return;
    }
    if (kindInTranscript.has(key(crossing.transcriptId, crossing.factType))) {
      // A fact of this kind IS stated in this day — just not in the message
      // the twin cited. Counted wrong, and said so distinctly.
      record(
        crossing,
        "misattributed",
        `no label on ${crossing.messageId}, though this day states a ${crossing.factType} elsewhere`,
      );
      return;
    }
    record(crossing, "no_label_for_message", "");
  }

  const frame = [
    ...new Set(
      input.clusterIds ?? crossings.map((c) => c.transcriptId),
    ),
  ].sort();

  const totalCrossed = crossings.length;
  const totalCorrect = [...correctByType.values()].reduce((a, b) => a + b, 0);

  const byFactType: Record<string, PrecisionCell> = {};
  // Every declared type gets a row, including the ones nothing crossed on:
  // a MISSING row reads as "fine" and an empty one does not (AC 4 asks for
  // the number per fact type, and silence is not a number).
  const types = new Set<string>([...FACT_TYPES, ...crossedByType.keys()]);
  for (const type of [...types].sort()) {
    byFactType[type] = cell(
      correctByType.get(type) ?? 0,
      crossedByType.get(type) ?? 0,
    );
  }

  // BOTH SIDES OF THE GATE (ticket #66, re-sourced at #218): the crossings
  // out of the Ledger, and the drops off the run's own submissions. The
  // crossings carry the scorer's verdict as well; a drop carries none,
  // because a candidate that never crossed was never judged against a label
  // and calling it wrong would be scoring the gate for doing its job.
  // Whether a LABEL backs it is a different claim and is on the row below.
  const graded: GradedCandidate[] = [
    ...gradedCrossings(outcomes),
    ...dropped.map((drop) => ({
      factType: drop.factType,
      confidence: drop.confidence,
      crossed: false,
      correct: undefined,
    })),
  ];

  return {
    overall: cell(totalCorrect, totalCrossed),
    clusters: frame.length,
    overallClusterInterval: clusterInterval(outcomes, frame),
    byFactType,
    wrong,
    labelsTotal: labels.length,
    recall: labels.length === 0 ? undefined : totalCorrect / labels.length,
    confidence: distributionOf({
      candidates: graded,
      // READ FROM THE APERTURE, never restated: a report that carried its
      // own copy of the gate could describe a threshold the run did not
      // use, which is exactly the mistake this ticket exists to avoid.
      gate: EXTRACTION_CONFIDENCE_THRESHOLD,
      factTypes: FACT_TYPES,
      ungradedCrossings: outcomes.filter((o) => o.confidence === null).length,
    }),
  };
}

/**
 * HOW ONE LOOKING DAY ENDED (ticket #199; ADR-0039 as amended; ticket #218).
 *
 * Three words for the three endings a day whose fact can only be read by
 * resolving a reference can have, and each is a different finding:
 *
 * - `resolved-right` — a fact crossed and every check passed. Looking paid.
 * - `resolved-wrong` — a fact crossed and did not match. The expensive
 *   ending: a wrong order in the rep's record, which is what FR-31 trades
 *   recall to avoid.
 * - `dropped` — nothing crossed, which is CORRECT on the two days whose
 *   reference cannot be settled and a recall loss on the two that can.
 *
 * THERE IS NO FOURTH WORD FOR A DAY THE GATE STOPPED (ticket #218). This row
 * carried a `questioned` ending so as not to read the gate working as the
 * looking failing, on ADR-0039's amendment of 2026-09-06; the accepted
 * decision is spec #214 decision 1 and its question principle — an unsure
 * resolution is still a hole in the twin's record — so such a day is
 * `dropped` like any other, and *dropped below gate* is where the drop is
 * named rather than here. That ADR is re-cut in the docs PR at the boundary.
 */
export type LookingOutcome =
  | "resolved-right"
  | "resolved-wrong"
  | "dropped";

/** One looking day: how it ended, and whether the referent leaked. */
export interface LookingCase {
  readonly transcriptId: string;
  readonly outcome: LookingOutcome;
  /**
   * Whether what was filed carried the referent — a `lacks` check that
   * failed, which `FactCheckShape` above argues.
   *
   * A leak is ALSO a wrong crossing, so it is inside `resolved-wrong` rather
   * than a fifth word: the outcome says the record is wrong and this says
   * which kind of wrong, the same split `WrongReason` makes for the original
   * days.
   */
  readonly leaked: boolean;
}

/**
 * THE LOOKING ROW — the four new days, reported apart from the original
 * number (spec #193 decision 11).
 *
 * Its own n, its own estimate and its own interval, because the two
 * populations answer different questions: the original labels say what the
 * migration did to precision on the same labels, and these say whether
 * looking pays at all. Folding them together would move the before/after
 * comparison by ADDING material, which is the unreadable pair #83 taught
 * this corpus to refuse.
 */
export interface LookingRow {
  /** One per looking day, in the order the corpus declares them. */
  readonly cases: readonly LookingCase[];
  readonly crossed: number;
  readonly correct: number;
  /** Undefined when nothing crossed — an empty denominator is not a 0 or a 1. */
  readonly precision: number | undefined;
  /** 95% Wilson interval on `precision`, absent when there is no denominator. */
  readonly interval: Interval | undefined;
  /**
   * Facts that carried the referent into what was filed.
   *
   * ITS OWN COUNT AND NOT A SHARE OF THE PRECISION, because it is a
   * different cost. A wrong quantity is a number the rep corrects inside the
   * window; a referent's name in `item` is another customer's identity in
   * this customer's record, and no correction unreads it (ADR-0004).
   */
  readonly leaks: number;
  /**
   * Facts a looking day filed whose LINE does not say the goods were
   * inferred — see `WrongReason`'s `unmarked_reference`.
   *
   * Its own count beside the leaks, and for the same reason: it is a
   * different cost. A leak puts another customer in this customer's record;
   * an unmarked resolution puts a correct record in front of a rep with
   * nothing saying which lines to check harder (user story 2).
   */
  readonly unmarked: number;
  /**
   * Every false positive these days produced, with the predicate that
   * caught it — the workings behind the numbers above.
   *
   * The same obligation `PrecisionReport.wrong` discharges for the original
   * days: a low number nobody can argue with is believed rather than read.
   * It is what says WHICH field carried the referent and what it said, which
   * neither `leaks` nor a case's `leaked` can.
   */
  readonly wrong: readonly WrongCrossing[];
}

/**
 * Reads the looking row off a run already scored.
 *
 * THE SCORING IS THE SAME SCORING, and that is the decision: a looking day's
 * labels are graded by `scoreCrossings` like any other day's — a resolved
 * fact's checks are the goods the referent named — and this only arranges
 * what came out. A second grader for these four days would be a second
 * answer sheet, and the one thing a corpus may not have is two.
 *
 * `transcripts` is the FRAME and has to be given: a day that correctly filed
 * nothing produced no crossing and no question, so inferring the frame from
 * what came out would drop the two drop cases — which are half of what these
 * days measure (the same argument `clusterIds` makes above). It is the
 * transcripts and not their ids because the leak sweep reads each day's own
 * `neverFiled`.
 *
 * `report` IS THE LOOKING SLICE'S OWN — `scoreCrossings` over these
 * transcripts' crossings and labels and nothing else — because the row's
 * correct count is its crossings less its false positives. A report scored
 * over the whole corpus would subtract the original days' wrong crossings
 * from these days' n, which is how a looking row would come to report the
 * original number's mistakes.
 */
export function scoreLooking(input: {
  readonly report: PrecisionReport;
  readonly crossings: readonly ScoredCrossing[];
  readonly transcripts: readonly SeedTranscript[];
}): LookingRow {
  const { report, crossings, transcripts } = input;
  // THE TOKENS AS THE CORPUS DECLARED THEM, folded only to compare: the
  // detail below quotes them back, and a reader looking for «Lucero» in the
  // corpus should not have to recognise «lucero».
  const forbidden = new Map(
    transcripts.map((t) => [t.id, t.neverFiled ?? []]),
  );

  // THE SWEEP, OVER WHAT WAS FILED RATHER THAN OVER THE LABELS (Codex r1).
  // `firstFailure` stops at the first failing check, a crossing of an
  // unlabelled type runs no checks, and the two days that must file nothing
  // have no labels at all — so a leak reached the record unmeasured in three
  // ways. This looks at every string the aperture stored, whatever type it
  // is and whether or not a label claims it: what the row must never hide is
  // a filed field naming another customer (ADR-0004).
  const leaks: WrongCrossing[] = [];
  for (const crossing of crossings) {
    const carried = (forbidden.get(crossing.transcriptId) ?? []).filter(
      (token) =>
        [...filedStrings(crossing.payload)].some((value) =>
          fold(value).includes(fold(token)),
        ),
    );
    if (carried.length === 0) continue;
    leaks.push({
      factId: crossing.factId,
      transcriptId: crossing.transcriptId,
      messageId: crossing.messageId,
      factType: crossing.factType,
      reason: "check_failed",
      detail: `what was filed carries ${JSON.stringify(carried)}, which names the referent this day resolved from`,
      failedCheck: "lacks",
      disclosureText: crossing.disclosureText,
      confidence: crossing.confidence,
    });
  }

  // THE MARK, ON THE DAYS WHOSE VALUES CAME FROM AN EARLIER ONE (Codex r2).
  // A model may submit the right goods under `reading: "stated"`, and the
  // aperture then renders a line with no «(por referencia)» on it — so the
  // rep is not told the goods were inferred and does not know to check that
  // line harder (user story 2). It is graded only where the corpus says a
  // fact was there to resolve, because a day that must file NOTHING has no
  // correct crossing to mark.
  const resolving = new Set(
    transcripts.filter((t) => t.labels.length > 0).map((t) => t.id),
  );
  const unmarked: WrongCrossing[] = crossings
    .filter(
      (crossing) =>
        resolving.has(crossing.transcriptId) &&
        !crossing.disclosureText.includes(BY_REFERENCE_MARK),
    )
    .map((crossing) => ({
      factId: crossing.factId,
      transcriptId: crossing.transcriptId,
      messageId: crossing.messageId,
      factType: crossing.factType,
      reason: "unmarked_reference",
      detail: `the line the rep reads carries no ${BY_REFERENCE_MARK}, so nothing tells them the goods were inferred rather than said`,
      disclosureText: crossing.disclosureText,
      confidence: crossing.confidence,
    }));

  // ONE CROSSING IS WRONG ONCE, AND SAYS BOTH THINGS. A fact the scorer
  // already rejected — for a wrong value, or for a message no label names —
  // keeps that REASON and takes the sweep's predicate and tokens, because two
  // entries for one fact would read as two false positives and dropping the
  // sweep's would lose the leak's name on exactly the crossings the labels
  // could not catch.
  const named = new Set(report.wrong.map((w) => w.factId));
  const leakByFact = new Map(leaks.map((w) => [w.factId, w]));
  const leakedIds = new Set(leaks.map((w) => w.factId));
  const unmarkedIds = new Set(unmarked.map((w) => w.factId));
  const wrongIds = new Set([...named, ...leakedIds, ...unmarkedIds]);

  const cases = transcripts.map((transcript): LookingCase => {
    const mine = crossings.filter((c) => c.transcriptId === transcript.id);
    const leaked = mine.some((c) => leakedIds.has(c.factId));
    if (mine.length > 0) {
      return {
        transcriptId: transcript.id,
        // ANY wrong crossing makes the day wrong — a leak included, whatever
        // the labels said about it. A day that filed one correct fact and one
        // naming another customer has put that name in the rep's record, and
        // reading it as `resolved-right` would report the half that went well.
        outcome: mine.some((c) => wrongIds.has(c.factId))
          ? "resolved-wrong"
          : "resolved-right",
        leaked,
      };
    }
    return {
      transcriptId: transcript.id,
      // NOTHING CROSSED, whichever way it ended (#218). A gate that
      // stopped this day's candidate says so in the report's own *dropped
      // below gate* row, where the drop is named and labelled; this row is
      // about what the LOOKING produced.
      outcome: "dropped",
      leaked,
    };
  });

  const crossed = crossings.length;
  const correct = crossed - wrongIds.size;
  return {
    cases,
    crossed,
    correct,
    precision: crossed === 0 ? undefined : correct / crossed,
    interval: wilsonInterval(correct, crossed),
    leaks: leakedIds.size,
    unmarked: unmarkedIds.size,
    wrong: [
      ...unmarked.filter((w) => !named.has(w.factId) && !leakedIds.has(w.factId)),
      ...report.wrong.map((w): WrongCrossing => {
        const leak = leakByFact.get(w.factId);
        if (leak === undefined) return w;
        return {
          ...w,
          failedCheck: "lacks",
          detail: w.detail === "" ? leak.detail : `${leak.detail}; and ${w.detail}`,
        };
      }),
      ...leaks.filter((w) => !named.has(w.factId)),
    ],
  };
}

/**
 * Every string the aperture stored on this fact, however deep.
 *
 * EVERY FIELD AND NOT ONLY THE PROSE ONES, which is the fail-closed
 * direction: `PROSE_FIELDS` says which fields a LABEL must pin, and a sweep
 * that trusted that table would miss a referent written into a field nobody
 * classified — including a type this build does not know. The shape is the
 * aperture's own `everyString`, which sweeps a payload for chat identity for
 * the same reason (ADR-0004).
 */
function* filedStrings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* filedStrings(item);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) yield* filedStrings(item);
  }
}

/** Re-exported so a caller need not import the aperture to iterate types. */
export type { FactType };

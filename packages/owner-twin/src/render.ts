/**
 * The rendered turn: what the room draws, built from the rows the tools
 * served (ticket #130; spec #126 decision 18; #134, variant A).
 *
 * THE MODEL WROTE THE WORDS AND CODE WROTE EVERY VALUE. The answer's
 * prose carries slots; this fills each one from the row its reference names,
 * through `@dito/aperture`'s owner renderers — the same functions Líneas de
 * tiempo renders with, so a value in an answer and the same value on a
 * timeline page cannot read differently.
 *
 * NOTHING HERE IS A SENTENCE, AND THAT IS DELIBERATE. The receipt strip's
 * labels, the pills' words and the day dividers are the ROOM's chrome and
 * belong to #131 (ADR-0037 as amended exempts the owner web's chrome by
 * name). What this returns is the structure under them: which segments are
 * prose and which are references, which class each reference renders as,
 * and what each receipt line's five fields say. So this module holds no
 * es-MX string at all — every Spanish word in its output came out of a
 * renderer in `@dito/aperture` or off a row.
 *
 * THE RECEIPT IS THE PRODUCT'S ONE CITATION GRAMMAR (#134, variant A —
 * «Recibo al pie»): one line per served fact under the prose, so the answer
 * reads as one object rather than an answer plus an exhibit. A count gets a
 * line too, and its line is the one that differs: a count has no single
 * confidence, so what it carries instead is its window and the statement
 * that the window is closed.
 */
import {
  renderOwnerEntityName,
  renderOwnerFact,
  renderOwnerFactLine,
  renderOwnerFactTypeLabel,
  renderOwnerInstant,
  type OwnerRenderedFact,
} from "@dito/aperture";
import { slotPattern } from "./prose.js";
import { referenceClass, type ServedRow, type ServedRows } from "./served.js";
import type { OwnerAnswer, OwnerAnswerKind } from "./answer.js";

/**
 * A reference no run served, reached at render time.
 *
 * UNREACHABLE THROUGH THE EXECUTION PATH, and kept anyway as the one honest
 * answer to "render a value from a row that is not there": the structural
 * guard refuses every unserved citation before an answer is accepted, so
 * this can only fire if a caller renders an answer the guard never saw.
 * Throwing is what keeps the two in step — a renderer that quietly dropped
 * the slot would turn a broken citation into a missing word nobody notices.
 */
export class OwnerRenderError extends Error {
  override readonly name = "OwnerRenderError";
}

/** One piece of a rendered line: prose the model wrote, or a value code filled. */
export type RenderedSegment =
  | { readonly kind: "prose"; readonly text: string }
  | {
      readonly kind: "reference";
      readonly ref: number;
      /** #134's two: a provenance value carries a gutter square, a name does not. */
      readonly referenceClass: "provenance-value" | "reference-name";
      /** Which served shape it is, so the room can style a count apart from a fact. */
      readonly of: ServedRow["kind"];
      readonly text: string;
    };

/** One line of the receipt strip: what a cited row is and where it came from. */
export type ReceiptLine =
  | {
      readonly kind: "fact";
      readonly ref: number;
      /** ADR-0004's five, in the order the spec fixes, plus the fact's own tag. */
      readonly typeLabel: string;
      readonly sourceType: string;
      readonly seat: string;
      readonly occurred: string;
      readonly filed: string;
      readonly confidence: string;
    }
  | {
      readonly kind: "count";
      readonly ref: number;
      readonly typeLabel: string;
      /**
       * The seat this count was narrowed to, or null when it was over
       * every seat. NULL IS "NOT NARROWED", never "not recorded" — the two
       * are different statements and `renderOwnerSeat`'s words are for the
       * second one.
       */
      readonly seat: string | null;
      /** The window's ends as the owner reads them; null where it is open. */
      readonly from: string | null;
      readonly to: string | null;
      /**
       * A count has no confidence, so this is what its line says instead:
       * the window holds only finalized facts.
       *
       * ALWAYS TRUE, AND TRUE BY CONSTRUCTION rather than by clamping (the
       * two-axis review's Spec axis asked what enforces it). `countOwnerFacts`
       * counts `ledger.finalized_facts` and nothing else, so whatever window
       * the model asked for, what was counted is finalized — the upper bound
       * is finalization itself, which is a property of a pass on the other
       * side of the wall and not a number this side can compute.
       *
       * WHAT THAT LEAVES OWED, recorded rather than papered over: `to` is
       * null when the model asked for no upper bound, so the room has no
       * instant to print at the window's end. #134 puts the words there —
       * «ventana · cerrada · solo datos firmes» — and they say exactly this
       * flag's fact. Whether the room should render a boundary INSTANT as
       * well is #131's, and it is on the remainder.
       */
      readonly windowClosed: true;
    };

/** A record the room renders as a pill: the refusal's pointer, the ask's choices. */
export interface RenderedRecord {
  readonly ref: number;
  readonly entityId: string;
  readonly displayName: string;
}

/** One turn, ready to draw. */
export interface RenderedOwnerTurn {
  readonly kind: OwnerAnswerKind;
  readonly prose: readonly RenderedSegment[];
  /** One line per cited fact and count, in the order the answer listed them. */
  readonly receipt: readonly ReceiptLine[];
  /** FR-46's third part, composed by the twin and rendered like prose. */
  readonly followUp: readonly RenderedSegment[] | null;
  /** FR-46's middle part: the timeline the owner may open instead. */
  readonly timeline: RenderedRecord | null;
  /** ADR-0039's candidates, when this turn is the one legitimate ask. */
  readonly candidates: readonly RenderedRecord[];
}

/**
 * The turn, rendered.
 *
 * Every value comes off a served row and none off the answer: the
 * answer contributes its words, its kind, and the references that say
 * which rows those values are.
 */
export function renderOwnerTurn(
  answer: OwnerAnswer,
  served: ServedRows,
  timeZone: string,
): RenderedOwnerTurn {
  const fill = (prose: string): readonly RenderedSegment[] =>
    renderProse(prose, served);
  return {
    kind: answer.kind,
    prose: fill(answer.prose),
    receipt: answer.references
      .map((ref) => receiptLine(rowFor(served, ref), timeZone))
      .filter((line): line is ReceiptLine => line !== null),
    followUp: answer.kind === "refusal" ? fill(answer.followUp) : null,
    timeline:
      answer.kind === "refusal" && answer.timelineRef !== undefined
        ? renderedRecord(rowFor(served, answer.timelineRef))
        : null,
    candidates:
      answer.kind === "ask"
        ? answer.candidates
            .map((ref) => renderedRecord(rowFor(served, ref)))
            .filter((record): record is RenderedRecord => record !== null)
        : [],
  };
}

/** The prose, split into what the model wrote and what code filled. */
function renderProse(
  prose: string,
  served: ServedRows,
): readonly RenderedSegment[] {
  const segments: RenderedSegment[] = [];
  let at = 0;
  for (const match of prose.matchAll(slotPattern())) {
    const start = match.index;
    if (start > at) {
      segments.push({ kind: "prose", text: prose.slice(at, start) });
    }
    const ref = Number(match[1]);
    const cited = rowFor(served, ref);
    segments.push({
      kind: "reference",
      ref,
      referenceClass: referenceClass(cited.kind),
      of: cited.kind,
      text: slotValue(cited),
    });
    at = start + match[0].length;
  }
  if (at < prose.length) segments.push({ kind: "prose", text: prose.slice(at) });
  return segments;
}

/**
 * What one reference reads as inside a sentence.
 *
 * A FACT READS AS ITS WHOLE LINE, which is `renderOwnerFactLine`'s — the one
 * composition of a payload this repo has, and the same one the model was
 * shown in the tool result, so an answer's words and its values describe the
 * same thing. Picking ONE FIELD out of a payload instead would mean deciding,
 * here, which of a quote's five fields the sentence meant — a decision the
 * answer does not carry and code cannot make. #131 may want that finer
 * grain for its violet-and-coral value spans; it is recorded as owed rather
 * than guessed at here.
 */
function slotValue(row: ServedRow): string {
  switch (row.kind) {
    case "fact":
      return renderOwnerFactLine(row.fact);
    case "entity":
      // The same fence the page renders behind (#129): a display name that
      // is a WhatsApp address or a phone number is not said here either.
      return renderOwnerEntityName(row.entity.displayName);
    case "seat":
      return row.seat.displayName;
    case "count":
      // THE NUMBER, AND THIS IS THE ONLY PLACE IT IS WRITTEN. The tool never
      // showed it to the model, and the answer carries a reference where
      // it goes. Spec #126 user story 14: "a count in an answer comes from
      // the record, not from the model's memory".
      return COUNT.format(row.count.count);
  }
}

/** One receipt line, or none — a resolved name has no receipt (#134). */
function receiptLine(row: ServedRow, timeZone: string): ReceiptLine | null {
  switch (row.kind) {
    case "fact": {
      const rendered: OwnerRenderedFact = renderOwnerFact(row.fact, timeZone);
      return {
        kind: "fact",
        ref: row.ref,
        typeLabel: rendered.typeLabel,
        sourceType: rendered.provenance.sourceType,
        seat: rendered.provenance.seat,
        occurred: rendered.provenance.occurred,
        filed: rendered.provenance.filed,
        confidence: rendered.provenance.confidence,
      };
    }
    case "count":
      return {
        kind: "count",
        ref: row.ref,
        typeLabel: renderOwnerFactTypeLabel(row.count.factType),
        seat: row.count.seatName,
        from:
          row.count.from === null
            ? null
            : renderOwnerInstant(row.count.from, timeZone),
        to:
          row.count.to === null ? null : renderOwnerInstant(row.count.to, timeZone),
        windowClosed: true,
      };
    case "entity":
    case "seat":
      return null;
  }
}

/** A record behind a pill, or none when the reference is not one. */
function renderedRecord(row: ServedRow): RenderedRecord | null {
  if (row.kind !== "entity") return null;
  return {
    ref: row.ref,
    entityId: row.entity.entityId,
    displayName: renderOwnerEntityName(row.entity.displayName),
  };
}

/** The row a reference names, or the loud refusal to invent one. */
function rowFor(served: ServedRows, ref: number): ServedRow {
  const found = served.get(ref);
  if (found === undefined) {
    throw new OwnerRenderError(
      `reference ${ref} was never served this turn, so there is no row to render it from (spec #126 decision 18)`,
    );
  }
  return found;
}

/**
 * A count, in the owner's own digits. `maximumFractionDigits` is untouched
 * because a count is a whole number by construction; the grouping is what
 * this is for.
 */
const COUNT = new Intl.NumberFormat("es-MX");

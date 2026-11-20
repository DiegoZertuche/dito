/**
 * THE TYPED ANSWER an owner turn ends on — never free text (ticket #130;
 * spec #126 decisions 5(d), 7 and 18; ticket #363: the SDK's structured
 * output, read when the model stops).
 *
 * FOUR KINDS, AND EACH ONE IS A DIFFERENT THING THE OWNER GETS BACK:
 *
 *   `answer` — the twin answered from what the tools returned, citing the
 *     rows it rests on. A count is one of those rows, and the number in the
 *     sentence is rendered from it (spec decision 7: "a count in an answer
 *     comes from the record, not from the model's memory").
 *
 *   `refusal` — the question was about what the wall keeps out, and it gets
 *     FR-46's STRUCTURE: the refusal, the relevant timeline when an entity
 *     was named, a suggested human follow-up (ADR-0037 as amended). Three
 *     fields, never three sentences: the timeline is a reference and the
 *     refusal and the follow-up are composed.
 *
 *   `ask` — a name resolved to more than one record, so the twin asks which
 *     (ADR-0039, the one legitimate ask). The candidates are references;
 *     the room renders them as pills and the owner picks one.
 *
 *   `unrecorded` — the Ledger holds no such fact type, so the twin says so
 *     rather than guessing. THIS IS FR-48's FAILED-QUERY LOG (spec #126
 *     decision 2), read off the stored answer's kind, and the room answers
 *     it with the fact types the record does hold. A word of its own because
 *     `schema-miss` is the runtime's disposition for a typed result it could
 *     not accept (CONTEXT.md, *Disposition*), and one word may not mean two
 *     things.
 *
 * THE KIND IS CONTENT, NEVER THE DISPOSITION (CONTEXT.md, *Disposition*:
 * "every word is read from what happened … never from a form the model
 * filled"). The record's word is read from what the turn did
 * (`ownerDispositionOf`).
 *
 * PROSE PLUS SLOTS, WHICH IS THE WHOLE OF HOW COMPOSITION AND THE WALL
 * COEXIST. The model composes the sentence and writes `[[3]]` where a
 * value goes; code fills every slot from the row that reference names. So
 * the voice is the twin's and every number, date, name and source is the
 * record's (ADR-0037 as amended, both halves). `guard.ts` is what makes
 * that true rather than requested.
 *
 * THE SCHEMA IS WHAT THE MODEL IS HELD TO; `parse` IS THE OWNER SIDE'S
 * RULE OVER WHAT IT ADMITTED. The CLI holds the answer to the schema and
 * asks again on a mismatch; every field is still re-read from `unknown`
 * here, and the structural guard runs in the same pass. An answer that fails
 * either goes back to the model as the reason, and it answers again (#133's
 * feedback, through `@dito/execution`'s structured-output check); a turn
 * that never gives one this accepts settles `schema-miss` with nothing to
 * render.
 */
import type {
  ReadDisposition,
  StructuredOutputContract,
  SubmissionParse,
  TurnEnding,
} from "@dito/execution";
import { structuralViolations } from "./guard.js";
import type { ServedRows } from "./served.js";

/** The four, as a value, so a refusal can name them. */
export const OWNER_ANSWER_KINDS = [
  "answer",
  "refusal",
  "ask",
  "unrecorded",
] as const;

export type OwnerAnswerKind = (typeof OWNER_ANSWER_KINDS)[number];

/** What every kind carries: the composed prose and the rows it rests on. */
interface OwnerAnswerBase {
  readonly prose: string;
  /**
   * The references this turn rests on, in the order the receipt strip
   * renders them. A reference the tools never served is refused before
   * anything renders (spec #126 decision 18).
   */
  readonly references: readonly number[];
}

export type OwnerAnswer =
  | (OwnerAnswerBase & {
      readonly kind: "answer";
      /** The count whose number this answer's slot renders, when it has one. */
      readonly countRef?: number;
      /**
       * FR-69's by-design delay, as a typed field rather than a fifth kind.
       *
       * WHY IT HAD TO EXIST (Codex r1). A question about today is answered
       * by saying the record runs a day behind, and "nothing at all about
       * what is or is not inside that window". That answer rests on no row
       * — there is no row it could rest on — so the grounding rule, which
       * refuses an answer from a turn that read nothing, made the one
       * answer FR-69 requires impossible to give. Worse than impossible:
       * it pushed the model towards reading today's window to have
       * something to cite, which is the read FR-69 exists to prevent.
       *
       * A FIELD AND NOT A KIND, because the closed set of four is the
       * spec's and a fifth word would reopen it — and because this IS an
       * answer: the twin answered, and the disposition is `answered`.
       *
       * The guard makes it exact in both directions: a delayed answer
       * carries NO references at all (a citation would characterise the
       * window it just declined to characterise), and an ordinary answer
       * is still held to reading before it speaks.
       */
      readonly delayed?: boolean;
    })
  | (OwnerAnswerBase & {
      readonly kind: "refusal";
      /** FR-46's middle third: the record the owner may open instead. */
      readonly timelineRef?: number;
      /** ...and its last third: what a person could answer, and who. */
      readonly followUp: string;
    })
  | (OwnerAnswerBase & {
      readonly kind: "ask";
      /** The records the owner is choosing between (ADR-0039). */
      readonly candidates: readonly number[];
    })
  | (OwnerAnswerBase & { readonly kind: "unrecorded" });

/**
 * How an owner turn's record ends, read from what happened (CONTEXT.md,
 * *Disposition*; spec #126 decision 5(e); ticket #363).
 *
 * `wall-refused` WHEN A READ TOOL REFUSED A CALL AT ITS PROJECTION'S FENCE —
 * a parameter naming a column, a table or a company the projection does not
 * declare (ADR-0013: a read owes a projection). Otherwise `asked` when the
 * typed result leaves a question open for the owner — an ask with the
 * records they choose between (ADR-0039) — and `answered` for every other
 * well-formed result. The model's chosen kind is the owner's to read and
 * never the record's word: the refusal kind carries FR-46's follow-up and
 * timeline, and the `unrecorded` kind is FR-48's log, each read off the
 * stored answer. `schema-miss` is the runtime's, for a typed result it could
 * not accept.
 */
export function ownerDispositionOf(answer: OwnerAnswer, _handled: void, ending: TurnEnding): ReadDisposition {
  if (ending.refused.length > 0) return "wall-refused";
  return answer.kind === "ask" && answer.candidates.length > 0 ? "asked" : "answered";
}

/**
 * The structured output, bound to one run's served rows.
 *
 * BOUND, BECAUSE THE GUARD IS ABOUT THIS RUN. `parse` closes over the map
 * the tools served into — the one thing "was this row served" can be asked
 * of. What the DIGEST covers is the schema, which does not change with the
 * closure, so two runs of the same instructions stamp the same digest with
 * two different served maps behind them.
 *
 * `read` IS TOLD EACH ANSWER'S VERDICT — why it was refused, or `undefined`
 * when it was accepted — for the failed-query log: the guard's violation
 * list names fields, references and rules and never a value, so it is the
 * one sentence about a refused answer worth keeping.
 */
export function ownerAnswerFormat(
  served: ServedRows,
  read: (refusal: string | undefined) => void = () => {},
): StructuredOutputContract<OwnerAnswer> {
  return {
    schema: OWNER_ANSWER_SCHEMA,
    parse: (output: unknown) => {
      const parsed = parseOwnerAnswer(output, served);
      read(parsed.ok ? undefined : parsed.reason);
      return parsed;
    },
  };
}

/**
 * What the model is told its answer looks like.
 *
 * CLOSED, and closed at every depth it declares (there is one depth). The
 * CLI holds the answer to the closure and the required list; everything else — the kinds, the shape of an array, whether the fields a
 * kind needs are there — is enforced by `parse` below, which is the
 * package's own rule about where a shape that matters is checked.
 */
export const OWNER_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "prose", "references"],
  properties: {
    kind: {
      type: "string",
      enum: [...OWNER_ANSWER_KINDS],
      description:
        "answer: you answered from what the tools returned. refusal: the question was about conversations, tone, speed, behaviour, chat identity, scope or the reps' own stores. ask: a name matched more than one record. unrecorded: the Ledger records no fact of that kind.",
    },
    prose: {
      type: "string",
      description:
        "What you say, in your own words, in the language the owner wrote in. Put [[N]] where a value, a name, a date or a count goes, N being a reference a tool returned. Never write a number, a date, a name or a source yourself.",
    },
    references: {
      type: "array",
      items: { type: "integer" },
      description:
        "Every reference this turn rests on, including every one your prose slots. The record shows them under what you said.",
    },
    count_ref: {
      type: "integer",
      description:
        "answer only. The count reference whose number your prose slots. Put a slot for it where the number goes; never write the number, in digits or in words.",
    },
    delayed: {
      type: "boolean",
      description:
        "answer only. True when this turn is the by-design-delay answer to a question about today or the last few hours. Such a turn cites nothing at all and says nothing about what is or is not inside that window.",
    },
    timeline_ref: {
      type: "integer",
      description:
        "refusal only. The record whose timeline the owner may open instead, when the question named one.",
    },
    follow_up: {
      type: "string",
      description:
        "refusal only. What a person could answer, and who — one sentence, composed.",
    },
    candidates: {
      type: "array",
      items: { type: "integer" },
      description:
        "ask only. The references of the records the owner is choosing between.",
    },
  },
} as const;

/**
 * Reads one answer out of whatever arrived, or says why it cannot.
 *
 * SHAPE FIRST, STRUCTURE SECOND, and the order is deliberate: a violation
 * list about references is unreadable if `references` turned out to be a
 * string. Both refusals settle the execution the same way — this is about
 * the sentence a person reads afterwards in the failed-query log.
 */
export function parseOwnerAnswer(
  input: unknown,
  served: ServedRows,
): SubmissionParse<OwnerAnswer> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return no("the answer is not an object");
  }
  const given = input as Record<string, unknown>;
  const kind = given["kind"];
  if (
    typeof kind !== "string" ||
    !(OWNER_ANSWER_KINDS as readonly string[]).includes(kind)
  ) {
    // THE WORD IS NOT ECHOED (Codex r1). Every refusal here can reach a
    // tool result, an execution's failure sentence and whatever a caller
    // does with it, so it names the FIELD and never reflects what arrived:
    // a model can put a chat address in any field it likes, and a refusal
    // that quotes it back has carried it somewhere nobody swept.
    return no(`kind is one of ${OWNER_ANSWER_KINDS.join(", ")}`);
  }
  const prose = given["prose"];
  if (typeof prose !== "string") return no("prose is the words you say");
  const references = integers(given["references"], "references");
  if (typeof references === "string") return no(references);

  let answer: OwnerAnswer;
  switch (kind as OwnerAnswerKind) {
    case "answer": {
      const countRef = optionalInteger(given["count_ref"], "count_ref");
      if (typeof countRef === "string") return no(countRef);
      const delayed = given["delayed"];
      if (delayed !== undefined && typeof delayed !== "boolean") {
        return no("delayed is true or absent");
      }
      answer = {
        kind: "answer",
        prose,
        references,
        ...(countRef === undefined ? {} : { countRef }),
        ...(delayed === true ? { delayed: true } : {}),
      };
      break;
    }
    case "refusal": {
      const followUp = given["follow_up"];
      if (typeof followUp !== "string") {
        return no(
          "a refusal carries a suggested human follow-up — the refusal, the relevant timeline, and what a person could answer (FR-46)",
        );
      }
      const timelineRef = optionalInteger(given["timeline_ref"], "timeline_ref");
      if (typeof timelineRef === "string") return no(timelineRef);
      answer = {
        kind: "refusal",
        prose,
        references,
        followUp,
        ...(timelineRef === undefined ? {} : { timelineRef }),
      };
      break;
    }
    case "ask": {
      const candidates = integers(given["candidates"], "candidates");
      if (typeof candidates === "string") return no(candidates);
      answer = { kind: "ask", prose, references, candidates };
      break;
    }
    case "unrecorded":
      answer = { kind: "unrecorded", prose, references };
      break;
  }

  const violations = structuralViolations(answer, served);
  if (violations.length > 0) return no(violations.join("; "));
  return { ok: true, submission: answer };
}

function no(reason: string): SubmissionParse<OwnerAnswer> {
  return { ok: false, reason };
}

/** An array of whole numbers, or the sentence saying what arrived instead. */
function integers(value: unknown, field: string): readonly number[] | string {
  if (value === undefined) return `${field} is a list of references`;
  if (!Array.isArray(value)) return `${field} is a list of references`;
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item)) {
      return `${field} holds references, and one of them is not a whole number`;
    }
  }
  return value as readonly number[];
}

/** ...and one optional whole number. */
function optionalInteger(value: unknown, field: string): number | undefined | string {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `${field} is a reference, and this is not a whole number`;
  }
  return value;
}

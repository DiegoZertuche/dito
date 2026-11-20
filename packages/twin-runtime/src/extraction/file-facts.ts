/**
 * THE FILING TOOL: HOW AN EXTRACTION STEP PUTS THE DAY'S FACTS IN FRONT OF
 * THE APERTURE (tickets #194, #364; spec #193 decisions 11 and 19; ADR-0003,
 * ADR-0013, ADR-0034, ADR-0040).
 *
 * The agent step of an extraction run reads one chat's day and calls this
 * tool with the candidate facts it found, each bound to the message it was
 * read in. ADR-0003 is what makes it safe to let a model decide — what it
 * hands over is DATA the aperture then decides about, so no call can mint a
 * rep act, a binding, a tap or a merge. Its gate is the correction window
 * (`disclosed-and-undoable-after`): every fact the aperture files becomes a
 * line of the day's notes the rep can take back.
 *
 * THE FIELDS AND THEIR ENUMS ARE THE ONES THE EXTRACTION CORPUS AND THE EVAL
 * LANE SCRIPT, field for field, flat and fully required. `CANDIDATE_READINGS`
 * is spread into the schema, so the vocabulary the model is shown is the
 * aperture's own and cannot be a second list.
 *
 * WHAT `parseCandidateFacts` IS FOR. The tool server checks nothing against
 * the schema, so every field is re-read from `unknown` here. A refusal is
 * FEEDBACK (#133): the reason goes back as the tool's answer and the model may
 * call again inside its turn.
 *
 * IT VALIDATES SHAPE AND NOT CONTENT: whether a payload is well-formed,
 * whether its identifiers normalize, whether the confidence clears the gate
 * and whether any of it may cross are all decided once, at the aperture,
 * where the credentials are.
 *
 * THE DISPOSITION IS READ FROM WHAT THE APERTURE DID (glossary *Disposition*):
 * the tool's outcome carries `filed` when at least one candidate was filed or
 * fell below the gate the rep is told about, `nothing-to-file` when none did,
 * and the engine records the step by that act word.
 */
import {
  CANDIDATE_READINGS,
  FACT_TYPES,
  type CandidateReading,
  type FactType,
} from "@dito/aperture";
import { defineTool, type EffectOutcome, type GatedEffectToolDeclaration } from "@dito/execution";
import {
  COMMITMENT_CLAUSE,
  CUSTOMER_ASKS_FOR_A_DAY,
  DATE_PROMISED_SENTENCE,
  PATTERN_CLAUSE,
  PATTERN_SENTENCE,
  POINTS_SOMEWHERE_ELSE_ONE,
  PRICE_PER_UNIT_ONE,
} from "./examples.js";

/** The filing tool's registered name. */
export const FILE_FACTS_TOOL = "file_facts";

/**
 * One candidate fact, bound to the message it was read in — CONTEXT.md's
 * word exactly ("a model-extracted, untrusted, confidence-gated assertion,
 * entity-attached, awaiting the aperture").
 *
 * `messageId` is what makes it traceable: the pass matches it back to the
 * `wa_events` row the plane delivered, deterministically, and a candidate
 * citing a message that is not in the window it was shown is dropped. A
 * model cannot produce a row on the seam, so it cannot invent provenance.
 */
export interface CandidateFact {
  readonly factType: FactType;
  readonly messageId: string;
  readonly confidence: number;
  /**
   * How the model read the message (ticket #66) — the gate's second input.
   *
   * Beside `confidence` rather than folded into it, because #66 measured
   * that they answer different questions and that only one of them was ever
   * being asked. The number says whether the words are there — 0.95 or 1.00
   * on 83 of 88 candidates, right or wrong — while this says whether the
   * record those words would make is one the twin can resolve on its own.
   * The aperture decides what to do about it; see `CandidateReading`.
   */
  readonly reading: CandidateReading;
  /** As the model said it. Untrusted and unnormalized — the aperture shapes it. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** What one call files: what this day states, which may be nothing. */
export interface CandidateFacts {
  readonly candidates: readonly CandidateFact[];
}

/**
 * What the model is told one call looks like.
 *
 * FLAT AND FULLY-REQUIRED: every field is present on every item, null where
 * it does not apply, so the model is told the exact vocabulary rather than
 * handed a free-form object.
 *
 * This schema is the MODEL WIRE FORMAT, not the stored payload. The stored
 * payload shape is the aperture's (`(fact_type, payload_version)`, ADR-0034)
 * and `toPayload` maps into it.
 */
const EXTRACTED_FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      description:
        "Every objective business fact this day's messages state. Empty when there are none.",
      items: {
        type: "object",
        properties: {
          fact_type: {
            type: "string",
            enum: [...FACT_TYPES],
            description: "Which of the six kinds of fact this is.",
          },
          message_id: {
            type: "string",
            description:
              "The id of the line this fact was read in, copied exactly from the transcript. For an OrderTaken the rep agreed to with a reaction, that is the REACTION line's own id (ticket #99).",
          },
          confidence: {
            type: "number",
            description:
              "0 to 1: how sure you are that this fact is stated in the conversation.",
          },
          // THE SECOND THING THE MODEL SAYS ABOUT ITS OWN READING (ticket
          // #66). The confidence above answers "are the words there"; this
          // answers "is the record they would make one the twin can
          // resolve", which is the question the aperture's gate was
          // actually asking of a number that never meant it. A closed set
          // rather than a scale, because #66 measured that the emitter has
          // a vocabulary and not a scale: five distinct confidences across
          // 88 candidates, 83 of them in [0.95, 1.00], and one candidate in
          // the whole middle band. Asking for a sixth number would have got
          // a sixth spike.
          reading: {
            type: "string",
            enum: [...CANDIDATE_READINGS],
            description: `"stated" when this message's own words spell out everything the record will hold; "resolved_reference" when a field you filled in came from something you FOUND with the read tools, because this message only pointed at it (${POINTS_SOMEWHERE_ELSE_ONE}); "unresolved_reference" when this message points somewhere and looking did not settle it — nothing found, or two different answers. Most facts are "stated". A missing optional field is still "stated".`,
          },
          item: {
            type: ["string", "null"],
            description:
              "QuoteGiven / OrderRequested / OrderTaken: what was quoted, asked for or agreed to.",
          },
          // NULL IS THE ANSWER FOR A RATE (ticket #59). The measured defect
          // was `quantity: 1` on a per-unit price, so the rep read a line
          // claiming one bulto of mortero at a rate nobody counted. Said in
          // the instructions and again here, because this is the field the
          // wrong value lands in and the schema line is what the model reads
          // beside the value it is choosing.
          quantity: {
            type: ["number", "null"],
            description: `QuoteGiven / OrderRequested / OrderTaken: how many, when the message says how many. NULL for a price per unit — ${PRICE_PER_UNIT_ONE} counts nothing, so a 1 here would be a count the conversation never made.`,
          },
          unit: {
            type: ["string", "null"],
            description:
              "QuoteGiven / OrderRequested / OrderTaken: the unit the quantity counts (cajas, bultos, kilos).",
          },
          amount: {
            type: ["number", "null"],
            description:
              "QuoteGiven / OrderRequested / OrderTaken: the money figure, as a number.",
          },
          currency: {
            type: ["string", "null"],
            description:
              "QuoteGiven / OrderRequested / OrderTaken: the ISO currency code of `amount` (MXN, USD).",
          },
          // THE DATE IS A FIELD, NOT PROSE (ticket #65). An example that put
          // the promised day inside the sentence taught the model to write it
          // there — and the disclosure line then rendered that sentence and
          // nothing else, so #57's wrong date was invisible to the rep who
          // could have corrected it. `due_on` is what the rep is shown, so
          // the contract says which field carries the day.
          //
          // WHICH DAY IT IS WAS THE OTHER HALF, and it is answered in the
          // CONTEXT rather than here (tickets #121, #139): the `now` part
          // carries the run's instant and the rep's zone, and every beat of
          // the day carries its own stamp. No rule mapping a weekday to a
          // date was ever added to this contract — the model resolves, code
          // only stops hiding the calendar (ADR-0037), and whether that lands
          // is extraction PRECISION measured in the eval lane rather than
          // asserted in CI (ADR-0028).
          commitment: {
            type: ["string", "null"],
            description: `DatePromised: WHAT was promised, written to continue the sentence ${DATE_PROMISED_SENTENCE} — e.g. ${COMMITMENT_CLAUSE}. The date belongs in due_on, not here.`,
          },
          // ONE DATE FIELD FOR EVERY FACT THAT HAS A DAY (ticket #70). It
          // was DatePromised's alone, and an order with its day in one
          // customer message had nowhere to put the day at all: a customer
          // asking for a day is not the rep promising one, so no DatePromised
          // may be filed for it, and the commercial payload had no date
          // field. The day was dropped, and #57's rep read an order with no
          // date to correct.
          //
          // The wire keeps ONE field; the two payloads keep DIFFERENT names
          // (`dueOn` vs `requestedFor`), because what the model reads off the
          // page is one thing — a day — while what the Ledger claims about it
          // is two.
          //
          // ONE MESSAGE, deliberately — a recorded limit, not an oversight. A
          // day named in an EARLIER message is NOT carried onto the quote. A
          // fact is bound to the single message it was read in and takes its
          // valid time from that message's instant, so lifting a day across
          // messages would file a field whose provenance the fact does not
          // claim. Widening this is an extraction-precision decision that
          // needs corpus labels to measure (#59). Until then the day is
          // absent and the line says so, which is true of the record even
          // when the conversation named a day.
          due_on: {
            type: ["string", "null"],
            description: `The calendar date this fact names, as YYYY-MM-DD, when THIS message states one unambiguously. Null otherwise — never carry a date over from another message. On DatePromised: the date the rep committed to. On QuoteGiven / OrderRequested / OrderTaken: the date the goods are asked for, when this same message states one (${CUSTOMER_ASKS_FOR_A_DAY} is an OrderRequested for the lunes). This is the date the rep is shown and asked to check.`,
          },
          // THE CLAIM, AND ONLY THE CLAIM (ticket #61; ADR-0040). There is
          // no wire field for the customer's own words and no stored one
          // either: a `CustomerPattern` copies nothing verbatim, because a
          // message that carries a standing preference AND a complaint
          // about the rep would carry the complaint across with it. The
          // whole payload is this one composed clause.
          pattern: {
            type: ["string", "null"],
            description: `CustomerPattern: what the customer said is standing about how THEY buy, written to continue the sentence ${PATTERN_SENTENCE} — e.g. ${PATTERN_CLAUSE}. This clause is the WHOLE of what is stored, and the rep's employer reads it: never about the rep, never a one-off, never a regularity you worked out, and never carrying anything else the message said.`,
          },
          contact_name: {
            type: ["string", "null"],
            description:
              "ContactEstablished: the person the contact details belong to.",
          },
          role: {
            type: ["string", "null"],
            description:
              "ContactEstablished: their role, when the conversation states it.",
          },
          phones: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "ContactEstablished: phone numbers, exactly as written.",
          },
          emails: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "ContactEstablished: email addresses, exactly as written.",
          },
          rfcs: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "ContactEstablished: tax IDs (RFC), exactly as written.",
          },
        },
        required: [
          "fact_type",
          "message_id",
          "confidence",
          "reading",
          "item",
          "quantity",
          "unit",
          "amount",
          "currency",
          "commitment",
          "due_on",
          "pattern",
          "contact_name",
          "role",
          "phones",
          "emails",
          "rfcs",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
} as const;

/** The declared half — the instructions render from it, the registry builds from it. */
export const FILE_FACTS_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: FILE_FACTS_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    "File every objective business fact this day's messages state, each bound to the line it was read in. Call it once, with an empty list when the day states none; what the aperture files goes into the day's notes, where the rep can take any line back.",
  inputSchema: EXTRACTED_FACTS_SCHEMA,
};

/** What filing the day's candidates did, as the extraction run's own reads report it. */
export type FilingOutcome =
  | { readonly superseded: true }
  | {
      readonly superseded: false;
      readonly filed: number;
      readonly belowThreshold: number;
      readonly candidates: number;
    };

/**
 * The tool, bound to one chat's day — or to nothing, for a step that reads
 * no chat's day, where every call is refused with the reason.
 */
export function fileFactsTool(
  file: ((facts: CandidateFacts) => Promise<FilingOutcome>) | undefined,
): GatedEffectToolDeclaration {
  return defineTool({
    ...FILE_FACTS_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      if (file === undefined) {
        return { performed: false, told: "This step reads no chat's day, so there is nothing here to file facts against." };
      }
      const parsed = parseCandidateFacts(input);
      if (!parsed.ok) return { performed: false, told: `Nothing was filed: ${parsed.reason}. Call again with the list fixed.` };
      const filing = await file(parsed.facts);
      if (filing.superseded) {
        return { performed: false, told: "This chat's day is already filed; nothing more is filed for it today." };
      }
      // `filed` WHEN THE APERTURE PUT SOMETHING IN FRONT OF THE REP, or held
      // one back below its gate — the ruling on #194, read off the filing.
      const act = filing.filed + filing.belowThreshold > 0 ? "filed" : "nothing-to-file";
      return {
        performed: true,
        act,
        told: `Filed ${String(filing.filed)} of ${String(filing.candidates)} candidate fact(s); the day's notes carry them. The chat's day is done.`,
      };
    },
  });
}

/** What one call carried, or why it cannot be read. */
export type CandidateFactsParse =
  | { readonly ok: true; readonly facts: CandidateFacts }
  | { readonly ok: false; readonly reason: string };

/** Reads one call's candidate facts out of whatever arrived, or says why it cannot. */
export function parseCandidateFacts(input: unknown): CandidateFactsParse {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return no("the input is not an object");
  }
  const facts = (input as Record<string, unknown>)["facts"];
  if (!Array.isArray(facts)) {
    // AN EMPTY LIST IS THE NORMAL EMPTY DAY and an absent one is a mistake:
    // the tool asks for a list either way, so the two cannot be told
    // apart unless the missing one is refused.
    return no("facts is a list, empty when the day states none");
  }
  const candidates: CandidateFact[] = [];
  for (const [at, raw] of facts.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return no(`fact ${at + 1} is not an object`);
    }
    const fact = raw as Record<string, unknown>;
    const factType = fact["fact_type"];
    if (typeof factType !== "string" || factType.trim() === "") {
      return no(`fact ${at + 1}: fact_type is one of ${FACT_TYPES.join(", ")}`);
    }
    const messageId = fact["message_id"];
    if (typeof messageId !== "string" || messageId.trim() === "") {
      return no(
        `fact ${at + 1}: message_id is the id of the line you read it in, copied from the transcript`,
      );
    }
    const confidence = fact["confidence"];
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
      // A NUMBER, AND FINITE — the SHAPE, not the range. The aperture refuses
      // a confidence outside [0, 1] and counts it, which is the judgement;
      // what this owes is a value the type does not lie about, because `NaN`
      // fails every comparison a gate could make of it and would arrive as
      // "below threshold" about a candidate the model never graded.
      return no(`fact ${at + 1}: confidence is a number from 0 to 1`);
    }
    const reading = fact["reading"];
    if (typeof reading !== "string" || reading.trim() === "") {
      return no(
        `fact ${at + 1}: reading is one of ${CANDIDATE_READINGS.join(" or ")}`,
      );
    }
    candidates.push({
      // CARRIED ACROSS AS SAID, and the two closed sets are checked at the
      // APERTURE and nowhere else — the rule this filing has always kept: "whether
      // the value is one the gate knows is checked once, at the aperture,
      // with every other decision about whether this may cross". A seventh
      // fact type or a FOURTH reading costs that ONE candidate, which the run
      // row counts under `refused`; re-deciding it here would cost the whole
      // day, and would put the Ledger's vocabulary in a second place. What
      // this contract owns is the SHAPE, because the SDK validates nothing.
      factType: factType as FactType,
      messageId,
      confidence,
      reading: reading as CandidateReading,
      payload: toPayload(fact),
    });
  }
  return { ok: true, facts: { candidates } };
}

function no(reason: string): CandidateFactsParse {
  return { ok: false, reason };
}

/**
 * The wire item → the payload shape for its type.
 *
 * A pass-through, deliberately: nulls come off and the identifier arms are
 * gathered, and nothing else is decided here. Whether a payload is
 * well-formed, whether its identifiers normalize, and whether any of it may
 * cross are all the aperture's — one place, the one that holds the
 * credentials.
 */
function toPayload(fact: Record<string, unknown>): Record<string, unknown> {
  if (fact["fact_type"] === "ContactEstablished") {
    return present({
      contactName: fact["contact_name"],
      role: fact["role"],
      identifiers: {
        phones: fact["phones"] ?? [],
        emails: fact["emails"] ?? [],
        rfcs: fact["rfcs"] ?? [],
      },
    });
  }
  if (fact["fact_type"] === "DatePromised") {
    return present({ commitment: fact["commitment"], dueOn: fact["due_on"] });
  }
  if (fact["fact_type"] === "CustomerPattern") {
    // ONE FIELD IN, ONE FIELD STORED (ticket #61; ADR-0040). Nothing
    // verbatim from the conversation reaches this payload — not from the
    // model, and not from the seam row either.
    return present({ pattern: fact["pattern"] });
  }
  return present({
    item: fact["item"],
    quantity: fact["quantity"],
    unit: fact["unit"],
    amount: fact["amount"],
    currency: fact["currency"],
    // The wire's one date field lands on a commercial payload as
    // `requestedFor` (ticket #70), never as `dueOn`. The names differ
    // because the CLAIMS differ: a `DatePromised`'s `dueOn` is a day the
    // rep committed to, while a day stated inside an order is one the
    // conversation asked for and nobody has yet answered. Storing the
    // second under the first's name would launder a request into a promise
    // at precisely the point the aperture exists to stop that.
    requestedFor: fact["due_on"],
    // `agreement` IS DELIBERATELY NOT HERE (ticket #71). An `OrderTaken`'s
    // evidence is the rep's own message, and the aperture takes it off the
    // seam row rather than from anything the model wrote: a quotation a
    // model chooses can be clipped to hide the condition that disqualifies
    // it, and the whole point of the field is that the rep can see one.
  });
}

/** Drops the nulls the flat wire format requires, keeping everything else. */
function present(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}

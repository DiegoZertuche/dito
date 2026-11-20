/**
 * The aperture's other input class: a candidate fact (ticket #52; spec #48
 * grilling decisions 5 and 6; ADR-0003, ADR-0004, ADR-0034, ADR-0035).
 *
 * CLASS 1 is model output. Untrusted, confidence-gated, and — the part that
 * matters most — SHAPED HERE rather than wherever it came from. The caller
 * hands over what a model said; this module decides whether any of it may
 * cross, normalizes what does, and files the fact with its disclosure line
 * in one transaction (FR-72).
 *
 * WHAT A CANDIDATE CANNOT DO. It cannot name its own company or seat (both
 * are read off the seam row it was read in, server-side, exactly as a
 * class-2 act's are). It cannot choose its own valid time (that is when the
 * message was SENT, off the same row — a pass restarted hours later must
 * not write its own clock into an append-only store). It cannot carry chat
 * identity across the wall in a payload field. It cannot mint a rep act,
 * a binding, a tap or a merge, because this module writes exactly two rows
 * and neither of them is any of those things.
 *
 * BELOW THE GATE, A CANDIDATE IS DROPPED (ticket #218; spec #214 decision 1;
 * FR-31, precision over recall). No fact, no question, no line — and the run
 * row counts the drop, which is the only trace one leaves. The gate lives
 * here rather than at the extraction call site because the aperture is what
 * decides what crosses; both of its tests now end the same way, and the
 * verdict's value is what says which of them stopped a candidate.
 *
 * THE TWIN DOES NOT ASK THE REP TO SETTLE ITS OWN UNCERTAINTY. That is the
 * question principle spec #214 writes: a question is a service, so the twin
 * asks only when the answer makes the rep's own work smaller, never to fill a
 * hole in the record. A below-threshold candidate is a hole in the record,
 * and #200's rig session showed what asking about one cost — a «si» on a
 * sentence the twin was unsure of files the record with the REP's hand at the
 * one moment they were told the twin was unsure. Precision is measured on
 * what crosses (ADR-0016) and the drops are counted, so the silence is a
 * number rather than a hope.
 */
import {
  containsChatOwnNumber,
  isChatOwnNumber,
  normalizeIdentifiers,
} from "./identifiers.js";
import {
  readSeamSource,
  type ApertureContext,
  type SeamSource,
} from "./inputs.js";
import { shadowAtFiling } from "./shadow-lift.js";
import { withApertureUnit } from "./unit.js";

/**
 * The six fact types this slice extracts (spec #48 grilling decision 5;
 * ticket #71 split `OrderTaken` off `OrderRequested`; ticket #61 added
 * `CustomerPattern`).
 *
 * `OrderRequested` AND `OrderTaken` ARE TWO EVENTS, NOT TWO STATES
 * (ADR-0038). The customer asking and the business agreeing are separate
 * things that happen at separate instants, and each is filed where and
 * when it happened: a request on Monday files an `OrderRequested` on
 * Monday, an agreement on Tuesday files an `OrderTaken` on Tuesday.
 * Neither ever becomes the other, nothing links them, and nothing is
 * deduplicated — which is the only shape an append-only store can hold
 * (ADR-0034 forbids restructuring what is stored), and also the more
 * truthful one: a customer who asks for 100 and a rep who agrees to 80
 * disclose as two lines whose numbers differ, where one collapsed line
 * would hide exactly the discrepancy the correction window exists to
 * expose.
 *
 * `CustomerPattern` JOINED AT TICKET #61 (ADR-0040), and the condition it
 * waited on was a labelled corpus able to tell a good one from a bad one
 * (#56 built it). Its false positives are aperture BREACHES rather than noise — FR-30
 * defines it narrowly and warns by name against "rep tactics, judgments, or
 * selling approach", and ADR-0035 names an entity-less observation slot as
 * the natural drain for exactly the rep-level inference ADR-0033 exists to
 * prevent — so what ships is the NARROW READING and three structural
 * fences, not a prompt.
 *
 * WHAT A `CustomerPattern` MAY REST ON: the words of ONE message, in which
 * the CUSTOMER states a standing preference or a constraint of their own.
 * Not cadence, and the omission is deliberate rather than an unfinished
 * half. Cadence is a claim about REPETITION while every other fact type is
 * a claim about one message, and the three things it would need are all
 * absent: the extraction window is the DAY (a backfilled row is refused
 * here, twelve lines down), so nothing in the pass can observe a
 * repetition; a cadence built by counting orders would double-count a
 * single want, because ticket #83 makes a customer who asks at the outset
 * and again after the price file TWO `OrderRequested`s; and an observed
 * regularity is by definition INFERRED rather than read, which is the exact
 * material ADR-0033 keeps twin-side. A stated cadence — «yo siempre pido
 * los martes» — is a stated preference and crosses like any other, because
 * the customer said it. What waits is only the unstated kind.
 */
export const FACT_TYPES = [
  "QuoteGiven",
  "OrderRequested",
  "OrderTaken",
  "DatePromised",
  "ContactEstablished",
  "CustomerPattern",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

/** Which side of the conversation a fact's own sentence claims acted. */
export type FactAuthorship = "rep" | "counterparty" | "either";

/**
 * WHOSE MESSAGE A FACT MAY BE READ IN (ticket #71; #70 remainder 2;
 * ADR-0003, ADR-0037).
 *
 * Every disclosure line names an actor: «Le cotizaste …», «Le confirmaste
 * …», «Te pidió …». A fact filed from the wrong side of the conversation
 * makes that sentence false in the one way a rep cannot see — #57's
 * complaint was an order the rep never accepted, and #66 then measured
 * that the confidence gate cannot catch it, because a plainly-stated
 * sentence read for the wrong claim arrives at 0.95–1.00 like every other.
 * A wrong-but-confident reading is caught by structure or not at all.
 *
 * So the structure: a fact whose sentence claims the REP acted may only be
 * read in a rep-authored message, and a fact whose sentence claims the
 * CUSTOMER acted may only be read in the customer's. Checked here against
 * `wa_events.from_me` — the flag the plane stamped, off the row, matched
 * by code — which is the same evidence a class-2 rep act is bound to
 * (`inputs.ts`) and equally unavailable to a model.
 *
 * The corpus already believed this: all 89 human labels put every
 * `QuoteGiven` and every `DatePromised` on a rep message and every order
 * on the customer's, without ever being told to. This encodes what a human
 * reading these conversations already does.
 *
 * `ContactEstablished` IS THE ONE EXCEPTION, and it is a real one rather
 * than an omission: «Guardé los datos de contacto de Ana» names no actor,
 * and a contact detail is genuinely established by whoever states it —
 * usually the customer, sometimes the rep passing on a bookkeeper's. There
 * is no false sentence to prevent, so nothing is fenced.
 */
export const FACT_AUTHORSHIP: Readonly<Record<FactType, FactAuthorship>> = {
  // «Le cotizaste …» — the rep priced it. A customer repeating the price
  // back, or quoting a competitor's, is not this rep quoting (the corpus's
  // `x-*` day is exactly that, labelled silent).
  QuoteGiven: "rep",
  // «Te pidió …» — the counterparty asked. The rep restating the ask is
  // not the ask.
  OrderRequested: "counterparty",
  // «Le confirmaste el pedido …» — the rep agreed. This is the fence
  // ticket #71 exists for: the old type's contract had no rep in it at
  // all.
  OrderTaken: "rep",
  // «Le confirmaste …» — the rep committed (#70 remainder 2, decided here
  // because it is the same question). A customer's «ok, entonces el
  // viernes» is the customer accepting a promise, not the rep making one;
  // if the rep made it, the rep's own message says so and the fact is
  // filed there.
  DatePromised: "rep",
  ContactEstablished: "either",
  // «Te dijo que …» — the customer stated it about themselves (ticket #61).
  // THE LOAD-BEARING ENTRY IN THIS TABLE, because it is the only one whose
  // wrong side is a wall breach rather than a wrong record. Every rep
  // tactic and rep judgment the precision corpus carries — «a este cliente
  // siempre hay que darle el precio alto primero», «este siempre paga
  // tarde», «con este hay que apretarlo» — is written in the REP's own
  // message, and this fence kills all of them in code, off the flag the
  // plane stamped, before any prompt wording is consulted. The rep
  // restating a customer's constraint is not the customer stating it, and
  // that costs recall exactly as `OrderRequested`'s fence does; FR-31 buys
  // precision with recall, and the customer says it themselves eventually.
  CustomerPattern: "counterparty",
};

/**
 * The payload version each fact type files today. `(fact_type,
 * payload_version)` identifies the shape (ADR-0034); evolution is
 * additive-only and a new reader treats an absent field as NOT RECORDED
 * THEN, never as a default.
 *
 * PER-TYPE, which is what ADR-0034 means by per-type evolution — "a change
 * to `QuoteGiven` never forces churn on unrelated types" (ticket #70). The
 * two commercial types gained an optional `requestedFor` and stand at 2;
 * `DatePromised` and `ContactEstablished` did not change and stay at 1.
 *
 * THE STAMP IS BUMPED RATHER THAN REUSED, deliberately. Adding an optional
 * field is exactly the additive evolution the ADR sanctions without an
 * upcaster — but leaving both shapes under one stamp would defeat the
 * stamp's one job, which is to identify the shape. An absent
 * `requestedFor` on a v1 row means the shape had no slot for one; on a v2
 * row it means the conversation stated no day. Both are "not recorded
 * then", and only the version says WHICH — a distinction slice 4's
 * owner-side reads are the first to need.
 *
 * Nothing already stored is restructured or rewritten: a v1 row keeps its
 * stamp and its contents and is read by the same reader, because v2 is v1
 * plus one optional field.
 *
 * TWO DELIBERATE NUMBERS FROM THE SPLIT (ticket #71; ADR-0038), and
 * neither is the one a fresh type would get:
 *
 * `OrderRequested` STARTS AT 2, not at 1, because it did not start. It is
 * the old `OrderTaken`'s meaning under an honest name, and the migration
 * relabels the standing rows into it without touching their
 * `payload_version` — so `(OrderRequested, 1)` is the pre-#70 commercial
 * shape those rows already carry and `(OrderRequested, 2)` is the same
 * shape plus `requestedFor`. The type inherits its predecessor's meaning,
 * so it inherits its version line; giving it a fresh 1 would make one
 * stamp name two different shapes, which is the one job a stamp has.
 *
 * `OrderTaken` STEPS TO 3, and this is the meaning shift itself. Its v3
 * payload is v2 plus a REQUIRED `agreement`, which additive evolution
 * cannot express — ADR-0034 says exactly that, and says such a change
 * needs a read-time upcaster and its own ADR. It carries no upcaster
 * because after the migration there are ZERO `OrderTaken` rows anywhere:
 * every one of them was relabelled, so no reader will ever meet a
 * `(OrderTaken, 1)` or `(OrderTaken, 2)` row. The numbers are burned
 * rather than recycled all the same, so that if one ever surfaces from a
 * database the migration did not reach, it cannot be mistaken for the new
 * shape.
 */
export const FACT_PAYLOAD_VERSIONS: Readonly<Record<FactType, number>> = {
  QuoteGiven: 2,
  OrderRequested: 2,
  OrderTaken: 3,
  DatePromised: 1,
  ContactEstablished: 1,
  // A GENUINELY NEW TYPE, so a genuinely fresh 1 (ticket #61). Nothing was
  // ever stored under this label — no relabel, no burned numbers, no
  // upcaster — so `(CustomerPattern, 1)` names one shape and always has.
  CustomerPattern: 1,
};

/**
 * The confidence a candidate must reach to cross.
 *
 * INVENTED, and recorded as such. No labelled corpus exists yet (spec #48
 * grilling decision 5 says so about `CustomerPattern` for the same reason),
 * so this is a deliberately high first setting in FR-31's direction —
 * precision over recall — and it is a NUMBER TO MEASURE at the first
 * extraction-precision run, not a derived one. Below it a candidate is
 * DROPPED (ticket #218), which costs the rep nothing at all and costs the
 * record a fact the twin was unsure of.
 *
 * IT DID NOT MOVE AT #66, AND THE MEASUREMENT IS WHY. Over 88 graded
 * candidates every WRONG crossing arrived at 0.95–1.00; the least confident
 * error sat at 0.95, so a gate set above it would discard 83 of the 88,
 * nearly all of them correct. No threshold on this emitter catches any
 * error. What moved instead is what the gate READS — see `CandidateReading`.
 */
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.8;

/**
 * HOW THE MODEL READ THE MESSAGE — the second thing it says about a
 * candidate, and the one the gate was missing (ticket #66).
 *
 * #66 measured that `confidence` cannot be the gate's whole input, and the
 * reason is a mismatch of PREDICATES rather than a mistuned number. The
 * extraction prompt asks how sure the model is that a fact is **stated in
 * the conversation**; the gate reads that number as **safe to cross into
 * the Ledger**. Those are different questions, and on plainly-worded
 * traffic the first one's answer is 0.95 or 1.00 whether the reading is
 * right or wrong: five distinct values across 88 candidates, 83 of them in
 * `[0.95, 1.00]`, and one single candidate in the whole middle band. The
 * emitter has a VOCABULARY, NOT A SCALE, so there was no number to move.
 *
 * The other half of the same finding is that "uncertain" had no
 * representation at all. #57's «¿me mandas lo mismo del pedido pasado pero
 * para la otra semana?» produced ZERO candidates — silence, not a hedge —
 * because the prompt's only instructed alternative to a confident filing is
 * an empty list. So this is a REPRESENTATION change, not a threshold one:
 * a second, categorical thing the model can say, which the aperture acts on.
 *
 * `stated` — everything the record would hold is in this message's own
 *   words. The ordinary case, and the only one that can cross unasked.
 *
 * `unresolved_reference` — the act is stated, but what the record would
 *   NAME points at something this day does not spell out: «lo mismo del
 *   pedido pasado», «el precio de siempre». The field carries the
 *   counterparty's own words, so the sentence is TRUE as far as it goes —
 *   and as a Ledger record it names nothing, so the candidate is DROPPED.
 *
 * WHY DROPPED AND NOT ASKED (ticket #76, generalized at #218). This route
 * raised the project's first-ever question on the rig, and the rep could not
 * answer it. The question is unanswerable IN PRINCIPLE rather than badly
 * worded: a «si» files «Te pidió lo mismo del pedido pasado», a sentence
 * that is STILL unresolved, so answering settles nothing. A yes/no does not
 * fit an uncertainty whose shape is a reference needing a VALUE, and the
 * question the twin actually needs — "what did they order last time?" — is
 * not one the rep should be doing the system's lookup for. The governing
 * rule became the whole gate's at #218: every time something is put in front
 * of the rep it should be to be proactive about their work, not to fix the
 * twin's. FR-31 is precision over recall, and a reference nobody can resolve
 * is a fact that cannot honestly be filed.
 *
 * THE CLASSIFICATION SURVIVED THAT CHANGE, AND ONLY THE ROUTING MOVED. An
 * unresolved reference genuinely is a different thing from a low-confidence
 * reading, naming it is what made either remedy expressible, and it is what
 * the remedy needs: an extraction that can go and RESOLVE the reference has
 * to know which candidates to resolve. The drop is still COUNTED, so a build
 * where it fires constantly stays visibly different from one where it never
 * does — see `extraction_runs.unresolved_reference`.
 *
 * `resolved_reference` — the message pointed somewhere the day does not
 *   spell out, the extraction WENT AND LOOKED, and exactly one referent
 *   turned up wherever it looked (ticket #196; spec #193 decision 18;
 *   ADR-0039 as amended). The payload carries the RESOLVED values and
 *   nothing about the referent, so the record names goods rather than a
 *   pointer — which is the whole difference from the reading above it, and
 *   the reason this one crosses on exactly the terms `stated` does.
 *
 * WHY IT GOES THROUGH THE SAME DOOR AS `stated`. The gate reads it and does
 * nothing about it: a resolved candidate is a COMPLETE SENTENCE, so above
 * the confidence threshold it files and below it is dropped, on the same
 * test and for the same reason as any other unsure candidate — an unsure
 * resolution is still a hole in the twin's record. Spec #214 decision 1 and
 * the question principle it writes are the accepted decision here, and
 * ADR-0039's amendment of 2026-09-06 — which sent this reading to a question
 * — is re-cut against them in the docs PR at the boundary (ticket #218).
 * What tells the rep it was inferred is not a route but a MARK, rendered by
 * code from this word at the twin's one grammar point
 * (`renderFactDisclosureLine`), naming no order and no chat. Two differing
 * referents, or none, are not this word: the model says
 * `unresolved_reference` and the candidate is dropped, exactly as before.
 *
 * WHAT IS DELIBERATELY NOT IN THIS SET. Each of these is a different kind
 * of incompleteness with a different right ending, and folding any of them
 * in here would give it this route's ending — dropped, silently — which is
 * wrong for all three:
 *
 *  - A CONDITIONAL is not a low-confidence fact. «Y si me haces precio te
 *    pido más» is a thing that has not happened; «Te pidió más» is false
 *    however it is filed, so there is no sentence to record at all. It
 *    stays silent at the model, and the prompt says so outright.
 *  - AN ABSENT OPTIONAL FIELD is not a hole worth stopping for. A quantity,
 *    a price or a day the conversation never stated is already filed as
 *    ABSENT and already read back to the rep as «sin cantidad», «sin
 *    precio», «sin fecha» (tickets #65 and #70), inside the correction
 *    window. Those are the common case by far, and dropping them would
 *    throw away most of what the day actually says.
 *  - AN AMBIGUOUS READING — whether this was a quote or an order, whether
 *    the rep or the customer acted — is not what this route is FOR, and
 *    marking one `unresolved_reference` would be false: nothing outside
 *    the day is being named. Such a doubt stays where it already lived,
 *    the confidence gate, which may or may not reach it — #66 measured it
 *    firing once in 88 — and the wrong-claim case is what the type system
 *    and the authorship fence carry instead (ADR-0038). This route is only
 *    ever about a field the model DID fill in, whose words point somewhere
 *    the day does not go.
 */
export const CANDIDATE_READINGS = [
  "stated",
  "unresolved_reference",
  "resolved_reference",
] as const;
export type CandidateReading = (typeof CANDIDATE_READINGS)[number];

/** WhatsApp's address shapes — the same set the Ledger wall sweep looks for. */
const JID_SUFFIXES = ["@s.whatsapp.net", "@g.us", "@lid", "@broadcast"];

/** A fact as it will be stored, after the aperture has shaped it. */
export interface NormalizedFact {
  readonly factType: FactType;
  readonly payloadVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /** When it was said in the chat — off the seam row, never a caller's. */
  readonly occurredAt: Date;
  readonly confidence: number;
}

export interface CandidateFactRequest {
  readonly twinId: string;
  /** The bound chat's entity, client-minted rep-side (ADR-0035). */
  readonly entityId: string;
  /** The `wa_events` row the candidate fact was read in. */
  readonly sourceEventId: string;
  readonly factType: FactType;
  /** What the model said. Untrusted and unnormalized. */
  readonly payload: unknown;
  readonly confidence: number;
  /**
   * How the model read the message (ticket #66) — the gate's second input,
   * beside `confidence`.
   *
   * REQUIRED, like the other two things the model says about a candidate.
   * The aperture validates every grading input it is handed and refuses
   * what it does not recognise — an unknown `factType`, a `confidence`
   * outside [0, 1], and now a reading outside `CANDIDATE_READINGS`. An
   * optional one would be the only grading input a caller could leave out
   * and still cross, which is the wrong direction for FR-31.
   */
  readonly reading: CandidateReading;
  /**
   * Renders the line the rep will read — at the twin's one grammar point,
   * from the payload the APERTURE normalized rather than from the model's
   * own text. A callback rather than a string because normalization
   * happens on the way in (spec #48 decision 6): the rep must be told what
   * was stored, and what was stored is not what was said.
   */
  readonly renderDisclosureLine: (
    fact: NormalizedFact,
    reading: CandidateReading,
  ) => string;
  /**
   * OTHER CONVERSATIONS THIS RUN READ (ticket #196, Codex round 2; ADR-0004).
   *
   * The wall sweep below refuses a payload carrying the number of the chat a
   * fact is filed against, and until an extraction could SEARCH, that was
   * every chat its model had seen. It is not any more: a run that resolves
   * «lo mismo que a Torres» reads Torres's own conversation, and a number
   * inside one of those messages is chat identity exactly as the filing
   * chat's is. The caller is the only one that knows what its own reads
   * served, so it hands the addresses over and the sweep covers them too.
   *
   * OPTIONAL AND NEVER STORED. Absent means a caller that showed its model
   * one conversation, which is what drafting, the thread's acts and every
   * pre-#196 extraction are; the value is read for the length of this call
   * and reaches no row.
   */
  readonly chatsRead?: readonly string[];
}

export type CandidateFactOutcome =
  | {
      readonly filed: true;
      readonly factId: string;
      readonly disclosureLineId: string;
      readonly fact: NormalizedFact;
    }
  | {
      readonly filed: false;
      /**
       * NOTHING WAS RECORDED, and the value says why. Three endings that
       * differ in their reason and not in their effect: no fact, no
       * question, no disclosure line, nothing for the rep to do.
       *
       * `below_threshold` — the model was not sure enough that the fact is
       *   stated at all (ticket #218; spec #214 decision 1). Why that is a
       *   drop rather than an ask is the module header's.
       * `unresolved_reference` — the model said outright that what the
       *   record would NAME points outside this day («lo mismo del pedido
       *   pasado»), so the candidate is dropped (ticket #76; see
       *   `CandidateReading`, which argues that one).
       * `refused` — the candidate may not cross AT ALL: an unknown type, a
       *   malformed payload, chat identity in a field, history rather than
       *   the day, a fact read on the wrong side of the conversation.
       *
       * They stay three values rather than one because they are counted
       * apart on the run row: a refusal is the aperture rejecting a
       * candidate it cannot read, and the two drops are the aperture
       * reading one perfectly well and declining to record what it names —
       * for two different reasons a reader of the rate has to be able to
       * tell apart.
       */
      readonly outcome:
        | "below_threshold"
        | "unresolved_reference"
        | "refused";
      readonly reason: string;
    };

/**
 * Files one candidate fact, with its disclosure line, as one atomic
 * aperture unit — or says why it did not.
 *
 * Refusals come back as VALUES rather than as throws, because a day's
 * extraction produces many candidates and one bad one must not abandon the
 * rest. What throws is a broken store: an entity that does not exist, a
 * constraint that refuses. Those are not candidate quality, they are the
 * seam being wrong, and the runtime's doctrine for that is loud.
 */
export async function fileCandidateFact(
  ctx: ApertureContext,
  request: CandidateFactRequest,
): Promise<CandidateFactOutcome> {
  if (!(FACT_TYPES as readonly string[]).includes(request.factType)) {
    return refuse(
      `fact type ${JSON.stringify(request.factType)} is outside the closed set this slice extracts (${FACT_TYPES.join(", ")})`,
    );
  }
  if (
    typeof request.confidence !== "number" ||
    !Number.isFinite(request.confidence) ||
    request.confidence < 0 ||
    request.confidence > 1
  ) {
    return refuse(
      `confidence ${JSON.stringify(request.confidence)} is not a number in [0, 1] — an ungradeable candidate is never a fact`,
    );
  }
  if (!(CANDIDATE_READINGS as readonly string[]).includes(request.reading)) {
    // The same door `factType` goes through, and for the same reason: a
    // grading input the aperture cannot read is one it cannot act on, and
    // guessing which way to fail would be guessing on the rep's behalf.
    return refuse(
      `reading ${JSON.stringify(request.reading)} is outside the closed set the gate reads (${CANDIDATE_READINGS.join(", ")})`,
    );
  }

  const read = await readSeamSource(ctx, {
    twinId: request.twinId,
    eventId: request.sourceEventId,
  });
  if (!read.ok) return refuse(read.reason);
  const { source } = read;
  if (source.backfill) {
    // Backfilled history is not re-extracted: the window is the day (spec
    // #48 decision 13). Enforced here as well as at the pass, because "the
    // aperture decides what crosses" is only true if the aperture checks.
    return refuse(
      `wa_events row ${request.sourceEventId} is backfilled history — the extraction window is the day, and history is never re-extracted`,
    );
  }

  const shaped = shapePayload(
    request.factType,
    request.payload,
    source,
    request.chatsRead ?? [],
  );
  if (typeof shaped === "string") return refuse(shaped);

  const fact: NormalizedFact = {
    factType: request.factType,
    payloadVersion: FACT_PAYLOAD_VERSIONS[request.factType],
    payload: shaped,
    // Valid time is WHEN IT WAS SAID, off the seam row. A pass that picks
    // the day up hours later must not write its own processing time into
    // an append-only, bi-temporal store.
    occurredAt: source.occurredAt,
    confidence: request.confidence,
  };

  // THE GATE, AFTER SHAPING — and shaping first is what keeps the two
  // endings distinguishable. A candidate that could never have crossed is
  // REFUSED, which is a statement about the candidate's shape; a candidate
  // that was well-formed and unsure is DROPPED, which is a statement about
  // the model's own confidence, and the run row counts them apart.
  //
  // IT READS TWO INPUTS SINCE #66, and the order matters only for the
  // message and the count: an `unresolved_reference` at 0.4 is both, and
  // naming the reading first says the more specific thing about it. Every
  // refusal above still comes FIRST, which is the rule the authorship fence
  // rests on (ADR-0038).
  const stopped = gateVerdict(request.reading, request.confidence);

  // THE DROP, BEFORE ANY SENTENCE IS COMPOSED (tickets #76 and #218). A
  // stopped candidate reaches no store and no rep, so nothing needs saying
  // about it — and a candidate nobody will read is not one to render a line
  // for. Returning here rather than after the render is also what keeps the
  // drop SILENT: a renderer that cannot state this payload would otherwise
  // throw on the way to doing nothing at all.
  if (stopped !== undefined) return { filed: false, ...stopped };

  // THE LINE THE REP WILL READ, rendered once and stored as rendered
  // (ADR-0034). It is reached only by a candidate that is crossing, which is
  // the whole of what the gate above decides.
  const disclosureLine = request.renderDisclosureLine(fact, request.reading);

  return withApertureUnit(ctx.db, async () => {
    // `shadow` IS STAMPED, not defaulted (ticket #132; ADR-0016 as
    // amended): `true` while this company is unlifted, `false` once the
    // lift act has set its timestamp. Read inside the unit above, holding
    // the company's shared lock until this row commits, so the mode cannot
    // change underneath the row it stamped.
    const shadow = await shadowAtFiling(ctx.db, source.companyId);
    const filed = await ctx.db.query<{ id: string }>(
      `INSERT INTO ledger.facts
         (company_id, entity_id, fact_type, payload_version, payload,
          occurred_at, confidence, source_type, filed_by_twin_id, shadow)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'extraction', $8, $9)
       RETURNING id`,
      [
        source.companyId,
        request.entityId,
        fact.factType,
        fact.payloadVersion,
        JSON.stringify(fact.payload),
        fact.occurredAt,
        fact.confidence,
        source.twinId,
        shadow,
      ],
    );
    const factId = filed.rows[0]!.id;
    const line = await ctx.db.query<{ id: string }>(
      `INSERT INTO disclosure_lines
         (company_id, seat_id, twin_id, subject_kind, fact_id, entity_id,
          rendered_text, source_event_id)
       VALUES ($1, $2, $3, 'fact', $4, $5, $6, $7)
       RETURNING id`,
      [
        source.companyId,
        source.seatId,
        source.twinId,
        factId,
        request.entityId,
        disclosureLine,
        source.sourceEventId,
      ],
    );
    return {
      filed: true as const,
      factId,
      disclosureLineId: line.rows[0]!.id,
      fact,
    };
  });
}

function refuse(reason: string): CandidateFactOutcome {
  return { filed: false, outcome: "refused", reason };
}

/**
 * Which of the gate's two tests stopped a candidate.
 *
 * STILL DISCRIMINATED THOUGH BOTH END THE SAME WAY (ticket #218). They were
 * two endings at #76 — one asked, one dropped — and they are one ending now:
 * nothing is recorded either way. The union stays because the two are
 * COUNTED APART on the run row, and «the model was unsure» and «the model
 * pointed somewhere it could not follow» are different findings about an
 * extractor: one is a threshold's business and the other is the search's.
 */
export type GateVerdict =
  | { readonly outcome: "unresolved_reference"; readonly reason: string }
  | { readonly outcome: "below_threshold"; readonly reason: string };

/**
 * The gate's verdict: which of its two tests said "this may not cross", or
 * `undefined` when neither did and the candidate may cross (tickets #66,
 * #76, #218).
 *
 * Both tests in one place because they are one decision — "may this cross?"
 * — and two `if`s at the call site would be two gates that could drift
 * apart in which one wins when both apply.
 *
 * EXPORTED FOR THE MEASUREMENT AND FOR NOTHING ELSE (ticket #218). The eval
 * report's *dropped below gate* row classifies each submitted candidate by
 * this function, because the alternative is a second copy of the gate in
 * `@dito/evals` that could disagree with the one that actually ran — and the
 * whole point of the row is to say what the gate really dropped. Filing still
 * goes through `fileCandidateFact`: a caller cannot use this to decide
 * anything about a crossing, because it writes nothing.
 *
 * The READING IS STILL TESTED FIRST, and the order still matters for the
 * message and for the count: an `unresolved_reference` at 0.4 is both, and
 * naming the reading first says the more specific thing about it.
 */
export function gateVerdict(
  reading: CandidateReading,
  confidence: number,
): GateVerdict | undefined {
  if (reading === "unresolved_reference") {
    return {
      outcome: "unresolved_reference",
      reason: `the model read this fact as naming something the day does not spell out, so it is dropped rather than filed — confidence ${confidence} says the words are there, not that the record they would make is one anybody can resolve (ticket #76)`,
    };
  }
  if (confidence < EXTRACTION_CONFIDENCE_THRESHOLD) {
    return {
      outcome: "below_threshold",
      reason: `confidence ${confidence} is below the aperture's gate of ${EXTRACTION_CONFIDENCE_THRESHOLD}, so the candidate is dropped — never a fact, and never a question either, because the twin does not ask the rep to settle what it was unsure of (FR-31; spec #214 decision 1)`,
    };
  }
  return undefined;
}

/**
 * The authorship fence (ticket #71): why this fact may not be read in this
 * message, or `undefined` when it may.
 *
 * A REFUSAL RATHER THAN A DROP, deliberately: the two have the same effect
 * and are counted apart, and this one is a statement about the candidate's
 * SHAPE rather than about how sure the model was. A «Le confirmaste …» read
 * in the customer's message is not an uncertain fact, it is a sentence about
 * the wrong person, and no confidence would make it filable — so a reader of
 * the run's rates must not find it under a threshold's count.
 */
function authorshipRefusal(
  factType: FactType,
  source: SeamSource,
): string | undefined {
  const required = FACT_AUTHORSHIP[factType];
  if (required === "either") return undefined;
  if (required === "rep" && !source.fromMe) {
    return `${factType} claims the rep acted, and wa_events row ${source.sourceEventId} is the counterparty's message — a fact about the rep's own act is read in the rep's own words or not at all (ticket #71)`;
  }
  if (required === "counterparty" && source.fromMe) {
    return `${factType} claims the counterparty acted, and wa_events row ${source.sourceEventId} is rep-authored — the rep restating what a customer asked for is not the customer asking (ticket #71)`;
  }
  return undefined;
}

/**
 * WHICH FACTS MAY BE READ IN A GESTURE — exactly one (ticket #99;
 * ADR-0041). The seam read admits a reaction because an `OrderTaken`'s
 * evidence IS the act, and ADR-0041 makes that act admissible; every other
 * type in the closed set is read in the WORDS of the message it is filed
 * on, and a reaction has none of its own.
 *
 * A REFUSAL RATHER THAN A SILENT WIDENING, and it is what keeps #99
 * narrow. Without it, admitting the gesture at the seam would let a model
 * hang a `CustomerPattern`, a `ContactEstablished` or an `OrderRequested`
 * off a wordless row and supply every one of their fields itself — the
 * model's own composition, with a 👍 as its provenance and nothing in the
 * row to check it against. That is the laundering path ADR-0003 exists to
 * close, arriving through a door opened for something else.
 *
 * A customer's 👍 on the rep's quote is real agreement in the other
 * direction (ADR-0041 says so outright), and nothing here files it. That
 * is deliberate: the fact it would make is the customer's, `OrderTaken`'s
 * sentence names the rep, and widening what counts as agreeing is out of
 * this ticket's scope.
 */
function gestureRefusal(
  factType: FactType,
  source: SeamSource,
): string | undefined {
  if (source.gesture === undefined || factType === "OrderTaken") {
    return undefined;
  }
  return `${factType} is read in what somebody said, and wa_events row ${source.sourceEventId} is a reaction — a gesture carries the agreement an OrderTaken cites (ADR-0041) and no words for any other fact to be read in (ticket #99)`;
}

/**
 * The payload, per `(fact_type, payload_version)` — validated and
 * normalized, or a refusal reason.
 *
 * The shapes are deliberately small. ADR-0034 makes evolution additive, so
 * a field that is not certain today can be added later; a field that is
 * stored wrong today cannot be restructured at all.
 */
function shapePayload(
  factType: FactType,
  raw: unknown,
  source: SeamSource,
  /** Other conversations this run read — see `CandidateFactRequest.chatsRead`. */
  chatsRead: readonly string[],
): Record<string, unknown> | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `payload for ${factType} is not an object`;
  }
  const wrongKind = gestureRefusal(factType, source);
  if (wrongKind !== undefined) return wrongKind;
  const wrongSide = authorshipRefusal(factType, source);
  if (wrongSide !== undefined) return wrongSide;
  const input = raw as Record<string, unknown>;
  const shaped =
    factType === "ContactEstablished"
      ? shapeContact(input, source)
      : factType === "DatePromised"
        ? shapeDatePromised(input)
        : factType === "CustomerPattern"
          ? shapeCustomerPattern(input)
          : shapeCommercial(factType, input, source);
  if (typeof shaped === "string") return shaped;

  // THE WALL, checked BEFORE the row exists rather than swept after it
  // (ADR-0004). `ledger-wall-check` catches an address that reached the
  // store; the aperture is what stops one reaching it. Both halves run over
  // EVERY string in EVERY payload shape, not only the identifiers of a
  // `ContactEstablished` — a `DatePromised` whose commitment reads «entrega
  // al 55 1234 5678» carries the counterparty's own number into Ledger
  // prose just as surely, punctuated so that neither a suffix scan nor a
  // normalized-identifier check would see it (Codex r1).
  for (const value of everyString(shaped)) {
    // Lowercased: the plane writes addresses lowercase, but a model
    // repeating one from a screenshot need not.
    const lowered = value.toLowerCase();
    for (const suffix of JID_SUFFIXES) {
      if (lowered.includes(suffix)) {
        return `payload for ${factType} carries a WhatsApp address (${suffix}) — chat identity never crosses the wall (ADR-0004)`;
      }
    }
    // ANYWHERE in the string, not at its end (Codex r2): «entregas al 55
    // 1234 5678 ext. 204» ends in the extension, and a suffix comparison
    // walks straight past the customer's own address in the middle of it.
    if (containsChatOwnNumber(value, source.chatJid)) {
      return `payload for ${factType} carries the counterparty's own WhatsApp number — that is chat identity, not a business fact, and it never crosses the wall (ADR-0004)`;
    }
    // ...AND OF EVERY OTHER CONVERSATION THIS RUN READ (ticket #196, Codex
    // round 2). An extraction that searches sees another customer's words,
    // and a number inside them is chat identity as surely as the filing
    // chat's is — «Torres, 55 1234 5678» copied into `item` would put one
    // customer's address into another customer's Ledger row, which the check
    // above cannot see because it knows one chat.
    for (const chatJid of chatsRead) {
      if (containsChatOwnNumber(value, chatJid)) {
        return `payload for ${factType} carries the WhatsApp number of another conversation this run read — that is chat identity, not a business fact, and it never crosses the wall (ADR-0004)`;
      }
    }
  }
  return shaped;
}

/** Every string anywhere in a shaped payload, however deeply nested. */
function* everyString(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* everyString(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) yield* everyString(item);
  }
}

/**
 * `QuoteGiven` / `OrderTaken` v2: what, how much of it, for how much — and
 * since ticket #70, the day it is wanted for.
 *
 * `requestedFor` IS A REQUEST, NOT A PROMISE, and the distinction is the
 * whole reason it lives here rather than on `DatePromised`. «te pido 100
 * cajas para el lunes» is the customer naming a day; the rep has agreed to
 * nothing. Filing that as a `DatePromised` would put a commitment in the
 * Ledger the conversation does not support — which is why the corpus
 * labels a customer-proposed date SILENT — and `OrderTaken` v1 had no slot
 * for it, so the day was simply dropped and the rep read a line with no
 * date to correct (#57 finding 2). The rep's own commitment keeps its own
 * fact type, its own field and its own sentence.
 *
 * ON A QUOTE TOO, and the name still holds. A quote's day is the day the
 * goods are wanted for — «¿en cuánto me deja 40 bultos para el viernes?»
 * — which the rep prices but does not thereby promise. When the rep DOES
 * commit to a day in the same breath, that is a second, separate
 * `DatePromised`, exactly as the corpus already labels it; this field
 * never carries the promise.
 *
 * WHAT IT DOES NOT REACH, said plainly (Codex r2): a day the customer
 * named in an EARLIER message than the one the fact was read in. The
 * extraction contract is deliberately per-message — a fact carries the
 * provenance of one seam row — so a quote assembled across a request and
 * a later price keeps no day, and its line says «sin fecha», which is true
 * of the record. Carrying a day across messages is an extraction-precision
 * decision with no corpus labels to measure it yet (#59), not something to
 * assume here.
 *
 * IT SURVIVED THE `OrderRequested` / `OrderTaken` SPLIT (#71) unchanged,
 * and deliberately so. That split puts the requested-versus-agreed
 * distinction on the FACT TYPE, where it belongs; this field only ever
 * says WHICH DAY. On an `OrderRequested` the name is exact; on an
 * `OrderTaken` it still holds — the day WAS requested — and merely says
 * less than the type already does. It never becomes false, which is what
 * matters, because ADR-0034 cannot express a rename without an upcaster.
 *
 * `agreement` IS `OrderTaken` v3's REQUIRED FIELD, and the only payload
 * field in any shape that the caller does not supply: it is the REP'S OWN
 * MESSAGE, read off the seam row the candidate cites. `OrderTaken` claims
 * the business agreed, and a claim about the rep's own act has to be
 * evidenced rather than asserted — #66 measured every wrong crossing
 * arriving at 0.95–1.00, so there is no gate underneath to catch an
 * invented agreement, and a model cannot produce a row on the seam
 * (ADR-0003).
 *
 * THE WHOLE MESSAGE, NOT A SPAN OF IT, and that is the version that works
 * (Codex r2). A model-chosen quotation checked as a substring is
 * verifiable and still useless: «si el proveedor me surte mañana, sí. si
 * no, hasta la otra semana» yields a perfectly genuine «sí», and the line
 * would then read «Dijiste: «sí».» with the condition deleted — the
 * disqualifying half clipped away at exactly the point the rep was
 * supposed to be able to see it. There is no span to clip when the field
 * is the message, and the rep reads the condition in the line they can
 * correct. It is also less machinery: no wire field, no substring check,
 * no fold.
 *
 * A message too long to hold refuses the crossing rather than being
 * truncated, because a truncated quotation is a clipped one — the very
 * defect. The `OrderRequested` still stands; only the agreement is lost.
 *
 * The other commercial types do not carry it. A `QuoteGiven` is a price
 * and an `OrderRequested` is the customer's ask; neither claims agreement,
 * so neither carries evidence of one.
 */
function shapeCommercial(
  factType: FactType,
  input: Record<string, unknown>,
  source: SeamSource,
): Record<string, unknown> | string {
  const label = `${factType} v${FACT_PAYLOAD_VERSIONS[factType]}`;
  const item = text(input["item"]);
  if (item === undefined) {
    return `${label} requires \`item\`: what was quoted or ordered`;
  }
  const shaped: Record<string, unknown> = { item };
  // Every optional field is present-or-absent, never present-and-null: an
  // absent field means NOT RECORDED THEN (ADR-0034), and a null would make
  // "we did not hear a currency" and "the currency is nothing" one value.
  const amount = positive(input["amount"]);
  if (amount !== undefined) shaped["amount"] = amount;
  const currency = currencyCode(input["currency"]);
  // A currency is stored only alongside the amount it denominates. The
  // orphan half is not a price and no disclosure line can state one, so
  // keeping it would put a field across the wall that the rep is never
  // told about and can therefore never correct — ticket #65's whole
  // subject, and the symmetric case of the refusal just below (Codex r1).
  if (currency !== undefined && amount !== undefined) {
    shaped["currency"] = currency;
  }
  const quantity = positive(input["quantity"]);
  if (quantity !== undefined) shaped["quantity"] = quantity;
  const unit = text(input["unit"]);
  if (unit !== undefined) shaped["unit"] = unit;
  // The day the goods are wanted for (ticket #70) — v2's one added field,
  // optional like every other, so an order that named no day stores none
  // rather than being handed one.
  const requestedFor = calendarDate(
    label,
    "requestedFor",
    input["requestedFor"],
  );
  if (typeof requestedFor === "string") return requestedFor;
  if (requestedFor.date !== undefined) shaped["requestedFor"] = requestedFor.date;
  // A quote with an amount and no currency is a number nobody can act on.
  if (shaped["amount"] !== undefined && shaped["currency"] === undefined) {
    return `${label} carries an amount with no currency — a bare number is not a price`;
  }
  if (factType === "OrderTaken") {
    // NOT A FIELD THE CALLER SUPPLIES. Whatever a model said about the
    // agreement — or about a gesture's target, or about its words — is
    // discarded here; the evidence is composed off the seam rows the
    // candidate cites and nothing else.
    const evidence = agreementEvidence(label, source);
    if (typeof evidence === "string") return evidence;
    Object.assign(shaped, evidence);
  }
  return shaped;
}

/**
 * `OrderTaken` v3's evidence, off the seam: the words that agreed, and —
 * when the rep agreed with a gesture rather than with words — the emoji
 * they tapped (ticket #99; ADR-0041, ADR-0038 as amended).
 *
 * TWO SHAPES, ONE MEANING. `agreement` always holds THE WORDS THE REP
 * AGREED TO. On a spoken agreement those are the rep's own, read off the
 * message the fact is filed on; on a gesture they are the TARGET's, read
 * off the message the 👍 points at, because a reaction's whole meaning is
 * the message under it. `agreementGesture` is what says which of the two a
 * row is, and the disclosure line reads it to choose its sentence —
 * «Dijiste: «…».» for words, «Confirmaste con 👍: «…».» for a gesture, so
 * the customer's words are never shown to the rep under their own verb.
 *
 * ADDITIVE, AND THEREFORE NO UPCASTER (ADR-0034). `agreementGesture` is
 * optional and ABSENT on every message-evidenced fact, which is exactly
 * what "an absent field means NOT RECORDED THEN" is for: a reader meeting
 * a row without it is reading a spoken agreement, which is what every row
 * filed before this ticket was. `agreement` did not change meaning either
 * — it was the words that agreed before and it is the words that agreed
 * after — so `payload_version` stays at 3. See the ADR-0038 amendment for
 * the window this rests on: every `OrderTaken` row that exists is shadow,
 * so no owner has ever read one.
 *
 * BOTH STRINGS GO THROUGH `text()`, the same cap every payload text field
 * gets, and then through `shapePayload`'s wall sweep like every other
 * shaped string. A target over the cap REFUSES the crossing rather than
 * being truncated — a truncated quotation is a clipped one, the exact
 * defect ADR-0038 wrote the whole-message rule against — and the
 * `OrderRequested` still stands.
 */
function agreementEvidence(
  label: string,
  source: SeamSource,
): Record<string, unknown> | string {
  const { gesture } = source;
  const agreement = text(
    gesture === undefined ? source.text : gesture.targetText,
  );
  if (agreement === undefined) {
    return gesture === undefined
      ? `${label} cannot carry its evidence: wa_events row ${source.sourceEventId} is empty or longer than a payload field may hold — an agreement the rep cannot be shown in one line is one they cannot check`
      : `${label} cannot carry its evidence: the message ${gesture.targetMessageId} that wa_events row ${source.sourceEventId} reacted to is longer than a payload field may hold — a gesture's agreement is the whole message under it, and a truncated one is a clipped one`;
  }
  if (gesture === undefined) return { agreement };
  const agreementGesture = text(gesture.emoji);
  if (agreementGesture === undefined) {
    // Not reachable off a rail that sends one emoji — an empty one is the
    // removal, already refused at the seam read — and written anyway
    // because the cap is the PAYLOAD's rule rather than the rail's, and a
    // rule enforced everywhere but one field is how that field ends up
    // uncapped.
    return `${label} cannot carry its evidence: wa_events row ${source.sourceEventId} carries no emoji a payload field may hold`;
  }
  return { agreement, agreementGesture };
}

/** `DatePromised` v1: what was promised, and when it is due if that is known. */
function shapeDatePromised(
  input: Record<string, unknown>,
): Record<string, unknown> | string {
  const commitment = text(input["commitment"]);
  if (commitment === undefined) {
    return "DatePromised v1 requires `commitment`: what was promised";
  }
  const shaped: Record<string, unknown> = { commitment };
  const dueOn = calendarDate("DatePromised v1", "dueOn", input["dueOn"]);
  if (typeof dueOn === "string") return dueOn;
  if (dueOn.date !== undefined) shaped["dueOn"] = dueOn.date;
  return shaped;
}

/**
 * The one reader for every DATED payload field — `DatePromised`'s `dueOn`
 * and a commercial fact's `requestedFor` (ticket #70). Returns the day the
 * payload states, `{}` when it states none, or the refusal reason.
 *
 * A CALENDAR DATE, NOT AN INSTANT: «el sábado» has no time of day, and
 * storing a midnight would invent one. Refused rather than coerced — a day
 * the Ledger records wrongly is worse than one it does not record at all,
 * and an append-only payload cannot be corrected later (ADR-0034).
 *
 * One reader rather than one per field, so the two dates cannot drift into
 * accepting different things: the day a rep promised and the day a
 * customer asked for are the same stored shape, and the disclosure line
 * reads them through one renderer for exactly the same reason.
 */
function calendarDate(
  label: string,
  field: string,
  raw: unknown,
): { readonly date?: string } | string {
  if (typeof raw !== "string" || raw === "") return {};
  if (!isCalendarDate(raw)) {
    return `${label} \`${field}\` must be a real calendar date (YYYY-MM-DD), not ${JSON.stringify(raw)}`;
  }
  return { date: raw };
}

/**
 * `CustomerPattern` v1: ONE FIELD — the claim, and nothing verbatim from the
 * conversation (ticket #61; ADR-0040).
 *
 * `pattern` is the standing preference or constraint, composed by the model,
 * written to continue «Te dijo que …». It is normalized knowledge rather
 * than a message copy: «nomás recibimos hasta las 2, después ya no hay quien
 * descargue» becomes «solo recibe material antes de las 2 de la tarde»,
 * which is the whole reason a fact is worth more to the Ledger than the
 * transcript it came from.
 *
 * THE FIRST CUT OF THIS SHAPE ALSO STORED THE CUSTOMER'S WHOLE MESSAGE as
 * evidence, on `OrderTaken`'s `agreement` argument (ADR-0038): #66 measured
 * every wrong crossing arriving at 0.95–1.00, so no gate underneath catches
 * an invented pattern and the rep is the only reader who can — but only if
 * the line shows them the words. **Both review axes and Codex round 1
 * rejected it, and they were right.** A single customer message can carry a
 * standing preference AND a judgment about the rep — «usted siempre se
 * tarda, pero nosotros pagamos a 15 días» — and a whole-message copy files
 * the judgment into `ledger.finalized_facts` verbatim, under the one type
 * FR-30 names "rep tactics, judgments, or selling approach" against. The
 * corpus could not have caught it either: a label grades the claim, and the
 * evidence was a function of the message id, so the leak rode in ungraded.
 * That is the exact breach this type waited a whole slice to avoid, arriving
 * through the field added to prevent it.
 *
 * SO NOTHING VERBATIM CROSSES, and that is a stronger wall statement than
 * any other fact type makes — which is right for the one whose failure is a
 * breach rather than a wrong number. What reaches the Ledger is the twin's
 * own one-clause claim about how the customer buys. If the model writes a
 * rep judgment into THAT, it is a false positive the corpus grades and the
 * per-type row reports, rather than a laundering path no reader can see.
 *
 * THE REP STILL CATCHES A WRONG ONE THE WAY THEY CATCH «Te pidió …», and the
 * symmetry is the argument (ADR-0038). Evidence is required on `OrderTaken`
 * because its sentence claims THE REP ACTED, and a claim about the rep's own
 * act has to be evidenced rather than asserted. `CustomerPattern` claims the
 * COUNTERPARTY spoke, like `OrderRequested`, which carries no evidence field
 * and never has: the line names the act, the content and the provenance
 * («su chat, hoy 19:23»), and the rep corrects it with «N no» inside the
 * window.
 *
 * WHAT IS DELIBERATELY NOT HERE, under ADR-0034's one-chance rule. No `kind`
 * taxonomy (preference / cadence / constraint): grading it would measure the
 * model's choice of bucket rather than its reading. No observation count, no
 * first-seen date — cadence machinery, and cadence does not ship (see
 * `FACT_TYPES`). And no evidence field, per the above. Each of them is
 * addable later as an OPTIONAL field, where an absent one on a v1 row means
 * "the shape had no slot for it" and reads true; none of them could be
 * removed once stored, which is the direction that actually costs.
 */
function shapeCustomerPattern(
  input: Record<string, unknown>,
): Record<string, unknown> | string {
  const pattern = text(input["pattern"]);
  if (pattern === undefined) {
    return "CustomerPattern v1 requires `pattern`: the standing preference or constraint the customer stated";
  }
  return { pattern };
}

/**
 * `ContactEstablished` v1: the merge match keys, and who they belong to.
 *
 * This is the payload ADR-0035's ladder reads, so it is the one payload
 * that must be right in its first row: structured, multi-valued and
 * normalized, never free text. `identifiers` is always present with all
 * three arms, empty where nothing was found.
 */
function shapeContact(
  input: Record<string, unknown>,
  source: SeamSource,
): Record<string, unknown> | string {
  const raw = input["identifiers"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "ContactEstablished v1 requires an `identifiers` object";
  }
  const arms = raw as Record<string, unknown>;
  const identifiers = normalizeIdentifiers({
    phones: stringArray(arms["phones"]),
    emails: stringArray(arms["emails"]),
    rfcs: stringArray(arms["rfcs"]),
  });

  // THE LAUNDERING PATH (ADR-0004). The counterparty's own WhatsApp number
  // is chat identity: an owner holding it recovers the chat by comparison
  // with `scope_allowlist` and can message the rep's customer directly.
  // The Ledger wall sweep looks for JID SUFFIXES and would never see a
  // bare «+52…», so this is the only place it can be caught.
  //
  // The whole candidate is refused rather than the number quietly dropped:
  // a `ContactEstablished` whose only content was the chat's own address
  // is not a contact that was established, and silently filing the rest
  // would tell the rep a different thing crossed than did.
  for (const phone of identifiers.phones) {
    if (isChatOwnNumber(phone, source.chatJid)) {
      return `ContactEstablished v1 carries the counterparty's own WhatsApp number — that is chat identity, not a business fact, and it never crosses the wall (ADR-0004)`;
    }
  }
  if (
    identifiers.phones.length === 0 &&
    identifiers.emails.length === 0 &&
    identifiers.rfcs.length === 0
  ) {
    return "ContactEstablished v1 carries no normalized identifier — there is nothing established, and nothing for ADR-0035's ladder to match on";
  }

  const shaped: Record<string, unknown> = {
    identifiers: {
      phones: identifiers.phones,
      emails: identifiers.emails,
      rfcs: identifiers.rfcs,
    },
  };
  const contactName = text(input["contactName"]);
  if (contactName !== undefined) shaped["contactName"] = contactName;
  const role = text(input["role"]);
  if (role !== undefined) shaped["role"] = role;
  return shaped;
}

/**
 * A real calendar date, checked by ROUND TRIP (Codex r3).
 *
 * `Date.parse` is not calendar validation: it rolls `2026-02-30` forward to
 * March 2 and returns a number, so a shape check plus a NaN check accepts
 * an impossible date and stores it verbatim in an append-only payload that
 * ADR-0034 forbids rewriting. Formatting the parsed instant back and
 * comparing is the check that actually asks "is this a day that exists?".
 *
 * YEAR 0000 IS REFUSED, and it is the one year that needs naming (Codex r3
 * on #70). It round-trips perfectly — ISO 8601 has a year zero — but the
 * disclosure line renders a bare year with no era, and ISO year 0 IS 1 BC,
 * so `0000-01-01` reads back to the rep as «1 de enero de 1»: a different
 * value from the one stored, and character-for-character the same sentence
 * as `0001-01-01`. A line that states a day the Ledger does not hold is
 * the same failure as one that omits it — the rep confirms a value that
 * was never filed — which is exactly why #65 widened the number formatter
 * rather than let it round 0.125 to 0.13. Every other accepted year
 * renders as itself.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  if (value.startsWith("0000-")) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/** How long a free-text payload field may be — prose is not a fact. */
const MAX_TEXT = 200;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_TEXT) return undefined;
  return trimmed;
}

function positive(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

/** ISO 4217, uppercased — three letters or nothing. */
function currencyCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/u.test(code) ? code : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

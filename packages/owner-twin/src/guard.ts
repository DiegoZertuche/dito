/**
 * THE STRUCTURAL GUARD (ticket #130; spec #126 decision 8 and decision 18;
 * ADR-0037 as amended; ADR-0028 as amended).
 *
 * "CI ships the structural guard: a scripted model that types a provenance
 * line, cites a row the tool never served, or answers a wall question with
 * invented content, and the surface must refuse to render it." This is that
 * surface's refusal, and it runs before anything renders: an answer that
 * fails here is refused by its structured output's own `parse`, and a turn
 * that ends on no accepted answer settles `schema-miss` and appends its one
 * audit entry — the owner never sees a forged answer, and the failed-query
 * log records that one was attempted.
 *
 * IT IS STRUCTURE, NOT JUDGEMENT. Nothing here reads the question, decides
 * whether prose is true, or scores a refusal. Every rule below is a property
 * of the SHAPE of an answer against the rows this run actually served,
 * which is why it can run in CI with no model call at all (ADR-0028 as
 * amended) and why the wall does not depend on model behaviour once a read
 * owes a projection (ADR-0013 as amended).
 *
 * WHY THE FORBIDDEN WORDS ARE DERIVED AND NEVER WRITTEN. Every Spanish
 * token this file refuses comes from `@dito/aperture`'s renderers or from
 * `Intl` — the source-type labels, the fact-type tags, the confidence word,
 * the month and weekday names. Two reasons, and both matter:
 *
 *   the guard cannot drift from the renderer. The thing it refuses the
 *   model for typing is precisely the thing code is about to render, so a
 *   label that changes in `owner-render.ts` changes here in the same commit
 *   or not at all;
 *
 *   and no es-MX string the twin could say is a constant in this package
 *   (ADR-0037 as amended), which `composed-language.test.ts` enforces over
 *   the whole of `src`. A hand-written list of Spanish words here would be
 *   the first offender the sweep found — and it would be right, because a
 *   forbidden-word list is a list of things the product says.
 */
import {
  FACT_TYPES,
  OWNER_SOURCE_TYPE_LABELS,
  renderOwnerConfidence,
  renderOwnerFactTypeLabel,
  renderOwnerSeat,
  renderOwnerSourceType,
} from "@dito/aperture";
import { fold, slotReferences, typedProse } from "./prose.js";
import type { OwnerAnswer } from "./answer.js";
import type { ServedRow, ServedRows } from "./served.js";

/**
 * Any digit at all: a number, a year, a quantity, half a date.
 *
 * `\p{Nd}` AND NOT `\d` (Codex r2). JavaScript's `\d` is ASCII-only, so a
 * full-width `４` or an Arabic-Indic `٤` is a number the model typed that
 * the rule could not see — and both render as digits to the owner.
 */
const DIGITS = /\p{Nd}/u;

/**
 * A chat address in every suffix this repo accepts. A phone number is
 * caught by `DIGITS` above; this is the other spelling, which has none.
 *
 * `broadcast` WAS MISSING (Codex r2), which is the suffix `status@broadcast`
 * carries — the one address a model is most likely to have seen. The four
 * are the aperture's own set, and they are matched as the whole suffix
 * rather than as a word inside it.
 */
const ADDRESS = /@(?:s\.whatsapp\.net|g\.us|lid|broadcast|whatsapp)\b/iu;

/**
 * The words code renders and the model may therefore not type: a source
 * type, a fact-type tag, the confidence word, the not-recorded seat.
 *
 * Matched whole, accent- and case-folded, so «cotizacion» in a sentence is
 * fine and «Cotización dada» — the tag code puts at the head of a timeline
 * entry — is not. The rule is not "avoid this vocabulary"; it is "do not
 * type the line the receipt strip renders".
 */
const RENDERED_TOKENS: readonly string[] = [
  ...Object.keys(OWNER_SOURCE_TYPE_LABELS).map(renderOwnerSourceType),
  ...FACT_TYPES.map(renderOwnerFactTypeLabel),
  // «confianza», off the renderer's own output rather than written down.
  renderOwnerConfidence(0).split(" ")[0]!,
  renderOwnerSeat(null),
];

/**
 * Every month and weekday name, in the language the owner reads.
 *
 * A DATE THE MODEL TYPED HAS ONE OF TWO SHAPES and both are refused: digits
 * (caught above) or a calendar word (caught here). Derived from `Intl` over
 * twelve months and seven days rather than listed, for the reason the whole
 * header gives — and because `renderOwnerFactLine` composes its dates with
 * exactly this formatter, so what is refused is what code renders.
 */
const CALENDAR_WORDS: readonly string[] = calendarWords();

function calendarWords(): string[] {
  const months = new Intl.DateTimeFormat("es-MX", {
    month: "long",
    timeZone: "UTC",
  });
  const weekdays = new Intl.DateTimeFormat("es-MX", {
    weekday: "long",
    timeZone: "UTC",
  });
  const words: string[] = [];
  for (let month = 0; month < 12; month += 1) {
    words.push(months.format(new Date(Date.UTC(2026, month, 15))));
  }
  // 2026-02-01 is a Sunday, so seven consecutive days are seven weekdays.
  for (let day = 1; day <= 7; day += 1) {
    words.push(weekdays.format(new Date(Date.UTC(2026, 1, day))));
  }
  return words;
}

/** Whether a whole word or phrase appears in some prose. */
function says(prose: string, phrase: string): boolean {
  const folded = fold(phrase).trim();
  if (folded === "") return false;
  const escaped = folded.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(
    fold(prose),
  );
}

/**
 * What is structurally wrong with one answer, as sentences — a pure
 * function over the answer and the run's served rows, so the same rules
 * can be shown to bite against a synthetic offender in the same suite
 * (`projectionViolations`' habit, and `sole-writer.test.ts`'s before it).
 *
 * EVERY VIOLATION IS A REFUSAL THE MODEL IS HANDED (#133). The list goes
 * back to it as the reason its answer was not accepted, and it answers
 * again inside the budget it has; a turn that never gives an answer this
 * accepts is recorded `schema-miss`, the runtime's word for an answer it
 * could not accept, and nothing renders. The spec's shape is "each must be
 * refused before rendering", and it is.
 */
export function structuralViolations(
  answer: OwnerAnswer,
  served: ServedRows,
): string[] {
  const found: string[] = [];
  const proseFields: readonly (readonly [string, string])[] = [
    ["prose", answer.prose],
    ...(answer.kind === "refusal"
      ? ([["follow_up", answer.followUp]] as const)
      : []),
  ];

  // ONE: EVERY CITATION IS TO A ROW THIS RUN SERVED. The rule the whole
  // reference design exists for, checked on the WIRE reference before
  // anything is translated to an id — "this run never served that" is the
  // property being claimed, and a run-scoped number is what makes it
  // unforgeable from a previous answer.
  const cited: readonly (readonly [string, number])[] = [
    ...answer.references.map((ref) => ["references", ref] as const),
    // EVERY PROSE FIELD, NOT JUST `prose` (Codex r1). The follow-up is prose
    // the owner reads and it takes slots like any other — and a slot only
    // `render.ts` would ever look at is a slot nothing checked. An unserved
    // one used to reach the renderer, which threw inside the transaction
    // and took the execution's own audit entry down with it.
    ...proseFields.flatMap(([field, text]) =>
      slotReferences(text).map((ref) => [`a slot in ${field}`, ref] as const),
    ),
    ...(answer.kind === "ask"
      ? answer.candidates.map((ref) => ["candidates", ref] as const)
      : []),
    ...(answer.kind === "refusal" && answer.timelineRef !== undefined
      ? ([["timeline_ref", answer.timelineRef]] as const)
      : []),
    ...(answer.kind === "answer" && answer.countRef !== undefined
      ? ([["count_ref", answer.countRef]] as const)
      : []),
  ];
  for (const [where, ref] of cited) {
    if (served.get(ref) === undefined) {
      found.push(
        `${where} names reference ${ref}, which no tool served this turn`,
      );
    }
  }

  // TWO: A SLOT IS A CITATION. Prose that fills a value from a row it does
  // not list among its references would render provenance for a row the
  // receipt strip never mentions — a value with no line under it.
  for (const [field, text] of proseFields) {
    for (const ref of new Set(slotReferences(text))) {
      if (!answer.references.includes(ref)) {
        found.push(
          `a slot in ${field} fills reference ${ref}, which is not among the answer's references`,
        );
      }
    }
  }

  // THREE: THE MODEL TYPES NO NUMBER, NO DATE, NO NAME AND NO SOURCE
  // (ADR-0037 as amended). Every one of those is a value code renders from a
  // served row, and prose that carries one is prose the owner cannot check.
  for (const [field, text] of proseFields) {
    const typed = typedProse(text);
    if (DIGITS.test(typed)) {
      found.push(
        `${field} types a number or a date — every value is a slot filled from a served row (ADR-0037 as amended)`,
      );
    }
    for (const word of CALENDAR_WORDS) {
      if (says(typed, word)) {
        found.push(
          `${field} types a calendar day — a date is a slot filled from the row it happened on`,
        );
        break;
      }
    }
    for (const token of RENDERED_TOKENS) {
      if (says(typed, token)) {
        found.push(
          `${field} types a provenance line: code renders the fact type, the source, the seat and the confidence from the served row, and prose beside them would read exactly like them (spec #126 decision 8)`,
        );
        break;
      }
    }
    for (const name of served.servedNames()) {
      if (says(typed, name)) {
        found.push(
          `${field} types a name the tools resolved — a resolved name is a reference the room renders, never prose`,
        );
        break;
      }
    }
    if (ADDRESS.test(typed)) {
      // The wall's own signature. Nothing any tool serves can carry one —
      // there is no column for it — so prose that has one invented it.
      found.push(
        `${field} names a chat address, which no owner-visible row carries at all (ADR-0004 as amended)`,
      );
    }
    if (text.trim() === "") {
      found.push(`${field} is empty, and an empty turn is not an answer`);
    }
  }

  // FOUR: AN ANSWER RESTS ON THE RECORD, IN TWO SENSES, AND BOTH ARE
  // CHECKED. This is the rule the spec's third guard case is about — "a
  // scripted model that answers a wall question with invented content" —
  // and it took the two-axis review to find that one sense of it is not
  // enough.
  //
  // THE SECOND SENSE IS THE ONE THAT MATTERS MOST: a model that called NO
  // TOOL AT ALL and answered anyway. That is the realistic shape of
  // inventing, because inventing means not reading — and it produces no
  // digits, no served name and no rendered token, so every other rule here
  // passes it. It is refused whatever it says. The precedent is exactly
  // this, in `qa.ts`: "rejected: search_memory before answering, so the
  // answer rests on the rep's real history".
  //
  // THE FIRST SENSE is the one already here: a model that DID read, was
  // served rows, and then cited none of them. It answered from something
  // that was not in what it read.
  //
  // AND THE ONE HONEST EMPTY ANSWER SURVIVES BOTH, which is why the rule is
  // not simply "cite something": a turn that consulted the record and found
  // nothing has nothing to cite, and "I find nothing about that" is a true
  // answer about the record. That is qa.ts's carve-out too.
  if (answer.kind === "answer" && !answer.delayed) {
    if (answer.references.length === 0) {
      if (served.readsCompleted === 0) {
        found.push(
          "an answer reads the record first, and this one called no tool at all — whatever it says came from somewhere the owner cannot check",
        );
      } else if (served.size > 0) {
        found.push(
          "an answer cites the rows it rests on, and this one cites none while the tools served rows",
        );
      }
    } else if (
      // A DUMMY READ IS NOT A READ (Codex r1). Resolving a name and citing
      // the record it found costs one tool call and grounds nothing: the
      // prose beside it can say anything at all, and an answer citing only
      // NAMES has looked up who somebody is and never opened what the
      // record holds about them. So an answer that names a customer has to
      // have read something of theirs — a timeline row, or a count. The
      // honest empty answer still passes: the model reads the timeline, it
      // comes back with nothing, and it says so citing the record.
      !answer.references.some((ref) => {
        const row = served.get(ref);
        return row !== undefined && (row.kind === "fact" || row.kind === "count");
      }) &&
      // THE RECORD WAS NEVER OPENED (Codex r2 sharpened this). It used to
      // ask whether TWO reads had happened, which a model bought by calling
      // `resolve_entity` twice for the same customer. What the rule is
      // actually about is whether the record itself was read — a timeline,
      // or a count — rather than how many lookups were made.
      served.recordReads === 0
    ) {
      found.push(
        "an answer that cites only names has looked up who somebody is and never opened what the record holds about them — read the timeline or count before answering about a customer",
      );
    }
  }

  // FOUR (a): THE ONE ANSWER THAT RESTS ON NOTHING, AND MAY (FR-69; spec
  // #126 decision 17's last clause). A question about today is answered
  // with the by-design delay, and that answer must reveal nothing about the
  // window — "not that it is empty, not that it is quiet, not that there is
  // nothing new". So it is the one answer that carries NO references at
  // all, and the guard requires exactly that: a delayed answer that cited
  // something would be characterising the window it just declined to
  // characterise.
  if (answer.kind === "answer" && answer.delayed) {
    if (answer.references.length > 0) {
      found.push(
        "a by-design-delay answer cites nothing at all: what has not finalized is not yours to characterise, and a citation would characterise it (FR-69)",
      );
    }
  }

  // FIVE: THE ASK IS A DISAMBIGUATION (ADR-0039). Its candidates are the
  // records the owner is choosing between, so there are at least two of
  // them and every one is a name the tools resolved. An ask with one
  // candidate is not a question the owner's answer settles — it is a
  // question with one legal answer.
  if (answer.kind === "ask") {
    const candidates = answer.candidates;
    if (new Set(candidates).size !== candidates.length) {
      // «cual de los dos» offering the same record twice is not a choice
      // (Codex r3).
      found.push("an ask offers each record once, and this one repeats one");
    }
    if (new Set(candidates).size < 2) {
      found.push(
        "an ask offers the records the owner is choosing between, and this one offers fewer than two (ADR-0039)",
      );
    }
    const groups = new Set<number>();
    for (const ref of candidates) {
      const row = served.get(ref);
      if (row === undefined) continue;
      if (!isName(row)) {
        found.push(
          `candidate ${ref} is a ${row.kind} and an ask offers records to choose between`,
        );
        continue;
      }
      // ...AND IT CAME FROM AN AMBIGUITY (Codex r2; ADR-0039). Two records
      // each resolved cleanly from a DIFFERENT name are not a question the
      // owner's answer settles — they are two customers, and asking which
      // one somebody meant when they named neither is the twin spending the
      // owner's attention on its own uncertainty. The ask exists for one
      // name that matched more than one record.
      const group = served.ambiguityGroup(ref);
      if (group === undefined) {
        found.push(
          `candidate ${ref} was resolved unambiguously — the one legitimate ask is a NAME that matched more than one record (ADR-0039)`,
        );
        continue;
      }
      groups.add(group);
      // AND THE OWNER SEES IT, which is what makes the pill renderable: a
      // candidate the answer does not also list among its references is
      // a choice with no row behind it when the answer is re-read.
      if (!answer.references.includes(ref)) {
        found.push(
          `candidate ${ref} is not among the answer's references, so the choice would render with nothing behind it`,
        );
      }
    }
    // ONE NAME, AND ALL OF IT (Codex r3). Candidates drawn from two
    // different ambiguous names are two questions asked as one; a subset of
    // one name's records is a choice missing an option the owner may have
    // meant.
    if (groups.size > 1) {
      found.push(
        "an ask offers the records ONE name matched, and these came from more than one resolution (ADR-0039)",
      );
    } else if (groups.size === 1) {
      const [group] = [...groups];
      const members = served.ambiguityGroupMembers(group!);
      const offered = new Set(candidates);
      const missing = members.filter((ref) => !offered.has(ref));
      if (missing.length > 0) {
        found.push(
          `the name matched ${members.length} records and the ask offers ${offered.size} — a choice missing an option is not the choice the owner has`,
        );
      }
    }
  }

  // SIX: THE REFUSAL POINTS AT A TIMELINE, NOT AT A FACT (FR-46's
  // structure, ADR-0037 as amended). The pointer is "the relevant timeline
  // when an entity was named" — the record the owner may open — and a
  // refusal that pointed at one fact of it would be answering a little of
  // the question it just refused.
  if (answer.kind === "refusal" && answer.timelineRef !== undefined) {
    const row = served.get(answer.timelineRef);
    if (row !== undefined && row.kind !== "entity") {
      found.push(
        `timeline_ref names a ${row.kind}, and a refusal points at the customer's timeline`,
      );
    }
  }

  // SEVEN (a): A CITED COUNT IS A RENDERED COUNT, whether or not the
  // answer named it in `count_ref` (Codex r2). The slot requirement
  // used to hang off that optional field, so omitting it skipped the rule
  // entirely: cite the count row among the references, write «fueron
  // cuatro», and the model's own number was stored and rendered. A count is
  // the one served shape whose whole value is a number, so citing one and
  // not slotting it is citing a number nobody rendered.
  if (answer.kind === "answer") {
    const slots = slotReferences(answer.prose);
    for (const ref of answer.references) {
      const row = served.get(ref);
      if (row?.kind === "count" && !slots.includes(ref)) {
        found.push(
          `reference ${ref} is a count and no slot in prose fills it — the number is rendered from the row, never written`,
        );
      }
    }
  }

  // SEVEN (b): THE COUNT IS A COUNT. `count_ref` is what the number is
  // rendered from, so a reference to anything else would render a value the
  // tool never computed.
  if (answer.kind === "answer" && answer.countRef !== undefined) {
    const row = served.get(answer.countRef);
    if (row !== undefined && row.kind !== "count") {
      found.push(`count_ref names a ${row.kind} rather than a count`);
    }
    if (!answer.references.includes(answer.countRef)) {
      found.push(
        "count_ref is not among the answer's references, so the number would render with no receipt line under it",
      );
    }
    // ...AND THE NUMBER MUST BE RENDERED FROM IT (Codex r1). The digit rule
    // catches «fueron 4» and cannot catch «fueron cuatro» — no character
    // class does. What closes it is the other end: a turn that names a
    // count must put the count's SLOT where the number goes, so the number
    // the owner reads is code's whatever words surround it. A `count_ref`
    // nothing slots is a count nobody rendered.
    if (!slotReferences(answer.prose).includes(answer.countRef)) {
      found.push(
        `count_ref names reference ${answer.countRef} and no slot in prose fills it — the number is rendered from the row, never written`,
      );
    }
  }

  return found;
}

/** The reference-name class: a record or a seat the tools resolved (#134). */
function isName(row: ServedRow): boolean {
  return row.kind === "entity" || row.kind === "seat";
}

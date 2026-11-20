/**
 * THE `now` RECIPE — the one thing every automation is handed and no
 * definition rediscovers (ticket #178; spec #171 decisions 8(3) and 13;
 * ADR-0014 as amended — "a code-rendered «now» as a standard context recipe
 * (today in the seat's zone; on the owner side also the day the FR-69 window
 * closes)").
 *
 * IT MOVED HERE FROM THE REP SIDE, WHOLE (ticket #139's second ruling lived
 * in `packages/twin-runtime/src/rep-clock.ts`). Two renderings of one
 * instant that could disagree about a date was #139's founding complaint, so
 * shipping a second copy of the formatter beside the first — even one a test
 * proved byte-identical today — would have rebuilt exactly the hazard the
 * ticket closed. `rep-clock.ts` re-exports these two functions and keeps
 * every one of its own callers and tests; the dependency runs the only way
 * the wall allows, `twin-runtime` → `execution`.
 *
 * NOTHING HERE READS A CLOCK. Every function takes its instant, which is the
 * `reconcileFr70At` shape the rest of the repo already uses, and is what
 * lets the owner side hand in the instant it recorded a question at rather
 * than the instant a prompt happened to be assembled.
 */
import type { ParameterShape } from "./automation.js";
import type { RecipeRegistration, RecipeRegistry } from "./registry.js";

/**
 * The date-and-time vocabulary every rendering below shares.
 *
 * ONE OPTION SET, because two of them is the same defect as two formatters
 * one level down: `Sep 3` and `September 3` in one prompt would read as two
 * different notations for the model to reconcile.
 *
 * `en-US` WITH A SHORT MONTH, and it is metadata rather than anybody's
 * language: everything code writes into a turn is framing, and only the two
 * humans' words are Spanish. The 24-hour clock because `hour12` would put an
 * English «PM» into a turn that is otherwise all numbers.
 */
const CIVIL_DAY_OPTIONS = {
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric",
} as const satisfies Intl.DateTimeFormatOptions;

const TURN_INSTANT_OPTIONS = {
  ...CIVIL_DAY_OPTIONS,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/**
 * THE INSTANT THE MODEL READS — `Tuesday, Sep 1, 2026, 21:30:16 CST`
 * (ticket #139, second ruling).
 *
 * METADATA, IN ENGLISH: everything code writes into a turn is framing, and
 * only the two humans' words are Spanish. A Spanish weekday appears nowhere
 * except inside a message.
 *
 * THE HYPOTHESIS THIS WAS BUILT ON TURNED OUT TO BE WRONG, and that is
 * worth more than the rule it produced. The first cut wrote the framing in
 * Spanish — «Hoy es martes 1 de septiembre de 2026, 21:30» over beats
 * stamped «(martes 1 de septiembre de 2026, 10:50)» — and a weekday said on
 * the run's OWN day fell from 19-of-21 right to 5-of-24, answering the
 * Tuesday a week out. It read like the model echoing the weekday word the
 * framing put in front of it. Rewriting the framing as English metadata did
 * NOT bring those cases back: 4-of-21. Same failure, same wrong date, no
 * Spanish anywhere near it.
 *
 * SO THE CAUSE IS THE DATE, NOT THE LANGUAGE. What both post-#139 arms
 * share and the pre-#139 renderer lacks is a full calendar date on EVERY
 * BEAT. Before, a beat carried a raw UTC ISO instant, which the model
 * plainly ignored in favour of the one day line; now it anchors on the
 * beat's own date and overshoots — «el lunes» said on Tuesday the 1st comes
 * back as Tuesday the 8th, which is the beat's own weekday plus seven rather
 * than the next Monday. The stamps still fix the case only they can express
 * (a weekday said one day and read another: 0-of-7 to 7-of-7). The trade is
 * real and it is the owner's to make.
 *
 * The rule stands on its own merits regardless — framing that cannot be
 * mistaken for speech is worth having — but it is not the fix it was reached
 * for as.
 *
 * ONE FORMATTER FOR THE HEADER, EVERY BEAT AND EVERY AUTOMATION'S `now`
 * PART, so no two of them can disagree about a date — which was #139's own
 * founding complaint, and it survives both the language change and the move
 * into this package intact.
 *
 * THE SECONDS ARE THERE because two beats can share a minute and their
 * order is the thing a reaction and its removal turn on (ADR-0041).
 *
 * THE ZONE ABBREVIATION IS AMBIGUOUS ON ITS OWN — CST is Monterrey here and
 * China elsewhere — which is exactly why `renderTurnHeader` spells the IANA
 * name out once, at the top, and the beats carry the short form.
 *
 * NOT THE REP'S SENTENCE, and it must never become it: `renderCalendarDate`
 * on the rep side is what the rep reads a day in (#65), it is Spanish, and
 * it stays that way. These renderings are separate functions on purpose.
 */
export function renderTurnInstant(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    ...TURN_INSTANT_OPTIONS,
  }).format(at);
}

/**
 * THE TURN'S FIRST LINE — `[Now: Tuesday, Sep 1, 2026, 21:30:16 CST
 * (America/Monterrey)]` (ticket #139, second ruling).
 *
 * IT REPLACED A SENTENCE. #121 opened the turn with «Hoy es martes 1 de
 * septiembre de 2026 (America/Monterrey).» — prose, in the conversation's
 * own language, one line above a transcript of people talking. It read as
 * speech, and the model treated it as speech: see `renderTurnInstant`. This
 * says the same thing and cannot be mistaken for anybody's words.
 *
 * IT IS THE EXECUTION'S OWN `now` — the read-through instant, moved by
 * `DITO_RIG_NOW` on the rig (#67), the instant the owner web recorded a
 * question at — never the seam's watermark clock. The hour is load-bearing
 * rather than decorative: «mañana» said at 23:50 and read at 00:10 is
 * otherwise unresolvable, because the model knows which day the run thinks
 * it is and not how close to its edge it is standing.
 *
 * THE IANA NAME IS SPELLED OUT HERE AND ONLY HERE. `timeZone` is optional
 * across this module — unset means the host clock, which is what the rig
 * runs on when `DITO_TIME_ZONE` is absent — so the RESOLVED zone is what
 * gets printed rather than an empty bracket or a claim about a zone nothing
 * used.
 */
export function renderTurnHeader(at: Date, timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `[Now: ${renderTurnInstant(at, zone)} (${zone})]`;
}

/**
 * A CALENDAR DAY AS THE MODEL READS IT — `Thursday, Sep 3, 2026`.
 *
 * The header's own vocabulary with the clock taken off, for the one thing
 * the owner side has to say about a day rather than an instant. The weekday
 * is not decoration: «esta semana» is a question about weekdays, and a date
 * with no weekday leaves the model to compute one.
 *
 * DERIVED BY FORMATTING IN THE ZONE, never by day arithmetic on an instant,
 * so a DST transition cannot move it: whichever day the zone shows for this
 * instant IS the day, and nothing here adds or subtracts a day to find out.
 */
export function renderCivilDay(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    ...CIVIL_DAY_OPTIONS,
  }).format(at);
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** A civil date as `YYYY-MM-DD`, in the given zone. */
function civilDate(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}

/**
 * THE LAST CALENDAR DAY WHOSE FACTS ARE ALL FINALIZED (FR-69; the ticket's
 * own words for what the owner variant renders).
 *
 * WHY IT IS THE DAY BEFORE THE BOUNDARY'S DAY, and this is the finding that
 * earned it (Codex r3). The boundary is an INSTANT — Thursday at 12:00, say
 * — and the reads compare instants: a `from` of Thursday 18:00 is REFUSED.
 * The first cut of this line named Thursday and told the model it could
 * anchor "on or before that day", which is the exact disagreement between
 * the sentence and the refusal that this recipe exists to prevent. A model
 * following it would have been refused with no way to see why.
 *
 * So the line names the last day that is WHOLLY readable: every instant in
 * it is at or before the boundary, so a window anchored anywhere inside it
 * — or at its start, or earlier — is always accepted. That is also the
 * ticket's own definition: "the latest calendar day whose facts are
 * finalized".
 *
 * ONE DAY BACK, ALWAYS, and the one second it costs is the right way to be
 * wrong. A boundary at Thursday 23:59:59 leaves Thursday readable for all
 * but its last second, and this still answers Wednesday — over-refusing a
 * window is a read the owner can re-ask with an earlier anchor, and
 * under-refusing one is the leak (`OWNER_LAG_HOURS`' own argument).
 *
 * CALENDAR ARITHMETIC ON A DATE, never on an instant, so DST cannot reach
 * it: the civil date is read in the zone first and the day is subtracted in
 * UTC, where every day is 24 hours long by construction.
 */
function lastWhollyFinalizedDay(boundary: Date, timeZone?: string): Date {
  const [year, month, day] = civilDate(boundary, timeZone).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1));
}

/**
 * THE EDGE OF WHAT HAS FINALIZED (FR-69), as one instant.
 *
 * ONE COMPUTATION, TWO READERS, and that is the whole reason it is a
 * function. The owner tools REFUSE a window whose start falls after this
 * instant, and `now_owner` TELLS the model which day it is — and a sentence
 * that disagreed with the refusal would be worse than no sentence at all:
 * the model would anchor a read where it was told it could and be refused,
 * every time, with no way to see why. Both sides now compute the boundary
 * here, from the lag their caller passed.
 *
 * THE LAG IS THE CALLER'S NUMBER. It is the owner side's (`OWNER_LAG_HOURS`,
 * argued against FR-69 in `@dito/owner-twin`), and a 24 written into this
 * package would be the second copy of exactly the constant this function
 * exists to keep single.
 */
export function finalizedThrough(at: Date, lagHours: number): Date {
  return new Date(at.getTime() - lagHours * MS_PER_HOUR);
}

/** The registry key, and the name of the part it renders. */
export const NOW_RECIPE = "now";
/** The owner side's variant — the same header plus the FR-69 edge. */
export const NOW_OWNER_RECIPE = "now_owner";

/** What the part is called wherever it is rendered from. */
const NOW_PART = "now";

const NOW_PARAMETERS = {
  at: "instant",
  timeZone: "zone",
} as const satisfies ParameterShape;

/**
 * `now` — today and this hour, in the seat's zone.
 *
 * TWO PARAMETERS AND NO CLOCK. The instant and the zone are the occasion's:
 * a customer burst's `now` is when the runtime picked it up, an owner
 * question's is when the app recorded it, and the rig moves both with
 * `DITO_RIG_NOW`. A recipe that read the host clock would make every one of
 * those unmovable and would make this package's tests depend on where they
 * ran.
 */
const now: RecipeRegistration<unknown> = {
  parameters: NOW_PARAMETERS,
  // BINDS NOTHING (ticket #172). A recipe's factory takes the execution's
  // dependencies so a rep-side part can render content the occasion holds;
  // this one renders an instant and a zone, both of them parameters, so it
  // ignores its argument — which is what makes it typed over `unknown` and
  // therefore spreadable into any app's registry.
  create: () => (values) => ({
    name: NOW_PART,
    text: renderTurnHeader(values["at"] as Date, values["timeZone"] as string),
  }),
};

/**
 * `now_owner` — the same header, plus the day the FR-69 window closes.
 *
 * A SIBLING RECIPE RATHER THAN `now` WITH AN OWNER FLAG, decided at #178.
 * Three reasons, in the order they matter. Its parameter SHAPE differs — the
 * lag is required here and meaningless rep-side — and a recipe whose shape
 * varies by caller is two recipes wearing one name, which is exactly what
 * the spec's shape check would then be unable to catch. The digest covers
 * the recipe NAME, so `now_owner` in a spec is a legible diff where an
 * optional flag inside one `now` would not be. And the rep side never has to
 * carry a parameter it must remember to leave out. What they share is every
 * line of the rendering, which is why the header cannot drift between them.
 *
 * WHY THE OWNER SIDE NEEDS THE SECOND LINE AT ALL. The owner's questions are
 * about windows — «entre el 1 y el 3», «la semana pasada» — and the tools
 * REFUSE a window anchored inside the region that has not finalized (FR-69).
 * Without this line the model learns that boundary only by being refused,
 * and it cannot tell a refusal about recency from a refusal about the wall.
 *
 * IT NAMES THE EDGE AND NOTHING PAST IT. FR-69's sentence is that the recent
 * region's contents must not be characterised — "not that it is empty, not
 * that it is quiet, not that there is nothing new" — so the line says which
 * day the record is complete through and stops. What to DO about a question
 * inside that window is the instructions' business, not this part's.
 */
const nowOwner: RecipeRegistration<unknown> = {
  parameters: { ...NOW_PARAMETERS, lagHours: "hours" },
  create: () => (values) => {
    const at = values["at"] as Date;
    const timeZone = values["timeZone"] as string;
    const through = finalizedThrough(at, values["lagHours"] as number);
    return {
      name: NOW_PART,
      text: [
        renderTurnHeader(at, timeZone),
        // RENDERED IN UTC, and that is not a slip: the value is a bare
        // calendar day with no time in it, built as UTC midnight by
        // `lastWhollyFinalizedDay`, so formatting it in the owner's zone
        // would shift it backwards by the offset and name the day before.
        `[Finalized through: ${renderCivilDay(lastWhollyFinalizedDay(through, timeZone), "UTC")}. Reads may anchor on or before that day; anything later has not finalized.]`,
      ].join("\n"),
    };
  },
};

/**
 * The recipes the runtime ships, as a registry fragment an app spreads into
 * its own.
 *
 * A CONSTANT AN APP MUST INCLUDE, not a global anything registers into. The
 * distinction the "a registry is a value" rule is about is MUTATION: a
 * registry code writes into at import time makes a tool's reach depend on
 * module load order, and would put a rep-side recipe within the owner
 * twin's reach with nothing in the way. This is a frozen value with two
 * entries, and an app that does not spread it has no `now` at all.
 */
export const STANDARD_RECIPES: RecipeRegistry<unknown> = Object.freeze({
  [NOW_RECIPE]: now,
  [NOW_OWNER_RECIPE]: nowOwner,
});

/**
 * WHAT AN EXTRACTION EXECUTION IS SHOWN, AS RECIPES (ticket #194; spec #193
 * decision 16).
 *
 * Three parts beside the runtime's `now`, and every one of them renders from
 * `deps` rather than from a parameter — see `deps.ts` for why content cannot
 * be a parameter and must not try to be.
 *
 * THE ORDER IS THE SPEC'S AND IT IS LOAD-BEARING (`automation.ts`). `now`
 * first, because it is framing rather than material; then who this chat is;
 * then what was said before the window, which the model is told is already
 * handled; then THE DAY, last and nearest what it has to answer about. It is
 * drafting's own ordering with one substitution — the day where the turn goes
 * — and it is the first time extraction is shown a chat's history at all: the
 * harness gave it the window and nothing before it.
 *
 * NO `rep_language`, and that is a decision rather than an omission (spec
 * #193 decision 16). That part is about how the twin WRITES, and an
 * extraction writes nothing anybody reads: its whole output is typed fields
 * the aperture normalizes and code renders. Adding it would tell the model
 * about a voice it never uses.
 *
 * WHAT THE MODEL MAY CITE IS THE DAY, BY CONSTRUCTION. The transcript's lines
 * carry no ids (`drafting/lines.ts`) and the day's do (`lines.ts`), so a
 * candidate can only name a beat inside the window — and `extractChat`
 * refuses one that names anything else anyway, which is the fence rather than
 * this.
 */
import type { NamedPart, RecipeRegistry } from "@dito/execution";
import {
  CHAT_BINDING_RECIPE,
  RECENT_TRANSCRIPT_RECIPE,
  recentTranscriptPart,
} from "../chat-context.js";
import type { ExtractionDeps } from "./deps.js";
import { renderDayLines } from "./lines.js";

export { CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE };

/** The window's beats in order, with their ids — what a fact may be read in. */
export const THE_DAY_RECIPE = "the_day";

/**
 * WHO THIS CHAT IS (spec #193 decision 16: "`chat_binding` (the shared
 * recipe)").
 *
 * ONE ARM WHERE DRAFTING HAS THREE, because the pass enumerates BOUND chats:
 * a chat with no binding has no entity, a fact with no entity has nowhere to
 * go (FR-32, absolute), and such a chat gets the pass's binding proposal and
 * no execution at all (spec #193 decision 9). So there is no unconfirmed
 * name to be careful with and no question to compose — the name here is the
 * REP's own word, and saying so is what stops the model treating it as
 * something the phone offered.
 *
 * ITS OWN RENDERER RATHER THAN DRAFTING'S (`chat-context.ts` argues the
 * split): drafting's first sentence says «You are drafting for …», which is
 * false of a run that writes nothing. The NAME is shared, which is what a
 * spec and the digest see.
 */
const chatBinding = (deps: ExtractionDeps) => (): NamedPart => ({
  name: "chat binding",
  text: `You are reading the rep's conversation with ${deps.counterparty}. The rep has confirmed who this is, so the name is theirs rather than the phone's.`,
});

/** What was said before the window — the shared part, bound to this chat's rows. */
const recentTranscript = (deps: ExtractionDeps) => (): NamedPart =>
  recentTranscriptPart(deps.transcript);

/**
 * THE DAY — the window's beats, in order, each with its id (spec #193
 * decision 16).
 *
 * THE THING A FILING MAY CITE, and the block the whole tool is
 * about. It says so out loud rather than relying on the ids: a model shown
 * two transcripts has to be told which one it is recording facts from.
 *
 * A WINDOW IS NOT ALWAYS ONE DAY, and the heading does not claim it is. The
 * pass's window runs from where this chat was last read through to now, which
 * a recovery carries across up to seven rep days (`windowFor`) — so the beats
 * carry their own stamps and the block names itself for what it is rather
 * than for the ordinary case.
 */
const theDay = (deps: ExtractionDeps) => (): NamedPart => ({
  name: "the day",
  text: `The messages you are recording facts from, oldest first. These, and only these, are what a fact may be read in — cite a line by the id in front of it:\n${renderDayLines(deps.day, deps.timeZone)}`,
});

/**
 * The three, as a registry fragment the extraction registries spread beside
 * `STANDARD_RECIPES`.
 *
 * A CONSTANT, NEVER A GLOBAL ANYTHING WRITES INTO — the rule `registry.ts`
 * states and `STANDARD_RECIPES` already follows. Every entry is a factory, so
 * the value holds no execution's data and two concurrent runs share nothing
 * but the code.
 */
export const EXTRACTION_RECIPES: RecipeRegistry<ExtractionDeps> = Object.freeze({
  [CHAT_BINDING_RECIPE]: { parameters: {}, create: chatBinding },
  [RECENT_TRANSCRIPT_RECIPE]: { parameters: {}, create: recentTranscript },
  [THE_DAY_RECIPE]: { parameters: {}, create: theDay },
});

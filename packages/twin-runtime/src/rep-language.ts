/**
 * HOW THIS REP TALKS — one fact about one rep, and ONE rendering of it
 * (ticket #172; spec #171 decision 15 and user story 17; ticket #173's
 * two-axis review, Standards axis).
 *
 * IT IS DATA THE TWIN IS TOLD, WHICH IS THE WHOLE POINT. User story 17: "I
 * want drafts in the language and register my conversations use, told to the
 * twin as a fact about me rather than a line in its code, so that a rep in
 * another register is not fighting a constant." Both harnesses carried «this
 * rig's traffic is Mexican Spanish» inside their prompts, so a rep in another
 * register had no way to be right.
 *
 * IT LIVES ABOVE BOTH AUTOMATIONS BECAUSE TWO OF THEM RENDER IT. Drafting and
 * the twin thread each register a `rep_language` recipe, and #173 first wrote
 * the sentence out twice — which is exactly the hazard `@dito/execution`'s
 * README argues about `renderTurnInstant`: "a test proving two copies agree
 * today is not the same claim as there being one". The rep is one person, and
 * a twin that read their register two ways would draft in one and answer in
 * the other. Registries stay per automation (that is the safety, `registry.ts`);
 * what is shared is the NAME and the WORDS.
 *
 * ONE STRING, NOT TWO KNOBS. Language and register are one sentence about how
 * one person talks, and splitting them into two settings would mean the rep
 * notepad, which renders this line as its own first line before the rep's
 * words (`rep-notepad.ts`; ADR-0033; CONTEXT.md *Rep notepad*), has to render
 * two.
 *
 * TWO OF THE THREE AUTOMATIONS THAT RENDERED IT NOW RENDER THE NOTEPAD
 * INSTEAD (ticket #260). Drafting and the twin thread write FOR the rep, so
 * they get the notebook; the daily disclosure reports what crossed and keeps
 * the register line by itself, which is why this recipe is still registered
 * and still exported.
 */
import type { NamedPart } from "@dito/execution";

/** The registered recipe name, shared by every automation that renders it. */
export const REP_LANGUAGE_RECIPE = "rep_language";

/**
 * THE DEFAULT IS STILL THIS RIG'S TRAFFIC, and the difference from the
 * constant it replaced is not cosmetic: it is a boundary default the rig
 * overrides with `DITO_REP_LANGUAGE`, it reaches the model as CONTEXT rather
 * than as instructions, and it is one line to replace when the notepad lands.
 * The instructions themselves name no language at all.
 */
export const DEFAULT_REP_LANGUAGE = "Mexican Spanish, informal WhatsApp";

/**
 * The sentence itself, without a part around it.
 *
 * ENGLISH BRACKETED METADATA, the shape #143 ruled for everything code writes
 * into a turn: framing that cannot be mistaken for anybody's speech. The
 * instructions say to write in the register this line names; they name none
 * themselves, which is what makes a rep in another register something to
 * configure rather than something to fight.
 *
 * SEPARATE FROM ITS PART BECAUSE TWO PARTS CARRY IT (ticket #260): the
 * disclosure's `rep_language`, and the notepad's own first line
 * (`rep-notepad.ts`). One function, so the register a twin drafts in and the
 * register it reports the day in cannot be written two ways.
 */
export function repLanguageLine(repLanguage: string): string {
  return `[The rep's language and register: ${repLanguage}.]`;
}

/** The part, as the automation that renders the line alone renders it. */
export function repLanguagePart(repLanguage: string): NamedPart {
  return { name: "rep language", text: repLanguageLine(repLanguage) };
}

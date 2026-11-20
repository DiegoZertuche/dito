/**
 * WHAT A DISCLOSURE EXECUTION IS SHOWN, AS RECIPES (ticket #198; spec #193
 * decision 22: "`now`; the rep's language; the day's groups and numbered
 * lines as data … the counts. No tools").
 *
 * Three parts beside the runtime's `now` — the shared `rep_language` and the
 * two this occasion holds — and every one renders from `deps` rather than
 * from a parameter, because a day's lines are content and content cannot be a
 * scalar parameter (`registry.ts`).
 *
 * THE ORDER IS THE SPEC'S AND IT IS THE ORDER OF THE JOB. `now` first,
 * because it is framing rather than material. Then how this rep talks, which
 * is about the ANSWER rather than about the day — the same place drafting puts
 * it. Then the record, which is what the opening is about. Then the counts,
 * last, because they are a fact about everything above them. The spec's
 * fourth part — the open questions the leads and asks were about — left with
 * the route at #218, and the digest moves because the parts list is what it
 * stamps.
 *
 * `rep_language` IS THE SHARED RECIPE AND NOT A SECOND ONE (`rep-language.ts`;
 * #173's two-axis review): the rep is one person, and a twin that read their
 * register two ways would draft in one and account for the day in the other.
 */
import type { NamedPart, RecipeRegistry } from "@dito/execution";
import { REP_LANGUAGE_RECIPE, repLanguagePart } from "../rep-language.js";
import type { DisclosureDeps } from "./deps.js";
import { renderCountsBlock, renderRecordBlock } from "./lines.js";

export const THE_RECORD_RECIPE = "the_record";
export const THE_COUNTS_RECIPE = "the_counts";

/** The day's lines, exactly as the post will carry them (`lines.ts`). */
const theRecord = (deps: DisclosureDeps) => (): NamedPart => ({
  name: "the day's record",
  text: renderRecordBlock(deps),
});

/** ...and what size of day this is, in the one place a digit belongs. */
const theCounts = (deps: DisclosureDeps) => (): NamedPart => ({
  name: "how big the day was",
  text: renderCountsBlock(deps),
});

/** How this rep talks — the shared part, bound to this seat's value. */
const repLanguage = (deps: DisclosureDeps) => (): NamedPart =>
  repLanguagePart(deps.repLanguage);

/**
 * The three, as a registry fragment the disclosure registries spread beside
 * `STANDARD_RECIPES`.
 *
 * A CONSTANT, NEVER A GLOBAL ANYTHING WRITES INTO — the rule `registry.ts`
 * states. Every entry is a factory, so the value holds no execution's data.
 */
export const DISCLOSURE_RECIPES: RecipeRegistry<DisclosureDeps> = Object.freeze(
  {
    [REP_LANGUAGE_RECIPE]: { parameters: {}, create: repLanguage },
    [THE_RECORD_RECIPE]: { parameters: {}, create: theRecord },
    [THE_COUNTS_RECIPE]: { parameters: {}, create: theCounts },
  },
);

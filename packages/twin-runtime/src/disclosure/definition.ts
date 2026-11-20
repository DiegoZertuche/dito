/**
 * THE DAY'S DISCLOSURE, AS DITO SHIPS IT (tickets #198, #364; ADR-0014 as
 * amended 2026-10-07; spec #193 decisions 21–24; ADR-0016: extraction is cut
 * ahead of it).
 *
 * One of Dito's automations, fired by the clock at the rep's disclosure hour
 * once the day's extraction run has ended, the batch lane is idle, no attempt
 * was made today and the day owes a line (`runs/preconditions.ts`), or by the
 * rep's own request — one run each time, in Trabajos en curso, of one `agent`
 * step: shown how this rep talks, the day's record already numbered and how
 * big the day was, it posts the day through `post_disclosure`, writing the
 * opening and the closing around code's numbered lines (ADR-0037).
 *
 * NO `post` STEP: the day's notes ARE the card the run lands, posted by its
 * tool; the run's end wakes the thread.
 *
 * FOUR ROUNDS: one honest attempt and three corrections of a call the guard
 * refused — it reads nothing, so nothing else spends a round.
 */
import { DEFAULT_MAX_TOKENS, renderParts } from "@dito/execution";
import { REP_LANGUAGE_RECIPE } from "../rep-language.js";
import type { RunDefinition } from "../runs/definition.js";
import { disclosureInstructions } from "./instructions.js";
import { POST_DISCLOSURE_TOOL } from "./post-disclosure.js";
import { THE_COUNTS_RECIPE, THE_RECORD_RECIPE } from "./recipes.js";

/** The rounds the day's post may take: one attempt and three corrections. */
const DISCLOSURE_MAX_ITERATIONS = 4;

export const DISCLOSURE_DEFINITION: RunDefinition = {
  name: "daily_disclosure",
  budget: { iterations: DISCLOSURE_MAX_ITERATIONS, tokens: DISCLOSURE_MAX_ITERATIONS * 8 * DEFAULT_MAX_TOKENS },
  steps: [
    {
      kind: "agent",
      name: "post_the_day",
      instructions: renderParts(disclosureInstructions()),
      tools: [POST_DISCLOSURE_TOOL],
      recipes: [REP_LANGUAGE_RECIPE, THE_RECORD_RECIPE, THE_COUNTS_RECIPE],
    },
  ],
};

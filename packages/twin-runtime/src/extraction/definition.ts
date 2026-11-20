/**
 * THE DAY'S EXTRACTION, AS DITO SHIPS IT (ticket #364; ADR-0014 as amended
 * 2026-10-07; spec #48 decisions 4 and 13; spec #193 decisions 9, 10 and 19).
 *
 * One of Dito's automations, fired by the clock at the rep's disclosure hour
 * when the seam has settled and a chat-day is unsettled
 * (`runs/preconditions.ts`) — and again that day, once its run has ended,
 * while one is still left — or by the rep's own request: one run each time,
 * in Trabajos en curso, with three steps:
 *
 *   1. `claim` — code: every chat with an unsettled chat-day claimed for one
 *      read (`claimChatDays`); an unbound chat gets the binding question and
 *      waits, an empty window settles with no read;
 *   2. `each_chat` — one child run per claim, whose one `agent` step reads that
 *      chat's day with the three reads and files what it found through
 *      `file_facts`, under the correction window;
 *   3. `settle` — code: whatever no child filed settles `failed`, and the
 *      merge ladder is climbed over the day's facts (`settleChatDays`).
 *
 * NO `post` STEP: the run lands no card of its own — the facts reach the rep
 * as the day's notes, and the run's end wakes the thread.
 *
 * THE BUDGET is six rounds per child, up to the most children an `each`
 * makes, and a generous token ceiling per child: the `each` splits what is
 * left evenly over the claims it has, and a child's step takes its share
 * (ticket #396).
 */
import { createHash } from "node:crypto";
import { renderParts } from "@dito/execution";
import type { ModelCallConfig } from "../model-config.js";
import {
  CLAIM_CHAT_DAYS_RECIPE,
  MAX_REPEATS,
  runDigest,
  SETTLE_CHAT_DAYS_RECIPE,
  type RunDefinition,
} from "../runs/definition.js";
import { FILE_FACTS_TOOL } from "./file-facts.js";
import { extractionInstructions } from "./instructions.js";
import { CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE, THE_DAY_RECIPE } from "./recipes.js";
import { LIST_CHATS_TOOL, READ_FILED_FACTS_TOOL, SEARCH_CHAT_HISTORY_TOOL } from "./tools.js";

/** The tokens one chat's read may spend, at most: its rounds over a day and its history. */
const TOKENS_PER_CHAT = 400_000;

/** The rounds Dito gives one chat's read, before the `each` splits what is left. */
export const ROUNDS_PER_CHAT = 6;

export const EXTRACTION_DEFINITION: RunDefinition = {
  name: "extraction",
  budget: {
    iterations: ROUNDS_PER_CHAT * MAX_REPEATS,
    tokens: TOKENS_PER_CHAT * MAX_REPEATS,
  },
  steps: [
    {
      kind: "code",
      name: "claim",
      recipe: CLAIM_CHAT_DAYS_RECIPE,
      inputs: {
        chat: "input.chat",
        reextract: "input.reextract",
        now: "input.now",
        seam_now: "input.seam_now",
        request: "input.request",
      },
    },
    {
      kind: "each",
      name: "each_chat",
      over: "claim.claims",
      item: "claim",
      body: [
        {
          kind: "agent",
          name: "extract",
          instructions: renderParts(extractionInstructions()),
          tools: [SEARCH_CHAT_HISTORY_TOOL, LIST_CHATS_TOOL, READ_FILED_FACTS_TOOL, FILE_FACTS_TOOL],
          recipes: [CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE, THE_DAY_RECIPE],
        },
      ],
    },
    {
      kind: "code",
      name: "settle",
      recipe: SETTLE_CHAT_DAYS_RECIPE,
      inputs: { claims: "claim.claims" },
    },
  ],
};

/**
 * THE EXTRACTOR'S STAMP FOR ONE RUNG — what the eval report records beside
 * its number (tickets #194, #364; spec #193 decision 30): the shipped
 * definition's digest, which covers its instructions, its tools and its
 * budget, with the model and effort it read on.
 *
 * WHAT IT CANNOT SEE: the day's rendering, the claim's window, the aperture's
 * shaping and the scorer are code the digest does not hash, so a changed
 * pipeline is answered by re-measuring the report rather than by a wider hash.
 */
export function extractionDigest(rung: ModelCallConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([runDigest(EXTRACTION_DEFINITION), rung.model, rung.effort ?? null]))
    .digest("hex")
    .slice(0, 32);
}

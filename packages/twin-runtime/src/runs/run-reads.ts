/**
 * WHAT A RUN HANDS ONE STEP TO READ OR POST (ticket #364): the chat-day a
 * child of the extraction run was given, and the day the disclosure run owes
 * — opened on the step's own connection, for the step that names a tool or a
 * recipe that needs them (`run-tools.ts`, `conversation.ts`).
 *
 * CODE DECIDES FROM WHAT THE STEP NAMES AND WHAT ITS RUN WAS STARTED WITH:
 * a step naming the day's reads or the filing, in a run whose inputs carry a
 * claim, is handed that claim; a step naming the day's post is handed the day
 * owed. Nothing here reads what a model wrote.
 */
import type pg from "pg";
import { CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE } from "../chat-context.js";
import { dayOwed, openDayToPost, type DailyDisclosureDeps } from "../disclosure.js";
import { THE_COUNTS_RECIPE, THE_RECORD_RECIPE } from "../disclosure/recipes.js";
import { claimChatDays, daySettled, openChatDay, settleChatDays, type DailyExtractionDeps } from "../extraction-pass.js";
import { THE_DAY_RECIPE } from "../extraction/recipes.js";
import type { RunValues } from "./definition.js";
import type { RunDeps } from "./engine.js";
import { CHAT_DAY_TOOLS, DAY_TO_POST_TOOLS, type RunStepReads } from "./run-tools.js";

export { claimChatDays, dayOwed, daySettled, settleChatDays };

/** The recipes that render a chat's day, and the ones that render the day's record. */
const CHAT_DAY_RECIPES: ReadonlySet<string> = new Set([CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE, THE_DAY_RECIPE]);
const DAY_TO_POST_RECIPES: ReadonlySet<string> = new Set([THE_RECORD_RECIPE, THE_COUNTS_RECIPE]);

/** The day's read, as the runtime's deps and one connection make it. */
export function extractionDepsOf(deps: RunDeps, db: pg.ClientBase): DailyExtractionDeps {
  return {
    db,
    executionPool: deps.executionPool,
    harness: deps.harness,
    bundle: deps.bundle,
    embedder: deps.embedder,
    dek: deps.dek,
    hmacKey: deps.hmacKey,
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    drafting: deps.drafting,
    ...(deps.extraction === undefined ? {} : { extraction: deps.extraction }),
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    ...(deps.historyLimit === undefined ? {} : { historyLimit: deps.historyLimit }),
    ...(deps.disclosureHour === undefined ? {} : { disclosureHour: deps.disclosureHour }),
  };
}

/** The day's post, as the runtime's deps and one connection make it. */
export function disclosureDepsOf(deps: RunDeps, db: pg.ClientBase): DailyDisclosureDeps {
  return {
    db,
    executionPool: deps.executionPool,
    harness: deps.harness,
    bundle: deps.bundle,
    dek: deps.dek,
    hmacKey: deps.hmacKey,
    twinId: deps.twinId,
    selfChatJid: deps.selfChatJid,
    drafting: deps.drafting,
    ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    ...(deps.repLanguage === undefined ? {} : { repLanguage: deps.repLanguage }),
    ...(deps.disclosureHour === undefined ? {} : { disclosureHour: deps.disclosureHour }),
  };
}

/**
 * What one step is handed, by what it names: its tools and its recipes. A
 * claim already settled, or a day that owes nothing, hands nothing —
 * the tools say so when called and the recipes render nothing.
 */
export async function stepReadsOf(
  client: pg.ClientBase,
  deps: RunDeps,
  names: readonly string[],
  values: RunValues,
  executionId: string,
  now: Date,
): Promise<RunStepReads> {
  const claim = values.inputs["claim"];
  const readsChatDay = names.some((name) => CHAT_DAY_TOOLS.has(name) || CHAT_DAY_RECIPES.has(name));
  const postsTheDay = names.some((name) => DAY_TO_POST_TOOLS.has(name) || DAY_TO_POST_RECIPES.has(name));
  const chatDay =
    readsChatDay && typeof claim === "string"
      ? await openChatDay(extractionDepsOf(deps, client), claim, executionId, now)
      : undefined;
  // THE DAY TO POST IS THE REP'S CLOCK THE RUN WAS STARTED ON, when a
  // request moved it to an earlier day; otherwise the step's own.
  const requested = typeof values.inputs["now"] === "string" ? new Date(values.inputs["now"]) : undefined;
  const dayToPost = postsTheDay
    ? await openDayToPost(disclosureDepsOf(deps, client), requested ?? now, executionId)
    : undefined;
  return {
    db: client,
    ...(readsChatDay ? { readsChatDay: true as const } : {}),
    ...(chatDay === undefined ? {} : { chatDay }),
    ...(dayToPost === undefined ? {} : { dayToPost }),
  };
}

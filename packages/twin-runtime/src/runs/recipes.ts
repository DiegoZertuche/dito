/**
 * THE CODE RECIPES A `code` STEP MAY RUN (tickets #323, #364; the design's
 * §7.2: «filter, count, sort, format» — code over typed fields, no model).
 *
 * A REGISTRY THIS BUILD SHIPS, NAMED BY A DEFINITION AND NEVER WRITTEN BY ONE:
 * an inline run the thread wrote can call a recipe by name, and nothing a
 * model writes is ever executed (decision 23). Each recipe declares what it
 * produces in `RUN_RECIPE_OUTPUTS` (`definition.ts`), which is what a later
 * step's reference is checked against.
 *
 * A RECIPE MAY READ AND WRITE THE STORE ON THE STEP'S CONNECTION, inside the
 * step's transaction (ticket #364): the day's extraction claims its chat-days
 * in a `code` step and settles them in another — code deciding structure,
 * never judgment.
 */
import type pg from "pg";
import { customersOf, parseReference, referencesIn } from "../thread/references.js";
import {
  CLAIM_CHAT_DAYS_RECIPE,
  MAX_REPEATS,
  RUN_RECIPE_OUTPUTS,
  SETTLE_CHAT_DAYS_RECIPE,
  type RunValue,
} from "./definition.js";
import type { RunDeps } from "./engine.js";
import { claimChatDays, extractionDepsOf, settleChatDays } from "./run-reads.js";

/** What a recipe may reach beyond its inputs: the step's connection, the runtime, the step's instant. */
export interface RecipeHost {
  readonly db: pg.ClientBase;
  readonly deps: RunDeps;
  readonly now: Date;
}

/** One recipe: typed fields in, typed fields out. */
export type RunRecipe = (
  inputs: Readonly<Record<string, RunValue | undefined>>,
  host: RecipeHost,
) => Readonly<Record<string, RunValue>> | Promise<Readonly<Record<string, RunValue>>>;

/**
 * `count`: how many items a list field holds — what an `if` reads to take a
 * branch on «found any» without a model saying so.
 */
const count: RunRecipe = (inputs) => {
  const list = inputs["list"];
  return { count: Array.isArray(list) ? list.length : 0 };
};

/**
 * `claim_chat_days`: every chat with an unsettled chat-day claimed for one
 * read (`claimChatDays`), at most one `each`'s worth. A run the rep asked for
 * names a customer by their reference (`chat`), may re-read a filed day
 * (`reextract`) on a moved clock — the rep's (`now`) or the seam's
 * (`seam_now`) — and names the request row it serves (`request`); a run the
 * clock fired names none of them.
 */
const claimDays: RunRecipe = async (inputs, host) => {
  const asked = inputs["request"] !== undefined;
  const reference = inputs["chat"];
  const chats = typeof reference === "string" ? chatsOfReference(host, reference) : undefined;
  if (typeof reference === "string" && chats === undefined) return { chats: 0, claims: [], deferred: 0 };
  // THE REP'S CLOCK AND THE SEAM'S, each the step's own unless the run was
  // started with one moved (#67): the rep's names the day the read is filed
  // under, the seam's cuts every edge of the window.
  const repNow = typeof inputs["now"] === "string" ? new Date(inputs["now"]) : host.now;
  const seamNow = typeof inputs["seam_now"] === "string" ? new Date(inputs["seam_now"]) : host.now;
  const claimed = await claimChatDays(extractionDepsOf(host.deps, host.db), repNow, {
    steering: {
      ...(inputs["reextract"] === true ? { reextract: true } : {}),
      seamNow,
    },
    ...(chats === undefined ? {} : { chats }),
    ...(typeof inputs["request"] === "string" ? { requestId: inputs["request"] } : {}),
    countsSteeringRuns: asked,
    // ONE CHILD OF THE RUN'S `each` PER CLAIM, so at most as many as an
    // `each` makes; a chat past them is the next run's, which the clock fires
    // once this one has ended (`PRECONDITIONS_THAT_REPEAT`).
    maxChats: MAX_REPEATS,
  });
  return { chats: claimed.chats, claims: claimed.claims, deferred: claimed.deferred };
};

/** The chats a customer's reference names in the twin's memory, when it names one. */
function chatsOfReference(host: RecipeHost, reference: string): ReadonlySet<string> | undefined {
  const number = referencesIn(reference)[0] ?? parseReference(reference);
  if (number === undefined) return undefined;
  const customer = customersOf(host.deps.bundle, host.deps.selfChatJid)(number);
  return customer === undefined ? undefined : new Set(customer.chats.map((chat) => chat.chatJid));
}

/**
 * `settle_chat_days`: every claim no child filed settled `failed`, and the
 * merge ladder climbed when the day filed anything (`settleChatDays`) — with
 * what it merged and what it saw and left apart, counted.
 */
const settleDays: RunRecipe = async (inputs, host) => {
  const claims = inputs["claims"];
  const settled = await settleChatDays(
    extractionDepsOf(host.deps, host.db),
    Array.isArray(claims) ? claims : [],
  );
  return {
    filed: settled.filed,
    failed: settled.failed,
    merged: settled.merged,
    kind_mismatches: settled.kindMismatches,
  };
};

/** The shipped recipes, by the name a definition calls them by — a value, never written into. */
export const RUN_RECIPES: Readonly<Record<string, RunRecipe>> = {
  count,
  [CLAIM_CHAT_DAYS_RECIPE]: claimDays,
  [SETTLE_CHAT_DAYS_RECIPE]: settleDays,
};

/** The recipe names a definition may use — exactly the ones with an output declared. */
export const RUN_RECIPE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(RUN_RECIPES).filter((name) => Object.hasOwn(RUN_RECIPE_OUTPUTS, name)),
);


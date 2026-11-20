/**
 * WHAT A RUN'S STEPS MAY CALL (ticket #324; spec #318 decision 23 as amended
 * 2026-10-06: «it holds any registered tool under that tool's own gate, read
 * or write, and calls them itself»).
 *
 * THE REGISTRIES DECIDE, NOT A LIST HERE. Every tool the twin thread's
 * registries hold is a tool an `agent` step may name and an `act` step may
 * call (a read only from an agent), under the gate it is registered with: a
 * `projection` answers, a `disclosed-and-undoable-after` tool acts and is on
 * the record, `create_draft` lands a card behind the tap, and a
 * `rep-evidenced` tool refuses inside a run, whose turn carries no line of the
 * rep's (`thread/evidence.ts`). A tool added to the registries reaches a run
 * the day it is registered, under its own gate, with nothing to edit here.
 *
 * THE ONE EXCEPTION IS WHAT IS THE THREAD'S OWN, by ruling rather than by
 * gate: the spotlight, the knock, a line on a card and the binding question
 * are what the rep sees and hears, and runs land cards while the thread speaks
 * (decisions 21 and 25); and a rutina is the twin's standing arrangement with
 * the rep, written in a turn of the day (ticket #386) — a run that wrote one
 * would write it again at each firing. So none of them reaches a step, and a
 * definition naming one is refused with that reason.
 *
 * AND THE TWO THAT WRITE THE DAY'S NOTES ARE DITO'S OWN (tickets #364, #396;
 * Diego, 2026-10-12): `file_facts` and `post_disclosure` (`run-tools.ts`)
 * and the code recipes that claim and settle the chat-days are in the catalog
 * a definition Dito ships is read against, and never in the one the rep's or
 * the thread's are — so the day's notes go out only from the run whose
 * precondition waited for the day's read. The three reads of the rep's chats
 * are the thread's, so every definition may name them.
 */
import { SDK_TOOL_GATES, type Gate } from "@dito/execution";
import { NOTEPAD_RECIPE } from "../rep-notepad.js";
import { KNOCK_TOOL, MOVE_CARDS_TOOL, SAY_ON_CARD_TOOL, SPOTLIGHT_TOOL } from "../thread/canvas-tools.js";
import { NOTHING_TO_SAY_TOOL } from "../thread/nothing-to-say.js";
import { PROPOSE_BINDING_TOOL } from "../thread/propose-binding.js";
import { CREATE_AUTOMATION_TOOL } from "./declarations.js";
import { threadRegistries } from "../thread/registries.js";
import { WORKING_MEMORY_RECIPE } from "../working-memory.js";
import { CONVERSATION_RECIPES } from "./conversation.js";
import { RUN_TOOLS } from "./run-tools.js";
import { CLAIM_CHAT_DAYS_RECIPE, SETTLE_CHAT_DAYS_RECIPE, type RunCatalog } from "./definition.js";
import { RUN_RECIPE_NAMES } from "./recipes.js";

/** The tools that are the thread's own and never a run's: its voice (decisions 21 and 25; its silence, ticket #401) and the rutinas it writes (ticket #386). */
export const THREAD_OWN_TOOLS: ReadonlySet<string> = new Set([
  MOVE_CARDS_TOOL,
  SPOTLIGHT_TOOL,
  KNOCK_TOOL,
  SAY_ON_CARD_TOOL,
  NOTHING_TO_SAY_TOOL,
  PROPOSE_BINDING_TOOL,
  CREATE_AUTOMATION_TOOL,
]);

/**
 * THE CONTEXT RECIPES A DEFINITION THE REP OR THE THREAD WROTE MAY NAME
 * (ticket #357): the rep's notebook and the twin's own working notes — the
 * twin's standing context about this rep, which every one of its turns may
 * read. The others are about one turn of the thread (the rep's line, the post
 * they quoted, the event, the canvas, the keyword set) and mean nothing to a
 * step that no line woke.
 */
const WRITTEN_CONTEXT_RECIPES: ReadonlySet<string> = new Set([NOTEPAD_RECIPE, WORKING_MEMORY_RECIPE]);

/** What a run's definition the rep or the thread wrote may name, read off the thread's registries now. */
export function runCatalog(): RunCatalog {
  return {
    tools: threadStepTools(),
    recipes: new Set([...RUN_RECIPE_NAMES].filter((name) => !SHIPPED_RECIPES.has(name))),
    contextRecipes: WRITTEN_CONTEXT_RECIPES,
    shipped: false,
  };
}

/**
 * What a definition Dito ships may name: the same tools and recipes, the
 * day's two writers and the recipes of the day's read, every context recipe a
 * conversation renders (`CONVERSATION_RECIPES`), and the day's conversation.
 */
export function shippedRunCatalog(): RunCatalog {
  const tools = new Map(threadStepTools());
  for (const [name, registration] of Object.entries(RUN_TOOLS)) tools.set(name, registration.gate);
  return {
    tools,
    recipes: RUN_RECIPE_NAMES,
    contextRecipes: new Set(Object.keys(CONVERSATION_RECIPES)),
    shipped: true,
  };
}

/** The code recipes only the day's read runs: claiming and settling its chat-days. */
const SHIPPED_RECIPES: ReadonlySet<string> = new Set([CLAIM_CHAT_DAYS_RECIPE, SETTLE_CHAT_DAYS_RECIPE]);

/**
 * Every tool a step of any definition may name, with its gate: the thread's
 * registries but what is the thread's own, and the SDK's own tools under the gates
 * `@dito/execution` maps them to (ticket #326; ADR-0013 as amended) — so a
 * definition names `Write` the way it names `create_draft`, whoever wrote it.
 */
function threadStepTools(): ReadonlyMap<string, Gate> {
  const tools = new Map<string, Gate>();
  for (const [name, registration] of Object.entries(threadRegistries().tools)) {
    if (!THREAD_OWN_TOOLS.has(name)) tools.set(name, registration.gate);
  }
  for (const [name, gate] of Object.entries(SDK_TOOL_GATES)) tools.set(name, gate);
  return tools;
}

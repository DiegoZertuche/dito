/**
 * THE CONVERSATIONS DITO SHIPS (ticket #363; the rulings of 2026-10-07 on
 * #357): each turn that answers someone is one definition of one `agent`
 * step, in the shape the twin writes a run in, read by the same parser with
 * the shipped catalog and run by the one engine's no-row path with no run
 * row (`executeStep`). Beside `shipped.ts`, which holds the runs the twin
 * starts for the rep, because those are read by `start_workflow` — and the
 * conversations' instructions are built from the thread's own tool
 * declarations, which reach `start_workflow` through the registries: one
 * module holding both would be read before the declarations it is built from.
 */
import { DEFAULT_MAX_TOKENS, renderParts, WORKSPACE_FILE_TOOLS } from "@dito/execution";
import { CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE } from "../chat-context.js";
import { DRAFTING_MAX_ITERATIONS } from "../drafting/automation.js";
import { draftingInstructions } from "../drafting/instructions.js";
import { RETRIEVED_MEMORIES_RECIPE, THE_TURN_RECIPE } from "../drafting/recipes.js";
import { DRAFTING_TOOL_DECLARATIONS } from "../drafting/tools.js";
import { ENTITY_KIND_MAX_ITERATIONS } from "../entity-kind/automation.js";
import { entityKindInstructions } from "../entity-kind/instructions.js";
import { RECENT_MESSAGES_RECIPE, THE_NAME_RECIPE } from "../entity-kind/recipes.js";
import { NOTEPAD_RECIPE } from "../rep-notepad.js";
import { THREAD_MAX_ITERATIONS } from "../thread/automation.js";
import { threadInstructions } from "../thread/instructions.js";
import {
  CANVAS_RECIPE,
  KEYWORD_SET_RECIPE,
  QUOTED_POST_RECIPE,
  THE_EVENT_RECIPE,
  THE_MESSAGE_RECIPE,
} from "../thread/recipes.js";
import { THREAD_TOOL_DECLARATIONS } from "../thread/tools.js";
import { WORKING_MEMORY_RECIPE } from "../working-memory.js";
import type { RunDefinition } from "./definition.js";

/**
 * THE TWIN THREAD (tickets #173, #319, #363): one turn of the day's
 * conversation, answering whatever woke it — the rep's line at either door,
 * an event, the rep's arrival (`thread/automation.ts`). Its instructions are
 * the day session's system prompt, told once when its child opens
 * (`daySessionShape`); its tools
 * are the day's, every tool the thread holds, and the SDK's file tools on the
 * workspace, which it names (ticket #326) — so a document the rep asks for is
 * written in the turn or by a run, the twin's choice; it ends on its words,
 * which are its line.
 *
 * ITS RECIPES ARE EVERY WAKE'S, IN THE ORDER THE MODEL READS THEM: what the
 * rep pointed at, the canvas, the two notebooks, the accepted keywords, then
 * the line or the event that woke the turn — each rendering only on a turn
 * that has one, so a line's turn reads the quoted post and the line, an
 * event's reads the event, and only a line at the phone's door reads the
 * keywords (ticket #404): the dashboard has the card's buttons instead.
 * Everything the two of them said earlier in the day is the session itself,
 * read natively.
 *
 * THE BUDGET is ten rounds a turn (`THREAD_MAX_ITERATIONS`) and the runtime's
 * output ceiling a call: a turn with no run spends no run's tokens.
 */
export const THREAD_DEFINITION: RunDefinition = {
  name: "twin_thread",
  budget: { iterations: THREAD_MAX_ITERATIONS, tokens: DEFAULT_MAX_TOKENS },
  session: "day",
  steps: [
    {
      kind: "agent",
      name: "thread",
      instructions: renderParts(threadInstructions(THREAD_TOOL_DECLARATIONS, THREAD_MAX_ITERATIONS)),
      tools: [...WORKSPACE_FILE_TOOLS],
      recipes: [
        QUOTED_POST_RECIPE,
        CANVAS_RECIPE,
        NOTEPAD_RECIPE,
        WORKING_MEMORY_RECIPE,
        KEYWORD_SET_RECIPE,
        THE_MESSAGE_RECIPE,
        THE_EVENT_RECIPE,
      ],
    },
  ],
};

/**
 * DRAFTING (tickets #172, #363; spec #171 decisions 14 and 15): one turn on a
 * conversation of its own, reading a customer's settled turn and, when it
 * needs an answer, writing the draft itself with `create_draft` — a turn that
 * writes none judged that nothing was owed. Its words reach nobody, so a turn
 * that only wrote words did nothing (`answeredAs: "no-action"`): its record
 * says `drafted` from the draft tool's effect, `no-action` otherwise.
 *
 * ITS RECIPES, IN THE ORDER THE MODEL READS THEM (`drafting/recipes.ts` argues
 * it): who this chat is, what the twin looked up, what was just said, the
 * thing to answer, how this rep writes, then the twin's own notes.
 */
export const DRAFTING_DEFINITION: RunDefinition = {
  name: "drafting",
  budget: { iterations: DRAFTING_MAX_ITERATIONS, tokens: DEFAULT_MAX_TOKENS },
  answeredAs: "no-action",
  steps: [
    {
      kind: "agent",
      name: "draft",
      instructions: renderParts(draftingInstructions(DRAFTING_TOOL_DECLARATIONS)),
      tools: DRAFTING_TOOL_DECLARATIONS.map((tool) => tool.name),
      recipes: [
        CHAT_BINDING_RECIPE,
        RETRIEVED_MEMORIES_RECIPE,
        RECENT_TRANSCRIPT_RECIPE,
        THE_TURN_RECIPE,
        NOTEPAD_RECIPE,
        WORKING_MEMORY_RECIPE,
      ],
    },
  ],
};

/**
 * THE KIND CLASSIFICATION (tickets #176, #363; spec #171 decisions 11 and
 * 26; ADR-0035): one turn on a conversation of its own, with no tool, whose
 * one typed field is the kind — `person` or `business`, the two the Ledger's
 * own CHECK offers, held to them by the conversation (`classify.ts`). There
 * is no "unsure" and no NULL: a NULL kind can never phone-match, so a NULL
 * entity's rung would be inert. Its answer records `classified`: nobody was
 * answered, and a classification that decided nothing is a refusal.
 *
 * ITS RECIPES, IN THE ORDER THE MODEL READS THEM: the name — which usually
 * settles it — then the chat's own words, which are what it reads when the
 * name does not.
 */
export const ENTITY_KIND_DEFINITION: RunDefinition = {
  name: "entity_kind",
  budget: { iterations: ENTITY_KIND_MAX_ITERATIONS, tokens: DEFAULT_MAX_TOKENS },
  answeredAs: "classified",
  steps: [
    {
      kind: "agent",
      name: "kind",
      instructions: renderParts(entityKindInstructions()),
      tools: [],
      recipes: [THE_NAME_RECIPE, RECENT_MESSAGES_RECIPE],
      output: { kind: "string" },
    },
  ],
};

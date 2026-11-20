/**
 * WHAT A ONE-STEP DEFINITION'S TURN IS BUILT OVER (ticket #363; the rulings
 * of 2026-10-07 on #357: one engine runs every definition).
 *
 * A turn that answers someone runs through the engine's no-row path
 * (`executeStep`), and what it reads and what it can call are the caller's —
 * the occasion binds them: the twin thread's line, its
 * canvas and its served hits; drafting's chat, its turn and what retrieval
 * found; the entity-kind question's name and its messages. A `Conversation`
 * is that binding, tagged with whose it is, so the one engine builds the step
 * the same way for each and the definition names its tools and its context
 * recipes and nothing else.
 *
 * ONE REGISTRY OF CONTEXT RECIPES, BY NAME (`CONVERSATION_RECIPES`): every
 * recipe a definition Dito ships may name, each rendering from the
 * conversation it is given — or rendering nothing, when that conversation
 * has nothing for it this turn (an event woke the thread, so there is no
 * line of the rep's to show). The rep-written catalog keeps the two notebooks
 * (`catalog.ts`).
 *
 * A RUN'S STEP IS A CONVERSATION OF ITS OWN (`run`, ticket #364): the
 * thread's tools and the two notebooks bound to the step's trigger, beside the
 * tools its run hands it (`run-tools.ts`) and what those are bound over — the
 * chat-day a child of the extraction run reads, the day the disclosure run
 * posts — so the recipes that render a chat's day or the day's record render
 * from the step's own conversation, through this one registry.
 *
 * ONE NAME, ONE BINDING PER CONVERSATION, FOR A TOOL: `search_memory` reaches
 * every chat of the rep's from the thread and one chat from drafting, and
 * `create_draft` writes to a confirmed customer from the thread and into the
 * turn's own chat from drafting. Which binding a step gets is its
 * conversation's — never anything its definition says (`thread/registries.ts`,
 * `drafting/registries.ts`).
 */
import { oneAtATime, type NamedPart, type ToolDeclaration } from "@dito/execution";
import type { DraftingDeps } from "../drafting/deps.js";
import { DRAFTING_RECIPES } from "../drafting/recipes.js";
import { draftingRegistries } from "../drafting/registries.js";
import type { EntityKindDeps } from "../entity-kind/deps.js";
import { ENTITY_KIND_RECIPES } from "../entity-kind/recipes.js";
import { DEFAULT_REP_LANGUAGE } from "../rep-language.js";
import { CHAT_BINDING_RECIPE, RECENT_TRANSCRIPT_RECIPE } from "../chat-context.js";
import { DISCLOSURE_RECIPES, THE_COUNTS_RECIPE, THE_RECORD_RECIPE } from "../disclosure/recipes.js";
import { EXTRACTION_RECIPES, THE_DAY_RECIPE } from "../extraction/recipes.js";
import { REP_LANGUAGE_RECIPE } from "../rep-language.js";
import { RETRIEVED_MEMORIES_RECIPE, THE_TURN_RECIPE } from "../drafting/recipes.js";
import { RECENT_MESSAGES_RECIPE, THE_NAME_RECIPE } from "../entity-kind/recipes.js";
import { NOTEPAD_RECIPE } from "../rep-notepad.js";
import { repTriggerOf, type ThreadDeps } from "../thread/deps.js";
import {
  CANVAS_RECIPE,
  KEYWORD_SET_RECIPE,
  QUOTED_POST_RECIPE,
  THE_EVENT_RECIPE,
  THE_MESSAGE_RECIPE,
  THREAD_RECIPES,
} from "../thread/recipes.js";
import type { Customers } from "../thread/references.js";
import { threadRegistries } from "../thread/registries.js";
import { WORKING_MEMORY_RECIPE } from "../working-memory.js";
import type { RunValue } from "./definition.js";
import { chatDayRead, RUN_TOOLS, type RunStepReads } from "./run-tools.js";

/**
 * THE RULE A TURN'S TYPED ANSWER OBEYS BEYOND ITS SHAPE (ticket #363): the
 * reason it may not stand, or nothing. The entity-kind question's: a kind the
 * Ledger has.
 */
export type OutputRule = (output: Readonly<Record<string, RunValue>>) => string | undefined;

/**
 * THE RULE A TURN'S FINAL WORDS OBEY, where they are said to someone (ticket
 * #363): the reason they may not stand, or nothing. The thread's guard over
 * its line (`thread/guard.ts`).
 */
export type WordsRule = (words: string) => string | undefined;

/** Whose turn this is, and what it was bound to. */
export type Conversation =
  | {
      readonly kind: "thread";
      readonly deps: ThreadDeps;
      /** What the turn's words are held to, when they are the rep's line. */
      readonly words?: WordsRule;
    }
  | { readonly kind: "drafting"; readonly deps: DraftingDeps }
  | {
      readonly kind: "entity_kind";
      readonly deps: EntityKindDeps;
      readonly holds: OutputRule;
    }
  | {
      readonly kind: "run";
      /** The thread's tools and notebooks, bound to the step's own trigger. */
      readonly deps: ThreadDeps;
      /** What the run handed this step: the chat-day it reads, or the day it posts. */
      readonly reads: RunStepReads;
    };

/**
 * A conversation, read once for the engine: its tools by name, how a
 * customer's reference resolves in it, the zone and the rep's language its
 * turn renders in, and what its words and its typed answer are held to.
 */
export interface BoundConversation {
  /** The tool this conversation binds under `name`, or nothing when it has none by that name. */
  readonly tool: (name: string) => ToolDeclaration | undefined;
  readonly customers: Customers;
  readonly timeZone: string;
  readonly repLanguage: string;
  readonly words?: WordsRule;
  readonly holds?: OutputRule;
}

/** The one reading of a conversation the engine makes. */
export function bind(conversation: Conversation): BoundConversation {
  switch (conversation.kind) {
    case "thread": {
      const { deps } = conversation;
      const tools = threadRegistries().tools;
      return {
        tool: (name) => tools[name]?.create(deps),
        customers: deps.served.customers,
        timeZone: deps.timeZone,
        repLanguage: deps.repLanguage,
        ...(conversation.words === undefined ? {} : { words: conversation.words }),
      };
    }
    case "drafting": {
      const { deps } = conversation;
      const tools = draftingRegistries().tools;
      return {
        tool: (name) => tools[name]?.create(deps),
        customers: nobody,
        timeZone: deps.timeZone,
        repLanguage: deps.repLanguage,
      };
    }
    case "entity_kind":
      return {
        tool: () => undefined,
        customers: nobody,
        timeZone: conversation.deps.timeZone,
        repLanguage: DEFAULT_REP_LANGUAGE,
        holds: conversation.holds,
      };
    case "run": {
      const { deps, reads } = conversation;
      // ONE QUEUE FOR THE STEP'S CONNECTION, the thread's tools and the run's
      // alike (`run-tools.ts`).
      const inTurn = oneAtATime();
      const tools = threadRegistries(inTurn).tools;
      return {
        // A STEP THAT READS A CLAIMED CHAT-DAY HOLDS THE CLAIM'S THREE READS;
        // every other step the thread's, over the twin's whole history
        // (ticket #396). Dito's two writers come last, by their own names.
        tool: (name) =>
          (reads.readsChatDay === true ? chatDayRead(name, reads, inTurn) : undefined) ??
          tools[name]?.create(deps) ??
          RUN_TOOLS[name]?.create(reads, inTurn),
        customers: deps.served.customers,
        timeZone: deps.timeZone,
        repLanguage: deps.repLanguage,
      };
    }
  }
}

/** A conversation no reference resolves in: it names no customer by one. */
const nobody: Customers = () => undefined;

/** One context recipe: the part it renders from a conversation, or nothing when this turn has none. */
export type ConversationRecipe = (conversation: Conversation) => NamedPart | undefined;

/**
 * One of the thread's recipes, rendered for a thread turn `when` it applies —
 * a run's step included, whose thread deps carry its own trigger.
 */
function thread(name: string, when: (deps: ThreadDeps) => boolean = () => true): ConversationRecipe {
  return (conversation) =>
    (conversation.kind === "thread" || conversation.kind === "run") && when(conversation.deps)
      ? THREAD_RECIPES[name]!.create(conversation.deps)({})
      : undefined;
}

/** One of extraction's recipes, rendered for a run's step that reads a chat's day. */
function chatDay(name: string): ConversationRecipe {
  return (conversation) =>
    conversation.kind === "run" && conversation.reads.chatDay !== undefined
      ? EXTRACTION_RECIPES[name]!.create(conversation.reads.chatDay.deps)({})
      : undefined;
}

/** One of the disclosure's recipes, rendered for a run's step that posts the day. */
function dayToPost(name: string): ConversationRecipe {
  return (conversation) =>
    conversation.kind === "run" && conversation.reads.dayToPost !== undefined
      ? DISCLOSURE_RECIPES[name]!.create(conversation.reads.dayToPost.deps)({})
      : undefined;
}

/** One of drafting's recipes, rendered for a drafting turn. */
function drafting(name: string): ConversationRecipe {
  return (conversation) =>
    conversation.kind === "drafting" ? DRAFTING_RECIPES[name]!.create(conversation.deps)({}) : undefined;
}

/** One of the entity-kind question's recipes, rendered for its turn. */
function entityKind(name: string): ConversationRecipe {
  return (conversation) =>
    conversation.kind === "entity_kind" ? ENTITY_KIND_RECIPES[name]!.create(conversation.deps)({}) : undefined;
}

/** Whether a rep's line woke this thread turn — the one turn with a line and a post to point at. */
const aLineWoke = (deps: ThreadDeps): boolean => deps.trigger.kind === "twin_thread_message";

/**
 * Whether a rep's line at the phone's door woke it (ticket #404): the one turn
 * where a keyword is the rep's button, so the one turn told the keywords.
 */
const aLineAtThePhone = (deps: ThreadDeps): boolean => repTriggerOf(deps)?.door === "twin_thread";

/** Whether an event or the rep's arrival woke it — a turn nobody wrote. */
const anEventWoke = (deps: ThreadDeps): boolean =>
  deps.trigger.kind === "twin_thread_event" || deps.trigger.kind === "arrival";

/**
 * EVERY CONTEXT RECIPE A STEP MAY NAME, BY NAME (tickets #363, #364) — the
 * thread's seven, drafting's four, the entity-kind question's two, and what a
 * run's step reads its chat's day or the day's record from. A chat's binding
 * and its recent transcript render from drafting's chat or from the chat-day
 * a run's step reads, whichever the conversation holds. The two notebooks
 * render from either the thread or drafting, each as its own conversation
 * shows them: writable from the thread, which holds the tools that write
 * them, and read-only from drafting, which does not.
 */
export const CONVERSATION_RECIPES: Readonly<Record<string, ConversationRecipe>> = Object.freeze({
  [QUOTED_POST_RECIPE]: thread(QUOTED_POST_RECIPE, aLineWoke),
  [CANVAS_RECIPE]: thread(CANVAS_RECIPE, (deps) => deps.canvasBlock !== ""),
  [THE_MESSAGE_RECIPE]: thread(THE_MESSAGE_RECIPE, aLineWoke),
  [THE_EVENT_RECIPE]: thread(THE_EVENT_RECIPE, anEventWoke),
  [KEYWORD_SET_RECIPE]: thread(KEYWORD_SET_RECIPE, aLineAtThePhone),
  [NOTEPAD_RECIPE]: (conversation) => thread(NOTEPAD_RECIPE)(conversation) ?? drafting(NOTEPAD_RECIPE)(conversation),
  [WORKING_MEMORY_RECIPE]: (conversation) =>
    thread(WORKING_MEMORY_RECIPE)(conversation) ?? drafting(WORKING_MEMORY_RECIPE)(conversation),
  [CHAT_BINDING_RECIPE]: (conversation) =>
    drafting(CHAT_BINDING_RECIPE)(conversation) ?? chatDay(CHAT_BINDING_RECIPE)(conversation),
  [RETRIEVED_MEMORIES_RECIPE]: drafting(RETRIEVED_MEMORIES_RECIPE),
  [RECENT_TRANSCRIPT_RECIPE]: (conversation) =>
    drafting(RECENT_TRANSCRIPT_RECIPE)(conversation) ?? chatDay(RECENT_TRANSCRIPT_RECIPE)(conversation),
  [THE_DAY_RECIPE]: chatDay(THE_DAY_RECIPE),
  [REP_LANGUAGE_RECIPE]: dayToPost(REP_LANGUAGE_RECIPE),
  [THE_RECORD_RECIPE]: dayToPost(THE_RECORD_RECIPE),
  [THE_COUNTS_RECIPE]: dayToPost(THE_COUNTS_RECIPE),
  [THE_TURN_RECIPE]: drafting(THE_TURN_RECIPE),
  [THE_NAME_RECIPE]: entityKind(THE_NAME_RECIPE),
  [RECENT_MESSAGES_RECIPE]: entityKind(RECENT_MESSAGES_RECIPE),
});

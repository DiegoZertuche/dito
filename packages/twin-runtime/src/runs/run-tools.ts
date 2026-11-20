/**
 * THE TOOLS A RUN HANDS ITS STEPS BEYOND THE THREAD'S (tickets #364, #396;
 * spec #318 decision 23 as amended: «it holds any registered tool under that
 * tool's own gate»; ADR-0013 as amended).
 *
 * DITO'S DAY'S TWO WRITERS: `file_facts`, which files what a chat's day
 * stated, and `post_disclosure`, which posts the day's notes — each under the
 * correction window, each Dito's own (Diego, 2026-10-12): the catalog a
 * definition Dito ships is read against holds them, and no other
 * (`catalog.ts`). Each is bound to what its run handed the step — the
 * chat-day a child of the extraction run was given, the day the disclosure
 * run owes — and a step whose run handed it none is told so by the tool
 * itself when it calls it.
 *
 * AND THE THREE READS OF A CLAIMED CHAT-DAY (`chatDayRead`): the
 * extraction's child reads its chat's day with `search_chat_history`,
 * `list_chats` and `read_filed_facts` bound to the claim and numbered by the
 * references that run serves. Every other step holds the same three names
 * bound to the twin's whole history, from the thread's registries
 * (`thread/chat-reads.ts`; `conversation.ts` picks).
 *
 * ONE QUEUE FOR THE STEP'S CONNECTION: the reads and the writes that reach
 * Postgres take the turn's one queue, the thread's tools' own
 * (`thread/registries.ts`), so two calls of one response never share a
 * savepoint stack (ADR-0010, 2026-09-06).
 */
import { defineTool, type Gate, type InTurn, type ProjectionToolDeclaration, type ToolDeclaration } from "@dito/execution";
import type pg from "pg";
import { postDisclosureTool, POST_DISCLOSURE_TOOL, type DayToPost } from "../disclosure/post-disclosure.js";
import type { ChatDayToRead } from "../extraction-pass.js";
import { FILE_FACTS_TOOL, fileFactsTool } from "../extraction/file-facts.js";
import {
  EXTRACTION_TOOL_DECLARATIONS,
  LIST_CHATS_TOOL,
  listChatsTool,
  READ_FILED_FACTS_TOOL,
  readFiledFactsTool,
  SEARCH_CHAT_HISTORY_TOOL,
  searchChatHistoryTool,
} from "../extraction/tools.js";
import { savepointed } from "../tool-savepoints.js";

/** What a run handed one step: the connection, and the day it reads or posts. */
export interface RunStepReads {
  readonly db: pg.ClientBase;
  /**
   * Whether the step reads a claimed chat-day — it names `file_facts` or one
   * of the chat-day's recipes — so its three reads are the claim's, and say
   * there is nothing to look at once the claim has settled.
   */
  readonly readsChatDay?: true;
  /** The chat-day a child of the extraction run reads, while its claim stands. */
  readonly chatDay?: ChatDayToRead;
  /** The day the disclosure run posts, while it owes a line. */
  readonly dayToPost?: DayToPost;
}

/** One tool a run hands a step: its gate, and how it is bound. */
interface RunToolRegistration {
  readonly gate: Gate;
  readonly create: (reads: RunStepReads, inTurn: InTurn) => ToolDeclaration;
}

/** One of the three reads of a claimed chat-day: how it is bound to the claim. */
type ChatDayRead = (chatDay: ChatDayToRead, db: pg.ClientBase, inTurn: InTurn) => ProjectionToolDeclaration;

const CHAT_DAY_BINDINGS: Readonly<Record<string, ChatDayRead>> = Object.freeze({
  // The search reads the bundle and nothing else, so it carries no savepoint.
  [SEARCH_CHAT_HISTORY_TOOL]: (chatDay) => searchChatHistoryTool(chatDay.deps),
  // The index of the rep's customers: the entity mirror, and no content.
  [LIST_CHATS_TOOL]: (chatDay) => listChatsTool(chatDay.deps),
  // SAVEPOINTED, BECAUSE IT REACHES POSTGRES on the step's connection.
  [READ_FILED_FACTS_TOOL]: (chatDay, db, inTurn) => savepointed(readFiledFactsTool(chatDay.deps), db, inTurn),
});

/**
 * One of the three reads as a step that reads a claimed chat-day holds it:
 * bound to its claim, or — once the claim has settled — a read that answers
 * and says why there is nothing. `undefined` for any other name.
 */
export function chatDayRead(name: string, reads: RunStepReads, inTurn: InTurn): ProjectionToolDeclaration | undefined {
  const bound = CHAT_DAY_BINDINGS[name];
  if (bound === undefined) return undefined;
  if (reads.chatDay !== undefined) return bound(reads.chatDay, reads.db, inTurn);
  const declaration = EXTRACTION_TOOL_DECLARATIONS.find((one) => one.name === name)!;
  return defineTool({
    ...declaration,
    run: () => "This step reads no chat's day, so there is nothing for this read to look at.",
  });
}

/** The tools, by their registered names. */
export const RUN_TOOLS: Readonly<Record<string, RunToolRegistration>> = Object.freeze({
  // THE FILING: the aperture's writes and the claim's settle, on the step's
  // connection, under the correction window.
  [FILE_FACTS_TOOL]: {
    gate: "disclosed-and-undoable-after",
    create: (reads, inTurn) => savepointed(fileFactsTool(reads.chatDay?.file), reads.db, inTurn),
  },
  // THE DAY'S POST: the notice, its numbering and the day's attempt, under
  // the correction window its lines open.
  [POST_DISCLOSURE_TOOL]: {
    gate: "disclosed-and-undoable-after",
    create: (reads, inTurn) => savepointed(postDisclosureTool(reads.dayToPost), reads.db, inTurn),
  },
});

/**
 * The tool names that need the step's chat-day, and the ones that need the
 * day it posts: the writers only, which a definition Dito ships alone may
 * name — so a rep's rutina naming the three reads never opens a claim.
 */
export const CHAT_DAY_TOOLS: ReadonlySet<string> = new Set([FILE_FACTS_TOOL]);
export const DAY_TO_POST_TOOLS: ReadonlySet<string> = new Set([POST_DISCLOSURE_TOOL]);

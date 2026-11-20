/**
 * WHAT THE TWIN THREAD CAN LOOK UP ABOUT ITS OWN DAYS AND ABOUT A CUSTOMER
 * (ticket #320; spec #318 decisions 12 and 19; design §4).
 *
 * `search_messages` and `read_message` read the thread's own items — the
 * rep's lines through either door, the twin's replies, the events, and each
 * version of a workspace document (ticket #326; `workspace.ts`) — over the
 * archived days and today, by words and by meaning. `read_entity` reads one
 * customer's timeline from the rep side's own records. All three are
 * projections with pinned columns (ADR-0013).
 *
 * ═══ THE THREAD'S OWN STORE, INDEXED AS IT HAPPENS ═══
 *
 * The day's session is the SDK's plaintext file under the harness directory,
 * and the twin's reading is never built on the SDK's session read API — it
 * resolves locations from the calling process's environment (spike #290 fact
 * 2). So the runtime records each item into the bundle's `thread_items` as
 * the turn that holds it ends (`indexThreadItems`), from what it already has
 * in hand: the wake's text with its door, the reply, the event's line.
 *
 * TOOL RESULTS ARE NEVER INDEXED. Customer text reaches the thread only as
 * the result of a tool the twin called (spec #318 decision 12), and the
 * original tool is how it is found again; an index of results would be a
 * second, unscoped path to a customer's words. And the self-chat's own rows
 * in `conversation_messages` are NOT unioned in: they hold the framed drafts
 * and notes the phone received, customer words among them, and the lines
 * the rep wrote there already reach this store as the thread's own wakes. So
 * `search_messages` returns text from this store and from nothing else;
 * `search_memory` still reaches every conversation, the self-chat included.
 */
import type { ThreadItem, ThreadItemRole } from "@dito/bundle";
import {
  defineTool,
  renderTurnInstant,
  type ProjectionToolDeclaration,
} from "@dito/execution";
import { embedAll, embedOne } from "../embedder.js";
import { chatOfBindingQuestion } from "../binding-question.js";
import { readFiledLines } from "../filed-lines.js";
import type { ThreadDeps } from "./deps.js";
import {
  parseReference,
  REFERENCE_EXAMPLE,
  tailOf,
  writeReference,
} from "./references.js";
import { UUID } from "./served.js";

/** How many items one search returns. The search side's own eight. */
const SEARCH_MESSAGES_LIMIT = 8;

/** How much of an item a search shows before `read_message` is needed. */
const ITEM_GLIMPSE = 200;

/** One item as the runtime hands it to the store. */
export interface ThreadItemToIndex {
  readonly id: string;
  readonly role: ThreadItemRole;
  readonly door?: "dashboard" | "twin_thread";
  readonly at: Date;
  readonly text: string;
}

/**
 * Records a turn's items into the thread's store (the module header argues
 * what is and is not recorded).
 *
 * A LINE AND A REPLY ARE EMBEDDED, AN EVENT IS NOT: an event's line is a word
 * and ids, with no meaning to search by, and it is found by its words.
 *
 * AN EMBEDDER THAT FAILS COSTS THE MEANING SIDE AND NEVER THE ITEM (Codex r2):
 * the items are recorded without vectors and the word side still finds them.
 */
export async function indexThreadItems(
  deps: Pick<ThreadDeps, "bundle" | "embedder">,
  at: { readonly sessionId: string; readonly day: string },
  items: readonly ThreadItemToIndex[],
): Promise<void> {
  const spoken = items.filter((item) => item.role !== "event");
  let vectors: readonly Float32Array[] = [];
  try {
    vectors = spoken.length === 0 ? [] : await embedAll(deps.embedder, spoken.map((item) => item.text));
  } catch {
    vectors = [];
  }
  const byId = new Map(
    spoken.flatMap((item, index) => {
      const vector = vectors[index];
      return vector === undefined ? [] : [[item.id, vector] as const];
    }),
  );
  for (const item of items) {
    const embedding = byId.get(item.id);
    deps.bundle.recordThreadItem({
      id: item.id,
      sessionId: at.sessionId,
      day: at.day,
      role: item.role,
      ...(item.door === undefined ? {} : { door: item.door }),
      at: item.at.toISOString(),
      text: item.text,
      ...(embedding === undefined ? {} : { embedding }),
    });
  }
}

/** Who an item is from, in the words a result line uses. */
function whoOf(item: ThreadItem): string {
  if (item.role === "event") return "event";
  if (item.role === "workspace") return "your workspace";
  if (item.role === "twin") return "you";
  return item.door === "dashboard" ? "the rep, at the dashboard" : "the rep, on WhatsApp";
}

/** A seat-local day, `YYYY-MM-DD`, or a refusal. */
function dayOf(value: unknown, field: string): string | undefined | { readonly refused: string } {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return { refused: `rejected: \`${field}\` is a day written YYYY-MM-DD, or null.` };
}

// ─── search_messages ────────────────────────────────────────────────────

/** The tool's registered name. */
export const SEARCH_MESSAGES_TOOL = "search_messages";

/**
 * WHAT A RESULT RETURNS, PINNED (ADR-0013): the item's id, when, who — the rep
 * and through which door, you, or an event — and its first words. The whole
 * item is `read_message`'s.
 */
export const SEARCH_MESSAGES_COLUMNS: readonly string[] = ["item_id", "at", "who", "text"];

export const SEARCH_MESSAGES_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: SEARCH_MESSAGES_TOOL,
  gate: "projection",
  description:
    "Look through your own conversation with the rep — this day and the days before it: what they said to you through either door, what you answered, and the events of their day — and the documents in your workspace, each version as you left it. It matches the words you give and what they mean, and returns each item by its id with when it was and who said it. It does not reach their customers' conversations: search_memory does.",
  columns: SEARCH_MESSAGES_COLUMNS,
  // `about` AND NOT `query`: the projection fence refuses a parameter named
  // for a caller-written query (`@dito/execution`'s `projectionViolations`).
  inputSchema: {
    type: "object",
    properties: {
      about: {
        type: "string",
        description: "What to look for, in whatever words you like.",
      },
      since: {
        type: ["string", "null"],
        description: "The first day to look in, YYYY-MM-DD in the rep's own calendar, or null for no limit.",
      },
      until: {
        type: ["string", "null"],
        description: "The last day to look in, YYYY-MM-DD, or null for no limit.",
      },
    },
    required: ["about", "since", "until"],
    additionalProperties: false,
  },
};

/** The search, bound to this twin's own store. */
export function searchMessagesTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...SEARCH_MESSAGES_DECLARATION,
    run: async (input: unknown) => {
      const given = input as { about?: unknown; since?: unknown; until?: unknown };
      if (typeof given.about !== "string" || given.about.trim() === "") {
        return "rejected: `about` is what to look for, in words.";
      }
      const since = dayOf(given.since, "since");
      if (typeof since === "object") return since.refused;
      const until = dayOf(given.until, "until");
      if (typeof until === "object") return until.refused;
      // THE WORD SIDE STANDS WHEN THE EMBEDDER DOES NOT (Codex r2).
      let embedding: Float32Array | undefined;
      try {
        embedding = await embedOne(deps.embedder, given.about);
      } catch {
        embedding = undefined;
      }
      const items = deps.bundle.searchThreadItems({
        words: given.about.split(/\s+/u),
        ...(embedding === undefined ? {} : { embedding }),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        limit: SEARCH_MESSAGES_LIMIT,
      });
      const text =
        items.length === 0
          ? "Nothing in your conversation with the rep matched."
          : items
              .map(
                (item) =>
                  `[item ${item.id}] [${renderTurnInstant(new Date(item.at), deps.timeZone)}] ${whoOf(item)}: ${glimpse(item.text)}`,
              )
              .join("\n");
      deps.served.read(text);
      return text;
    },
  });
}

/** An item's first words, marked when there is more. */
function glimpse(text: string): string {
  const chars = [...text];
  return chars.length <= ITEM_GLIMPSE ? text : `${chars.slice(0, ITEM_GLIMPSE).join("")}…`;
}

// ─── read_message ───────────────────────────────────────────────────────

/** The tool's registered name. */
export const READ_MESSAGE_TOOL = "read_message";

/** WHAT IT RETURNS, PINNED (ADR-0013): one item, whole, with its day. */
export const READ_MESSAGE_COLUMNS: readonly string[] = ["item_id", "day", "at", "who", "text"];

export const READ_MESSAGE_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: READ_MESSAGE_TOOL,
  gate: "projection",
  description:
    "One item of your conversation with the rep, whole, by the id search_messages gave you.",
  columns: READ_MESSAGE_COLUMNS,
  inputSchema: {
    type: "object",
    properties: {
      item_id: {
        type: "string",
        description: "The item's id, as search_messages returned it.",
      },
    },
    required: ["item_id"],
    additionalProperties: false,
  },
};

/** The read, bound to this twin's own store. */
export function readMessageTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...READ_MESSAGE_DECLARATION,
    run: (input: unknown) => {
      const given = (input as { item_id?: unknown }).item_id;
      if (typeof given !== "string" || given.trim() === "") {
        return "rejected: `item_id` is an item's id, as search_messages returned it.";
      }
      const item = deps.bundle.readThreadItem(given);
      if (item === undefined) return `No item of your conversation has the id ${given}.`;
      const text = `[item ${item.id}] [${item.day}] [${renderTurnInstant(new Date(item.at), deps.timeZone)}] ${whoOf(item)}:\n${item.text}`;
      deps.served.read(text);
      return text;
    },
  });
}

// ─── read_entity ────────────────────────────────────────────────────────

/** The tool's registered name. */
export const READ_ENTITY_TOOL = "read_entity";

/**
 * WHAT IT RETURNS, PINNED (ADR-0013): the customer's conversations the rep
 * confirmed — a number's last four digits and when — and the lines of the
 * day's notes filed against them, oldest first, with whether the rep marked
 * each wrong. The rep side's own records and nothing of the owner's: the
 * entity mirror in the bundle and the notes the rep was shown
 * (`filed-lines.ts`), never a Ledger table.
 */
export const READ_ENTITY_COLUMNS: readonly string[] = ["customer", "at", "kind", "text", "retracted"];

export const READ_ENTITY_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: READ_ENTITY_TOOL,
  gate: "projection",
  description: `One customer's timeline as the rep's own records hold it: the conversations the rep confirmed as theirs and when, and what the day's notes recorded about them, oldest first, with any line the rep marked wrong. Name the customer by their reference — ${REFERENCE_EXAMPLE} — or by the post id of their card on the dashboard.`,
  columns: READ_ENTITY_COLUMNS,
  inputSchema: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        description: `The customer's reference, like ${REFERENCE_EXAMPLE}, or the post id of their card on the dashboard.`,
      },
    },
    required: ["entity"],
    additionalProperties: false,
  },
};

/** The read, bound to this twin's mirror and its rep-side records. */
export function readEntityTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...READ_ENTITY_DECLARATION,
    run: async (input: unknown) => {
      const given = (input as { entity?: unknown }).entity;
      const reference =
        parseReference(given) ??
        (typeof given === "string" && isPostIdLike(given) ? await customerOfCard(deps, given) : undefined);
      if (reference === undefined) {
        return `rejected: \`entity\` is a customer's reference, like ${REFERENCE_EXAMPLE}, or the post id of their card.`;
      }
      const customer = deps.served.customers(reference);
      if (customer?.entityId === undefined) {
        return `${writeReference(reference)} is not a customer the rep has confirmed, so there is no timeline to read.`;
      }
      const lines = await readFiledLines(deps.db, {
        twinId: deps.twinId,
        entityId: customer.entityId,
      });
      const chats = deps.bundle.chatsOfEntity(customer.entityId);
      const rows = [
        `${writeReference(reference)}'s timeline, oldest first:`,
        ...chats.map(
          (chat) =>
            `- [${renderTurnInstant(new Date(chat.confirmedAt), deps.timeZone)}] the rep confirmed a conversation as theirs${numberTail(chat.chatJid)}`,
        ),
        ...[...lines].reverse().map(
          (line) =>
            `- [${renderTurnInstant(line.filed_at, deps.timeZone)}] recorded: ${line.rendered_text}${line.retracted ? " — the rep marked this one wrong" : ""}`,
        ),
      ];
      if (lines.length === 0) rows.push("Nothing has been recorded about them yet.");
      const text = rows.join("\n");
      deps.served.read(text);
      return text;
    },
  });
}

/** Whether a string is shaped like a post's id. */
function isPostIdLike(value: string): boolean {
  return new RegExp(`^${UUID.source}$`, "iu").test(value);
}

/** The customer a card on the canvas is about, by reference, or nothing. */
async function customerOfCard(deps: ThreadDeps, postId: string): Promise<number | undefined> {
  const chatJid = await chatOfCard(deps, postId);
  return chatJid === undefined ? undefined : deps.bundle.referenceOfChat(chatJid);
}

/**
 * The conversation a card on the canvas is about: a draft's destination, or
 * the chat a binding question asks about — read rep-side, never served.
 */
async function chatOfCard(deps: ThreadDeps, postId: string): Promise<string | undefined> {
  const row = await deps.db.query<{ destination: string | null; about: string | null }>(
    `SELECT d.destination, q.about_event_id::text AS about
       FROM posts p
       LEFT JOIN drafts d ON d.id = p.draft_id
       LEFT JOIN notices q ON q.id = p.notice_id AND q.kind = 'binding_question'
      WHERE p.twin_id = $1 AND p.id = $2`,
    [deps.twinId, postId],
  );
  const found = row.rows[0];
  if (found?.destination != null) return found.destination;
  if (found?.about != null) return await chatOfBindingQuestion(deps, found.about);
  return undefined;
}

/** A conversation's number by its last four digits, where it has one. */
function numberTail(chatJid: string): string {
  const tail = tailOf(chatJid);
  return tail === undefined ? "" : ` (the number ending ${tail})`;
}

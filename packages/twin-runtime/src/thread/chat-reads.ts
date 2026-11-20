/**
 * THE REP'S CUSTOMERS AND THEIR CONVERSATIONS, AS THE TWIN READS THEM (ticket
 * #396; Diego's ruling of 2026-10-12: every read is the twin's and every
 * rutina's; ADR-0013 as amended — a read owes a projection).
 *
 * `list_chats`, `search_chat_history` and `read_filed_facts` were Dito's
 * extraction's alone (`extraction/tools.ts`), bound to the chat-day a child of
 * that run claimed and numbered by references that run served. These are the
 * same three reads bound to the twin's whole history and named the way every
 * thread tool names a customer — by the customer's own reference, which the
 * twin writes wherever it speaks of them (spec #318 decision 18). The thread
 * holds them, and so does any run's agent step, since a step's tools are the
 * thread's (`runs/catalog.ts`); the extraction's child keeps its own binding
 * while it holds a claimed chat-day (`runs/conversation.ts`).
 *
 * `list_chats` IS AN INDEX AND STAYS ONE: a customer's reference, their name,
 * when their conversation last said anything and which side said it. No
 * words — the search serves those, under its own page limit.
 *
 * EVERY READ GROUNDS THE TWIN'S LINE as any read does (`served.ts`): what it
 * printed is recorded, so a line resting on it is a line resting on the
 * record.
 */
import { defineTool, renderTurnInstant, type ProjectionToolDeclaration } from "@dito/execution";
import { inDeliveryOrder } from "@dito/bundle";
import { readFiledLines } from "../filed-lines.js";
import { counterpartyName } from "../grammar.js";
import { renderGesturesForModel } from "../reactions.js";
import { retrieveRelevantMessages } from "../retrieval.js";
import {
  LIST_CHATS_TOOL,
  READ_FILED_FACTS_COLUMNS,
  READ_FILED_FACTS_TOOL,
  SEARCH_CHAT_HISTORY_COLUMNS,
  SEARCH_CHAT_HISTORY_TOOL,
} from "../extraction/tools.js";
import type { ThreadDeps } from "./deps.js";
import { renderSearchHits } from "./lines.js";
import {
  customerLine,
  parseReference,
  REFERENCE_EXAMPLE,
  tailOf,
  tailsOf,
  writeReference,
  type Customer,
} from "./references.js";
import type { ServedHit } from "./served.js";

/** How many hits one search serves: the thread's own eight (`tools.ts`). */
const SEARCH_LIMIT = 8;

/**
 * WHAT A LISTED CUSTOMER RETURNS, PINNED (ADR-0013): the extraction's three
 * columns and `last_from` — which side wrote the newest message, the rep or
 * the customer — the one fact a «who has not answered me» question needs, and
 * a fact about a message rather than its words.
 */
export const THREAD_LIST_CHATS_COLUMNS: readonly string[] = ["ref", "name", "last_message_at", "last_from"];

/** A thread read's declared half (`tools.ts`'s `ThreadSearchDeclaration`). */
type ChatReadDeclaration = Omit<ProjectionToolDeclaration, "run">;

export const THREAD_LIST_CHATS_DECLARATION: ChatReadDeclaration = {
  name: LIST_CHATS_TOOL,
  gate: "projection",
  description: `List every customer the rep has confirmed, newest conversation first: each one's reference — ${REFERENCE_EXAMPLE} — their name, when their conversation last had a message and who wrote it, the rep or the customer. No messages: search_chat_history and search_memory read what was said.`,
  columns: THREAD_LIST_CHATS_COLUMNS,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export const THREAD_SEARCH_CHAT_HISTORY_DECLARATION: ChatReadDeclaration = {
  name: SEARCH_CHAT_HISTORY_TOOL,
  gate: "projection",
  description:
    "Look through the rep's conversations with their customers — never this thread with you. Each match comes back with a number, when it was sent, which side sent it and whose conversation it was: the customer's reference and name.",
  columns: SEARCH_CHAT_HISTORY_COLUMNS,
  // `about` AND NOT `query`: the projection fence refuses a parameter named
  // for a caller-written query (`@dito/execution`'s `projectionViolations`).
  inputSchema: {
    type: "object",
    properties: {
      about: {
        type: "string",
        description:
          "What to look for, in whatever words you like — the search runs over the rep's conversations with their customers and returns the closest matches.",
      },
      chat: {
        type: ["string", "null"],
        description: `A customer's reference, like ${REFERENCE_EXAMPLE}, to look only through their conversations. Null to look through all of them.`,
      },
    },
    required: ["about", "chat"],
    additionalProperties: false,
  },
};

export const THREAD_READ_FILED_FACTS_DECLARATION: ChatReadDeclaration = {
  name: READ_FILED_FACTS_TOOL,
  gate: "projection",
  description: `Read what is already recorded for one of the rep's customers: the most recent lines of the day's notes filed about them, oldest first, each with when it was filed and whether the rep has since marked it wrong. Name the customer by their reference, like ${REFERENCE_EXAMPLE}.`,
  columns: READ_FILED_FACTS_COLUMNS,
  inputSchema: {
    type: "object",
    properties: {
      chat: {
        type: "string",
        description: `The customer's reference, like ${REFERENCE_EXAMPLE} — whose record to read.`,
      },
    },
    required: ["chat"],
    additionalProperties: false,
  },
};

/** The three, in the extraction's order: search, list, read the record. */
export const CHAT_READ_DECLARATIONS: readonly ChatReadDeclaration[] = [
  THREAD_SEARCH_CHAT_HISTORY_DECLARATION,
  THREAD_LIST_CHATS_DECLARATION,
  THREAD_READ_FILED_FACTS_DECLARATION,
];

/**
 * The list, bound to this twin's mirror: one line per confirmed customer —
 * every chat of theirs read as one conversation, its newest message the
 * newest of any of them.
 */
export function listChatsTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...THREAD_LIST_CHATS_DECLARATION,
    run: () => {
      const last = deps.bundle.lastMessages();
      const seen = new Set<number>();
      const listed: { readonly customer: Customer; readonly at?: string; readonly fromMe?: boolean }[] = [];
      for (const binding of deps.bundle.listChatBindings()) {
        const reference = deps.bundle.referenceOfEntity(binding.entityId);
        if (reference === undefined || seen.has(reference)) continue;
        seen.add(reference);
        const customer = deps.served.customers(reference);
        if (customer === undefined) continue;
        const newest = customer.chats
          .map((chat) => last.get(chat.chatJid))
          .filter((one) => one !== undefined)
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
        listed.push({ customer, ...(newest === undefined ? {} : { at: newest.occurredAt, fromMe: newest.fromMe }) });
      }
      listed.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
      const text =
        listed.length === 0
          ? "The rep has confirmed no customer yet."
          : [
              "The customers the rep has confirmed, newest conversation first:",
              ...listed.map(
                (one) =>
                  `${customerLine(one.customer)} — ${
                    one.at === undefined
                      ? "no message in your memory yet"
                      : `last message ${renderTurnInstant(new Date(one.at), deps.timeZone)}, from ${one.fromMe === true ? "the rep" : "the customer"}`
                  }`,
              ),
            ].join("\n");
      deps.served.read(text);
      return text;
    },
  });
}

/** The search, bound to this twin's memory: every customer's conversation, never this thread. */
export function searchChatHistoryTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...THREAD_SEARCH_CHAT_HISTORY_DECLARATION,
    run: async (input: unknown) => {
      const given = input as { about?: unknown; chat?: unknown };
      if (typeof given.about !== "string" || given.about.trim() === "") {
        return "rejected: `about` is what to look for, in words";
      }
      let scope: readonly string[] | undefined;
      if (given.chat !== null && given.chat !== undefined && given.chat !== "") {
        const reference = parseReference(given.chat);
        if (reference === undefined) {
          return `rejected: \`chat\` is a customer's reference, like ${REFERENCE_EXAMPLE}, or null.`;
        }
        const scoped = scopeToCustomer(deps, reference, "chat");
        if ("refused" in scoped) return scoped.refused;
        scope = scoped;
      }
      const { hits } = await servedHistory(deps, given.about, scope, SEARCH_LIMIT, true);
      if (hits.length === 0) return "No message in the rep's conversations matched.";
      return renderSearchHits(hits, [], deps.selfChatJid, deps.timeZone);
    },
  });
}

/** The record read, bound to this execution's own connection and the twin's references. */
export function readFiledFactsTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...THREAD_READ_FILED_FACTS_DECLARATION,
    run: async (input: unknown) => {
      const reference = parseReference((input as { chat?: unknown }).chat);
      if (reference === undefined) {
        return `rejected: \`chat\` is a customer's reference, like ${REFERENCE_EXAMPLE}.`;
      }
      const customer = deps.served.customers(reference);
      if (customer?.entityId === undefined) {
        return `${writeReference(reference)} is not a customer the rep has confirmed, so nothing is recorded for them.`;
      }
      const rows = await readFiledLines(deps.db, { twinId: deps.twinId, entityId: customer.entityId });
      const text =
        rows.length === 0
          ? `Nothing is recorded for ${writeReference(reference)} yet.`
          : [
              `What is recorded for ${writeReference(reference)}, oldest first:`,
              ...[...rows].reverse().map(
                (row, at) =>
                  `[line ${String(at + 1)}] [${renderTurnInstant(row.filed_at, deps.timeZone)}] ${row.rendered_text}${row.retracted ? " — the rep marked this one wrong" : ""}`,
              ),
            ].join("\n");
      deps.served.read(text);
      return text;
    },
  });
}

/**
 * THE CHATS A REFERENCE SCOPES A SEARCH TO (ticket #321; Codex r2) — every
 * chat of that customer, or a refusal when it names nobody. A reference is
 * the one name two customers of one name do not share, so it is honoured as
 * the scope rather than read as a name that matches nothing — which would
 * silently widen the search to everyone.
 */
export function scopeToCustomer(
  deps: ThreadDeps,
  reference: number,
  parameter: "counterparty" | "chat",
): readonly string[] | { readonly refused: string } {
  const customer = deps.served.customers(reference);
  if (customer === undefined) {
    return {
      refused:
        parameter === "counterparty"
          ? `rejected: \`counterparty\` names ${writeReference(reference)}, which names no customer. Use a reference a tool gave you, a name, or null.`
          : `rejected: \`chat\` names ${writeReference(reference)}, which names no customer. Use a reference a tool gave you, or null.`,
    };
  }
  return customer.chats.map((chat) => chat.chatJid);
}

/**
 * ONE SEARCH OF THE REP'S HISTORY, SERVED (tickets #173, #321, #396): the
 * hits by meaning over the scope's chats or every chat, in delivery order,
 * each numbered for this run and named by its customer's reference — and the
 * customers they came from. `search_memory` and the thread's
 * `search_chat_history` both read through it; the second never reaches the
 * rep's own thread.
 */
export async function servedHistory(
  deps: ThreadDeps,
  about: string,
  scope: readonly string[] | undefined,
  limit: number,
  withoutTheThread = false,
): Promise<{ readonly hits: readonly ServedHit[]; readonly customers: ReadonlyMap<string, Customer | undefined> }> {
  // A SEARCH THAT THROWS IS NOT AN EMPTY HISTORY: the runner records the tool
  // failure and the execution lands `failed`.
  // ONE QUERY PER CHAT OF THE SCOPE, merged by distance: a customer with
  // two numbers is one customer, and both conversations are theirs.
  const found = (
    await Promise.all(
      (scope ?? [undefined]).map((chatJid) =>
        retrieveRelevantMessages({
          bundle: deps.bundle,
          embedder: deps.embedder,
          query: about,
          ...(chatJid === undefined ? {} : { chatJid }),
          // THE REP'S OWN THREAD IS LEFT AT THE ROW SOURCE when the read
          // is `search_chat_history` (ADR-0033): the KNN never chooses it.
          ...(withoutTheThread ? { excludeChatJid: deps.selfChatJid } : {}),
          // ONE MORE THAN THE LIMIT, because exactly one row is about to
          // be dropped: the message this execution is answering
          // (`ThreadDeps.messageId` argues why). Over-fetching by one is
          // what keeps the page the size the projection promises when
          // the rep's own question ranks inside it — which, being the
          // query's own words, it always does.
          limit: limit + 1,
        }),
      ),
    )
  ).flat();
  const rows = found
    .sort((a, b) => a.distance - b.distance)
    .filter((row) => row.message.messageId !== deps.messageId)
    .slice(0, limit);
  // Gestures composed against what twin memory holds NOW (#97), and the
  // pair of a reaction and its removal dealt into their own slots by the
  // reactor's clock (#109) — both after the search, over the rows it
  // really returned, exactly as every other reader does it. `inDeliveryOrder`
  // runs on the ALREADY SLICED result, so it can only swap two rows the
  // search really returned; the references are assigned over this final
  // order below, so every one names the line it is printed beside.
  const ordered = inDeliveryOrder(
    renderGesturesForModel(
      deps.bundle,
      rows.map((row) => row.message),
    ),
    (row) => row,
  );
  // EVERY CUSTOMER A HIT COMES FROM IS NAMED BY THEIR REFERENCE (ticket
  // #321): a confirmed chat by its customer's, and a chat nobody has
  // confirmed by one of its own, given the first time the twin is shown
  // it. The rep's own thread is nobody's customer and has none.
  const customers = new Map<string, Customer | undefined>();
  for (const row of ordered) {
    if (row.chatJid === deps.selfChatJid || customers.has(row.chatJid)) continue;
    customers.set(row.chatJid, deps.served.customers(deps.bundle.referenceForChat(row.chatJid)));
  }
  const hits = deps.served.serve(
    ordered.map((row): Omit<ServedHit, "ref"> => {
      const customer = customers.get(row.chatJid);
      return {
        chatJid: row.chatJid,
        messageId: row.messageId,
        // The one binding-aware naming rule (#34): the reference's own
        // name, unmarked when the rep confirmed it and «(sin confirmar)»
        // otherwise. THE THREAD ITSELF HAS NO CUSTOMER and falls through
        // to its number, which the rendering names for what it is.
        counterparty:
          customer?.shown ??
          counterpartyName({
            confirmedName: undefined,
            pushName: undefined,
            senderJid: row.chatJid,
          }),
        ...(customer === undefined ? {} : { customer: customer.reference }),
        ...(customer !== undefined && tailsOf(customer).length > 0 && tailOf(row.chatJid) !== undefined
          ? { chatTail: tailOf(row.chatJid)! }
          : {}),
        fromMe: row.fromMe,
        occurredAt: row.occurredAt,
        content: row.content,
        ...(row.pushName === undefined ? {} : { pushName: row.pushName }),
      };
    }),
  );
  return { hits, customers };
}

/**
 * THE THREE READS AN EXTRACTION HAS (ticket #196; spec #193 decision 18;
 * ADR-0013 as amended, ADR-0033, ADR-0039 as amended).
 *
 * A customer writes «me mandas lo mismo del pedido pasado?» and the day in
 * front of the model does not say what «lo mismo» is. Without a way to look,
 * that candidate is dropped and the order simply goes unrecorded — the twin
 * holds the customer's whole history in its memory and cannot read it. These
 * three are the way: search the rep's own conversations, list the ones the
 * rep has confirmed, and read what has already been filed for one of them.
 *
 * ALL THREE ARE PROJECTIONS (ADR-0013 as amended — "a read owes a
 * projection"). Each declares the columns it returns and nothing the model
 * sends can widen that: `about` and `chat` select ROWS, which is the whole of
 * what a read's parameters may do.
 *
 * A CONVERSATION IS A NUMBER AND NEVER AN ADDRESS (`served.ts`). The only
 * thing that narrows a search or names an entity's filed lines is a reference
 * `list_chats` minted this run — so a poisoned message has no parameter to
 * put a chat address into, which is the argument `resolve_chat` makes on the
 * thread side and it holds identically here.
 *
 * THE SEARCH CANNOT REACH THE TWIN THREAD, BY CONSTRUCTION (ADR-0033; spec
 * #193 decision 18: "excluded at the row source and never by filter"). The
 * rep's own thread is where their instructions to their twin live, and an
 * extraction that could read it could turn «no le contestes a Torres» into a
 * fact about Torres. The exclusion rides INSIDE the bundle's KNN subquery, on
 * the vec0 partition key, so those rows are not among the ones `k` chooses
 * from — a filter over the result would both leave the row source reachable
 * and short the page (`SearchOptions.excludeChatJid`).
 *
 * WHAT A RESULT IS AND IS NOT. Everything these return is the rep's own
 * history being quoted to the model. It grounds a RESOLUTION and is never a
 * fact's source: a candidate names the day's own message and only that
 * (`fileOne` refuses anything else), so nothing found here can become
 * provenance, and nothing found here reaches the payload, the line, the run
 * row or the Ledger except as the resolved VALUE it named.
 */
import { inDeliveryOrder } from "@dito/bundle";
import { defineTool, type ProjectionToolDeclaration } from "@dito/execution";
import { readFiledLines } from "../filed-lines.js";
import { counterpartyName } from "../grammar.js";
import { renderGesturesForModel } from "../reactions.js";
import { retrieveRelevantMessages } from "../retrieval.js";
import type { ExtractionDeps } from "./deps.js";
import {
  renderChatList,
  renderFiledLines,
  renderSearchHits,
} from "./lines.js";
import type { ServedChat, ServedLine, ServedMessage } from "./served.js";

/** The tool's registered name — what the rep's own history is searched with. */
export const SEARCH_CHAT_HISTORY_TOOL = "search_chat_history";

/**
 * How many hits one search serves.
 *
 * EIGHT, WHICH IS THE THREAD'S NUMBER AND NOT DRAFTING'S SIX. Both searches
 * run over every conversation the rep has, so the page has to be able to hold
 * hits from more than one chat and still say something; drafting's six are
 * ONE chat's retrieval page inside NFR-2's window. A resolution needs the
 * order it points at to be on the page, and an order is one message.
 */
const SEARCH_LIMIT = 8;

/**
 * What a hit's conversation is called when nobody has named it (Codex round
 * 2; ADR-0004).
 *
 * ENGLISH AND CODE-OWNED, like every other thing this runtime writes into a
 * prompt rather than into a post (the beat stamps' own rule, #139). It says
 * what the model needs — these hits are one conversation, and it is not one
 * the rep has told the twin about — and carries no identity at all, which is
 * the whole of why it exists in place of the number.
 */
const UNNAMED_COUNTERPARTY = "a customer the rep has not named";

/**
 * WHAT A HIT RETURNS, PINNED (ADR-0013 — "a read owes a projection").
 *
 * A bundle row carries a chat address, a rail message id, a sender JID, a
 * push-name and reaction bookkeeping. None of that is here. What is left is
 * what a person reading a transcript sees — when, which side spoke, whose
 * conversation it was, and the words — plus the reference the row is printed
 * under.
 *
 * `counterparty` IS A NAME AND NEVER AN ADDRESS: the rep-confirmed one when
 * the chat is bound, the counterparty's own push-name «(sin confirmar)»
 * otherwise, through the one binding-aware naming rule every rep-side surface
 * resolves through (`counterpartyName`). It is here because a search over
 * every conversation is useless if a hit does not say whose it was — that is
 * exactly how «lo mismo que a Torres» is resolved.
 *
 * ...AND A CHAT NOBODY HAS NAMED GETS `UNNAMED_COUNTERPARTY` (Codex round 2).
 * `counterpartyName` falls back to the NUMBER when there is neither a binding
 * nor a push-name, which is right on the rep side — the rep can see who —
 * and wrong here: this is the one read whose output can end up in a Ledger
 * payload the rep's employer reads, and a WhatsApp number is chat identity
 * (ADR-0004). The rep side never loses anything by it, because a chat with
 * no name is one the model cannot narrow to and cannot read a record for.
 */
export const SEARCH_CHAT_HISTORY_COLUMNS: readonly string[] = [
  "ref",
  "occurred_at",
  "from_me",
  "counterparty",
  "content",
];

/**
 * The parameters, and why neither is called `query`.
 *
 * `projectionViolations` REFUSES A PARAMETER NAMED `query` — it is in the
 * group that "widens columns, tables and company at once" — and that fence is
 * doing its job on an ambiguous word: a tool whose caller writes the query has
 * no pinned projection at all, and nothing in the name distinguishes a search
 * string from a SQL one. So `about` is named for what it holds, exactly as
 * the thread's and drafting's are.
 *
 * `chat` IS A ROW SELECTOR in ADR-0013's sense: it decides WHICH messages come
 * back and can never decide what a message returns. Null looks through all of
 * them, which is the ordinary case — «lo mismo que a Torres» is a reference
 * into somebody else's conversation, and a search that could only look in the
 * chat being extracted would never find it.
 */
const SEARCH_CHAT_HISTORY_SCHEMA = {
  type: "object",
  properties: {
    about: {
      type: "string",
      description:
        "What to look for, in whatever words you like — the search runs over the rep's own message history and returns the closest matches.",
    },
    chat: {
      type: ["integer", "null"],
      description:
        "A conversation's reference number from list_chats, to look only through that one. Null to look through all of them.",
    },
  },
  required: ["about", "chat"],
  additionalProperties: false,
} as const;

/**
 * A tool's DECLARED HALF — everything but its handler.
 *
 * A MODULE-LEVEL CONSTANT BECAUSE TWO THINGS READ IT (the thread's own note):
 * the instructions render the tool list from this (ADR-0013 — the tool list
 * rides with the instructions), and the registry's factory builds the runnable
 * tool from it. One source, so the digest that stamps what the model was TOLD
 * and the declaration it was HANDED cannot describe different tools. It holds
 * no closure, which is what lets `EXTRACTION_AUTOMATION` be a constant.
 */
export type ExtractionReadDeclaration = Omit<ProjectionToolDeclaration, "run">;

const SEARCH_CHAT_HISTORY_DECLARATION: ExtractionReadDeclaration = {
  name: SEARCH_CHAT_HISTORY_TOOL,
  gate: "projection",
  description:
    "Look through the rep's own message history — every conversation they have with a customer. Each match comes back with a reference number, when it was sent, which side sent it and whose conversation it was. It cannot reach the rep's own thread with you.",
  columns: SEARCH_CHAT_HISTORY_COLUMNS,
  inputSchema: SEARCH_CHAT_HISTORY_SCHEMA,
};

/** The tool's registered name — the rep's confirmed conversations. */
export const LIST_CHATS_TOOL = "list_chats";

/**
 * WHAT A LISTED CONVERSATION RETURNS, PINNED (ADR-0013).
 *
 * THREE COLUMNS, AND THE ABSENCE IS THE POINT: no content. This read exists
 * so the model can find out WHO the rep's customers are and get a reference
 * to narrow the other two reads with — «lo mismo que a Torres» needs Torres
 * to be nameable before anything is searched. A conversation's messages are
 * the search's to serve, under the search's own page limit; listing them here
 * would be an unbounded read of every chat the rep has, dressed as an index.
 *
 * `last_message_at` IS WHAT MAKES THE LIST ORDERABLE BY A READER rather than
 * by luck: a rep with forty customers needs the recent ones to be findable,
 * and the instant is the one fact about a conversation that says so without
 * quoting anything anybody said.
 */
export const LIST_CHATS_COLUMNS: readonly string[] = [
  "ref",
  "name",
  "last_message_at",
];

/**
 * NO PARAMETERS AT ALL, and that is the narrowest a projection can be: there
 * is nothing to select, nothing to page and no second way to ask. The row
 * source is this twin's own entity mirror, bound from the deps.
 */
const LIST_CHATS_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const LIST_CHATS_DECLARATION: ExtractionReadDeclaration = {
  name: LIST_CHATS_TOOL,
  gate: "projection",
  description:
    "List the customers the rep has confirmed, each with a reference number, the name the rep confirmed and when that conversation last said anything. No messages — use search_chat_history for what was said.",
  columns: LIST_CHATS_COLUMNS,
  inputSchema: LIST_CHATS_SCHEMA,
};

/** The tool's registered name — what has already been recorded for a customer. */
export const READ_FILED_FACTS_TOOL = "read_filed_facts";


/**
 * WHAT A FILED LINE RETURNS, PINNED (ADR-0013), AND WHAT IT CANNOT (spec #171
 * decision 4: "no Ledger read and no new grant").
 *
 * The rows are the rep-side `disclosure_lines` — plaintext, already crossed,
 * already read by the rep in the day's post — joined to the rep-side
 * `fact_retractions` the runtime already selects. Both are stores this role
 * holds a grant on today.
 *
 * WHAT IS NOT HERE, AND WHY. Spec #193 decision 18 asks for the fact TYPE and
 * for whether the fact is provisional, final or retracted. Two of those three
 * are columns of the Ledger's own fact row — its type, and the instant it
 * finalized — and the twin runtime holds no privilege on a Ledger TABLE
 * (…20260829100012): reading them means either a Ledger read or a new grant,
 * and decision 4 of spec #171 forbids both. Deriving «final» from `filed_at` plus the correction window
 * would be worse than absent: it would put the finalization rule in a second
 * place, where it could disagree with the aperture's. RETRACTED is the half
 * that IS reachable, and it is the half that matters most here — a line the
 * rep has marked wrong is the one thing a resolution must not resolve
 * against. The verb in every line says its type in words anyway («Le
 * cotizaste …», «Te pidió …»), which is what the model actually reads.
 */
export const READ_FILED_FACTS_COLUMNS: readonly string[] = [
  "ref",
  "filed_at",
  "line",
  "retracted",
];

/**
 * `chat` IS A ROW SELECTOR and the only parameter: it names WHICH customer's
 * lines come back and can never decide what a line returns. A reference this
 * run served, never an entity id and never an address.
 */
const READ_FILED_FACTS_SCHEMA = {
  type: "object",
  properties: {
    chat: {
      type: "integer",
      description:
        "A conversation's reference number from list_chats — whose record to read.",
    },
  },
  required: ["chat"],
  additionalProperties: false,
} as const;

const READ_FILED_FACTS_DECLARATION: ExtractionReadDeclaration = {
  name: READ_FILED_FACTS_TOOL,
  gate: "projection",
  description:
    "Read what is already recorded for one of the rep's customers: the most recent lines the rep was shown, oldest first, each with a reference number, when it was filed and whether the rep has since marked it wrong.",
  columns: READ_FILED_FACTS_COLUMNS,
  inputSchema: READ_FILED_FACTS_SCHEMA,
};

/**
 * EVERY TOOL AN EXTRACTION HAS — three reads and no act.
 *
 * THE ORDER IS SPEC #193 DECISION 18's, LITERALLY: `search_chat_history`,
 * `list_chats`, `read_filed_facts`. The instructions render the list in it,
 * and it reads as the shape of a look: search for the thing, find out who a
 * name belongs to, then read what is already recorded for them. An extraction
 * writes nothing anybody reads, so there is no act in the list and no gate
 * here but `projection`.
 */
export const EXTRACTION_TOOL_DECLARATIONS: readonly ExtractionReadDeclaration[] =
  [
    SEARCH_CHAT_HISTORY_DECLARATION,
    LIST_CHATS_DECLARATION,
    READ_FILED_FACTS_DECLARATION,
  ];

/** The search, bound to this twin's memory and this run's served references. */
export function searchChatHistoryTool(
  deps: ExtractionDeps,
): ProjectionToolDeclaration {
  return defineTool({
    ...SEARCH_CHAT_HISTORY_DECLARATION,
    run: async (input: unknown) => {
      // The runner has already refused an undeclared property and a missing
      // required one (`inputViolations`), so what is left is the type the
      // schema declares and the model did not honour — which the SDK
      // validates nowhere.
      const given = input as { about?: unknown; chat?: unknown };
      if (typeof given.about !== "string" || given.about.trim() === "") {
        return "rejected: `about` is what to look for, in words";
      }
      let chatJid: string | undefined;
      if (given.chat !== null && given.chat !== undefined) {
        // AN HONEST REFUSAL RATHER THAN A WIDER SEARCH. Running unscoped
        // would answer a question the model did not ask, and the model would
        // read the hits as coming from the one conversation it named.
        const chat = servedChat(deps, given.chat);
        if (typeof chat === "string") return chat;
        chatJid = chat.chatJid;
      }
      const rows = await retrieveRelevantMessages({
        bundle: deps.bundle,
        embedder: deps.embedder,
        query: given.about,
        // THE ROW SOURCE, NOT A FILTER (ADR-0033; the header argues it).
        excludeChatJid: deps.selfChatJid,
        ...(chatJid === undefined ? {} : { chatJid }),
        limit: SEARCH_LIMIT,
      });
      // Gestures composed against what twin memory holds NOW (#97), and the
      // pair of a reaction and its removal dealt into their own slots by the
      // reactor's clock (#109) — both after the search, over the rows it
      // really returned, exactly as every other reader does it. The
      // references are assigned over this final order, so every one names the
      // line it is printed beside.
      const ordered = inDeliveryOrder(
        renderGesturesForModel(
          deps.bundle,
          rows.map((row) => row.message),
        ),
        (row) => row,
      );
      // The provisional name for each chat, chosen ONCE per chat from a
      // COUNTERPARTY-authored row. `push_name` is the SENDER's name, so an
      // own-sent row in a customer chat carries the REP's — which would
      // label a hit «the rep's conversation with Diego». Only the other side
      // of a conversation may name it; with no such row the number stands.
      const chatNames = new Map<string, string>();
      for (const row of ordered) {
        if (row.fromMe) continue;
        const name = row.pushName;
        if (name === undefined || name === "") continue;
        if (!chatNames.has(row.chatJid)) chatNames.set(row.chatJid, name);
      }
      // EVERY CONVERSATION THIS SEARCH READ, recorded for the filing (Codex
      // round 2). The model has now seen those chats' CONTENT, so a number
      // inside one of them could be copied into a payload field — and the
      // aperture's wall sweep only knows the chat a fact is filed against.
      // Run-scoped and never persisted: it is a fact about what this
      // execution was shown.
      deps.served.reach(ordered.map((row) => row.chatJid));
      const hits = deps.served.number(
        ordered.map((row): Omit<ServedMessage, "ref"> => {
          const binding = deps.bundle.readChatBinding(row.chatJid);
          const pushName = chatNames.get(row.chatJid);
          return {
            counterparty:
              binding === undefined && pushName === undefined
                ? UNNAMED_COUNTERPARTY
                : counterpartyName({
                    confirmedName: binding?.displayName,
                    pushName,
                    senderJid: row.chatJid,
                  }),
            fromMe: row.fromMe,
            occurredAt: row.occurredAt,
            content: row.content,
          };
        }),
      );
      if (hits.length === 0) {
        // AN HONEST EMPTY, SAID IN WORDS. A blank tool result reads to the
        // model as a tool that failed, and the difference between "the rep's
        // history holds nothing about it" and "the search broke" is the
        // difference between dropping a candidate as unresolvable and
        // resolving it against nothing. A failure THROWS, so silence here is
        // only ever this.
        return "No message in the rep's history matched.";
      }
      return renderSearchHits(hits, deps.timeZone);
    },
  });
}

/** The list, bound to this twin's entity mirror and this run's references. */
export function listChatsTool(
  deps: ExtractionDeps,
): ProjectionToolDeclaration {
  return defineTool({
    ...LIST_CHATS_DECLARATION,
    run: () => {
      // ONE STATEMENT FOR EVERY CHAT'S INSTANT (Codex round 1). Reading each
      // one through `readConversation` would load every message of every
      // bound chat to take one timestamp — synchronously, on the loop that
      // also drafts, which is the one thing the batch lane exists to stay off.
      const lastAt = deps.bundle.lastMessageInstants();
      const chats = deps.served.serveChats(
        deps.bundle.listChatBindings().map((binding): Omit<ServedChat, "ref"> => {
          // A REFUSAL RATHER THAN A FILTER (ADR-0033; `assertNotSelfChat`
          // states the same rule at the pass's own input set). The rep's own
          // thread cannot be in the entity mirror — a binding is the rep
          // saying which CUSTOMER a chat belongs to, and the twin is not one
          // — so this is unreachable; it is here because a filter is what
          // rots and a refusal is what fails loudly if it ever does.
          if (binding.chatJid === deps.selfChatJid) {
            throw new Error(
              `${LIST_CHATS_TOOL} found the twin thread in the entity mirror — the rep's own thread is never an extraction input, and this is a refusal rather than a filter because a filter is what rots (ADR-0033)`,
            );
          }
          return {
            chatJid: binding.chatJid,
            entityId: binding.entityId,
            displayName: binding.displayName,
            lastMessageAt: lastAt.get(binding.chatJid),
          };
        }),
      );
      if (chats.length === 0) {
        return "The rep has confirmed no customer conversations yet.";
      }
      return renderChatList(chats, deps.timeZone);
    },
  });
}

/** The record read, bound to this execution's own connection and references. */
export function readFiledFactsTool(
  deps: ExtractionDeps,
): ProjectionToolDeclaration {
  return defineTool({
    ...READ_FILED_FACTS_DECLARATION,
    run: async (input: unknown) => {
      const given = input as { chat?: unknown };
      const chat = servedChat(deps, given.chat);
      if (typeof chat === "string") return chat;
      const rows = await readFiledLines(deps.db, {
        twinId: deps.twinId,
        entityId: chat.entityId,
      });
      if (rows.length === 0) {
        return `Nothing is recorded for ${chat.displayName} yet.`;
      }
      // PRINTED OLDEST FIRST, though the LIMIT takes the newest: the model
      // reads a customer's record the way it reads a transcript, and a page
      // that runs backwards would have to be re-ordered by whoever reads it.
      const lines = deps.served.number(
        [...rows].reverse().map(
          (row): Omit<ServedLine, "ref"> => ({
            filedAt: row.filed_at.toISOString(),
            text: row.rendered_text,
            retracted: row.retracted,
          }),
        ),
      );
      return renderFiledLines(chat.displayName, lines, deps.timeZone);
    },
  });
}

/**
 * The conversation a reference names, or the refusal the model reads instead.
 *
 * TWO READS TAKE A `chat` REFERENCE and both owe the same two refusals — a
 * value that is not a whole number, and a number this run never served — so
 * the walk from a wire reference to a chat is written once. A string back is
 * the tool result: `runnable` serves a projection's return value to the model
 * verbatim, so a refusal is feedback it can act on rather than an error.
 */
function servedChat(
  deps: ExtractionDeps,
  given: unknown,
): ServedChat | string {
  if (typeof given !== "number" || !Number.isInteger(given)) {
    return `rejected: \`chat\` is a conversation's reference number from ${LIST_CHATS_TOOL}`;
  }
  const chat = deps.served.chat(given);
  if (chat === undefined) {
    return `rejected: no conversation has been served under reference ${String(given)} — call ${LIST_CHATS_TOOL} first, and use a number it printed`;
  }
  return chat;
}


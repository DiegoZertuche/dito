/**
 * THE THREAD EXECUTION'S READ (ticket #173; spec #171 decision 19: "Tools:
 * `search_memory` (projection, every chat of the rep's including the
 * thread)"; ADR-0013 as amended).
 *
 * The rep asks their twin something about their own work, and this is what
 * the twin can do about it: look through everything it remembers, in whatever
 * words it chooses, and answer from what came back with the references the
 * rep can check. The three acts on its own earlier posts are `acts.ts`, the
 * rep's notebook is `notepad.ts` and the one draft it may write is
 * `write.ts`; this is the one thing it can look at.
 *
 * ONE REGISTERED NAME, TWO BINDINGS, and that is the registry design doing
 * exactly what it is for. Drafting registers `search_memory` over ONE chat
 * (`drafting/tools.ts`) because a drafting execution is answering one
 * conversation and has nothing to widen to; the thread registers the same
 * name over every chat because the rep asked about somebody. Registries are
 * plain values held per automation and never a module-level global
 * (`registry.ts`), so the same name meaning two scopes is a property of which
 * registry a spec was resolved against — and two NAMES would tell the model
 * that searching is two different acts, which it is not. The digest tells
 * them apart either way: the description, the pinned columns and the
 * parameters all differ, so the two automations stamp different digests.
 *
 * A PROJECTION, AND THE SCOPE IS NOT WIDENED BY A PARAMETER. ADR-0013's rule
 * for a read is that its "parameters select rows … and never columns, tables
 * or company". `counterparty` narrows to one chat when the rep named
 * somebody; nothing the model can send widens anything, because the widest
 * this read goes — this twin's own memory — is where it starts, and the twin
 * is bound from `deps`.
 *
 * THE TWIN THREAD IS IN SCOPE NOW, WHICH IS THE REVERSAL (spec #171 decision
 * 19). The Q&A filtered its own chat out of every search and paginated to
 * stop the exclusion starving the page. Both are gone: the exclusion was
 * costing the twin any memory of what it and the rep had already worked out
 * («¿y qué le cotizamos?» after an answer about a quote), and with nothing
 * filtered there is no starvation to compensate for — one page is one page.
 * What kept the loop honest was never the filter: it is that retrieved
 * content is DATA, that a citation must name a hit this run served, and that
 * this tool's only output is text (`guard.ts`; the poison cases in
 * `thread.int.test.ts`).
 */
import { defineTool, type ProjectionToolDeclaration } from "@dito/execution";
import { REP_ACT_DECLARATIONS, type RepActDeclaration } from "./acts.js";
import { PROPOSE_BINDING_DECLARATION } from "./propose-binding.js";
import { bindingQuestionAsked } from "../answering.js";
import { renderChatFacts, resolveChatCandidates } from "./chats.js";
import { civilDate } from "../grammar.js";
import {
  KNOCK_DECLARATION,
  MOVE_CARDS_DECLARATION,
  READ_CANVAS_DECLARATION,
  READ_POST_DECLARATION,
  SAY_ON_CARD_DECLARATION,
  SPOTLIGHT_DECLARATION,
} from "./canvas-tools.js";
import {
  READ_ENTITY_DECLARATION,
  READ_MESSAGE_DECLARATION,
  SEARCH_MESSAGES_DECLARATION,
} from "./memory-tools.js";
import { NOTHING_TO_SAY_DECLARATION } from "./nothing-to-say.js";
import { WRITE_NOTEPAD_DECLARATION } from "./notepad.js";
import { WRITE_WORKING_MEMORY_DECLARATION } from "./working-memory.js";
import { CREATE_DRAFT_DECLARATION } from "./write.js";
import { FILL_BLANK_DECLARATION } from "./fill.js";
import { CREATE_AUTOMATION_DECLARATION } from "../runs/create-automation.js";
import { ANSWER_PROPOSAL_DECLARATION } from "../runs/proposals.js";
import { RUN_TOOL_DECLARATIONS } from "../runs/declarations.js";
import { ANSWER_ASK_DECLARATION, ASK_DECLARATION } from "../runs/ask.js";
import { CHAT_READ_DECLARATIONS, scopeToCustomer, servedHistory } from "./chat-reads.js";
import type { ThreadDeps } from "./deps.js";
import { renderSearchHits } from "./lines.js";
import {
  customerLine,
  parseReference,
  REFERENCE_EXAMPLE,
  writeReference,
  type Customer,
} from "./references.js";
import type { ServedUnconfirmedChat } from "./served.js";

/** The tool's registered name — the Q&A's own, for the same act. */
export const SEARCH_MEMORY_TOOL = "search_memory";

/**
 * How many hits one search serves.
 *
 * EIGHT, WHICH IS THE Q&A's OWN NUMBER AND NOT DRAFTING'S SIX. The rep asked
 * a question about their whole book of conversations, so the page has to be
 * able to hold hits from more than one chat and still say something; a
 * drafting turn is answering one conversation inside NFR-2's window and its
 * six are that chat's own retrieval page. Kept at eight so an answer the rep
 * reads today cites what it cited yesterday.
 */
const SEARCH_LIMIT = 8;

/**
 * WHAT A HIT RETURNS, PINNED (ADR-0013 — "a read owes a projection").
 *
 * A bundle row carries a chat address, a rail message id, a sender JID, a
 * push-name and reaction bookkeeping. None of that is here. What is left is
 * what a person reading a transcript sees — when, which side spoke, whose
 * conversation it was, and the words — plus the number the answer cites it
 * by.
 *
 * `counterparty` IS THE CUSTOMER'S REFERENCE AND NAME (ticket #321): the
 * reference the twin writes when it speaks of them, and the name code renders
 * for it — the rep-confirmed one, or the push-name «(sin confirmar)» — never
 * an address. It is the one column drafting's projection does not have: a
 * search over every chat is useless if it does not say whose each hit is.
 *
 * `chat` LISTS THE CONVERSATIONS AMONG THE HITS THAT NOBODY HAS CONFIRMED
 * (ticket #195), by the same references: the twin may hand the rep the
 * question whether one of them is the customer it just talked about
 * (`propose_binding`).
 */
export const SEARCH_MEMORY_COLUMNS: readonly string[] = [
  "ref",
  "occurred_at",
  "from_me",
  "counterparty",
  "content",
  "chat",
];

/**
 * The parameters, and why neither is called `query`.
 *
 * `projectionViolations` REFUSES A PARAMETER NAMED `query` — it is in the
 * group that "widens columns, tables and company at once", beside `sql` and
 * `where` — and that fence is doing its job on an ambiguous word: a tool
 * whose caller writes the query has no pinned projection at all, and nothing
 * in the name distinguishes a search string from a SQL one. So `about` is
 * named for what it holds, exactly as the drafting side's is.
 *
 * `counterparty` IS A ROW SELECTOR in ADR-0013's sense: it decides WHICH
 * messages come back and can never decide what a message returns. A
 * customer's reference scopes to every chat of theirs, and one that names
 * nobody is refused rather than read as a name (ticket #321). An unbound or
 * ambiguous NAME is not an error and not a guess — the search simply runs
 * unscoped, so the twin still answers from everything it knows. Ceremony
 * never blocks an answer.
 */
const SEARCH_MEMORY_SCHEMA = {
  type: "object",
  properties: {
    about: {
      type: "string",
      description:
        "What to look for, in whatever words you like — the search runs over the rep's own message history and returns the closest matches.",
    },
    counterparty: {
      type: ["string", "null"],
      description:
        `The customer to look through, when the turn is about one: their reference, like ${REFERENCE_EXAMPLE}, or the name the rep used. Null to look through all of them.`,
    },
  },
  required: ["about", "counterparty"],
  additionalProperties: false,
} as const;

/**
 * A tool's DECLARED HALF — everything but its handler.
 *
 * A MODULE-LEVEL CONSTANT BECAUSE TWO THINGS READ IT (the drafting side's own
 * note): the instructions render the tool list from this (ADR-0013 — the tool
 * list rides with the instructions), and the registry's factory builds the
 * runnable tool from it. One source, so the digest that stamps what the model
 * was TOLD and the declaration it was HANDED cannot describe different tools.
 * It holds no closure, which is what lets the thread's definition be a
 * constant (`runs/shipped-conversations.ts`).
 */
export type ThreadSearchDeclaration = Omit<ProjectionToolDeclaration, "run">;

const SEARCH_MEMORY_DECLARATION: ThreadSearchDeclaration = {
  name: SEARCH_MEMORY_TOOL,
  gate: "projection",
  description:
    "Look through the rep's own message history — every conversation they have, this thread with you included. Each match comes back with a number you cite it by, when it was sent, which side sent it, and whose conversation it was: the customer's reference and name.",
  columns: SEARCH_MEMORY_COLUMNS,
  inputSchema: SEARCH_MEMORY_SCHEMA,
};

/**
 * The search's own reading of the name→chat resolution (#34's hand-off,
 * kept unchanged by #175): scope to the one chat when exactly one matches.
 *
 * AN AMBIGUOUS NAME STILL RESOLVES TO NOTHING HERE, and that is deliberate
 * rather than left over. A wrong scope silently hides the answer; an
 * unscoped search merely looks wider, so a search never needs the ask. The
 * ask is `resolve_chat`'s, where the rep asked the twin to WRITE to
 * somebody and picking the wrong one has a cost. The fold underneath is now
 * one function both call (`chats.ts`), so the two readings cannot disagree
 * about which chats a name names.
 */
function scopeToChat(deps: ThreadDeps, counterparty: string): string | undefined {
  const matches = resolveChatCandidates(deps.bundle, counterparty);
  return matches.length === 1 ? matches[0]!.chatJid : undefined;
}

/** The tool's registered name — the one #173's comment promised. */
export const RESOLVE_CHAT_TOOL = "resolve_chat";

/**
 * WHAT A CANDIDATE RETURNS, PINNED (ADR-0013 — "a read owes a projection").
 *
 * THREE COLUMNS, AND THE ABSENCES ARE THE POINT (ticket #321). A customer's
 * reference — what the twin writes wherever it speaks of them and hands to
 * `create_draft` — the name the rep confirmed, and each of their chats: the
 * number's last four digits and the day the other side last wrote, which is
 * what the twin picks a chat by when the customer has more than one. No chat
 * address, no entity id, nothing anybody said: the twin can only ever name a
 * customer by a reference this projection printed.
 */
export const RESOLVE_CHAT_COLUMNS: readonly string[] = ["ref", "name", "chats"];

/**
 * `name` IS A ROW SELECTOR in ADR-0013's sense: it decides WHICH bindings
 * come back and can never decide what one returns. It is also the only
 * parameter — there is nothing to page, nothing to widen, and no second way
 * to ask.
 */
const RESOLVE_CHAT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "The name the rep used for the customer, exactly as they wrote it. Matching ignores accents and capitals but not the rest: the whole name has to be one the rep has confirmed.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const RESOLVE_CHAT_DECLARATION: ThreadSearchDeclaration = {
  name: RESOLVE_CHAT_TOOL,
  gate: "projection",
  description: `Find which of the rep's confirmed customers a name belongs to. Each comes back with its reference — ${writeReference(7)} — the name the rep confirmed, and each of its chats: the last four digits of the number and the day that customer last wrote. Write that reference wherever you speak of them and pass it to the tools that take a customer; it names them for the rest of the day. Two come back when two customers share the name, and none when the rep has confirmed nobody by it.`,
  columns: RESOLVE_CHAT_COLUMNS,
  inputSchema: RESOLVE_CHAT_SCHEMA,
};

/** The tool, bound to this twin's bindings and references. */
export function resolveChatTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...RESOLVE_CHAT_DECLARATION,
    run: (input: unknown) => {
      const given = input as { name?: unknown };
      if (typeof given.name !== "string" || given.name.trim() === "") {
        return "rejected: `name` is the name the rep used for the customer.";
      }
      const customers = customersNamed(deps, given.name);
      if (customers.length === 0) {
        // AN HONEST EMPTY, SAID IN WORDS: a blank result would read as a
        // broken tool, and the difference between "the rep has no chat under
        // that name" and "the lookup failed" is the difference between the
        // twin saying it cannot write to them and the twin inventing one.
        return "No customer of the rep's is confirmed under that name. You cannot write to them: tell the rep so, and do not draft anything.";
      }
      return customers.map((customer) => candidateLines(deps, customer)).join("\n");
    },
  });
}

/**
 * The customers whose confirmed chats a name matches — one per entity, in
 * the mirror's own order, each by its reference.
 */
function customersNamed(deps: ThreadDeps, name: string): readonly Customer[] {
  const found: Customer[] = [];
  for (const chat of resolveChatCandidates(deps.bundle, name)) {
    const reference = deps.bundle.referenceOfEntity(chat.entityId);
    const customer = reference === undefined ? undefined : deps.served.customers(reference);
    if (customer !== undefined && !found.some((one) => one.reference === customer.reference)) {
      found.push(customer);
    }
  }
  return found;
}

/** One customer as the lookup prints them: the reference, the name, each chat. */
function candidateLines(deps: ThreadDeps, customer: Customer): string {
  const chats = customer.chats.map((chat, at) => {
    const lastAt = deps.bundle.lastMessageFromOtherSide(chat.chatJid);
    return `  chat ${String(at + 1)}: ${renderChatFacts(
      chat.tail,
      lastAt === undefined ? undefined : civilDate(new Date(lastAt), deps.timeZone),
    )}`;
  });
  return [
    `${customerLine(customer)} — ${customer.chats.length === 1 ? "one chat" : `${String(customer.chats.length)} chats; say which when you write to them`}:`,
    ...chats,
  ].join("\n");
}

/**
 * EVERY TOOL A THREAD EXECUTION HAS — the reads, the three acts on the rep's
 * own posts, their notebook, the one thing it may write for a customer, and
 * the two that decide what the rep sees and hears (tickets #174, #175, #260
 * and #320, narrowed at #218).
 *
 * THE ORDER IS SPEC #171 DECISION 19's, LESS THE ONE ACT THAT LEFT AND PLUS
 * THE ONE 6b ADDED: "`search_memory`, `resolve_chat`, `dismiss_draft`,
 * `decline_binding`, `retract_disclosure_line`, `create_draft`" — the
 * decision listed `answer_aperture_question` between the last two, and spec
 * #214 decision 3 retires it with the route that gave it something to
 * answer — and spec #318 decision 19's reads, spotlight and knock (ticket
 * #320). The instructions render the list in this order, and it reads as
 * the shape of a turn: look, then resolve who, then read whole, then act on
 * what the rep pointed at, then write down what they taught you, then write
 * to a customer, and last decide what the rep sees and hears of it.
 *
 * `write_notepad` SITS WITH THE ACTS AND NOT WITH THE DRAFT, because that is
 * what it is: a gated effect on the rep's own twin-side state, asked for in
 * their own sentence (spec #258; ADR-0033 as amended). What separates it
 * from the three above it is only its target — their standing rules rather
 * than a post they quoted — which is why the instructions state the
 * quoted-post rule of the three and not of it.
 */
export const THREAD_TOOL_DECLARATIONS: readonly ThreadToolDeclaration[] = [
  SEARCH_MEMORY_DECLARATION,
  RESOLVE_CHAT_DECLARATION,
  // THE REP'S CUSTOMERS AND THEIR CONVERSATIONS, AS AN INDEX AND A SEARCH AND
  // THEIR RECORD (ticket #396): the extraction's three reads, the twin's too.
  ...CHAT_READ_DECLARATIONS,
  // WHAT IT CAN READ OF ITS OWN DAYS AND OF THE CANVAS (ticket #320; spec #318
  // decision 19), right after the two reads it had: look, then read whole.
  SEARCH_MESSAGES_DECLARATION,
  READ_MESSAGE_DECLARATION,
  READ_POST_DECLARATION,
  READ_ENTITY_DECLARATION,
  READ_CANVAS_DECLARATION,
  ...REP_ACT_DECLARATIONS,
  // ...AND THE BINDING QUESTION, HANDED TO THE REP (ticket #363): the
  // sibling of the rep's «no» on it, one tool over.
  PROPOSE_BINDING_DECLARATION,
  WRITE_NOTEPAD_DECLARATION,
  // THE TWIN'S OWN NOTES, BESIDE THE REP'S (ticket #322; spec #318 decision
  // 19): the second notebook, written in any turn and gated as disclosed.
  WRITE_WORKING_MEMORY_DECLARATION,
  CREATE_DRAFT_DECLARATION,
  // ...AND THE BLANK A DRAFT LEFT, FILLED FROM THE REP'S ANSWER (ticket #342):
  // writing to a customer again, so beside the draft.
  FILL_BLANK_DECLARATION,
  // WHAT THE REP SEES AND HEARS, which only the thread decides (ticket #320;
  // design D4): the cards' places, the one card held up (ticket #401), then
  // the phone — and a sentence on the card the rep brought the twin to (ticket #340).
  MOVE_CARDS_DECLARATION,
  SPOTLIGHT_DECLARATION,
  KNOCK_DECLARATION,
  SAY_ON_CARD_DECLARATION,
  // ...AND A TURN THAT HAS NOTHING FOR THE REP, ended by the twin's own call
  // (ticket #401).
  NOTHING_TO_SAY_DECLARATION,
  // ...AND THE JOBS THAT OUTLIVE A TURN (ticket #323; spec #318 decisions 4 and
  // 19): what is in flight, then starting, steering, pausing and cancelling one.
  ...RUN_TOOL_DECLARATIONS,
  // ...AND THE ONES THAT RUN AGAIN AND AGAIN (tickets #325, #386): live at
  // the rep's ask, or the twin's proposal on a card — and the rep's answer to
  // that card given in their own words.
  CREATE_AUTOMATION_DECLARATION,
  ANSWER_PROPOSAL_DECLARATION,
  // ...AND A RUN'S QUESTION TO THE REP, AND THE REP'S ANSWER GIVEN IN THEIR
  // OWN WORDS (ticket #324): the ask a run's step calls, and the one the
  // thread answers a card with.
  ASK_DECLARATION,
  ANSWER_ASK_DECLARATION,
];

/**
 * A thread tool's declared half, whichever kind it is.
 *
 * THE INSTRUCTIONS RENDER FROM THIS UNION and the two arms read differently
 * — a read owes the rep its pinned columns, an act owes them what it does
 * and what it cannot be aimed at — which is why `renderToolList` branches
 * on the gate rather than printing one sentence for both.
 */
export type ThreadToolDeclaration = ThreadSearchDeclaration | RepActDeclaration;

/** The tool, bound to this twin's memory and this run's served map. */
export function searchMemoryTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...SEARCH_MEMORY_DECLARATION,
    run: async (input: unknown) => {
      // The runner has already refused an undeclared property and a missing
      // required one (`inputViolations`), so what is left is the type the
      // schema declares and the model did not honour — which the SDK
      // validates nowhere.
      const given = input as { about?: unknown; counterparty?: unknown };
      if (typeof given.about !== "string" || given.about.trim() === "") {
        return "rejected: `about` is what to look for, in words";
      }
      const named =
        typeof given.counterparty === "string" && given.counterparty !== ""
          ? given.counterparty
          : undefined;
      const reference = parseReference(named);
      const scope =
        reference !== undefined
          ? scopeToCustomer(deps, reference, "counterparty")
          : named === undefined
            ? undefined
            : (() => {
                const chatJid = scopeToChat(deps, named);
                return chatJid === undefined ? undefined : [chatJid];
              })();
      if (scope !== undefined && "refused" in scope) return scope.refused;
      const { hits, customers } = await servedHistory(deps, given.about, scope, SEARCH_LIMIT);
      if (hits.length === 0) {
        // AN HONEST EMPTY, SAID IN WORDS. A blank tool result reads to the
        // model as a tool that failed, and the difference between "your
        // history holds nothing about it" and "the search broke" decides
        // whether an answer may commit to anything at all. A failure THROWS
        // in `servedHistory`, so silence here is only ever this.
        return "No message in the rep's history matched.";
      }
      const unconfirmed = await unconfirmedChats(deps, [...customers.values()]);
      return renderSearchHits(
        hits,
        unconfirmed,
        deps.selfChatJid,
        deps.timeZone,
      );
    },
  });
}

/**
 * THE CONVERSATIONS AMONG ONE SEARCH'S HITS THAT NOBODY HAS CONFIRMED
 * (ticket #195; spec #193 decision 27).
 *
 * THE THREE THINGS A CHAT NEEDS TO BE ASKABLE ARE THE CEREMONY'S OWN, and
 * they are checked here so the model is shown only chats the question could
 * be asked about (#34's rules, which `answering.ts` still decides under its
 * lock):
 *
 * - NOT THE REP'S OWN THREAD. A «si» on a question about it would confirm
 *   the rep as their own customer and bind the twin thread to an entity.
 * - NOT ALREADY BOUND. There is nothing to ask about a chat the rep has
 *   already told the twin who it is.
 * - NAMED BY THE COUNTERPARTY. `push_name` is the SENDER's, so a rep-authored
 *   row carries the REP's name (#34's decision 1): a chat whose other side
 *   never wrote under a name has nothing to propose and is not listed.
 */
async function unconfirmedChats(
  deps: ThreadDeps,
  customers: readonly (Customer | undefined)[],
): Promise<readonly ServedUnconfirmedChat[]> {
  const askable: ServedUnconfirmedChat[] = [];
  for (const customer of customers) {
    const chat = customer?.chats[0];
    if (customer === undefined || customer.entityId !== undefined || chat === undefined) continue;
    if (customer.anchors.length === 0) continue;
    askable.push({
      reference: customer.reference,
      chatJid: chat.chatJid,
      pushName: customer.name,
      // A COPY, NOT THE AUTHORITY — `served.ts`'s `ServedUnconfirmedChat`
      // argues why, and why it is read here.
      asked: await bindingQuestionAsked(deps, chat.chatJid),
    });
  }
  deps.served.serveUnconfirmed(askable);
  return askable;
}

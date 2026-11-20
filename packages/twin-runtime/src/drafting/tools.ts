/**
 * THE SEARCH A DRAFTING TURN LOOKS WITH (ticket #172; spec #171 decision 15:
 * "Tools: `search_memory` (projection, this chat)"; ADR-0013 as amended), and
 * the list of its two tools — the search and the draft it writes with
 * (`write.ts`, ticket #363).
 *
 * The turn arrives with the chat's recent window and one page of retrieved
 * memories already in front of the model. This is what it can do when that
 * is not enough — look further back through THIS chat's own memory, in
 * whatever words it chooses, which is the difference between a draft that
 * remembers the promise made last month and one that does not (#35's
 * founding case, now something the model can ask for rather than something
 * the consumer guessed at).
 *
 * A PROJECTION, AND THE SCOPE IS NOT A PARAMETER. ADR-0013's rule is that a
 * read's "parameters select rows … and never columns, tables or company",
 * and its amendment adds the reason a read owes anything at all: "a wall
 * leak through a read is a projection leak, not an effect". Here the leak
 * that matters is one customer's conversation reaching another customer's
 * draft — the case `drafting-context.int.test.ts` already plants — so the
 * chat is bound from `deps` at construction and the model has no way to name
 * one. The Q&A's own `search_memory` takes a counterparty precisely because
 * the rep asked about somebody; a drafting execution is answering ONE chat
 * and has nothing to widen to.
 */
import { inDeliveryOrder } from "@dito/bundle";
import {
  defineTool,
  type GatedEffectToolDeclaration,
  type ProjectionToolDeclaration,
} from "@dito/execution";
import { renderGesturesForModel } from "../reactions.js";
import { retrieveRelevantMessages } from "../retrieval.js";
import type { DraftingDeps } from "./deps.js";
import { renderSearchHits } from "./lines.js";
import { CREATE_DRAFT_DECLARATION } from "./write.js";

/** The tool's registered name — the Q&A's own, for the same act. */
export const SEARCH_MEMORY_TOOL = "search_memory";

/**
 * How many hits one search serves.
 *
 * SMALLER THAN THE Q&A's EIGHT, and the reason is the latency budget rather
 * than taste: this runs inside NFR-2's ~1-minute window (ADR-0016) and the
 * model may search more than once, while the Q&A answers one question with
 * one pass. Six is the number the consumer's own retrieval page already
 * uses for the same chat (`DEFAULT_RETRIEVAL_LIMIT`), so the two reads the
 * model is shown are the same size and nothing has to explain why they
 * differ.
 */
const SEARCH_LIMIT = 6;

/**
 * WHAT A HIT RETURNS, PINNED (ADR-0013 — "a read owes a projection").
 *
 * A bundle row carries a chat, a rail message id, a sender JID, a push-name
 * and reaction bookkeeping. None of that is here: the chat is fixed and
 * saying it would be repetition, and every id is rail identity the model has
 * no use for and must not learn to cite. What is left is what a person
 * reading a transcript sees — when, which side spoke, and the words — which
 * is exactly what `recent_transcript` renders, from the same function.
 */
export const SEARCH_MEMORY_COLUMNS: readonly string[] = [
  "occurred_at",
  "from_me",
  "content",
];

/**
 * The parameter, and why it is not called `query`.
 *
 * `projectionViolations` REFUSES A PARAMETER NAMED `query` — it is in the
 * group that "widens columns, tables and company at once", beside `sql` and
 * `where` — and that is the fence doing its job on an ambiguous word rather
 * than a false positive to work around: a tool whose caller writes the query
 * has no pinned projection at all, and nothing in the name distinguishes a
 * search string from a SQL one. So the parameter is named for what it holds.
 * `about` is a row selector in ADR-0013's sense — it decides WHICH messages
 * come back and can never decide what a message returns.
 */
const SEARCH_MEMORY_SCHEMA = {
  type: "object",
  properties: {
    about: {
      type: "string",
      description:
        "What to look for, in whatever words you like — the search runs over this chat's own message history and returns the closest matches.",
    },
  },
  required: ["about"],
  additionalProperties: false,
} as const;

/**
 * A tool's DECLARED HALF — everything but its handler.
 *
 * IT IS A MODULE-LEVEL CONSTANT BECAUSE TWO THINGS READ IT, and the owner
 * twin's `OwnerToolDeclaration` is the same shape for the same reason: the
 * instructions render the tool list from this (ADR-0013 — the tool list
 * rides with the instructions), and the registry's factory builds the
 * runnable tool from it. One source, so the digest that stamps what the
 * model was TOLD and the declaration it was HANDED cannot describe different
 * tools. It holds no closure, which is what lets drafting's definition be a
 * constant (`runs/shipped-conversations.ts`).
 */
export type DraftingToolDeclaration =
  | Omit<ProjectionToolDeclaration, "run">
  | Omit<GatedEffectToolDeclaration, "run">;

const SEARCH_MEMORY_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: SEARCH_MEMORY_TOOL,
  gate: "projection",
  description:
    "Search this chat's earlier messages for anything bearing on what you have to answer. Scoped to this conversation and nothing else. Each match comes back with when it was sent and which side sent it.",
  columns: SEARCH_MEMORY_COLUMNS,
  inputSchema: SEARCH_MEMORY_SCHEMA,
};

/** Every tool a drafting turn has: the look, and the draft (ticket #363). */
export const DRAFTING_TOOL_DECLARATIONS: readonly DraftingToolDeclaration[] = [
  SEARCH_MEMORY_DECLARATION,
  CREATE_DRAFT_DECLARATION,
];

/** The tool, bound to this execution's chat and twin memory. */
export function searchMemoryTool(
  deps: DraftingDeps,
): ProjectionToolDeclaration {
  return defineTool({
    ...SEARCH_MEMORY_DECLARATION,
    run: async (input: unknown) => {
      // The runner has already refused an undeclared property and a missing
      // required one (`inputViolations`), so what is left is the type the
      // schema declares and the model did not honour — which the SDK
      // validates nowhere.
      const about = (input as { about?: unknown }).about;
      if (typeof about !== "string" || about.trim() === "") {
        return "rejected: `about` is what to look for, in words";
      }
      const hits = await retrieveRelevantMessages({
        bundle: deps.bundle,
        embedder: deps.embedder,
        // SCOPED HERE, from `deps`, and unreachable from the input above.
        // The scope is vec0 partition pruning inside the bundle (#32), not
        // a filter over a wider result.
        chatJid: deps.chatJid,
        query: about,
        limit: SEARCH_LIMIT,
      });
      if (hits.length === 0) {
        // AN HONEST EMPTY, said in words: a tool result that came back blank
        // would read to the model as a tool that failed, and the difference
        // between "this chat never mentioned it" and "the search broke"
        // decides whether a draft may commit to anything. A failure here THROWS
        // and the runner records it, so silence is only ever this.
        return "No earlier message in this chat matched.";
      }
      // Gestures composed against what twin memory holds NOW (#97), and the
      // pair of a reaction and its removal dealt into their own slots by the
      // reactor's clock (#109) — both after the search, over the rows it
      // really returned, exactly as the two existing readers do it.
      return renderSearchHits(
        inDeliveryOrder(
          renderGesturesForModel(
            deps.bundle,
            hits.map((hit) => hit.message),
          ),
          (row) => row,
        ),
        deps.timeZone,
      );
    },
  });
}

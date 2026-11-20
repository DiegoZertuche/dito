/**
 * WHAT DRAFTING'S TOOL NAMES MEAN (tickets #172, #363; spec #171 decisions
 * 9, 30 and 31).
 *
 * Drafting's definition names two tools (`runs/shipped-conversations.ts`),
 * and this is where those names become code (`runs/conversation.ts`). It is a
 * plain value built by a function call — never a module-level registry
 * anything writes into — which is the rule spec #171 decision 9 states: this
 * one holds a search over ONE chat and a draft written into that chat, the
 * thread's holds a search over every chat and a draft for a confirmed
 * customer, and a shared mutable registry would put either within reach of
 * the other with nothing in the way but a name.
 *
 * NEITHER TOOL CARRIES A SAVEPOINT: the search reads the BUNDLE — a separate
 * SQLCipher file — and embeds a query through the embedder, so a failing
 * search leaves the transaction clean, the runner records the tool failure,
 * and the turn lands `failed` with its entry beside it; the draft writes
 * nothing at all — it holds the draft, and the turn's caller writes it after
 * the record (ticket #368).
 */
import type { ToolRegistry } from "@dito/execution";
import type { DraftingDeps } from "./deps.js";
import { SEARCH_MEMORY_TOOL, searchMemoryTool } from "./tools.js";
import { CREATE_DRAFT_TOOL, createDraftTool } from "./write.js";

/** Drafting's tools, as one value. */
export function draftingRegistries(): { readonly tools: ToolRegistry<DraftingDeps> } {
  return {
    tools: {
      [SEARCH_MEMORY_TOOL]: {
        gate: "projection",
        create: searchMemoryTool,
      },
      [CREATE_DRAFT_TOOL]: {
        gate: "approve-before",
        create: createDraftTool,
      },
    },
  };
}

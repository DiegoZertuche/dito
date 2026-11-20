/**
 * Retrieval over twin memory (ticket #32, spec #29 decision 9): a text
 * query embeds through the one embedder boundary and searches the
 * bundle's vector store through the bundle API — the most relevant
 * messages for the question, optionally scoped to one chat. This is the
 * contract #35's Q&A tools and #36's context-aware drafting consume: the
 * query vector exists only in memory for the duration of the call, and
 * every hit comes back in the message store's own row shape (ADR-0007 —
 * nothing vector-shaped ever leaves the bundle's custody).
 */
import type { Bundle, ScoredMessage } from "@dito/bundle";
import { embedOne, type Embedder } from "./embedder.js";

export interface RetrievalOptions {
  readonly bundle: Bundle;
  readonly embedder: Embedder;
  /** The rep's question, in whatever words the rep used. */
  readonly query: string;
  /** Restrict hits to one chat's messages. */
  readonly chatJid?: string;
  /**
   * Put one chat OUT OF REACH of this query (ticket #196; ADR-0033).
   *
   * Carried straight through to the bundle, where it is a constraint on the
   * KNN's own row source rather than a filter over its result — the
   * distinction spec #193 decision 18 makes ("excluded at the row source and
   * never by filter") and `SearchOptions.excludeChatJid` argues.
   */
  readonly excludeChatJid?: string;
  /** At most this many hits (the bundle's default when omitted). */
  readonly limit?: number;
}

/** The most relevant stored messages for a text query, nearest first. */
export async function retrieveRelevantMessages(
  options: RetrievalOptions,
): Promise<ScoredMessage[]> {
  const vector = await embedOne(options.embedder, options.query);
  return options.bundle.searchMessages(vector, {
    ...(options.chatJid === undefined ? {} : { chatJid: options.chatJid }),
    ...(options.excludeChatJid === undefined
      ? {}
      : { excludeChatJid: options.excludeChatJid }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

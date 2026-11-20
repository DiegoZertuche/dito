/**
 * The embedding backlog (ticket #32): messages that exist in the bundle
 * without their vector — the migrated slice-1 rig bundle's history at
 * wake-up, or anything a crash left half-done — embed in batches through
 * the one embedder boundary into the bundle's vector store. Restart-safe
 * by construction: the selection is "still un-embedded" and every vector
 * write commits on its own, so a killed run re-selects exactly what it
 * never wrote — nothing lost, nothing duplicated (#33's backfill leans
 * on the same property). Vectors never leave the bundle (ADR-0007).
 */
import type { Bundle } from "@dito/bundle";
import { embedAll, type Embedder } from "./embedder.js";

export interface EmbedBacklogOptions {
  readonly bundle: Bundle;
  readonly embedder: Embedder;
  /** Messages per embedder batch (default 16). */
  readonly batchSize?: number;
}

export interface EmbedBacklogResult {
  /** How many vectors this run stored. */
  readonly embedded: number;
}

const DEFAULT_BATCH_SIZE = 16;

/** Embeds every un-embedded message, one bounded batch at a time. */
export async function embedMessageBacklog(
  options: EmbedBacklogOptions,
): Promise<EmbedBacklogResult> {
  const { bundle, embedder } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let embedded = 0;
  for (;;) {
    const batch = bundle.listUnembeddedMessages(batchSize);
    if (batch.length === 0) {
      return { embedded };
    }
    const vectors = await embedAll(
      embedder,
      batch.map((message) => message.content),
    );
    for (const [i, message] of batch.entries()) {
      // First write wins in the store itself; an embedded message leaves
      // the next selection, so the loop always shrinks the backlog.
      if (bundle.writeMessageVector(message.storeId, vectors[i]!).stored) {
        embedded += 1;
      }
    }
  }
}

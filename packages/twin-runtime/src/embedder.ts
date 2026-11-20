/**
 * The embedder boundary (ticket #32, spec #29 decision 9): the slice's
 * one new scripted boundary. Whatever sits behind it — the real BGE-M3
 * model in-process (bge-m3.ts) or the deterministic fake the integration
 * lanes compose in (testing/fake-embedder.ts) — the contract is one
 * BGE-M3-shaped dense vector per text, in order: MESSAGE_VECTOR_DIMS
 * wide, unit-normalized. Which implementation runs is a composition
 * choice at the edges (scripts, tests), never a code path in here —
 * exactly the scripted-model pattern (ADR-0028). No external embedding
 * service exists: vectors are computed in-process and live only inside
 * the bundle (ADR-0007, ADR-0015 — embeddings are self-hosted rep-side).
 */

/** The one new scripted boundary of slice 2 (spec #29 decision 9). */
export interface Embedder {
  /**
   * Embeds each text into a BGE-M3-shaped dense vector: one vector per
   * input, same order, MESSAGE_VECTOR_DIMS wide, unit-normalized.
   */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/**
 * An embedder broke the one-vector-per-text contract. Loud, never a
 * silent skip: a message left silently un-embedded would be twin memory
 * retrieval can never see.
 */
export class EmbedderContractError extends Error {
  override readonly name = "EmbedderContractError";

  constructor(expected: number, got: number) {
    super(
      `embedder returned ${got} vectors for ${expected} texts — the boundary contract is one vector per text, in order`,
    );
  }
}

/** Embeds a batch, refusing loudly unless the contract holds. */
export async function embedAll(
  embedder: Embedder,
  texts: readonly string[],
): Promise<Float32Array[]> {
  const vectors = await embedder.embed(texts);
  if (vectors.length !== texts.length) {
    throw new EmbedderContractError(texts.length, vectors.length);
  }
  return vectors;
}

/** Embeds one text, refusing loudly unless the contract holds. */
export async function embedOne(
  embedder: Embedder,
  text: string,
): Promise<Float32Array> {
  const vectors = await embedAll(embedder, [text]);
  return vectors[0]!;
}

/**
 * The deterministic fake embedder (ticket #32): the integration lanes'
 * composition at the embedder boundary, the way scripted-model.ts is the
 * lanes' model client (ADR-0028 — the crypto is never mocked; the model
 * boundaries are scripted). A hashed bag-of-words unit vector: the same
 * text always yields the same vector, and cosine similarity follows word
 * overlap — so retrieval rankings are exactly assertable, no model in
 * the loop. Test-only: excluded from the build, never composed outside
 * a test.
 */
import { MESSAGE_VECTOR_DIMS } from "@dito/bundle";
import type { Embedder } from "../embedder.js";

/** Stable vectors, assertable rankings — the integration lanes' embedder. */
export function fakeEmbedder(): Embedder {
  return {
    embed: (texts) => Promise.resolve(texts.map(fakeVector)),
  };
}

function fakeVector(text: string): Float32Array {
  const v = new Float32Array(MESSAGE_VECTOR_DIMS);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    v[fnv1a(word) % MESSAGE_VECTOR_DIMS]! += 1;
  }
  let sumOfSquares = 0;
  for (const x of v) sumOfSquares += x * x;
  if (sumOfSquares === 0) {
    // No words at all: a fixed direction, never the zero vector (cosine
    // distance against a zero vector is undefined).
    v[0] = 1;
    return v;
  }
  const norm = Math.sqrt(sumOfSquares);
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/** FNV-1a over code points — stable across platforms and runs. */
function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (const ch of word) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

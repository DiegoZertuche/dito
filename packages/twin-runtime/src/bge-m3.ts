/**
 * The real embedder (ticket #32, spec #29 decision 9): BGE-M3 dense
 * embeddings, in-process through @huggingface/transformers over
 * onnxruntime — no external embedding service exists, no text ever
 * leaves the process to be embedded (ADR-0015: embeddings are
 * self-hosted rep-side; ADR-0007: the vectors it produces live only
 * inside the bundle). Model weights cache locally (they are not rep
 * data); the first run downloads them, every later run is offline.
 *
 * Composition happens at the edges (scripts/rig-run.ts, the embed
 * smoke): library code only ever sees the Embedder interface, and the
 * integration lanes compose the deterministic fake instead — never a
 * code path, always a composition choice. The heavy runtime loads via
 * dynamic import inside the factory, so importing this package costs
 * nothing until the real model is actually asked for.
 */
import type { Embedder } from "./embedder.js";

/** BGE-M3's ONNX export on the Hugging Face hub — the one owner of the id. */
export const BGE_M3_MODEL = "Xenova/bge-m3";

export interface BgeM3Options {
  /** Hub model id or local path (default BGE_M3_MODEL). */
  readonly model?: string;
  /** Where model files cache (default: the transformers.js cache). */
  readonly cacheDir?: string;
}

/**
 * Loads BGE-M3 once and returns the Embedder the runtime composes in.
 * Dense retrieval embeddings are the model's CLS vector, unit-normalized
 * (the BGE-M3 dense recipe); a vector of any other width is refused
 * typed at the bundle boundary (VectorDimensionMismatchError), so a
 * wrong or mispackaged model can never poison the store.
 */
export async function createBgeM3Embedder(
  options: BgeM3Options = {},
): Promise<Embedder> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = await pipeline(
    "feature-extraction",
    options.model ?? BGE_M3_MODEL,
    {
      // q8 weights (~600MB): rig-friendly, and the retrieval quality the
      // slice needs. Full precision is a later steering call, not a knob.
      dtype: "q8",
      ...(options.cacheDir === undefined
        ? {}
        : { cache_dir: options.cacheDir }),
    },
  );
  return {
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const output = await extractor([...texts], {
        pooling: "cls",
        normalize: true,
      });
      const dims = output.dims[output.dims.length - 1] ?? 0;
      const data = output.data as Float32Array;
      return texts.map((_, i) =>
        // A plain slice: each vector is its own copy, safe to hand to
        // the bundle after the tensor is disposed. Width is asserted at
        // the write/search boundary (MESSAGE_VECTOR_DIMS).
        data.slice(i * dims, (i + 1) * dims),
      );
    },
  };
}

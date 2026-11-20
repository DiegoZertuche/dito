/**
 * The embedder boundary (ticket #32, spec #29 decision 9 — the slice's
 * one new scripted boundary): whichever implementation is composed in
 * must produce one BGE-M3-shaped vector per text, in order. The
 * deterministic fake is the integration lanes' implementation — stable
 * vectors whose similarity follows word overlap, so retrieval rankings
 * are exactly assertable.
 */
import { MESSAGE_VECTOR_DIMS } from "@dito/bundle";
import { describe, expect, it } from "vitest";
import { EmbedderContractError, embedOne } from "./embedder.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

describe("the deterministic fake embedder (integration lanes' composition)", () => {
  it("is deterministic and BGE-M3-shaped: the same text yields the same unit vector on every call — never a zero vector, even for empty text", async () => {
    const embedder = fakeEmbedder();
    const [a] = await embedder.embed(["¿me manda las 40 cajas el jueves?"]);
    const [b] = await embedder.embed(["¿me manda las 40 cajas el jueves?"]);
    expect(a).toEqual(b);
    expect(a!.length).toBe(MESSAGE_VECTOR_DIMS);
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);

    // Cosine distance against a zero vector is undefined — the fake must
    // never emit one, whatever the text.
    const [empty] = await embedder.embed([""]);
    expect(cosine(empty!, empty!)).toBeCloseTo(1, 5);
  });

  it("orders similarity by word overlap — the property that makes retrieval rankings exactly assertable", async () => {
    const embedder = fakeEmbedder();
    const [query, near, far, unrelated] = await embedder.embed([
      "cajas para el jueves",
      "le aparto las cajas el jueves temprano",
      "¿tiene cajas?",
      "mándame la ubicación",
    ]);
    const nearSim = cosine(query!, near!);
    const farSim = cosine(query!, far!);
    const unrelatedSim = cosine(query!, unrelated!);
    expect(nearSim).toBeGreaterThan(farSim);
    expect(farSim).toBeGreaterThan(unrelatedSim);
    expect(unrelatedSim).toBeCloseTo(0, 5);
  });
});

describe("the embedder boundary contract", () => {
  it("embedOne refuses an embedder that breaks one-vector-per-text — loud, never a silent skip", async () => {
    const broken = { embed: () => Promise.resolve([]) };
    await expect(embedOne(broken, "hola")).rejects.toBeInstanceOf(
      EmbedderContractError,
    );
  });
});

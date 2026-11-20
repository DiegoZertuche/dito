/**
 * The served map's two properties: a reference resolves only to a row this
 * run served, and one row has one reference however many tools returned it.
 */
import type { OwnerEntity, OwnerFact } from "@dito/aperture";
import { describe, expect, it } from "vitest";
import { persistedReference, ServedRows } from "./served.js";

function fact(id: string, overrides: Partial<OwnerFact> = {}): OwnerFact {
  return {
    id,
    entityId: "e-1",
    factType: "QuoteGiven",
    payloadVersion: 1,
    payload: { item: "mortero" },
    occurredAt: new Date("2026-08-28T16:00:00Z"),
    filedAt: new Date("2026-08-29T02:00:00Z"),
    confidence: 0.9,
    sourceType: "extraction",
    filedBySeatId: "s-1",
    filedBySeatName: null,
    ...overrides,
  };
}

function entity(id: string, displayName: string): OwnerEntity {
  return {
    entityId: id,
    kind: "business",
    displayName,
    createdAt: new Date("2026-08-20T00:00:00Z"),
  };
}

describe("the served map (spec #126 decision 18)", () => {
  it("hands out references from one, in the order rows were served", () => {
    const served = new ServedRows();
    expect(served.serveEntity(entity("e-1", "Torres Hnos."))).toBe(1);
    expect(served.serveFact(fact("f-1"))).toBe(2);
    expect(served.size).toBe(2);
  });

  it("gives one row one reference, however many tools returned it", () => {
    // Two overlapping timeline reads — one unnarrowed, one by fact type —
    // return the same fact. Two references would render its receipt line
    // twice in one answer.
    const served = new ServedRows();
    const first = served.serveFact(fact("f-1"));
    const again = served.serveFact(fact("f-1"));
    expect(again).toBe(first);
    expect(served.size).toBe(1);
  });

  it("counts the same window twice as one served row", () => {
    const served = new ServedRows();
    const window = {
      factType: "QuoteGiven",
      from: new Date("2026-08-24T00:00:00Z"),
      to: new Date("2026-08-30T00:00:00Z"),
      seatId: "s-1",
      seatName: "Mauricio Cantu",
      count: 4,
    };
    expect(served.serveCount({ ...window })).toBe(1);
    expect(served.serveCount({ ...window })).toBe(1);
  });

  it("tells a count of one window apart from a count of another", () => {
    const served = new ServedRows();
    const base = { factType: "QuoteGiven", from: null, to: null, count: 4 };
    expect(served.serveCount({ ...base, seatId: "s-1", seatName: "Ana" })).toBe(1);
    expect(served.serveCount({ ...base, seatId: "s-2", seatName: "Rosa", count: 9 })).toBe(2);
  });

  it("resolves nothing for a reference it never served", () => {
    // The whole refusal, in one line: this is what a forged citation hits.
    const served = new ServedRows();
    served.serveFact(fact("f-1"));
    expect(served.get(1)).toBeDefined();
    expect(served.get(2)).toBeUndefined();
    expect(served.get(0)).toBeUndefined();
  });

  it("names every entity and every seat it put in front of the model", () => {
    const served = new ServedRows();
    served.serveEntity(entity("e-1", "Torres Hnos."));
    served.serveFact(fact("f-1", { filedBySeatName: "Mauricio Cantu" }));
    served.serveFact(fact("f-2", { filedBySeatName: null }));
    expect(served.servedNames()).toEqual(["Torres Hnos.", "Mauricio Cantu"]);
  });

  it("persists a fact reference as the fact's own id, beside its wire ref", () => {
    const served = new ServedRows();
    const ref = served.serveFact(fact("f-9"));
    expect(persistedReference(served.get(ref)!)).toEqual({
      ref: 1,
      kind: "fact",
      factId: "f-9",
    });
  });

  it("persists a count as its descriptor, because no row holds it", () => {
    const served = new ServedRows();
    const ref = served.serveCount({
      factType: "QuoteGiven",
      from: new Date("2026-08-24T00:00:00Z"),
      to: null,
      seatId: null,
      seatName: null,
      count: 4,
    });
    expect(persistedReference(served.get(ref)!)).toEqual({
      ref: 1,
      kind: "count",
      count: {
        factType: "QuoteGiven",
        from: "2026-08-24T00:00:00.000Z",
        to: null,
        seatId: null,
        seatName: null,
        count: 4,
      },
    });
  });
});

/**
 * The rendered turn (ticket #130; spec #126 decision 18; #134 variant A).
 *
 * The claim under every test here: the model contributed words, kinds and
 * references, and every VALUE the owner will read came off a served row
 * through `@dito/aperture`'s renderers.
 */
import {
  renderOwnerFactLine,
  renderOwnerInstant,
  type OwnerEntity,
  type OwnerFact,
} from "@dito/aperture";
import { describe, expect, it } from "vitest";
import { OwnerRenderError, renderOwnerTurn } from "./render.js";
import { ServedRows } from "./served.js";

const TIME_ZONE = "America/Monterrey";

const FACT: OwnerFact = {
  id: "f-1",
  entityId: "e-1",
  factType: "QuoteGiven",
  payloadVersion: 1,
  payload: { item: "mortero", quantity: 40, unit: "bultos", amount: 4500, currency: "MXN" },
  occurredAt: new Date("2026-08-28T16:00:00Z"),
  filedAt: new Date("2026-08-29T02:00:00Z"),
  confidence: 0.955,
  sourceType: "extraction",
  filedBySeatId: "s-1",
  filedBySeatName: "Mauricio Cantu",
};

const ENTITY: OwnerEntity = {
  entityId: "e-1",
  kind: "business",
  displayName: "Torres Hnos.",
  createdAt: new Date("2026-08-20T00:00:00Z"),
};

function oneCustomer(): ServedRows {
  const served = new ServedRows();
  served.serveEntity(ENTITY);
  served.serveFact(FACT);
  return served;
}

describe("the rendered turn", () => {
  it("fills every slot from the row it names, and leaves the prose alone", () => {
    const turn = renderOwnerTurn(
      { kind: "answer", prose: "Lo ultimo con [[1]] fue [[2]].", references: [1, 2] },
      oneCustomer(),
      TIME_ZONE,
    );
    expect(turn.prose).toEqual([
      { kind: "prose", text: "Lo ultimo con " },
      {
        kind: "reference",
        ref: 1,
        referenceClass: "reference-name",
        of: "entity",
        text: "Torres Hnos.",
      },
      { kind: "prose", text: " fue " },
      {
        kind: "reference",
        ref: 2,
        referenceClass: "provenance-value",
        of: "fact",
        // The renderer's own composition, not a second one written here.
        text: renderOwnerFactLine(FACT),
      },
      { kind: "prose", text: "." },
    ]);
  });

  it("renders a receipt line for every cited fact, in ADR-0004's five fields", () => {
    const turn = renderOwnerTurn(
      { kind: "answer", prose: "Fue [[2]].", references: [1, 2] },
      oneCustomer(),
      TIME_ZONE,
    );
    // The record and the fact are both cited; only the fact earns a line
    // (#134: a reference name has no square and no receipt).
    expect(turn.receipt).toEqual([
      {
        kind: "fact",
        ref: 2,
        typeLabel: "Cotización dada",
        sourceType: "Conversación",
        seat: "Mauricio Cantu",
        occurred: renderOwnerInstant(FACT.occurredAt, TIME_ZONE),
        filed: renderOwnerInstant(FACT.filedAt, TIME_ZONE),
        confidence: "confianza 95.5%",
      },
    ]);
  });

  it("renders a count's number from the row, and its line says the window is closed", () => {
    const served = oneCustomer();
    const ref = served.serveCount({
      factType: "QuoteGiven",
      from: new Date("2026-08-24T00:00:00Z"),
      to: new Date("2026-08-30T00:00:00Z"),
      seatId: "s-1",
      seatName: "Mauricio Cantu",
      count: 4,
    });
    const turn = renderOwnerTurn(
      {
        kind: "answer",
        prose: `Fueron [[${ref}]].`,
        references: [ref],
        countRef: ref,
      },
      served,
      TIME_ZONE,
    );
    const value = turn.prose.find((segment) => segment.kind === "reference");
    expect(value).toMatchObject({ referenceClass: "provenance-value", of: "count", text: "4" });
    expect(turn.receipt).toEqual([
      {
        kind: "count",
        ref,
        typeLabel: "Cotización dada",
        seat: "Mauricio Cantu",
        from: renderOwnerInstant(new Date("2026-08-24T00:00:00Z"), TIME_ZONE),
        to: renderOwnerInstant(new Date("2026-08-30T00:00:00Z"), TIME_ZONE),
        windowClosed: true,
      },
    ]);
  });

  it("carries FR-46's three parts: the refusal, the timeline, the follow-up", () => {
    const turn = renderOwnerTurn(
      {
        kind: "refusal",
        prose: "De las conversaciones no te puedo decir nada.",
        references: [1],
        timelineRef: 1,
        followUp: "Lo mejor es preguntarle a quien la atiende.",
      },
      oneCustomer(),
      TIME_ZONE,
    );
    expect(turn.kind).toBe("refusal");
    expect(turn.timeline).toEqual({
      ref: 1,
      entityId: "e-1",
      displayName: "Torres Hnos.",
    });
    expect(turn.followUp?.map((segment) => segment.text).join("")).toBe(
      "Lo mejor es preguntarle a quien la atiende.",
    );
    // A refusal shows no receipt strip: the record it points at is a name,
    // and it quotes no fact.
    expect(turn.receipt).toEqual([]);
  });

  it("renders an ask's candidates as records to choose between", () => {
    const served = new ServedRows();
    served.serveEntity(ENTITY);
    served.serveEntity({ ...ENTITY, entityId: "e-2", displayName: "Torres Hermanos" });
    const turn = renderOwnerTurn(
      {
        kind: "ask",
        prose: "Tengo dos con ese nombre, cual de los dos?",
        references: [1, 2],
        candidates: [1, 2],
      },
      served,
      TIME_ZONE,
    );
    expect(turn.candidates.map((record) => record.displayName)).toEqual([
      "Torres Hnos.",
      "Torres Hermanos",
    ]);
  });

  it("refuses loudly rather than dropping a slot it cannot render", () => {
    // Unreachable through the execution path — the guard refuses an
    // unserved citation before an answer is accepted — and this is what
    // keeps the two in step if a caller ever renders an answer the guard
    // never saw.
    expect(() =>
      renderOwnerTurn(
        { kind: "answer", prose: "Fue [[9]].", references: [9] },
        oneCustomer(),
        TIME_ZONE,
      ),
    ).toThrow(OwnerRenderError);
  });
});

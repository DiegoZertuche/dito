/**
 * The structural guard, case by case (ticket #130; spec #126 decision 8 —
 * "the deterministic half of FR-71b").
 *
 * The four the spec names each have their own test below: a model that
 * types a provenance line, one that cites a row the tools never served, one
 * that answers with invented content, and one that puts a number in prose.
 * They are asserted here as PURE REFUSALS, over an answer and a served map,
 * and again end to end over the scripted wire in `turn.int.test.ts` — where
 * the same answer has to produce `schema-miss`, one audit entry and a row in
 * the failed-query log.
 */
import type { OwnerEntity, OwnerFact } from "@dito/aperture";
import { describe, expect, it } from "vitest";
import { structuralViolations } from "./guard.js";
import { ServedRows } from "./served.js";
import { parseOwnerAnswer, type OwnerAnswer } from "./answer.js";

function fact(id: string, overrides: Partial<OwnerFact> = {}): OwnerFact {
  return {
    id,
    entityId: "e-1",
    factType: "QuoteGiven",
    payloadVersion: 1,
    payload: { item: "mortero", quantity: 40, unit: "bultos", amount: 4500 },
    occurredAt: new Date("2026-08-28T16:00:00Z"),
    filedAt: new Date("2026-08-29T02:00:00Z"),
    confidence: 0.9,
    sourceType: "extraction",
    filedBySeatId: "s-1",
    filedBySeatName: "Mauricio Cantu",
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

/**
 * A run that served one record and one of its facts: refs 1 and 2.
 *
 * TWO READS NOTED, because two tools ran to produce those rows — and the
 * guard's grounding rule asks BOTH "did anything get read" and "was
 * anything cited", so a fixture that served rows without noting a read
 * would be a run that could not have happened.
 */
function oneCustomer(): ServedRows {
  const served = new ServedRows();
  served.noteResolution();
  served.serveEntity(entity("e-1", "Torres Hnos."));
  served.noteRecordRead();
  served.serveFact(fact("f-1"));
  return served;
}

/** ...and a run whose one read came back with nothing at all. */
function readNothing(): ServedRows {
  const served = new ServedRows();
  served.noteResolution();
  return served;
}

const GROUNDED: OwnerAnswer = {
  kind: "answer",
  prose: "Lo ultimo con [[1]] fue [[2]].",
  references: [1, 2],
};

describe("the structural guard (spec #126 decision 8)", () => {
  it("passes a grounded answer whose values are all slots", () => {
    expect(structuralViolations(GROUNDED, oneCustomer())).toEqual([]);
  });

  it("refuses a citation to a row no tool served", () => {
    const violations = structuralViolations(
      { ...GROUNDED, references: [1, 2, 9] },
      oneCustomer(),
    );
    expect(violations).toContain(
      "references names reference 9, which no tool served this turn",
    );
  });

  it("refuses a slot that fills a reference the turn does not list", () => {
    const violations = structuralViolations(
      { kind: "answer", prose: "Lo ultimo con [[1]] fue [[2]].", references: [1] },
      oneCustomer(),
    );
    expect(violations).toContain(
      "a slot in prose fills reference 2, which is not among the answer's references",
    );
  });

  it("refuses a number typed into prose", () => {
    // The count case, from the other end: the tool never shows the model a
    // number, so a number in prose is one the model produced.
    const violations = structuralViolations(
      { kind: "answer", prose: "Le diste 4 cotizaciones a [[1]].", references: [1] },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("prose types a number or a date");
  });

  it("refuses a phone number written the way a person writes one", () => {
    // A FORMATTED NUMBER HAS NO TEN-DIGIT RUN (#129's follow-up found the
    // shape). The entity-name fence looks for one; this rule does not — any
    // digit at all in prose is a value the model typed, so «+52 (55)
    // 1234-5678» is refused by the same sentence that refuses «4».
    const violations = structuralViolations(
      {
        kind: "answer",
        prose: "Te dejo el contacto: +52 (55) 1234-5678, y ve [[2]].",
        references: [2],
      },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("prose types a number or a date");
  });

  it("does not mistake a slot's own digits for a number", () => {
    const served = new ServedRows();
    for (let i = 0; i < 12; i += 1) served.serveFact(fact(`f-${i}`));
    expect(
      structuralViolations(
        { kind: "answer", prose: "Fue [[11]] y [[12]].", references: [11, 12] },
        served,
      ),
    ).toEqual([]);
  });

  it("refuses a provenance line typed into prose", () => {
    // «Cotización dada» is the tag code puts at the head of a rendered fact,
    // and it is derived from the renderer rather than written down here.
    const violations = structuralViolations(
      {
        kind: "answer",
        prose: "Cotización dada: lo de [[1]], con confianza alta.",
        references: [1],
      },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("prose types a provenance line");
  });

  it("refuses a resolved name typed into prose", () => {
    const violations = structuralViolations(
      { kind: "answer", prose: "Torres Hnos. sigue pendiente, ver [[2]].", references: [2] },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain(
      "prose types a name the tools resolved",
    );
  });

  it("refuses a seat's name typed into prose, not only a customer's", () => {
    const violations = structuralViolations(
      { kind: "answer", prose: "Eso lo levanto Mauricio Cantu, ver [[2]].", references: [2] },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain(
      "prose types a name the tools resolved",
    );
  });

  it("refuses a calendar day typed into prose", () => {
    const violations = structuralViolations(
      { kind: "answer", prose: "Quedo para el jueves, ver [[2]].", references: [2] },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("prose types a calendar day");
  });

  it("refuses a chat address, which no owner-visible row can carry", () => {
    const violations = structuralViolations(
      {
        kind: "answer",
        prose: "Te escribio desde 5218112223344@s.whatsapp.net, ver [[2]].",
        references: [2],
      },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("names a chat address");
  });

  it("refuses an answer that cites nothing while the tools served rows", () => {
    // The invented-conversation case: the model read a timeline and then
    // answered from something that was not in it.
    const violations = structuralViolations(
      { kind: "answer", prose: "Te dijo que lo queria antes de la comida.", references: [] },
      oneCustomer(),
    );
    expect(violations).toContain(
      "an answer cites the rows it rests on, and this one cites none while the tools served rows",
    );
  });

  it("lets an answer cite nothing when the read came back with nothing", () => {
    // The honest empty answer, and qa.ts's own carve-out: there is nothing
    // to cite because retrieval genuinely came back with nothing.
    expect(
      structuralViolations(
        { kind: "answer", prose: "No encuentro nada de eso en el registro.", references: [] },
        readNothing(),
      ),
    ).toEqual([]);
  });

  it("refuses an answer from a turn that read nothing at all", () => {
    // THE INVENTED-CONTENT CASE IN ITS REALISTIC SHAPE: inventing means not
    // reading, so the model that invents calls no tool — and then it types
    // no digit, no served name and no rendered token, and every other rule
    // here passes it. `qa.ts`'s rule is what catches it: read the record
    // before answering about it.
    const violations = structuralViolations(
      {
        kind: "answer",
        prose: "Te comento que quedaron de verse y que sono interesado.",
        references: [],
      },
      new ServedRows(),
    );
    expect(violations.join(" ")).toContain("called no tool at all");
  });

  it("refuses an ask that offers fewer than two records (ADR-0039)", () => {
    const violations = structuralViolations(
      { kind: "ask", prose: "Cual de ellos?", references: [1], candidates: [1] },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("fewer than two");
  });

  it("refuses an ask whose candidate is a fact rather than a record", () => {
    const served = oneCustomer();
    served.serveEntity(entity("e-2", "Torres Hermanos"));
    const violations = structuralViolations(
      {
        kind: "ask",
        prose: "Cual de los dos?",
        references: [1, 3],
        candidates: [1, 2],
      },
      served,
    );
    expect(violations.join(" ")).toContain(
      "candidate 2 is a fact and an ask offers records",
    );
  });

  it("refuses an ask whose candidates were each resolved unambiguously", () => {
    // Two customers the owner never asked to choose between: not a question
    // their answer settles (ADR-0039).
    const served = oneCustomer();
    const other = served.serveEntity(entity("e-2", "Lozano"));
    const violations = structuralViolations(
      { kind: "ask", prose: "Cual?", references: [1, other], candidates: [1, other] },
      served,
    );
    expect(violations.join(" ")).toContain("was resolved unambiguously");
  });

  it("refuses an ask that offers one record twice (Codex r3)", () => {
    const served = new ServedRows();
    served.noteResolution();
    const group = served.nextAmbiguityGroup();
    const a = served.serveEntity(entity("e-1", "Aceros Rios"), { ambiguityGroup: group });
    served.serveEntity(entity("e-2", "Aceros Rios"), { ambiguityGroup: group });
    const violations = structuralViolations(
      { kind: "ask", prose: "Cual?", references: [a], candidates: [a, a] },
      served,
    );
    expect(violations.join(" ")).toContain("offers each record once");
  });

  it("refuses an ask that mixes two different ambiguous names (Codex r3)", () => {
    const served = new ServedRows();
    served.noteResolution();
    const first = served.nextAmbiguityGroup();
    const a1 = served.serveEntity(entity("e-1", "Aceros Rios"), { ambiguityGroup: first });
    const a2 = served.serveEntity(entity("e-2", "Aceros Rios"), { ambiguityGroup: first });
    served.noteResolution();
    const second = served.nextAmbiguityGroup();
    const b1 = served.serveEntity(entity("e-3", "Torres"), { ambiguityGroup: second });
    served.serveEntity(entity("e-4", "Torres"), { ambiguityGroup: second });
    const violations = structuralViolations(
      {
        kind: "ask",
        prose: "Cual?",
        references: [a1, b1],
        candidates: [a1, b1],
      },
      served,
    );
    expect(violations.join(" ")).toContain("came from more than one resolution");
    expect([a2]).toBeDefined();
  });

  it("refuses an ask that leaves one of the matching records out (Codex r3)", () => {
    const served = new ServedRows();
    served.noteResolution();
    const group = served.nextAmbiguityGroup();
    const a = served.serveEntity(entity("e-1", "Aceros Rios"), { ambiguityGroup: group });
    const b = served.serveEntity(entity("e-2", "Aceros Rios"), { ambiguityGroup: group });
    served.serveEntity(entity("e-3", "Aceros Rios"), { ambiguityGroup: group });
    const violations = structuralViolations(
      { kind: "ask", prose: "Cual?", references: [a, b], candidates: [a, b] },
      served,
    );
    expect(violations.join(" ")).toContain("a choice missing an option");
  });

  it("accepts the ask that offers exactly what one name matched", () => {
    const served = new ServedRows();
    served.noteResolution();
    const group = served.nextAmbiguityGroup();
    const a = served.serveEntity(entity("e-1", "Aceros Rios"), { ambiguityGroup: group });
    const b = served.serveEntity(entity("e-2", "Aceros Rios"), { ambiguityGroup: group });
    expect(
      structuralViolations(
        {
          kind: "ask",
          prose: "Tengo dos: [[1]] y [[2]]. Cual?",
          references: [a, b],
          candidates: [a, b],
        },
        served,
      ),
    ).toEqual([]);
  });

  it("refuses a refusal that points at a fact instead of a timeline", () => {
    const violations = structuralViolations(
      {
        kind: "refusal",
        prose: "De eso no te puedo hablar.",
        references: [2],
        timelineRef: 2,
        followUp: "Preguntaselo a quien lo atendio.",
      },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain(
      "timeline_ref names a fact, and a refusal points at the customer's timeline",
    );
  });

  it("sweeps the refusal's follow-up as prose, because it is prose", () => {
    const violations = structuralViolations(
      {
        kind: "refusal",
        prose: "De eso no te puedo hablar.",
        references: [1],
        timelineRef: 1,
        followUp: "Preguntale a Mauricio Cantu.",
      },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain(
      "follow_up types a name the tools resolved",
    );
  });

  it("refuses an unserved slot in the refusal's follow-up (Codex r1)", () => {
    // The hole the review found: slots were enumerated from `prose` only,
    // so a follow-up could name a row nobody served — and the renderer,
    // running inside the transaction, threw and rolled back the
    // execution's own audit entry.
    const violations = structuralViolations(
      {
        kind: "refusal",
        prose: "De eso no te puedo hablar, ve [[1]].",
        references: [1],
        timelineRef: 1,
        followUp: "Preguntaselo a [[999]].",
      },
      oneCustomer(),
    );
    expect(violations).toContain(
      "a slot in follow_up names reference 999, which no tool served this turn",
    );
  });

  it("refuses a follow-up slot the answer does not list either", () => {
    const violations = structuralViolations(
      {
        kind: "refusal",
        prose: "De eso no te puedo hablar.",
        references: [1],
        timelineRef: 1,
        followUp: "Lo de [[2]] si te lo puedo abrir.",
      },
      oneCustomer(),
    );
    expect(violations).toContain(
      "a slot in follow_up fills reference 2, which is not among the answer's references",
    );
  });

  it("refuses an answer that resolved a name and never opened it (Codex r1)", () => {
    // THE DUMMY READ. One resolve costs one tool call and grounds nothing:
    // the prose beside it can say anything at all, which is the shape an
    // invented answer to a wall question actually takes.
    const served = new ServedRows();
    served.noteResolution();
    served.serveEntity(entity("e-1", "Torres Hnos."));
    const violations = structuralViolations(
      { kind: "answer", prose: "Con [[1]] todo va bien.", references: [1] },
      served,
    );
    expect(violations.join(" ")).toContain("cites only names");
  });

  it("is not bought off by resolving the same name twice (Codex r2)", () => {
    // The counter this rule used to use let two lookups stand in for a
    // read. Looking up who somebody is twice is still never opening their
    // record.
    const served = new ServedRows();
    served.noteResolution();
    served.serveEntity(entity("e-1", "Torres Hnos."));
    served.noteResolution();
    served.serveEntity(entity("e-1", "Torres Hnos."));
    const violations = structuralViolations(
      { kind: "answer", prose: "Con [[1]] se les nota contentos.", references: [1] },
      served,
    );
    expect(violations.join(" ")).toContain("cites only names");
  });

  it("lets an answer cite only a record once its timeline was read", () => {
    // The honest empty answer about one customer: resolved, opened, nothing
    // there, and it says so citing the record.
    const served = new ServedRows();
    served.noteResolution();
    served.serveEntity(entity("e-1", "Torres Hnos."));
    served.noteRecordRead();
    expect(
      structuralViolations(
        { kind: "answer", prose: "De [[1]] no tengo nada.", references: [1] },
        served,
      ),
    ).toEqual([]);
  });

  it("lets the by-design-delay answer rest on nothing, and only that one (FR-69)", () => {
    expect(
      structuralViolations(
        {
          kind: "answer",
          prose: "Lo de hoy tarda en aparecer: aqui solo veo lo ya firme.",
          references: [],
          delayed: true,
        },
        new ServedRows(),
      ),
    ).toEqual([]);
  });

  it("refuses a by-design-delay answer that cites anything at all", () => {
    // A citation would characterise the window it just declined to
    // characterise (FR-69: not that it is empty, not that it is quiet).
    const violations = structuralViolations(
      {
        kind: "answer",
        prose: "Lo de hoy tarda; lo ultimo firme fue [[2]].",
        references: [2],
        delayed: true,
      },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("cites nothing at all");
  });

  it("refuses a count nothing slots — the spelled-out number (Codex r1)", () => {
    // «Fueron cuatro» carries no digit and no character class can find it.
    // What closes it is the other end: the count's slot must be where the
    // number goes, so the number the owner reads is code's.
    const served = oneCustomer();
    const ref = served.serveCount({
      factType: "QuoteGiven",
      from: null,
      to: null,
      seatId: null,
      seatName: null,
      count: 7,
    });
    const violations = structuralViolations(
      {
        kind: "answer",
        prose: "Fueron cuatro esta semana.",
        references: [ref],
        countRef: ref,
      },
      served,
    );
    expect(violations.join(" ")).toContain("no slot in prose fills it");
  });

  it("refuses a count reference that is not a count", () => {
    const violations = structuralViolations(
      { kind: "answer", prose: "Fueron [[2]].", references: [2], countRef: 2 },
      oneCustomer(),
    );
    expect(violations.join(" ")).toContain("count_ref names a fact");
  });

  it("refuses a count the receipt strip would not carry", () => {
    const served = oneCustomer();
    const ref = served.serveCount({
      factType: "QuoteGiven",
      from: null,
      to: null,
      seatId: null,
      seatName: null,
      count: 4,
    });
    const violations = structuralViolations(
      { kind: "answer", prose: `Fueron [[${ref}]].`, references: [1], countRef: ref },
      served,
    );
    expect(violations.join(" ")).toContain("count_ref is not among");
  });
});

describe("the typed answer's own reading (spec #126 decision 5(d))", () => {
  it("accepts a well-formed grounded answer", () => {
    const parsed = parseOwnerAnswer(
      { kind: "answer", prose: "Lo de [[1]].", references: [1] },
      oneCustomer(),
    );
    expect(parsed).toEqual({
      ok: true,
      submission: { kind: "answer", prose: "Lo de [[1]].", references: [1] },
    });
  });

  it("refuses a kind outside the four", () => {
    const parsed = parseOwnerAnswer(
      { kind: "guess", prose: "x", references: [] },
      oneCustomer(),
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses a refusal with no human follow-up (FR-46's third part)", () => {
    const parsed = parseOwnerAnswer(
      { kind: "refusal", prose: "No puedo.", references: [] },
      oneCustomer(),
    );
    expect(parsed).toEqual({
      ok: false,
      reason:
        "a refusal carries a suggested human follow-up — the refusal, the relevant timeline, and what a person could answer (FR-46)",
    });
  });

  it("refuses references that are not references", () => {
    const parsed = parseOwnerAnswer(
      { kind: "answer", prose: "x", references: ["f-1"] },
      oneCustomer(),
    );
    expect(parsed.ok).toBe(false);
  });

  it("carries the structural violations into the refusal's own reason", () => {
    const parsed = parseOwnerAnswer(
      { kind: "answer", prose: "Fueron 4.", references: [9] },
      oneCustomer(),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("which no tool served this turn");
    expect(parsed.reason).toContain("types a number or a date");
  });
});

/**
 * The daily disclosure's ASSEMBLY (ticket #51; spec #48 decisions 7 and
 * 14): pending disclosure lines in, the post's grouped and numbered shape
 * out.
 *
 * It is tested here rather than at the Postgres seam because the case that
 * matters most — one counterparty with two lines, another's line filed
 * between them — is not reachable through the seam this slice: a binding
 * mints one entity and an entity gets exactly one create line, ever
 * (`disclosure_lines_one_per_entity_create`). Extraction (#52) makes it
 * reachable on day one, and by then the numbering will already be the
 * thing a rep's «N no» resolves through, so it is pinned now.
 */
import { describe, expect, it } from "vitest";
import {
  assembleDisclosureGroups,
  type PendingLine,
} from "./disclosure.js";
import { renderDailyDisclosurePost } from "./grammar.js";

const AT = new Date("2026-08-29T00:53:00.000Z");

function line(id: string, entityId: string, text: string): PendingLine {
  return {
    id,
    subjectKind: "entity_create",
    entityId,
    renderedText: text,
    actAt: AT,
  };
}

const NAMES = new Map([
  ["e1", "Diego Zertuche"],
  ["e2", "Ferretería Fuentes"],
]);

describe("grouping and numbering (spec #48 decision 7 shape D, decision 14)", () => {
  it("numbers the RENDERED order, not the filing order — a day whose counterparties alternate still counts 1, 2, 3 down the page", () => {
    // Filed A, B, A. Numbering as the lines come off the seam would put
    // «1» and «3» under one heading and «2» under the other, and the rep
    // would be reading a page whose numbers do not count.
    const groups = assembleDisclosureGroups(
      [
        line("l1", "e1", "Lo di de alta como cliente."),
        line("l2", "e2", "Lo di de alta como cliente."),
        line("l3", "e1", "Le confirmaste el precio."),
      ],
      NAMES,
    );
    expect(
      groups.map((g) => [g.counterparty, g.lines.map((l) => l.index)]),
    ).toEqual([
      ["Diego Zertuche", [1, 2]],
      ["Ferretería Fuentes", [3]],
    ]);
    // And the recorded numbering names the line printed beside each number.
    expect(
      groups.flatMap((g) =>
        g.lines.map((l) => [l.index, l.disclosureLineId] as const),
      ),
    ).toEqual([
      [1, "l1"],
      [2, "l3"],
      [3, "l2"],
    ]);
  });

  it("the numbers the rep reads are exactly the numbers recorded — render and record walk one array", () => {
    const groups = assembleDisclosureGroups(
      [
        line("l1", "e1", "Lo di de alta como cliente."),
        line("l2", "e2", "Lo di de alta como cliente."),
        line("l3", "e1", "Le confirmaste el precio."),
      ],
      NAMES,
    );
    const post = renderDailyDisclosurePost({
      groups,
      // The two halves the execution composes (spec #193 decision 23): what
      // this suite is about is the NUMBERING code owns around them.
      opening: "fue un día tranquilo",
      closing: "si algo quedó raro contéstame aquí",
      now: new Date("2026-08-30T03:00:00.000Z"),
      timeZone: "America/Monterrey",
    });
    const printed = [...post.matchAll(/^(\d+)\. /gmu)].map((m) => Number(m[1]));
    expect(printed).toEqual(
      groups.flatMap((g) => g.lines.map((l) => l.index)),
    );
    expect(printed).toEqual([1, 2, 3]);
  });

  it("groups in first-appearance order, so the post reads oldest-first the way the day happened", () => {
    const groups = assembleDisclosureGroups(
      [
        line("l1", "e2", "Lo di de alta como cliente."),
        line("l2", "e1", "Lo di de alta como cliente."),
      ],
      NAMES,
    );
    expect(groups.map((g) => g.counterparty)).toEqual([
      "Ferretería Fuentes",
      "Diego Zertuche",
    ]);
  });

  it("refuses a line whose counterparty the mirror does not know — a crossing the twin cannot name is not one to report namelessly (ADR-0004)", () => {
    expect(() =>
      assembleDisclosureGroups(
        [line("l1", "e-unknown", "Lo di de alta como cliente.")],
        NAMES,
      ),
    ).toThrow(/entity mirror does not know/);
  });

  it("groups a fact line under its counterparty and dates it «su chat» — the vocabulary a fact was always going to wear (ticket #52)", () => {
    const saidAt = new Date("2026-08-27T19:23:00Z");
    const groups = assembleDisclosureGroups(
      [
        {
          id: "l1",
          subjectKind: "fact",
          entityId: "e1",
          renderedText: "Le confirmaste que tienes disponible para el sábado.",
          actAt: saidAt,
        },
      ],
      NAMES,
    );
    expect(groups).toEqual([
      {
        // THE ENTITY RIDES ON THE GROUP (ticket #198), so the reference the
        // disclosure execution is served and the name the post renders mean
        // the same customer without a second walk back to the line's row.
        entityId: "e1",
        counterparty: "Diego Zertuche",
        lines: [
          {
            index: 1,
            text: "Le confirmaste que tienes disponible para el sábado.",
            // The rep did not do this in the twin thread — the twin read it
            // in the customer's chat, so it wears «su chat, …» and never
            // «tú lo confirmaste».
            provenance: { kind: "chat", at: saidAt },
            disclosureLineId: "l1",
          },
        ],
      },
    ]);
  });

  it("refuses a line with no instant — a line the twin cannot date is one it cannot honestly place", () => {
    expect(() =>
      assembleDisclosureGroups(
        [
          {
            id: "l1",
            subjectKind: "fact",
            entityId: "e1",
            renderedText: "Le confirmaste el precio.",
            actAt: null,
          },
        ],
        NAMES,
      ),
    ).toThrow(/date by guessing/);
  });
});

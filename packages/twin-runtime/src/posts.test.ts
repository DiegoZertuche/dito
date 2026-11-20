/**
 * THE POST PRIMITIVE'S TWO PURE CLAIMS (ticket #220; spec #214 decision 2):
 * the part union survives the seal, and the closed sets it rests on are the
 * ones the store enforces.
 *
 * Everything a post DOES is behaviour at the Postgres seam and is tested
 * there (`feed.int.test.ts`, and the drafting, thread and disclosure suites
 * whose pinned text is the oracle for what the thread renders). What is left
 * for a unit test is exactly what spec #214's Testing Decisions leave here:
 * "unit tests only for the part union's serialization and the CHECKs" — plus
 * the pairing INSIDE a composer, which is the one claim the seam cannot see:
 * that the parts a post carries account for the bytes it renders to.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createDekFromMaterial } from "@dito/crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { renderBindingQuestion } from "./grammar.js";
import {
  acceptsKnock,
  answerActsOf,
  composeAnswerPost,
  composeBindingQuestionPost,
  composeDisclosurePost,
  composeDraftPost,
  composeReceiptPost,
  insertPost,
  KNOCK_MAX,
  openSealedParts,
  reexpressedParts,
  sealParts,
  PART_KINDS,
  POST_ORIGINS,
  QUESTION_SUBJECTS,
  type PostPart,
} from "./posts.js";

const dek = createDekFromMaterial(randomBytes(32));

/** One part of every kind — the union, written out rather than derived. */
const EVERY_KIND: readonly PostPart[] = [
  { kind: "prose", text: "one line the twin composed" },
  {
    kind: "draft",
    draftId: "11111111-1111-4111-8111-111111111111",
    counterparty: "Sra. Garza",
  },
  {
    kind: "record-lines",
    disclosurePostId: "22222222-2222-4222-8222-222222222222",
    groups: [{ counterparty: "Sra. Garza", indexes: [1, 2] }],
  },
  {
    kind: "question",
    subject: "binding",
    aboutEventId: "7",
    proposedName: "Sra. Garza",
  },
  {
    kind: "ask",
    question: "¿A cuáles de [c4] y [c7] les escribo?",
    mentions: [
      { reference: "c4", name: "Sra. Garza" },
      { reference: "c7", name: "Ferretería Ruiz", entityId: "55555555-5555-4555-8555-555555555555" },
    ],
    fields: [
      {
        name: "customers",
        kind: "pick_many",
        options: [
          { value: "[c4]", label: "Sra. Garza" },
          { value: "[c7]", label: "Ferretería Ruiz" },
        ],
      },
      { name: "when", kind: "date", label: "Para cuándo" },
    ],
  },
  {
    kind: "proposal",
    automationId: "66666666-6666-4666-8666-666666666666",
    name: "Clientes sin contacto",
    sentence: "Cada viernes a las 9 te mando la lista de los que no te han escrito, como [c4].",
    mentions: [{ reference: "c4", name: "Sra. Garza" }],
    when: "Cada viernes a las 09:00",
    plan: [
      { text: "Pensar", depth: 0 },
      { text: "Avisar", depth: 1 },
    ],
    replaces: false,
  },
  { kind: "receipt", text: "Descartado" },
  {
    kind: "curation",
    spotlight: "33333333-3333-4333-8333-333333333333",
    order: [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ],
  },
  {
    kind: "document",
    versionId: "66666666-6666-4666-8666-666666666666",
    title: "Hoteles en Madrid",
    version: 2,
  },
  {
    kind: "data",
    shape: "list",
    rows: [
      { text: "[c4] pide la lista de precios", mentions: [{ reference: "c4", name: "Sra. Garza" }] },
      { text: "Revisar el pedido de la semana" },
    ],
  },
];

/** A knock's fence against a draft's own words — its body and the name it is for (`announcedTextOf`). */
function fenced(draft: { readonly body: string; readonly counterparty: string }, knock: string): boolean {
  return acceptsKnock(knock, `${draft.body}\n${draft.counterparty}`);
}

describe("the part union survives the seal (ADR-0008)", () => {
  it("round-trips every kind, field for field", () => {
    expect(openSealedParts(dek, sealParts(dek, EVERY_KIND))).toEqual(
      EVERY_KIND,
    );
  });

  it("covers every kind the union declares — a seventh cannot slip past this file", () => {
    expect(EVERY_KIND.map((part) => part.kind).sort()).toEqual(
      [...PART_KINDS].sort(),
    );
  });

  it("refuses a sealed document with no version and a list of another shape (#326)", () => {
    expect(() =>
      openSealedParts(dek, sealParts(dek, [{ kind: "document", versionId: randomUUID(), title: "Hoteles" } as unknown as PostPart])),
    ).toThrow(/version/u);
    expect(() =>
      openSealedParts(dek, sealParts(dek, [{ kind: "data", shape: "table", rows: [] } as unknown as PostPart])),
    ).toThrow(/horizon/u);
  });

  it("refuses a sealed curation whose spotlight is outside its order (#266)", () => {
    const broken = sealParts(dek, [
      {
        kind: "curation",
        spotlight: "33333333-3333-4333-8333-333333333333",
        order: ["44444444-4444-4444-8444-444444444444"],
      },
    ]);
    expect(() => openSealedParts(dek, broken)).toThrow(/spotlight/);
  });

  it("an absent optional field stays absent (ADR-0034: never a default)", () => {
    // A pre-#220 draft post has no counterparty recorded, because nothing
    // recorded it then. The seal must not invent one,
    // and must not turn "not recorded" into an explicit null a renderer
    // would print.
    const bare: readonly PostPart[] = [
      { kind: "draft", draftId: randomUUID() },
    ];
    const opened = openSealedParts(dek, sealParts(dek, bare));
    expect(opened).toEqual(bare);
    expect(Object.hasOwn(opened[0]!, "counterparty")).toBe(false);
  });

  it("seals the parts — a prose part's own words are not in the bytes", () => {
    const sealed = sealParts(dek, [
      { kind: "prose", text: "un secreto del rep" },
    ]);
    expect(sealed.toString("utf8")).not.toContain("secreto");
  });

  it("refuses a part kind nothing declares, loudly", () => {
    // The reachable shape: a bundle or a database restored from a build that
    // knew a seventh kind. A renderer handed one would either drop it silently
    // — a post the rep is shown with a piece missing — or print an object.
    const smuggled = Buffer.from(
      dek.encrypt(Buffer.from(JSON.stringify([{ kind: "chart", rows: [] }]), "utf8")),
    );
    expect(() => openSealedParts(dek, smuggled)).toThrow(/chart/u);
  });

  it("refuses parts that are not a list, and a list that is empty", () => {
    const notAList = Buffer.from(
      dek.encrypt(Buffer.from(JSON.stringify({ kind: "prose" }), "utf8")),
    );
    expect(() => openSealedParts(dek, notAList)).toThrow(/ordered list/u);
    const empty = Buffer.from(dek.encrypt(Buffer.from("[]", "utf8")));
    expect(() => openSealedParts(dek, empty)).toThrow(/no parts/u);
  });

  it("refuses a part missing the field its kind is about", () => {
    const noDraft = Buffer.from(
      dek.encrypt(Buffer.from(JSON.stringify([{ kind: "draft" }]), "utf8")),
    );
    expect(() => openSealedParts(dek, noDraft)).toThrow(/draftId/u);
  });

  it("refuses a record-lines heading with no name or no numbers under it", () => {
    // A heading with nothing under it is not one the post printed, and a
    // group with no name would attribute a retractable claim to nothing.
    const seal = (groups: unknown): Buffer =>
      Buffer.from(
        dek.encrypt(
          Buffer.from(
            JSON.stringify([
              {
                kind: "record-lines",
                disclosurePostId: "22222222-2222-4222-8222-222222222222",
                groups,
              },
            ]),
            "utf8",
          ),
        ),
      );
    expect(() =>
      openSealedParts(dek, seal([{ counterparty: "Sra. Garza", indexes: [] }])),
    ).toThrow(/no line numbers/u);
    expect(() => openSealedParts(dek, seal([{ indexes: [1] }]))).toThrow(
      /counterparty/u,
    );
    expect(() => openSealedParts(dek, seal("Sra. Garza"))).toThrow(
      /counterparty headings/u,
    );
  });
});

/**
 * THE COMPOSERS' OWN BYTES, PINNED — and pinned against LITERALS, not against
 * the renderers, because a test that recomputed the expectation the way the
 * code does would pass by construction. Every literal here is the text
 * `grammar.test.ts` pins one level down.
 *
 * WHAT EACH CASE ALSO ASSERTS is that the parts ACCOUNT for those bytes: every
 * content-bearing field a part carries appears in the rendering, and every
 * part the rendering shows is one the parts hold. That pairing lives inside a
 * composer, so a test that only checked the text would leave it unproven.
 */
describe("a composer's parts and its bytes are one value", () => {
  it("the Borrador — the twin's sentence above Mock A, from the prose and the draft's own part", () => {
    const draftId = "33333333-3333-4333-8333-333333333333";
    const composed = composeDraftPost({
      draftId,
      words: "Te dejé la respuesta a [c4]: ayer preguntó disponibilidad y quedó sin respuesta.",
      mentions: [{ reference: "c4", name: "Sra. Garza" }],
      counterparty: "Sra. Garza",
      body: "Sí le tengo las 40 cajas para el jueves. ¿Se las aparto?",
    });
    expect(composed.text).toBe(
      `✳️ Te dejé la respuesta a Sra. Garza: ayer preguntó disponibilidad y quedó sin respuesta.

*Borrador — para Sra. Garza*

«Sí le tengo las 40 cajas para el jueves. ¿Se las aparto?»

Para enviarlo, responde a este mensaje citándolo con «va».`,
    );
    expect(composed.parts).toEqual([
      {
        kind: "prose",
        text: "Te dejé la respuesta a [c4]: ayer preguntó disponibilidad y quedó sin respuesta.",
        mentions: [{ reference: "c4", name: "Sra. Garza" }],
      },
      { kind: "draft", draftId, counterparty: "Sra. Garza" },
    ]);
  });

  it("a draft the twin said nothing of carries no prose part, and its frame opens the post", () => {
    const draftId = "33333333-3333-4333-8333-333333333333";
    const composed = composeDraftPost({ draftId, words: "  ", counterparty: "Sra. Garza", body: "claro" });
    expect(composed.parts).toEqual([{ kind: "draft", draftId, counterparty: "Sra. Garza" }]);
    expect(composed.text.startsWith("✳️ *Borrador — para Sra. Garza*")).toBe(true);
  });

  it("the binding question, asked bare by code and composed by an execution", () => {
    const bare = composeBindingQuestionPost({
      aboutEventId: "7",
      proposedName: "Sra. Garza",
    });
    expect(bare.text).toBe(
      `✳️ ¿Este chat es de Sra. Garza?

Para confirmarlo, responde a este mensaje citándolo con «si».`,
    );
    expect(bare.parts).toEqual([
      {
        kind: "question",
        subject: "binding",
        aboutEventId: "7",
        proposedName: "Sra. Garza",
      },
    ]);
    // THE NAME IS THE RAIL'S AND THE SENTENCE IS THE TWIN'S (ADR-0037): the
    // slot is folded by code, so the rep is asked about the name the rail
    // supplied whatever the submission wrote.
    const composed = composeBindingQuestionPost({
      aboutEventId: "7",
      proposedName: "Sra. Garza",
      sentence: "¿este chat es el de {name}?",
    });
    expect(composed.text).toBe(
      `✳️ ¿este chat es el de Sra. Garza?

Para confirmarlo, responde a este mensaje citándolo con «si».`,
    );
    // ...AND THE COMPOSED SENTENCE RIDES IN THE PARTS (Codex r2), the same
    // string the rendering carries. Two different questions about one chat
    // sealed identically before this: the words were readable in the thread
    // and gone from every other surface.
    expect(composed.parts).toEqual([
      { kind: "prose", text: "¿este chat es el de Sra. Garza?" },
      ...bare.parts,
    ]);
    const other = composeBindingQuestionPost({
      aboutEventId: "7",
      proposedName: "Sra. Garza",
      sentence: "oye, {name} es de este chat?",
    });
    expect(other.parts).not.toEqual(composed.parts);
  });

  it("the answer post keeps the twin's references and seals what they named; the phone reads names (ticket #321)", () => {
    const mentions = [
      { reference: "c7", name: "Sra. Garza", entityId: "E-7" },
      { reference: "c8", name: "Torres", tails: ["8416", "0537"], entityId: "E-8" },
    ];
    const composed = composeAnswerPost({
      answer: "[c7] y [c8] te pidieron lo mismo.",
      mentions,
    });
    expect(composed.parts).toEqual([
      { kind: "prose", text: "[c7] y [c8] te pidieron lo mismo.", mentions },
    ]);
    expect(composed.text).toBe("✳️ Sra. Garza y Torres (…8416, …0537) te pidieron lo mismo.");
    // SEALED AND OPENED WHOLE: every surface renders from what the post holds.
    expect(openSealedParts(dek, sealParts(dek, composed.parts))).toEqual(composed.parts);
  });

  it("a receipt post: the sentence in the part, the frame on the post", () => {
    const composed = composeReceiptPost("Descartado");
    expect(composed.text).toBe("✳️ Descartado");
    expect(composed.parts).toEqual([{ kind: "receipt", text: "Descartado" }]);
  });

  it("the answer post: what the tool did, what the twin said, what it asks", () => {
    const acted = composeAnswerPost({
      answer: "ya no le mando nada",
      mentions: [],
      receipt: "Descartado",
    });
    expect(acted.text).toBe(`✳️ Descartado

ya no le mando nada`);
    expect(acted.parts).toEqual([
      { kind: "receipt", text: "Descartado" },
      { kind: "prose", text: "ya no le mando nada" },
    ]);

    // THE RECEIPTS-ARE-CODE RULE, SEEN FROM THE PART (ADR-0037): the same
    // prose with no tool behind it composes NO receipt part, so a line
    // cannot smuggle one in by describing an effect.
    const claimed = composeAnswerPost({
      answer: "listo, lo descarté",
      mentions: [],
    });
    expect(claimed.parts).toEqual([
      { kind: "prose", text: "listo, lo descarté" },
    ]);
    expect(claimed.text).toBe("✳️ listo, lo descarté");

    // ...and the question the same post asks, when the turn handed the rep
    // one and CODE found it due: the twin's sentence after the reply with the
    // name folded in, the taught line last, and the binding question's own
    // parts after the reply's.
    const asking = composeAnswerPost({
      answer: "le pidió 40 cajas.",
      mentions: [],
      binding: { aboutEventId: "9", proposedName: "Sra. Garza", sentence: "¿Este chat es de {name}?" },
    });
    expect(asking.text).toBe(
      `✳️ le pidió 40 cajas.

¿Este chat es de Sra. Garza?

Para confirmarlo, responde a este mensaje citándolo con «si».`,
    );
    expect(asking.parts).toEqual([
      { kind: "prose", text: "le pidió 40 cajas." },
      { kind: "prose", text: "¿Este chat es de Sra. Garza?" },
      { kind: "question", subject: "binding", aboutEventId: "9", proposedName: "Sra. Garza" },
    ]);
  });

  it("a draft post carries no knock: the twin knocks with its tool, on the post's id (#358)", () => {
    const composed = composeDraftPost({
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Sra. Garza",
      body: "Sí le tengo las 40 cajas para el jueves. ¿Se las aparto?",
      words: "ayer preguntó disponibilidad y quedó sin respuesta",
    });
    expect(composed.parts.map((part) => part.kind)).toEqual(["prose", "draft"]);
  });

  it("refuses a knock that carries a link or outruns the lock screen (#262)", () => {
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Sra. Garza",
      body: "Sí le tengo las 40 cajas.",
      words: "preguntó disponibilidad",
    };
    // THE LINK IS CODE'S, so a sentence carrying one is refused.
    expect(fenced(args, "Ábrelo en https://otro.example/entrar")).toBe(false);
    expect(fenced(args, "pasa a tablero.dito.mx")).toBe(false);
    expect(fenced(args, "a".repeat(KNOCK_MAX + 1))).toBe(false);
    expect(acceptsKnock("a".repeat(KNOCK_MAX), args.body)).toBe(true);
    expect(acceptsKnock("dos\nlíneas", args.body)).toBe(false);
    expect(acceptsKnock("   ", args.body)).toBe(false);
  });

  it("refuses a knock carrying a number the post does not (#276)", () => {
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Sra. Garza",
      body: "Sí le tengo las 40 cajas, le salen en 1,500 pesos.",
      words: "preguntó disponibilidad",
    };
    // A LOCK SCREEN IS READ AT A GLANCE AND ACTED ON, so a quantity the draft
    // does not carry is the one kind of wrongness the rep cannot see is wrong
    // (ADR-0037: the twin never types a number of its own).
    expect(fenced(args, "Garza te debe 987654 pesos.")).toBe(false);
    // ...and a number the draft DOES carry passes, however the sentence spells
    // it: «1500» against a draft that wrote «1,500» is the same number.
    expect(fenced(args, "Le pasé las 40 cajas en 1500.")).toBe(true);
  });

  it("grounds a whole digit run and never a piece of one (#276)", () => {
    // A SUBSTRING IS NOT A NUMBER (Codex round 2 on PR #275). «25» inside
    // «125» and «5» inside «1500» are not quantities the post carries, and a
    // probe put an invented one on a lock screen through exactly that gap — so
    // what is compared is the SET of whole runs the announced text holds.
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Sra. Garza",
      body: "Le mandé las 125 cajas y le salen en 1,500 pesos.",
      words: "preguntó disponibilidad",
    };
    expect(
      fenced(args, "Le aparté 25 cajas."),
    ).toBe(false);
    // THE SEPARATOR STRIPPING STAYS, because a rendering that grouped the
    // thousands and a sentence that did not are the same number.
    expect(
      fenced(args, "Le salen en 1500."),
    ).toBe(true);
    // ...and the raw text's own runs stay grounded, which is what makes the
    // stripping a widening rather than a replacement.
    expect(
      fenced(args, "Le salen en 500 de anticipo."),
    ).toBe(true);
  });

  it("never merges two numbers across a gap that is not thousands grouping (Codex r2)", () => {
    // A SEPARATOR IS GROUPING OR IT IS NOTHING. Stripping every space between
    // digits merged across the line that joins the body to the name — a body
    // ending «12» and a customer called «24 Horas» grounded an invented
    // «1224» — and merged inside one line too. Grouping is a dot, a comma or
    // one space before exactly three digits; everything else is a boundary.
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "24 Horas",
      body: "Le mandé las 12",
      words: "preguntó disponibilidad",
    };
    expect(
      fenced(args, "Garza te debe 1224 pesos."),
    ).toBe(false);
    expect(
      fenced({ ...args, counterparty: "Sra. Garza", body: "Le mandé 12 cajas y 24 bolsas." }, "Le mandé 1224 piezas."),
    ).toBe(false);
    // ...and each number on its own is still the post's own.
    expect(
      fenced(args, "Lo de 24 Horas quedó en 12."),
    ).toBe(true);
  });

  it("grounds a grouped number written either way round (Codex r2)", () => {
    // THE NORMALISATION IS ON BOTH SIDES OR IT IS A FALSE REFUSAL. A draft
    // that wrote «1500» and a sentence that wrote «1,500» are the same
    // number, and dropping that knock costs the rep the push for a draft that
    // really is waiting.
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Sra. Garza",
      words: "preguntó disponibilidad",
    };
    expect(
      fenced({ ...args, body: "Le salen en 1500 pesos." }, "Le salen en 1,500."),
    ).toBe(true);
    expect(
      fenced({ ...args, body: "Le salen en 1,500 pesos." }, "Le salen en 1500."),
    ).toBe(true);
    // ...and a piece of a number is still not the number.
    expect(
      fenced({ ...args, body: "Le mandé las 125 cajas." }, "Le aparté 25 cajas."),
    ).toBe(false);
  });

  it("never reads a decimal point as grouping (Codex r3)", () => {
    // A PERIOD BETWEEN DIGITS IS A DECIMAL POINT in es-MX, never a thousands
    // separator — and undoing it merged «1,234.567» into «1234567», putting
    // an amount a thousand times larger on a lock screen with the post's own
    // blessing. The comma and the space group; the point divides.
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Sra. Garza",
      words: "preguntó disponibilidad",
    };
    expect(
      fenced({ ...args, body: "Le salen en 1,234.567 pesos." }, "Le salen en 1234567 pesos."),
    ).toBe(false);
    // ...and the same the other way round, where the point comes first.
    expect(
      fenced({ ...args, body: "Le salen en 1.234,567 pesos." }, "Le salen en 1234567 pesos."),
    ).toBe(false);
    // THE INTEGER PART IS STILL THE POST'S OWN NUMBER, which is what keeps
    // this a boundary rather than a wall.
    expect(
      fenced({ ...args, body: "Le salen en 1,234.567 pesos." }, "Le salen en 1234 y fracción."),
    ).toBe(true);
  });

  it("grounds a knock against the name the post carries, not the body alone (#276)", () => {
    // THE ORDINARY KNOCK NAMES THE COUNTERPARTY — the submission schema asks
    // for what the draft is about and who it is for — and an ordinary Mexican
    // customer's name carries digits. «Farmacia 24» is not in the body, so a
    // body-only fence would refuse a knock the model wrote correctly and cost
    // the rep the push for a draft that really is waiting. The name is the
    // POST's own text: it comes off the rail's push name or a confirmed
    // binding, never out of the model.
    const args = {
      draftId: "33333333-3333-4333-8333-333333333333",
      counterparty: "Farmacia 24",
      body: "Sí le tengo las cajas para el jueves.",
      words: "preguntó disponibilidad",
    };
    expect(fenced(args, "Te dejé listo lo de Farmacia 24.")).toBe(true);
    // ...and a run in NEITHER the body nor the name is still refused, which is
    // the half the widening must not cost.
    expect(
      fenced(args, "Farmacia 24 te debe 987654 pesos."),
    ).toBe(false);
  });

  it("carries no knock of its own, whether it answers or asks (#262, #363)", () => {
    // THE THREAD KNOCKS WITH ITS TOOL AND NOWHERE ELSE (ADR-0031 as amended):
    // a reply is read at the door the rep asked at, and a question is the
    // thread's to announce on a turn of its own.
    const answering = { answer: "le pidió 40 cajas", mentions: [] };
    for (const post of [composeAnswerPost(answering), composeAnswerPost({
      ...answering,
      binding: { aboutEventId: "9", proposedName: "Sra. Garza", sentence: "¿Es de {name}?" },
    })]) {
      expect(post.parts.map((part) => part.kind)).not.toContain("knock");
    }
  });

  it("the day's post: the twin's two sentences around a reference to the sealed lines", () => {
    const disclosurePostId = "44444444-4444-4444-8444-444444444444";
    const composed = composeDisclosurePost({
      disclosurePostId,
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              provenance: {
                kind: "rep_act",
                at: new Date("2026-08-29T00:53:00.000Z"),
              },
            },
          ],
        },
      ],
      opening: "fue un día tranquilo, casi todo de un solo cliente",
      closing: "si algo quedó mal respóndeme aquí citando este mensaje y dime cuál",
      now: new Date("2026-08-30T03:00:00.000Z"),
      timeZone: "America/Monterrey",
    });
    expect(composed.text).toBe(
      `✳️ *Hoy agregué 1 dato al registro.*

fue un día tranquilo, casi todo de un solo cliente

*Diego Zertuche*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

si algo quedó mal respóndeme aquí citando este mensaje y dime cuál`,
    );
    // THE LINES ARE A REFERENCE AND NOT A COPY (ADR-0034): the heading's
    // count and the numbered block are code's, rendered from the day's own
    // rows, and the part names the post whose numbering the seal holds.
    expect(composed.parts).toEqual([
      { kind: "prose", text: "fue un día tranquilo, casi todo de un solo cliente" },
      {
        kind: "record-lines",
        disclosurePostId,
        // THE HEADING THE POST PRINTED, sealed with the part: a name resolved
        // later could be one a rename gave the customer after the rep read
        // this (`RecordLineGroup`).
        groups: [{ counterparty: "Diego Zertuche", indexes: [1] }],
      },
      {
        kind: "prose",
        text: "si algo quedó mal respóndeme aquí citando este mensaje y dime cuál",
      },
    ]);
  });

  it("the day's post over TWO customers: each heading over its own numbers", () => {
    // Codex r2's own next step. The numbering is CONTINUOUS across the post
    // (spec #48 decision 14) while the headings partition it, so a card that
    // resolved attribution by counting blocks would attribute the wrong
    // claims the moment a day has two customers.
    const disclosurePostId = "55555555-5555-4555-8555-555555555555";
    const at = new Date("2026-08-29T00:53:00.000Z");
    const composed = composeDisclosurePost({
      disclosurePostId,
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              provenance: { kind: "rep_act", at },
            },
            {
              index: 2,
              text: "Te pidió 20 bultos — sin precio, sin fecha.",
              provenance: { kind: "chat", at },
            },
          ],
        },
        {
          counterparty: "Sra. Garza",
          lines: [
            {
              index: 3,
              text: "Le cotizaste 40 cajas en 4,500 MXN — sin fecha.",
              provenance: { kind: "chat", at },
            },
          ],
        },
      ],
      opening: "un día de dos clientes",
      closing: "dime si algo quedó mal",
      now: new Date("2026-08-30T03:00:00.000Z"),
      timeZone: "America/Monterrey",
    });
    expect(composed.text).toBe(
      `✳️ *Hoy agregué 3 datos al registro.*

un día de dos clientes

*Diego Zertuche*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)
2. Te pidió 20 bultos — sin precio, sin fecha. (su chat, ayer 18:53)

*Sra. Garza*
3. Le cotizaste 40 cajas en 4,500 MXN — sin fecha. (su chat, ayer 18:53)

dime si algo quedó mal`,
    );
    expect(composed.parts[1]).toEqual({
      kind: "record-lines",
      disclosurePostId,
      groups: [
        { counterparty: "Diego Zertuche", indexes: [1, 2] },
        { counterparty: "Sra. Garza", indexes: [3] },
      ],
    });
  });

  it("refuses a post asking two questions — one act answers one ask", async () => {
    await expect(
      insertPost(neverReached, {
        twinId: "t",
        dek,
        parts: [
          { kind: "question", subject: "binding", aboutEventId: "1" },
          { kind: "question", subject: "binding", aboutEventId: "2" },
        ],
        delivery: { noticeId: "n" },
      }),
    ).rejects.toThrow(/asking 2 questions/u);
  });

  it("refuses a post with no parts at all", async () => {
    await expect(
      insertPost(neverReached, {
        twinId: "t",
        dek,
        parts: [],
        delivery: { noticeId: "n" },
      }),
    ).rejects.toThrow(/no parts/u);
  });
});

/**
 * A connection that fails the test if it is reached: both refusals above are
 * decided before any statement is issued, and a stub that ANSWERED a query
 * would let a regression that moved the guard after the INSERT pass.
 */
const neverReached = {
  query: (): never => {
    throw new Error(
      "a refused post reached the database — the guard runs before the INSERT (ticket #220)",
    );
  },
} as unknown as pg.ClientBase;

/**
 * THE RE-EXPRESSION IS A PURE FUNCTION, and this is where its classification
 * is pinned (Codex r3). A retired notice kind's posts ride forward by design —
 * #218 narrowed `notices_kind_check` `NOT VALID` so the ones a rep had already
 * read would keep their rows (ADR-0034) — and the seam CANNOT plant one,
 * because that CHECK refuses the INSERT. So the claim is made here, over the
 * derivation itself, rather than left to a fixture the store forbids.
 */
describe("what a post written before parts existed is read back as", () => {
  const frozen = "✳️ unas palabras";
  /**
   * The instruction paragraph, taken off the thread's own renderer rather than
   * restated: the renderer folds in whichever word the affirmation class
   * teaches, and a literal here would be a second copy of a sentence that
   * moved once already.
   */
  const BINDING_INSTRUCTION = renderBindingQuestion("X")
    .split("\n\n")
    .slice(-1)[0]!;
  const legacy = (
    noticeKind: string | null,
    extra: Record<string, unknown> = {},
  ): readonly PostPart[] =>
    reexpressedParts({
      postId: "77777777-7777-4777-8777-777777777777",
      draftId: null,
      noticeKind,
      aboutEventId: "7",
      disclosurePostId: null,
      frozenText: frozen,
      ...extra,
    });

  it("a draft is a draft, and its body comes off its own row", () => {
    expect(
      legacy(null, { draftId: "11111111-1111-4111-8111-111111111111" }),
    ).toEqual([
      { kind: "draft", draftId: "11111111-1111-4111-8111-111111111111" },
    ]);
  });

  it("the day's post is a reference to its sealed numbering, and nothing else", () => {
    // Its composed opening and closing were never recorded as parts, and the
    // frozen rendering CARRIES the numbered lines — so putting it beside the
    // reference would print every claim twice on one card, and put a thread
    // instruction on a surface that has buttons instead (story 33).
    expect(
      legacy("daily_disclosure", {
        disclosurePostId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual([
      {
        kind: "record-lines",
        disclosurePostId: "22222222-2222-4222-8222-222222222222",
      },
    ]);
  });

  it("a binding question keeps its words, because its part carries none", () => {
    expect(legacy("binding_question")).toEqual([
      { kind: "prose", text: "unas palabras" },
      { kind: "question", subject: "binding", aboutEventId: "7" },
    ]);
  });

  it("drops the instruction line from a question, and keeps every word beside it", () => {
    // CODEX r3, A REACHABLE FAILURE. The frozen text of a binding question is
    // the whole THREAD rendering, and it ends by telling the rep to reply
    // quoting the message with the word. The dashboard offers two buttons for
    // that act, so the sentence is false the moment it is read there — and
    // ADR-0037 retires the instruction line on this surface outright.
    //
    // THE ORACLE IS THE THREAD'S OWN RENDERER, so this cannot drift into
    // agreeing with a sentence nobody writes: the fixture IS what a rep read.
    const asked = renderBindingQuestion("Refacciones RS");
    const parts = legacy("binding_question", { frozenText: asked });
    expect(parts).toEqual([
      { kind: "prose", text: "¿Este chat es de Refacciones RS?" },
      { kind: "question", subject: "binding", aboutEventId: "7" },
    ]);
    // ...AND NOT BY TRUSTING THE ASSERTION ABOVE TO NOTICE. The instruction is
    // gone from the whole part list, whatever else it carried.
    expect(JSON.stringify(parts)).not.toContain("citándolo");
  });

  it("keeps the twin's own paragraphs when the question rode inside an answer", () => {
    // #195 folds an ask into a whole answer post, so the frozen text can be
    // several paragraphs with the instruction last. Everything the twin SAID
    // survives — this drops chrome and never content.
    const said = "Ya le mandé el precio.\n\nUna cosa más.";
    const parts = legacy("binding_question", {
      frozenText: `${said}\n\n${BINDING_INSTRUCTION}`,
    });
    expect(parts[0]).toEqual({ kind: "prose", text: said });
  });

  it("is the question alone when the instruction was all there was", () => {
    // An empty prose part would draw a blank line above the buttons; the card
    // renders its own chrome from the subject when no words ride beside it.
    expect(
      legacy("binding_question", { frozenText: BINDING_INSTRUCTION }),
    ).toEqual([{ kind: "question", subject: "binding", aboutEventId: "7" }]);
  });

  it("the six acknowledgement kinds are receipts, and the answer is prose", () => {
    for (const kind of [
      "send_confirmation",
      "affirmation_refusal",
      "dismissal_ack",
      "binding_ack",
      "correction_ack",
      "correction_refusal",
    ]) {
      expect(legacy(kind), kind).toEqual([
        { kind: "receipt", text: "unas palabras" },
      ]);
    }
    expect(legacy("answer")).toEqual([
      { kind: "prose", text: "unas palabras" },
    ]);
  });

  it("a RETIRED kind is never a receipt — a receipt claims code did something", () => {
    // `aperture_question` left the closed set at #218 and its posts ride
    // forward. A model-composed ask read back as a receipt would be a card
    // telling the rep that code performed an effect it never performed
    // (ADR-0013, ADR-0037). Prose is the fail-safe reading, and it is the
    // reading any future retirement gets too.
    for (const kind of ["aperture_question", "something_later", null]) {
      expect(legacy(kind), String(kind)).toEqual([
        { kind: "prose", text: "unas palabras" },
      ]);
    }
  });

  it("refuses a delivery row with no words to read it back through", () => {
    expect(() => legacy("answer", { frozenText: undefined })).toThrow(
      /no words in it/u,
    );
  });
});

describe("the closed sets a post rests on", () => {
  it("the binding question is 6a's one subject kind, and names confirm and decline", () => {
    expect(Object.keys(QUESTION_SUBJECTS)).toEqual(["binding"]);
    expect(QUESTION_SUBJECTS.binding).toEqual(["confirm", "decline"]);
  });

  it("names the answer acts every part kind offers a surface", () => {
    // The literal table, so a part that quietly gained or lost an act is a
    // failure here rather than a button the dashboard does or does not draw.
    expect(EVERY_KIND.map((part) => [part.kind, answerActsOf(part)])).toEqual([
      ["prose", []],
      ["draft", ["tap", "dismiss"]],
      ["record-lines", ["retract"]],
      ["question", ["confirm", "decline"]],
      // THE RUN'S QUESTION: one typed answer, while the run waits on it (#324).
      ["ask", ["answer"]],
      // A RUTINA'S PROPOSAL: Activar or Descartar, while it waits (#386).
      ["proposal", ["activate", "discard"]],
      ["receipt", []],
      // THE CURATION IS LAYOUT: the acts are its cards' own (#266).
      ["curation", []],
      // A DOCUMENT AND A LIST ARE READ: opening a document answers nothing
      // (#326) — and «Listo» takes the card off the canvas (#368).
      ["document", ["clear"]],
      ["data", ["clear"]],
    ]);
  });

  it("a post's parts are either composed by this build or re-expressed from a row that predates them", () => {
    expect([...POST_ORIGINS]).toEqual(["composed", "reexpressed"]);
  });

  it("a post a build before ticket #358 sealed with a knock part opens without it: every knock is a `post_knocks` row", () => {
    const sealed = dek.encrypt(
      Buffer.from(JSON.stringify([{ kind: "prose", text: "Listo." }, { kind: "knock", text: "Te dejé listo lo de Garza." }]), "utf8"),
    );
    expect(openSealedParts(dek, sealed)).toEqual([{ kind: "prose", text: "Listo." }]);
  });

  it("a post sealed with a run part opens without it: a card says where it came from only in the twin's words (ticket #399)", () => {
    const draft = EVERY_KIND.find((part) => part.kind === "draft")!;
    const sealed = dek.encrypt(
      Buffer.from(
        JSON.stringify([
          { kind: "run", name: "Seguimiento a [c7]", mentions: [{ reference: "c7", name: "Sra. Garza" }], pass: 2, passes: 3 },
          { kind: "prose", text: "Te dejé el seguimiento a Garza." },
          draft,
        ]),
        "utf8",
      ),
    );
    expect(openSealedParts(dek, sealed)).toEqual([{ kind: "prose", text: "Te dejé el seguimiento a Garza." }, draft]);
  });
});

/**
 * The twin-thread grammar (ticket #30; spec #29 grilling decision 4):
 * every twin-authored post renders through this one point and opens with
 * the ✳️ frame. The Mock A fixture below is decision-encoding — it is the
 * grilling's recorded decision, rendered exactly.
 */
import type { CandidateReading } from "@dito/aperture";
import { describe, expect, it } from "vitest";
import { AFFIRMATIONS } from "./affirmation.js";
import {
  assertFramed,
  NAME_SLOT,
  counterpartyDisplayName,
  counterpartyName,
  renderAnswerPost,
  renderBindingAck,
  renderBindingQuestion,
  renderComposedBindingQuestion,
  renderDailyDisclosurePost,
  renderFactDisclosureLine,
  renderCorrectionAck,
  renderCorrectionRefusal,
  renderDismissAck,
  renderReceiptPost,
  RECEIPTS,
  renderDraftPost,
  renderRefusalNotice,
  renderSendConfirmation,
} from "./grammar.js";

/**
 * The Mock A grammar block (#29/#30) with the twin's own sentence above the
 * frame (ticket #368): the words the drafting turn ended on, then the label
 * and counterparty, the guillemet body and the instruction line.
 */
const MOCK_A = `✳️ Te dejé la respuesta a la Sra. Garza: ayer preguntó por las 40 cajas y quedó sin respuesta.

*Borrador — para Sra. Garza*

«Sí le tengo las 40 cajas para el jueves. ¿Se las aparto?»

Para enviarlo, responde a este mensaje citándolo con «va».`;

describe("the draft post (Mock A)", () => {
  it("renders the twin's sentence above the frame — label, counterparty, guillemet body, instruction line", () => {
    const post = renderDraftPost({
      said: "Te dejé la respuesta a la Sra. Garza: ayer preguntó por las 40 cajas y quedó sin respuesta.",
      counterparty: "Sra. Garza",
      body: "Sí le tengo las 40 cajas para el jueves. ¿Se las aparto?",
    });
    expect(post).toBe(MOCK_A);
  });

  it("with no words from the twin the frame opens the post, and no «Porque:» line is left", () => {
    const post = renderDraftPost({
      said: "",
      counterparty: "Sra. Garza",
      body: "claro que sí",
    });
    expect(post).toBe(
      "✳️ *Borrador — para Sra. Garza*\n\n«claro que sí»\n\n" +
        "Para enviarlo, responde a este mensaje citándolo con «va».",
    );
    expect(post).not.toContain("Porque:");
  });

  it("every draft post opens with the ✳️ frame", () => {
    const post = renderDraftPost({
      said: "y",
      counterparty: "5215550001",
      body: "x",
    });
    expect(post.startsWith("✳️ ")).toBe(true);
  });
});

describe("the counterparty line's name (provisional style — bindings upgrade it later in the slice)", () => {
  it("uses the sender push-name when the payload carries one", () => {
    expect(
      counterpartyDisplayName("Sra. Garza", "5215550001@s.whatsapp.net"),
    ).toBe("Sra. Garza");
  });

  it("falls back to the number when the push-name is absent", () => {
    expect(counterpartyDisplayName(undefined, "5215550001@s.whatsapp.net")).toBe(
      "5215550001",
    );
  });
});

describe("companion posts inherit the frame (spec #29 story 9)", () => {
  it("the send confirmation: «✳️ Enviado a {cliente} ✓»", () => {
    expect(renderSendConfirmation("Sra. Garza")).toBe(
      "✳️ Enviado a Sra. Garza ✓",
    );
  });

  it("every refusal notice opens with the frame around its microcopy", () => {
    expect(renderRefusalNotice("already_tapped")).toBe("✳️ ya se envió");
  });

  it("the dismiss ack is exactly «Descartado», framed", () => {
    expect(renderDismissAck()).toBe("✳️ Descartado");
  });
});

/**
 * THE RECEIPTS, PINNED (ticket #174; ADR-0037 as amended — "receipts and
 * frame labels are the rep side's chrome").
 *
 * A receipt reports what code DID, so every one of them is a constant here
 * and none is composed. What this file pins is the BYTES: the two that
 * existed before this ticket render exactly what they rendered, so a rep who
 * dismissed a draft yesterday reads the same word today, and the three that
 * are new read in the same voice — one line, no ceremony, no apology, and
 * no promise about anything that did not happen.
 */
describe("the receipts a rep-act tool renders from its own result", () => {
  it("keeps the two that existed byte-for-byte", () => {
    expect(RECEIPTS.dismissed).toBe("Descartado");
    expect(RECEIPTS.retracted(3)).toBe(
      "Listo, marqué el dato 3 como incorrecto.",
    );
    // ...and the framed form is the same string with the frame on it, which
    // is what makes the stand-alone post and the folded line one sentence.
    expect(renderDismissAck()).toBe(renderReceiptPost(RECEIPTS.dismissed));
    expect(renderCorrectionAck(3)).toBe(
      renderReceiptPost(RECEIPTS.retracted(3)),
    );
  });

  it("names the line back, because the rep addressed it by a number", () => {
    // The whole risk an indexed target carries: the rep said which line in
    // their own words, so reading the number back is how they see which one
    // the twin resolved.
    expect(RECEIPTS.retracted(1)).toContain(" 1 ");
    expect(RECEIPTS.retracted(12)).toContain(" 12 ");
  });

  it("gives the act that had none a line of its own", () => {
    // A DECLINED BINDING SAID NOTHING before #174 — the rep answered and
    // read silence. Two of the three acts #174 gave a line to were the
    // aperture question's, and they left with the route at #218.
    expect(RECEIPTS.bindingDeclined).toBe(
      "Entendido, este chat sigue sin confirmar.",
    );
  });

  it("renders a refusal from the total record rather than from a sentence", () => {
    // Total over `CorrectionRefusalReason`, so a reason added on the far
    // side of the wall reaches the rep through a typecheck rather than
    // through somebody remembering.
    expect(RECEIPTS.correctionRefused("unknown_line")).toBe(
      "no encontré ese dato en este mensaje",
    );
    expect(renderCorrectionRefusal("window_closed")).toBe(
      renderReceiptPost(RECEIPTS.correctionRefused("window_closed")),
    );
  });

  it("folds into the composed reply above the twin's own words", () => {
    // ONE POST PER TURN (spec #171 decision 22): what the twin DID, then
    // what it says about it. The receipt is a parameter, so a model that
    // wrote the same sentence into `answer` changes nothing about what is
    // rendered here.
    expect(
      renderAnswerPost({
        answer: "Ya no le escribo.",
        receipt: RECEIPTS.dismissed,
      }),
    ).toBe("✳️ Descartado\n\nYa no le escribo.");
  });

  it("renders nothing extra when no tool acted", () => {
    // THE CASE THE DESIGN EXISTS FOR, at the renderer: an answer with no
    // receipt is exactly the answer, so a turn whose prose merely CLAIMED
    // an effect looks like every other reply.
    expect(
      renderAnswerPost({ answer: "Listo, lo descarté." }),
    ).toBe("✳️ Listo, lo descarté.");
  });
});

describe("the thread's answer post carries no sources line (Diego's ruling of 2026-10-07 on #363)", () => {
  it("renders the answer framed and nothing after it", () => {
    expect(renderAnswerPost({ answer: "Le pidió 40 cajas para el jueves." })).toBe(
      "✳️ Le pidió 40 cajas para el jueves.",
    );
  });
});

describe("the binding ceremony's grammar (ticket #34; spec #29 grilling decision 3)", () => {
  it("an unconfirmed counterparty renders the push-name marked «(sin confirmar)»", () => {
    expect(
      counterpartyName({
        confirmedName: undefined,
        pushName: "Sra. Garza",
        senderJid: "5215550001@s.whatsapp.net",
      }),
    ).toBe("Sra. Garza (sin confirmar)");
  });

  it("an unconfirmed counterparty with no push-name renders the number, still marked", () => {
    expect(
      counterpartyName({
        confirmedName: undefined,
        pushName: undefined,
        senderJid: "5215550001@s.whatsapp.net",
      }),
    ).toBe("5215550001 (sin confirmar)");
  });

  it("a confirmed binding renders the rep-confirmed name unmarked — whatever the payload's push-name says today", () => {
    expect(
      counterpartyName({
        confirmedName: "Sra. Garza",
        pushName: "Garza Abarrotes",
        senderJid: "5215550001@s.whatsapp.net",
      }),
    ).toBe("Sra. Garza");
  });

  it("renders the binding question exactly: framed, the proposed name, and the one word it teaches", () => {
    // The teaching line asks for «si» (ticket #49; #36 finding 1): «va»
    // means "go ahead", which reads oddly as the answer to a question, and
    // the twin was the one sounding wrong. The NO left at #174 — declining
    // a binding is prose the execution reads — so the line teaches only the
    // act a wrong yes could not take back.
    expect(renderBindingQuestion("Sra. Garza")).toBe(
      "✳️ ¿Este chat es de Sra. Garza?\n\n" +
        "Para confirmarlo, responde a este mensaje citándolo con «si».",
    );
  });

  it("the binding question wears the frame", () => {
    expect(() => assertFramed(renderBindingQuestion("Sra. Garza"))).not.toThrow();
  });

  it("renders the execution's own sentence with the name folded into the slot (ticket #172)", () => {
    // Spec #171 decision 17: the execution composes the sentence, code
    // renders the frame and the accepted answers. The sigil and the answers
    // line are the same ones the code-composed question wears, so the rep
    // reads one shape whichever path asked.
    expect(
      renderComposedBindingQuestion({
        sentence: `¿Este chat es el de ${NAME_SLOT}?`,
        name: "Sra. Garza",
      }),
    ).toBe(
      "✳️ ¿Este chat es el de Sra. Garza?\n\n" +
        "Para confirmarlo, responde a este mensaje citándolo con «si».",
    );
  });

  it("flattens a composed sentence that carries a newline, so it cannot paint a second post", () => {
    // `renderDraftPost`'s own reachable case, one surface over: what the
    // rep quotes must be one question.
    const post = renderComposedBindingQuestion({
      sentence: `¿Este chat es de ${NAME_SLOT}?\n\n✳️ ¿Y este?`,
      name: "Sra. Garza",
    });
    expect(post.split("\n\n")).toHaveLength(2);
    expect(post).toContain("¿Este chat es de Sra. Garza? ✳️ ¿Y este?");
  });

  it("the composed binding question wears the frame", () => {
    expect(() =>
      assertFramed(
        renderComposedBindingQuestion({
          sentence: `¿${NAME_SLOT}?`,
          name: "Sra. Garza",
        }),
      ),
    ).not.toThrow();
  });

  it("the binding ack says out loud what was saved, in the «Descartado» shape", () => {
    // #36 finding 2: silence after a confirmation was felt first-hand to be
    // wrong. One framed line, naming what is now stored.
    expect(renderBindingAck("Sra. Garza")).toBe(
      "✳️ Listo, guardé este chat como *Sra. Garza*.",
    );
    expect(() => assertFramed(renderBindingAck("Sra. Garza"))).not.toThrow();
  });
});

/**
 * THE TWO ACTION-TEACHING LINES ARE RENDERED FROM THE ACCEPTED SETS (ticket
 * #172; ADR-0037 as amended — "the instruction line is a button's label
 * rendered from data").
 *
 * Two claims, and they only mean something together: the rep reads exactly
 * what they read before this ticket for TODAY's sets, and a changed set
 * changes the line with no edit in `grammar.ts`. The first alone would pass
 * over a constant; the second alone would not say the rep sees the same
 * thing.
 */
describe("the keyword is a button and the line is its label (ticket #172)", () => {
  const draftLine = (): string =>
    renderDraftPost({
      said: "preguntó",
      counterparty: "Sra. Garza",
      body: "claro",
    })
      .split("\n\n")
      .at(-1)!;

  it("teaches the accepted word, and today's set renders the line the rep reads", () => {
    expect(draftLine()).toBe(
      `Para enviarlo, responde a este mensaje citándolo con «${AFFIRMATIONS.proposal[0]!}».`,
    );
    // ...and the literal, so the byte-identity claim does not rest on the
    // same data the renderer reads (a tautology would pass either way).
    expect(draftLine()).toBe(
      "Para enviarlo, responde a este mensaje citándolo con «va».",
    );
  });

  it("teaches NOTHING about discarding a draft (ticket #174)", () => {
    // THE LINE'S OWN DEFECT, HAD IT BEEN LEFT ALONE. It taught «no va»
    // beside «va», and #174 retires «no va» as a keyword — so the label
    // would have gone on naming a word the matcher no longer accepted,
    // which is the exact drift #172 removed by rendering it from data. The
    // dismissal is prose now and needs no label: the twin dismisses «así
    // no» and «mejor no le contestes» through the tool.
    const line = draftLine();
    expect(line).not.toContain("descartar");
    expect(line).not.toContain("«no va»");
    expect(line).not.toContain("«no»");
  });

  it("teaches the question's own word, which is not the proposal's", () => {
    // «va» means "go ahead" and reads oddly as the answer to a question
    // (#36 finding 1). It remains ACCEPTED on both classes — what differs
    // is the word the line shows.
    const question = renderBindingQuestion("Sra. Garza").split("\n\n").at(-1)!;
    expect(question).toBe(
      `Para confirmarlo, responde a este mensaje citándolo con «${AFFIRMATIONS.question[0]!}».`,
    );
    expect(question).toBe(
      "Para confirmarlo, responde a este mensaje citándolo con «si».",
    );
  });

  it("the two binding questions render one answers line, and it is the only taught line left", () => {
    // ONE SENTENCE WHEREVER THE TWIN ASKS ABOUT A BINDING (ticket #49) —
    // the code-composed question and the execution-composed one, so the rep
    // reads one shape either way.
    const answersLineOf = (post: string): string =>
      post.split("\n\n").at(-1)!;
    expect(
      answersLineOf(
        renderComposedBindingQuestion({
          sentence: `¿${NAME_SLOT}?`,
          name: "Sra. Garza",
        }),
      ),
    ).toBe(answersLineOf(renderBindingQuestion("Sra. Garza")));

    // ...AND IT IS THE ONLY ONE (ticket #218). The one act a wrong yes
    // cannot take back is the chat↔entity binding, and the
    // candidate-question route that had the other taught line is retired —
    // so every taught word in this module belongs to the binding.
    const taught = [
      renderBindingQuestion("Sra. Garza"),
      renderComposedBindingQuestion({
        sentence: `¿${NAME_SLOT}?`,
        name: "Sra. Garza",
      }),
    ];
    for (const word of AFFIRMATIONS.question) {
      const teaching = taught.filter((post) => post.includes(`«${word}»`));
      expect(teaching.length, `«${word}» is taught by the bindings alone`).toBe(
        AFFIRMATIONS.question[0] === word ? 2 : 0,
      );
    }
  });

  it("is data and not a constant: the words the line teaches ARE the sets'", () => {
    // THE CLAIM THAT MAKES THE BYTE-IDENTITY TEST WORTH ITS GREEN. The
    // quoted words are extracted from the line the REP reads and compared
    // against the sets the MATCHER reads, so the two can no longer disagree:
    // a word re-taught in `affirmation.ts` reaches the rep with no edit
    // here. Asserted this way rather than by mutating the tables, which are
    // frozen — they are the matcher's vocabulary, not a fixture.
    const quoted = (line: string): string[] =>
      [...line.matchAll(/«([^»]+)»/gu)].map((match) => match[1]!);
    expect(quoted(draftLine())).toEqual([AFFIRMATIONS.proposal[0]!]);
    expect(
      quoted(renderBindingQuestion("Sra. Garza").split("\n\n").at(-1)!),
    ).toEqual([AFFIRMATIONS.question[0]!]);
    // ...and the two classes teach DIFFERENT words through the same
    // renderer, which is a claim only data-driven rendering can make: a
    // constant would have to hold both, and each is checked against its own
    // set.
    expect(quoted(draftLine())).not.toEqual(
      quoted(renderBindingQuestion("Sra. Garza").split("\n\n").at(-1)!),
    );
  });

  it("the table is frozen, so nothing can re-teach a word at run time", () => {
    // A vocabulary three surfaces read — the matcher's `some`, the
    // grammar's two labels and the `keyword_set` part — must not be
    // reachable and writable from anywhere, which is the rule
    // `STANDARD_RECIPES` and `DRAFTING_RECIPES` already follow.
    expect(Object.isFrozen(AFFIRMATIONS)).toBe(true);
  });
});

/**
 * The daily disclosure post (ticket #51; spec #48 decision 7 shape D and
 * decision 17). The fixture below is the spec's own prototype mock —
 * settled at the prototype gate on real rig traffic — so it is
 * decision-encoding in exactly the way MOCK_A is: change it and you have
 * changed what the rep was promised, not a string.
 */
describe("the daily disclosure post (ticket #51, composed at #198)", () => {
  // 2026-08-28 18:53 America/Monterrey — the rep's own «va» on the binding
  // question, as the plane stamped it.
  const CONFIRMED_AT = new Date("2026-08-29T00:53:00.000Z");
  // The post goes out the next day, so that confirmation reads «ayer».
  const NOW = new Date("2026-08-30T01:00:00.000Z");
  /**
   * The two halves the EXECUTION writes (spec #193 decision 23), as a
   * scripted twin would.
   *
   * LOWER CASE AND UNPUNCTUATED ON PURPOSE: they are prose a coworker types,
   * not a template, and writing them here the way a model writes them is
   * what keeps the byte-exact expectations below honest about which parts of
   * the post code owns. Neither carries a digit or a name, which is what the
   * contract's guard refuses (`disclosure/guard.ts`).
   */
  const OPENING = "fue un día tranquilo";
  const CLOSING = "si ves algo raro contéstame aquí y dime cuál";

  it("renders the prototype mock exactly: the ✳️ frame, the count, the twin's opening, the counterparty heading, numbered lines with provenance, and the twin's closing", () => {
    const post = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              provenance: { kind: "rep_act", at: CONFIRMED_AT },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: NOW,
      timeZone: "America/Monterrey",
    });
    expect(post).toBe(
      `✳️ *Hoy agregué 1 dato al registro.*

fue un día tranquilo

*Diego Zertuche*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

si ves algo raro contéstame aquí y dime cuál`,
    );
  });

  it("counts in the plural once there is more than one, and numbers CONTINUOUSLY across counterparties — «N» names one line in the whole post, never one line in a group", () => {
    const post = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              provenance: { kind: "rep_act", at: CONFIRMED_AT },
            },
          ],
        },
        {
          counterparty: "Ferretería Fuentes",
          lines: [
            {
              index: 2,
              text: "Lo di de alta como cliente.",
              provenance: { kind: "rep_act", at: CONFIRMED_AT },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: NOW,
      timeZone: "America/Monterrey",
    });
    expect(post).toBe(
      `✳️ *Hoy agregué 2 datos al registro.*

fue un día tranquilo

*Diego Zertuche*
1. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

*Ferretería Fuentes*
2. Lo di de alta como cliente. (tú lo confirmaste, ayer 18:53)

si ves algo raro contéstame aquí y dime cuál`,
    );
  });

  it("says «hoy» for something confirmed today and the day-and-month for anything older — the rep's own reading of when", () => {
    const sameDay = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              // 2026-08-29 19:23 America/Monterrey, the post's own day.
              provenance: {
                kind: "rep_act",
                at: new Date("2026-08-30T01:23:00.000Z"),
              },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: new Date("2026-08-30T02:00:00.000Z"),
      timeZone: "America/Monterrey",
    });
    expect(sameDay).toContain("(tú lo confirmaste, hoy 19:23)");

    const older = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              // 2026-08-27 19:23 America/Monterrey — two days back.
              provenance: {
                kind: "rep_act",
                at: new Date("2026-08-28T01:23:00.000Z"),
              },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: new Date("2026-08-30T02:00:00.000Z"),
      timeZone: "America/Monterrey",
    });
    expect(older).toContain("(tú lo confirmaste, 27 ago 19:23)");
  });

  it("wears the frame, and refuses to render a post with no lines at all — an empty day says nothing (spec #48 decision 17)", () => {
    expect(() =>
      assertFramed(
        renderDailyDisclosurePost({
          groups: [
            {
              counterparty: "Diego Zertuche",
              lines: [
                {
                  index: 1,
                  text: "Lo di de alta como cliente.",
                  provenance: { kind: "rep_act", at: CONFIRMED_AT },
                },
              ],
            },
          ],
          opening: OPENING,
          closing: CLOSING,
          now: NOW,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      renderDailyDisclosurePost({
        groups: [],
        opening: OPENING,
        closing: CLOSING,
        now: NOW,
      }),
    ).toThrow(/empty day/i);
  });

  it("a line the twin read in a customer chat says «su chat, …»", () => {
    const post = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Le confirmaste que tienes disponible para el sábado.",
              provenance: {
                kind: "chat",
                // 2026-08-27 19:23 America/Monterrey.
                at: new Date("2026-08-28T01:23:00.000Z"),
              },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: NOW,
      timeZone: "America/Monterrey",
    });
    expect(post).toContain(
      "1. Le confirmaste que tienes disponible para el sábado. (su chat, 27 ago 19:23)",
    );
  });

  it("a hostile counterparty name cannot paint a numbered line the twin never wrote (Codex r1)", () => {
    // The heading's name is a WhatsApp push-name — a COUNTERPARTY-controlled
    // string the rep merely confirmed. In this post the numbers are what a
    // rep act resolves through, so a name carrying a newline and a «1.»
    // would leave «1 no» pointing at one thing and the seam resolving
    // another.
    const post = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "ACME*\n1. Nunca autoricé esto\n\n*ACME",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              provenance: { kind: "rep_act", at: CONFIRMED_AT },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: NOW,
      timeZone: "America/Monterrey",
    });
    // Exactly one numbered line in the whole post, and it is the twin's.
    const numbered = [...post.matchAll(/^(\d+)\. /gmu)].map((m) => m[0]);
    expect(numbered).toEqual(["1. "]);
    expect(post).toContain("1. Lo di de alta como cliente.");
    // The name still appears — honest about who the chat is bound to — but
    // on one line, so it cannot forge structure.
    expect(post).toContain("Nunca autoricé esto");
    expect(post.split("\n").filter((l) => l.includes("ACME"))).toHaveLength(1);
  });

  it("carries no consumer-facing product noun (FR-40) — the twin simply reports", () => {
    const post = renderDailyDisclosurePost({
      groups: [
        {
          counterparty: "Diego Zertuche",
          lines: [
            {
              index: 1,
              text: "Lo di de alta como cliente.",
              provenance: { kind: "rep_act", at: CONFIRMED_AT },
            },
          ],
        },
      ],
      opening: OPENING,
      closing: CLOSING,
      now: NOW,
      timeZone: "America/Monterrey",
    });
    // CONTEXT.md's «Avoid» list for the daily disclosure, plus the product's
    // own name: none of it is a word the rep is ever shown.
    for (const banned of [/recibo/i, /reporte/i, /informe/i, /resumen/i, /\bdito\b/i]) {
      expect(post).not.toMatch(banned);
    }
  });
});

describe("the frame is enforced at the emission seams", () => {
  it("assertFramed passes framed text through", () => {
    expect(assertFramed("✳️ Descartado")).toBe("✳️ Descartado");
  });

  it("assertFramed refuses an unframed post loudly — no twin post ships without the sigil", () => {
    expect(() => assertFramed("Descartado")).toThrow(/✳️/);
  });
});

/**
 * The fact disclosure line (ticket #52; spec #48 decision 7, shape D;
 * ADR-0034).
 *
 * Rendered from the payload the APERTURE normalized, never from the model's
 * own text: a disclosure line is what the rep was told crossed, so it must
 * say what was actually stored. The line is stored as rendered text and
 * never re-rendered, which is why the copy is pinned here.
 */
describe("the fact disclosure line", () => {
  const line = (
    factType: string,
    payload: Record<string, unknown>,
    reading: CandidateReading = "stated",
  ): string =>
    // `factType` is deliberately widened here: the closed set is the
    // aperture's, and the last case below asks what the grammar does with
    // one outside it.
    renderFactDisclosureLine(
      {
        factType,
        payload,
      } as Parameters<typeof renderFactDisclosureLine>[0],
      reading,
    );

  it("says what was quoted, with the amount as it was stored", () => {
    expect(
      line("QuoteGiven", {
        item: "cajas",
        quantity: 100,
        amount: 4500,
        currency: "MXN",
      }),
    ).toBe("Le cotizaste 100 cajas en 4,500 MXN — sin fecha.");
    expect(
      line("QuoteGiven", {
        item: "cemento",
        quantity: 20,
        unit: "bultos",
        amount: 4500,
        currency: "MXN",
      }),
    ).toBe("Le cotizaste 20 bultos de cemento en 4,500 MXN — sin fecha.");
  });

  it("says what the customer asked for", () => {
    expect(
      line("OrderRequested", {
        item: "cajas",
        quantity: 100,
        amount: 4500,
        currency: "MXN",
      }),
    ).toBe("Te pidió 100 cajas por 4,500 MXN — sin fecha.");
  });

  /**
   * THE UNIT IS SAID ONCE (#200 hotfix 2). Both payloads are the rig's own:
   * «varilla» filed as the unit of «varilla de 3/8» on 2026-09-05, and
   * «bultos» filed as the unit of «bultos» on 2026-09-01. The rep read «Le
   * cotizaste varilla de varilla de 3/8» and «Te pidió 30 bultos de bultos» —
   * a line the twin never says out loud, which is exactly the kind a rep
   * stops trusting on a busy day.
   */
  it("names the unit once when the item already opens with it", () => {
    expect(
      line("QuoteGiven", {
        item: "varilla de 3/8",
        unit: "varilla",
        amount: 35,
        currency: "MXN",
      }),
    ).toBe("Le cotizaste varilla de 3/8 en 35 MXN — sin cantidad, sin fecha.");
    expect(
      line("OrderRequested", { item: "bultos", unit: "bultos", quantity: 30 }),
    ).toBe("Te pidió 30 bultos — sin precio, sin fecha.");
  });

  it("still says both when the unit is a different word, or only the start of one", () => {
    expect(
      line("QuoteGiven", {
        item: "cemento",
        unit: "bultos",
        quantity: 20,
        amount: 4500,
        currency: "MXN",
      }),
    ).toBe("Le cotizaste 20 bultos de cemento en 4,500 MXN — sin fecha.");
    // «sal» opens «salsa» as letters and not as a word, and a rep who is told
    // «salsa» when the store holds «sal de salsa» is being told less than
    // crossed. The comparison is at a word boundary for this case alone.
    expect(line("OrderRequested", { item: "salsa", unit: "sal", quantity: 4 })).
      toBe("Te pidió 4 sal de salsa — sin precio, sin fecha.");
  });

  /**
   * THE TWO LINES MUST NOT READ AS ONE EXCHANGE COUNTED TWICE (ticket
   * #71). A request and the agreement that answers it disclose
   * independently — two facts, two lines — and on a same-day exchange the
   * rep sees both. So the subject changes: «Te pidió …» is the customer's
   * act, «Le confirmaste el pedido …» is the rep's.
   *
   * AND THE WORDS THAT AGREED ARE QUOTED BACK. #66 measured every wrong
   * crossing arriving at 0.95–1.00, so a wrong agreement will not be
   * caught by the confidence gate; the only place a rep can catch one is
   * the line they read. «Le confirmaste el pedido de 100 cajas» alone
   * gives them nothing to check against — quoting the message that was
   * read as the yes is what makes «déjame checar» visible as a mistake
   * inside the correction window.
   */
  it("says what the rep agreed to, and quotes the words that agreed", () => {
    expect(
      line("OrderTaken", {
        item: "cajas",
        quantity: 100,
        amount: 4500,
        currency: "MXN",
        requestedFor: "2026-08-31",
        agreement: "va, se los mando",
      }),
    ).toBe(
      "Le confirmaste el pedido de 100 cajas por 4,500 MXN para el lunes 31 de agosto de 2026. Dijiste: «va, se los mando».",
    );
    expect(
      line("OrderTaken", {
        item: "cajas",
        quantity: 100,
        agreement: "sale",
      }),
    ).toBe(
      "Le confirmaste el pedido de 100 cajas — sin precio, sin fecha. Dijiste: «sale».",
    );
  });

  /**
   * A 👍 IS SAID AS A 👍 (ticket #99; ADR-0041's worked example line). The
   * rep did not SAY «¿me mandas 20 bultos?» — the customer did, and the rep
   * tapped an emoji on it. «Dijiste: «…».» over those words would put the
   * customer's sentence in the rep's mouth, which is a wrong the rep cannot
   * catch by reading it: it would look exactly like an agreement they made.
   *
   * So the gesture field chooses the verb, and the line names both halves —
   * what they tapped, and the message they tapped it on. Wrong on its face
   * or right on its face, inside the 24-hour window, which is where
   * ADR-0038 wants the rep's eyes.
   */
  it("says a gesture as a gesture, quoting the message it was placed on", () => {
    expect(
      line("OrderTaken", {
        item: "bultos",
        quantity: 20,
        agreement: "¿me mandas 20 bultos?",
        agreementGesture: "👍",
      }),
    ).toBe(
      "Le confirmaste el pedido de 20 bultos — sin precio, sin fecha. Confirmaste con 👍: «¿me mandas 20 bultos?».",
    );
    // The emoji is the row's, not a constant: ADR-0041 admits the gesture,
    // never one particular glyph.
    expect(
      line("OrderTaken", {
        item: "bultos",
        quantity: 20,
        agreement: "¿me mandas 20 bultos?",
        agreementGesture: "💯",
      }),
    ).toContain("Confirmaste con 💯: «¿me mandas 20 bultos?».");
  });

  /**
   * Loud rather than vague, like every other unrenderable payload here:
   * the aperture puts the rep's own message on every `OrderTaken` v3, so
   * reaching this throw means the store and the renderer disagree — and a
   * line claiming the rep confirmed an order without saying what they said
   * would be exactly the invisible wrong the field exists to prevent.
   */
  it("refuses to state an agreed order with no words that agreed", () => {
    expect(() => line("OrderTaken", { item: "cajas", quantity: 100 })).toThrow(
      /agreement/,
    );
  });

  /**
   * ONE LINE, WHATEVER THE PAYLOAD HOLDS (routed from #73). The question
   * post displays `oneLine(claim)` while the questions store seals the
   * claim raw, so a disclosure line carrying a newline would show the rep
   * one sentence and file another — and a «si» would then confirm
   * something they never read. Guaranteed at this function's exit rather
   * than at each of its free-text slots, so a slot added later cannot
   * reopen it.
   */
  it("is always one line, however the payload was written", () => {
    expect(
      line("OrderTaken", {
        item: "cajas\ny también 40 bultos",
        quantity: 100,
        agreement: "va\nse los mando",
      }),
    ).toBe(
      "Le confirmaste el pedido de 100 cajas y también 40 bultos — sin precio, sin fecha. Dijiste: «va se los mando».",
    );
  });

  /**
   * #57's orders, in the line the rep read: quantity and total rendered,
   * and nothing at all said about what the Ledger did NOT hold. A field
   * the sentence simply omits is indistinguishable from one it got right,
   * so the rep has nothing to correct — the same defect as the missing
   * date, on the commercial types.
   *
   * «sin cantidad» / «sin precio» state the absence; they never stand in
   * for a value (ADR-0034: a missing currency is unknown, not MXN).
   */
  it("says plainly which commercial fields the Ledger does not hold, rather than omitting them", () => {
    expect(line("QuoteGiven", { item: "cajas" })).toBe(
      "Le cotizaste cajas — sin cantidad, sin precio, sin fecha.",
    );
    expect(line("OrderRequested", { item: "cajas", quantity: 100 })).toBe(
      "Te pidió 100 cajas — sin precio, sin fecha.",
    );
    expect(
      line("OrderRequested", {
        item: "producto (no especificado)",
        unit: "bultos",
        amount: 4000,
        currency: "MXN",
      }),
    ).toBe(
      "Te pidió bultos de producto (no especificado) por 4,000 MXN — sin cantidad, sin fecha.",
    );
  });

  /**
   * THE #57 ORDER CASE (ticket #70). «te pido 100 cajas para el lunes» is
   * one message carrying an order AND the day it is wanted for, and until
   * now the day had nowhere to go: `DatePromised` is the REP's commitment
   * — the corpus labels a customer-proposed date silent precisely so the
   * Ledger never claims a promise the rep did not make — and the
   * commercial payload had no date field at all. So the order crossed
   * dateless and the rep read a line with nothing to correct.
   *
   * `requestedFor` is that day, and the line says it the way the rep would:
   * «para el lunes 31 de agosto de 2026», the same weekday-and-date
   * rendering `DatePromised` already uses, so one wrong day looks the same
   * wherever the rep meets it.
   */
  it("names the day a dated order is wanted for — the #57 order that crossed with no date", () => {
    expect(
      line("OrderRequested", {
        item: "cajas",
        quantity: 100,
        requestedFor: "2026-08-31",
      }),
    ).toBe("Te pidió 100 cajas para el lunes 31 de agosto de 2026 — sin precio.");
    expect(
      line("QuoteGiven", {
        item: "cajas",
        quantity: 100,
        amount: 4500,
        currency: "MXN",
        requestedFor: "2026-08-31",
      }),
    ).toBe("Le cotizaste 100 cajas en 4,500 MXN para el lunes 31 de agosto de 2026.");
  });

  /**
   * EVERY DAY THE APERTURE ACCEPTS READS BACK AS ITSELF (Codex r3 on #70).
   *
   * The disclosure line is the rep's only view of the stored day, so a
   * value the store accepts and the line renders DIFFERENTLY is the same
   * defect as one the line omits — the rep confirms a day that was never
   * filed, which is #65's number-fidelity finding in date form.
   * `0000-01-01` was exactly that: a real ISO date that passes the
   * round-trip check, rendered «1 de enero de 1» because a bare year
   * carries no era and ISO year 0 is 1 BC — the same sentence as
   * `0001-01-01`. The aperture now refuses year 0000, so the renderer's
   * promise holds for every day that can reach it.
   */
  it("reads every storable day back as the year the Ledger holds", () => {
    const dated = (day: string): string =>
      line("OrderRequested", { item: "cajas", quantity: 1, requestedFor: day });
    expect(dated("0001-01-01")).toBe("Te pidió 1 cajas para el lunes 1 de enero de 1 — sin precio.");
    expect(dated("0999-12-31")).toContain("de 999 ");
    expect(dated("2026-08-31")).toContain("de 2026 ");
    expect(dated("9999-12-31")).toContain("de 9999 ");
  });

  it("says what was promised, continuing the twin's own verb — the prototype's own sentence", () => {
    expect(
      line("DatePromised", { commitment: "que tienes disponible para el sábado" }),
    ).toBe("Le confirmaste que tienes disponible para el sábado — sin fecha.");
  });

  /**
   * THE #57 REGRESSION (ticket #65). The steering session filed
   * `dueOn: 2026-09-01` for a customer who said «para el lunes» — the
   * session ran on Saturday 2026-08-29, so Monday was 2026-08-31. The line
   * the rep read was «Le confirmaste enviar los bultos.» and the date was
   * not in it, so there was nothing to correct and the fact finalized
   * 24 hours later holding Tuesday for a Monday promise.
   *
   * The line must carry the date, as a weekday and a date the rep reads
   * without decoding — «martes» beside a promise they remember making for
   * Monday is the whole correction signal (ADR-0004's window, ADR-0016's
   * ground truth).
   */
  it("names the promised date — the #57 wrong-date case the rep could not see", () => {
    expect(
      line("DatePromised", {
        commitment: "enviar los bultos",
        dueOn: "2026-09-01",
      }),
    ).toBe("Le confirmaste enviar los bultos — martes 1 de septiembre de 2026.");
  });

  /**
   * The YEAR is part of the date (Codex r1). `dueOn` is a full
   * `YYYY-MM-DD`, and a weekday-day-month rendering states three quarters
   * of it: «martes 1 de septiembre» is the same sentence for 2026 and for
   * 2037, which share that weekday. A promise said in December for «el 15
   * de enero» is exactly where a model picks the wrong year, and a field
   * the line does not state is a field the rep cannot correct — the whole
   * defect of this ticket, one component further in.
   */
  it("states the year too, so a wrong year is as correctable as a wrong day", () => {
    expect(
      line("DatePromised", { commitment: "entregar", dueOn: "2037-09-01" }),
    ).toBe("Le confirmaste entregar — martes 1 de septiembre de 2037.");
  });

  it("names every identifier that crossed, so the rep can see exactly what was stored", () => {
    expect(
      line("ContactEstablished", {
        identifiers: {
          phones: ["+528180001111"],
          emails: ["ana@ferreteria.mx"],
          rfcs: ["FUE930101AB1"],
        },
        contactName: "Ana",
      }),
    ).toBe(
      "Guardé los datos de contacto de Ana: +528180001111, ana@ferreteria.mx, RFC FUE930101AB1.",
    );
    expect(
      line("ContactEstablished", {
        identifiers: { phones: [], emails: ["ana@ferreteria.mx"], rfcs: [] },
      }),
    ).toBe("Guardé sus datos de contacto: ana@ferreteria.mx.");
  });

  /**
   * `role` is stored (`ContactEstablished` v1 shapes it) and, before #65,
   * was the one payload field that crossed the wall without ever appearing
   * in the disclosure line for it. The same defect as the missing date: a rep
   * cannot correct a job title they were never shown.
   */
  it("names the role it filed with the contact — every stored field reaches the rep", () => {
    expect(
      line("ContactEstablished", {
        identifiers: { phones: [], emails: ["ana@ferreteria.mx"], rfcs: [] },
        contactName: "Ana",
        role: "compras",
      }),
    ).toBe("Guardé los datos de contacto de Ana (compras): ana@ferreteria.mx.");
    expect(
      line("ContactEstablished", {
        identifiers: { phones: [], emails: ["ana@ferreteria.mx"], rfcs: [] },
        role: "compras",
      }),
    ).toBe("Guardé sus datos de contacto (compras): ana@ferreteria.mx.");
  });

  it("collapses a line break in stored text — a numbered post's lines are the ones the grammar numbered", () => {
    // Same reachable failure as the heading's (Codex r1 on #51): a payload
    // field carrying «\n1. …» would paint a numbered line the twin never
    // wrote, and «1 no» would then point at one thing and resolve another.
    expect(
      line("DatePromised", { commitment: "el sábado\n1. Nunca autoricé esto" }),
    ).toBe("Le confirmaste el sábado 1. Nunca autoricé esto — sin fecha.");
  });

  /**
   * The line states the number the Ledger holds, not a rounding of it
   * (Codex r1). The aperture accepts any finite positive quantity or
   * amount — a fractional tonnage is an ordinary one — and a formatter
   * capped at two decimals would tell the rep 0.13 for a stored 0.125.
   * A line describing something other than the stored row is the exact
   * failure this surface exists to prevent.
   */
  it("renders the stored number exactly, never a rounding of it", () => {
    expect(
      line("OrderRequested", { item: "toneladas", quantity: 0.125 }),
    ).toBe("Te pidió 0.125 toneladas — sin precio, sin fecha.");
  });

  /**
   * A promised date is a CALENDAR date and has no zone: «el lunes» has no
   * time of day, and the aperture refuses to invent one. Rendering it in
   * the rep's own zone parses midnight UTC and shifts every date west of
   * Greenwich back a day — the twin reading out Monday for the Tuesday it
   * stored, which is the exact error #65 exists to expose rather than to
   * commit.
   *
   * The zone is forced here because CI runs UTC, where an ambient-zone bug
   * cannot show itself.
   */
  it("never shifts a promised date into the day before, whatever zone the host is in", () => {
    const original = process.env["TZ"];
    try {
      // UTC-11: midnight UTC on 1 September is still 31 August here.
      process.env["TZ"] = "Pacific/Midway";
      expect(
        line("DatePromised", { commitment: "enviar los bultos", dueOn: "2026-09-01" }),
      ).toBe(
        "Le confirmaste enviar los bultos — martes 1 de septiembre de 2026.",
      );
    } finally {
      if (original === undefined) delete process.env["TZ"];
      else process.env["TZ"] = original;
    }
  });

  /**
   * `CustomerPattern` (ticket #61; ADR-0040) — «Te dijo que …», and nothing
   * else.
   *
   * THE SUBJECT IS THE CUSTOMER, which is the sentence the authorship fence
   * exists to keep true (ADR-0038): the fact is read in the customer's own
   * message, so «Te dijo …» is a claim about who spoke that the aperture
   * has already checked against `wa_events.from_me`.
   *
   * NOTHING VERBATIM IS IN THE LINE, and that is the pinned behaviour
   * rather than an omission. An earlier cut ended «Sus palabras: «…».» with
   * the customer's whole message, on `OrderTaken`'s evidence argument — and
   * one message can carry a standing preference AND a complaint about the
   * rep, so the quote would have filed FR-30's excluded class into the
   * Ledger the rep's employer reads. What crosses is the twin's own clause;
   * a wrong one is caught the way a wrong «Te pidió …» is.
   */
  it("says what the customer stated about themselves, and quotes nothing", () => {
    expect(
      line("CustomerPattern", {
        pattern: "solo recibe material antes de las 2 de la tarde",
      }),
    ).toBe("Te dijo que solo recibe material antes de las 2 de la tarde.");
  });

  it("puts nothing verbatim from the conversation into the line, whatever the payload holds", () => {
    // The regression guard for the review finding. A stored payload
    // carrying a stray field — from an older shape, or a caller that
    // invented one — must not reach the rep, and must not reach the owner
    // through the line either.
    expect(
      line("CustomerPattern", {
        pattern: "paga a 15 días",
        statedAs: "usted siempre se tarda, pero nosotros pagamos a 15 días",
      }),
    ).toBe("Te dijo que paga a 15 días.");
  });

  it("refuses a CustomerPattern with no claim to state", () => {
    // The aperture requires `pattern`, so reaching this means the store and
    // the renderer disagree — which is exactly when a line must be loud
    // rather than vague.
    expect(() => line("CustomerPattern", {})).toThrow(/CustomerPattern/);
    expect(() => line("CustomerPattern", { pattern: "   " })).toThrow(
      /CustomerPattern/,
    );
  });

  it("refuses a payload it cannot describe — a crossing the twin cannot state is never disclosed vaguely", () => {
    expect(() => line("QuoteGiven", {})).toThrow(/QuoteGiven/);
    expect(() => line("Nonsense", {})).toThrow(/Nonsense/);
    // A `dueOn` that is present but is not the calendar date the aperture
    // stores is not silently reported as «sin fecha»: saying no date
    // crossed when one did is the same lie in the other direction.
    expect(() =>
      line("DatePromised", { commitment: "entregar", dueOn: "el lunes" }),
    ).toThrow(/dueOn/);
  });
});

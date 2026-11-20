/**
 * DRAFTING'S OWN BOUNDARY (tickets #172, #363; spec #171 decisions 14, 15 and
 * 17; ADR-0037 as amended).
 *
 * Three claims the Postgres seam cannot make, and one it cannot make
 * cheaply:
 *
 * 1. **The definition is a shipped one.** Drafting is one `agent` step on a
 *    conversation of its own, read by the same parser and the shipped catalog
 *    as every definition Dito ships (`runs/shipped-conversations.ts`).
 * 2. **The instructions hold no sentence the twin would say.** The owner
 *    twin's two rules, applied to the rep side's first instructions: the
 *    orthography of the language this rig reads, and the function-word
 *    density that catches Spanish written without its accents.
 * 3. **The rig line is gone.** «this rig's traffic is Mexican Spanish» is
 *    written in English and would pass both rules above.
 * 4. **The digest is pinned.** So a change to what the twin is told is a
 *    line in a diff rather than something a boundary session notices on the
 *    rig.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOKENS, renderParts, wakeAccepts } from "@dito/execution";
import type { ConversationRow } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { DRAFTING_MAX_ITERATIONS, DRAFTING_WAKE } from "./automation.js";
import { DraftSlot, type DraftingDeps } from "./deps.js";
import { draftingInstructions } from "./instructions.js";
import { notepadBundle } from "../testing/notepad-bundle.js";
import { DEFAULT_REP_LANGUAGE } from "../rep-language.js";
import { NOTEPAD_PART } from "../rep-notepad.js";
import { WORKING_MEMORY_PART } from "../working-memory.js";
import { shippedRunCatalog } from "../runs/catalog.js";
import { parseRunDefinition } from "../runs/definition.js";
import { oneStepDefinition } from "../runs/engine.js";
import { DRAFTING_DEFINITION } from "../runs/shipped-conversations.js";
import { DRAFTING_TOOL_DECLARATIONS, SEARCH_MEMORY_TOOL } from "./tools.js";
import { CREATE_DRAFT_TOOL } from "./write.js";

const CHAT = "5215550001@s.whatsapp.net";
const SEEN_AT = new Date("2026-09-04T18:30:00Z");
const ZONE = "America/Monterrey";

function row(content: string, fromMe = false): ConversationRow {
  return {
    chatJid: CHAT,
    messageId: `M-${content.slice(0, 6)}`,
    senderJid: fromMe ? "5215550000@s.whatsapp.net" : CHAT,
    fromMe,
    occurredAt: "2026-09-04T18:00:00.000Z",
    content,
  };
}

/** A stand-in this suite never reaches: building a turn writes nothing. */
function untouched<T>(what: string): T {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`this suite does not use ${what}`);
      },
    },
  ) as T;
}

function deps(overrides: Partial<DraftingDeps> = {}): DraftingDeps {
  return {
    bundle: notepadBundle(),
    embedder: { embed: () => Promise.reject(new Error("not called")) } as never,
    chatJid: CHAT,
    counterparty: "Sra. Garza",
    bindingConfirmed: false,
    bindingQuestionDue: false,
    turn: [row("me mandas 50 bultos?"), row("para el lunes")],
    transcript: [row("le mando la cotizacion", true)],
    memories: [row("el flete corre por nuestra cuenta", true)],
    repLanguage: DEFAULT_REP_LANGUAGE,
    timeZone: ZONE,
    db: untouched<pg.ClientBase>("Postgres"),
    dek: untouched<Dek>("the twin key"),
    twinId: "11111111-1111-4111-8111-111111111111",
    selfChatJid: "5215550000@s.whatsapp.net",
    executionId: "33333333-3333-4333-8333-333333333333",
    anchor: { eventId: "7" },
    counterpartyShown: "Sra. Garza (sin confirmar)",
    reference: 4,
    drafted: new DraftSlot(),
    ...overrides,
  };
}

/** One drafting turn, as the engine builds it. */
function execution(overrides: Partial<DraftingDeps> = {}) {
  return oneStepDefinition({
    definition: DRAFTING_DEFINITION,
    conversation: { kind: "drafting", deps: deps(overrides) },
    inputs: {},
    lane: "realtime",
    wake: DRAFTING_WAKE,
    now: SEEN_AT,
    model: "claude-sonnet-5",
  });
}

describe("drafting is a definition Dito ships (tickets #172, #363; spec #171 decision 14)", () => {
  it("parses as one agent step on a conversation of its own, its answer recording `no-action`", () => {
    const parsed = parseRunDefinition(DRAFTING_DEFINITION, shippedRunCatalog());
    expect(parsed.ok && parsed.definition).toEqual(DRAFTING_DEFINITION);
    expect(DRAFTING_DEFINITION.session).toBeUndefined();
    expect(DRAFTING_DEFINITION.answeredAs).toBe("no-action");
  });

  it("wakes on a settled customer turn, by seam event, in the realtime lane", () => {
    expect(DRAFTING_WAKE).toEqual({
      kind: "trigger",
      mechanism: "seam_event",
      occasion: "chat_turn",
      predicate: { sources: ["whatsapp"], eventTypes: ["message"] },
    });
    expect(wakeAccepts(DRAFTING_WAKE, "request")).toBe(false);
    expect(execution().lane).toBe("realtime");
  });

  it("holds two tools — its look and the draft it writes — six recipes in order, and no submission", () => {
    expect(execution().tools.map((tool) => [tool.name, tool.gate])).toEqual([
      [SEARCH_MEMORY_TOOL, "projection"],
      [CREATE_DRAFT_TOOL, "approve-before"],
    ]);
    expect(execution().outputFormat).toBeUndefined();
    expect(DRAFTING_DEFINITION.steps[0]).toMatchObject({
      recipes: [
        "chat_binding",
        "retrieved_memories",
        "recent_transcript",
        "the_turn",
        // THE NOTEPAD IS LAST BUT ONE (ticket #260; spec #258): what the rep
        // has taught is about the DRAFT rather than about what the customer said.
        "notepad",
        // ...AND THE TWIN'S OWN NOTES RIGHT AFTER IT (ticket #322; spec #318
        // decision 2), marked as notes and never as rules.
        "working_memory",
      ],
    });
  });

  it("takes the draft's text, blanks, delicacy and binding question as the draft tool's parameters, and no knock and no clause (ticket #368)", () => {
    const declared = DRAFTING_TOOL_DECLARATIONS.find((tool) => tool.name === CREATE_DRAFT_TOOL)!;
    expect(Object.keys(declared.inputSchema.properties ?? {})).toEqual([
      "text",
      "blanks",
      "delicate",
      "reason",
      "binding_question",
    ]);
    expect(declared.inputSchema.required).toEqual(["text"]);
  });

  it("takes the runtime's 16,000, six iterations and the app's rung", () => {
    expect(DRAFTING_MAX_ITERATIONS).toBe(6);
    expect(execution().budget).toEqual({
      model: "claude-sonnet-5",
      maxIterations: 6,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    // The harness capped one call's output at 1,024, which on a model that
    // thinks out of the same cap is a turn that ends with no tool call at
    // all (#148; the slice-4 boundary).
    expect(DEFAULT_MAX_TOKENS).toBe(16_000);
  });

  it("stamps one digest whatever the turn holds, and a different one when the parts change", () => {
    // The line the digest draws: WHICH instructions and WHICH recipes are
    // stamped; what they render is not.
    expect(execution().digest).toBe(execution({ turn: [row("otra cosa entera")] }).digest);
    expect(execution().digest).toBe(execution({ bindingConfirmed: true, bindingQuestionDue: false }).digest);
    // ...and the rendered parts really did differ.
    expect(renderParts(execution().context)).not.toBe(
      renderParts(execution({ turn: [row("otra cosa entera")] }).context),
    );
  });

  it("pins the instructions digest, so a change to what the twin is told is a diff", () => {
    // A LITERAL, and it moves deliberately. The stamp covers the instructions,
    // each tool with its description, schema, gate and pinned columns, all
    // four budget fields and every recipe by name — so this number changing
    // is the signal that one of those did.
    expect(execution().digest).toBe("57dc2d36f465f6c1f697c03c7ea3a7e5");
  });
});

describe("what a drafting turn is shown (spec #171 decision 15)", () => {
  it("renders `now` first, in the rep's own zone and at the turn's pick-up", () => {
    const [first] = execution().context;
    expect(first?.name).toBe("now");
    expect(first?.text).toBe(
      "[Now: Friday, Sep 4, 2026, 12:30:00 CST (America/Monterrey)]",
    );
  });

  it("names the counterparty and says nobody has confirmed who they are", () => {
    const part = partNamed(execution(), "chat binding");
    expect(part).toContain("Sra. Garza");
    expect(part).toContain("Nobody has confirmed who this is");
    // ...IN ENGLISH, AND NOT WITH THE FRAME LABEL (the two-axis review's
    // Spec axis). «(sin confirmar)» is chrome the rep reads on the post; in
    // the prompt it would say the same thing twice, the second time in a
    // language the instructions deliberately do not use.
    expect(part).not.toContain("sin confirmar");
  });

  it("says the name is the rep's own once a binding is confirmed", () => {
    const part = partNamed(
      execution({ bindingConfirmed: true }),
      "chat binding",
    );
    expect(part).toContain("The rep has confirmed who this is");
  });

  it("tells the execution the binding question is due, and asks for the slot", () => {
    const part = partNamed(
      execution({ bindingQuestionDue: true, proposedName: "Sra. Garza" }),
      "chat binding",
    );
    expect(part).toContain("never been identified");
    expect(part).toContain("Sra. Garza");
    expect(part).toContain("{name}");
  });

  it("says nothing about a question that is not due", () => {
    expect(partNamed(execution(), "chat binding")).not.toContain("{name}");
  });

  it("keeps the retrieved memories a labelled block of their own", () => {
    // `drafting-context.int.test.ts` looks for this phrase to prove a
    // retrieved line arrived as retrieval rather than as transcript (#35).
    const part = partNamed(execution(), "retrieved memories");
    expect(part).toContain("from the rep's memory");
    expect(part).toContain("el flete corre por nuestra cuenta");
  });

  it("says plainly when retrieval or the window came back with nothing", () => {
    // The harness omitted an empty block, so a model shown neither could
    // not tell "this chat has no history" from "nobody looked".
    expect(
      partNamed(execution({ memories: [] }), "retrieved memories"),
    ).toContain("came back as relevant");
    expect(
      partNamed(execution({ transcript: [] }), "recent transcript"),
    ).toContain("nothing before the messages below");
  });

  it("numbers the turn under the heading that says it and only it is to be answered", () => {
    // `batching.int.test.ts` splits the prompt at this heading to prove the
    // turn appears under it and nowhere else (#75 AC 3).
    const part = partNamed(execution(), "the turn");
    expect(part).toContain("NEW — unanswered messages from the counterparty");
    expect(part).toContain("1. me mandas 50 bultos?");
    expect(part).toContain("2. para el lunes");
  });

  it("marks which side spoke in the transcript, and never who they are", () => {
    expect(partNamed(execution(), "recent transcript")).toContain(
      "rep: le mando la cotizacion",
    );
  });

  it("ends with the notepad: the default line alone when the rep has taught nothing", () => {
    // User story 17: told to the twin as a fact about the rep rather than a
    // line in its code. English bracketed metadata (#143's ruling). The Dito
    // default is the notebook's FIRST line and stays one (`rep-notepad.ts`).
    expect(partNamed(execution(), NOTEPAD_PART)).toBe(
      "[The rep's language and register: Mexican Spanish, informal WhatsApp.]",
    );
    expect(
      partNamed(execution({ repLanguage: "Brazilian Portuguese, formal" }), NOTEPAD_PART),
    ).toBe("[The rep's language and register: Brazilian Portuguese, formal.]");
  });

  it("...and the rep's own words under it, so a customer's draft obeys what they taught", () => {
    // THE WHOLE POINT OF THE SLOT (spec #258 user story 1): «con Fuentes
    // siempre de usted» is a rule about a DRAFT, so it has to reach the turn
    // that writes one — read off the bundle at render time, whether the rep
    // taught it a month ago or a minute ago in their own thread.
    expect(
      partNamed(
        execution({ bundle: notepadBundle("con Fuentes siempre de usted") }),
        NOTEPAD_PART,
      ),
    ).toBe(
      [
        "[The rep's language and register: Mexican Spanish, informal WhatsApp.]",
        "[What the rep has told you about how they work. They wrote it, you did not, and it stands until they change it:]",
        "<rep_notepad>\ncon Fuentes siempre de usted\n</rep_notepad>",
      ].join("\n"),
    );
  });

  it("ends with the twin's own notes, after the notepad and without the clause about rewriting them (ticket #322)", () => {
    const shown = execution({
      bundle: notepadBundle("con Fuentes siempre de usted", {
        text: "Torres espera saber cuándo sale su pedido.",
        matters: [
          {
            label: "Torres, el pedido",
            about: { kind: "entity", id: "0e2c7a52-0000-4000-8000-0000000000aa" },
          },
        ],
      }),
    });
    expect(shown.context.map((part) => part.name).slice(-2)).toEqual([
      NOTEPAD_PART,
      WORKING_MEMORY_PART,
    ]);
    expect(partNamed(shown, WORKING_MEMORY_PART)).toBe(
      [
        "[Your own working notes, at version 1: what you are keeping track of with this rep. You wrote these; they are not the rep's instructions and bind nothing:]",
        "<working_memory>",
        "Torres espera saber cuándo sale su pedido.",
        "Open matters:",
        "- Torres, el pedido [customer 0e2c7a52-0000-4000-8000-0000000000aa]",
        "</working_memory>",
      ].join("\n"),
    );
  });
});

/**
 * THE OWNER TWIN'S TWO RULES, over the rep side's first instructions.
 *
 * Copied rather than imported: the list below is a list of Spanish words, and
 * a list of Spanish words in `src` would be the first offender any sweep
 * found — so it lives in a test file on both sides, which is what keeps the
 * rule and the thing it forbids on opposite sides of the fence.
 */
const ES_MX = /[¿¡«»áéíóúüñÁÉÍÓÚÜÑ]/u;

const ES_MX_FUNCTION_WORDS = [
  "a", "al", "algo", "asi", "como", "con", "de", "del", "donde", "el", "ella",
  "ellos", "en", "es", "esa", "ese", "eso", "esta", "este", "hay", "la", "las",
  "le", "les", "lo", "los", "mas", "me", "mi", "muy", "nada", "ni", "no", "nos",
  "o", "para", "pero", "por", "puedo", "que", "se", "si", "sin", "sobre", "solo",
  "son", "soy", "su", "sus", "te", "tengo", "ti", "tu", "un", "una", "uno", "y",
  "ya", "yo",
];

/** Whether a run of text reads as a Spanish sentence rather than as a name. */
function readsAsSpanish(text: string): boolean {
  const words = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word !== "");
  const found = new Set(
    words.filter((word) => ES_MX_FUNCTION_WORDS.includes(word)),
  );
  return found.size >= 2 && found.size / words.length >= 1 / 3;
}

describe("the instructions hold no sentence the twin would say (ADR-0037 as amended)", () => {
  const parts = draftingInstructions(DRAFTING_TOOL_DECLARATIONS);

  it("carries no Spanish orthography in any part, name or text", () => {
    for (const part of parts) {
      expect(part.name, `the part name "${part.name}"`).not.toMatch(ES_MX);
      expect(part.text, `the part "${part.name}"`).not.toMatch(ES_MX);
    }
  });

  it("carries no Spanish sentence written without its orthography", () => {
    // The rule the owner side's Codex round 1 added: «No puedo decirte eso»
    // carries no accent and no inverted mark, and the character class cannot
    // see it. Run per PARAGRAPH rather than over the whole part, because
    // density over four paragraphs of English would hide one Spanish line.
    for (const part of parts) {
      for (const paragraph of part.text.split("\n")) {
        if (paragraph.trim() === "") continue;
        expect(
          readsAsSpanish(paragraph),
          `the part "${part.name}": ${paragraph}`,
        ).toBe(false);
      }
    }
  });

  it("catches its own violation, so the two greens above mean something", () => {
    expect(ES_MX.test("¿Este chat es de Sra. Garza?")).toBe(true);
    expect(readsAsSpanish("no lo registro")).toBe(true);
    expect(readsAsSpanish("te pido 50 bultos para el lunes")).toBe(true);
    // ...and does not read the instructions' own English as Spanish.
    expect(readsAsSpanish("Short. One WhatsApp message, not a letter.")).toBe(
      false,
    );
  });

  it("puts no Spanish of its own into the rendered context either", () => {
    // THE INSTRUCTIONS ARE ONLY HALF THE PROMPT. What the recipes write is
    // framing too, so the same rule runs over it — with the two humans'
    // words removed, since a message and a name are exactly what Spanish is
    // allowed to be in a turn.
    let framing = renderParts(execution().context);
    for (const said of [
      "me mandas 50 bultos?",
      "para el lunes",
      "le mando la cotizacion",
      "el flete corre por nuestra cuenta",
      "Sra. Garza",
    ]) {
      framing = framing.split(said).join("");
    }
    expect(framing).not.toMatch(ES_MX);
  });

  it("names no language and no rig — the third acceptance criterion", () => {
    // WRITTEN IN ENGLISH AND THEREFORE INVISIBLE TO BOTH RULES ABOVE, which
    // is why it is asserted by hand. The harness's own line was «Short,
    // natural WhatsApp register, in the same language the conversation uses
    // (this rig's traffic is Mexican Spanish).»
    const prompt = renderParts(parts);
    for (const word of ["Mexican", "Spanish", "rig", "es-MX", "español"]) {
      expect(prompt, `the instructions name "${word}"`).not.toContain(word);
    }
    // ...and they DO tell the model to read the register it was given, which
    // is what replaces the line.
    expect(prompt).toContain("the register you were told this rep writes in");
  });

  it("names the label it must not write, nowhere", () => {
    // The «Porque:» label is code's (`grammar.ts`), so the model is asked
    // for the clause that follows it and never for the line.
    expect(renderParts(parts)).not.toContain("Porque");
  });

  it("carries the tool list, with its gates and the search's pinned columns", () => {
    // ADR-0013: the tool list rides with the instructions, rendered from the
    // declaration so the stamp and what the model is handed cannot differ.
    const tools = partNamed({ instructions: parts }, "your tools", "instructions");
    expect(tools).toContain("search_memory (projection)");
    expect(tools).toContain("occurred_at, from_me, content");
    expect(tools).toContain("nothing you ask it can widen that");
    expect(tools).toContain("create_draft (approve-before)");
  });

  it("speaks of no submission: the turn ends when the twin stops, the draft its one act (ticket #363)", () => {
    const prompt = renderParts(parts);
    for (const word of ["submit", "submission", "needs_answer", "draft_text"]) {
      expect(prompt, `the instructions say "${word}"`).not.toContain(word);
    }
    expect(prompt).toContain("create the draft once with create_draft, then finish with the sentence the rep reads above it");
  });

  it("keeps the eight parts and their order", () => {
    expect(parts.map((part) => part.name)).toEqual([
      "who you are",
      "what a reply owes, and when none is owed",
      "how you write",
      // A FACT ONLY THE REP HAS, LEFT BLANK (ticket #342), shared with the thread.
      "when a fact is the rep's to give",
      // ...AND A DRAFT THAT COMMITS THE REP, WITH ITS REASON (ticket #343), shared too.
      "when a draft commits the rep",
      "your tools",
      "when the rep has to be asked who this chat is",
      "how you finish",
    ]);
  });
});

/** One named part's text, from a definition's context or its instructions. */
function partNamed(
  definition: { readonly context?: readonly { name: string; text: string }[]; readonly instructions?: readonly { name: string; text: string }[] },
  name: string,
  from: "context" | "instructions" = "context",
): string {
  const parts = from === "context" ? definition.context : definition.instructions;
  const part = (parts ?? []).find((candidate) => candidate.name === name);
  if (part === undefined) {
    throw new Error(`no ${from} part named "${name}"`);
  }
  return part.text;
}

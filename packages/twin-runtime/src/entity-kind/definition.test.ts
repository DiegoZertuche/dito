/**
 * THE KIND CLASSIFICATION'S OWN BOUNDARY (tickets #176, #363; spec #171
 * decisions 26 and 27; ADR-0035, ADR-0037 as amended).
 *
 * What the Postgres seam cannot make cheaply, or at all:
 *
 * 1. **The definition is a shipped one.** The classification is one `agent`
 *    step with no tool, read by the same parser and the shipped catalog as
 *    every definition Dito ships (`runs/shipped-conversations.ts`), and its
 *    typed output is the kind.
 * 2. **The context is the two inputs and nothing else** — the confirmed
 *    name, and the chat's own words windowed at both ends.
 * 3. **The kind is held to the two the Ledger has**: the structured output's
 *    rule refuses a third value and names the two that exist.
 * 4. **The instructions hold no sentence the twin would say, and name no
 *    market.**
 * 5. **The digest is pinned.**
 *
 * WHAT IS NOT HERE: the SDK's iteration cap, the refusal of a truncated
 * response and the output ceiling are the runner's behaviour, proven once in
 * `runner.test.ts` for every definition; `entity-kind.int.test.ts` shows at
 * the seam that a refused or truncated classification leaves the crossing
 * unfiled and the «va» replayable.
 */
import type { ConversationRow } from "@dito/bundle";
import { DEFAULT_MAX_TOKENS, renderParts, type ExecutionDefinition } from "@dito/execution";
import { describe, expect, it } from "vitest";
import { shippedRunCatalog } from "../runs/catalog.js";
import { parseRunDefinition } from "../runs/definition.js";
import { oneStepDefinition, type StepOutput } from "../runs/engine.js";
import { ENTITY_KIND_DEFINITION } from "../runs/shipped-conversations.js";
import { ENTITY_KIND_MAX_ITERATIONS, ENTITY_KIND_WAKE } from "./automation.js";
import type { EntityKindDeps } from "./deps.js";
import { entityKindInstructions } from "./instructions.js";
import { OPENING_MESSAGES, RECENT_MESSAGES } from "./lines.js";

const CHAT = "5215559401@s.whatsapp.net";
const SEEN_AT = new Date("2026-09-04T18:30:00Z");
const ZONE = "America/Monterrey";

function row(content: string, fromMe = false): ConversationRow {
  return {
    chatJid: CHAT,
    messageId: `M-${content.slice(0, 8)}`,
    senderJid: fromMe ? "5215550000@s.whatsapp.net" : CHAT,
    fromMe,
    occurredAt: "2026-09-04T18:00:00.000Z",
    content,
  };
}

function deps(overrides: Partial<EntityKindDeps> = {}): EntityKindDeps {
  return {
    displayName: "Ferreteria Fuentes",
    conversation: [row("me mandas 40 cajas"), row("va, el jueves", true)],
    timeZone: ZONE,
    ...overrides,
  };
}

/** The Ledger's two, as `classify.ts` holds the answer to them. */
const holdsAKind = (output: Readonly<Record<string, unknown>>): string | undefined =>
  output["kind"] === "person" || output["kind"] === "business"
    ? undefined
    : "kind is one of person or business, and there is no third value";

/** One classification turn, as the engine builds it. */
function execution(overrides: Partial<EntityKindDeps> = {}): ExecutionDefinition<StepOutput | undefined> {
  return oneStepDefinition({
    definition: ENTITY_KIND_DEFINITION,
    conversation: { kind: "entity_kind", deps: deps(overrides), holds: holdsAKind },
    inputs: {},
    lane: "realtime",
    wake: ENTITY_KIND_WAKE,
    now: SEEN_AT,
    model: "claude-sonnet-5",
  });
}

describe("the kind classification is a definition Dito ships (tickets #176, #363; spec #171 decision 26)", () => {
  it("parses as one agent step with no tool, its typed output the kind, its answer recording `classified`", () => {
    const parsed = parseRunDefinition(ENTITY_KIND_DEFINITION, shippedRunCatalog());
    expect(parsed.ok && parsed.definition).toEqual(ENTITY_KIND_DEFINITION);
    expect(ENTITY_KIND_DEFINITION.answeredAs).toBe("classified");
    const [step] = ENTITY_KIND_DEFINITION.steps;
    expect(step?.kind === "agent" && step.tools).toEqual([]);
    expect(step?.kind === "agent" && step.output).toEqual({ kind: "string" });
    expect(execution().tools).toEqual([]);
  });

  it("wakes on a request from code, in the realtime lane", () => {
    // NOT a seam event: the rep's «va» is the BINDING's occasion, matched
    // and confirmed by code before anything is classified. Three call sites
    // share this one wake.
    expect(ENTITY_KIND_WAKE).toEqual({
      kind: "trigger",
      mechanism: "request",
      occasion: "entity_kind",
    });
    expect(execution().lane).toBe("realtime");
  });

  it("names its two recipes in order — the name, then the chat", () => {
    const [step] = ENTITY_KIND_DEFINITION.steps;
    expect(step?.kind === "agent" && step.recipes).toEqual(["the_name", "recent_messages"]);
  });

  it("takes ONE round and the runtime's 16,000, on the app's rung", () => {
    // `entityKindTurns(kind, times)` in `@dito/scripted-model` is one turn
    // per determination, the shape #154 settled. ADR-0015 as amended: this
    // classification has its OWN rung, never derived from extraction's.
    expect(ENTITY_KIND_MAX_ITERATIONS).toBe(1);
    expect(execution().budget).toEqual({
      model: "claude-sonnet-5",
      maxIterations: 1,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it("stamps one digest whatever the chat holds, and the rendered parts really differ", () => {
    expect(execution().digest).toBe(execution({ displayName: "Ana Garcia", conversation: [] }).digest);
    expect(renderParts(execution().context)).not.toBe(renderParts(execution({ conversation: [] }).context));
  });

  it("stamps its digest at the value this ticket set (#363)", () => {
    // THE PIN. It moves when the instructions, the output's shape or the
    // recipes change, and only then.
    expect(execution().digest).toBe("026dc0a6b846eca35bf2ac210a5b6807");
  });
});

describe("what the classification is shown (spec #171 decision 26)", () => {
  it("is told today and this hour, first", () => {
    expect(execution().context[0]?.name).toBe("now");
  });

  it("names the customer as the rep confirmed them", () => {
    expect(partNamed(execution(), "the customer's name")).toBe(
      "The customer's name, as the rep confirmed it: Ferreteria Fuentes",
    );
  });

  it("shows the chat oldest first, marking which side spoke", () => {
    const conversation = partNamed(execution(), "the conversation");
    expect(conversation).toContain("customer: me mandas 40 cajas");
    expect(conversation).toContain("rep: va, el jueves");
    expect(conversation.indexOf("customer:")).toBeLessThan(
      conversation.indexOf("rep:"),
    );
  });

  it("says out loud when there is no conversation, rather than showing nothing", () => {
    // The ordinary case for a binding confirmed off a first message. A model
    // shown no block could not tell "this chat has no history" from "nobody
    // looked".
    expect(partNamed(execution({ conversation: [] }), "the conversation")).toBe(
      "There is no conversation with this customer yet — decide from the name.",
    );
  });

  it("keeps both ends of a long chat and MARKS the gap", () => {
    // WHO A COUNTERPARTY IS IS SETTLED AT THE OPENING far more often than
    // anywhere else, so a window off the tail alone would drop the answer;
    // the recent end is kept because a chat whose opening says nothing may
    // still show what this customer buys. The gap is marked because two
    // blocks run together read as one continuous conversation.
    const long = Array.from({ length: 40 }, (_, at) => row(`m${at}`));
    const conversation = partNamed(
      execution({ conversation: long }),
      "the conversation",
    );
    expect(conversation).toContain("customer: m0");
    expect(conversation).toContain(`customer: m${OPENING_MESSAGES - 1}`);
    expect(conversation).not.toContain(`customer: m${OPENING_MESSAGES}`);
    expect(conversation).toContain(`customer: m${40 - RECENT_MESSAGES}`);
    expect(conversation).toContain("customer: m39");
    expect(conversation).toContain(
      `[…${40 - OPENING_MESSAGES - RECENT_MESSAGES} messages omitted…]`,
    );
  });

  it("shows a short chat whole, with no gap marker", () => {
    const short = Array.from({ length: OPENING_MESSAGES + RECENT_MESSAGES }, (_, at) =>
      row(`m${at}`),
    );
    const conversation = partNamed(
      execution({ conversation: short }),
      "the conversation",
    );
    expect(conversation).not.toContain("omitted");
    for (let at = 0; at < short.length; at += 1) {
      expect(conversation).toContain(`customer: m${at}`);
    }
  });
});

describe("the kind is one of the two the Ledger has (ADR-0035)", () => {
  const format = execution().outputFormat!;

  it("reads both kinds back", () => {
    expect(format.parse({ kind: "business" })).toEqual({ ok: true, submission: { kind: "business" } });
    expect(format.parse({ kind: "person" })).toEqual({ ok: true, submission: { kind: "person" } });
  });

  it("refuses a third value, and the refusal names the two that exist", () => {
    // THERE IS NO "unsure" AND NO NULL: a NULL kind can never phone-match,
    // so a NULL entity's rung would be inert — the defect the classification
    // exists to fix rather than relabel.
    const refused = format.parse({ kind: "unsure" });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("person or business");
    expect(format.parse({}).ok).toBe(false);
    expect(format.parse(null).ok).toBe(false);
    expect(format.parse([{ kind: "person" }]).ok).toBe(false);
  });
});

/**
 * THE OWNER TWIN'S TWO RULES, over this classification's instructions.
 *
 * Copied rather than imported, exactly as the drafting and thread definition
 * suites copy them: the list below is a list of Spanish words, and a list of
 * Spanish words in `src` would be an offender the package-wide sweep found.
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
  const parts = entityKindInstructions();

  it("carries no Spanish orthography in any part, name or text", () => {
    for (const part of parts) {
      expect(part.name, `the part name "${part.name}"`).not.toMatch(ES_MX);
      expect(part.text, `the part "${part.name}"`).not.toMatch(ES_MX);
    }
  });

  it("carries no Spanish sentence written without its orthography", () => {
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
    expect(ES_MX.test("«Ferretería Fuentes» es un negocio")).toBe(true);
    expect(readsAsSpanish("de compras de la ferreteria")).toBe(true);
    expect(
      readsAsSpanish("A person is an individual buying for themselves."),
    ).toBe(false);
  });

  it("names no market and no rig — the harness's own line is gone", () => {
    // WRITTEN IN ENGLISH AND THEREFORE INVISIBLE TO BOTH RULES ABOVE, which
    // is why it is asserted by hand. The harness opened «You decide one
    // thing about one customer of a Mexican sales rep», which named the
    // market in the one place nobody looks — spec #171 decision 27 retired
    // the drafting prompt's equivalent for the same reason.
    const prompt = renderParts(parts);
    for (const word of ["Mexican", "Spanish", "rig", "es-MX", "espanol"]) {
      expect(prompt, `the instructions name "${word}"`).not.toContain(word);
    }
  });

  it("teaches the distinction by DEFINITION rather than by example", () => {
    // The seven Spanish proper nouns are gone with the line above. What
    // replaces them is what the examples were illustrating and what travels
    // to a rep whose customers are named differently.
    const prompt = renderParts(parts);
    for (const word of ["company", "shop", "workshop", "contractor", "institution"]) {
      expect(prompt, `the instructions define a business as a "${word}"`).toContain(
        word,
      );
    }
    expect(prompt).toContain("A PERSON is an individual buying for themselves");
  });

  it("names neither the model nor the rung (ADR-0015)", () => {
    const bytes = JSON.stringify(ENTITY_KIND_DEFINITION);
    for (const word of ["claude", "sonnet", "haiku", "DITO_ENTITY_KIND_MODEL"]) {
      expect(bytes.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("keeps the four parts and their order", () => {
    expect(parts.map((part) => part.name)).toEqual([
      "what you decide",
      "what tells the two apart",
      "you must choose one",
      "how you finish",
    ]);
  });

  it("puts no Spanish of its own into the rendered context either", () => {
    // The recipes are framing too, so the same rule runs over what they
    // write — with the two humans' words removed, since a name and a chat
    // are exactly what Spanish is allowed to be in a classification.
    let framing = renderParts(execution().context);
    for (const said of ["me mandas 40 cajas", "va, el jueves", "Ferreteria Fuentes"]) {
      framing = framing.split(said).join("");
    }
    expect(framing).not.toMatch(ES_MX);
  });
});

/** One named part's text, from a definition's context. */
function partNamed(
  definition: { readonly context: readonly { name: string; text: string }[] },
  name: string,
): string {
  const part = definition.context.find((candidate) => candidate.name === name);
  if (part === undefined) throw new Error(`no context part named "${name}"`);
  return part.text;
}

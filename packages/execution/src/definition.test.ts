/**
 * The definition and its stamp (ticket #128 AC 3: "The instructions digest
 * is stable across identical definitions and changes when any part, the
 * tool list or the budget changes"; spec #126's testing decision: "the
 * instructions digest changes when any part changes").
 */
import { describe, expect, it } from "vitest";
import type { ParameterShape } from "./automation.js";
import {
  defineExecution,
  DEFAULT_MAX_TOKENS,
  ExecutionDefinitionError,
  renderParts,
  resolveBudget,
  type ExecutionDefinitionSpec,
} from "./definition.js";
import {
  defineTool,
  type EffectOutcome,
  type ProjectionToolDeclaration,
  type ToolDeclaration,
} from "./tool.js";

/** One performed effect, as any effect tool's handler returns one (#174). */
const PERFORMED: EffectOutcome = {
  performed: true,
  told: "done",
  receipt: "Listo.",
  act: "acted",
};

const READ_TIMELINE: ProjectionToolDeclaration = defineTool({
  name: "read_timeline",
  description: "Read one entity's finalized facts in a window.",
  gate: "projection",
  columns: ["fact_id", "fact_type", "occurred_at"],
  inputSchema: {
    type: "object",
    properties: { entity_id: { type: "string" } },
    required: ["entity_id"],
    additionalProperties: false,
  },
  run: () => "[]",
});

const COUNT_FACTS: ProjectionToolDeclaration = defineTool({
  name: "count_facts",
  description: "Count finalized facts of one type in a window.",
  gate: "projection",
  columns: ["count"],
  inputSchema: {
    type: "object",
    properties: { fact_type: { type: "string" } },
    required: ["fact_type"],
    additionalProperties: false,
  },
  run: () => "0",
});

interface Answer {
  readonly kind: "answer" | "refusal";
  readonly prose: string;
}

/** The spec under test, rebuilt per case so no case mutates another's. */
function spec(
  overrides: Partial<ExecutionDefinitionSpec<Answer>> = {},
): ExecutionDefinitionSpec<Answer> {
  return {
    instructions: [
      { name: "grounding", text: "Answer only from what the tools returned." },
      { name: "refusal", text: "Refuse questions about conversations." },
    ],
    tools: [READ_TIMELINE, COUNT_FACTS],
    outputFormat: {
      schema: {
        type: "object",
        properties: { kind: { type: "string" }, prose: { type: "string" } },
        required: ["kind", "prose"],
        additionalProperties: false,
      },
      parse: (output) => ({ ok: true, submission: output as Answer }),
    },
    recipes: [
      { recipe: "now", parameters: { at: "instant", timeZone: "zone" } },
    ],
    context: [
      { name: "now", text: "[Now: Tuesday, Sep 1, 2026, 21:30:16 CST (America/Monterrey)]" },
      { name: "question", text: "¿qué quedó pendiente con Torres?" },
    ],
    budget: { model: "claude-sonnet-5", maxIterations: 6, maxTokens: 2048 },
    lane: "realtime",
    wake: { kind: "trigger", mechanism: "request", occasion: "owner_question" },
    dispositionOf: (answer) =>
      answer.kind === "answer" ? "answered" : "wall-refused",
    ...overrides,
  };
}

const BASE = defineExecution(spec()).digest;

describe("the instructions digest (spec #126 user story 38)", () => {
  it("is 32 hex characters, as the extraction contract digest is", () => {
    expect(BASE).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is the same for two definitions written identically", () => {
    expect(defineExecution(spec()).digest).toBe(BASE);
  });

  it("changes when an instruction part's text changes", () => {
    expect(
      defineExecution(
        spec({
          instructions: [
            {
              name: "grounding",
              text: "Answer only from what the tools returned, and cite by reference.",
            },
            { name: "refusal", text: "Refuse questions about conversations." },
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when an instruction part is renamed", () => {
    expect(
      defineExecution(
        spec({
          instructions: [
            { name: "grounded", text: "Answer only from what the tools returned." },
            { name: "refusal", text: "Refuse questions about conversations." },
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when the instruction parts are reordered", () => {
    expect(
      defineExecution(
        spec({ instructions: [...spec().instructions].reverse() }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when a tool leaves the list", () => {
    expect(defineExecution(spec({ tools: [READ_TIMELINE] })).digest).not.toBe(
      BASE,
    );
  });

  it("changes when the tools are reordered", () => {
    expect(
      defineExecution(spec({ tools: [COUNT_FACTS, READ_TIMELINE] })).digest,
    ).not.toBe(BASE);
  });

  it("changes when a tool's description changes", () => {
    expect(
      defineExecution(
        spec({
          tools: [
            defineTool({ ...READ_TIMELINE, description: "Read a timeline." }),
            COUNT_FACTS,
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when a tool's schema changes", () => {
    expect(
      defineExecution(
        spec({
          tools: [
            defineTool({
              ...READ_TIMELINE,
              inputSchema: {
                type: "object",
                properties: {
                  entity_id: { type: "string" },
                  since: { type: "string" },
                },
                required: ["entity_id"],
                additionalProperties: false,
              },
            }),
            COUNT_FACTS,
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when a tool's gate changes", () => {
    // The gate is part of what a tool IS, so a tool that stopped owing a
    // projection must not stamp the same as one that owes it.
    expect(
      defineExecution(
        spec({
          tools: [
            defineTool({
              name: READ_TIMELINE.name,
              description: READ_TIMELINE.description,
              gate: "disclosed-and-undoable-after",
              inputSchema: READ_TIMELINE.inputSchema,
              // An effect's handler returns an outcome and a read's returns
              // a string (#174), so the two cannot share one.
              run: () => PERFORMED,
            }),
            COUNT_FACTS,
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when a read's pinned column set changes", () => {
    expect(
      defineExecution(
        spec({
          tools: [
            defineTool({
              ...READ_TIMELINE,
              columns: [...READ_TIMELINE.columns, "seat_id"],
            }),
            COUNT_FACTS,
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when a tool comes to end the turn (ticket #401)", () => {
    expect(
      defineExecution(spec({ tools: [defineTool({ ...READ_TIMELINE, endsTurn: true }), COUNT_FACTS] })).digest,
    ).not.toBe(BASE);
  });

  it("changes when the structured output's schema changes", () => {
    expect(
      defineExecution(
        spec({
          outputFormat: {
            ...spec().outputFormat!,
            schema: {
              type: "object",
              properties: {
                kind: { type: "string" },
                prose: { type: "string" },
                references: { type: "array", items: { type: "string" } },
              },
              required: ["kind", "prose", "references"],
              additionalProperties: false,
            },
          },
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when any of the four budget fields changes", () => {
    const budget = spec().budget;
    for (const changed of [
      { ...budget, model: "claude-opus-5" },
      { ...budget, maxIterations: 7 },
      { ...budget, maxTokens: 4096 },
      // The effort knob (#178; spec #171 decision 8(2)). It changes how hard
      // the model works before it answers, which is as much a part of what
      // an execution IS as which model ran it.
      { ...budget, effort: "low" as const },
    ]) {
      expect(defineExecution(spec({ budget: changed })).digest).not.toBe(BASE);
    }
  });

  it("stamps two efforts differently, and an absent effort is not `medium`", () => {
    const budget = spec().budget;
    const low = defineExecution(spec({ budget: { ...budget, effort: "low" } })).digest;
    const high = defineExecution(spec({ budget: { ...budget, effort: "high" } })).digest;
    expect(low).not.toBe(high);
    // UNSET IS AN ABSENCE, NOT A LEVEL (`ModelCallConfig`'s own rule): the
    // request carries no `output_config` at all and the model applies its
    // own default, so an unset effort must not stamp as any named one.
    for (const named of [low, high]) expect(named).not.toBe(BASE);
  });

  it("does NOT change when the context inputs change", () => {
    // The stated exclusion, asserted rather than only commented: the
    // context varies per execution by design, so a digest that moved with
    // it could never answer "was this the same instructions".
    expect(
      defineExecution(
        spec({
          context: [
            { name: "now", text: "[Now: Tuesday, Sep 1, 2026, 21:30:16 CST (America/Monterrey)]" },
            { name: "question", text: "¿cuántas cotizaciones dio Mauricio?" },
          ],
        }),
      ).digest,
    ).toBe(BASE);
  });
});

describe("the digest covers the recipes by name and shape, never by value (#178)", () => {
  it("changes when a context recipe is renamed", () => {
    // The recipe NAME is part of what an execution is: `now` and `now_owner`
    // put different lines in front of the model, and a definition that
    // swapped one for the other must not stamp the same.
    expect(
      defineExecution(
        spec({
          recipes: [
            { recipe: "now_owner", parameters: { at: "instant", timeZone: "zone" } },
          ],
        }),
      ).digest,
    ).not.toBe(BASE);
  });

  it("changes when a recipe's parameter is renamed or retyped", () => {
    const shapes: readonly ParameterShape[] = [
      { instant: "instant", timeZone: "zone" },
      { at: "zone", timeZone: "zone" },
      { at: "instant", timeZone: "zone", lagHours: "hours" },
    ];
    for (const parameters of shapes) {
      expect(
        defineExecution(spec({ recipes: [{ recipe: "now", parameters }] })).digest,
      ).not.toBe(BASE);
    }
  });

  it("changes when a recipe joins or leaves the context", () => {
    expect(defineExecution(spec({ recipes: [] })).digest).not.toBe(BASE);
  });

  it("does NOT change across two renderings of the same recipe (AC 2)", () => {
    // THE CLAIM THE ACCEPTANCE CRITERION MAKES, at the seam it makes it: a
    // context VALUE changing must not move the stamp. Two occasions render
    // `now` into two different lines; the recipe, its shape and everything
    // else about the definition are identical, so the digest is too —
    // otherwise every execution of every automation would stamp differently
    // and "was this the same instructions" would have no answer.
    const monday = defineExecution(
      spec({
        context: [
          { name: "now", text: "[Now: Monday, Aug 31, 2026, 09:00:00 CST (America/Monterrey)]" },
          { name: "question", text: "¿y de Torres?" },
        ],
      }),
    );
    const friday = defineExecution(
      spec({
        context: [
          { name: "now", text: "[Now: Friday, Sep 4, 2026, 23:59:59 CST (America/Monterrey)]" },
          { name: "question", text: "¿y de Torres?" },
        ],
      }),
    );
    expect(monday.context).not.toEqual(friday.context);
    expect(monday.digest).toBe(friday.digest);
  });

  it("does NOT change when the lane changes, because the model is never told it", () => {
    // The lane is how the runtime SCHEDULES an execution, not anything the
    // model is shown, and the digest records what the model was told. A lane
    // in the stamp would make the same automation stamp two ways depending
    // on which queue picked it up.
    expect(defineExecution(spec({ lane: "batch" })).digest).toBe(BASE);
  });
});

describe("the budget's 16,000 default (spec #171 decision 8(2))", () => {
  it("fills the output cap the runtime holds, so no definition rediscovers it", () => {
    expect(
      resolveBudget({ maxIterations: 6 }, "claude-sonnet-5"),
    ).toEqual({
      model: "claude-sonnet-5",
      maxIterations: 6,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(DEFAULT_MAX_TOKENS).toBe(16_000);
  });

  it("keeps a cap the spec chose, and carries the effort through", () => {
    expect(
      resolveBudget({ maxIterations: 4, maxTokens: 2048, effort: "low" }, "claude-haiku-5"),
    ).toEqual({
      model: "claude-haiku-5",
      maxIterations: 4,
      maxTokens: 2048,
      effort: "low",
    });
  });

  it("omits effort entirely when the spec named none", () => {
    // Not `effort: undefined`: the key's absence is what the digest and the
    // wire both read as "the model's own default".
    expect(
      Object.hasOwn(resolveBudget({ maxIterations: 6 }, "claude-sonnet-5"), "effort"),
    ).toBe(false);
  });

  it("stamps a spec that omitted the cap the same as one that named 16,000", () => {
    // The default is resolved BEFORE the stamp, and that is the honest
    // reading of what a digest is for: both definitions told the model
    // 16,000, so both are the same instructions.
    const omitted = defineExecution(
      spec({ budget: resolveBudget({ maxIterations: 6 }, "claude-sonnet-5") }),
    );
    const named = defineExecution(
      spec({
        budget: { model: "claude-sonnet-5", maxIterations: 6, maxTokens: 16_000 },
      }),
    );
    expect(omitted.digest).toBe(named.digest);
  });

  it("refuses a rung it was not given, rather than defaulting one (ADR-0015)", () => {
    expect(() => resolveBudget({ maxIterations: 6 }, "")).toThrow(
      ExecutionDefinitionError,
    );
  });
});

describe("a definition refuses what cannot run (ticket #128)", () => {
  it("refuses a tool with no gate, however it got here", () => {
    // The second fence, and the one that bites a tool the type system
    // never saw: `defineExecution` re-runs the tool check over everything
    // it is handed.
    const smuggled = JSON.parse(
      '{"name":"read_timeline","description":"d","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}',
    ) as ToolDeclaration;
    expect(() =>
      defineExecution(
        spec({ tools: [{ ...smuggled, run: () => "[]" } as ToolDeclaration] }),
      ),
    ).toThrow(/gate/);
  });

  it("refuses two tools with the same name", () => {
    expect(() =>
      defineExecution(spec({ tools: [READ_TIMELINE, READ_TIMELINE] })),
    ).toThrow(ExecutionDefinitionError);
  });

  it("refuses no instructions and no context", () => {
    expect(() => defineExecution(spec({ instructions: [] }))).toThrow(
      ExecutionDefinitionError,
    );
    expect(() => defineExecution(spec({ context: [] }))).toThrow(
      ExecutionDefinitionError,
    );
  });

  it("refuses a budget that cannot run", () => {
    const budget = spec().budget;
    expect(() =>
      defineExecution(spec({ budget: { ...budget, model: "" } })),
    ).toThrow(/model/);
    expect(() =>
      defineExecution(spec({ budget: { ...budget, maxIterations: 0 } })),
    ).toThrow(/iteration/);
    expect(() =>
      defineExecution(spec({ budget: { ...budget, maxTokens: 0 } })),
    ).toThrow(/token/);
  });

  it("refuses an effort level the API does not know", () => {
    // A CAST OR A BOUNDARY SETTING GETS ONE HERE (Codex r2). `effort` is a
    // union to the compiler and a string on the wire, so a bad rung
    // configuration used to reach Anthropic and fail the execution at the
    // provider. Absent is not a level, so an absent one is untouched.
    const budget = spec().budget;
    expect(() =>
      defineExecution(
        spec({
          budget: { ...budget, effort: "invalid" as unknown as "low" },
        }),
      ),
    ).toThrow(/effort/u);
    expect(() =>
      defineExecution(spec({ budget: { ...budget, effort: undefined } })),
    ).not.toThrow();
  });

  it("refuses a trigger the definition's wake did not declare", () => {
    // Not this suite's seam — `runner.test.ts` drives it — but the field it
    // turns on is the definition's, so the pair is stated where the shape is.
    expect(defineExecution(spec()).wake).toEqual({
      kind: "trigger",
      mechanism: "request",
      occasion: "owner_question",
    });
  });

  it("refuses a budget that is a number but not a limit", () => {
    // Codex r2: `NaN` and `Infinity` are numbers and both pass a bare
    // `< 1`. The SDK's guard is `if (max_iterations && count >=
    // max_iterations)`, so `NaN` is falsy and removes the limit outright
    // while `Infinity` is never reached — an unbounded model loop from a
    // budget that typechecked. `Number(process.env.X)` on an unset
    // variable is how one arrives.
    const budget = spec().budget;
    for (const maxIterations of [Number.NaN, Infinity, 2.5, -1]) {
      expect(() =>
        defineExecution(spec({ budget: { ...budget, maxIterations } })),
      ).toThrow(/iteration/);
    }
    for (const maxTokens of [Number.NaN, Infinity, 1.5, -1]) {
      expect(() =>
        defineExecution(spec({ budget: { ...budget, maxTokens } })),
      ).toThrow(/token/);
    }
  });
});

describe("the instructions as the model is shown them", () => {
  it("renders each part under its own name, in order", () => {
    expect(
      renderParts([
        { name: "grounding", text: "Answer only from the tools." },
        { name: "refusal", text: "Refuse conversation questions." },
      ]),
    ).toBe(
      "## grounding\n\nAnswer only from the tools.\n\n## refusal\n\nRefuse conversation questions.",
    );
  });
});

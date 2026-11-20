/**
 * The runner, over the scripted model server (ticket #128 ACs 4, 5 and 6;
 * ticket #328; ADR-0028 as amended — "CI never makes a real model call").
 *
 * Every case here drives the REAL Claude Agent SDK and the REAL Claude Code
 * child it spawns; only the model is scripted, by the loopback server the
 * child is pointed at. What is asserted is what a caller sees at this
 * package's boundary — the typed result, the record, the one audit entry —
 * and what the fake recorded the model being shown.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  closeScriptedModels,
  promptOf,
  scriptedModel,
  systemOf,
  toolNamesOf,
  toolResultsOf,
  type ScriptedTurn,
} from "@dito/scripted-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineExecution, type Budget, type ExecutionDefinition, type ExecutionDefinitionSpec } from "./definition.js";
import { workspaceOf } from "./harness.js";
import { ExecutionError, runExecution } from "./runner.js";
import { recordingChain } from "./testing/chain.js";
import { defineTool, type EffectOutcome, type ProjectionToolDeclaration } from "./tool.js";
import type { TraceEvent } from "./trace.js";
import type { Trigger } from "./trigger.js";

// EVERY CASE SPAWNS A CLAUDE CODE CHILD, which takes about half a second
// warm and several on a cold machine — past the unit lane's five-second
// default on CI's first spawn.
vi.setConfig({ testTimeout: 60_000 });

afterEach(closeScriptedModels);

const TRIGGER: Trigger = {
  kind: "owner_question",
  mechanism: "request",
  companyId: "11111111-1111-4111-8111-111111111111",
  ownerQuestionId: "22222222-2222-4222-8222-222222222222",
};

const QUESTION = "¿qué quedó pendiente con Torres?";

/** The two rows the timeline tool serves, and the only rows an answer may cite. */
const TIMELINE_ROWS = '[{"ref":"f1","fact_type":"DatePromised"}]';

/**
 * A typed result roughly as the owner twin declares one — prose plus
 * references plus a kind. Declared here as a test fixture and nowhere in
 * `src`: the shape is the owning app's, and this package's job is to hold the
 * turn to whatever schema and parser it is handed.
 */
interface Answer {
  readonly kind: "answer" | "refusal" | "no-action";
  readonly prose: string;
  readonly references: readonly string[];
}

function isAnswer(input: unknown): input is Answer {
  if (input === null || typeof input !== "object") return false;
  const candidate = input as Record<string, unknown>;
  return (
    (candidate["kind"] === "answer" ||
      candidate["kind"] === "refusal" ||
      candidate["kind"] === "no-action") &&
    typeof candidate["prose"] === "string" &&
    Array.isArray(candidate["references"])
  );
}

function definition(
  budget: Budget = { model: "claude-sonnet-5", maxIterations: 6, maxTokens: 2048 },
): ExecutionDefinition<Answer> {
  return defineExecution<Answer>({
    instructions: [
      { name: "grounding", text: "Answer only from what the tools returned." },
      { name: "refusal", text: "Refuse questions about conversations." },
    ],
    tools: [
      defineTool({
        name: "read_timeline",
        description: "Read one entity's finalized facts in a window.",
        gate: "projection",
        columns: ["ref", "fact_type", "occurred_at"],
        inputSchema: {
          type: "object",
          properties: { entity_id: { type: "string" } },
          required: ["entity_id"],
          additionalProperties: false,
        },
        run: () => TIMELINE_ROWS,
      }),
      defineTool({
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
        run: () => '{"count":1}',
      }),
    ],
    outputFormat: {
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
      parse: (output) =>
        isAnswer(output)
          ? { ok: true, submission: output }
          : { ok: false, reason: "the output does not match its schema" },
    },
    context: [{ name: "question", text: QUESTION }],
    recipes: [],
    budget,
    lane: "realtime",
    wake: { kind: "trigger", mechanism: "request", occasion: "owner_question" },
    dispositionOf: wordOf,
  });
}

/**
 * The same frame ending on its words rather than on a structured output: the
 * model stopping is the turn's ending, and the definition reads it `answered`.
 */
function spoken(budget?: Budget): ExecutionDefinition<Answer> {
  const base = definition(budget);
  return defineExecution<Answer>({
    instructions: base.instructions,
    tools: base.tools,
    context: base.context,
    recipes: base.recipes,
    budget: base.budget,
    lane: base.lane,
    wake: base.wake,
    dispositionOf: () => "answered",
  });
}

/** The disposition an answer's kind reads as. */
function wordOf(answer: Answer): "answered" | "wall-refused" | "no-action" {
  return answer.kind === "answer"
    ? "answered"
    : answer.kind === "refusal"
      ? "wall-refused"
      : "no-action";
}

const ANSWER = {
  kind: "answer",
  prose: "Quedó una fecha prometida el jueves.",
  references: ["f1"],
};

/** A two-tool sequence, then the structured output the turn ends on. */
const TWO_TOOL_SCRIPT: ScriptedTurn[] = [
  {
    toolCall: { name: "read_timeline", input: { entity_id: "e1" } },
    usage: { inputTokens: 1200, outputTokens: 40 },
  },
  {
    toolCall: { name: "count_facts", input: { fact_type: "DatePromised" } },
    usage: { inputTokens: 1310, outputTokens: 35 },
  },
  {
    structured: ANSWER,
    usage: { inputTokens: 1450, outputTokens: 120 },
  },
];

describe("the runner returns a typed result, never free text (ADR-0014)", () => {
  it("runs a two-tool sequence and hands back the typed result and its record", async () => {
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain } = recordingChain();
    const execution = definition();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: execution,
      chain,
    });

    expect(outcome.submission).toEqual(ANSWER);
    expect(outcome.record.disposition).toBe("answered");
    expect(outcome.record.trigger).toEqual(TRIGGER);
    expect(outcome.record.instructionsDigest).toBe(execution.digest);
    expect(outcome.record.toolNames).toEqual(["read_timeline", "count_facts"]);

    // Iterations are the model calls the child really made — one
    // `/v1/messages` request each (#328 AC 1) — and the tokens are the whole
    // execution's, not the last call's: 1200+1310+1450 in, 40+35+120 out.
    expect(outcome.record.iterations).toBe(3);
    expect(requests).toHaveLength(3);
    expect(outcome.record.tokens).toEqual({ input: 3960, output: 195 });

    expect(outcome.record.endedAt.getTime()).toBeGreaterThanOrEqual(
      outcome.record.startedAt.getTime(),
    );
    // THE RECORD'S SHAPE IS THE ONE IT HAD BEFORE THE HARNESS MOVED (#328
    // AC 2): the same nine fields, read by every store that persists it.
    expect(Object.keys(outcome.record).sort()).toEqual([
      "disposition",
      "endedAt",
      "instructionsDigest",
      "iterations",
      "lane",
      "startedAt",
      "tokens",
      "toolNames",
      "trigger",
    ]);
  });

  it("really went around the loop: the tools' rows came back to the model", async () => {
    // The claim the record cannot make: this is the REAL loop, so request 2
    // must carry the first tool's result — the rows the read served — back
    // into the conversation.
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain } = recordingChain();

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition(),
      chain,
    });

    expect(toolResultsOf(requests[1])).toEqual([TIMELINE_ROWS]);
    // And the model was shown the instructions and the context this
    // execution was defined with, in the order they were declared.
    const system = systemOf(requests[0]);
    expect(system).toContain("## grounding");
    expect(system.indexOf("## grounding")).toBeLessThan(system.indexOf("## refusal"));
    expect(promptOf(requests[0]!)).toBe(`## question\n\n${QUESTION}`);
  });

  it("hands the budget to the loop as the definition declares it", async () => {
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain } = recordingChain();

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition({
        model: "claude-opus-5",
        maxIterations: 6,
        maxTokens: 512,
      }),
      chain,
    });

    expect(requests[0]?.["model"]).toBe("claude-opus-5");
    // The output cap reaches the child as its own variable, and the child
    // puts it on every call.
    expect(requests.map((request) => request["max_tokens"])).toEqual([512, 512, 512]);
  });

  it("sends the budget's effort, and none at all when the budget names none", async () => {
    // AN UNSET EFFORT IS AN ABSENCE (`Budget.effort`): the model's own
    // default, which a child left to its own devices would replace with its.
    const unset = scriptedModel(TWO_TOOL_SCRIPT);
    await runExecution({
      harness: unset.harness,
      trigger: TRIGGER,
      definition: definition(),
      chain: recordingChain().chain,
    });
    expect(unset.requests[0]).not.toHaveProperty("output_config");

    const low = scriptedModel(TWO_TOOL_SCRIPT);
    await runExecution({
      harness: low.harness,
      trigger: TRIGGER,
      definition: definition({
        model: "claude-sonnet-5",
        maxIterations: 6,
        maxTokens: 2048,
        effort: "low",
      }),
      chain: recordingChain().chain,
    });
    expect(low.requests[0]?.["output_config"]).toEqual({ effort: "low" });
  });

  it("assigns each of the app's dispositions from the typed result's kind", async () => {
    for (const [kind, disposition] of [
      ["answer", "answered"],
      ["refusal", "wall-refused"],
      ["no-action", "no-action"],
    ] as const) {
      const { harness } = scriptedModel([{ structured: { kind, prose: "…", references: [] } }]);
      const { chain, entries } = recordingChain();

      const outcome = await runExecution({
        harness,
        trigger: TRIGGER,
        definition: definition(),
        chain,
      });

      expect(outcome.record.disposition).toBe(disposition);
      expect(entries[0]?.outcome).toBe(disposition);
    }
  });
});

describe("the runner fails loudly (ticket #128 AC 5)", () => {
  it("refuses a complete output the provider marked truncated (ticket #176, Codex r1)", async () => {
    // The guard lives here, where every automation inherits it. The output
    // below is COMPLETE and would parse: what refuses it is the flag on the
    // response carrying it.
    for (const stopReason of ["max_tokens", "model_context_window_exceeded"] as const) {
      // The child still runs the call and asks again, as the loop always
      // did; what refuses the run is the flag on the response carrying it.
      const { harness } = scriptedModel([
        {
          structured: { kind: "answer", prose: "Torres quedó pendiente.", references: ["f1"] },
          stopReason,
        },
        { structured: { kind: "answer", prose: "Torres quedó pendiente.", references: ["f1"] } },
      ]);
      const { chain, entries } = recordingChain();

      const failure = await runExecution({
        harness,
        trigger: TRIGGER,
        definition: definition(),
        chain,
      }).catch((error: unknown) => error);

      expect(failure, stopReason).toBeInstanceOf(ExecutionError);
      const error = failure as ExecutionError;
      expect(error.message).toContain(stopReason);
      // It NAMES THE BUDGET rather than blaming the model: the misreading
      // #148 came from is a budget failure diagnosed as a model failure.
      expect(error.message).toContain("2048");
      expect(error.record.disposition).toBe("failed");
      // The trace survives, as it does for every other refusal.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.outcome).toBe("failed");
    }
  });

  it("records `failed` when the model call itself fails", async () => {
    // The scripted model exhausts loudly — a 400 the child reports as an
    // API error — which is a wire failure as far as the runner is concerned. It is still an execution that
    // happened, so it leaves a record and an entry rather than escaping
    // untraced.
    const { harness } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
    ]);
    const { chain, entries } = recordingChain();

    const failure = (await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition(),
      chain,
    }).catch((error: unknown) => error)) as ExecutionError;

    expect(failure).toBeInstanceOf(ExecutionError);
    expect(failure.message).toContain("the model call failed");
    expect(failure.record.disposition).toBe("failed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("failed");
  });
});

describe("the trigger must be the one the automation declared (#178, Codex r2)", () => {
  it("refuses a trigger whose occasion is not the wake's, before any model call", async () => {
    // The automation's wake names the occasion and the mechanism; the
    // trigger carries them into the record and onto an APPEND-ONLY chain.
    // Two independent statements of one pair of words meant a definition
    // could be run and audited as something it was not, with nothing in the
    // record to say so.
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain, entries } = recordingChain();
    await expect(
      runExecution({
        harness,
        trigger: { ...TRIGGER, kind: "chat_turn" as "owner_question" },
        definition: definition(),
        chain,
      }),
    ).rejects.toThrow(/chat_turn/u);
    // ...and nothing ran: no request, no entry.
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("refuses a trigger whose mechanism is not the wake's", async () => {
    const { harness } = scriptedModel(TWO_TOOL_SCRIPT);
    await expect(
      runExecution({
        harness,
        trigger: { ...TRIGGER, mechanism: "seam_event" as "request" },
        definition: definition(),
        chain: recordingChain().chain,
      }),
    ).rejects.toThrow(/seam_event/u);
  });
});

describe("exactly one content-free audit entry per execution (ADR-0020, AC 6)", () => {
  it("appends one entry, whatever the execution did", async () => {
    const { harness } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain, entries } = recordingChain();
    const execution = definition();

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: execution,
      chain,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      caller: "execution",
      action: "execution",
      ref: `trigger:owner_question mechanism:request company:${TRIGGER.companyId} owner_question:${TRIGGER.ownerQuestionId} instructions:${execution.digest}`,
      outcome: "answered",
    });
  });

  it("carries the four fields ADR-0020 allows and nothing the model said", async () => {
    const { harness } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain, entries } = recordingChain();

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition(),
      chain,
    });

    const entry = entries[0]!;
    expect(Object.keys(entry).sort()).toEqual([
      "action",
      "caller",
      "outcome",
      "ref",
    ]);
    // Content-free, checked against the content that actually passed
    // through this execution: the owner's question, the twin's prose, and
    // the rows a tool served.
    const written = JSON.stringify(entry);
    for (const content of [QUESTION, ANSWER.prose, TIMELINE_ROWS]) {
      expect(written).not.toContain(content);
    }
  });
});

describe("what the SDK hides, this runtime does not (Codex r1)", () => {
  /** One read whose handler fails, the way a database call fails. */
  function withFailingRead(): ExecutionDefinition<Answer> {
    const base = definition();
    return defineExecution<Answer>({
      ...base,
      tools: [
        defineTool({
          name: "read_timeline",
          description: "Read one entity's finalized facts in a window.",
          gate: "projection",
          columns: ["ref", "fact_type"],
          inputSchema: {
            type: "object",
            properties: { entity_id: { type: "string" } },
            required: ["entity_id"],
            additionalProperties: false,
          },
          run: () => {
            throw new Error("connection terminated unexpectedly");
          },
        }),
      ],
    });
  }

  it("fails an execution whose read threw, even when the model answered anyway", async () => {
    // The model is handed the failure as an error result and carries on —
    // so without this the model's confident answer over a failed read would
    // come back `answered`.
    const { harness } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { structured: ANSWER },
    ]);
    const { chain, entries } = recordingChain();

    const failure = (await runExecution({
      harness,
      trigger: TRIGGER,
      definition: withFailingRead(),
      chain,
    }).catch((error: unknown) => error)) as ExecutionError;

    expect(failure).toBeInstanceOf(ExecutionError);
    expect(failure.message).toContain("connection terminated unexpectedly");
    expect(failure.record.disposition).toBe("failed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("failed");
  });

  it("refuses a tool call carrying a parameter the schema never declared", async () => {
    // `additionalProperties: false` is only a sentence until something
    // reads it: the MCP server validates nothing. The handler is never called and
    // the model is told why.
    let served = 0;
    const base = definition();
    const watched = defineExecution<Answer>({
      ...base,
      tools: [
        defineTool({
          name: "read_timeline",
          description: "Read one entity's finalized facts in a window.",
          gate: "projection",
          columns: ["ref", "fact_type"],
          inputSchema: {
            type: "object",
            properties: { entity_id: { type: "string" } },
            required: ["entity_id"],
            additionalProperties: false,
          },
          run: () => {
            served += 1;
            return TIMELINE_ROWS;
          },
        }),
      ],
    });

    const { harness, requests } = scriptedModel([
      {
        toolCall: {
          name: "read_timeline",
          input: { entity_id: "e1", company_id: "another-company" },
        },
      },
      { structured: ANSWER },
    ]);
    const { chain } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: watched,
      chain,
    });

    expect(served).toBe(0);
    expect(JSON.stringify(requests[1]?.["messages"])).toContain(
      "`company_id` is not a parameter of this tool",
    );
    // The execution itself is untouched: a refused tool call is a tool
    // result like any other, and the model went on to answer.
    expect(outcome.record.disposition).toBe("answered");
  });

  it("fails when the definition cannot read how its turn ended", async () => {
    // `dispositionOf` is the owning app's code: a throw there lands the turn
    // `failed`, with its record and its one audit entry.
    const base = definition();
    const broken = defineExecution<Answer>({
      ...base,
      dispositionOf: () => {
        throw new Error("owner-side lookup failed");
      },
    });
    const { harness } = scriptedModel([
      { structured: ANSWER },
    ]);
    const { chain, entries } = recordingChain();

    const failure = (await runExecution({
      harness,
      trigger: TRIGGER,
      definition: broken,
      chain,
    }).catch((error: unknown) => error)) as ExecutionError;

    expect(failure).toBeInstanceOf(ExecutionError);
    expect(failure.message).toContain("owner-side lookup failed");
    expect(failure.record.disposition).toBe("failed");
    expect(entries).toHaveLength(1);
  });

  it("refuses a disposition the closed set does not hold", async () => {
    const base = definition();
    const invented = defineExecution<Answer>({
      ...base,
      // Past the type, the way a definition assembled from configuration
      // would arrive.
      dispositionOf: () => "answered-ish" as never,
    });
    const { harness } = scriptedModel([
      { structured: ANSWER },
    ]);
    const { chain, entries } = recordingChain();

    const failure = (await runExecution({
      harness,
      trigger: TRIGGER,
      definition: invented,
      chain,
    }).catch((error: unknown) => error)) as ExecutionError;

    expect(failure.message).toContain("answered-ish");
    expect(failure.record.disposition).toBe("failed");
    expect(entries[0]?.outcome).toBe("failed");
  });

  it("refuses to run a hand-built definition carrying a gateless tool", async () => {
    // `ExecutionDefinition` is a plain interface, so a definition can be
    // written by hand and never pass `defineExecution`. The runner is the
    // boundary where "cannot be constructed without a gate" has to become
    // "cannot be RUN without one" — the next thing that happens is a model
    // calling it.
    const forged = {
      ...definition(),
      tools: [
        {
          name: "read_everything",
          description: "no gate at all",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          run: () => "[]",
        },
      ],
    } as unknown as ExecutionDefinition<Answer>;
    const { harness, requests } = scriptedModel([{ text: "listo" }]);
    const { chain, entries } = recordingChain();

    await expect(
      runExecution({
        harness,
        trigger: TRIGGER,
        definition: forged,
        chain,
      }),
    ).rejects.toThrow(/gate/);
    // Refused before the model was ever called, so nothing ran and nothing
    // was chained.
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("refuses a definition whose budget was changed after it was stamped", async () => {
    // Codex r3, reproduced: spread a stamped definition, replace
    // `maxIterations` with NaN, keep the old digest. A NaN turn cap is no
    // cap at all, so the run is refused before the child is spawned.
    const stamped = definition({
      model: "claude-sonnet-5",
      maxIterations: 1,
      maxTokens: 2048,
    });
    const unbounded: ExecutionDefinition<Answer> = {
      ...stamped,
      budget: { ...stamped.budget, maxIterations: Number.NaN },
    };
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain, entries } = recordingChain();

    await expect(
      runExecution({
        harness,
        trigger: TRIGGER,
        definition: unbounded,
        chain,
      }),
    ).rejects.toThrow(/iteration/);
    expect(requests).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("refuses a definition whose instructions were changed after it was stamped", async () => {
    // The stamp goes into the record AND into the append-only chain. A
    // stale one makes both attest to instructions that were not the ones
    // used, which is the single thing stamping exists to prevent.
    const stamped = definition();
    const drifted: ExecutionDefinition<Answer> = {
      ...stamped,
      instructions: [{ name: "grounding", text: "Answer however you like." }],
    };
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);
    const { chain } = recordingChain();

    await expect(
      runExecution({ harness, trigger: TRIGGER, definition: drifted, chain }),
    ).rejects.toThrow(/stamp/);
    expect(requests).toHaveLength(0);
  });

  it("refuses a tool call that omits a required selector", async () => {
    let served = 0;
    const base = definition();
    const watched = defineExecution<Answer>({
      ...base,
      tools: [
        defineTool({
          name: "read_timeline",
          description: "Read one entity's finalized facts in a window.",
          gate: "projection",
          columns: ["ref", "fact_type"],
          inputSchema: {
            type: "object",
            properties: { entity_id: { type: "string" } },
            required: ["entity_id"],
            additionalProperties: false,
          },
          run: () => {
            served += 1;
            return TIMELINE_ROWS;
          },
        }),
      ],
    });
    const { harness, requests } = scriptedModel([
      { toolCall: { name: "read_timeline", input: {} } },
      { structured: ANSWER },
    ]);
    const { chain } = recordingChain();

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: watched,
      chain,
    });

    expect(served).toBe(0);
    expect(JSON.stringify(requests[1]?.["messages"])).toContain(
      "`entity_id` is required and was not given",
    );
  });

  it("refuses `failed` from the owning app, the one word only the runner assigns", async () => {
    const base = definition();
    const forged = defineExecution<Answer>({
      ...base,
      dispositionOf: () => "failed" as never,
    });
    const { harness } = scriptedModel([
      { structured: ANSWER },
    ]);
    const { chain } = recordingChain();

    const failure = (await runExecution({
      harness,
      trigger: TRIGGER,
      definition: forged,
      chain,
    }).catch((error: unknown) => error)) as ExecutionError;

    expect(failure.message).toContain("failed is this runtime's own");
    expect(failure.record.disposition).toBe("failed");
  });
});

/**
 * One effect tool whose outcome the script decides, call by call, and a
 * definition that reads `acted` off what its tools reported.
 *
 * AT MODULE SCOPE because several describes need it: `acted` is proven over
 * it, and so is the trace, and a second copy of this fixture is the copy
 * that drifts.
 */
function acting(
  outcomes: readonly EffectOutcome[],
): ExecutionDefinition<Answer> {
  let next = 0;
  const base = definition();
  return defineExecution<Answer>({
    ...base,
    tools: [
      ...base.tools,
      defineTool({
        name: "dismiss_draft",
        description: "Discard the draft the rep quoted.",
        gate: "rep-evidenced",
        evidence: "evidence",
        inputSchema: {
          type: "object",
          properties: { evidence: { type: "string" } },
          required: ["evidence"],
          additionalProperties: false,
        },
        run: () => {
          const outcome = outcomes[next];
          next += 1;
          if (outcome === undefined) throw new Error("no outcome scripted");
          return outcome;
        },
      }),
    ],
    dispositionOf: (answer, _handled, ending) =>
      ending.effects.some((effect) => effect.performed) ? "acted" : wordOf(answer),
  });
}

const PERFORMED: EffectOutcome = {
  performed: true,
  told: "the draft is discarded",
  receipt: "Descartado",
  act: "dismissed",
};
const REFUSED: EffectOutcome = {
  performed: false,
  told: "that draft was already sent",
  act: "correction_refused",
};

/**
 * `acted` IS READ OFF WHAT A TOOL DID (ticket #174; spec #171 decision 11).
 *
 * Not a claim about the plumbing but about what a model can and cannot
 * produce: the distinction between «I dismissed it» and «I said I dismissed
 * it» has to be drawn from what a tool DID, or the second sentence is
 * indistinguishable from the first everywhere downstream — the disposition,
 * the receipt and the seam's own marker all rest on it.
 */
describe("acted comes from performed effects, never from the model's prose", () => {
  const CALL_THEN_ANSWER: ScriptedTurn[] = [
    { toolCall: { name: "dismiss_draft", input: { evidence: "e1" } } },
    { structured: ANSWER },
  ];

  it("assigns acted when an effect tool performed and the reply was accepted", async () => {
    const { harness } = scriptedModel(CALL_THEN_ANSWER);
    const { chain, entries } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([PERFORMED]),
      chain,
    });

    expect(outcome.record.disposition).toBe("acted");
    // The chain entry attests to the same word the record carries: an
    // execution that acted must not read as one that merely answered.
    expect(entries[0]?.outcome).toBe("acted");
    expect(outcome.effects).toEqual([PERFORMED]);
  });

  it("stays answered when the only effect call was refused", async () => {
    const { harness } = scriptedModel(CALL_THEN_ANSWER);
    const { chain } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([REFUSED]),
      chain,
    });

    expect(outcome.record.disposition).toBe("answered");
    expect(outcome.effects).toEqual([REFUSED]);
  });

  it("stays answered when the prose claims an effect and no tool was called", async () => {
    // THE CASE THE WORD EXISTS FOR. The answer says the draft was
    // discarded; nothing was called; the effect list is empty, so there is
    // nothing for a receipt to render from and nothing to read `acted` off.
    const { harness } = scriptedModel([{ structured: { ...ANSWER, prose: "Listo, lo descarté." } }]);
    const { chain } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([]),
      chain,
    });

    expect(outcome.record.disposition).toBe("answered");
    expect(outcome.effects).toEqual([]);
  });

  it("hands the model the outcome's own words as the tool result", async () => {
    // The effect's account of itself reaches the conversation, so the model
    // can relay a refusal it did not choose — and so the runtime's record
    // and what the model was told come from ONE value.
    const { harness, requests } = scriptedModel(CALL_THEN_ANSWER);
    const { chain } = recordingChain();

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([REFUSED]),
      chain,
    });

    expect(JSON.stringify(requests[1]?.["messages"])).toContain(
      "that draft was already sent",
    );
  });

  it("records every effect call in order, refusals included", async () => {
    const { harness } = scriptedModel([
      { toolCall: { name: "dismiss_draft", input: { evidence: "e1" } } },
      { toolCall: { name: "dismiss_draft", input: { evidence: "e1" } } },
      { structured: ANSWER },
    ]);
    const { chain } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([PERFORMED, REFUSED]),
      chain,
    });

    expect(outcome.effects).toEqual([PERFORMED, REFUSED]);
    expect(outcome.record.disposition).toBe("acted");
  });

  it("does not record a call the schema check refused before the handler", async () => {
    // A missing required parameter never reaches the handler, so it is not
    // an effect call at all — nothing to read `acted` off, nothing to
    // acknowledge.
    const { harness } = scriptedModel([
      { toolCall: { name: "dismiss_draft", input: {} } },
      { structured: ANSWER },
    ]);
    const { chain } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([]),
      chain,
    });

    expect(outcome.effects).toEqual([]);
    expect(outcome.record.disposition).toBe("answered");
  });
});

/**
 * THE SDK'S TURN CAP ENDS THE LOOP (ticket #328; #311).
 *
 * The runner asks nothing of a model that stops early and gives nothing
 * extra to one that spends its budget: a prose ending with no structured
 * output fails at once, and a run the cap stops fails with its record intact.
 * Both are `failed`, and the failure names the budget.
 */
describe("a run ends where its model or its turn cap ends it (#328)", () => {
  const THREE = { model: "claude-sonnet-5", maxIterations: 3, maxTokens: 2048 };
  const READS: ScriptedTurn[] = [
    { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
    { toolCall: { name: "read_timeline", input: { entity_id: "e2" } } },
    { toolCall: { name: "count_facts", input: { fact_type: "DatePromised" } } },
  ];

  it("ends a turn on the model's prose after that one call, asking nothing more", async () => {
    const { harness, requests } = scriptedModel([{ text: "Listo." }]);
    const { chain, entries } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: spoken(),
      chain,
    });

    expect(outcome.words).toBe("Listo.");
    expect(outcome.record.iterations).toBe(1);
    expect(requests).toHaveLength(1);
    expect(entries).toHaveLength(1);
  });

  it("fails a run that reaches its turn cap without its output, with the record intact", async () => {
    // The script holds a fourth turn the cap must never reach.
    const { harness, requests } = scriptedModel([...READS, { structured: ANSWER }]);
    const { chain, entries } = recordingChain();

    const failure = (await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition(THREE),
      chain,
    }).catch((error: unknown) => error)) as ExecutionError;

    expect(failure).toBeInstanceOf(ExecutionError);
    expect(failure.message).toContain(
      "the turn cap stopped the execution before the model did, within a budget of 3 iterations",
    );
    expect(failure.record.disposition).toBe("failed");
    expect(failure.record.iterations).toBe(3);
    expect(failure.record.tokens).toEqual({ input: 3, output: 3 });
    expect(requests).toHaveLength(3);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("failed");
  });

  it("settles an output given on the last turn the cap allows", async () => {
    // One round, and the turn ends on its output inside the cap.
    const { harness, requests } = scriptedModel([{ structured: ANSWER }]);
    const { chain } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition({ model: "claude-sonnet-5", maxIterations: 1, maxTokens: 2048 }),
      chain,
    });

    expect(outcome.submission).toEqual(ANSWER);
    expect(outcome.record.iterations).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("refuses prose the provider cut off, whatever the child does next", async () => {
    // The child answers a cut-off text with a continuation request of its
    // own; the run is refused by the flag on the first response either way.
    for (const stopReason of ["max_tokens", "model_context_window_exceeded"] as const) {
      const { harness } = scriptedModel([
        { text: "Listo, ya lo…", stopReason },
        { text: "…mandé." },
      ]);
      const failure = (await runExecution({
        harness,
        trigger: TRIGGER,
        definition: spoken(),
        chain: recordingChain().chain,
      }).catch((error: unknown) => error)) as ExecutionError;

      expect(failure.message, stopReason).toContain(stopReason);
    }
  });
});

/**
 * WHAT THE MODEL CAN CALL IS THE DEFINITION'S LIST AND NOTHING ELSE (ticket
 * #328 AC 3; spike #290 fact 1).
 */
describe("the tool list is the definition's", () => {
  it("offers the definition's tools and the structured output, and no other SDK tool", async () => {
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition(),
      chain: recordingChain().chain,
    });

    // The child lists them in its own order, so the claim is about the set.
    for (const request of requests) {
      expect(toolNamesOf(request).sort()).toEqual(["StructuredOutput", "count_facts", "read_timeline"]);
    }
    expect(toolNamesOf(requests[0], { prefixed: true }).sort()).toEqual([
      "StructuredOutput",
      "mcp__dito__count_facts",
      "mcp__dito__read_timeline",
    ]);
  });

  it("denies a tool off the list, and the model is told so as that call's error", async () => {
    const { harness, requests } = scriptedModel([
      { toolCall: { name: "Bash", input: { command: "ls" } } },
      { structured: ANSWER },
    ]);
    const events: TraceEvent[] = [];

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition(),
      chain: recordingChain().chain,
      trace: (event) => events.push(event),
    });

    const messages = requests[1]?.["messages"] as { content?: unknown }[];
    const denial = messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find(
        (block: { type?: string }) => block.type === "tool_result",
      ) as { is_error?: boolean; tool_use_id?: string } | undefined;
    expect(denial).toMatchObject({ is_error: true, tool_use_id: "toolu_scripted_1" });
    expect(toolResultsOf(requests[1])[0]).toContain("Bash");
    expect(
      events
        .filter((event) => event.kind === "tool_call")
        .map((event) => `${event.tool} ${event.outcome}`),
    ).toEqual(["Bash rejected", "StructuredOutput recorded"]);
    // A denied call is the model being told no, not a failure of the run.
    expect(outcome.record.disposition).toBe("answered");
  });
});

/**
 * THE SDK'S OWN TOOLS, ALLOWED BY NAME ON THE WORKSPACE (ticket #326; spec
 * #318 decision 9; ADR-0014 as amended): a definition is served the SDK tools
 * it names and no other, a file tool reaches the workspace and nowhere else,
 * and a write is an effect the turn performed.
 */
describe("the SDK's own tools are the definition's, on the workspace", () => {
  function writing(sdkTools: ExecutionDefinitionSpec<undefined>["sdkTools"]): ExecutionDefinition<undefined> {
    return defineExecution<undefined>({
      instructions: [{ name: "the step", text: "Write the document." }],
      tools: [],
      sdkTools,
      context: [{ name: "the ask", text: "ármame un documento" }],
      recipes: [],
      budget: { model: "claude-sonnet-5", maxIterations: 6, maxTokens: 2048 },
      lane: "batch",
      wake: { kind: "trigger", mechanism: "request", occasion: "owner_question" },
      dispositionOf: (_output, _handled, ending) =>
        ending.effects.some((effect) => effect.performed) ? "acted" : ending.words !== "" ? "answered" : "no-action",
    });
  }

  it("serves a definition naming Write that tool and no other of the SDK's — no Bash, no web search", async () => {
    const { harness, requests } = scriptedModel([{ text: "listo" }]);

    const outcome = await runExecution({ harness, trigger: TRIGGER, definition: writing(["Read", "Write"]), chain: recordingChain().chain });

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(toolNamesOf(request).sort()).toEqual(["Read", "Write"]);
    }
    expect(outcome.record.toolNames).toEqual(["Read", "Write"]);
  });

  it("serves a definition naming no SDK tool none of them", async () => {
    const { harness, requests } = scriptedModel(TWO_TOOL_SCRIPT);

    const outcome = await runExecution({ harness, trigger: TRIGGER, definition: definition(), chain: recordingChain().chain });

    for (const request of requests) {
      expect(toolNamesOf(request).sort()).toEqual(["StructuredOutput", "count_facts", "read_timeline"]);
    }
    expect(outcome.record.toolNames).toEqual(["read_timeline", "count_facts"]);
  });

  it("denies a write outside the workspace and lands one inside, which the turn performed", async () => {
    const model = scriptedModel((): ScriptedTurn[] => [
      { toolCall: { name: "Write", input: { file_path: join(workspaceOf(model.harness), "../outside.md"), content: "x" } } },
      { toolCall: { name: "Write", input: { file_path: join(workspaceOf(model.harness), "hoteles.md"), content: "# Hoteles en Madrid\n" } } },
      { text: "" },
    ]);
    const events: TraceEvent[] = [];

    const outcome = await runExecution({
      harness: model.harness,
      trigger: TRIGGER,
      definition: writing(["Write"]),
      chain: recordingChain().chain,
      trace: (event) => events.push(event),
    });

    expect(
      events.flatMap((event) => (event.kind === "tool_call" ? [`${event.tool} ${event.outcome}`] : [])),
    ).toEqual(["Write rejected", "Write performed"]);
    expect(existsSync(join(model.harness.directory, "outside.md"))).toBe(false);
    expect(readFileSync(join(workspaceOf(model.harness), "hoteles.md"), "utf8")).toBe("# Hoteles en Madrid\n");
    expect(toolResultsOf(model.requests[1])[0]).toContain("outside your workspace");
    expect(outcome.effects).toEqual([{ performed: true, act: "wrote", told: "Write: hoteles.md" }]);
    expect(outcome.record.disposition).toBe("acted");
  });

  it("denies a write through a link that leads out of the workspace", async () => {
    const model = scriptedModel((): ScriptedTurn[] => [
      { toolCall: { name: "Write", input: { file_path: join(workspaceOf(model.harness), "fuera", "x.md"), content: "x" } } },
      { text: "" },
    ]);
    mkdirSync(workspaceOf(model.harness), { recursive: true });
    mkdirSync(join(model.harness.directory, "config"), { recursive: true });
    symlinkSync(join(model.harness.directory, "config"), join(workspaceOf(model.harness), "fuera"));
    const events: TraceEvent[] = [];

    await runExecution({
      harness: model.harness,
      trigger: TRIGGER,
      definition: writing(["Write"]),
      chain: recordingChain().chain,
      trace: (event) => events.push(event),
    });

    expect(events.flatMap((event) => (event.kind === "tool_call" ? [`${event.tool} ${event.outcome}`] : []))).toEqual([
      "Write rejected",
    ]);
    expect(existsSync(join(model.harness.directory, "config", "x.md"))).toBe(false);
  });

  it("keeps a path that climbs through a link with `..` inside the workspace: the CLI resolves it by its words before the hook and the write (Codex r2)", async () => {
    const model = scriptedModel((): ScriptedTurn[] => [
      { toolCall: { name: "Write", input: { file_path: `${workspaceOf(model.harness)}/fuera/../x.md`, content: "x" } } },
      { text: "" },
    ]);
    mkdirSync(join(model.harness.directory, "elsewhere", "deep"), { recursive: true });
    mkdirSync(workspaceOf(model.harness), { recursive: true });
    symlinkSync(join(model.harness.directory, "elsewhere", "deep"), join(workspaceOf(model.harness), "fuera"));
    const events: TraceEvent[] = [];

    await runExecution({
      harness: model.harness,
      trigger: TRIGGER,
      definition: writing(["Write"]),
      chain: recordingChain().chain,
      trace: (event) => events.push(event),
    });

    expect(events.flatMap((event) => (event.kind === "tool_call" ? [`${event.tool} ${event.outcome}`] : []))).toEqual([
      "Write performed",
    ]);
    expect(existsSync(join(model.harness.directory, "elsewhere", "x.md"))).toBe(false);
    expect(readFileSync(join(workspaceOf(model.harness), "x.md"), "utf8")).toBe("x");
  });

  it("refuses a definition that names Bash or WebFetch", () => {
    for (const name of ["Bash", "WebFetch"]) {
      expect(() => writing([name as "Read"])).toThrow(/Bash and WebFetch stay off/u);
    }
  });
});

/**
 * THE CHILD'S ENVIRONMENT, AS THE CHILD RECEIVED IT (ticket #328 AC 4).
 *
 * Recorded by the child itself: the harness names an executable that writes
 * its own environment into its home and then becomes the real Claude Code,
 * so what is asserted is what the process had, not what the runner meant to
 * give it.
 */
describe("the child's environment is built, never inherited", () => {
  /** The Claude Code binary the SDK ships for this platform. */
  function bundledClaude(): string {
    const sdk = realpathSync(
      createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
    );
    return join(
      dirname(dirname(sdk)),
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
  }

  it("carries the fixed variables, a config directory inside the harness directory, and nothing of the parent but its PATH", async () => {
    const { harness } = scriptedModel(TWO_TOOL_SCRIPT);
    const recorder = join(harness.directory, "record-env.sh");
    writeFileSync(
      recorder,
      `#!/bin/sh\n/usr/bin/env > "$HOME/child.env"\nexec "${bundledClaude()}" "$@"\n`,
    );
    chmodSync(recorder, 0o755);

    await runExecution({
      harness: { ...harness, executable: recorder },
      trigger: TRIGGER,
      definition: definition(),
      chain: recordingChain().chain,
    });

    const env = Object.fromEntries(
      readFileSync(join(harness.directory, "child.env"), "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env).toMatchObject({
      DISABLE_COMPACT: "1",
      DISABLE_TELEMETRY: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      HOME: harness.directory,
      CLAUDE_CONFIG_DIR: join(harness.directory, "config"),
      ANTHROPIC_BASE_URL: harness.baseUrl,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
    });
    // NOTHING OF THE PARENT BUT ITS PATH: not its home, not its database,
    // not its credentials.
    expect(env["PATH"]).toBe(process.env["PATH"]);
    expect(env["DITO_TEST_DATABASE_URL"]).toBeUndefined();
    expect(env["AWS_REGION"]).toBeUndefined();
    const withoutPath = Object.entries(env).filter(([name]) => name !== "PATH");
    expect(JSON.stringify(withoutPath)).not.toContain(
      process.env["HOME"] ?? "/nonexistent-home",
    );
  });
});

/**
 * WHAT ONE EXECUTION DID, ROUND BY ROUND (#177 hotfix 1; `trace.ts` argues
 * why it exists).
 *
 * The claim is that the trace is a faithful account of the loop, so it is
 * asserted over a run whose script names every outcome a call can carry: a
 * read that returned, an effect that performed, an output the parser
 * rejected, and the one it recorded.
 */
describe("the trace says what each round did (#177 hotfix 1)", () => {
  it("names every tool call in order, with the outcome each one carried", async () => {
    const { harness } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { toolCall: { name: "dismiss_draft", input: { evidence: "e1" } } },
      { structured: { kind: "guess", prose: "creo que sí", references: [] } },
      { structured: ANSWER },
    ]);
    const { chain } = recordingChain();
    const events: TraceEvent[] = [];

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: acting([PERFORMED]),
      chain,
      trace: (event) => events.push(event),
    });

    expect(outcome.record.disposition).toBe("acted");
    expect(
      events
        .filter((event) => event.kind === "tool_call")
        .map((event) => `${event.tool} ${event.outcome}`),
    ).toEqual([
      "read_timeline returned",
      "dismiss_draft performed",
      "StructuredOutput rejected",
      "StructuredOutput recorded",
    ]);
    // Each call is placed in the round whose response asked for it, and the
    // tools' own words travel with it.
    const calls = events.filter((event) => event.kind === "tool_call");
    expect(calls.map((call) => call.iteration)).toEqual([1, 2, 3, 4]);
    expect(calls[0]?.result).toBe(TIMELINE_ROWS);
    expect(calls[1]?.result).toBe(PERFORMED.told);
    expect(calls[2]?.reason).toContain("does not match its schema");
    // ...and the ending is an event of its own, carrying the word the record
    // carries.
    const settled = events.filter((event) => event.kind === "settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ disposition: "acted" });
  });

  it("records the model's prose, its stop reason and what the round spent", async () => {
    const { harness } = scriptedModel([
      {
        toolCall: { name: "read_timeline", input: { entity_id: "e1" } },
        usage: { inputTokens: 1450, outputTokens: 120 },
      },
      { text: "listo", usage: { inputTokens: 1600, outputTokens: 8 } },
    ]);
    const { chain } = recordingChain();
    const events: TraceEvent[] = [];

    await runExecution({
      harness,
      trigger: TRIGGER,
      // A turn that ends on its words, so the last round's prose is its ending.
      definition: spoken(),
      chain,
      trace: (event) => events.push(event),
    });

    const messages = events.filter((event) => event.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      iteration: 1,
      stopReason: "tool_use",
      text: "",
      tokens: { input: 1450, output: 120 },
    });
    expect(messages[1]).toMatchObject({
      iteration: 2,
      stopReason: "end_turn",
      text: "listo",
      tokens: { input: 1600, output: 8 },
    });
  });

  it("names the failure on the ending, so a failed run's trace explains itself", async () => {
    const { harness } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { toolCall: { name: "read_timeline", input: { entity_id: "e2" } } },
    ]);
    const { chain } = recordingChain();
    const events: TraceEvent[] = [];

    await runExecution({
      harness,
      trigger: TRIGGER,
      definition: definition({ model: "claude-sonnet-5", maxIterations: 1, maxTokens: 2048 }),
      chain,
      trace: (event) => events.push(event),
    }).catch(() => undefined);

    const settled = events.filter((event) => event.kind === "settled");
    expect(settled[0]?.disposition).toBe("failed");
    expect(settled[0]?.failure).toContain("the turn cap stopped the execution before the model did");
  });
});

/**
 * A TURN THAT ENDS WHEN THE MODEL STOPS (ticket #357): a typed result, when
 * the definition declares one, is the SDK's structured output, and otherwise
 * what the model wrote last is the turn's words.
 */
describe("a turn ends when the model stops (#357)", () => {
  interface Line {
    readonly line: string;
  }

  const LINE_SCHEMA = {
    type: "object" as const,
    properties: { line: { type: "string" } },
    required: ["line"],
    additionalProperties: false,
  };

  /** The owner-question frame ending on words, or on a `{ line }` structured output. */
  function stopping(
    outputFormat?: ExecutionDefinition<Line | undefined>["outputFormat"],
  ): ExecutionDefinition<Line | undefined> {
    const frame = definition();
    return defineExecution<Line | undefined>({
      instructions: frame.instructions,
      tools: frame.tools,
      context: frame.context,
      recipes: frame.recipes,
      budget: frame.budget,
      lane: frame.lane,
      wake: frame.wake,
      ...(outputFormat === undefined ? {} : { outputFormat }),
      dispositionOf: (_output, _handled, ending) => (ending.words === "" ? "no-action" : "answered"),
    });
  }

  const LINE_FORMAT = {
    schema: LINE_SCHEMA,
    parse: (output: unknown) =>
      output !== null && typeof output === "object" && typeof (output as Record<string, unknown>)["line"] === "string"
        ? { ok: true as const, submission: output as Line }
        : { ok: false as const, reason: "the output is a line" },
  };

  it("ends on the structured output it declares, with only the definition's tools beside it", async () => {
    const { harness, requests } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { structured: { line: "Quedó una fecha prometida el jueves." } },
    ]);

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: stopping(LINE_FORMAT),
      chain: recordingChain().chain,
    });

    expect(outcome.submission).toEqual({ line: "Quedó una fecha prometida el jueves." });
    expect(outcome.record.disposition).toBe("no-action");
    expect(outcome.record.toolNames).toEqual(["read_timeline", "count_facts"]);
    // The CLI ends the turn on the structured output: two model calls, no third.
    expect(requests).toHaveLength(2);
    expect(toolNamesOf(requests[0]).sort()).toEqual(["StructuredOutput", "count_facts", "read_timeline"]);
  });

  it("ends when the model stops, its last words the turn's — streamed piece by piece as they were written", async () => {
    const said = "Quedó una fecha prometida el jueves con Torres.";
    const pieces: { round: number; text: string }[] = [];
    const { harness, requests } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { text: said },
    ]);

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: stopping(),
      chain: recordingChain().chain,
      onWords: (piece) => pieces.push(piece),
    });

    expect(requests).toHaveLength(2);
    expect(outcome.words).toBe(said);
    expect(outcome.submission).toBeUndefined();
    expect(outcome.record.disposition).toBe("answered");
    expect(pieces.length).toBeGreaterThan(1);
    expect(new Set(pieces.map((piece) => piece.round))).toEqual(new Set([2]));
    expect(pieces.map((piece) => piece.text).join("")).toBe(said);
  });

  it("settles schema-miss when the CLI gives up on an output that never matched its schema", async () => {
    const { harness } = scriptedModel(Array.from({ length: 5 }, () => ({ structured: { said: 1 } })));
    const { chain, entries } = recordingChain();

    const outcome = await runExecution({ harness, trigger: TRIGGER, definition: stopping(LINE_FORMAT), chain });

    expect(outcome.record.disposition).toBe("schema-miss");
    expect(outcome.submission).toBeUndefined();
    expect(entries.map((entry) => entry.outcome)).toEqual(["schema-miss"]);
  });

  it("hands an output the definition's own rule refuses back to the model, which answers again (#363)", async () => {
    const { harness, requests } = scriptedModel([
      { structured: { line: "Quedó algo." } },
      { structured: { line: "Quedó una fecha prometida el jueves." } },
    ]);
    const events: TraceEvent[] = [];

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: stopping({
        schema: LINE_SCHEMA,
        parse: (output) =>
          (output as Line).line === "Quedó algo."
            ? { ok: false, reason: "a line names nobody" }
            : { ok: true, submission: output as Line },
      }),
      chain: recordingChain().chain,
      trace: (event) => events.push(event),
    });

    expect(outcome.submission).toEqual({ line: "Quedó una fecha prometida el jueves." });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("refused: a line names nobody");
    expect(
      events.filter((event) => event.kind === "tool_call").map((event) => `${event.tool} ${event.outcome}`),
    ).toEqual(["StructuredOutput rejected", "StructuredOutput recorded"]);
  });

  it("settles schema-miss when every output the model gives is one the definition's own rule refuses", async () => {
    // The CLI counts a denied output against its own retries, and gives up.
    const { harness } = scriptedModel(Array.from({ length: 8 }, () => ({ structured: { line: "Quedó algo." } })));
    const { chain, entries } = recordingChain();

    const outcome = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: stopping({ schema: LINE_SCHEMA, parse: () => ({ ok: false, reason: "a line names nobody" }) }),
      chain,
    });

    expect(outcome.record.disposition).toBe("schema-miss");
    expect(outcome.submission).toBeUndefined();
    expect(entries.map((entry) => entry.outcome)).toEqual(["schema-miss"]);
  });

  it("fails when the turn cap ends it before it reported any output", async () => {
    const { harness } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
    ]);
    const frame = stopping(LINE_FORMAT);

    const failure = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: defineExecution<Line | undefined>({ ...frame, budget: { ...frame.budget, maxIterations: 2 } }),
      chain: recordingChain().chain,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExecutionError);
    expect((failure as ExecutionError).message).toContain("the turn cap stopped the execution before the model did, within a budget of 2 iterations");
    expect((failure as ExecutionError).record.disposition).toBe("failed");
  });

  it("fails a turn with no output that the turn cap stopped mid-way, whatever it had done (Codex r1)", async () => {
    const { harness } = scriptedModel([
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
      { toolCall: { name: "read_timeline", input: { entity_id: "e1" } } },
    ]);
    const frame = stopping();

    const failure = await runExecution({
      harness,
      trigger: TRIGGER,
      definition: defineExecution<Line | undefined>({ ...frame, budget: { ...frame.budget, maxIterations: 2 } }),
      chain: recordingChain().chain,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExecutionError);
    expect((failure as ExecutionError).message).toContain("the turn cap stopped the execution before the model did");
  });
});

describe("a tool that ends the turn, in the single-message shape (ticket #401)", () => {
  it("stops right after the call: one model call, no words, and the SDK's prompt for a visible response never sent", async () => {
    const base = spoken();
    const ending = defineExecution<Answer>({
      ...base,
      tools: [defineTool({ ...(base.tools[1] as ProjectionToolDeclaration), endsTurn: true })],
    });
    const model = scriptedModel([
      { toolCall: { name: "count_facts", input: { fact_type: "DatePromised" } } },
      { text: "" },
      { text: "palabras de más" },
    ]);

    const outcome = await runExecution({
      harness: model.harness,
      trigger: TRIGGER,
      definition: ending,
      chain: recordingChain().chain,
    });

    expect(outcome.words).toBe("");
    expect(outcome.record.disposition).toBe("answered");
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests)).not.toContain("no visible output");
  });
});

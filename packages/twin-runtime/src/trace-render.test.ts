/**
 * THE TWO VIEWS OF A TRACE, AND THE ONE PROPERTY THAT MAKES THE DEFAULT SAFE
 * (#177 hotfix 1; `trace-render.ts` argues both).
 *
 * THE PROPERTY IS ASSERTED OVER A REAL RUN, not over events written by hand.
 * The risk `renderShape` exists to close is a field somebody forgot about — a
 * tool's input, a refusal's reason, the model's prose — and events planted by
 * this file would only ever prove what its author remembered to plant. So a
 * distinctive string is put into every place content enters an execution, the
 * real runner is run over the scripted wire (ADR-0028 — CI never calls a
 * model), and the shape lines are searched for it.
 *
 * THE DEFINITION IS THE SMALLEST ONE THAT CARRIES CONTENT IN ALL FOUR PLACES,
 * and it is built here rather than borrowed: the thread's own definition needs
 * a bundle, a connection and a served state, none of which this claim is
 * about. What is real is the loop, the tools, the contract and the trace.
 */
import {
  defineExecution,
  defineTool,
  runExecution,
  type ExecutionAuditChain,
  type TraceEvent,
} from "@dito/execution";
import { closeScriptedModels, scriptedModel } from "@dito/scripted-model";
import { afterAll, describe, expect, it , vi } from "vitest";
import { renderFull, renderShape } from "./trace-render.js";

// Every scripted model this suite opened is closed with it (#328).
afterAll(closeScriptedModels);
// Each run spawns a Claude Code child, which can take several seconds cold —
// past the unit lane's five-second default on CI's first spawn.
vi.setConfig({ testTimeout: 60_000 });

/** The string that must never reach a shape line. */
const PLANTED = "PLANTED-9f3b";

const TRIGGER = {
  kind: "twin_thread_message",
  mechanism: "seam_event",
  twinId: "11111111-1111-4111-8111-111111111111",
  door: "twin_thread",
  eventId: "22222222-2222-4222-8222-222222222222",
} as const;

/** A chain that accepts anything: this file is not about the audit chain. */
const chain: ExecutionAuditChain = { append: async () => undefined };

/**
 * One read that returns the planted string and one act that refuses with it;
 * the turn ends on its words.
 */
function planted() {
  return defineExecution<undefined>({
    instructions: [{ name: "how you finish", text: "Say what you did." }],
    tools: [
      defineTool({
        name: "search_planted",
        description: "Read the rep's own messages about something.",
        gate: "projection",
        columns: ["ref", "text"],
        inputSchema: {
          type: "object",
          properties: { about: { type: "string" } },
          required: ["about"],
          additionalProperties: false,
        },
        run: () => `[{"ref":1,"text":"${PLANTED}"}]`,
      }),
      defineTool({
        name: "refusing_act",
        description: "Act on the post the rep replied to.",
        gate: "rep-evidenced",
        evidence: "evidence",
        inputSchema: {
          type: "object",
          properties: { evidence: { type: "string" } },
          required: ["evidence"],
          additionalProperties: false,
        },
        run: () => ({
          performed: false as const,
          told: `no se puede: ${PLANTED}`,
          act: "correction_refused",
        }),
      }),
    ],
    context: [{ name: "the message", text: `el rep dijo ${PLANTED}` }],
    recipes: [],
    budget: { model: "claude-sonnet-5", maxIterations: 6, maxTokens: 2048 },
    lane: "realtime",
    wake: {
      kind: "trigger",
      mechanism: "seam_event",
      occasion: "twin_thread_message",
      predicate: { sources: ["whatsapp"], eventTypes: ["message"] },
    },
    dispositionOf: () => "answered",
  });
}

/**
 * The run: a read, a refused act, then the model's closing prose carrying the
 * planted string.
 */
async function traced(): Promise<TraceEvent[]> {
  const { harness } = scriptedModel([
    { toolCall: { name: "search_planted", input: { about: PLANTED } } },
    { toolCall: { name: "refusing_act", input: { evidence: PLANTED } } },
    { text: `Listo, ${PLANTED}.` },
  ]);
  const events: TraceEvent[] = [];
  await runExecution({
    harness,
    trigger: TRIGGER,
    definition: planted(),
    chain,
    trace: (event) => events.push(event),
  });
  return events;
}

describe("the shape view carries no content, and the full view carries all of it", () => {
  it("plants a string in an input, a result, a refusal and the prose — and shape shows none of it", async () => {
    const events = await traced();

    // THE RUN REALLY CARRIED IT IN ALL FOUR PLACES, so the green below is not
    // a green over a trace with nothing in it.
    expect(JSON.stringify(events)).toContain(PLANTED);

    const shape = events
      .map((event) => renderShape(event))
      .filter((line): line is string => line !== undefined);
    expect(shape).toHaveLength(events.length);
    for (const line of shape) {
      expect(line, line).not.toContain(PLANTED);
    }

    // ...and the full view shows all four, each in its own place: the input a
    // tool was sent, the rows it answered with, the reason an act refused, and
    // what the model wrote.
    const full = events
      .map((event) => renderFull(event))
      .filter((line): line is string => line !== undefined)
      .join("\n");
    for (const carried of [
      `{"about":"${PLANTED}"}`,
      `"text":"${PLANTED}"`,
      `no se puede: ${PLANTED}`,
      `Listo, ${PLANTED}.`,
    ]) {
      expect(full, carried).toContain(carried);
    }
  });

  it("prints the sequence a boundary session needed and did not have", async () => {
    const events = await traced();

    expect(
      events.map((event) => renderShape(event)).join("\n"),
    ).toBe(
      [
        "#1 message tool_use",
        "#1 search_planted returned",
        "#2 message tool_use",
        "#2 refusing_act refused",
        "#3 message end_turn",
        "settled answered",
      ].join("\n"),
    );
  });

  it("keeps a failure sentence out of the shape line and in the full one", () => {
    // A failure sentence can be a rule's own refusal, and those quote what
    // the model wrote — so the ending's shape line carries the word and
    // nothing else.
    const settled: TraceEvent = {
      kind: "settled",
      iteration: 2,
      at: new Date("2026-09-05T08:07:07Z"),
      disposition: "failed",
      failure: `your line types the name "${PLANTED}"`,
    };
    expect(renderShape(settled)).toBe("settled failed");
    expect(renderFull(settled)).toContain(PLANTED);
  });

  it("prints a message with no prose as one line, and one with prose as two", () => {
    const round = {
      kind: "message",
      iteration: 1,
      at: new Date("2026-09-05T08:07:07Z"),
      stopReason: "tool_use",
      tokens: { input: 49_005, output: 1_125 },
    } as const;
    expect(renderFull({ ...round, text: "" })).toBe(
      "#1 message tool_use (49005 in / 1125 out)",
    );
    expect(renderFull({ ...round, text: "Listo" })).toBe(
      "#1 message tool_use (49005 in / 1125 out)\n  Listo",
    );
  });
});

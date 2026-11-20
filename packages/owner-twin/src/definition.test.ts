/**
 * The definition: what is stamped, what is not, and what the model is shown
 * (ticket #130; spec #126 decision 17; definition of done item 10).
 */
import {
  DEFAULT_MAX_TOKENS,
  ExecutionDefinitionError,
  NOW_OWNER_RECIPE,
  renderParts,
} from "@dito/execution";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { OWNER_TWIN_MAX_ITERATIONS } from "./automation.js";
import {
  ownerTwinContext,
  ownerTwinExecution,
  renderEarlierTurns,
  type OwnerTurn,
} from "./definition.js";
import { ownerTwinInstructions } from "./instructions.js";
import { ServedRows } from "./served.js";
import { OWNER_ANSWER_SCHEMA } from "./answer.js";
import { OWNER_LAG_HOURS, OWNER_TOOL_DECLARATIONS } from "./tools.js";

const NO_CLIENT = {
  query: () => {
    throw new Error("this suite makes no query");
  },
} as unknown as pg.ClientBase;

const ASKED_AT = new Date("2026-09-02T18:00:00Z");
const ZONE = "America/Monterrey";

function deps() {
  return {
    client: NO_CLIENT,
    served: new ServedRows(),
    timeZone: ZONE,
    askedAt: ASKED_AT,
  };
}

function execution(
  question = "que quedo pendiente con Torres",
  earlierTurns: readonly OwnerTurn[] = [],
) {
  return ownerTwinExecution({
    deps: deps(),
    question,
    earlierTurns,
    model: "claude-sonnet-5",
  });
}

describe("the owner twin's execution definition", () => {
  it("stamps the same digest for two runs of the same instructions", () => {
    // Definition of done item 10. Two runs mean two served maps and two
    // closures; neither is stamped, and the digest is what says so.
    expect(execution().digest).toBe(execution().digest);
  });

  it("stamps the same digest whatever the question is, because context is not stamped", () => {
    // The context is deliberately NOT stamped: it varies every turn, so a
    // digest covering it could never answer "was this the same instructions".
    expect(execution("a").digest).toBe(execution("b").digest);
  });

  it("carries the tool list into the instructions the digest covers (ADR-0013)", () => {
    const instructions = execution().instructions;
    const toolPart = instructions.find((part) => part.name === "your tools");
    expect(toolPart?.text).toContain("resolve_entity (projection)");
    expect(toolPart?.text).toContain("read_timeline (projection)");
    expect(toolPart?.text).toContain("count_facts (projection)");
  });

  it("tells the model the pinned fields each read returns", () => {
    const toolPart = execution().instructions.find(
      (part) => part.name === "your tools",
    );
    expect(toolPart?.text).toContain("ledger.finalized_facts.payload");
    expect(toolPart?.text).toContain("nothing you ask it can widen that");
  });

  it("ends on the typed answer as structured output, with no submission tool (#363)", () => {
    const definition = execution();
    expect(definition.outputFormat?.schema).toBe(OWNER_ANSWER_SCHEMA);
    expect(definition.tools.map((tool) => tool.name)).toEqual([
      "resolve_entity",
      "read_timeline",
      "count_facts",
    ]);
  });

  it("stamps its digest at the value this ticket set (#363)", () => {
    // THE PIN. It moves when the instructions, the tool declarations, the
    // answer's schema or the recipe call change, and only then.
    expect(execution().digest).toBe("d2cb8f8a980703f9d4dfac51013115e0");
  });

  it("routes to the rung the caller named, with no default of its own", () => {
    // The spec carries no model — ADR-0015 routes at the app boundary — and
    // the cap it also does not carry is the runtime's 16,000, so no
    // definition rediscovers the number (user story 39).
    expect(execution().budget).toEqual({
      model: "claude-sonnet-5",
      maxIterations: OWNER_TWIN_MAX_ITERATIONS,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(OWNER_TWIN_MAX_ITERATIONS).toBe(6);
    expect(() =>
      ownerTwinExecution({
        deps: deps(),
        question: "hola",
        earlierTurns: [],
        model: "",
      }),
    ).toThrow(ExecutionDefinitionError);
  });

  it("holds no twin-spoken sentence in any instruction part", () => {
    // The rule ADR-0037's amendment states, checked here at the part level
    // and over the whole package in `composed-language.test.ts`: the
    // execution is told a structure, never handed a sentence.
    for (const part of execution().instructions) {
      expect(part.text, part.name).not.toMatch(/[¿¡«»áéíóúñÁÉÍÓÚÑ]/u);
    }
  });
});

describe("the owner twin's wake, lane and recipe (#178; spec #171 decision 29)", () => {
  it("wakes on a request, runs in the realtime lane and stamps its one recipe", () => {
    const definition = execution();
    expect(definition.wake).toEqual({
      kind: "trigger",
      mechanism: "request",
      occasion: "owner_question",
    });
    expect(definition.lane).toBe("realtime");
    expect(definition.recipes).toEqual([
      {
        recipe: NOW_OWNER_RECIPE,
        parameters: { at: "instant", timeZone: "zone", lagHours: "hours" },
      },
    ]);
  });
});

describe("the prompt gains the `now` part and nothing else (#178 AC 8)", () => {
  it("leaves the instructions byte-identical to the nine parts", () => {
    // THE STAMPED HALF IS UNTOUCHED. Whatever moved, the model is told
    // exactly what it was told at the slice-4 boundary — same parts, same
    // order, same words — which is what "no other behaviour change" (spec
    // #171 decision 29) has to mean for a system whose whole behaviour is
    // what it was told.
    expect(renderParts(execution().instructions)).toBe(
      renderParts(ownerTwinInstructions(OWNER_TOOL_DECLARATIONS)),
    );
    expect(execution().instructions).toHaveLength(9);
  });

  it("adds `now` as the first context part and changes no other", () => {
    const before = ownerTwinContext("que quedo pendiente con Torres", []);
    const [first, ...rest] = execution().context;
    expect(first?.name).toBe("now");
    expect(rest).toEqual(before);
  });

  it("keeps that true when there is a conversation behind the question", () => {
    const earlier: readonly OwnerTurn[] = [
      {
        questionId: "q-1",
        askedAt: new Date("2026-09-02T10:00:00Z"),
        question: "que quedo pendiente con Torres",
        answer: { kind: "answer", prose: "Lo de [[1]] sigue abierto." },
      },
    ];
    const [first, ...rest] = execution("y de Lozano?", earlier).context;
    expect(first?.name).toBe("now");
    expect(rest).toEqual(ownerTwinContext("y de Lozano?", earlier));
  });

  it("renders the day the FR-69 window closes from the tools' own lag", () => {
    // Asked 2026-09-02 12:00 in Monterrey; 24 hours back is the 1st at
    // noon, so the 1st is only PARTLY readable and the last whole day is
    // August the 31st. The number is never restated here — it travels from
    // `OWNER_LAG_HOURS`, which is the constant the reads refuse against — so
    // the sentence the model is shown and the refusal it would meet cannot
    // disagree.
    const now = execution().context[0]!.text;
    expect(now).toContain("[Now: Wednesday, Sep 2, 2026, 12:00:00 CST (America/Monterrey)]");
    expect(now).toContain("Finalized through: Monday, Aug 31, 2026");
    expect(OWNER_LAG_HOURS).toBe(24);
  });

  it("holds no twin-spoken sentence in the part it added either", () => {
    expect(execution().context[0]!.text).not.toMatch(/[¿¡«»áéíóúñÁÉÍÓÚÑ]/u);
  });
});

describe("what one turn is shown", () => {
  it("puts the question last, nearest the model's own turn", () => {
    const context = ownerTwinContext("y de Lozano?", [
      {
        questionId: "q-1",
        askedAt: new Date("2026-09-02T10:00:00Z"),
        question: "que quedo pendiente con Torres",
        answer: { kind: "answer", prose: "Lo de [[1]] sigue abierto." },
      },
    ]);
    expect(context.map((part) => part.name)).toEqual([
      "earlier turns",
      "the question",
    ]);
    expect(context.at(-1)?.text).toBe("y de Lozano?");
  });

  it("shows only the question when there is no conversation yet", () => {
    expect(ownerTwinContext("hola", []).map((part) => part.name)).toEqual([
      "the question",
    ]);
  });

  it("kills the references in earlier answers rather than carrying them forward", () => {
    // A reference is scoped to the run that served it. Carried into a new
    // turn it would resolve against a different map — a citation that looks
    // grounded and is not.
    const rendered = renderEarlierTurns([
      {
        questionId: "q-1",
        askedAt: new Date("2026-09-02T10:00:00Z"),
        question: "que quedo pendiente con Torres",
        answer: { kind: "answer", prose: "Lo de [[1]] y [[2]] sigue abierto." },
      },
    ]);
    expect(rendered).not.toContain("[[1]]");
    expect(rendered).toContain("(a value from the record)");
    expect(rendered).toContain("never cite one");
  });

  it("says when the conversation is longer than what it was handed", () => {
    // The cap must not be silent: a model shown five of fifty turns and not
    // told will answer «como te dije al principio» about a beginning it
    // never saw.
    const one: OwnerTurn = {
      questionId: "q-1",
      askedAt: new Date("2026-09-02T10:00:00Z"),
      question: "que quedo pendiente con Torres",
      answer: { kind: "answer", prose: "Sigue abierto." },
    };
    const rendered = renderEarlierTurns([one], 50);
    expect(rendered).toContain("most recent 1 of 50 turns");
    expect(rendered).toContain("do not have it in front of you");
    // ...and says nothing when it was handed the whole conversation.
    expect(renderEarlierTurns([one], 1)).not.toContain("most recent");
    expect(renderEarlierTurns([one])).not.toContain("most recent");
  });

  it("shows a turn that failed as one, so a follow-up is readable", () => {
    const rendered = renderEarlierTurns([
      {
        questionId: "q-1",
        askedAt: new Date("2026-09-02T10:00:00Z"),
        question: "y de Lozano?",
        answer: null,
      },
    ]);
    expect(rendered).toContain("did not get an answer out");
  });
});

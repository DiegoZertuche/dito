/**
 * A RUN'S DEFINITION, ITS LAYOUT AND ITS ADVANCE (tickets #323 and #324; spec
 * #318 decisions 22, 23 and 27): the parser that refuses what this build does
 * not run, the pure step advance over typed fields, and the two shipped runs.
 */
import { describe, expect, it } from "vitest";
import { runCatalog, shippedRunCatalog } from "./catalog.js";
import {
  holds,
  layout,
  MAX_REPEATS,
  MAX_STEP_INSTRUCTIONS,
  nextAfter,
  outputSchema,
  parseRunDefinition,
  runDigest,
  whileOutput,
  type RunCatalog,
  type RunDefinition,
  type RunValues,
} from "./definition.js";
import { SHIPPED_RUNS } from "./shipped.js";

const CATALOG: RunCatalog = {
  tools: new Map([
    ["search_memory", "projection"],
    ["read_entity", "projection"],
    ["create_draft", "approve-before"],
    ["ask", "disclosed-and-undoable-after"],
    ["write_notepad", "rep-evidenced"],
  ]),
  recipes: new Set(["count"]),
  contextRecipes: new Set(["notepad", "working_memory"]),
  shipped: false,
};

/** The Thursday reminder, as the thread would write it. */
const REMINDER = {
  name: "Revisar lo de [c4] el jueves",
  budget: { iterations: 6, tokens: 40_000 },
  steps: [
    { kind: "wait", name: "until_thursday", until: { at: "2026-10-08T15:00:00.000Z" } },
    {
      kind: "agent",
      name: "check",
      instructions: "Read [c4]'s conversation and write the reminder.",
      tools: ["search_memory", "read_entity"],
      output: { line: "string", replied: "boolean" },
    },
    { kind: "post", name: "report", text: "check.line" },
  ],
};

function parsed(raw: unknown): RunDefinition {
  const result = parseRunDefinition(raw, CATALOG);
  if (!result.ok) throw new Error(result.reason);
  return result.definition;
}

function refusal(raw: unknown): string {
  const result = parseRunDefinition(raw, CATALOG);
  if (result.ok) throw new Error("the definition was accepted");
  return result.reason;
}

describe("the parser reads what this build runs and refuses the rest", () => {
  it("reads the Thursday reminder: a wait, an agent step and a post", () => {
    const definition = parsed(REMINDER);
    expect(definition.steps.map((step) => step.kind)).toEqual(["wait", "agent", "post"]);
    expect(definition.budget).toEqual({ iterations: 6, tokens: 40_000 });
  });

  it("refuses a check step: a code rule over the model's output is withdrawn (decision 23 as amended)", () => {
    expect(
      refusal({
        ...REMINDER,
        steps: [...REMINDER.steps.slice(0, 2), { kind: "check", name: "has_line", rule: { field: "check.line", is: "present" } }, REMINDER.steps[2]],
      }),
    ).toContain("`kind` is one of agent, code, act, ask, post, wait, each, while, end, if");
  });

  it("refuses a code step naming a recipe this build does not ship", () => {
    expect(
      refusal({
        ...REMINDER,
        steps: [{ kind: "code", name: "tally", recipe: "eval", inputs: {} }],
      }),
    ).toContain("recipe");
  });

  it("refuses a definition with no budget", () => {
    expect(refusal({ name: REMINDER.name, steps: REMINDER.steps })).toContain("budget");
  });

  it("reads a rutina of one agent step and no post step: nothing checks how a run ends (#364)", () => {
    const definition = parsed({
      name: "Revisar pedidos",
      budget: { iterations: 4, tokens: 30_000 },
      steps: [{ kind: "agent", name: "look", instructions: "Look at today's orders.", tools: ["search_memory"] }],
    });
    expect(definition.steps.map((step) => step.kind)).toEqual(["agent"]);
  });

  it("reads a run whose one branch ends with no post step", () => {
    const definition = parsed({
      ...REMINDER,
      steps: [
        { kind: "agent", name: "look", instructions: "Look.", tools: [], output: { replied: "boolean", line: "string" } },
        {
          kind: "if",
          name: "replied",
          when: { field: "look.replied", is: "true" },
          then: [{ kind: "post", name: "done", text: "look.line" }],
          else: [],
        },
      ],
    });
    expect(definition.steps.map((step) => step.kind)).toEqual(["agent", "if"]);
  });

  it("reads an agent step holding a tool that writes and the ask: it calls them itself, each under its own gate", () => {
    const definition = parsed({
      ...REMINDER,
      steps: [
        {
          kind: "agent",
          name: "write",
          instructions: "Write the draft, asking first if you must.",
          tools: ["search_memory", "create_draft", "ask", "write_notepad"],
          output: { line: "string" },
        },
        { kind: "post", name: "report", text: "write.line" },
      ],
    });
    expect(definition.steps[0]).toMatchObject({ kind: "agent", tools: ["search_memory", "create_draft", "ask", "write_notepad"] });
  });

  it("refuses an agent step naming a tool the registries do not hold", () => {
    expect(
      refusal({
        ...REMINDER,
        steps: [
          { kind: "agent", name: "write", instructions: "Send it.", tools: ["send_message"], output: { line: "string" } },
          { kind: "post", name: "report", text: "write.line" },
        ],
      }),
    ).toContain("is not a tool a step may call");
  });

  it("refuses an act step calling a read: a read belongs to an agent step", () => {
    expect(
      refusal({
        ...REMINDER,
        steps: [{ kind: "act", name: "look", tool: "search_memory", inputs: {} }, REMINDER.steps[2]],
      }),
    ).toContain("a read belongs to an agent step");
  });

  it("refuses a reference to a step that has not run by then", () => {
    expect(
      refusal({ ...REMINDER, steps: [{ kind: "post", name: "report", text: "later.line" }] }),
    ).toContain("names no earlier step");
  });

  it("refuses a step after an if that reads a field only one branch produces", () => {
    expect(
      refusal({
        ...REMINDER,
        steps: [
          {
            kind: "agent",
            name: "look",
            instructions: "Look.",
            tools: [],
            output: { replied: "boolean" },
          },
          {
            kind: "if",
            name: "replied",
            when: { field: "look.replied", is: "true" },
            then: [
              { kind: "agent", name: "thank", instructions: "Thank them.", tools: [], output: { line: "string" } },
            ],
            else: [],
          },
          { kind: "post", name: "report", text: "thank.line" },
        ],
      }),
    ).toContain("names no earlier step");
  });
});

describe("the pin", () => {
  it("stamps the same definition the same way, whatever the order of its keys", () => {
    const definition = parsed(REMINDER);
    const reordered = parsed({ steps: REMINDER.steps, budget: { tokens: 40_000, iterations: 6 }, name: REMINDER.name });
    expect(runDigest(reordered)).toBe(runDigest(definition));
    expect(runDigest(definition)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("stamps a changed word differently", () => {
    const changed = parsed({ ...REMINDER, name: "Revisar lo de [c4] el viernes" });
    expect(runDigest(changed)).not.toBe(runDigest(parsed(REMINDER)));
  });
});

/** A run whose agent step says whether the customer replied, then branches on it. */
const BRANCHING = {
  name: "Seguir a [c4]",
  budget: { iterations: 6, tokens: 40_000 },
  steps: [
    {
      kind: "agent",
      name: "look",
      instructions: "Did [c4] reply?",
      tools: [],
      output: { replied: "boolean", line: "string" },
    },
    {
      kind: "if",
      name: "replied",
      when: { field: "look.replied", is: "true" },
      then: [{ kind: "post", name: "done", text: "look.line" }],
      else: [
        { kind: "wait", name: "two_days", until: { after: { days: 2 } } },
        { kind: "agent", name: "again", instructions: "Look again.", tools: [], output: { line: "string" } },
      ],
    },
    { kind: "post", name: "report", text: "look.line" },
  ],
};

function after(replied: boolean, line = "Sigue sin escribir."): RunValues {
  return { inputs: {}, outputs: { look: { replied, line } } };
}

describe("a run moves forward step by step, an if reading typed fields", () => {
  const laid = layout(parsed(BRANCHING));

  it("lays the branches out after the if, one index per step for its whole life", () => {
    expect(laid.map((step) => `${String(step.index)}:${step.kind}:${step.name}`)).toEqual([
      "0:agent:look",
      "1:if:replied",
      "2:post:done",
      "3:wait:two_days",
      "4:agent:again",
      "5:post:report",
    ]);
  });

  it("takes the then branch when the field holds, and joins after the if", () => {
    expect(nextAfter(laid, 0, after(true))).toBe(1);
    expect(nextAfter(laid, 1, after(true))).toBe(2);
    expect(nextAfter(laid, 2, after(true))).toBe(5);
  });

  it("takes the else branch when it does not, and joins after the if", () => {
    expect(nextAfter(laid, 1, after(false))).toBe(3);
    expect(nextAfter(laid, 3, after(false))).toBe(4);
    expect(nextAfter(laid, 4, after(false))).toBe(5);
  });

  it("ends after the last step", () => {
    expect(nextAfter(laid, 5, after(true))).toBeUndefined();
  });

  it("compares numbers and words the way the condition says", () => {
    const values: RunValues = { inputs: { attempts: 3, who: "c4" }, outputs: {} };
    expect(holds({ field: "input.attempts", is: "more", value: 2 }, values)).toBe(true);
    expect(holds({ field: "input.attempts", is: "less", value: 3 }, values)).toBe(false);
    expect(holds({ field: "input.who", is: "equal", value: "c4" }, values)).toBe(true);
    expect(holds({ field: "input.missing", is: "absent" }, values)).toBe(true);
  });
});

// ─── ticket #324: the repeats, the end, the question, the children ──────

/** «Sigue a [c4] hasta que conteste»: a while of a follow-up and a reply wait, then the report. */
const FOLLOW = {
  name: "Seguir a [c4]",
  budget: { iterations: 20, tokens: 200_000 },
  steps: [
    {
      kind: "while",
      name: "follow",
      when: { field: "answer.replied", is: "unequal", value: true },
      cap: 3,
      body: [
        { kind: "agent", name: "nudge", instructions: "Write attempt follow.iteration.", tools: ["create_draft"], output: { line: "string" } },
        { kind: "wait", name: "answer", until: { reply: "input.customer", within: { days: "input.days" } } },
      ],
    },
    { kind: "agent", name: "summary", instructions: "Report.", tools: [], output: { line: "string" } },
    { kind: "post", name: "report", text: "summary.line" },
  ],
};

describe("a while repeats its body in sequence under a cap, over typed fields", () => {
  const laid = layout(parsed(FOLLOW));
  const step = laid[0]!;
  if (step.kind !== "while") throw new Error("step 0 is the while");

  it("lays its body after it and goes back to it at the body's end", () => {
    expect(laid.map((one) => `${String(one.index)}:${one.kind}:${one.name}`)).toEqual([
      "0:while:follow",
      "1:agent:nudge",
      "2:wait:answer",
      "3:agent:summary",
      "4:post:report",
    ]);
    expect(nextAfter(laid, 2, { inputs: {}, outputs: {} })).toBe(0);
  });

  it("passes while the condition holds and the cap allows, and stops on either, saying which", () => {
    const first = whileOutput(step, { inputs: {}, outputs: {} }, 3);
    expect(first).toEqual({ iteration: 1 });
    expect(nextAfter(laid, 0, { inputs: {}, outputs: { follow: first } })).toBe(1);
    const unanswered = { follow: { iteration: 3 }, answer: { replied: false } };
    const capped = whileOutput(step, { inputs: {}, outputs: unanswered }, 3);
    expect(capped).toEqual({ iteration: 3, exited: "cap" });
    expect(nextAfter(laid, 0, { inputs: {}, outputs: { ...unanswered, follow: capped } })).toBe(3);
    const replied = whileOutput(step, { inputs: {}, outputs: { follow: { iteration: 2 }, answer: { replied: true } } }, 3);
    expect(replied).toEqual({ iteration: 2, exited: "condition" });
  });

  it("begins counting again when it is reached after it last stopped", () => {
    expect(whileOutput(step, { inputs: {}, outputs: { follow: { iteration: 3, exited: "cap" } } }, 3)).toEqual({ iteration: 1 });
  });

  it("refuses a cap past twenty, and a step after the while that reads its body", () => {
    expect(refusal({ ...FOLLOW, steps: [{ ...FOLLOW.steps[0], cap: MAX_REPEATS + 1 }, ...FOLLOW.steps.slice(1)] })).toContain("cap");
    expect(refusal({ ...FOLLOW, steps: [FOLLOW.steps[0], { kind: "post", name: "report", text: "nudge.line" }] })).toContain(
      "names no earlier step",
    );
  });
});

describe("an end ends the run well from inside a branch", () => {
  const ENDING = {
    name: "Mirar a [c4]",
    budget: { iterations: 6, tokens: 40_000 },
    steps: [
      { kind: "agent", name: "look", instructions: "Look.", tools: [], output: { found: "boolean", line: "string" } },
      {
        kind: "if",
        name: "found",
        when: { field: "look.found", is: "false" },
        then: [{ kind: "end", name: "nothing", value: "look.line" }],
        else: [],
      },
      { kind: "post", name: "report", text: "look.line" },
    ],
  };

  it("lays an end out with nowhere after it", () => {
    const laid = layout(parsed(ENDING));
    expect(laid[2]).toMatchObject({ kind: "end", name: "nothing", next: undefined });
  });

  it("reads a branch that ends the run where the other posts", () => {
    const definition = parsed({
      ...ENDING,
      steps: [ENDING.steps[0], { ...ENDING.steps[1], else: [{ kind: "post", name: "said", text: "look.line" }] }],
    });
    expect(definition.steps).toHaveLength(2);
  });

  it("refuses a step after an end in the same list", () => {
    expect(
      refusal({
        ...ENDING,
        steps: [ENDING.steps[0], { kind: "end", name: "stop" }, { kind: "post", name: "report", text: "look.line" }],
      }),
    ).toContain("nothing runs after an `end`");
  });
});

describe("an each makes one child run per item, and an ask types its answer", () => {
  const STALE = {
    name: "Clientes callados",
    budget: { iterations: 20, tokens: 200_000 },
    steps: [
      { kind: "agent", name: "find", instructions: "Find them.", tools: ["search_memory"], output: { customers: "list", question: "string" } },
      { kind: "ask", name: "choose", question: "find.question", fields: [{ name: "customers", kind: "pick_many", options: "find.customers" }] },
      {
        kind: "each",
        name: "drafts",
        over: "choose.customers",
        item: "customer",
        body: [{ kind: "agent", name: "follow_up", instructions: "Write to input.customer.", tools: ["create_draft"], output: { line: "string" } }],
      },
      { kind: "post", name: "report", text: "drafts.outputs" },
    ],
  };

  it("reads the ask's fields as its output and the each's outputs as a list the post reports, one index each", () => {
    expect(layout(parsed(STALE)).map((one) => one.kind)).toEqual(["agent", "ask", "each", "post"]);
  });

  it("refuses a child step that names its parent's steps: a child reads its inputs", () => {
    expect(
      refusal({
        ...STALE,
        steps: [
          ...STALE.steps.slice(0, 2),
          { ...STALE.steps[2], body: [{ kind: "post", name: "said", text: "find.question" }] },
          STALE.steps[3],
        ],
      }),
    ).toContain("names no earlier step");
  });

  it("refuses the twenty-first item of a list written into the definition", () => {
    const items = Array.from({ length: MAX_REPEATS + 1 }, (_, index) => `item ${String(index)}`);
    expect(refusal({ ...STALE, steps: [STALE.steps[0], { ...STALE.steps[2], over: { value: items } }, STALE.steps[3]] })).toContain(
      `at most ${String(MAX_REPEATS)} children`,
    );
  });

  it("refuses an each inside an each: a child makes no children of its own", () => {
    const nested = { ...STALE.steps[2], body: [{ ...STALE.steps[2], name: "inner", over: "input.customers", body: [{ kind: "end", name: "stop" }] }] };
    expect(refusal({ ...STALE, steps: [STALE.steps[0], STALE.steps[1], nested, STALE.steps[3]] })).toContain(
      "a child run makes no children of its own",
    );
  });

  it("refuses a pick with no options", () => {
    expect(
      refusal({ ...STALE, steps: [STALE.steps[0], { ...STALE.steps[1], fields: [{ name: "who", kind: "pick_one" }] }, STALE.steps[3]] }),
    ).toContain("a pick has `options`");
  });

  it("pins the digest of a definition with the new kinds, whatever its keys' order", () => {
    const reordered = JSON.parse(JSON.stringify({ steps: STALE.steps, budget: STALE.budget, name: STALE.name })) as unknown;
    expect(runDigest(parsed(reordered))).toBe(runDigest(parsed(STALE)));
    expect(runDigest(parsed(FOLLOW))).not.toBe(runDigest(parsed(STALE)));
  });
});

describe("what a step may call is the registries' own, less what is the thread's own", () => {
  const catalog = runCatalog();

  it("holds the tools the thread registers, the writes and the ask among them", () => {
    for (const tool of ["search_memory", "create_draft", "ask", "start_workflow", "write_working_memory"]) {
      expect(catalog.tools.has(tool), tool).toBe(true);
    }
  });

  it("holds the SDK's own tools under their gates: the reads and the search answer, the writes are undone through the version", () => {
    expect(Object.fromEntries(["Read", "Glob", "Grep", "Write", "Edit", "WebSearch"].map((tool) => [tool, catalog.tools.get(tool)]))).toEqual({
      Read: "projection",
      Glob: "projection",
      Grep: "projection",
      Write: "disclosed-and-undoable-after",
      Edit: "disclosed-and-undoable-after",
      WebSearch: "projection",
    });
    const written = parseRunDefinition(
      {
        ...REMINDER,
        steps: [
          { kind: "agent", name: "write", instructions: "Write it.", tools: ["WebSearch", "Write"], output: { path: "string" } },
          { kind: "post", name: "report", text: "write.path" },
        ],
      },
      catalog,
    );
    expect(written.ok ? "parsed" : written.reason).toBe("parsed");
  });

  it("refuses Bash and WebFetch by name, and an act step calling an SDK tool — the CLI serves those to a model turn", () => {
    for (const tool of ["Bash", "WebFetch"]) {
      const agent = parseRunDefinition(
        {
          ...REMINDER,
          steps: [
            { kind: "agent", name: "shell", instructions: "Look.", tools: [tool], output: { line: "string" } },
            { kind: "post", name: "report", text: "shell.line" },
          ],
        },
        catalog,
      );
      expect(agent.ok ? "parsed" : agent.reason, tool).toContain(`\`${tool}\` is not a tool a step may call`);
    }
    const act = parseRunDefinition({ ...REMINDER, steps: [{ kind: "act", name: "write", tool: "Write", inputs: {} }, REMINDER.steps[2]] }, catalog);
    expect(act.ok ? "parsed" : act.reason).toContain("as the SDK's own tools do");
  });

  it("refuses a step that would spotlight, knock or speak on a card — runs land cards, the thread speaks", () => {
    for (const tool of ["move_cards", "spotlight", "knock", "say_on_card", "nothing_to_say"]) {
      const agent = parseRunDefinition(
        {
          ...REMINDER,
          steps: [
            { kind: "agent", name: "speak", instructions: "Tell them.", tools: [tool], output: { line: "string" } },
            { kind: "post", name: "report", text: "speak.line" },
          ],
        },
        catalog,
      );
      expect(agent.ok, tool).toBe(false);
      const act = parseRunDefinition({ ...REMINDER, steps: [{ kind: "act", name: "speak", tool, inputs: {} }, REMINDER.steps[2]] }, catalog);
      expect(act.ok, tool).toBe(false);
    }
  });

  it("refuses a step that would write a rutina — the thread's own, never a run's, which would write it again at each firing (#386)", () => {
    expect(catalog.tools.has("create_automation")).toBe(false);
    expect(shippedRunCatalog().tools.has("create_automation")).toBe(false);
    const agent = parseRunDefinition(
      {
        ...REMINDER,
        steps: [
          { kind: "agent", name: "settle", instructions: "Set it up for every Friday.", tools: ["create_automation"], output: { line: "string" } },
          { kind: "post", name: "report", text: "settle.line" },
        ],
      },
      catalog,
    );
    expect(agent.ok ? "parsed" : agent.reason).toContain("`create_automation` is not a tool a step may call");
    // ...AND THE REP'S ANSWER TO A PROPOSAL CARD STAYS UNDER ITS OWN GATE, as
    // `answer_ask` does: a step's turn carries no line of the rep's.
    expect(catalog.tools.get("answer_proposal")).toBe("rep-evidenced");
  });

  it("refuses the day's two writers to a definition the rep or the thread wrote, and holds them for Dito's (#364, Codex r1; #396)", () => {
    for (const tool of ["file_facts", "post_disclosure"]) {
      expect(catalog.tools.has(tool), tool).toBe(false);
      expect(shippedRunCatalog().tools.has(tool), tool).toBe(true);
      const written = parseRunDefinition(
        {
          ...REMINDER,
          steps: [
            { kind: "agent", name: "post", instructions: "Post the day.", tools: [tool], output: { line: "string" } },
            { kind: "post", name: "report", text: "post.line" },
          ],
        },
        catalog,
      );
      expect(written.ok, tool).toBe(false);
    }
    for (const recipe of ["claim_chat_days", "settle_chat_days"]) {
      expect(catalog.recipes.has(recipe), recipe).toBe(false);
      expect(shippedRunCatalog().recipes.has(recipe), recipe).toBe(true);
    }
  });
});

describe("every read of the rep's chats is the twin's and every rutina's (ticket #396; Diego, 2026-10-12)", () => {
  it("a definition the rep or the thread wrote may name the three reads, under the projection gate", () => {
    const catalog = runCatalog();
    for (const tool of ["list_chats", "search_chat_history", "read_filed_facts"]) {
      expect(catalog.tools.get(tool), tool).toBe("projection");
      expect(shippedRunCatalog().tools.get(tool), tool).toBe("projection");
    }
    const written = parseRunDefinition(
      {
        ...REMINDER,
        steps: [
          {
            kind: "agent",
            name: "find",
            instructions: "List the customers waiting on the rep.",
            tools: ["list_chats", "search_chat_history", "read_filed_facts"],
            output: { line: "string" },
          },
          { kind: "post", name: "report", text: "find.line" },
        ],
      },
      catalog,
    );
    expect(written.ok ? "parsed" : written.reason).toBe("parsed");
  });
});

describe("the two shipped runs (spec #318 decision 27)", () => {
  it.each(Object.entries(SHIPPED_RUNS))("%s parses through the parser the thread's runs go through", (_, definition) => {
    const result = parseRunDefinition(definition, runCatalog());
    expect(result.ok ? "parsed" : result.reason).toBe("parsed");
  });

  it("the first asks over the customers it found, drafts one per chosen customer and reports over them", () => {
    expect(layout(SHIPPED_RUNS.stale_relationships).map((step) => step.kind)).toEqual(["agent", "code", "if", "ask", "each", "post", "end"]);
  });

  it("the second repeats a draft and a reply wait under the attempts the rep gave, then reports", () => {
    const laid = layout(SHIPPED_RUNS.standing_goal);
    expect(laid.map((step) => step.kind)).toEqual(["while", "agent", "wait", "agent", "post"]);
    expect(laid[0]).toMatchObject({ kind: "while", cap: "input.attempts" });
  });
});

/**
 * HOW A STEP ENDS, WHICH CONVERSATION IT CONTINUES AND WHAT IT IS SHOWN
 * (ticket #357): an agent step's typed output is optional and becomes the
 * SDK's schema; a definition joins the day's conversation only when Dito
 * ships it; a step names the context recipes its turn renders.
 */
describe("an agent step's ending, its conversation and its recipes (#357)", () => {
  /** One turn of the day's conversation, as Dito would ship one. */
  const DAY_TURN = {
    name: "Un turno del día",
    budget: { iterations: 6, tokens: 40_000 },
    session: "day",
    steps: [{ kind: "agent", name: "turn", instructions: "Answer the rep.", recipes: ["notepad", "canvas"] }],
  };

  it("derives the structured output's schema from the declared fields: every one required, a list an array of texts", () => {
    expect(outputSchema({ line: "string", count: "number", replied: "boolean", customers: "list" })).toEqual({
      type: "object",
      properties: {
        line: { type: "string" },
        count: { type: "number" },
        replied: { type: "boolean" },
        customers: { type: "array", items: { type: "string" } },
      },
      required: ["line", "count", "replied", "customers"],
      additionalProperties: false,
    });
  });

  it("reads an agent step that declares no output: it ends when the model stops, and later steps read none of its fields", () => {
    const definition = parsed({
      ...REMINDER,
      steps: [
        { kind: "agent", name: "look", instructions: "Look through the conversation.", tools: ["search_memory"] },
        { kind: "end", name: "done" },
      ],
    });
    expect(definition.steps[0]).toEqual({ kind: "agent", name: "look", instructions: "Look through the conversation.", tools: ["search_memory"] });
    expect(
      refusal({
        ...REMINDER,
        steps: [
          { kind: "agent", name: "look", instructions: "Look.", tools: [] },
          { kind: "post", name: "report", text: "look.line" },
        ],
      }),
    ).toContain("step `look` has no field `line`");
  });

  it("reads the context recipes a step names, in their order, and refuses one its catalog does not list", () => {
    const definition = parsed({
      ...REMINDER,
      steps: [REMINDER.steps[0], { ...REMINDER.steps[1], recipes: ["working_memory", "notepad"] }, REMINDER.steps[2]],
    });
    expect(definition.steps[1]).toMatchObject({ recipes: ["working_memory", "notepad"] });
    const canvas = refusal({ ...REMINDER, steps: [REMINDER.steps[0], { ...REMINDER.steps[1], recipes: ["canvas"] }, REMINDER.steps[2]] });
    expect(canvas).toContain("`canvas` is not a context recipe a step may name: notepad, working_memory");
    // THE «NOW» IS ALWAYS FIRST AND NEVER NAMED.
    expect(refusal({ ...REMINDER, steps: [REMINDER.steps[0], { ...REMINDER.steps[1], recipes: ["now"] }, REMINDER.steps[2]] })).toContain("`now` is not a context recipe");
    expect(
      refusal({ ...REMINDER, steps: [REMINDER.steps[0], { ...REMINDER.steps[1], recipes: ["notepad", "notepad"] }, REMINDER.steps[2]] }),
    ).toContain("names each recipe once");
  });

  it("reads `own` from anybody and `day` from a definition Dito ships, one agent step of the day's conversation", () => {
    expect(parsed({ ...REMINDER, session: "own" }).session).toBe("own");
    const shipped = parseRunDefinition(DAY_TURN, shippedRunCatalog());
    expect(shipped.ok && shipped.definition.session).toBe("day");
    expect(shipped.ok && shipped.definition.steps[0]).toMatchObject({ recipes: ["notepad", "canvas"] });
  });

  it("refuses `day` from a definition the rep or the thread wrote, as start_workflow and create_automation parse it", () => {
    const written = parseRunDefinition(DAY_TURN, runCatalog());
    expect(written.ok).toBe(false);
    expect(!written.ok && written.reason).toContain("only a run Dito ships joins it");
    expect(refusal({ ...REMINDER, session: "day" })).toContain("only a run Dito ships joins it");
    expect(refusal({ ...REMINDER, session: "yesterday" })).toContain("`session` is own or day");
  });

  it("refuses a day definition that is more than one turn, ends on typed fields or names tools of its own", () => {
    const shipped = shippedRunCatalog();
    const reasonOf = (raw: unknown): string => {
      const result = parseRunDefinition(raw, shipped);
      return result.ok ? "accepted" : result.reason;
    };
    expect(reasonOf({ ...DAY_TURN, steps: [...DAY_TURN.steps, { kind: "end", name: "done" }] })).toContain("one `agent` step");
    expect(reasonOf({ ...DAY_TURN, steps: [{ ...DAY_TURN.steps[0], output: { line: "string" } }] })).toContain("declares no `output`");
    expect(reasonOf({ ...DAY_TURN, steps: [{ ...DAY_TURN.steps[0], tools: ["search_memory"] }] })).toContain("names none of its own");
  });
});

/**
 * WHAT A CONVERSATION DITO SHIPS MAY SAY OF ITSELF (ticket #363): every
 * context recipe a conversation renders, the whole of its frame as its
 * instructions, and the word its answer records — none of which a run the
 * rep or the thread writes may.
 */
describe("a shipped conversation's recipes, its frame and its answer's word (#363)", () => {
  const CLASSIFY = {
    name: "Una pregunta",
    budget: { iterations: 1, tokens: 20_000 },
    steps: [{ kind: "agent", name: "classify", instructions: "Say which.", tools: [], output: { kind: "string" } }],
    answeredAs: "classified",
  };

  it("lists every conversation's context recipes for a definition Dito ships, and only the notebooks for one the rep wrote", () => {
    expect([...shippedRunCatalog().contextRecipes].sort()).toEqual([
      "canvas",
      "chat_binding",
      "keyword_set",
      "notepad",
      "quoted_post",
      "recent_messages",
      "recent_transcript",
      "rep_language",
      "retrieved_memories",
      "the_counts",
      "the_day",
      "the_event",
      "the_message",
      "the_name",
      "the_record",
      "the_turn",
      "working_memory",
    ]);
    expect([...runCatalog().contextRecipes].sort()).toEqual(["notepad", "working_memory"]);
  });

  it("reads the word a shipped answer records, and refuses it from a run the rep or the thread wrote", () => {
    const shipped = parseRunDefinition(CLASSIFY, shippedRunCatalog());
    expect(shipped.ok && shipped.definition.answeredAs).toBe("classified");
    const written = parseRunDefinition({ ...CLASSIFY, steps: [...CLASSIFY.steps, { kind: "end", name: "done" }] }, runCatalog());
    expect(!written.ok && written.reason).toContain("`answeredAs` is not yours to set");
    const odd = parseRunDefinition({ ...CLASSIFY, answeredAs: "drafted" }, shippedRunCatalog());
    expect(!odd.ok && odd.reason).toContain("`answeredAs` is answered, classified, no-action");
  });

  it("takes a shipped conversation's whole frame as its instructions, and holds what the rep or the thread writes to the cap", () => {
    const frame = "Answer the rep. ".repeat(MAX_STEP_INSTRUCTIONS / 8);
    const long = { ...CLASSIFY, steps: [{ ...CLASSIFY.steps[0], instructions: frame }] };
    expect(parseRunDefinition(long, shippedRunCatalog()).ok).toBe(true);
    const written = { name: long.name, budget: long.budget, steps: [...long.steps, { kind: "end", name: "done" }] };
    const refused = parseRunDefinition(written, runCatalog());
    expect(!refused.ok && refused.reason).toContain(`at most ${String(MAX_STEP_INSTRUCTIONS)} characters`);
  });
});

describe("the last two shipped runs, on the agent step (ticket #326; spec #318 decision 27)", () => {
  const RESEARCH = SHIPPED_RUNS.research_and_document;
  const OVERNIGHT = SHIPPED_RUNS.overnight_requests;

  it.each([
    ["research_and_document", RESEARCH],
    ["overnight_requests", OVERNIGHT],
  ] as const)("%s parses as Dito ships it and as the thread would write it — one kind of definition", (_, definition) => {
    for (const catalog of [shippedRunCatalog(), runCatalog()]) {
      const result = parseRunDefinition(definition, catalog);
      expect(result.ok ? result.definition : result.reason).toEqual(definition);
    }
  });

  it("research gathers on the web, branches on the twin's own `found`, writes the document into the workspace and reports with it", () => {
    expect(layout(RESEARCH).map((step) => `${step.kind}:${step.name}`)).toEqual([
      "agent:gather",
      "if:sourced",
      "agent:write",
      "post:report",
      "end:nothing_found",
    ]);
    const [gather, sourced] = RESEARCH.steps;
    expect(gather).toMatchObject({ tools: ["WebSearch", "search_memory", "search_messages"], output: { found: "boolean", sources: "list", notes: "string" } });
    expect(sourced).toMatchObject({
      when: { field: "gather.found", is: "true" },
      then: [
        { kind: "agent", name: "write", tools: ["Read", "Write", "Edit"], output: { path: "string", line: "string" } },
        { kind: "post", name: "report", text: "write.line", document: "write.path" },
      ],
      else: [{ kind: "end", name: "nothing_found", value: "gather.notes" }],
    });
  });

  it("overnight reads the night, posts the briefing with its list, and drafts one reply per request in a child of its own", () => {
    expect(layout(OVERNIGHT).map((step) => `${step.kind}:${step.name}`)).toEqual([
      "agent:read_night",
      "post:briefing",
      "each:drafts",
      "end:done",
    ]);
    expect(OVERNIGHT.steps[1]).toEqual({ kind: "post", name: "briefing", text: "read_night.summary", list: "read_night.requests" });
    expect(OVERNIGHT.steps[2]).toMatchObject({
      over: "read_night.requests",
      item: "request",
      body: [{ kind: "agent", name: "reply", tools: ["read_message", "search_memory", "create_draft"], output: { line: "string" } }],
    });
  });

  it("holds no check step and no act: the agent calls its tools itself", () => {
    for (const definition of [RESEARCH, OVERNIGHT]) {
      expect(JSON.stringify(definition)).not.toMatch(/"kind":"(act|check)"/u);
    }
  });

  it("pins both, so a change to what a shipped run does is a diff", () => {
    expect(runDigest(RESEARCH)).toBe("62df4e2e21d287021c3a4514e2f70fa3");
    expect(runDigest(OVERNIGHT)).toBe("13645f71d74df8f28f3948e324ae9b36");
  });
});

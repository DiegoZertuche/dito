/**
 * THE RUN TOOLS' DECLARED HALVES (ticket #323; ADR-0013 as amended): what the
 * thread is told each tool does, the names a run's steps may use, and the
 * words the tools record their effects by. Apart from the tools themselves
 * (`tools.ts`) so the thread's own list reads them without the engine.
 */
import type { GatedEffectToolDeclaration, ProjectionToolDeclaration } from "@dito/execution";
import { NOTEPAD_RECIPE } from "../rep-notepad.js";
import { writeReference } from "../thread/references.js";
import { WORKING_MEMORY_RECIPE } from "../working-memory.js";
import { ASK_FIELD_KINDS, MAX_REPEATS, MAX_STEPS, STEP_KINDS } from "./definition.js";
import { RUN_RECIPE_NAMES } from "./recipes.js";
import { SHIPPED_RUN_NAMES } from "./shipped-names.js";

/** The words the run tools record their effects by — the twin's own, like `noted`. */
export const RUN_ACT_WORDS = [
  "run_started",
  "run_steered",
  "run_paused",
  "run_resumed",
  "run_cancelled",
] as const;

/**
 * THE FIVE TOOLS' REGISTERED NAMES, ADR-0013's own words for them (as amended
 * 2026-09-27), so the instructions, the registry and the list pin read one
 * spelling.
 */
export const START_WORKFLOW_TOOL = "start_workflow";
/** ...steering a run in flight with the rep's guidance. */
export const STEER_RUN_TOOL = "steer_run";
/** ...pausing it, or taking a paused one up again. */
export const PAUSE_RUN_TOOL = "pause_run";
/** ...cancelling it. */
export const CANCEL_RUN_TOOL = "cancel_run";
/** ...and reading what is in flight. */
export const READ_RUNS_TOOL = "read_runs";

/**
 * `create_automation`'s registered name (`create-automation.ts`), here beside
 * the run tools' so the catalog can hold it out of a run's reach without
 * importing the tool.
 */
export const CREATE_AUTOMATION_TOOL = "create_automation";

const SPAN_DESCRIPTION = "{\"days\"|\"hours\"|\"minutes\": n}";

const STEP_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...STEP_KINDS] },
    name: { type: "string", description: "A short lowercase snake_case name; later steps refer to its output as name.field." },
    instructions: { type: "string", description: "agent: what this step is for, in your own words — the rep's words go here as data." },
    tools: {
      type: "array",
      items: { type: "string" },
      description:
        "agent: the tools it calls itself, by name — any of yours but move_cards, spotlight, knock, say_on_card and nothing_to_say, which stay yours alone, and the SDK's own: Read, Glob, Grep, Write and Edit on your workspace, and WebSearch to look on the web. Each works under its own rule: a read answers, create_draft lands a draft behind the rep's tap, ask puts a question card in front of the rep and the step waits for the answer, Write and Edit change a document whose every version is kept, and a tool that needs the rep's own message is refused inside a run.",
    },
    output: {
      type: "object",
      additionalProperties: { type: "string", enum: ["string", "number", "boolean", "list"] },
      description:
        "agent: its result's typed fields, each a lowercase name and a type. Leave it out for a step that only acts: it ends when it stops, and a later step has nothing of it to read.",
    },
    recipes: {
      type: "array",
      items: { type: "string", enum: [NOTEPAD_RECIPE, WORKING_MEMORY_RECIPE] },
      description: `agent: the notes it reads beside its instructions — ${NOTEPAD_RECIPE}, the rep's standing notes, and ${WORKING_MEMORY_RECIPE}, yours.`,
    },
    recipe: { type: "string", description: `code: the recipe it runs: ${[...RUN_RECIPE_NAMES].join(", ")}.` },
    tool: { type: "string", description: "act: the one tool that acts it calls, with no model — usually create_draft." },
    inputs: {
      type: "object",
      description: "code and act: each parameter a reference — input.name or step.field — or {\"value\": …} written here.",
    },
    question: {
      type: ["string", "object"],
      description: "ask: the question, in the rep's language — a reference to a string field, or {\"value\": text}.",
    },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: [...ASK_FIELD_KINDS] },
          label: { type: ["string", "object"] },
          options: { type: ["string", "object"], description: "pick_one and pick_many: a list field, or {\"value\": [texts]}; customers as their references." },
        },
        required: ["name", "kind"],
      },
      description: "ask: the answer's typed fields; each lands in the step's output under its name.",
    },
    text: { type: "string", description: "post: the reference to the string field it posts, like compose.line — or a list field, one line per item." },
    document: {
      type: "string",
      description: "post: a string field holding the path of a document an agent step wrote into your workspace, like write.path — the report hands the rep that document, which they open from its card.",
    },
    list: { type: "string", description: "post: a list field the report carries as its list, one row per item; a customer in a row as their reference." },
    until: {
      type: "object",
      description: `wait: {"at": ISO instant} computed from the now you were given, {"after": ${SPAN_DESCRIPTION}}, {"settle": step.post_id}, or {"reply": a field holding a customer's reference, "within": ${SPAN_DESCRIPTION}} — its output says replied (and message_id) or not.`,
    },
    over: { type: ["string", "object"], description: `each: the list field it makes one child run per item of, at most ${String(MAX_REPEATS)}.` },
    item: { type: "string", description: "each: the name each child reads its item under, as input.item." },
    body: {
      type: "array",
      items: { type: "object" },
      description: "each: the steps every child runs, reading input.<name>; while: the steps repeated, reading their own latest outputs and the while's iteration.",
    },
    cap: { type: ["integer", "string"], description: `while: the most passes, up to ${String(MAX_REPEATS)}, or a number field.` },
    value: { type: "string", description: "end: the field the run ends with, carried into its report." },
    when: { type: "object", description: "if and while: {\"field\": reference, \"is\": present|absent|true|false|equal|unequal|more|less, \"value\"?}." },
    then: { type: "array", items: { type: "object" }, description: "if: the steps when it holds." },
    else: { type: "array", items: { type: "object" }, description: "if: the steps when it does not." },
  },
  required: ["kind", "name"],
} as const;

/**
 * `start_workflow`'s declared half (ADR-0013: disclosed-and-undoable-after —
 * the run is on Trabajos the moment its row exists, and cancel is the undo).
 * The description teaches the definition's shape, since the thread writes it.
 */
export const START_WORKFLOW_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: START_WORKFLOW_TOOL,
  gate: "disclosed-and-undoable-after",
  description: [
    "Start work that outlives this turn: a run of typed steps that works on its own, waits on the clock or on a card, and comes back to its work later. It appears in Trabajos en curso at once, where the rep can pause or cancel it.",
    "Write a one-off errand the rep asked for as an inline definition: a name the rep would recognise (a customer as their reference), one budget for the whole run (iterations: the model calls all its agent steps may make; tokens: what they may spend — an agent step usually makes three to six calls, each reading some five thousand tokens), and its steps in order.",
    `Step kinds: agent — a step of yours that calls the tools it names itself and ends in typed fields; ask — a question card with typed answer fields in front of the rep, the run waiting for the answer; post — puts one field in front of the rep, in both doors, as the run's report, with a document from your workspace and a list beside it when it names them; wait — until an instant, for a span, until a card settles, or until a customer replies with a deadline; each — one child run per item of a list, all at once, the parent waiting for every child and reporting over their outputs; while — repeats its body while a typed field holds, up to a cap; end — ends the run well from inside a branch; if — two branches over a typed field; act — one call to a tool that acts, with no model; code — a shipped recipe. Judgment is an agent step with a typed output, never a condition. At most ${String(MAX_STEPS)} steps.`,
    `For example, a reminder to look on Thursday at whether ${writeReference(4)} answered: a wait until Thursday's instant, an agent step that reads that customer's conversation and writes the reminder's line as a string field, and a post of that field.`,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      shipped: {
        type: "string",
        description: `The name of a run Dito ships, instead of a definition: ${SHIPPED_RUN_NAMES.join(", ")}.`,
      },
      name: {
        type: "string",
        description: "With shipped: the few words, in the rep's language, Trabajos en curso shows the run by.",
      },
      definition: {
        type: "object",
        properties: {
          name: { type: "string" },
          budget: {
            type: "object",
            properties: { iterations: { type: "integer" }, tokens: { type: "integer" } },
            required: ["iterations", "tokens"],
          },
          steps: { type: "array", items: STEP_SCHEMA },
        },
        required: ["name", "budget", "steps"],
      },
      inputs: {
        type: "object",
        description: "Typed values the steps read as input.name: text, numbers, yes/no, lists of text.",
      },
    },
    additionalProperties: false,
  },
};

const RUN_ID_PROPERTY = {
  type: "string",
  description: "The run's id, as start_workflow or read_runs gave it.",
} as const;

/** `steer_run`'s declared half: the same gate — the steered run is on Trabajos. */
export const STEER_RUN_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: STEER_RUN_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    "Pass the rep's word about a run in flight to the run itself: their guidance is kept in the run's own conversation and read by its next agent step, never by a step already running. It changes what the steps do, never which steps there are — to change the plan, cancel_run it and start_workflow a new one in the same turn.",
  inputSchema: {
    type: "object",
    properties: {
      run_id: RUN_ID_PROPERTY,
      guidance: {
        type: "string",
        description: "What the rep said about the run, in their words or yours, as the run's next step should read it.",
      },
    },
    required: ["run_id", "guidance"],
    additionalProperties: false,
  },
};

/** `pause_run`'s declared half: the same gate, and its own undo in `paused: false`. */
export const PAUSE_RUN_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: PAUSE_RUN_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    "Pause a run in flight — it fires nothing, its waits included, until it is taken up again — or take a paused one up again. Trabajos en curso shows it paused, and the rep can take it up there too.",
  inputSchema: {
    type: "object",
    properties: {
      run_id: RUN_ID_PROPERTY,
      paused: { type: "boolean", description: "true to pause it, false to take it up again." },
    },
    required: ["run_id", "paused"],
    additionalProperties: false,
  },
};

/** `cancel_run`'s declared half: the same gate — the cancelled run's report is on both doors. */
export const CANCEL_RUN_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: CANCEL_RUN_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    "Cancel a run in flight: it ends at the next pass with its report to the rep, and nothing of it fires afterwards.",
  inputSchema: {
    type: "object",
    properties: { run_id: RUN_ID_PROPERTY },
    required: ["run_id"],
    additionalProperties: false,
  },
};

/**
 * WHAT IT RETURNS, PINNED (ADR-0013): one line per run of this twin's that is
 * going or ended in the last days — its id, its name, its state with its
 * flags, the step it stands at, when it started and when it last changed.
 * Never what a step produced: that is the run's own, read on its report.
 */
export const READ_RUNS_COLUMNS: readonly string[] = [
  "run_id",
  "name",
  "state",
  "current_step",
  "started",
  "last_change",
];

/** `read_runs`' declared half: a projection over the pinned columns above. */
export const READ_RUNS_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: READ_RUNS_TOOL,
  gate: "projection",
  description:
    "The runs you have going, and the ones that ended in the last days: each one's id, its name, its state and whether it is paused or cancelled, the step it stands at, when it started and when it last changed.",
  columns: READ_RUNS_COLUMNS,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** The run tools' declared halves, in the order the thread's list carries them. */
export const RUN_TOOL_DECLARATIONS = [
  READ_RUNS_DECLARATION,
  START_WORKFLOW_DECLARATION,
  STEER_RUN_DECLARATION,
  PAUSE_RUN_DECLARATION,
  CANCEL_RUN_DECLARATION,
] as const;

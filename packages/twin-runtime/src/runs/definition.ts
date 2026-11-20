/**
 * A WORKFLOW RUN'S DEFINITION: ONE TYPED OBJECT, ITS DIGEST, AND THE ORDER ITS
 * STEPS RUN IN (ticket #323; spec #318 decisions 4, 22 and 23; ADR-0012 as
 * amended 2026-09-27; the design's §7.2).
 *
 * A definition is a name, one budget, and an ordered list of typed steps. The
 * twin thread writes one for a one-off errand the rep asked for (an `inline`
 * run), and the shipped runs are written in code in the same shape
 * (`shipped.ts`) — so the same parser reads both, and nothing a model writes
 * reaches the engine past it.
 *
 * JUDGMENT IS AN `agent` STEP AND NOTHING ELSE (decision 23 as amended
 * 2026-10-06). An `agent` step is one model turn on the run's session that
 * ends when the model stops — on a typed output, when it declares one — and
 * it calls the tools it names itself, each under that tool's own gate — Quick
 * Automate's custom agent with its integrations as its tools. Every other kind is code: `code` runs a recipe this build ships;
 * `act` makes one gated tool call with its inputs mapped from typed fields;
 * `ask` puts a question card with typed answer fields in front of the rep and
 * parks the run on it; `post` writes a report from a typed field; `wait`
 * parks the run on the clock, on a customer's reply with a deadline, or on a
 * card settling; `each` starts one child run per item of a list; `while`
 * repeats its body in sequence while a condition holds, under a cap; `end`
 * ends the run well from inside a branch; `if` takes one of two branches. No
 * condition reads prose, so the record shows what the model decided and what
 * code did with it.
 *
 * LAID OUT FLAT (`layout`). Every step has one index for its whole life — the
 * index `run_steps` checkpoints and the trigger records: an `if`'s branches
 * and a `while`'s body are laid out after it in order, the branch not taken is
 * skipped over, and the end of a `while`'s body goes back to the `while`. An
 * `each`'s body is laid out in each child run, never in its parent.
 */
import { createHash } from "node:crypto";
import { isSdkTool, type Gate, type ToolInputSchema } from "@dito/execution";

/** A typed value a step produced, or a run was started with. */
export type RunValue = string | number | boolean | readonly string[];

/** The field types an `agent` step's output may declare. */
export const OUTPUT_FIELD_TYPES = ["string", "number", "boolean", "list"] as const;
export type OutputFieldType = (typeof OUTPUT_FIELD_TYPES)[number];

/**
 * WHERE A VALUE COMES FROM: `input.<name>` — what the run was started with —
 * or `<step>.<field>`, a field of an earlier step's output.
 */
export type Ref = string;

/** A value a step reads: a reference, or one written into the definition. */
export type Source<T> = Ref | { readonly value: T };

/** What an `if` or a `while` asks of one typed field. */
export const CONDITION_TESTS = ["present", "absent", "true", "false", "equal", "unequal", "more", "less"] as const;
export type ConditionTest = (typeof CONDITION_TESTS)[number];

export interface Condition {
  readonly field: Ref;
  readonly is: ConditionTest;
  /** The value `equal`, `unequal`, `more` and `less` compare with. */
  readonly value?: string | number | boolean;
}

/**
 * THE KINDS OF ANSWER AN `ask` TAKES (spec #318 decision 34): one of the
 * options, several of them, a short text, a date. The options are rendered by
 * code; the question is the twin's words.
 */
export const ASK_FIELD_KINDS = ["pick_one", "pick_many", "text", "date"] as const;
export type AskFieldKind = (typeof ASK_FIELD_KINDS)[number];

/** One typed answer field of an `ask`, as written. */
export interface AskFieldSpec {
  /** The field's name — the step's output field the answer lands in. */
  readonly name: string;
  readonly kind: AskFieldKind;
  /** What the field asks for, in the twin's words, when the question alone does not say. */
  readonly label?: Source<string>;
  /** The options a pick chooses from: a list field, or a list written here. */
  readonly options?: Source<readonly string[]>;
}

/** A numeric span, each part a number written here or a number field. */
export interface SpanSpec {
  readonly days?: Source<number> | number;
  readonly hours?: Source<number> | number;
  readonly minutes?: Source<number> | number;
}

/** One step, as written. */
export type StepSpec =
  | {
      readonly kind: "agent";
      readonly name: string;
      readonly instructions: string;
      /**
       * The tools it calls itself, by their registered names: any tool the
       * thread's registries hold but what is the thread's own (`RunCatalog`),
       * each under its own gate.
       */
      readonly tools: readonly string[];
      /**
       * The typed fields it ends on, every one required — the SDK's structured
       * output. Absent, the step ends when the model stops, on its words.
       */
      readonly output?: Readonly<Record<string, OutputFieldType>>;
      /**
       * The context recipes rendered into its turn, by name, in this order
       * after the «now» (`RunCatalog.contextRecipes`).
       */
      readonly recipes?: readonly string[];
    }
  | {
      readonly kind: "code";
      readonly name: string;
      /** A recipe this build ships (`RUN_RECIPES`), by name. */
      readonly recipe: string;
      readonly inputs: Readonly<Record<string, Ref>>;
    }
  | {
      readonly kind: "act";
      readonly name: string;
      readonly tool: string;
      /** The tool's parameters: a typed field, or a value written into the definition. */
      readonly inputs: Readonly<Record<string, Ref | { readonly value: string | number | boolean }>>;
    }
  | {
      readonly kind: "ask";
      readonly name: string;
      /** The question, in the twin's words: a string field, or written here. */
      readonly question: Source<string>;
      readonly fields: readonly AskFieldSpec[];
    }
  | {
      readonly kind: "post";
      readonly name: string;
      /** The report's prose: a string field, or a list field posted one line per item. */
      readonly text: Ref;
      /**
       * A string field holding the path of a document the run wrote into the
       * workspace (ticket #326): the report carries that document at the
       * version this boundary's snapshot took.
       */
      readonly document?: Ref;
      /** A list field the report carries as its list, one row per item (ticket #326). */
      readonly list?: Ref;
    }
  | {
      readonly kind: "wait";
      readonly name: string;
      readonly until: WaitUntil;
    }
  | {
      readonly kind: "each";
      readonly name: string;
      /** The list the children are made from, one per item. */
      readonly over: Source<readonly string[]>;
      /** The input name each child reads its item under: `input.<item>`. */
      readonly item: string;
      /** The steps every child runs, in its own run. */
      readonly body: readonly StepSpec[];
    }
  | {
      readonly kind: "while";
      readonly name: string;
      readonly when: Condition;
      /** The most times the body runs: a whole number up to `MAX_REPEATS`, or a number field. */
      readonly cap: Source<number> | number;
      readonly body: readonly StepSpec[];
    }
  | {
      readonly kind: "end";
      readonly name: string;
      /** What the run ends with, carried into its report. */
      readonly value?: Ref;
    }
  | {
      readonly kind: "if";
      readonly name: string;
      readonly when: Condition;
      readonly then: readonly StepSpec[];
      readonly else: readonly StepSpec[];
    };

/**
 * What a `wait` waits on: an instant, a span from when it parks, a card
 * settling, or a customer's reply with a deadline.
 */
export type WaitUntil =
  | { readonly at: string }
  | { readonly after: { readonly days?: number; readonly hours?: number; readonly minutes?: number } }
  | { readonly settle: Ref }
  | {
      /** The customer, as a field holding their reference (`[c7]`). */
      readonly reply: Ref;
      /** The deadline, from when the wait begins. */
      readonly within: SpanSpec;
    };

/**
 * ONE BUDGET PER RUN, ACROSS STEPS (decision 23): the model calls every
 * `agent` step of the run may make between them, and the tokens they may
 * spend. Each step's execution is counted against both.
 */
export interface RunBudget {
  readonly iterations: number;
  readonly tokens: number;
}

/**
 * WHICH CONVERSATION A DEFINITION'S AGENT STEP CONTINUES (ticket #357): its
 * `own` — the run's session, or a fresh one per execution with no run — or
 * the `day`'s, the twin thread's session for the seat-local day, which code
 * cuts and carries. The day's conversation has one owner, so only a
 * definition Dito ships may join it.
 */
export const STEP_SESSIONS = ["own", "day"] as const;
export type StepSession = (typeof STEP_SESSIONS)[number];

export interface RunDefinition {
  /** A few words naming the run, in the rep's language — what Trabajos shows. */
  readonly name: string;
  readonly budget: RunBudget;
  readonly steps: readonly StepSpec[];
  /** The conversation its agent step continues; absent is `own`. */
  readonly session?: StepSession;
  /**
   * THE WORD A TURN THAT ANSWERED WITHOUT ACTING RECORDS (ticket #363): its
   * words or its typed result and no effect. Absent is `answered`. A
   * conversation Dito ships whose answer is something else says so — the
   * entity-kind question's typed kind is `classified`, and drafting's words
   * reach nobody, so a drafting turn that wrote no draft did nothing
   * (`no-action`) — and the record keeps the words it has always had.
   */
  readonly answeredAs?: AnsweredAs;
}

/** The words a shipped conversation's answer may record as (`RunDefinition.answeredAs`). */
export const ANSWERED_AS = ["answered", "classified", "no-action"] as const;
export type AnsweredAs = (typeof ANSWERED_AS)[number];

/** The kinds a definition may use, in the order decision 23 lists them. */
export const STEP_KINDS = ["agent", "code", "act", "ask", "post", "wait", "each", "while", "end", "if"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * THE MOST STEPS ONE DEFINITION MAY LAY OUT — Quick's limit, borrowed as a
 * starting constant (the design's §7.6), branches and bodies counted.
 */
export const MAX_STEPS = 35;

/** The longest a run's name may be: a few words, read on one row. */
export const MAX_RUN_NAME = 80;

/** The most one `agent` step's instructions may hold. */
export const MAX_STEP_INSTRUCTIONS = 4_000;

/**
 * THE MOST CHILDREN ONE `each` MAKES AND THE MOST TIMES ONE `while` REPEATS
 * (decision 23: «capped at twenty»): the twenty-first item is refused, at
 * parse time when the list is written here and at run time otherwise.
 */
export const MAX_REPEATS = 20;

/** The most answer fields one `ask` carries: a short form, never a page. */
export const MAX_ASK_FIELDS = 6;

/**
 * The most options one pick offers — the `each` cap, because a pick of many
 * is what an `each` most often runs over, and an answer no `each` could take
 * in full is one the card should never offer.
 */
export const MAX_ASK_OPTIONS = MAX_REPEATS;

/**
 * THE LONGEST A QUESTION, A LABEL, AN OPTION OR A TYPED TEXT ANSWER MAY BE —
 * a few lines on a card, read at a glance. One bound for what a definition
 * writes, what the ask tool takes and what an answer carries.
 */
export const MAX_ASK_TEXT = 1_000;

/** The span a `wait` may park a run for, at most: a month. */
export const MAX_WAIT_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * WHAT A DEFINITION MAY NAME: every tool a step may call, with the gate it is
 * registered under, the recipes a `code` step may run and the context recipes
 * an `agent` step may render — and whether the definition is one Dito ships,
 * the only kind that may join the day's conversation. Handed in, so this
 * module names no tool of its own — the registries decide (`catalog.ts`).
 */
export interface RunCatalog {
  readonly tools: ReadonlyMap<string, Gate>;
  readonly recipes: ReadonlySet<string>;
  readonly contextRecipes: ReadonlySet<string>;
  readonly shipped: boolean;
}

export type DefinitionParse =
  | { readonly ok: true; readonly definition: RunDefinition }
  | { readonly ok: false; readonly reason: string };

/** A step's or a field's name: lowercase snake_case, so a reference is unambiguous. */
const NAME = /^[a-z][a-z0-9_]{0,39}$/u;

/**
 * Reads a definition, or says why not in a sentence the twin can act on.
 *
 * IT CHECKS STRUCTURE AND NOTHING THE MODEL JUDGED: kinds, names, the
 * references between steps, the catalog's names, the budget. Whether the plan
 * is a good one is the twin's (agentic first, 2026-09-29).
 */
export function parseRunDefinition(raw: unknown, catalog: RunCatalog): DefinitionParse {
  try {
    return { ok: true, definition: readDefinition(raw, catalog) };
  } catch (error) {
    if (error instanceof DefinitionRefusal) return { ok: false, reason: error.message };
    throw error;
  }
}

class DefinitionRefusal extends Error {
  override readonly name = "DefinitionRefusal";
}

function refuse(reason: string): never {
  throw new DefinitionRefusal(reason);
}

function readDefinition(raw: unknown, catalog: RunCatalog): RunDefinition {
  const given = objectOf(raw, "the definition");
  const name = given["name"];
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_RUN_NAME) {
    refuse(`\`name\` is a few words naming the run, at most ${String(MAX_RUN_NAME)} characters`);
  }
  const budget = readBudget(given["budget"]);
  if (!Array.isArray(given["steps"]) || given["steps"].length === 0) {
    refuse("`steps` is the list of the run's steps, at least one");
  }
  const session = readSession(given["session"], catalog);
  const answeredAs = readAnsweredAs(given["answeredAs"], catalog);
  const steps = readSteps(given["steps"] as unknown[], catalog, new Map(), new Set(), "steps");
  if (session === "day") readDayStep(steps);
  if (countSteps(steps) > MAX_STEPS) {
    refuse(`a run lays out at most ${String(MAX_STEPS)} steps, its branches and bodies counted`);
  }
  return {
    name: name.trim(),
    budget,
    steps,
    ...(session === undefined ? {} : { session }),
    ...(answeredAs === undefined ? {} : { answeredAs }),
  };
}

/**
 * A run the rep or the thread writes records its answers as answers: what a
 * turn's answer means is a fact about a conversation Dito ships.
 */
function readAnsweredAs(raw: unknown, catalog: RunCatalog): AnsweredAs | undefined {
  if (raw === undefined) return undefined;
  if (!catalog.shipped) refuse("`answeredAs` is not yours to set: a run you write records its answers as answers");
  if (typeof raw !== "string" || !(ANSWERED_AS as readonly string[]).includes(raw)) {
    refuse(`\`answeredAs\` is ${ANSWERED_AS.join(", ")}`);
  }
  return raw as AnsweredAs;
}

function readSession(raw: unknown, catalog: RunCatalog): StepSession | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(STEP_SESSIONS as readonly string[]).includes(raw)) {
    refuse(`\`session\` is ${STEP_SESSIONS.join(" or ")}`);
  }
  // THE DAY'S CONVERSATION HAS ONE OWNER (ticket #357; the ruling of
  // 2026-10-07): the rep's door has one twin answering, so a definition the
  // rep or the thread wrote runs on a conversation of its own.
  if (raw === "day" && !catalog.shipped) {
    refuse("`session` is `own` for a run you write: the day's conversation is the thread's own, and only a run Dito ships joins it");
  }
  return raw as StepSession;
}

/**
 * A DEFINITION THAT JOINS THE DAY IS ONE TURN OF IT: one `agent` step, which
 * ends when the model stops — the day's session is opened with no typed
 * output — and holds the day's tools, so it names none of its own.
 */
function readDayStep(steps: readonly StepSpec[]): void {
  const [step, ...rest] = steps;
  if (step?.kind !== "agent" || rest.length > 0) {
    refuse("a definition on the day's conversation is one `agent` step, a turn of that conversation");
  }
  if (step.output !== undefined) refuse(`steps[0] (${step.name}): a turn of the day's conversation ends on its words and declares no \`output\``);
  // THE DAY HOLDS THE THREAD'S TOOLS ALREADY, and the SDK's own are the one
  // kind a day's step names, since the CLI serves them (ticket #326).
  if (step.tools.some((tool) => !isSdkTool(tool))) {
    refuse(`steps[0] (${step.name}): a turn of the day's conversation holds the day's tools and names none of its own but the SDK's`);
  }
}

function readBudget(raw: unknown): RunBudget {
  if (raw === undefined) {
    refuse("`budget` is the run's one budget — `iterations` (model calls) and `tokens` — and every run has one");
  }
  const given = objectOf(raw, "`budget`");
  const iterations = given["iterations"];
  const tokens = given["tokens"];
  if (!isWhole(iterations) || !isWhole(tokens)) {
    refuse("`budget.iterations` and `budget.tokens` are whole numbers of at least one");
  }
  return { iterations, tokens };
}

/** What an earlier step's output holds, by field — what a reference is checked against. */
export type OutputShape = Readonly<Record<string, OutputFieldType | "id">>;

/** The fields a reply wait reports (`WaitUntil.reply`). */
const REPLY_OUTPUT: OutputShape = { replied: "boolean", message_id: "id" };

/** The fields a `while` reports: how many times its body ran, and why it stopped. */
const WHILE_OUTPUT: OutputShape = { iteration: "number", exited: "string" };

/** The fields an `each` reports: its children, what each ended with, and how many failed. */
const EACH_OUTPUT: OutputShape = { children: "list", outputs: "list", failed: "number" };

/**
 * Reads a list of steps in order. `seen` is what a step may refer to — the
 * steps before it on its own path — and `names` every name the definition has
 * used, so names stay unique across branches and bodies.
 */
function readSteps(
  raw: readonly unknown[],
  catalog: RunCatalog,
  seen: Map<string, OutputShape>,
  names: Set<string>,
  where: string,
): StepSpec[] {
  const steps = raw.map((entry, index) => readStep(entry, catalog, seen, names, `${where}[${String(index)}]`));
  // NOTHING RUNS AFTER AN `end` ON ITS OWN PATH: a step written there would be
  // a step the run can never reach.
  const ended = steps.findIndex((step) => step.kind === "end");
  if (ended !== -1 && ended < steps.length - 1) {
    refuse(`${where}[${String(ended + 1)}]: nothing runs after an \`end\` — it is the last step of its list`);
  }
  return steps;
}

function readStep(
  raw: unknown,
  catalog: RunCatalog,
  seen: Map<string, OutputShape>,
  names: Set<string>,
  where: string,
): StepSpec {
  const given = objectOf(raw, where);
  const kind = given["kind"];
  if (typeof kind !== "string" || !(STEP_KINDS as readonly string[]).includes(kind)) {
    refuse(`${where}: \`kind\` is one of ${STEP_KINDS.join(", ")}`);
  }
  const name = given["name"];
  if (typeof name !== "string" || !NAME.test(name) || name === "input") {
    refuse(`${where}: \`name\` is a short lowercase snake_case name other than \`input\`, so later steps can refer to its output`);
  }
  if (names.has(name)) refuse(`${where}: two steps are named \`${name}\``);
  names.add(name);
  const at = `${where} (${name})`;
  switch (kind as StepKind) {
    case "agent": {
      const instructions = given["instructions"];
      // THE CAP IS ON WHAT THE REP OR THE THREAD WRITES (ticket #363): a
      // conversation Dito ships carries its whole frame here — the thread's
      // instructions are its day session's system prompt — and is code.
      if (
        typeof instructions !== "string" ||
        instructions.trim() === "" ||
        (!catalog.shipped && instructions.length > MAX_STEP_INSTRUCTIONS)
      ) {
        refuse(`${at}: \`instructions\` say what this step is for, at most ${String(MAX_STEP_INSTRUCTIONS)} characters`);
      }
      const tools = given["tools"] ?? [];
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
        refuse(`${at}: \`tools\` is a list of tool names`);
      }
      for (const tool of tools as string[]) {
        if (!catalog.tools.has(tool)) {
          refuse(
            `${at}: \`${tool}\` is not a tool a step may call — it calls any of yours but move_cards, the spotlight, the knock, a line on a card, the binding question and create_automation, which are the thread's own: ${[...catalog.tools.keys()].join(", ")}`,
          );
        }
      }
      const output = given["output"] === undefined ? undefined : readOutput(given["output"], at);
      const recipes = readContextRecipes(given["recipes"], catalog, at);
      seen.set(name, output ?? {});
      return {
        kind: "agent",
        name,
        instructions: instructions.trim(),
        tools: [...new Set(tools as string[])],
        ...(output === undefined ? {} : { output }),
        ...(recipes === undefined ? {} : { recipes }),
      };
    }
    case "code": {
      const recipe = given["recipe"];
      if (typeof recipe !== "string" || !catalog.recipes.has(recipe)) {
        refuse(
          `${at}: \`recipe\` names one this build ships (${[...catalog.recipes].join(", ")}) — a code step runs a recipe, it never carries one`,
        );
      }
      const inputs = readRefs(given["inputs"], seen, at);
      seen.set(name, recipeOutputs(recipe));
      return { kind: "code", name, recipe, inputs };
    }
    case "act": {
      const tool = given["tool"];
      const gate = typeof tool === "string" ? catalog.tools.get(tool) : undefined;
      // THE SDK'S OWN TOOLS RUN INSIDE A MODEL TURN (ticket #326): the CLI
      // serves them to an agent step, and an act step has no model.
      if (typeof tool !== "string" || gate === undefined || gate === "projection" || isSdkTool(tool)) {
        refuse(
          `${at}: \`tool\` is one of your tools that acts — an act step calls it once with no model; a read belongs to an agent step, as the SDK's own tools do: ${[...catalog.tools].filter(([toolName, toolGate]) => toolGate !== "projection" && !isSdkTool(toolName)).map(([toolName]) => toolName).join(", ")}`,
        );
      }
      const inputs = readActInputs(given["inputs"], seen, at);
      seen.set(name, { performed: "boolean", post_id: "id" });
      return { kind: "act", name, tool, inputs };
    }
    case "ask": {
      const question = readSource(given["question"], seen, `${at}: \`question\``, "string");
      const fields = readAskFields(given["fields"], seen, at);
      seen.set(name, Object.fromEntries(fields.map((field) => [field.name, ASK_FIELD_TYPE[field.kind]])));
      return { kind: "ask", name, question, fields };
    }
    case "post": {
      const text = given["text"];
      checkRef(text, seen, at, ["string", "list"]);
      const document = given["document"];
      if (document !== undefined) checkRef(document, seen, `${at}: \`document\``, ["string"]);
      const list = given["list"];
      if (list !== undefined) checkRef(list, seen, `${at}: \`list\``, ["list"]);
      seen.set(name, { post_id: "id" });
      return {
        kind: "post",
        name,
        text: text as string,
        ...(document === undefined ? {} : { document: document as string }),
        ...(list === undefined ? {} : { list: list as string }),
      };
    }
    case "wait": {
      const until = readUntil(given["until"], seen, at);
      seen.set(name, "reply" in until ? REPLY_OUTPUT : {});
      return { kind: "wait", name, until };
    }
    case "each": {
      const over = readSource(given["over"], seen, `${at}: \`over\``, "list");
      if (typeof over !== "string" && over.value.length > MAX_REPEATS) {
        refuse(`${at}: an \`each\` makes at most ${String(MAX_REPEATS)} children, and this list holds ${String(over.value.length)}`);
      }
      const item = given["item"];
      if (typeof item !== "string" || !NAME.test(item)) {
        refuse(`${at}: \`item\` is the lowercase name each child reads its item under, as input.<item>`);
      }
      // A CHILD READS ITS OWN INPUTS AND NOTHING ELSE (ADR-0012: a child run
      // has the full state set): the parent's inputs and its item, under
      // `input.`. What earlier steps found is in the conversation the child is
      // forked from, never a field it could name.
      const body = readBody(given["body"], catalog, new Map(), names, `${at}.body`);
      // ONE LEVEL OF CHILDREN (Codex r1): a child makes none of its own, so a
      // run's pause and cancel reach every run it made, and Trabajos draws
      // them all under it.
      if (holdsEach(body)) refuse(`${at}: a child run makes no children of its own — an \`each\` never sits inside another`);
      seen.set(name, EACH_OUTPUT);
      return { kind: "each", name, over, item, body };
    }
    case "while": {
      // THE BODY AND THE CONDITION SEE THE BODY'S OWN STEPS, as the latest
      // iteration left them, and the step's own `iteration` — what a loop
      // tests is what its last pass produced. What follows the `while` sees
      // neither: the body may not have run at all.
      const inside = new Map(seen);
      inside.set(name, WHILE_OUTPUT);
      const rawBody = given["body"];
      if (Array.isArray(rawBody)) {
        for (const entry of rawBody) {
          const peeked = peekStep(entry);
          if (peeked !== undefined && !inside.has(peeked.name)) inside.set(peeked.name, peeked.shape);
        }
      }
      const body = readBody(rawBody, catalog, inside, names, `${at}.body`);
      const when = readCondition(given["when"], inside, at);
      const cap = readCount(given["cap"], seen, `${at}: \`cap\``);
      seen.set(name, WHILE_OUTPUT);
      return { kind: "while", name, when, cap, body };
    }
    case "end": {
      const value = given["value"];
      if (value !== undefined) checkRef(value, seen, at);
      seen.set(name, {});
      return value === undefined ? { kind: "end", name } : { kind: "end", name, value: value as string };
    }
    case "if": {
      const when = readCondition(given["when"], seen, at);
      // A BRANCH SEES WHAT CAME BEFORE THE `if` AND ITS OWN EARLIER STEPS,
      // and what follows the `if` sees neither branch: a field the run may
      // not have produced is not one a later step can name.
      const branch = (key: "then" | "else"): StepSpec[] => {
        const steps = given[key] ?? [];
        if (!Array.isArray(steps)) refuse(`${at}: \`${key}\` is a list of steps`);
        return readSteps(steps as unknown[], catalog, new Map(seen), names, `${at}.${key}`);
      };
      const then = branch("then");
      const otherwise = branch("else");
      if (then.length === 0 && otherwise.length === 0) {
        refuse(`${at}: an \`if\` has a step in at least one of \`then\` and \`else\``);
      }
      seen.set(name, {});
      return { kind: "if", name, when, then, else: otherwise };
    }
  }
}

/** What each kind of answer field puts in the step's output. */
const ASK_FIELD_TYPE: Readonly<Record<AskFieldKind, OutputFieldType>> = {
  pick_one: "string",
  pick_many: "list",
  text: "string",
  date: "string",
};

function readBody(
  raw: unknown,
  catalog: RunCatalog,
  seen: Map<string, OutputShape>,
  names: Set<string>,
  where: string,
): StepSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) refuse(`${where}: a body is a list of at least one step`);
  return readSteps(raw as unknown[], catalog, seen, names, where);
}

/**
 * A step's name and output shape read off its raw form, before it is parsed
 * — what a `while`'s condition and body may name of the body. Whatever is
 * wrong with the step is the parse's to refuse.
 */
function peekStep(raw: unknown): { readonly name: string; readonly shape: OutputShape } | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const given = raw as Record<string, unknown>;
  const name = given["name"];
  if (typeof name !== "string" || !NAME.test(name)) return undefined;
  switch (given["kind"]) {
    case "agent": {
      const output = given["output"];
      if (output === null || typeof output !== "object" || Array.isArray(output)) return { name, shape: {} };
      const shape: Record<string, OutputFieldType> = {};
      for (const [field, type] of Object.entries(output as Record<string, unknown>)) {
        if ((OUTPUT_FIELD_TYPES as readonly unknown[]).includes(type)) shape[field] = type as OutputFieldType;
      }
      return { name, shape };
    }
    case "act":
      return { name, shape: { performed: "boolean", post_id: "id" } };
    case "post":
      return { name, shape: { post_id: "id" } };
    case "wait": {
      const until = given["until"];
      const reply = until !== null && typeof until === "object" && "reply" in (until as object);
      return { name, shape: reply ? REPLY_OUTPUT : {} };
    }
    case "ask": {
      const fields = Array.isArray(given["fields"]) ? (given["fields"] as unknown[]) : [];
      const shape: Record<string, OutputFieldType> = {};
      for (const field of fields) {
        const spec = field as Record<string, unknown> | null;
        const kind = spec?.["kind"];
        if (typeof spec?.["name"] === "string" && typeof kind === "string" && Object.hasOwn(ASK_FIELD_TYPE, kind)) {
          shape[spec["name"]] = ASK_FIELD_TYPE[kind as AskFieldKind];
        }
      }
      return { name, shape };
    }
    case "code":
      return { name, shape: typeof given["recipe"] === "string" ? recipeOutputs(given["recipe"]) : {} };
    case "each":
      return { name, shape: EACH_OUTPUT };
    case "while":
      return { name, shape: WHILE_OUTPUT };
    default:
      return { name, shape: {} };
  }
}

/**
 * The context recipes an agent step names: each one the catalog holds, once,
 * in the order the turn shows them — the «now» always first and never named.
 */
function readContextRecipes(raw: unknown, catalog: RunCatalog, at: string): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((recipe) => typeof recipe === "string")) {
    refuse(`${at}: \`recipes\` is a list of context recipe names`);
  }
  for (const recipe of raw as string[]) {
    if (!catalog.contextRecipes.has(recipe)) {
      refuse(`${at}: \`${recipe}\` is not a context recipe a step may name: ${[...catalog.contextRecipes].join(", ")}`);
    }
  }
  if (new Set(raw).size !== raw.length) refuse(`${at}: \`recipes\` names each recipe once`);
  return raw as string[];
}

function readOutput(raw: unknown, at: string): Readonly<Record<string, OutputFieldType>> {
  const given = objectOf(raw, `${at}: \`output\``);
  const fields = Object.entries(given);
  if (fields.length === 0) refuse(`${at}: \`output\` declares at least one typed field`);
  const output: Record<string, OutputFieldType> = {};
  for (const [field, type] of fields) {
    if (!NAME.test(field)) refuse(`${at}: output field \`${field}\` is lowercase snake_case`);
    if (typeof type !== "string" || !(OUTPUT_FIELD_TYPES as readonly string[]).includes(type)) {
      refuse(`${at}: output field \`${field}\` is one of ${OUTPUT_FIELD_TYPES.join(", ")}`);
    }
    output[field] = type as OutputFieldType;
  }
  return output;
}

/**
 * AN AGENT STEP'S TYPED OUTPUT AS THE SCHEMA THE SDK HOLDS THE MODEL TO
 * (ticket #357; its `outputFormat`): every declared field required, each of
 * its type, a list an array of texts, nothing else.
 */
export function outputSchema(output: Readonly<Record<string, OutputFieldType>>): ToolInputSchema {
  const fields = Object.entries(output);
  return {
    type: "object",
    properties: Object.fromEntries(
      fields.map(([field, type]) => [field, type === "list" ? { type: "array", items: { type: "string" } } : { type }]),
    ),
    required: fields.map(([field]) => field),
    additionalProperties: false,
  };
}

function readAskFields(raw: unknown, seen: ReadonlyMap<string, OutputShape>, at: string): AskFieldSpec[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ASK_FIELDS) {
    refuse(`${at}: \`fields\` is the answer's typed fields, one to ${String(MAX_ASK_FIELDS)}`);
  }
  const fields: AskFieldSpec[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `${at}: field ${String(index + 1)}`;
    const given = objectOf(entry, where);
    const name = given["name"];
    if (typeof name !== "string" || !NAME.test(name)) refuse(`${where}: \`name\` is lowercase snake_case`);
    if (fields.some((field) => field.name === name)) refuse(`${where}: two fields are named \`${name}\``);
    const kind = given["kind"];
    if (typeof kind !== "string" || !(ASK_FIELD_KINDS as readonly string[]).includes(kind)) {
      refuse(`${where}: \`kind\` is one of ${ASK_FIELD_KINDS.join(", ")}`);
    }
    const label = given["label"] === undefined ? undefined : readSource(given["label"], seen, `${where}: \`label\``, "string");
    const picks = kind === "pick_one" || kind === "pick_many";
    if (picks !== (given["options"] !== undefined)) {
      refuse(`${where}: a pick has \`options\` and a text or a date has none`);
    }
    const options = picks ? readSource(given["options"], seen, `${where}: \`options\``, "list") : undefined;
    if (options !== undefined && typeof options !== "string" && (options.value.length === 0 || options.value.length > MAX_ASK_OPTIONS)) {
      refuse(`${where}: a pick offers one to ${String(MAX_ASK_OPTIONS)} options`);
    }
    fields.push({
      name,
      kind: kind as AskFieldKind,
      ...(label === undefined ? {} : { label }),
      ...(options === undefined ? {} : { options }),
    });
  }
  return fields;
}

/**
 * A value a step reads: a reference of the type it needs, or that type
 * written here as `{ "value": … }`.
 */
function readSource<K extends "string" | "list">(
  raw: unknown,
  seen: ReadonlyMap<string, OutputShape>,
  what: string,
  type: K,
): Source<K extends "list" ? readonly string[] : string> {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>)["value"];
    const fits =
      type === "list"
        ? Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "" && item.length <= MAX_ASK_TEXT)
        : typeof value === "string" && value.trim() !== "" && value.length <= MAX_ASK_TEXT;
    if (!fits) refuse(`${what} is a reference or \`{ "value": … }\` holding ${type === "list" ? "a list of short texts" : "a text"}`);
    return { value } as Source<K extends "list" ? readonly string[] : string>;
  }
  checkRef(raw, seen, what, type === "list" ? ["list"] : ["string"]);
  return raw as string;
}

/** A count: a whole number from one to `MAX_REPEATS` written here, or a number field. */
function readCount(raw: unknown, seen: ReadonlyMap<string, OutputShape>, what: string): Source<number> | number {
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_REPEATS) {
      refuse(`${what} is a whole number from 1 to ${String(MAX_REPEATS)}`);
    }
    return raw;
  }
  checkRef(raw, seen, what, ["number"]);
  return raw as string;
}

function readRefs(raw: unknown, seen: ReadonlyMap<string, OutputShape>, at: string): Record<string, Ref> {
  const given = objectOf(raw ?? {}, `${at}: \`inputs\``);
  const inputs: Record<string, Ref> = {};
  for (const [key, value] of Object.entries(given)) {
    checkRef(value, seen, at);
    inputs[key] = value as string;
  }
  return inputs;
}

function readActInputs(
  raw: unknown,
  seen: ReadonlyMap<string, OutputShape>,
  at: string,
): Record<string, Ref | { readonly value: string | number | boolean }> {
  const given = objectOf(raw ?? {}, `${at}: \`inputs\``);
  const inputs: Record<string, Ref | { readonly value: string | number | boolean }> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const literal = (value as Record<string, unknown>)["value"];
      if (typeof literal !== "string" && typeof literal !== "number" && typeof literal !== "boolean") {
        refuse(`${at}: input \`${key}\` is a reference or \`{ "value": … }\``);
      }
      inputs[key] = { value: literal };
      continue;
    }
    checkRef(value, seen, at);
    inputs[key] = value as string;
  }
  return inputs;
}

function readUntil(raw: unknown, seen: ReadonlyMap<string, OutputShape>, at: string): WaitUntil {
  const given = objectOf(raw, `${at}: \`until\``);
  if (typeof given["at"] === "string") {
    if (Number.isNaN(Date.parse(given["at"]))) refuse(`${at}: \`until.at\` is an ISO instant`);
    return { at: new Date(given["at"]).toISOString() };
  }
  if (given["after"] !== undefined) {
    const after = objectOf(given["after"], `${at}: \`until.after\``);
    const span = {
      ...(after["days"] === undefined ? {} : { days: after["days"] }),
      ...(after["hours"] === undefined ? {} : { hours: after["hours"] }),
      ...(after["minutes"] === undefined ? {} : { minutes: after["minutes"] }),
    } as { days?: unknown; hours?: unknown; minutes?: unknown };
    const parts = Object.values(span);
    if (parts.length === 0 || !parts.every((part) => typeof part === "number" && part >= 0 && Number.isFinite(part))) {
      refuse(`${at}: \`until.after\` is days, hours or minutes, as numbers`);
    }
    const ms = spanMs(span as { days?: number; hours?: number; minutes?: number });
    if (ms <= 0 || ms > MAX_WAIT_MS) refuse(`${at}: a wait lasts more than a moment and at most a month`);
    return { after: span as { days?: number; hours?: number; minutes?: number } };
  }
  if (given["settle"] !== undefined) {
    checkRef(given["settle"], seen, at, ["id"]);
    return { settle: given["settle"] as string };
  }
  if (given["reply"] !== undefined) {
    checkRef(given["reply"], seen, at, ["string"]);
    const within = objectOf(given["within"], `${at}: \`until.within\``);
    const span: Record<string, Source<number> | number> = {};
    for (const key of ["days", "hours", "minutes"] as const) {
      const part = within[key];
      if (part === undefined) continue;
      if (typeof part === "number") {
        if (!(part >= 0 && Number.isFinite(part))) refuse(`${at}: \`until.within.${key}\` is a number`);
        span[key] = part;
        continue;
      }
      checkRef(part, seen, at, ["number"]);
      span[key] = part as string;
    }
    if (Object.keys(span).length === 0) refuse(`${at}: \`until.within\` is days, hours or minutes — a reply wait has a deadline`);
    const written = Object.values(span).every((part) => typeof part === "number");
    if (written) {
      const ms = spanMs(span as { days?: number; hours?: number; minutes?: number });
      if (ms <= 0 || ms > MAX_WAIT_MS) refuse(`${at}: a wait lasts more than a moment and at most a month`);
    }
    return { reply: given["reply"] as string, within: span as SpanSpec };
  }
  return refuse(
    `${at}: \`until\` is \`{ "at": instant }\`, \`{ "after": { "days"|"hours"|"minutes": n } }\`, \`{ "settle": <step>.post_id }\` or \`{ "reply": <a customer reference field>, "within": { "days"|"hours"|"minutes": n } }\``,
  );
}

function readCondition(raw: unknown, seen: ReadonlyMap<string, OutputShape>, at: string): Condition {
  const given = objectOf(raw, `${at}: the condition`);
  checkRef(given["field"], seen, at);
  const is = given["is"];
  if (typeof is !== "string" || !(CONDITION_TESTS as readonly string[]).includes(is)) {
    refuse(`${at}: \`is\` is one of ${CONDITION_TESTS.join(", ")}`);
  }
  const value = given["value"];
  const compares = is === "equal" || is === "unequal" || is === "more" || is === "less";
  if (compares && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    refuse(`${at}: \`${is}\` compares with a \`value\``);
  }
  if ((is === "more" || is === "less") && typeof value !== "number") {
    refuse(`${at}: \`${is}\` compares with a number`);
  }
  return {
    field: given["field"] as string,
    is: is as ConditionTest,
    ...(compares ? { value: value as string | number | boolean } : {}),
  };
}

/**
 * A reference names `input.<field>` or a field an EARLIER step declared — so
 * a step never reads what the run has not produced by the time it runs.
 */
function checkRef(
  raw: unknown,
  seen: ReadonlyMap<string, OutputShape>,
  at: string,
  types?: readonly (OutputFieldType | "id")[],
): void {
  if (typeof raw !== "string") refuse(`${at}: a reference is \`input.<name>\` or \`<step>.<field>\``);
  const [step, field, ...rest] = raw.split(".");
  if (step === undefined || field === undefined || rest.length > 0 || !NAME.test(field)) {
    refuse(`${at}: \`${raw}\` is not \`input.<name>\` or \`<step>.<field>\``);
  }
  if (step === "input") return;
  const shape = seen.get(step);
  if (shape === undefined) refuse(`${at}: \`${raw}\` names no earlier step`);
  const type = shape[field];
  if (type === undefined) refuse(`${at}: step \`${step}\` has no field \`${field}\``);
  if (types !== undefined && !types.includes(type)) {
    refuse(`${at}: \`${raw}\` is a ${type}, and this needs ${types.join(" or ")}`);
  }
}

function recipeOutputs(recipe: string): OutputShape {
  return RUN_RECIPE_OUTPUTS[recipe] ?? {};
}

/** The recipe the day's extraction claims its chat-days with (`recipes.ts`). */
export const CLAIM_CHAT_DAYS_RECIPE = "claim_chat_days";

/** ...and the one it settles them with. */
export const SETTLE_CHAT_DAYS_RECIPE = "settle_chat_days";

/** What each shipped recipe produces, by field — `recipes.ts` holds the code. */
export const RUN_RECIPE_OUTPUTS: Readonly<Record<string, OutputShape>> = {
  count: { count: "number" },
  [CLAIM_CHAT_DAYS_RECIPE]: { chats: "number", claims: "list", deferred: "number" },
  [SETTLE_CHAT_DAYS_RECIPE]: { filed: "number", failed: "number", merged: "number", kind_mismatches: "number" },
};

/** Whether any step in `steps`, at any depth, is an `each`. */
function holdsEach(steps: readonly StepSpec[]): boolean {
  return steps.some((step) => step.kind === "each" || nestedSteps(step).some(holdsEach));
}

/** How many steps a definition holds, every branch and body counted — what `MAX_STEPS` bounds. */
function countSteps(steps: readonly StepSpec[]): number {
  return steps.reduce((total, step) => total + 1 + nestedSteps(step).reduce((sum, inner) => sum + countSteps(inner), 0), 0);
}

/** The step lists one step holds inside it. */
function nestedSteps(step: StepSpec): readonly (readonly StepSpec[])[] {
  switch (step.kind) {
    case "if":
      return [step.then, step.else];
    case "while":
    case "each":
      return [step.body];
    default:
      return [];
  }
}

/** How many indices `steps` takes in its run's layout: an `each`'s body is its children's. */
function laidCount(steps: readonly StepSpec[]): number {
  return steps.reduce(
    (total, step) =>
      total +
      1 +
      (step.kind === "if"
        ? laidCount(step.then) + laidCount(step.else)
        : step.kind === "while"
          ? laidCount(step.body)
          : 0),
    0,
  );
}

function objectOf(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) refuse(`${what} is an object`);
  return raw as Record<string, unknown>;
}

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** A span's length in milliseconds. */
export function spanMs(span: { readonly days?: number; readonly hours?: number; readonly minutes?: number }): number {
  return ((span.days ?? 0) * 24 * 60 + (span.hours ?? 0) * 60 + (span.minutes ?? 0)) * 60 * 1000;
}

// ─── the digest ─────────────────────────────────────────────────────────

/**
 * THE PIN: sha256 over the definition's canonical form, 32 hex characters —
 * the instructions digest's own length and alphabet (`@dito/execution`).
 *
 * CANONICAL BY CONSTRUCTION: the definition is serialized with its keys
 * sorted at every level, so two definitions that say the same thing stamp the
 * same and one changed word stamps differently. The run row carries this
 * value; the engine refuses content whose digest is not it.
 */
export function runDigest(definition: RunDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex").slice(0, 32);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─── the layout ─────────────────────────────────────────────────────────

/**
 * One step laid out: its index, and where the run goes after it.
 *
 * `next` is the index after this step — or `undefined` at the run's end, and
 * always on an `end`. An `if` has two: `then` is where it goes when its
 * condition holds and `next` where it goes when it does not (the `else`
 * branch, or past the `then` branch when there is no `else`). A `while` has
 * two: `body`, where it goes for another pass, and `next`, past its body once
 * it stops; the last step of its body goes back to it.
 */
export type LaidStep = (
  | Exclude<StepSpec, { readonly kind: "if" | "while" }>
  | { readonly kind: "if"; readonly name: string; readonly when: Condition }
  | {
      readonly kind: "while";
      readonly name: string;
      readonly when: Condition;
      readonly cap: Source<number> | number;
      /** Where the body begins, and the index just past its last step. */
      readonly body: number;
      readonly bodyEnd: number;
    }
) & {
  readonly index: number;
  readonly next: number | undefined;
  readonly then?: number | undefined;
};

/** The definition's steps in the order they can run, every one with its index. */
export function layout(definition: RunDefinition): readonly LaidStep[] {
  const laid: LaidStep[] = [];
  place(definition.steps, laid, 0, undefined);
  return laid;
}

/** Places `steps` from index `start`; the last of them goes to `after`. */
function place(
  steps: readonly StepSpec[],
  laid: LaidStep[],
  start: number,
  after: number | undefined,
): void {
  let at = start;
  const starts = steps.map((step) => {
    const index = at;
    at += laidCount([step]);
    return index;
  });
  steps.forEach((step, i) => {
    const index = starts[i]!;
    const following = i + 1 < steps.length ? starts[i + 1] : after;
    if (step.kind === "while") {
      place(step.body, laid, index + 1, index);
      laid[index] = {
        kind: "while",
        name: step.name,
        when: step.when,
        cap: step.cap,
        body: index + 1,
        bodyEnd: index + laidCount([step]),
        index,
        next: following,
      };
      return;
    }
    if (step.kind !== "if") {
      laid[index] = { ...step, index, next: step.kind === "end" ? undefined : following };
      return;
    }
    const thenStart = index + 1;
    const elseStart = thenStart + laidCount(step.then);
    place(step.then, laid, thenStart, following);
    place(step.else, laid, elseStart, following);
    laid[index] = {
      kind: "if",
      name: step.name,
      when: step.when,
      index,
      then: step.then.length === 0 ? following : thenStart,
      next: step.else.length === 0 ? following : elseStart,
    };
  });
}

// ─── reading typed fields ───────────────────────────────────────────────

/** What a run holds by the time a step reads: its inputs, and each finished step's output. */
export interface RunValues {
  readonly inputs: Readonly<Record<string, RunValue>>;
  readonly outputs: Readonly<Record<string, Readonly<Record<string, RunValue>>>>;
}

/** The value a reference names, or `undefined` when the run has none there. */
export function valueOf(ref: Ref, values: RunValues): RunValue | undefined {
  const [step, field] = ref.split(".") as [string, string];
  return step === "input" ? values.inputs[field] : values.outputs[step]?.[field];
}

/** The value a step reads off a `Source`: a reference's, or the one written here. */
export function sourceValue<T>(source: Source<T> | T, values: RunValues): RunValue | T | undefined {
  if (typeof source === "string") return valueOf(source, values);
  if (source !== null && typeof source === "object" && !Array.isArray(source) && "value" in source) {
    return (source as { readonly value: T }).value;
  }
  return source as T;
}

/** Whether a condition holds over the run's typed fields — code, never a model. */
export function holds(condition: Condition, values: RunValues): boolean {
  const value = valueOf(condition.field, values);
  const present = value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
  switch (condition.is) {
    case "present":
      return present;
    case "absent":
      return !present;
    case "true":
      return value === true;
    case "false":
      return value === false;
    case "equal":
      return value === condition.value;
    case "unequal":
      return value !== condition.value;
    case "more":
      return typeof value === "number" && value > (condition.value as number);
    case "less":
      return typeof value === "number" && value < (condition.value as number);
  }
}

/**
 * WHERE THE RUN GOES AFTER A STEP ENDS WELL — a pure function over the laid
 * steps and what the run holds: the next index, or `undefined` at the end.
 * An `if` reads its condition here and nowhere else; a `while` reads what its
 * own step just decided (`whileOutput`): another pass, or past its body.
 */
export function nextAfter(
  steps: readonly LaidStep[],
  index: number,
  values: RunValues,
): number | undefined {
  const step = steps[index];
  if (step === undefined) throw new Error(`step ${String(index)} is past the end of the run`);
  if (step.kind === "if") return holds(step.when, values) ? step.then : step.next;
  if (step.kind === "while") return values.outputs[step.name]?.["exited"] === undefined ? step.body : step.next;
  return step.next;
}

/**
 * WHICH PASS OF A `while` A RUN STANDS IN (tickets #324, #396): the innermost
 * `while` whose body holds the step it is at, how many passes it has begun,
 * and its cap when the definition or the run's inputs say it — what Trabajos
 * en curso reads of a run, and what a card the run lands keeps of it.
 */
export function passAt(
  laid: readonly LaidStep[],
  values: RunValues,
  at: number,
): { readonly pass: number; readonly passes?: number } | undefined {
  const around = laid
    .filter((step): step is Extract<LaidStep, { kind: "while" }> => step.kind === "while" && step.body <= at && at < step.bodyEnd)
    .at(-1);
  if (around === undefined) return undefined;
  const pass = values.outputs[around.name]?.["iteration"];
  if (typeof pass !== "number") return undefined;
  const cap = sourceValue(around.cap, values);
  return typeof cap === "number" ? { pass, passes: cap } : { pass };
}

/**
 * WHAT A `while` DECIDES EACH TIME THE RUN REACHES IT, from what the run holds
 * and its cap: another pass — `iteration` one more than the passes so far —
 * or a stop, with `exited` saying whether the condition failed or the cap was
 * reached. A `while` reached after it last stopped begins counting again.
 */
export function whileOutput(
  step: Extract<LaidStep, { kind: "while" }>,
  values: RunValues,
  cap: number,
): Readonly<Record<string, RunValue>> {
  const standing = values.outputs[step.name];
  const passes =
    standing === undefined || standing["exited"] !== undefined || typeof standing["iteration"] !== "number"
      ? 0
      : standing["iteration"];
  const counted: RunValues = { inputs: values.inputs, outputs: { ...values.outputs, [step.name]: { iteration: passes } } };
  if (!holds(step.when, counted)) return { iteration: passes, exited: "condition" };
  if (passes >= cap) return { iteration: passes, exited: "cap" };
  return { iteration: passes + 1 };
}

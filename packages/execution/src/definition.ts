/**
 * The execution definition: what an execution IS, digest-stamped (spec
 * #126 decision 5(b) and 17; user story 38 — "the owner twin's
 * instructions digest-stamped, so a change to what it is told is visible
 * and diffable").
 *
 * Instructions assembled from named parts, the tool list, how the turn ends
 * — a structured output, or its words (ticket #357) — the context inputs, and
 * a budget. The TOOL LIST
 * RIDES HERE (ADR-0013): an execution's tools are part of what it is,
 * resolved at construction, carried with its instructions and stamped with
 * them — not looked up again by the runner. Safety lives on each tool.
 * The runner's MCP server is what hands the tools to the model; what this
 * says is that no tool reaches an execution except by being written into
 * its definition, where the digest can see it.
 */
import { createHash } from "node:crypto";
import {
  canonicalParameters,
  EFFORTS,
  isEffort,
  isLane,
  LANES,
  type BudgetSpec,
  type ContextRecipeCall,
  type Effort,
  type Lane,
  type Wake,
} from "./automation.js";
import type { ReadDisposition } from "./record.js";
import { isSdkTool, SDK_TOOLS, type SdkTool } from "./sdk-tools.js";
import {
  assertToolDeclaration,
  type EffectOutcome,
  type ToolDeclaration,
  type ToolInputSchema,
} from "./tool.js";

/**
 * One named piece of an execution's text.
 *
 * The same shape serves the instructions and the context inputs, and that
 * is not an accident: both are text the model is shown, and the only
 * difference between them is the one the digest makes — the instructions
 * are stamped, the context is not.
 */
export interface NamedPart {
  readonly name: string;
  readonly text: string;
}

/**
 * What an execution may spend.
 *
 * `model` IS A FIELD WITH NO DEFAULT, deliberately. ADR-0015's routing
 * ladder is a per-call-site choice — Sonnet 5 for the owner twin — and no
 * default in library code is this repo's standing rule: a default here
 * would be a routing decision made in the one place nobody looks.
 */
export interface Budget {
  readonly model: string;
  /** The turn cap: the SDK ends the execution when it is reached (`maxTurns`). */
  readonly maxIterations: number;
  /**
   * The API's `max_tokens`: the cap on ONE call's output, the meaning the
   * word already has at every model call site in this repo
   * (`ModelCallConfig.maxTokens`) and in the API itself.
   *
   * WHAT IT DOES NOT BOUND, said plainly because a field called "max
   * tokens" invites the other reading: an execution's TOTAL spend. Six
   * iterations may each emit up to this many output tokens. A cumulative
   * ceiling is a different field and a different decision — one counting
   * input tokens would trip on the prompt alone — and no accepted sentence
   * asks for one. What the record carries instead is what was actually
   * spent, summed across the whole execution, so the question can be
   * answered from evidence before anyone writes a number.
   */
  readonly maxTokens: number;
  /**
   * How hard the model works before it answers — the API's
   * `output_config.effort` (spec #171 decision 8(2); ticket #148).
   *
   * UNSET IS AN ABSENCE, NOT A LEVEL, which is why it is optional rather
   * than defaulted to `medium`. Omitted, the request carries no
   * `output_config` key at all and the model applies its own default —
   * adaptive thinking on Sonnet 5 — and #148's two arms are `low` and THAT,
   * so a runtime that filled one in would make the second unmeasurable.
   * It moved here from the rep side's `ModelCallConfig`, where its own
   * comment said it belonged: "so drafting, Q&A and the kind classification
   * can take one when somebody measures what it buys them".
   */
  readonly effort?: Effort;
}

/**
 * The shared default output cap (spec #171 decision 8(2)).
 * It includes room for thinking, not just the short answer: caps sized
 * for prose alone can end before any answer (#148; #133's
 * 2,048-token owner-twin failure). Centralizing it keeps each automation
 * from rediscovering the same budget failure.
 *
 * The token cap is a shared floor for room to think, not a choice of rung,
 * so it has a runtime default; the model deliberately does not.
 * ADR-0015 leaves the model rung to the app boundary, where deployment
 * routing is visible.
 */
export const DEFAULT_MAX_TOKENS = 16_000;

/**
 * The budget an automation declared, plus the rung the deployment chose.
 *
 * TWO ARGUMENTS BECAUSE THE SPEC HOLDS NO MODEL (`automation.ts`): a shipped
 * constant naming `claude-sonnet-5` would be ADR-0015's routing decision
 * written into library code. The rung arrives from the app boundary and is
 * refused if it is empty, here rather than at the model call, so a
 * misconfigured deployment fails where the mistake is instead of at the
 * wire.
 */
export function resolveBudget(spec: BudgetSpec, model: string): Budget {
  if (model === "") refuse("a budget names its model (ADR-0015)");
  return {
    model,
    maxIterations: spec.maxIterations,
    maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
  };
}

/**
 * What the declared parser made of the typed result the model gave — the
 * value, or why it may not stand.
 */
export type SubmissionParse<S> =
  | { readonly ok: true; readonly submission: S }
  | { readonly ok: false; readonly reason: string };

/**
 * THE TYPED RESULT A TURN ENDS ON, AS THE SDK'S STRUCTURED OUTPUT (ticket
 * #357): the schema is handed to `query()` as its `outputFormat`, the CLI
 * holds the model to it — a call that does not match is answered with the
 * mismatch and tried again — and the result message's `structured_output`
 * is what `parse` reads.
 *
 * `parse` IS THE OWNING APP'S RULE OVER A VALUE THE SCHEMA ALREADY ADMITTED
 * (a reference that names nobody, say). It reads each output as the model
 * gives it, and one it refuses goes back to the model as that call's error,
 * so the model answers again (`TurnBook.structuredCheck`); the CLI counts
 * those against its own retries. A turn that ends without an output `parse`
 * accepts settles `schema-miss`, as an output the CLI gave up retrying does.
 */
export interface StructuredOutputContract<S> {
  readonly schema: ToolInputSchema;
  readonly parse: (output: unknown) => SubmissionParse<S>;
}

/**
 * What a turn did beside its typed result: its words — the text of the round
 * the model stopped on — every effect its tools reported, in order, and the
 * read tools that refused a call at their projection's fence.
 */
export interface TurnEnding {
  readonly words: string;
  readonly effects: readonly EffectOutcome[];
  /**
   * THE PROJECTION'S REFUSALS (ticket #363): the name of each read tool, in
   * call order, that refused a call for a parameter its projection does not
   * declare — a column, a table, a company (ADR-0013: a read owes a
   * projection). It is what the owner twin's `wall-refused` is read from:
   * what a tool did, never the kind the model chose.
   */
  readonly refused: readonly string[];
}

/**
 * An execution definition as written, before it is stamped. `Handled` is
 * the type of `dispositionOf`'s second argument — see there.
 */
export interface ExecutionDefinitionSpec<S, Handled = void> {
  readonly instructions: readonly NamedPart[];
  /**
   * PARTS RENDERED INTO THE INSTRUCTIONS FROM THE OCCASION'S DATA, after the
   * written ones (ticket #319; `DefinitionSpec.standing`): what a session is
   * told once, when its child opens — the twin thread's accepted keyword sets.
   *
   * NOT DIGESTED AS TEXT, for the reason the context is not: the words come
   * from the occasion's data and may vary per rep, so a digest over them
   * would stamp one automation a different way for every rep (ADR-0033 as
   * amended: one digest per Dito-authored automation). Which recipes render them, by name
   * and parameter shape, is in `recipes` and so in the stamp. What the model
   * is told is `instructionsText`: the written parts, then these.
   */
  readonly standing?: readonly NamedPart[];
  readonly tools: readonly ToolDeclaration[];
  /**
   * THE SDK'S OWN TOOLS THIS TURN IS GIVEN, BY NAME (ticket #326;
   * `sdk-tools.ts`): the CLI runs them, so they are names and not
   * declarations with a `run` — each under the gate `SDK_TOOL_GATES` maps it
   * to, the file tools held to the workspace by the runner's hook. Absent or
   * empty, the turn is given none.
   */
  readonly sdkTools?: readonly SdkTool[];
  /**
   * The typed result this turn ends on, when it declares one; absent, the
   * turn ends on its words (ticket #357).
   */
  readonly outputFormat?: StructuredOutputContract<S>;
  /**
   * WHAT THE TURN'S FINAL WORDS ARE HELD TO, where they are said to someone
   * (ticket #363): the reason they may not stand, or nothing. Words it
   * refuses go back to the model as the reason its turn may not end yet —
   * the SDK's `Stop` hook — so it writes them again inside the budget it
   * already has; a turn that still ends on refused words fails. Only for a
   * turn that ends on its words.
   *
   * NOT DIGESTED, like `parse`: it is code, and what the model is told about
   * its words is in its instructions.
   */
  readonly wordsRule?: (words: string) => string | undefined;
  /**
   * WHETHER AN EFFECT MAY LEAVE THIS EXECUTION WAITING ON AN ANSWER (ticket
   * #324; `EffectOutcome.waitsOn`): such an execution settles `asked` and the
   * owning app parks it; one that may not be left waiting fails.
   *
   * NOT DIGESTED, like the lane: it is what the owning app does with a
   * waiting execution, never anything the model is shown.
   */
  readonly suspends?: true;
  /**
   * What this execution is shown. Fetched fresh by the owning app and
   * handed in whole — which is what makes "context never spans two
   * executions" (CONTEXT.md, Execution) true by construction: a second
   * turn is a second execution with its own inputs, not this one resumed.
   */
  readonly context: readonly NamedPart[];
  /**
   * WHICH RECIPES RENDERED THAT CONTEXT — names and parameter SHAPES, never
   * values (spec #171 decision 9; ticket #178 AC 2).
   *
   * THE STAMP'S OTHER HALF, and the reason the pair exists. `context` is the
   * rendered text and is deliberately not digested, because it varies every
   * execution. But WHICH recipes an automation asks for, and what the
   * occasion must bind into them, is exactly as much a part of what an
   * execution IS as its instruction parts are: swapping `now` for
   * `now_owner` puts a different line in front of the model, and a stamp
   * that could not see it would attest to the wrong prompt.
   *
   * EMPTY IS HONEST, not a hole: a definition whose context was rendered by
   * its caller rather than by recipes stamps as one with no recipes, and
   * there is one digest function over one shape either way.
   */
  readonly recipes: readonly ContextRecipeCall[];
  readonly budget: Budget;
  /**
   * Which of the runtime's two lanes this runs in (spec #171 decision 3).
   *
   * NOT DIGESTED, and this is the field that says why the digest is not
   * simply "everything about the definition": the lane is how the runtime
   * SCHEDULES an execution and is never shown to the model, so a lane in the
   * stamp would make one automation stamp two ways depending on which queue
   * picked it up. It rides on the definition rather than being passed to
   * `runExecution` so that an automation's own declaration reaches the
   * record without every call site threading it by hand.
   */
  readonly lane: Lane;
  /**
   * THE WAKE THIS DEFINITION CAME FROM (Codex r2).
   *
   * WHY THE DEFINITION CARRIES IT. The trigger record says what a run was
   * about and how it came to be, and the automation's wake DECLARES both —
   * so without this they were two independent statements of the same two
   * words, restated at the call site and free to drift. `runExecution`
   * refuses a trigger whose occasion or mechanism disagrees with the wake,
   * which is what makes the record's `mechanism` and `kind` attributable to
   * the automation that ran rather than to whatever the caller typed.
   *
   * NOT DIGESTED, like the lane: a wake is how an execution came to exist,
   * never anything the model is shown.
   */
  readonly wake: Wake;
  /**
   * The owning app's reading of how its turn ended, READ FROM WHAT HAPPENED
   * (ticket #357): `output` is the turn's typed result (or `undefined`) and
   * `ending` carries its words, its effects and its read tools' refusals, so
   * the word is read off what the tools reported rather than off anything the
   * model said — which is why a definition may answer `acted`.
   *
   * THE SECOND ARGUMENT IS ALWAYS `undefined`: no runner hands one. It stays
   * in its place because the owner twin's reader takes `ending` third.
   */
  readonly dispositionOf: (
    output: S,
    handled: Handled | undefined,
    ending: TurnEnding,
  ) => ReadDisposition;
}

/** An execution definition, stamped. */
export interface ExecutionDefinition<S, Handled = void>
  extends ExecutionDefinitionSpec<S, Handled> {
  /** The instructions digest — see `instructionsDigest`. */
  readonly digest: string;
}

/** An invalid definition, refused at construction or the runner's pre-call checks. */
export class ExecutionDefinitionError extends Error {
  override readonly name = "ExecutionDefinitionError";
}

/** Hex characters kept, as `EXTRACTION_CONTRACT_DIGEST` keeps them. */
const DIGEST_LENGTH = 32;

/**
 * The canonical form the digest hashes: a positional array, so nothing
 * depends on a key name or on where a field sits in an object literal.
 *
 * The trick is `@dito/audit`'s `canonical()`, which encodes a chain entry
 * the same way and for the same reason — a separator-joined string has to
 * answer "what if a part contains the separator", and a positional JSON
 * array does not.
 *
 * A tool's schema goes in as written. Two semantically identical schemas
 * with their keys in a different order therefore stamp differently, which
 * is correct: the digest records WHAT THE MODEL WAS TOLD, and the model is
 * told the schema in the order it is written.
 */
function canonical<S, Handled>(spec: ExecutionDefinitionSpec<S, Handled>): string {
  return JSON.stringify([
    spec.instructions.map((part) => [part.name, part.text]),
    spec.tools.map((tool) => [
      tool.name,
      tool.description,
      tool.inputSchema,
      tool.gate,
      tool.gate === "projection" ? tool.columns : null,
      // A TOOL THAT ENDS THE TURN SAYS SO, ONLY WHERE ONE DOES (ticket #401):
      // every other tool stamps as it did.
      ...(tool.endsTurn === true ? ["ends the turn"] : []),
    ]),
    // A SLOT THAT IS ALWAYS NULL, kept so every definition stamps as it
    // did before the slot's ending was deleted (ticket #364): a stamp is
    // what a recorded execution is joined on.
    null,
    [
      spec.budget.model,
      spec.budget.maxIterations,
      spec.budget.maxTokens,
      // `null` for an absent effort, and never omitted: a positional array
      // whose length varied would let two different budgets encode the same
      // way, which is the hole the positional form exists to close.
      spec.budget.effort ?? null,
    ],
    spec.recipes.map((call) => [call.recipe, canonicalParameters(call.parameters)]),
    // THE SDK'S OWN TOOLS, ONLY WHERE THERE ARE ANY, tagged so the entry can
    // never be read as the schema beside it — a definition given none stamps
    // with no entry here at all.
    ...(spec.sdkTools === undefined || spec.sdkTools.length === 0 ? [] : [["sdk tools", ...spec.sdkTools]]),
    // THE TYPED RESULT'S SCHEMA, ONLY WHERE THERE IS ONE.
    ...(spec.outputFormat === undefined ? [] : [spec.outputFormat.schema]),
  ]);
}

/**
 * Stamps one definition: sha256 over the canonical form above, hex, cut to
 * 32 characters. The prior art is `EXTRACTION_CONTRACT_DIGEST`, and the
 * reason it exists is the reason this does — a report that recorded a model
 * name and a corpus digest could not tell two runs of DIFFERENT PROMPTS
 * apart, and the same hole here would let "the digest is stable across
 * identical runs" (spec #126's definition of done, item 10) be satisfied by
 * a stamp that covered nothing.
 *
 * WHAT IT COVERS: every instruction part, name and text, in order; every
 * tool, with its description, its schema, its gate, its pinned columns and
 * whether it ends the turn, in order; the SDK's own tools it is given, by name, when it is given any;
 * the structured output's schema for a definition that ends on one; all four
 * budget fields, effort included; and every context recipe by NAME with the
 * SHAPE of its occasion-bound parameters.
 *
 * WHAT IT DOES NOT COVER, said out loud so a green is not read as more than
 * it is:
 *
 *   - THE CONTEXT INPUTS. They vary per execution by design — a different
 *     owner question every time, a different instant in the `now` part — so
 *     a digest covering them would change on every execution and could never
 *     answer "was this the same instructions". The recipe's NAME and SHAPE
 *     are covered and its rendered VALUE is not, which is the line drawn
 *     exactly where the varying starts.
 *   - THE LANE. It is how the runtime schedules an execution, never
 *     something the model is told; see `ExecutionDefinitionSpec.lane`.
 *   - THE CODE. A tool's `run` and the output's `parse` are functions;
 *     what they do can change completely under an unchanged stamp. The
 *     digest records the CONTRACT the model was given, not the
 *     implementation behind it.
 *   - THE MODEL'S BEHAVIOUR, and the wording is never asserted in CI
 *     (ADR-0028). This records WHICH wording, so an execution and the
 *     instructions that produced it cannot be separated after the fact.
 */
export function instructionsDigest<S, Handled>(
  spec: ExecutionDefinitionSpec<S, Handled>,
): string {
  return createHash("sha256")
    .update(canonical(spec))
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

function refuse(reason: string): never {
  throw new ExecutionDefinitionError(reason);
}

/**
 * Refuse invalid definitions at construction and again before execution
 * (Codex r3). The interface is structural: a caller can spread a stamped
 * value and replace its budget without returning through defineExecution.
 * One shared assertion prevents either entry point from enforcing a
 * different subset of the limits.
 */
export function assertDefinition<S, Handled>(
  spec: ExecutionDefinitionSpec<S, Handled>,
): void {
  if (spec.instructions.length === 0) {
    refuse("an execution with no instructions is not an execution");
  }
  if (spec.context.length === 0) {
    // The context inputs are the user turn, and a turn with no content is
    // a 400 from the API — a refusal here names the real problem instead.
    refuse("an execution is shown at least one context input");
  }
  for (const tool of spec.tools) assertToolDeclaration(tool);

  const names = spec.tools.map((tool) => tool.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    refuse(`two tools are named "${duplicate}": the model's call is ambiguous`);
  }
  for (const sdkTool of spec.sdkTools ?? []) {
    // BASH AND WEBFETCH NEVER (spec #318 decision 9): a definition that names
    // either, or any tool of the CLI's the design does not allow, is refused
    // here, whoever built it.
    if (!isSdkTool(sdkTool)) {
      refuse(`"${String(sdkTool)}" is not an SDK tool a definition may name: ${SDK_TOOLS.join(", ")} — Bash and WebFetch stay off until the unit's egress is enforced at the network`);
    }
    if (names.includes(sdkTool)) refuse(`a tool of ours is named "${sdkTool}", which is an SDK tool's own name`);
  }
  if (new Set(spec.sdkTools ?? []).size !== (spec.sdkTools ?? []).length) {
    refuse("an SDK tool is named twice");
  }
  if (spec.wordsRule !== undefined && spec.outputFormat !== undefined) {
    refuse("a rule over a turn's words holds only a turn that ends on its words");
  }

  if (spec.budget.model === "") refuse("a budget names its model (ADR-0015)");
  // THE LANE IS A WORD FROM A CLOSED SET, checked here for the same reason
  // the budget's numbers are: a definition can be spread and cast past the
  // type, and a lane the runtime does not know would run the execution,
  // reach the store, and be refused by a CHECK constraint after the model
  // had already been paid for.
  if (!isLane(spec.lane)) {
    refuse(
      `a definition runs in one of ${LANES.join(" or ")}, and this one declares "${String(spec.lane)}"`,
    );
  }
  // WHOLE NUMBERS, CHECKED FOR FINITENESS (Codex r2). `NaN` and `Infinity`
  // are numbers and both pass a bare `< 1`, and neither is a turn cap: `NaN`
  // compares false against every count and `Infinity` is never reached — an
  // unbounded model loop from a budget that typechecked. `Number(
  // process.env.X)` on an unset variable is exactly how one arrives. Both
  // also serialize to `null` through `JSON.stringify`, so two different
  // broken budgets would stamp the same digest.
  if (!Number.isInteger(spec.budget.maxIterations) || spec.budget.maxIterations < 1) {
    refuse(
      `a budget's max iterations is a whole number of at least one, and this one is ${String(spec.budget.maxIterations)}`,
    );
  }
  if (!Number.isInteger(spec.budget.maxTokens) || spec.budget.maxTokens < 1) {
    refuse(
      `a budget's max tokens is a whole number of at least one, and this one is ${String(spec.budget.maxTokens)}`,
    );
  }
  // AN EFFORT THE API DOES NOT KNOW IS A 400 MID-EXECUTION (Codex r2), and
  // it arrives the same way a broken budget number does: past the type,
  // through a cast or a boundary setting. Absent is not a level — that is
  // the whole of what `Budget.effort` optional means — so only a PRESENT
  // one is checked.
  if (spec.budget.effort !== undefined && !isEffort(spec.budget.effort)) {
    refuse(
      `a budget's effort is one of ${EFFORTS.join(", ")}, or absent for the model's own default, and this one is "${String(spec.budget.effort)}"`,
    );
  }
}

/**
 * Constructs one execution definition, or refuses.
 *
 * THIS IS THE FENCE THAT MATTERS FOR THE GATE. `defineTool` catches a tool
 * built through it; `assertDefinition` catches every tool, however it was
 * built — including one cast into place or read out of JSON — because no
 * tool reaches an execution except through a definition.
 */
export function defineExecution<S, Handled = void>(
  spec: ExecutionDefinitionSpec<S, Handled>,
): ExecutionDefinition<S, Handled> {
  assertDefinition(spec);
  return { ...spec, digest: instructionsDigest(spec) };
}

/**
 * The instructions as the model is shown them: each part under its own
 * name, in order.
 *
 * The names are not decoration — they are what makes a digest change
 * readable ("the refusal part changed") and what a definition is assembled
 * from. Rendered here rather than by the caller so that what is STAMPED and
 * what is SENT come from the same list.
 */
export function renderParts(parts: readonly NamedPart[]): string {
  return parts.map((part) => `## ${part.name}\n\n${part.text}`).join("\n\n");
}

/**
 * The system prompt a definition gives the model: its written instruction
 * parts, then its standing ones (ticket #319).
 */
export function instructionsText<S, Handled>(
  definition: ExecutionDefinitionSpec<S, Handled>,
): string {
  return renderParts([...definition.instructions, ...(definition.standing ?? [])]);
}

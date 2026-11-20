/**
 * ONE TURN OF THE MODEL LOOP, AS AN EXECUTION (ADR-0014 as amended
 * 2026-09-27; spec #318 decisions 7 and 8; tickets #328 and #319).
 *
 * The harness has two shapes — the single-message `query()` every automation
 * but the twin thread runs (`runner.ts`), and the streaming-input session the
 * thread runs a whole day in (`session.ts`) — and ONE wrapper that makes a
 * turn an execution: its tools served over MCP with every gate in their own
 * handlers, its ending — the model stopping, on the SDK's structured output
 * when it declares one (ticket #357) — its rounds, tokens, words and
 * truncation read off the stream, whether it has an outcome decided by one
 * failure ladder, its disposition by the definition's `dispositionOf`, and
 * one record and one audit entry. That wrapper lives here, so the
 * two shapes cannot drift apart on what an execution is: a shape decides how
 * the child is fed and when a turn ends, and nothing else.
 */
import type {
  HookCallback,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { wakeAccepts } from "./automation.js";
import { executionAuditEntry, type ExecutionAuditChain } from "./audit.js";
import {
  assertDefinition,
  instructionsDigest,
  ExecutionDefinitionError,
  type ExecutionDefinition,
  type TurnEnding,
} from "./definition.js";
import {
  isDisposition,
  type Disposition,
  type ExecutionRecord,
} from "./record.js";
import {
  inputViolations,
  type EffectOutcome,
  type ToolDeclaration,
  type ToolInputSchema,
} from "./tool.js";
import { workspacePath, writesTheWorkspace, WROTE_ACT, type SdkTool } from "./sdk-tools.js";
import type { ToolCall, ToolCallOutcome, Trace } from "./trace.js";
import type { Trigger } from "./trigger.js";

/**
 * Provider cutoff reasons (#176, kind-harness Codex round 1).
 * Check both output and context ceilings: a complete-looking tool call or
 * output can arrive under either truncation flag and must not become an answer.
 */
const TRUNCATION_STOP_REASONS: readonly string[] = [
  "max_tokens",
  "model_context_window_exceeded",
];

/**
 * The in-process MCP server's name, and so the prefix of every tool name the
 * model sees: `mcp__dito__<tool>`. The record, the trace and every gate keep
 * the bare name; only the wire carries the prefix.
 */
export const SERVER = "dito";

/** The name the model calls a tool by. */
export function wireName(tool: string): string {
  return `mcp__${SERVER}__${tool}`;
}

/**
 * The SDK tools ruled off until the unit's egress is enforced at the network
 * (spec #318 decision 9). The base set is only the SDK tools a definition
 * names, and no definition may name these two (`assertDefinition`); this list
 * is the belt, so widening the base set later cannot bring them back by
 * accident.
 */
export const DISALLOWED_SDK_TOOLS = ["Bash", "WebFetch"];

/**
 * THE CLI'S OWN TOOL FOR A STRUCTURED OUTPUT (ticket #357): with an
 * `outputFormat`, the child offers the model this tool, validates its input
 * against the schema and ends the turn on it. It is never ours to serve, and
 * it is on a turn's list only when the turn declares a typed result.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * THE SDK'S WORD FOR A TOOL RESULT THAT ENDS THE TURN (`_meta` on the MCP
 * result): the child takes no further model call after it, whatever else the
 * turn would have asked for — a structured output included.
 */
const END_TURN_META = "claude/endTurn";

/** A structured output's schema as the `query()` option the SDK takes (`outputFormat`). */
export function sdkOutputFormat(
  schema: ToolInputSchema | undefined,
): { readonly outputFormat?: { readonly type: "json_schema"; readonly schema: Record<string, unknown> } } {
  return schema === undefined ? {} : { outputFormat: { type: "json_schema", schema: { ...schema } } };
}

/**
 * The names a child lets the model call: the listed tools by their wire
 * names, the SDK's own tools the turn is given by theirs, and the CLI's
 * structured-output tool when the turn ends on one.
 */
export function onTheListOf(
  listed: readonly { readonly name: string }[],
  outputFormat: ToolInputSchema | undefined,
  sdkTools: readonly SdkTool[] = [],
): ReadonlySet<string> {
  return new Set([
    ...listed.map((tool) => wireName(tool.name)),
    // THE SDK'S OWN TOOLS GO BY THEIR OWN NAMES (ticket #326): the CLI serves
    // them, so the wire carries no prefix.
    ...sdkTools,
    ...(outputFormat === undefined ? [] : [STRUCTURED_OUTPUT_TOOL]),
  ]);
}

/**
 * What a completed execution hands back: its typed result, its words, its
 * record, and what its effect tools DID.
 *
 * `effects` IS WHY A RECEIPT CANNOT BE FAKED (spec #171 decision 22;
 * ADR-0037 as amended). Every effect tool call of this execution is here in
 * the order it was made, carrying what the tool itself reported — so the
 * owning app posts an acknowledgement rendered from the tool's result and
 * never from the model's prose, and words that CLAIM an effect with no call
 * behind them leave this list empty and render nothing.
 *
 * IT IS ALSO WHERE `acted` COMES FROM, and it is read here rather than
 * assigned by the app for the same reason (see `assign`).
 */
export interface ExecutionOutcome<S> {
  /** The typed result: the structured output, `undefined` when it declares none. */
  readonly submission: S;
  /** The text of the round the model stopped on: what it said last, `""` when it said nothing. */
  readonly words: string;
  readonly record: ExecutionRecord;
  readonly effects: readonly EffectOutcome[];
}

/**
 * One piece of the model's text, as the provider streamed it (ticket #357).
 *
 * `round` IS THE MODEL CALL IT BELONGS TO, which is what tells a sentence the
 * model wrote before a tool call from the one it ends on: a reader keeps the
 * pieces of the latest round and starts over when the round changes, and what
 * it holds at the end is the turn's `words`.
 */
export interface WordsPiece {
  readonly round: number;
  readonly text: string;
}

/**
 * An execution with no outcome: the failure ladder named why
 * (`failureOf`).
 *
 * IT CARRIES THE RECORD, and that is not decoration. The failed-query log
 * (FR-48) is an execution disposition rather than a second system (spec
 * #126 decision 2), so a failure that threw the record away would take the
 * only trace of the question with it. The owning app catches this and
 * persists `error.record` through its store exactly as it persists a
 * successful one.
 */
export class ExecutionError extends Error {
  override readonly name = "ExecutionError";
  readonly record: ExecutionRecord;

  constructor(
    message: string,
    record: ExecutionRecord,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.record = record;
  }
}

/**
 * One tool as the MCP server lists it: what the model is shown.
 *
 * THE LISTING AND THE ANSWERING ARE SEPARATE, because a session lists its
 * tools once, when its child opens, and answers every call with the handlers
 * of whichever turn is running — each turn's tools are bound to that turn's
 * own connection and evidence (`session.ts`).
 */
export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * One tool as a turn serves it: what the model is shown, and what runs when
 * it is called.
 *
 * `answer` NEVER THROWS. Whatever happened — a rejection, a refusal, a
 * handler that threw — is already decided and recorded by the time it
 * returns, and `isError` is what tells the model a call failed.
 */
interface ServedTool extends ListedTool {
  readonly answer: (input: unknown) => Promise<ServedAnswer>;
}

/** What one call answers the model. */
export interface ServedAnswer {
  readonly text: string;
  readonly isError: boolean;
  /**
   * The call ended the turn (ticket #357): an effect that left the execution
   * waiting on an answer, after which there is nothing for the model to do.
   */
  readonly endsTurn?: true;
}

/**
 * Hands one declared tool to the MCP server with input validation, failure
 * tracking and effect-result capture the SDK does not supply.
 *
 * ONE: THE SCHEMA IS ENFORCED HERE (Codex r1). The server lists each tool's
 * own JSON schema and validates nothing against it, so a schema closed with
 * `additionalProperties: false` tells the model what it may send and stops
 * nothing from arriving. A read whose caller can add a parameter it never
 * declared has no pinned projection whatever its declaration says, so an
 * undeclared parameter is refused to the model and the handler is never
 * called.
 *
 * TWO: A HANDLER THAT THROWS IS NOT A TOOL RESULT (Codex r1). The model is
 * told the call failed and can carry on, so a read whose database call
 * failed looks, from inside the loop, like one that returned nothing
 * interesting, and the model can go on to compose a confident answer over
 * it. The failure is recorded here so the execution lands `failed`.
 *
 * THREE: AN EFFECT'S RESULT IS A VALUE, NOT A STRING (#174). An effect has
 * to be able to tell the runtime whether it really happened, or `acted`
 * would be a word the model could talk its way into. So an effect tool's
 * handler returns an `EffectOutcome`, this is where it is recorded, and the
 * model is served the outcome's own `told`. That is also why the record of
 * what a tool did is taken here, from the handler's value, and never from a
 * post-tool hook, which sees only the text the model was handed.
 */
function served(
  tool: ToolDeclaration,
  report: {
    readonly failure: (failure: string) => void;
    readonly effect: (outcome: EffectOutcome) => void;
    /** A read tool's call refused at its projection's fence (`TurnEnding.refused`). */
    readonly refused: (tool: string) => void;
    /** One call, as it answered — `trace.ts` argues what for (#177 hotfix 1). */
    readonly call: (call: ToolCall) => void;
    /** A call of a tool that ends the turn went through (`ToolBase.endsTurn`). */
    readonly ended: (tool: string) => void;
  },
): ServedTool {
  /**
   * Report the same answer to the trace and the model (#177 hotfix 1).
   * One helper for every branch prevents a trace from attributing words to
   * a tool that the model did not receive.
   */
  const answered = (
    input: unknown,
    outcome: ToolCallOutcome,
    said: string,
    isError = false,
    endsTurn = false,
  ): ServedAnswer => {
    report.call({
      tool: tool.name,
      input,
      outcome,
      ...(outcome === "returned" || outcome === "performed"
        ? { result: said }
        : { reason: said }),
    });
    return { text: said, isError, ...(endsTurn ? { endsTurn: true as const } : {}) };
  };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    answer: async (input) => {
      const violations = inputViolations(tool.inputSchema, input);
      if (violations.length > 0) {
        // NOT AN EFFECT CALL AT ALL, and not recorded as one: the handler
        // was never reached, so there is nothing for `acted` to rest on and
        // no receipt to render. A rejection is the model being told what it
        // sent, which is the same answer a read gets.
        if (tool.gate === "projection") report.refused(tool.name);
        return answered(input, "rejected", `rejected: ${violations.join("; ")}`);
      }
      try {
        if (tool.gate === "projection") {
          const returned = await tool.run(input);
          if (tool.endsTurn === true) report.ended(tool.name);
          return answered(input, "returned", returned);
        }
        const outcome = await tool.run(input);
        report.effect(outcome);
        if (outcome.performed && tool.endsTurn === true) report.ended(tool.name);
        // AN EFFECT THAT LEFT THE EXECUTION WAITING ENDS THE TURN (ticket
        // #357): the answer resumes it, so the model is asked nothing more —
        // not even a typed result it could not yet know.
        return answered(
          input,
          outcome.performed ? "performed" : "refused",
          outcome.told,
          false,
          outcome.performed && outcome.waitsOn !== undefined,
        );
      } catch (error) {
        const failure = `the tool ${tool.name} failed: ${String(error)}`;
        report.failure(failure);
        // A THROW IS `refused` WITH THE FAILURE AS ITS REASON (`trace.ts`
        // argues the shared word): the call did not happen, and the reader
        // most likely to need this line is the one debugging exactly it.
        return answered(input, "refused", failure, true);
      }
    },
  };
}

/**
 * The in-process MCP server a child's tools are served from: the listing it
 * was opened with, and one function that answers every call.
 *
 * THE LOW-LEVEL HANDLERS, NOT `tool()`. The SDK's `tool()` helper takes a
 * zod shape and converts it to JSON Schema, and the MCP server's own
 * registration validates arguments against that shape before a handler
 * runs. Every tool here already IS a JSON schema, validated by
 * `inputViolations` with a rejection the model is shown — so listing the
 * declared schema as it stands keeps one schema per tool and one validator,
 * and no second schema is ever written or derived.
 *
 * EVERY TOOL IS LOADED EAGERLY (`anthropic/alwaysLoad`): deferred tools sit
 * behind a tool search the model has to call first, and without their
 * schemas it calls them blind (spike #290 fact 1).
 */
export function toolServer(
  listing: readonly ListedTool[],
  call: (name: string, input: unknown) => Promise<ServedAnswer>,
): McpServer {
  const server = new McpServer(
    { name: SERVER, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listing.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object" } & Record<string, unknown>,
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }));
  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const answer = await call(request.params.name, request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: answer.text }],
        ...(answer.isError ? { isError: true } : {}),
        ...(answer.endsTurn === true ? { _meta: { [END_TURN_META]: true } } : {}),
      };
    },
  );
  return server;
}

/**
 * The pre-tool hook: any tool not on this execution's list is denied, and the
 * denial reaches the model as that call's error (spike #290 fact 1).
 *
 * A BELT, SAID PLAINLY. With `tools: []` and one MCP server, every tool the
 * CLI can run is on the list, and a name off it is refused by the CLI itself
 * («No such tool available») before any hook runs — so in these executions
 * this hook is never the one that says no. It is here so that a later change
 * to the base tool set cannot put a tool in reach of the model without also
 * putting it on a definition's list.
 */
export function denyOffList(allowed: ReadonlySet<string>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse" || allowed.has(input.tool_name)) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${input.tool_name} is not on this execution's tool list.`,
      },
    };
  };
}

/**
 * The checks every execution passes before its model call, in either shape.
 *
 * Revalidate before the model call (Codex r2/r3): a structural definition
 * can be spread and changed without returning through defineExecution.
 * A spread maxIterations: NaN would reach the SDK as no turn cap at all.
 * Gate and budget guarantees must hold when it runs, not only when built.
 *
 * AND THE STAMP MUST STILL DESCRIBE WHAT RUNS. The digest goes into the
 * record and into the append-only chain; a stale one makes both attest to
 * instructions, tools or a budget that were not the ones used, which is the
 * single thing stamping exists to prevent.
 *
 * ...AND THE TRIGGER MUST BE ONE THE AUTOMATION DECLARED (#178, Codex r2).
 * The automation's wake names the occasion and which mechanisms may fire it;
 * the trigger carries the pair into the record and onto the append-only
 * chain. Without this they are two independent statements of the same two
 * words, so one automation's definition could be run and audited as another's
 * with nothing in the record to say so.
 */
export function assertRunnable<S, Handled>(
  trigger: Trigger,
  definition: ExecutionDefinition<S, Handled>,
): void {
  assertDefinition(definition);
  const stamp = instructionsDigest(definition);
  if (stamp !== definition.digest) {
    throw new ExecutionDefinitionError(
      `the definition's digest is ${definition.digest} but its contents stamp as ${stamp}: it changed after it was stamped`,
    );
  }
  if (
    trigger.kind !== definition.wake.occasion ||
    !wakeAccepts(definition.wake, trigger.mechanism)
  ) {
    throw new ExecutionDefinitionError(
      `this definition wakes on ${definition.wake.occasion} by ${definition.wake.mechanism} and the trigger is ${trigger.kind} by ${trigger.mechanism}: the record and the chain entry would attest to an automation that did not run`,
    );
  }
}

/**
 * EVERYTHING ONE TURN ACCUMULATES, from its first model call to its result:
 * the tools it serves, the effects its
 * tools reported, and its rounds and tokens as the stream told them.
 *
 * ONE BOOK PER EXECUTION, in either shape. The single-message runner opens
 * one per `query()`; a session opens one per wake and hands the stream to
 * whichever book's turn is running — so a turn's numbers, its trace and its
 * tool failures are its own, never its neighbour's in the same conversation.
 */
export class TurnBook<S, Handled = void> {
  readonly definition: ExecutionDefinition<S, Handled>;
  /**
   * WHEN THE TURN BEGAN (ticket #358): the instant its book was opened, until
   * a session says the turn began later (`began`) — a wake waits its turn on
   * the session behind the one running, and its record says when it ran.
   */
  #startedAt = new Date();
  #began = false;
  /** This turn's tools, as their handlers serve them. */
  readonly tools: readonly ServedTool[];
  /** The wire names this turn's tools are called by. */
  readonly onTheList: ReadonlySet<string>;
  readonly #trace: Trace | undefined;
  readonly #onWords: ((piece: WordsPiece) => void) | undefined;
  /** The result message's structured output, when the child reported one. */
  #structured: { readonly given: unknown } | undefined;
  /** Why the child gave up on the structured output, when it did. */
  #structuredGaveUp: string | undefined;
  /** Whether the child's turn cap stopped the turn before the model did. */
  #capped = false;
  #toolFailure: string | undefined;
  /** The read tools that refused a call at their projection's fence, in order. */
  readonly #projectionRefusals: string[] = [];
  /**
   * Every effect tool call this execution made, in order.
   *
   * PER CALL RATHER THAN A FLAG, because the owning app renders one
   * acknowledgement per act and needs to know which act: a boolean would
   * answer `acted` and nothing else.
   */
  readonly #effects: EffectOutcome[] = [];
  /** The card an effect left this execution waiting on (ticket #324), when one did. */
  #waitsOn: string | undefined;
  /** The wire name of the call that ended the turn (`ToolBase.endsTurn`), when one did. */
  #endedOn: string | undefined;
  #iterations = 0;
  #input = 0;
  #output = 0;
  #truncated: string | undefined;
  /** The round being streamed: what it spent, and what it said. */
  #round = {
    input: 0,
    output: 0,
    stop: null as string | null,
    text: [] as string[],
  };

  constructor(
    definition: ExecutionDefinition<S, Handled>,
    options: {
      readonly trace?: Trace;
      readonly onWords?: (piece: WordsPiece) => void;
    } = {},
  ) {
    this.definition = definition;
    this.#trace = options.trace;
    this.#onWords = options.onWords;
    this.tools = [
      ...definition.tools.map((tool) =>
        served(tool, {
          failure: (failure) => {
            this.#toolFailure ??= failure;
          },
          effect: (outcome) => {
            this.#effects.push(outcome);
            if (outcome.performed && outcome.waitsOn !== undefined) this.#waitsOn ??= outcome.waitsOn;
          },
          refused: (tool) => {
            this.#projectionRefusals.push(tool);
          },
          call: (call) => this.#traceCall(call),
          ended: (tool) => {
            this.#endedOn ??= wireName(tool);
          },
        }),
      ),
    ];
    this.onTheList = onTheListOf(this.tools, definition.outputFormat?.schema, definition.sdkTools);
  }

  /** Answers one call by its wire or bare name; a name off the list is the error it is. */
  async call(name: string, input: unknown): Promise<ServedAnswer> {
    const bare = name.startsWith(`mcp__${SERVER}__`)
      ? name.slice(`mcp__${SERVER}__`.length)
      : name;
    const tool = this.tools.find((candidate) => candidate.name === bare);
    // The CLI refuses a name its tool list does not hold before it gets
    // here; a request that arrives anyway is answered as the error it is.
    if (tool === undefined) {
      return { text: `${name} is not on this execution's tool list`, isError: true };
    }
    return await tool.answer(input);
  }

  /**
   * One tool call, placed in the round whose response asked for it.
   *
   * THE ITERATION IS READ AND NOT PASSED, because the child runs a round's
   * tools only after that round's stream has ended — so `iterations` IS the
   * round that called it, and several calls in one response all carry the
   * same number.
   */
  #traceCall(call: ToolCall): void {
    this.#trace?.({ kind: "tool_call", iteration: this.#iterations, at: new Date(), ...call });
  }

  /**
   * One stream event of this turn's own loop (a subagent's stream is never
   * handed here — it is not a round of this execution).
   *
   * THE ROUNDS ARE READ OFF THE STREAM. Every model call the child makes
   * arrives as stream events from `message_start` to `message_stop`, and those
   * are the only messages that carry a call's stop reason and its usage — the
   * assembled assistant messages carry neither. So the iteration count, the
   * token totals, the truncation guard and the trace are one reading of one
   * sequence, and the words reach `onWords` from the same events.
   */
  onStreamEvent(event: BetaRawMessageStreamEvent): void {
    switch (event.type) {
      case "message_start": {
        this.#iterations += 1;
        // The two cache counters are input tokens that `input_tokens` does
        // not include; the CLI marks its prompt blocks for caching, so on a
        // real call they are most of the input.
        //
        // SPEND IS COUNTED AS IT IS REPORTED, not when the round closes: a
        // stream cut off before `message_stop` was still paid for (Codex r1).
        const usage = event.message.usage;
        this.#round = {
          input:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          output: usage.output_tokens,
          stop: null,
          text: [],
        };
        this.#input += this.#round.input;
        this.#output += this.#round.output;
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type !== "tool_use") return;
        if (!this.onTheList.has(block.name)) {
          // A NAME OFF THE LIST NEVER REACHES A HANDLER — the CLI answers it
          // with an error before any hook runs — so this is the only place
          // the trace can say the model asked for it.
          this.#traceCall({
            tool: block.name,
            input: undefined,
            outcome: "rejected",
            reason: `${block.name} is not on this execution's tool list`,
          });
        }
        return;
      }
      case "content_block_delta": {
        if (event.delta.type === "text_delta") {
          this.#round.text.push(event.delta.text);
          // STREAMED AS IT ARRIVES, never held for the round's end (ticket
          // #357): the piece is the provider's own, and what the model says
          // last is what a reader of the pieces holds when the turn ends.
          if (event.delta.text !== "") {
            this.#onWords?.({ round: this.#iterations, text: event.delta.text });
          }
        }
        return;
      }
      case "message_delta": {
        // The delta's count is the round's running total, so only what it
        // adds is added.
        this.#output += event.usage.output_tokens - this.#round.output;
        this.#round.output = event.usage.output_tokens;
        this.#round.stop = event.delta.stop_reason ?? this.#round.stop;
        // A provider cutoff invalidates even a complete-looking ending (#176,
        // Codex round 1; #148; #154 Codex round 1). Record it here and let
        // the ladder apply failure precedence, so nothing the turn produced
        // can race or override the truncation guard.
        if (
          this.#round.stop !== null &&
          TRUNCATION_STOP_REASONS.includes(this.#round.stop)
        ) {
          this.#truncated ??= this.#round.stop;
        }
        return;
      }
      case "message_stop": {
        // WHAT THE MODEL SAID THIS ROUND, if anybody is listening (#177 hotfix
        // 1). The prose is here and nowhere else in this runtime: the record is
        // numbers and the chain entry is content-free by construction.
        this.#trace?.({
          kind: "message",
          iteration: this.#iterations,
          at: new Date(),
          stopReason: this.#round.stop,
          text: this.#round.text.join(""),
          tokens: { input: this.#round.input, output: this.#round.output },
        });
        return;
      }
      default:
        return;
    }
  }

  /** When the turn began, as its record will say. */
  get startedAt(): Date {
    return this.#startedAt;
  }

  /**
   * The session granted this turn (ticket #358). A line: handed to an idle
   * session, or the turn ahead of it ended — before its model call, so every
   * stamp the turn writes comes after this one. A `later` wake (an event):
   * its first frame, since the child runs a line that arrives beside it
   * first. Once: a later grant or frame of the same turn moves nothing.
   */
  began(at: Date): void {
    if (this.#began) return;
    this.#began = true;
    this.#startedAt = at;
  }

  /**
   * What the child's result says about the turn's typed result (ticket
   * #357): the structured output it ended on, or that it gave up on one —
   * the CLI retried a mismatched output until its own limit.
   */
  onResult(result: SDKResultMessage | undefined): void {
    if (result === undefined) return;
    this.#capped = result.subtype === "error_max_turns";
    if (this.definition.outputFormat === undefined) return;
    if (result.subtype === "error_max_structured_output_retries") {
      this.#structuredGaveUp = result.errors.join("; ");
      return;
    }
    if (result.subtype === "success" && !result.is_error && result.structured_output !== undefined) {
      this.#structured = { given: result.structured_output };
    }
  }

  /**
   * The text of the round the model stopped on: its words, `""` when it said
   * nothing there — and `""` when a tool ended the turn (ticket #401), since
   * whatever the model wrote before a tool call is its working, never its line.
   */
  get words(): string {
    return this.#endedOn === undefined ? this.#round.text.join("") : "";
  }

  /**
   * THE `Stop` HOOK (ticket #363): a turn whose words its definition's rule
   * refuses may not end on them. The model is handed the reason and writes
   * again inside the budget it has; words the rule accepts — or no rule at
   * all — let the turn end.
   */
  readonly stop: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    const refused = this.definition.wordsRule?.(this.words);
    if (refused === undefined) return {};
    this.#traceCall({ tool: "the turn's words", input: undefined, outcome: "rejected", reason: refused });
    return { decision: "block", reason: `refused: ${refused}` };
  };

  /**
   * THE `PostToolUse` HOOK THAT ENDS A TURN ON ITS TOOL (ticket #401): once a
   * call of a tool declared `endsTurn` went through, the hook answers
   * `continue: false` and the child stops right after the tool — no further
   * model call, so the SDK's own prompt for a turn that ended with no words
   * never fires. Measured on 0.3.288 against the scripted model
   * (`session.test.ts`): the result is `success` with the terminal reason
   * `hook_stopped`. A refused call raises no stop, and the model answers the
   * refusal.
   */
  readonly endTurn: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || input.tool_name !== this.#endedOn) return {};
    return { continue: false, stopReason: `${input.tool_name} ended the turn` };
  };

  /**
   * THE STRUCTURED OUTPUT'S OWN RULE, WHILE THE TURN CAN STILL ANSWER IT
   * (ticket #363): a `PreToolUse` hook on the CLI's structured-output tool
   * that reads the call through the definition's `parse` and denies one it
   * refuses, so the model is handed the reason as that call's error and
   * answers again inside the budget it has. The CLI holds the call to the
   * schema; this holds it to the
   * owning app's rule over what the schema admitted. What the turn ends on
   * is read through `parse` once more (`#ended`), so a turn that stops on a
   * refused answer still settles `schema-miss`.
   */
  readonly structuredCheck: HookCallback = async (input) => {
    const outputFormat = this.definition.outputFormat;
    if (
      outputFormat === undefined ||
      input.hook_event_name !== "PreToolUse" ||
      input.tool_name !== STRUCTURED_OUTPUT_TOOL
    ) {
      return {};
    }
    const parsed = outputFormat.parse(input.tool_input);
    if (parsed.ok) return {};
    this.#traceCall({ tool: STRUCTURED_OUTPUT_TOOL, input: input.tool_input, outcome: "rejected", reason: parsed.reason });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `refused: ${parsed.reason}`,
      },
    };
  };

  /**
   * AN SDK TOOL'S CALL THE WORKSPACE HOOK DENIED (ticket #326;
   * `confineToWorkspace`): traced as the rejection the model was handed.
   */
  sdkToolDenied(tool: string, input: unknown, reason: string): void {
    this.#traceCall({ tool, input, outcome: "rejected", reason });
  }

  /**
   * THE `PostToolUse` HOOK OVER THE SDK'S OWN TOOLS (ticket #326; ADR-0014 as
   * amended: «a `PostToolUse` hook records each performed effect»). The CLI
   * runs them, so this is the one place the turn learns a call ran: a `Write`
   * or an `Edit` is an effect the turn performed — its act `wrote`, its path
   * relative to the workspace — and a read or a search is traced as returned.
   * A call the CLI could not carry out raises no `PostToolUse`, so it leaves
   * no effect.
   */
  sdkToolUsed(workspace: string): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== "PostToolUse") return {};
      if (!(this.definition.sdkTools ?? []).some((tool) => tool === input.tool_name)) return {};
      const given = (input.tool_input ?? {}) as Record<string, unknown>;
      if (writesTheWorkspace(input.tool_name)) {
        const path = typeof given["file_path"] === "string" ? workspacePath(workspace, given["file_path"]) : "";
        const told = `${input.tool_name}: ${path}`;
        this.#effects.push({ performed: true, act: WROTE_ACT, told });
        this.#traceCall({ tool: input.tool_name, input: input.tool_input, outcome: "performed", result: told });
      } else {
        this.#traceCall({ tool: input.tool_name, input: input.tool_input, outcome: "returned", result: JSON.stringify(input.tool_response ?? null) });
      }
      return {};
    };
  }

  /**
   * Whether there is an outcome at all, from what the turn left behind and
   * what the child's result says about the wire — or `undefined`, meaning
   * the turn has its outcome: a structured output to read, or its ending when
   * the model stopped.
   *
   * SYNCHRONOUS ON PURPOSE: a session must know a turn failed before its
   * child can start the next one (`session.ts`), so nothing here awaits.
   */
  failure(wireFailure: unknown): Settled<S> | undefined {
    return failureOf(this.definition, {
      wireFailure,
      toolFailure: this.#toolFailure,
      truncated: this.#truncated,
      waitsOn: this.#waitsOn,
      structuredReported: this.#structured !== undefined || this.#structuredGaveUp !== undefined,
      capped: this.#capped,
      wordsRefused: this.definition.wordsRule?.(this.words),
    });
  }

  /** The disposition of a turn with an outcome — `failure` came back empty. */
  assign(): Settled<S> {
    // A TURN AN EFFECT LEFT WAITING SETTLES `asked` (ticket #324): the ladder
    // only comes back empty for one when its definition `suspends`, and its
    // typed result is the resumed turn's.
    if (this.#waitsOn !== undefined && this.definition.suspends === true) {
      return { failed: false, disposition: "asked", submission: undefined as S };
    }
    return this.#ended();
  }

  /**
   * A TURN THAT ENDED WHEN THE MODEL STOPPED (ticket #357): its structured
   * output read, when it declares one — `schema-miss` when the child gave up
   * on it or the definition's own rule refuses it — and its disposition read
   * by the definition off what happened.
   */
  #ended(): Settled<S> {
    const outputFormat = this.definition.outputFormat;
    let output: S | undefined;
    if (outputFormat !== undefined) {
      const miss = (reason: string): Settled<S> => {
        this.#traceCall({ tool: STRUCTURED_OUTPUT_TOOL, input: this.#structured?.given, outcome: "rejected", reason });
        return { failed: false, disposition: "schema-miss", submission: undefined as S };
      };
      if (this.#structuredGaveUp !== undefined) return miss(this.#structuredGaveUp);
      const parsed = outputFormat.parse(this.#structured?.given);
      if (!parsed.ok) return miss(parsed.reason);
      this.#traceCall({ tool: STRUCTURED_OUTPUT_TOOL, input: this.#structured?.given, outcome: "recorded" });
      output = parsed.submission;
    }
    const ending: TurnEnding = {
      words: this.words,
      effects: [...this.#effects],
      refused: [...this.#projectionRefusals],
    };
    let assigned: string;
    try {
      assigned = this.definition.dispositionOf(output as S, undefined, ending);
    } catch (error) {
      return failed(`the definition could not read what its turn did: ${String(error)}`);
    }
    if (!isDisposition(assigned) || assigned === "failed") {
      return failed(
        `the definition assigned "${assigned}", which is not a disposition a turn's own reading may give: failed is this runtime's own`,
      );
    }
    return { failed: false, disposition: assigned, submission: output as S };
  }

  /**
   * The record, the trace's last event and the one audit entry — and then the
   * outcome, or the `ExecutionError` that carries the record.
   *
   * EXACTLY ONE AUDIT ENTRY, on every path that gets this far: the chain is
   * appended once before the outcome is returned or thrown, so a failed
   * execution is as visible in the chain as an answered one.
   *
   * THE APPEND COMES FIRST, AND FAIL-CLOSED. If the injected chain throws,
   * its error propagates and the caller never receives the record — so
   * nothing is persisted either. That is the correct trade rather than an
   * oversight: an execution whose entry could not be written must not leave a
   * record behind, because a record with no entry is exactly the hole
   * ADR-0020's coverage check exists to find. The owning app closes the
   * remaining gap by appending and persisting in ONE transaction, the rule
   * `chainApertureAct` already states for the aperture — "the crossing and
   * its audit link commit together or not at all".
   */
  async close(args: {
    readonly trigger: Trigger;
    readonly chain: ExecutionAuditChain;
    readonly settled: Settled<S>;
    readonly endedAt: Date;
    readonly cause?: unknown;
  }): Promise<ExecutionOutcome<S>> {
    const settled = args.settled;
    const definition = this.definition;
    const disposition: Disposition = settled.disposition;
    // HOW IT ENDED, as the last event (#177 hotfix 1) — with the sentence, when
    // there is one. A trace that stopped at the last round would leave a reader
    // to infer the ending from the rounds, which is the inference this whole
    // file exists to remove.
    this.#trace?.({
      kind: "settled",
      iteration: this.#iterations,
      at: args.endedAt,
      disposition,
      ...(settled.failed ? { failure: settled.failure } : {}),
    });
    const record: ExecutionRecord = {
      trigger: args.trigger,
      instructionsDigest: definition.digest,
      toolNames: [...definition.tools.map((tool) => tool.name), ...(definition.sdkTools ?? [])],
      startedAt: this.#startedAt,
      endedAt: args.endedAt,
      iterations: this.#iterations,
      tokens: { input: this.#input, output: this.#output },
      disposition,
      lane: definition.lane,
    };
    await args.chain.append(
      executionAuditEntry(args.trigger, definition.digest, disposition),
    );
    if (settled.failed) {
      throw new ExecutionError(settled.failure, record, { cause: args.cause });
    }
    return {
      submission: settled.submission,
      words: this.words,
      record,
      effects: [...this.#effects],
    };
  }
}

/**
 * What the child's result says about the wire, read off its subtype.
 *
 * AN API ERROR IS A `success` RESULT WITH `is_error` SET, carrying the
 * error's text: that is how the CLI reports a refused or failed model call
 * after its own retries (measured on 2.1.288). `error_during_execution` and
 * the budget subtypes this runtime never sets are failures of the child.
 * `error_max_turns` is NOT a wire failure: the turn cap is this execution's
 * budget, and whether a run that reached it has an outcome is the ladder's
 * to say.
 */
export function wireFailureOf(
  result: SDKResultMessage | undefined,
): string | undefined {
  if (result === undefined) {
    return "the SDK child ended without a result";
  }
  if (result.subtype === "success") {
    return result.is_error ? result.result : undefined;
  }
  if (result.subtype === "error_max_turns") return undefined;
  // A STRUCTURED OUTPUT THE CHILD GAVE UP ON IS THE OUTPUT'S FAILURE, NOT THE
  // WIRE'S (ticket #357): every call arrived and was answered; what the model
  // sent never matched its schema, which `TurnBook.onResult` reads.
  if (result.subtype === "error_max_structured_output_retries") return undefined;
  return `${result.subtype}: ${result.errors.join("; ")}`;
}

/** Everything the loop left behind that the FAILURE ladder is decided from. */
interface LoopResult {
  /** The model call or the child itself failed — transport, a refused request, an exhausted wire. */
  readonly wireFailure: unknown;
  /** A tool handler threw; the model was told, and the loop carried on. */
  readonly toolFailure: string | undefined;
  /** The stop reason of the first response the provider marked truncated. */
  readonly truncated: string | undefined;
  /** The card an effect left the turn waiting on (ticket #324), if one did. */
  readonly waitsOn: string | undefined;
  /** Whether the child reported on a structured output at all: one it ended on, or one it gave up on. */
  readonly structuredReported: boolean;
  /** Whether the turn cap stopped the turn before the model stopped it. */
  readonly capped: boolean;
  /** Why the definition's rule refuses the words the turn ended on, when it does. */
  readonly wordsRefused: string | undefined;
}

/**
 * Keep failure, the typed result and disposition in one discriminated value,
 * so the execution cannot claim both failure and a usable result.
 */
export type Settled<S> =
  | {
      readonly failed: false;
      /** Every word but `failed`, which is the other arm's. */
      readonly disposition: Exclude<Disposition, "failed">;
      readonly submission: S;
    }
  | {
      readonly failed: true;
      readonly disposition: "failed";
      readonly failure: string;
    };

/** A failed ending, with the sentence that says why. */
export function failed<S>(failure: string): Settled<S> {
  return { failed: true, disposition: "failed", failure };
}

/**
 * The failure ladder: whether this run has an outcome at all, in the order
 * the failures shadow each other — or `undefined`, meaning it has one.
 *
 * A TOOL FAILURE OUTRANKS EVERYTHING THE TURN PRODUCED, and that is the point
 * of tracking it: the model is handed the failure as a tool result and can
 * compose a perfectly well-formed answer on top of it, so an execution whose
 * read failed must not be able to report itself `answered`.
 */
function failureOf<S, Handled>(
  definition: ExecutionDefinition<S, Handled>,
  loop: LoopResult,
): Settled<S> | undefined {
  if (loop.wireFailure !== undefined) {
    return failed(`the model call failed: ${String(loop.wireFailure)}`);
  }
  if (loop.toolFailure !== undefined) return failed(loop.toolFailure);
  if (loop.truncated !== undefined) {
    // IT OUTRANKS WHATEVER THE TURN PRODUCED, which is the whole of the guard:
    // an execution whose response the provider marked truncated must not be
    // able to report itself answered, drafted or classified, however
    // well-formed what it carried looked. The message NAMES the
    // budget rather than blaming the model, because the misreading #148 came
    // from — a budget failure diagnosed as a model failure — is the one it
    // exists to prevent.
    return failed(
      `the model ran out of room before it finished (stop_reason: ${loop.truncated}, against a ${definition.budget.maxTokens}-token ceiling): a truncated response is not an answer, whatever it carries`,
    );
  }
  if (loop.waitsOn !== undefined) {
    // A TURN THAT ASKED THE REP HAS ITS OUTCOME IN THE ANSWER (ticket #324):
    // what it ends on is settled when the answer resumes it — so the checks
    // below do not apply, and only a definition that can stand waiting may be
    // left so.
    return definition.suspends === true
      ? undefined
      : failed("an effect left this execution waiting on an answer, and its definition cannot wait");
  }
  const budget = `within a budget of ${definition.budget.maxIterations} iterations`;
  // A TURN THAT ENDS WHEN THE MODEL STOPS HAS ITS OUTCOME IN HOW IT STOPPED
  // (ticket #357): its words, its effects, its structured output. The turn
  // cap stopping it first leaves it with none (Codex r1: the model was still
  // going, so whatever it had done so far is not its ending), as does a
  // typed result the child never reported at all.
  if (loop.capped) return failed(`the turn cap stopped the execution before the model did, ${budget}`);
  // WORDS THE RULE STILL REFUSES ARE NO ENDING (ticket #363): the `Stop`
  // hook handed the model the reason, and it ended on them anyway.
  if (loop.wordsRefused !== undefined) return failed(`the turn ended on words its rule refuses: ${loop.wordsRefused}`);
  return definition.outputFormat !== undefined && !loop.structuredReported
    ? failed(`the execution ended without its structured output, ${budget}`)
    : undefined;
}


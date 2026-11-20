/**
 * The runner: one function that takes a trigger, a definition and an
 * injected harness, runs one Claude Agent SDK `query()` inside the caller's
 * own process (ADR-0014 as amended 2026-09-27; spec #318 decision 7), and
 * returns how it ended: its structured output when it declares one, and its
 * words (ticket #357).
 *
 * The single-message call: the owner question and every step that is not a
 * session's turn run through this boundary (spec #318 decision 8). The
 * thread and a run's steps run the other shape, a streaming-input session
 * (`session.ts`); what makes a turn of either an execution is one wrapper
 * (`turn.ts`). The SDK's own permission model is off and its own tools are
 * absent; what the model can call is this execution's tools, served as one
 * in-process MCP server whose handlers carry every gate unchanged — plus the
 * CLI's own `StructuredOutput` when the definition declares an
 * `outputFormat`.
 *
 * WHAT IT DOES NOT DO, because ADR-0012's machine is not this package:
 * nothing is durable, nothing checkpoints, nothing is enqueued, no session is
 * persisted, and there are no step boundaries. An execution here is
 * single-shot, start to finish, inside the caller's own await.
 */
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionAuditChain } from "./audit.js";
import {
  instructionsText,
  renderParts,
  type ExecutionDefinition,
} from "./definition.js";
import { placeChild, type Harness } from "./harness.js";
import { confineToWorkspace } from "./sdk-tools.js";
import type { Trace } from "./trace.js";
import type { Trigger } from "./trigger.js";
import {
  assertRunnable,
  denyOffList,
  DISALLOWED_SDK_TOOLS,
  SERVER,
  sdkOutputFormat,
  toolServer,
  TurnBook,
  wireFailureOf,
  type ExecutionOutcome,
  type Settled,
  type WordsPiece,
} from "./turn.js";

export {
  ExecutionError,
  STRUCTURED_OUTPUT_TOOL,
  type ExecutionOutcome,
  type WordsPiece,
} from "./turn.js";

/**
 * Runs one execution to its end.
 *
 * The budget rides on the definition and is handed to the SDK whole:
 * `maxIterations` is the turn cap, `maxTokens` caps each call's output, and
 * `model` is the ADR-0015 rung the caller chose. An execution that reaches
 * the turn cap without the structured output it ends on is one the budget
 * could not finish, and it lands `failed`.
 *
 * PARTIAL MESSAGES ARE ALWAYS ON, because the stream is the only place a
 * call's stop reason and usage appear (`TurnBook.onStreamEvent`).
 *
 * EXACTLY ONE AUDIT ENTRY, appended fail-closed before the outcome is
 * returned or thrown (`TurnBook.close` argues the order).
 */
export async function runExecution<S, Handled = void>(options: {
  /** Where the SDK child lives and what it presents (`harness.ts`). */
  readonly harness: Harness;
  readonly trigger: Trigger;
  readonly definition: ExecutionDefinition<S, Handled>;
  readonly chain: ExecutionAuditChain;
  /**
   * Where this run's per-call trace goes, if anywhere (#177 hotfix 1).
   *
   * OPTIONAL, AND THE CALLER'S ENTIRELY. An absent callback is a run that
   * traces nothing, and a present one decides what its events are for —
   * `trace.ts` argues why, and why this is never the audit chain.
   */
  readonly trace?: Trace;
  /**
   * WHERE THE MODEL'S TEXT GOES AS IT IS WRITTEN, if anywhere (ticket #357):
   * every text piece of every round, in order, tagged with its round — the
   * words of a turn that ends when the model stops (`WordsPiece`).
   */
  readonly onWords?: (piece: WordsPiece) => void;
}): Promise<ExecutionOutcome<S>> {
  const { harness, trigger, definition, chain, trace, onWords } = options;
  const { budget } = definition;
  assertRunnable(trigger, definition);
  const book = new TurnBook(definition, {
    ...(trace === undefined ? {} : { trace }),
    ...(onWords === undefined ? {} : { onWords }),
  });

  let wireFailure: unknown;
  let result: SDKResultMessage | undefined;
  try {
    const child = placeChild(harness, budget);
    const run = query({
      prompt: renderParts(definition.context),
      options: {
        model: budget.model,
        // OURS REPLACES THE SDK'S. The CLI still sends its own identity line
        // and per-turn reminders beside it (environment, model, a date); no
        // option of this SDK removes those.
        systemPrompt: instructionsText(definition),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // THE BASE SET IS THE SDK TOOLS THE DEFINITION NAMES AND NOTHING
        // ELSE: `allowedTools` does not narrow what the model sees, only this
        // does (spike #290 fact 1; ticket #326).
        tools: [...(definition.sdkTools ?? [])],
        mcpServers: {
          [SERVER]: {
            type: "sdk",
            name: SERVER,
            instance: toolServer(book.tools, (name, input) => book.call(name, input)),
          },
        },
        allowedTools: [...book.onTheList],
        disallowedTools: DISALLOWED_SDK_TOOLS,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                denyOffList(book.onTheList),
                confineToWorkspace(child.cwd, (tool, input, reason) => book.sdkToolDenied(tool, input, reason)),
                ...(definition.outputFormat === undefined ? [] : [book.structuredCheck]),
              ],
            },
          ],
          PostToolUse: [{ hooks: [book.sdkToolUsed(child.cwd), book.endTurn] }],
          ...(definition.wordsRule === undefined ? {} : { Stop: [{ hooks: [book.stop] }] }),
        },
        ...sdkOutputFormat(definition.outputFormat?.schema),
        includePartialMessages: true,
        maxTurns: budget.maxIterations,
        ...(budget.effort === undefined ? {} : { effort: budget.effort }),
        persistSession: false,
        settingSources: [],
        strictMcpConfig: true,
        cwd: child.cwd,
        env: { ...child.env },
        ...(harness.executable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: harness.executable }),
      },
    });
    for await (const message of run) {
      if (message.type === "stream_event") {
        // A SUBAGENT'S STREAM IS NOT A ROUND OF THIS EXECUTION. None of these
        // executions can start one; the guard keeps the count honest if one
        // ever does.
        if (message.parent_tool_use_id === null) book.onStreamEvent(message.event);
      } else if (message.type === "result") {
        result = message;
      }
    }
  } catch (error) {
    // The child itself failed — it could not start, it died, or it reported
    // an error result and the SDK raised it. An error result already read is
    // what is reported below; anything else is the wire failure itself.
    if (result === undefined) wireFailure = error;
  }
  wireFailure ??= wireFailureOf(result);
  book.onResult(result);

  const endedAt = new Date();
  const settled: Settled<S> = book.failure(wireFailure) ?? book.assign();
  return await book.close({
    trigger,
    chain,
    settled,
    endedAt,
    cause: wireFailure,
  });
}

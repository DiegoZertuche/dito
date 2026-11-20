/**
 * WHAT ONE EXECUTION DID, ROUND BY ROUND (#177 hotfix 1; the slice-5a
 * boundary, 2026-09-05).
 *
 * THE HOLE THIS FILLS, in the words the boundary session had to write: "the
 * most likely sequence, unprovable today because nothing records what each
 * iteration did". Two live executions failed with «the execution ended without
 * calling» their submission, and the record carried the iteration count, the token
 * totals and the disposition — every number about the run and not one fact
 * about what happened inside it. Reconstructing the turn took reading the
 * tool's own source and guessing. A per-call trace is the difference between
 * "the model probably drafted and then talked" and knowing it did.
 *
 * THE PACKAGE WRITES NOWHERE AND READS NO ENVIRONMENT. `runExecution` takes an
 * optional callback and calls it; where the events go, whether they go
 * anywhere, and how much of each one is printed are all the CALLER's
 * decisions. That is the same rule the audit chain follows here (ADR-0020's
 * custody note, this package's item 9): a credential-free library that chose a
 * destination would be a library that had to hold one.
 *
 * IT IS NOT THE AUDIT CHAIN AND MUST NEVER BE READ AS ONE. The chain is one
 * content-free entry per execution, hash-linked and durable (ADR-0020); this
 * is a debug view that carries the rep's own content, is handed to whatever
 * callback the composition root passed, and is durable nowhere. Nothing may
 * ever be verified against it — `trace-render.ts` on the rep side is where the
 * content-free default lives, and the rig's own `--trace=full` is the opt-in
 * that prints the rest to one terminal.
 */
import type { Disposition, TokenCount } from "./record.js";

/**
 * How one tool call ANSWERED.
 *
 * FIVE WORDS FOR THE FIVE ANSWERS A CALL CAN CARRY BACK, and they are the
 * runner's own vocabulary rather than new ones: a read `returned` its rows; an
 * effect `performed` or was `refused` by the tool itself (`EffectOutcome`'s two
 * arms); a call the runtime would not pass on — an undeclared parameter, a
 * missing selector, a structured output the definition's own rule refuses —
 * was `rejected`; and an accepted structured output is `recorded`.
 *
 * A HANDLER THAT THREW IS `refused`, WITH THE FAILURE AS ITS REASON, and that
 * is a judgement worth stating rather than a sixth word. From the loop's side a
 * throw and a refusal are the same fact — the thing did not happen — and the
 * reason carried here is the runner's own sentence, «the tool X failed: …», so
 * the full view says which it was. The alternative, going silent on the one
 * call a reader is most likely debugging, is worse than a shared word.
 */
export type ToolCallOutcome =
  | "returned"
  | "performed"
  | "refused"
  | "rejected"
  | "recorded";

/**
 * One tool call, as the runner saw it.
 *
 * `reason` OR `result`, NEVER BOTH: a call that did something has a result to
 * show and a call that did not has a reason it did not. Both are the tool's own
 * words — an `EffectOutcome`'s `told`, a read's rows, the contract's refusal —
 * so nothing here is the runtime's paraphrase of what a tool meant.
 */
export interface ToolCall {
  readonly tool: string;
  readonly input: unknown;
  readonly outcome: ToolCallOutcome;
  readonly reason?: string;
  readonly result?: string;
}

/**
 * WHERE AND WHEN, which every event carries.
 *
 * Because the two questions a failed run raises are "in which round" and "how
 * long did that take" — and a trace whose events had to be counted to be
 * placed would answer neither after a round that called two tools.
 */
interface Placed {
  readonly iteration: number;
  readonly at: Date;
}

/** One thing that happened inside an execution. */
export type TraceEvent =
  | (Placed & {
      readonly kind: "message";
      readonly stopReason: string | null;
      /** The model's full prose for this round — every text block, joined. */
      readonly text: string;
      readonly tokens: TokenCount;
    })
  | (Placed & { readonly kind: "tool_call" } & ToolCall)
  | (Placed & {
      readonly kind: "settled";
      readonly disposition: Disposition;
      readonly failure?: string;
    });

/** Where a caller's trace events go. Called synchronously, never awaited. */
export type Trace = (event: TraceEvent) => void;

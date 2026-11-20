/**
 * THE REP SIDE'S TRACE SURFACE: WHERE EVENTS GO, AND THE TWO VIEWS OF THEM
 * (#177 hotfix 1; the slice-5a boundary, 2026-09-05).
 *
 * `@dito/execution` records what each round did and writes it nowhere
 * (`trace.ts`); this is where the rep side decides what a line looks like. Two
 * renderers, one default, and the difference between them is the rep's own
 * content.
 *
 * SHAPE IS THE DEFAULT, AND IT IS CONTENT-FREE ON PURPOSE. What a boundary
 * session needed and did not have was the SEQUENCE — «drafted, then talked,
 * then never submitted» — which is a claim about tool names and outcomes and
 * about nothing anybody said. A default that printed the rep's messages, their
 * customers' names and the drafts written for them into a terminal, a scroll
 * buffer and whatever captured that terminal would be a new copy of the twin's
 * memory in the worst place for one (ADR-0007: the twin's memory is a per-twin
 * encrypted bundle, and this is neither).
 *
 * FULL IS AN OPT-IN AND ONLY EVER THE RIG'S. It prints what the model wrote,
 * what a tool was sent and what it answered, which is the whole point of it and
 * also why it is never a default and never a steering surface: it is one
 * operator debugging one turn on their own laptop.
 *
 * PURE FUNCTIONS OVER ONE EVENT, so both can be shown, line by line, to print
 * what they claim and to leave out what they claim — the property
 * `trace-render.test.ts` plants a distinctive string to prove.
 */
import type { Trace, TraceEvent, Trigger } from "@dito/execution";

/**
 * WHERE THIS RUNTIME'S PER-CALL TRACE GOES, if anywhere.
 *
 * THE TRIGGER RIDES WITH THE EVENT because one callback serves every execution
 * a pass runs, and the realtime lane runs two at once (`lanes.ts`): lines from
 * a rep's thread turn and from a customer's settled turn would otherwise
 * interleave into one unreadable column. `triggerRef` off the trigger is what
 * tells them apart, and printing it is the caller's job — this runtime writes
 * nowhere.
 */
export type RuntimeTrace = (trigger: Trigger, event: TraceEvent) => void;

/**
 * One execution's runner option, or no option at all.
 *
 * SPREAD RATHER THAN PASSED AS `undefined`: `exactOptionalPropertyTypes` is on,
 * so an absent trace is an absent key rather than a key holding nothing. The
 * trigger is bound HERE, at the one place a call site holds both — which is
 * also why the entity-kind path takes this helper rather than restating the
 * trigger it deliberately builds from its own automation's wake.
 */
export function traceFor(
  trace: RuntimeTrace | undefined,
  trigger: Trigger,
): { readonly trace?: Trace } {
  return trace === undefined
    ? {}
    : { trace: (event: TraceEvent) => trace(trigger, event) };
}

/**
 * The shape of a run: which round, which tool, what it answered.
 *
 * NO INPUT, NO RESULT, NO REASON, NO PROSE — and the ENDING carries only its
 * disposition, never the failure sentence. That last one is not squeamishness:
 * a failure sentence can be a contract's or the guard's own refusal, and
 * those quote what the model wrote — «your line types the name "…"» is the
 * rep's customer's name inside a runner error string.
 */
export function renderShape(event: TraceEvent): string | undefined {
  switch (event.kind) {
    case "message":
      return `#${String(event.iteration)} message ${event.stopReason ?? "(none)"}`;
    case "tool_call":
      return `#${String(event.iteration)} ${event.tool} ${event.outcome}`;
    case "settled":
      return `settled ${event.disposition}`;
    default:
      // An event kind this build does not know prints nothing rather than
      // guessing at it.
      return undefined;
  }
}

/**
 * The whole of a run, the rep's content included — the rig's `--trace=full`
 * and nothing else.
 */
export function renderFull(event: TraceEvent): string | undefined {
  switch (event.kind) {
    case "message": {
      const spent = `${String(event.tokens.input)} in / ${String(event.tokens.output)} out`;
      const head = `#${String(event.iteration)} message ${event.stopReason ?? "(none)"} (${spent})`;
      return event.text === "" ? head : `${head}\n  ${event.text}`;
    }
    case "tool_call": {
      const head = `#${String(event.iteration)} ${event.tool} ${event.outcome} ${JSON.stringify(event.input)}`;
      const said = event.result ?? event.reason;
      return said === undefined ? head : `${head}\n  ${said}`;
    }
    case "settled":
      return event.failure === undefined
        ? `settled ${event.disposition}`
        : `settled ${event.disposition}\n  ${event.failure}`;
    default:
      return undefined;
  }
}

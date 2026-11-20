/**
 * WHAT A DEFINITION'S WAKE, LANE, RECIPES AND BUDGET ARE (ticket #178; spec
 * #171 decisions 1 and 9; ADR-0012, ADR-0014 as amended 2026-10-07).
 *
 * The words an `ExecutionDefinition` is written in, beside it: which lane it
 * runs in, what wakes it, the shape of the context recipes it asks for, and
 * what it declares about its spend. A schedule is not among the wakes: what
 * the clock fires is a row in `schedules` that starts a run, and a run's
 * steps execute on the run-step occasion (ADR-0014 as amended 2026-10-07).
 */
import type { Occasion } from "./trigger.js";

/** Which of the runtime's two lanes an automation runs in (spec #171 decision 3). */
export const LANES = ["realtime", "batch"] as const;
/**
 * `realtime` is drafting (#172), the twin thread, the entity kind and the
 * owner question — anything a person is waiting on. `batch` is the steps of
 * runs — the day's extraction and its post among them — off the latency path
 * (ADR-0016), capped at one at a time. The rep runtime implements the lanes in `twin-runtime/src/lanes.ts`
 * (#173); this declaration carries the automation's choice so callers do
 * not independently choose its lane.
 */
export type Lane = (typeof LANES)[number];

/**
 * Whether a word is a lane this build runs.
 *
 * A GUARD BECAUSE SOMETHING READS ONE BACK. `assertDefinition` checks a lane
 * that arrived past the type — a spread definition, a cast, a value out of
 * JSON — for the reason it checks the budget's numbers: a lane the runtime
 * does not know would run the execution, reach the store and be refused by a
 * CHECK constraint after the model had already been paid for.
 */
export function isLane(word: string): word is Lane {
  return (LANES as readonly string[]).includes(word);
}

/** How a wake came to be: an event, a clock, or code asking (spec #171 decision 10). */
export const TRIGGER_MECHANISMS = ["seam_event", "request", "schedule"] as const;
export type TriggerMechanism = (typeof TRIGGER_MECHANISMS)[number];

/**
 * WHICH SEAM EVENTS WAKE IT — metadata only, no function, no content
 * (ADR-0012: "Wake predicates use a metadata-only vocabulary … predicate
 * rows carry no names or text"): the sources and the versioned event types
 * are the plaintext half of ADR-0012's envelope, so nothing here can be
 * evaluated against an event's content. A content-conditioned wake is two
 * stages — metadata wake, then the execution itself.
 *
 * SOURCES, PLURAL (ticket #261; spec #258 *Habla con Dito, the mechanism*):
 * one occasion can arrive through more than one integration — a rep message
 * reaches the twin thread from the WhatsApp rail and from the dashboard's own
 * door — and it is the same occasion.
 */
export interface SeamEventPredicate {
  /**
   * The integrations whose events wake it, e.g. `whatsapp`, `dashboard`;
   * empty is refused, because a predicate naming no source matches nothing.
   */
  readonly sources: readonly string[];
  /** The versioned event types that wake it; empty is refused. */
  readonly eventTypes: readonly string[];
}

/** An event fires it (spec #171 decision 1). */
export type TriggerWake =
  | {
      readonly kind: "trigger";
      readonly mechanism: "seam_event";
      readonly occasion: Occasion;
      readonly predicate: SeamEventPredicate;
    }
  | {
      readonly kind: "trigger";
      readonly mechanism: "request";
      readonly occasion: Occasion;
    };

/** What wakes a definition: an event or a request (ADR-0014 as amended). */
export type Wake = TriggerWake;

/**
 * Whether a wake may be fired through a given mechanism — what the runner
 * holds a trigger to: the one its wake declares, so a record never says an
 * event woke a definition only a request can, or the other way round.
 */
export function wakeAccepts(wake: Wake, mechanism: TriggerMechanism): boolean {
  return mechanism === wake.mechanism;
}

/**
 * The shape of one occasion-bound parameter, as a definition declares it.
 *
 * THREE WORDS: an instant, a zone, a number of hours. A fourth arrives with
 * the recipe that needs it.
 */
export const PARAMETER_TYPES = ["instant", "zone", "hours"] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/** A recipe's parameters, by name, as shapes rather than values. */
export type ParameterShape = Readonly<Record<string, ParameterType>>;

/**
 * One context part a definition asks for: the recipe's name, and the shape of
 * what the occasion binds into it. The digest covers the shape
 * (`definition.ts`), so a definition whose recipe's parameters changed is a
 * different definition.
 */
export interface ContextRecipeCall {
  readonly recipe: string;
  readonly parameters: ParameterShape;
}

/** The three effort levels the API's `output_config.effort` accepts. */
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Whether a word is an effort level the API accepts.
 *
 * A GUARD BECAUSE `assertDefinition` READS ONE BACK (Codex r2). The direct
 * `defineExecution` path takes a `Budget` past the type — a cast, a value
 * out of a boundary setting — and an effort the API does not know is a 400
 * from the provider in the middle of a live execution rather than a refusal
 * at construction. Checked where the lane is checked, and for the same
 * reason.
 */
export function isEffort(word: string): word is Effort {
  return (EFFORTS as readonly string[]).includes(word);
}

/**
 * What a definition declares about its spend.
 *
 * NO MODEL: ADR-0015 routes per rung at the app boundary and `Budget.model`
 * has no default anywhere in this repo, so the rung is bound where the
 * definition is built. `maxTokens` OMITTED MEANS THE RUNTIME'S 16,000 (spec
 * #171 decision 8(2)), resolved by `resolveBudget`.
 */
export interface BudgetSpec {
  readonly maxIterations: number;
  readonly maxTokens?: number;
  readonly effort?: Effort;
}

/**
 * A parameter shape, BY NAME, sorted: a shape is a map, so `{at, timeZone}`
 * and `{timeZone, at}` are one value, and `instructionsDigest` stamps one form
 * of it.
 */
export function canonicalParameters(shape: ParameterShape): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shape).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

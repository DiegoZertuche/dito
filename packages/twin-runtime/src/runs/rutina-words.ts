/**
 * WHAT A RUTINA'S PROPOSAL CARD SAYS BESIDE THE TWIN'S SENTENCE (ticket #386;
 * ADR-0044's `proposal` part; ADR-0037 as amended: chrome is the copy
 * package's, never the twin's).
 *
 * When it runs — «Cada viernes a las 09:00», «Cuando te escribe Sergio Ramos»
 * — and its plan, one line per step: the step's word, a wait's span or the
 * card it waits on. Rendered by code from the row's typed wake and the
 * definition's steps, in the copy package's words, once, when the post is
 * written: both doors read the same words off the part, the phone in the
 * thread's grammar and the dashboard as a card. When it runs is the copy
 * package's own rendering (`whenRutinaRuns`), the one Rutinas says too
 * (ticket #387).
 */
import { CHROME, whenRutinaRuns as whenWords, type ChromeKey } from "@dito/copy";
import type { TwinPlanStep, TwinRunStepKind } from "@dito/seam";
import type { PlanLine } from "../posts.js";
import { planOf } from "../routines.js";
import type { StepSpec } from "./definition.js";
import type { RutinaWake } from "./rutinas.js";

/** The word each kind of step is said in, the one Trabajos en curso says it in. */
const STEP_WORD: Readonly<Record<TwinRunStepKind, ChromeKey>> = {
  agent: "trabajos.stepAgent",
  code: "trabajos.stepCode",
  act: "trabajos.stepAct",
  post: "trabajos.stepPost",
  wait: "trabajos.stepWait",
  if: "trabajos.stepIf",
  ask: "trabajos.stepAsk",
  each: "trabajos.stepEach",
  while: "trabajos.stepWhile",
  end: "trabajos.stepEnd",
};

/** The heading the plan's lines sit under. */
export const PLAN_HEADING: string = CHROME["rutinas.plan"];

/** What a proposal says when accepting it ends a rutina the rep has. */
export const REPLACES_LINE: string = CHROME["rutinas.replaces"];

/**
 * When the rutina runs, in words: its cadence, or the event — a customer by
 * the name `customer` gives, when it is about one, in place of the bundle's
 * reference the row holds.
 */
export function whenRutinaRuns(wake: RutinaWake, customer: string | undefined): string {
  return whenWords(
    wake.kind === "trigger"
      ? { kind: "trigger", event: wake.event, ...(customer === undefined ? {} : { customer }) }
      : wake,
  );
}

/** The plan, one line per step, a branch's steps one level deeper after their `if`. */
export function planLines(steps: readonly StepSpec[]): readonly PlanLine[] {
  return planOf(steps, 0).map((step) => ({ text: planLine(step), depth: step.depth }));
}

function planLine(step: TwinPlanStep): string {
  const wait = step.wait;
  if (step.kind !== "wait" || wait === undefined) return CHROME[STEP_WORD[step.kind]];
  if ("settle" in wait) return CHROME["rutinas.waitCard"];
  const spans = [
    spanOf(wait.after.days, "rutinas.spanDay", "rutinas.spanDays"),
    spanOf(wait.after.hours, "rutinas.spanHour", "rutinas.spanHours"),
    spanOf(wait.after.minutes, "rutinas.spanMinute", "rutinas.spanMinutes"),
  ].filter((span) => span !== undefined);
  return `${CHROME["rutinas.waitFor"]}${spans.join(" ")}`;
}

function spanOf(count: number | undefined, one: ChromeKey, many: ChromeKey): string | undefined {
  if (count === undefined || count === 0) return undefined;
  return `${String(count)} ${CHROME[count === 1 ? one : many]}`;
}

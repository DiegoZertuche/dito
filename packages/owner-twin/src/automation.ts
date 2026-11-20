/**
 * WHAT WAKES THE OWNER TWIN, AND WHAT IT IS SHOWN FIRST (ticket #178; spec
 * #171 decision 29; ADR-0014 as amended 2026-09-04; ticket #363).
 *
 * The owner twin is one execution definition of the execution package's own
 * kind (`definition.ts`): it lives on the owner's side of the wall and never
 * imports the rep-side engine (ADR-0002), so it is built here from the
 * package's `defineExecution` rather than from a run's definition. These are
 * its fixed halves — the wake, the lane, the iteration count and the recipe
 * that renders its first context part. The model stays at the app boundary
 * (ADR-0015); the omitted output cap inherits the runtime's 16,000 rather
 * than restating it (user story 39).
 */
import { NOW_OWNER_RECIPE, type ContextRecipeCall, type Lane } from "@dito/execution";

/**
 * Enough iterations to resolve, read and answer, with room for a second
 * read; a runaway loop is a loud failure rather than a bill.
 */
export const OWNER_TWIN_MAX_ITERATIONS = 6;

/**
 * THE WAKE IS A `request` TRIGGER and can be nothing else: the owner web
 * calls the turn function from a server action, so there is no seam event
 * behind it and no clock.
 *
 * `as const` RATHER THAN AN ANNOTATION, so the wake's two words stay LITERAL
 * — `"owner_question"` and `"request"`. `turn.ts` builds this execution's
 * trigger from them, and an annotation would force a cast there to say
 * something the constant already knew.
 */
export const OWNER_TWIN_WAKE = {
  kind: "trigger",
  mechanism: "request",
  occasion: "owner_question",
} as const;

/** `realtime`, because a person is sitting in front of it — the only kind of thing the owner side has. */
export const OWNER_TWIN_LANE: Lane = "realtime";

/**
 * `now_owner` IS THE FIRST CONTEXT PART, before the conversation and before
 * the question (spec #171 decision 8(3)). First because it is framing rather
 * than material: the model reads what day it is, then what was asked. The
 * owner variant because the owner's questions are about WINDOWS — «entre el
 * 1 y el 3», «la semana pasada» — and the reads refuse a window anchored
 * inside the region that has not finalized, which without this line the
 * model can only discover by being refused.
 */
export const OWNER_TWIN_RECIPES: readonly ContextRecipeCall[] = [
  {
    recipe: NOW_OWNER_RECIPE,
    parameters: { at: "instant", timeZone: "zone", lagHours: "hours" },
  },
];

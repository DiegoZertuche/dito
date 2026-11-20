import type { Effort } from "@dito/execution";

/**
 * WHICH MODEL A CALL SITE RUNS ON (ADR-0015: config-driven per call site).
 *
 * WHAT IT CARRIES NOW THAT EVERY REP-SIDE HARNESS IS AN AUTOMATION (ticket
 * #194). A definition takes its instructions, its tools and its iteration
 * count from its spec, and the two things a spec may not hold arrive here:
 * the rung ADR-0015 routes at the app boundary, and — for extraction alone —
 * the `output_config.effort` arm a measurement selects (#148). Drafting, the
 * twin thread and the kind classification forward the model and nothing else.
 *
 * Each call site gets its own value, not a new type (#35; ADR-0015).
 *
 * IT LIVES OUTSIDE EVERY AUTOMATION so the composition roots that resolve a
 * rung — the rig scripts, the eval lanes — can share it without depending on
 * one execution's module. It does NOT retire with extraction's automation,
 * which #202 still expected: extraction is one now and this is where its rung
 * and its effort arm still arrive.
 */
export interface ModelCallConfig {
  readonly model: string;
  /**
   * How hard the model works before it answers — the API's
   * `output_config.effort` (ticket #148).
   *
   * Omitted means no output_config key and the model's own default, not
   * medium: filling one in would make #148's default-versus-low comparison
   * unmeasurable. Only extraction reads this field, and it folds the arm into
   * its spec's budget so the digest sees which one ran
   * (`extraction/definition.ts`). Every other caller forwards the model
   * alone; their specs own `Budget.effort`.
   */
  readonly effort?: ModelEffort;
}

/**
 * The shared runtime's effort vocabulary, re-exported for rep-side callers
 * and the package surface (#178). Alias Effort rather than restating the
 * union, so Budget and ModelCallConfig cannot acquire different levels.
 */
export type ModelEffort = Effort;

/**
 * WHEN THE DRAFT A THREAD TURN WROTE WAS READY (tickets #175, #321).
 *
 * A draft's timing row cannot be written inside the model loop:
 * `draft_timings.execution_id` references the execution's own record, which
 * does not exist until the run has ended (`drafts.ts`'s `recordDraftTiming`).
 * So `fill_blank` records the three instants here, as the consumer does when
 * it lands the draft `create_draft` held (ticket #368), and the consumer
 * writes the row after `recordExecution`, in the same transaction — NFR-2
 * measures a draft the rep asked for by the same arithmetic as one a
 * customer's turn produced.
 *
 * RUN-SCOPED AND MUTABLE, like the served map and the act slot beside it,
 * from one `ThreadDeps`. One draft per turn is the act slot's rule, so it
 * holds one timing.
 */
import type { DraftTiming } from "../drafts.js";

export class TurnDraftTiming {
  #timing: DraftTiming | undefined;

  /** Records the draft this turn wrote, and when it was ready. */
  record(timing: DraftTiming): void {
    this.#timing = timing;
  }

  /** The timing of the draft this turn wrote, or nothing when it wrote none. */
  get timing(): DraftTiming | undefined {
    return this.#timing;
  }
}

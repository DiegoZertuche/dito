/**
 * THE SHIPPED RUNS' REGISTRY WORDS (tickets #324, #326; spec #318 decision 27): the
 * code identifiers `start_workflow({ shipped })` picks a definition by and a
 * run row records as its automation. Apart from the definitions themselves
 * (`shipped.ts`) so the thread's declarations can name them without the
 * engine.
 */
export const SHIPPED_RUN_NAMES = [
  "stale_relationships",
  "standing_goal",
  "research_and_document",
  "overnight_requests",
] as const;

export type ShippedRunName = (typeof SHIPPED_RUN_NAMES)[number];

/**
 * WHAT WAKES THE KIND CLASSIFICATION, AND HOW MANY ROUNDS IT GETS (tickets
 * #176, #363; spec #171 decision 26; ADR-0014 as amended 2026-09-04).
 *
 * The classification is the shipped `entity_kind` definition — one `agent`
 * step whose typed output is the kind (`runs/shipped-conversations.ts`) — run
 * through the engine's no-row path (`classify.ts`). Model routing stays at
 * the app boundary: ADR-0015 as amended gives classification its own rung and
 * override, `DITO_ENTITY_KIND_MODEL`, never derived from extraction's (#148,
 * #154). Startup and live confirmation use `kindModelOf`; the operator
 * backfill uses `entityKindModelConfig`.
 */
import type { Wake } from "@dito/execution";

/**
 * How many rounds one classification gets.
 *
 * ONE, because there is almost nothing to be fed back: the answer is one
 * field holding one of two words, and #148 is the record of what an extra
 * INVITED round costs a model that reasons before it speaks — it answers the
 * invitation it was given. That defect is what took this rung's cap to one
 * in the first place (#154). And one round is what the fixtures say the shape
 * is: `entityKindTurns(kind, times)` scripts one turn per determination.
 *
 * WHAT ONE ROUND COSTS, recorded rather than discovered: a run that answers
 * a word the Ledger has no kind for is handed the refusal and has no round
 * left to answer again, so it lands `failed` with its record and its chain
 * entry. On the live path that means the rep's «va» replays on the next pass
 * and the classification is asked again from scratch.
 */
export const ENTITY_KIND_MAX_ITERATIONS = 1;

/**
 * THE WAKE IS A `request` TRIGGER and can be nothing else (spec #171
 * decision 26: "a request from code at binding confirmation and at the
 * startup backlog, as today"). No seam event and no clock is behind a
 * classification: the rep's «va» IS a seam event, but it is the BINDING's
 * occasion, matched and confirmed by code before anything is classified.
 * Three call sites share this one wake — the live confirmation, the startup
 * backlog and the operator's hand-run backfill.
 *
 * `realtime` because classification runs before the `binding_ack` notice
 * the rep is waiting for (spec #171 decision 3; `lanes.ts`, #173).
 *
 * `as const satisfies Wake` RATHER THAN AN ANNOTATION, so the wake's two
 * words stay LITERAL — `"entity_kind"` and `"request"`. `classify.ts` builds
 * the trigger from them, and an annotation would force a cast there to say
 * something the constant already knew.
 */
export const ENTITY_KIND_WAKE = {
  kind: "trigger",
  mechanism: "request",
  occasion: "entity_kind",
} as const satisfies Wake;

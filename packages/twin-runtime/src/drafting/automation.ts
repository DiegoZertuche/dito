/**
 * WHAT WAKES DRAFTING (tickets #172, #363; spec #171 decisions 14 and 15;
 * ADR-0014 as amended).
 *
 * Drafting is one definition Dito ships — one `agent` step on a conversation
 * of its own (`runs/shipped-conversations.ts`) — run through the engine's
 * no-row path on a customer's settled turn. Model routing stays at the app
 * boundary (ADR-0015): `rig-run.ts` reads `DITO_DRAFTING_MODEL`, so a model
 * name here would hide a routing decision.
 */
import type { Wake } from "@dito/execution";

/**
 * How many rounds one drafting turn gets.
 *
 * SIX. A turn that legitimately looks before it writes spends a round asking
 * and a round reading — the whole point of `search_memory` — and a refused
 * `create_draft` is FEEDBACK: the model is handed the reason and may call it
 * again, which is only true if the budget has a round left when the refusal
 * arrives. Six is the number the twin thread takes (spec #171 decision 19)
 * and the owner twin, for the same shape of work. A runaway loop is a loud
 * `failed` rather than a bill.
 */
export const DRAFTING_MAX_ITERATIONS = 6;

/**
 * A CUSTOMER'S SETTLED TURN.
 *
 * A `seam_event` TRIGGER and nothing else: a settled run of customer messages
 * is `wa_events` rows arriving and then going quiet, which is what the
 * consumer's settle predicate reads over timestamps Postgres supplied (#75).
 * The predicate itself stays code and stays in SQL — spec #171 decision 14
 * says so — because a metadata-only wake predicate (ADR-0012) can describe
 * WHICH events wake drafting and never a quiet window.
 *
 * `whatsapp` ALONE AND `message`, WHICH IS NARROWER THAN THE ROUTER.
 * Reactions and opaque deliveries reach the same consumer and land in twin
 * memory, and neither opens a turn — ADR-0041 and ADR-0042 both rule that
 * they are context and never a trigger. One source, where the thread names
 * two (ticket #261): drafting answers a CUSTOMER, and the dashboard's door has
 * no customer in it.
 *
 * `as const satisfies Wake` RATHER THAN AN ANNOTATION, so the wake's two
 * words stay LITERAL: `consumer.ts` builds the trigger from them.
 */
export const DRAFTING_WAKE = {
  kind: "trigger",
  mechanism: "seam_event",
  occasion: "chat_turn",
  predicate: { sources: ["whatsapp"], eventTypes: ["message"] },
} as const satisfies Wake;

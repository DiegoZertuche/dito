/**
 * WHAT WAKES THE TWIN THREAD (tickets #173, #319, #320, #363; spec #171
 * decisions 18 and 19; ADR-0014 as amended).
 *
 * The thread is one definition Dito ships — one `agent` step on the day's
 * conversation (`runs/shipped-conversations.ts`) — run through the engine's
 * no-row path, and three wakes: the rep's line at either door, an event of
 * the seam, and the rep's arrival. The consumer decides which fires (`consumer.ts`); each
 * wake is what the record's trigger is held to (`assertRunnable`), so a turn
 * is recorded under the occasion that really woke it.
 *
 * `as const satisfies Wake` RATHER THAN AN ANNOTATION, so each wake's two
 * words stay LITERAL — `"twin_thread_message"` and `"seam_event"`, not the
 * occasion union and the mechanism union. `consumer.ts` builds the trigger
 * from them, and an annotation would force a cast there to say something the
 * constant already knew.
 */
import type { Wake } from "@dito/execution";

/**
 * How many rounds one thread turn gets.
 *
 * TEN (Diego, 2026-10-12, boundary #327): the spec's six (decision 19) left a
 * turn that looks across the rep's chats — a search, a read, a second search
 * when the first found the wrong conversation, the chat index — one refusal
 * from a loud `failed`. A refused line is FEEDBACK (`thread/guard.ts`): the
 * model is handed the reason and writes again, which is only true if the
 * budget has a round left when the refusal arrives. A runaway loop is still a
 * loud `failed` rather than a bill.
 */
export const THREAD_MAX_ITERATIONS = 10;

/**
 * THE REP'S LINE, AT EITHER DOOR.
 *
 * A `seam_event` TRIGGER and nothing else: the occasion is one row the rep
 * authored — a `wa_events` row in their own thread, or a `dashboard_messages`
 * row typed at the dashboard's door — read the moment it arrives. There is no
 * settle window here and there must not be one — a rep who asks something is
 * waiting on the answer — which is the whole asymmetry with drafting's
 * `chat_turn`. The dashboard is an OCCASION and never a mechanism (ADR-0013
 * as amended): `request` is what the API performs inline, and a door message
 * is a durable row this consumer picks up.
 *
 * THE PREDICATE NAMES BOTH DOORS' SOURCES AND `message` (ticket #261; spec
 * #258 *Habla con Dito, the mechanism*): two integrations the same occasion
 * arrives through. IT IS STILL NARROWER THAN THE ROUTER on `whatsapp`, and
 * deliberately the same `message` drafting declares: a reaction and an
 * unreadable delivery in this thread both reach a turn today (`routeReaction`,
 * `routeOpaque`), and a metadata-only wake predicate (ADR-0012) cannot express
 * "in the rep's own thread, anything they do" — recorded on the horizon
 * (#117): the honest fix is a gesture and an opaque delivery becoming their
 * own occasions, which is a spec decision.
 */
export const THREAD_MESSAGE_WAKE = {
  kind: "trigger",
  mechanism: "seam_event",
  occasion: "twin_thread_message",
  predicate: { sources: ["whatsapp", "dashboard"], eventTypes: ["message"] },
} as const satisfies Wake;

/**
 * AN EVENT OF THE SEAM (ticket #319; spec #318 decision 11; ADR-0014 as
 * amended 2026-09-27: "the seam's events wake its turns"). The predicate
 * names the events the wake list wakes on (`events.ts`); an appended event
 * creates no execution at all, which is what lets the records prove the list
 * was honoured.
 */
export const THREAD_EVENT_WAKE = {
  kind: "trigger",
  mechanism: "seam_event",
  occasion: "twin_thread_event",
  predicate: {
    sources: ["runtime"],
    eventTypes: [
      "post_landed",
      "post_settled",
      "matter_picked",
      "selection",
      "summons",
      "run_finished",
      "run_failed",
      "expiring",
    ],
  },
} as const satisfies Wake;

/**
 * THE REP'S ARRIVAL (ticket #320; spec #318 decision 15; design D4): its own
 * wake rather than a wider event predicate, because an arrival turn's record
 * says `arrival` — `ArrivalTrigger` names the seat, the arrival row, the visit
 * and the two instants the return line is about. The mechanism is `request`:
 * the local API's ask raised it and the runtime's pass hands it a turn.
 */
export const THREAD_ARRIVAL_WAKE = {
  kind: "trigger",
  mechanism: "request",
  occasion: "arrival",
} as const satisfies Wake;

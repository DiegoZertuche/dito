/**
 * How an opaque delivery READS (ticket #124; ADR-0042).
 *
 * A delivery the plane could not read crosses the seam as its own typed
 * event carrying the rail's own kind and a reason, and no content at all —
 * because there is none to carry (see `@dito/seam`'s wa-payload header).
 * What the twin remembers is therefore composed rather than transcribed:
 * one placeholder beat, «[foto]», «[nota de voz]», «[mensaje que no se
 * pudo leer]», standing where the empty-text husk used to read as somebody
 * saying nothing.
 *
 * TWO READERS BUILD THAT ROW and they must agree, so they build it here.
 * The consumer writes it into twin memory (`routeOpaque`) and the
 * extraction window builds it as a beat of the day (`readOpaqueDelivery`),
 * and both have to reach the same three answers: the placeholder composed
 * from the kind, the ROW's suffixed identity as the message id, and the
 * message the row stands for in `opaqueOf`. The third is what the fold
 * decides on (`foldOpaqueDeliveries`), so two readers that disagreed about
 * it would fold in one context and not the other — a divergence no test
 * of either reader alone would catch.
 *
 * COMPOSED AT READ TIME, and unlike a reaction's line that costs nothing:
 * the placeholder is a pure function of the kind, so there is no target to
 * resolve and no later arrival to wait for (`reactions.ts` explains why a
 * gesture cannot be frozen at ingest; an opaque delivery has no such
 * problem, which is why its `content` IS stored).
 */
import type { ConversationRow } from "@dito/bundle";
import { opaquePlaceholder, opaqueRowStandsFor } from "./payload.js";
import type { WaOpaquePayload } from "./payload.js";

/**
 * One opaque delivery as a conversation row — the placeholder beat, keyed
 * by the seam's own identity for it.
 *
 * `occurredAt` comes from the SEAM ROW rather than the payload, exactly as
 * it does for a message and a gesture: the plane stamps when the delivery
 * happened, and that is the instant every chronological reader is cut on.
 *
 * AND `sender_ts_ms` IS NOT CARRIED INTO THE ROW, deliberately (Codex r1).
 * The wire shape REQUIRES it — a field that is optional at birth is one no
 * later consumer can rely on — but nothing spends it here. `inDeliveryOrder`
 * re-deals only gestures, and its docblock argues that case specifically:
 * two taps of one second can be a 👍 and the removal that retracts it, so
 * their order decides whether the model reads a standing yes. Two opaque
 * deliveries of one second are «[foto]» and «[nota de voz]», and swapping
 * them says nothing different — while dealing them into slots would also
 * move them across a same-second MESSAGE, which is the cost that docblock
 * accepts for gestures and nobody has accepted for anything else. When a
 * kind is promoted out of `'opaque'` (ADR-0042), its typed row is where
 * that clock earns a reader.
 */
export function opaqueConversationRow(
  payload: WaOpaquePayload,
  occurredAt: string,
): ConversationRow {
  const standsFor = opaqueRowStandsFor(payload.messageId);
  return {
    chatJid: payload.chatJid,
    // The seam's own identity for this delivery, suffix included: what
    // makes it a row of its own beside the readable row for the same
    // message, and what the seam's dedupe already keys on.
    messageId: payload.messageId,
    senderJid: payload.senderJid,
    fromMe: payload.fromMe,
    occurredAt,
    content: opaquePlaceholder(payload.kind),
    opaqueKind: payload.kind,
    // What the fold decides on — absent on the id-less `opaque:<hash>`
    // shape, which stands for no message and so folds with nothing.
    ...(standsFor === undefined ? {} : { opaqueOf: standsFor }),
    ...(payload.pushName === undefined ? {} : { pushName: payload.pushName }),
  };
}

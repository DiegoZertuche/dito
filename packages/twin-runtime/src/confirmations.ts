/**
 * The send confirmation sweep (ticket #25; ADR-0006: "the self-chat
 * carries the send confirmation"): when a customer_send has resolved
 * sent — the executor's finalization, read back over the seam — the twin
 * posts «✳️ Enviado a {cliente} ✓» to the twin thread as a notice +
 * system_send (the frame and counterparty naming are ticket #30's
 * grammar). The name resolves at sweep time through the one rule (#34):
 * a rep-confirmed binding names the counterparty unmarked — read from
 * the bundle's entity mirror through the bundle API — and until then the
 * drafted inbound's push-name (number when absent) wears «(sin
 * confirmar)».
 *
 * Confirmation minting is runtime domain, not plane behavior: the plane
 * stays dumb (ADR-0005/0017) and just posts what the notice row says.
 * Exactly-once rests on the notices unique index (one send_confirmation
 * per command), not on sweep bookkeeping: the sweep query skips
 * already-confirmed commands, and a racing duplicate insert would refuse
 * on the constraint rather than double-post. Only 'sent' confirms —
 * failed and held sends stay visible by their absence this slice; a
 * retry is a new tap.
 */
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { withDbTransaction } from "./db-tx.js";
import { counterpartyName, sendConfirmationReceipt } from "./grammar.js";
import { insertNoticeWithSystemSend } from "./notices.js";
import { composeReceiptPost } from "./posts.js";
import { decodeWaMessagePayload } from "./payload.js";
import type { SeatEvents } from "./seat-events.js";
import type { ThreadEventSink } from "./thread/events.js";

export interface ConfirmationDeps {
  readonly db: pg.Client;
  readonly dek: Dek;
  /** The twin's open bundle: the sweep reads bindings through its API (#34). */
  readonly bundle: Bundle;
  readonly twinId: string;
  readonly selfChatJid: string;
  /**
   * THE SEAT'S EVENT BUS (ticket #266): where «Enviado» comes from. This
   * sweep is the one place the runtime learns a customer send resolved
   * `sent`, so the canvas's `settle { sent }` is published here, after the
   * confirmation commits — never on the press, because «Enviado» is the truth
   * of the send. Absent, nothing is published.
   */
  readonly events?: SeatEvents;
  /**
   * The twin thread's days (ticket #319): «Enviado» is also a `post.settled`
   * event in the day's conversation — the rail's outcome, never the rep's act
   * on the card, so it appends. Absent, the thread is told nothing.
   */
  readonly threadSessions?: ThreadEventSink;
}

/** Emits the confirmation for every newly resolved customer_send; returns how many were posted. */
export async function processResolvedSends(
  deps: ConfirmationDeps,
): Promise<number> {
  const resolved = await deps.db.query<{
    id: string;
    destination: string;
    payload_enc: Buffer | null;
    post_id: string | null;
  }>(
    `SELECT sc.id, sc.destination, e.payload_enc, p.id AS post_id
       FROM send_commands sc
       LEFT JOIN drafts d ON d.id = sc.draft_id
       LEFT JOIN posts p ON p.draft_id = sc.draft_id
       LEFT JOIN wa_events e ON e.id = d.in_reply_to_event_id
       LEFT JOIN notices n
         ON n.about_command_id = sc.id AND n.kind = 'send_confirmation'
      WHERE sc.twin_id = $1
        AND sc.send_class = 'customer_send'
        AND sc.outcome = 'sent'
        AND n.id IS NULL
      ORDER BY sc.executed_at, sc.id`,
    [deps.twinId],
  );
  for (const command of resolved.rows) {
    // The counterparty name, resolved at sweep time through the one rule
    // (#34): the destination chat's rep-confirmed binding when one exists
    // — so a draft born provisional confirms under the rep-confirmed
    // name — otherwise the drafted inbound's push-name (its payload
    // decoded under the twin DEK exactly as the consumer decoded it to
    // draft — a payload that fails here is seam corruption and refuses
    // loudly), or the destination number, marked «(sin confirmar)».
    const binding = deps.bundle.readChatBinding(command.destination);
    const pushName =
      command.payload_enc === null
        ? undefined
        : decodeWaMessagePayload(deps.dek, command.payload_enc).pushName;
    const counterparty = counterpartyName({
      confirmedName: binding?.displayName,
      pushName,
      senderJid: command.destination,
    });
    await withDbTransaction(deps.db, () =>
      insertNoticeWithSystemSend(deps.db, {
        twinId: deps.twinId,
        selfChatJid: deps.selfChatJid,
        dek: deps.dek,
        kind: "send_confirmation",
        aboutCommandId: command.id,
        // A RECEIPT, and the one code composes with no execution at all
        // (ticket #220): the sweep reports a send the executor performed.
        post: composeReceiptPost(sendConfirmationReceipt(counterparty)),
      }),
    );
    // «ENVIADO», AFTER THE CONFIRMATION COMMITTED (ticket #266). The
    // confirmation's own unique index is what makes this once per command:
    // the next sweep finds it confirmed and does not reach here again.
    if (deps.events !== undefined && command.post_id !== null) {
      const seat = await seatOfTwin(deps);
      if (seat !== undefined) {
        deps.events.publish(seat, {
          kind: "settle",
          postId: command.post_id,
          outcome: "sent",
        });
      }
    }
    if (command.post_id !== null) {
      deps.threadSessions?.raise(deps.twinId, {
        kind: "post.settled",
        postId: command.post_id,
        outcome: "sent",
        byRep: false,
      });
    }
  }
  return resolved.rows.length;
}

/** The twin's one seat (`seats_one_seat_per_twin`), or none. */
async function seatOfTwin(
  deps: Pick<ConfirmationDeps, "db" | "twinId">,
): Promise<string | undefined> {
  const rows = await deps.db.query<{ id: string }>(
    "SELECT id FROM seats WHERE twin_id = $1",
    [deps.twinId],
  );
  return rows.rows[0]?.id;
}

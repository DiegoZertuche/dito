/**
 * Seam fixtures for the twin-runtime's integration tests (spec #18: the
 * whole twin-side loop is testable by injecting seam events). Payloads are
 * sealed exactly the way `plane/ingest` seals them — the pinned #22 v1
 * JSON contract under the twin's DEK, via the real @dito/crypto envelope
 * (the cross-language tests on #22 guarantee byte compatibility).
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import {
  insertWaEventFixture,
  insertWaOpaqueFixture,
  insertWaReactionFixture,
  sealWaMessagePayload,
  type WaEventFixture,
  type WaOpaqueFixture,
  type WaReactionFixture,
} from "../../../seam/src/testing/wa-fixtures.js";

export type { WaEventFixture, WaOpaqueFixture, WaReactionFixture };

/**
 * Seals the pinned v1 payload the way the plane does. The contract lives
 * in @dito/seam (ticket #50 moved its decoder there, so the aperture can
 * re-read a rep act for itself); this is the one seal both sides use.
 */
export const sealPayload: (dek: Dek, fixture: WaEventFixture) => Uint8Array =
  sealWaMessagePayload;

/** Injects one wa_events row with the pinned metadata envelope; returns its id. */
export const insertWaEvent: (
  client: pg.Client,
  dek: Dek,
  fixture: WaEventFixture,
) => Promise<string> = insertWaEventFixture;

/**
 * Injects one `wa_events` REACTION row (ticket #97), sealed the way the
 * plane will once #100 lands. The runtime learns to speak the type before
 * any plane emits one — ADR-0041's deploy-order rule — so until then this
 * fixture is the only source of a reaction row anywhere.
 */
export const insertWaReaction: (
  client: pg.Client,
  dek: Dek,
  fixture: WaReactionFixture,
) => Promise<string> = insertWaReactionFixture;

/**
 * Injects one `wa_events` OPAQUE row (ticket #124), sealed the way the
 * plane will once #125 lands. The runtime learns to speak the type before
 * any plane emits one — ADR-0042 makes that deploy order a rule of the
 * seam rather than of one kind — so until then this fixture is the only
 * source of an opaque row anywhere.
 */
export const insertWaOpaque: (
  client: pg.Client,
  dek: Dek,
  fixture: WaOpaqueFixture,
) => Promise<string> = insertWaOpaqueFixture;

/**
 * The plane executor's successful post, simulated at the seam — the ONE
 * mirror of plane/executor's finalizeSent (proven in Go against a stubbed
 * socket): execution evidence, the own-send capture, and the single
 * finalizing UPDATE, committed together. Every TS test that needs "the
 * executor posted this command" goes through here, so the mirrored contract
 * lives in exactly one place; the cross-language contract itself is verified
 * live on the rig (#26).
 *
 * THE OWN-SEND CAPTURE (ticket #63). A delivered `customer_send` is written
 * back onto the seam as a `from_me` message on the destination chat, because
 * WhatsApp never echoes the sending device's own messages to it — without
 * this the twin cannot see what it said, and extraction reads half a
 * conversation. `system_send` is deliberately NOT written back; the reasoning
 * lives on `plane/executor`'s `finalizeSent`, and the Go test
 * `TestSystemSendIsRecordedAsAnExecutionAndNeverEntersTwinMemory` is what
 * makes it a decision rather than a gap.
 */
export async function simulateExecutorPost(
  client: pg.ClientBase,
  args: {
    commandId: string;
    twinId: string;
    waMessageId: string;
    /**
     * WHEN the executor landed it, when a suite needs that instant to be a
     * known one (ticket #54). The correction window starts at
     * rep-reachability — this stamp — so finalization is measured from it,
     * and a test that wanted a specific one could not backdate afterwards:
     * `send_commands_outcome_only` makes the outcome and its `executed_at`
     * final together. It has to be chosen here, in the one write, which is
     * why it is a parameter rather than a second statement. Defaults to
     * `now()`, exactly as the plane's own `finalizeSent` does.
     *
     * It is also the captured send's `occurred_at` (ticket #63): the plane
     * stamps that from the rail's own send instant.
     */
    executedAt?: Date;
    /**
     * What the plane knows about itself, needed to record the own-send
     * capture (ticket #63). REQUIRED when the command turns out to be a
     * `customer_send`, and absent otherwise — the four values travel
     * together because they are one thing (the plane's own configuration),
     * and a caller that posts a customer_send without them would silently
     * reproduce the defect: a delivered message with no trace in twin
     * memory. It throws instead.
     */
    plane?: PlaneIdentity;
  },
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      "INSERT INTO send_executions (command_id, twin_id, wa_message_id) VALUES ($1, $2, $3)",
      [args.commandId, args.twinId, args.waMessageId],
    );
    await captureOwnSend(client, args);
    await client.query(
      `UPDATE send_commands SET outcome = 'sent', executed_at = COALESCE($2, now())
        WHERE id = $1 AND outcome IS NULL`,
      [args.commandId, args.executedAt ?? null],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * What the plane knows about itself when it records what it sent — the
 * config-read stamp and the live-session identity, together because the
 * plane holds them together (ticket #63).
 */
export interface PlaneIdentity {
  /** The twin DEK, for sealing the capture (ADR-0008 custody point two). */
  readonly dek: Dek;
  /**
   * The rep's own JID, which the plane takes from the live whatsmeow session
   * (ADR-0006) and stamps as an own-sent event's sender. In these suites that
   * is the self-chat JID, the same value the runtime is configured with.
   */
  readonly selfJid: string;
  /**
   * The seat's company and seat scope, as the plane stamps them from its own
   * configuration (`DITO_COMPANY_ID` / `DITO_SEAT_ID`) — ONE pair per twin,
   * on every row it writes. The aperture scopes a filed fact by the company
   * on the seam row it was read in (server-side, never from the device), so a
   * capture stamped with some other company than the twin's remaining rows
   * files facts into a company the twin's entities do not belong to.
   */
  readonly companyId: string;
  readonly seatId: string;
}

/**
 * The mirror of `ingest.CaptureOwnSend`, inside the caller's transaction
 * (ticket #63).
 *
 * THE CAPTURE GUARD DECIDES, not the send-lock. `scope_allowlist` and
 * `send_allowlist` are different lists: the first answers "may this twin
 * remember this chat" (ADR-0023), the second "may this twin send here"
 * (ADR-0017). A write-back is a capture, so the CAPTURE list governs it —
 * which is why a descoped chat with a tapped draft in flight still sends and
 * is still not remembered.
 *
 * The seam id is composed exactly as an inbound delivery composes it, so a
 * real echo dedupes onto this row rather than duplicating it.
 *
 * ONE DELIBERATE ASYMMETRY WITH THE GO SIDE. `plane/ingest` runs the
 * destination through `canonicalDMChat` before both the guard read and the
 * seam-id composition; this mirror uses the stored destination as it stands,
 * because there is no JID vocabulary on this side of the seam and inventing a
 * second, weaker canonicalization is worse than not having one. It costs
 * nothing here: `send_commands.destination` is the draft's, which is the
 * chat identity a captured inbound already carried, so the Go canonicalization
 * is a no-op on every value that can reach it. A fixture that hand-writes a
 * LID destination is the one case the two sides would answer differently, and
 * it is a fixture no plane can produce.
 */
async function captureOwnSend(
  client: pg.ClientBase,
  args: {
    commandId: string;
    twinId: string;
    waMessageId: string;
    executedAt?: Date;
    plane?: PlaneIdentity;
  },
): Promise<void> {
  const cmd = await client.query<{
    send_class: string;
    destination: string;
    payload_ref: string;
  }>(
    "SELECT send_class, destination, payload_ref FROM send_commands WHERE id = $1 AND twin_id = $2",
    [args.commandId, args.twinId],
  );
  const row = cmd.rows[0];
  if (row === undefined || row.send_class !== "customer_send") return;
  const plane = args.plane;
  if (plane === undefined) {
    throw new Error(
      `simulateExecutorPost for customer_send ${args.commandId} needs \`plane\` to record the own-send capture — a delivered send with no trace in twin memory is the #63 defect`,
    );
  }
  const inScope = await client.query(
    "SELECT 1 FROM scope_allowlist WHERE twin_id = $1 AND chat_jid = $2",
    [args.twinId, row.destination],
  );
  if (inScope.rows.length === 0) return;
  await insertWaEventFixture(client, plane.dek, {
    twinId: args.twinId,
    chatJid: row.destination,
    senderJid: plane.selfJid,
    fromMe: true,
    messageId: args.waMessageId,
    text: await sentText(client, plane.dek, row.payload_ref),
    occurredAt: args.executedAt ?? new Date(),
    companyId: plane.companyId,
    seatId: plane.seatId,
  });
}

/**
 * What actually went to the customer: the draft's BODY (never the framed
 * twin-thread post), or a notice's text — the same dereference
 * `plane/executor`'s `resolveContent` performs for this send class, refusing
 * an unknown scheme just as loudly (a newer runtime means upgrading the
 * plane, never guessing).
 */
async function sentText(
  client: pg.ClientBase,
  dek: Dek,
  payloadRef: string,
): Promise<string> {
  const at = payloadRef.indexOf(":");
  const scheme = at === -1 ? payloadRef : payloadRef.slice(0, at);
  const id = payloadRef.slice(at + 1);
  if (at === -1 || (scheme !== "draft" && scheme !== "notice")) {
    throw new Error(
      `payload_ref ${payloadRef} is not draft:<uuid> or notice:<uuid> — the executor speaks only those two`,
    );
  }
  const res = await client.query<{ content_enc: Buffer }>(
    scheme === "draft"
      ? "SELECT content_enc FROM drafts WHERE id = $1"
      : "SELECT content_enc FROM notices WHERE id = $1",
    [id],
  );
  const enc = res.rows[0]?.content_enc;
  if (enc === undefined) {
    throw new Error(`payload_ref ${payloadRef} dereferences to nothing`);
  }
  return Buffer.from(dek.decrypt(enc)).toString("utf8");
}

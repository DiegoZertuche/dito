/**
 * Seam fixtures for the inbound side: one `wa_events` row, sealed exactly
 * the way `plane/ingest` seals it — the pinned #22 v1 JSON contract under
 * the twin's DEK, through the real @dito/crypto envelope (the
 * cross-language tests on #22 guarantee byte compatibility).
 *
 * Lives in the seam package because the payload contract does (ADR-0005);
 * the twin-runtime's own fixture helper seals through this one, so a
 * contract change has exactly one place to land.
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import type { OpaqueReason } from "../wa-payload.js";

/**
 * What EVERY seam fixture carries whatever its event type — the plaintext
 * envelope plus the two additive v:1 fields both payload shapes share.
 * One definition, so a reaction row and a message row cannot drift apart
 * on the fields they have in common.
 */
export interface WaEnvelopeFixture {
  readonly twinId: string;
  readonly chatJid: string;
  readonly senderJid: string;
  readonly fromMe: boolean;
  /** This event's OWN stanza id (a reaction's is its own, not its target's). */
  readonly messageId: string;
  /** Sender push name — the additive #30 v:1 field; absent unless given. */
  readonly pushName?: string;
  /** The additive #33 backfill marker — sealed only when true, as the plane's history normalization stamps it. */
  readonly backfill?: boolean;
  readonly occurredAt?: Date;
  /**
   * Override the seam's external event id (default: composed
   * `<chat-jid>:<message-id>` as the plane composes it). A DISTINCT id for
   * the same (chat, message id) is the re-delivery signature (#31/#33:
   * e.g. a live/backfill overlap) — the seam's dedupe cannot catch it, so
   * the bundle's message-id idempotence must.
   */
  readonly externalEventId?: string;
  /**
   * The seat's company and seat scope, as the plane stamps it from its own
   * configuration. Random per row unless pinned — the aperture's tests pin
   * them, because "the company scope is applied server-side" is a claim
   * about exactly these columns (ADR-0035).
   */
  readonly companyId?: string;
  readonly seatId?: string;
}

export interface WaEventFixture extends WaEnvelopeFixture {
  readonly text: string;
  readonly quotedMessageId?: string;
  /** Override the row's event type — how a suite plants a type the runtime does not speak. */
  readonly eventType?: string;
}

/**
 * One `wa_events` REACTION row, sealed the way `plane/ingest` will seal it
 * once ticket #100 lands (ticket #97; ADR-0041). Its own fixture rather
 * than a flag on the message one, for the same reason a reaction is its
 * own event type: the two shapes share an envelope and nothing else.
 */
export interface WaReactionFixture extends WaEnvelopeFixture {
  /** The target message's stanza id, off the rail's reaction key. */
  readonly reactionTo: string;
  /** The emoji; the empty string is a REMOVAL, exactly as the rail sends it. */
  readonly emoji: string;
  /**
   * The rail's sender timestamp in ms — the last-write fold key. Defaults
   * to the row's own instant, which is what the plane stamps when the rail
   * supplies none.
   */
  readonly senderTsMs?: number;
}

/**
 * One `wa_events` OPAQUE row, sealed the way `plane/ingest` will seal it
 * once ticket #125 lands (ticket #124; ADR-0042) — an in-scope delivery the
 * plane could not read. Its own fixture, for the same reason it is its own
 * event type: it shares the envelope with the other two shapes and nothing
 * else.
 */
export interface WaOpaqueFixture extends WaEnvelopeFixture {
  /**
   * The rail's own name for the shape (`imageMessage`, `audioMessage`,
   * `undecryptable`, …). Free-form: it is whatever whatsmeow called it.
   */
  readonly kind: string;
  /**
   * Why the plane could not read it — the decoder's own closed set, never
   * retyped: two spellings of one vocabulary is two things that can drift.
   */
  readonly reason: OpaqueReason;
  /**
   * The rail's sender timestamp in ms. Defaults to the row's own instant,
   * which is what the plane stamps when the rail supplies none.
   */
  readonly senderTsMs?: number;
}

/** Seals the pinned v1 payload the way the plane does. */
export function sealWaMessagePayload(
  dek: Dek,
  fixture: WaEventFixture,
): Uint8Array {
  return dek.encrypt(
    Buffer.from(
      JSON.stringify({
        v: 1,
        chat_jid: fixture.chatJid,
        sender_jid: fixture.senderJid,
        from_me: fixture.fromMe,
        message_id: fixture.messageId,
        text: fixture.text,
        ...(fixture.quotedMessageId === undefined
          ? {}
          : { quoted_message_id: fixture.quotedMessageId }),
        ...(fixture.pushName === undefined
          ? {}
          : { push_name: fixture.pushName }),
        ...(fixture.backfill ? { backfill: true } : {}),
      }),
      "utf8",
    ),
  );
}

/** Seals the pinned v1 reaction payload the way the plane will (#100). */
export function sealWaReactionPayload(
  dek: Dek,
  fixture: WaReactionFixture,
): Uint8Array {
  return dek.encrypt(
    Buffer.from(
      JSON.stringify({
        v: 1,
        chat_jid: fixture.chatJid,
        sender_jid: fixture.senderJid,
        from_me: fixture.fromMe,
        message_id: fixture.messageId,
        reaction_to: fixture.reactionTo,
        // Present even when empty — the empty string is the removal.
        emoji: fixture.emoji,
        sender_ts_ms:
          fixture.senderTsMs ??
          (fixture.occurredAt ?? DEFAULT_OCCURRED_AT).getTime(),
        ...(fixture.pushName === undefined
          ? {}
          : { push_name: fixture.pushName }),
        ...(fixture.backfill ? { backfill: true } : {}),
      }),
      "utf8",
    ),
  );
}

/** Seals the pinned v1 opaque payload the way the plane will (#125). */
export function sealWaOpaquePayload(
  dek: Dek,
  fixture: WaOpaqueFixture,
): Uint8Array {
  return dek.encrypt(
    Buffer.from(
      JSON.stringify({
        v: 1,
        chat_jid: fixture.chatJid,
        sender_jid: fixture.senderJid,
        from_me: fixture.fromMe,
        // THE ROW'S IDENTITY, suffix included — the fixture takes it whole,
        // exactly as the plane composes it (`<stanza>:opaque`, or
        // `opaque:<hash>` with no stanza id), so a suite can plant either
        // shape without this helper deciding which one is legal.
        message_id: fixture.messageId,
        kind: fixture.kind,
        reason: fixture.reason,
        sender_ts_ms:
          fixture.senderTsMs ??
          (fixture.occurredAt ?? DEFAULT_OCCURRED_AT).getTime(),
        ...(fixture.pushName === undefined
          ? {}
          : { push_name: fixture.pushName }),
        ...(fixture.backfill ? { backfill: true } : {}),
      }),
      "utf8",
    ),
  );
}

/** Injects one `wa_events` opaque row; returns its id. */
export async function insertWaOpaqueFixture(
  client: pg.ClientBase,
  dek: Dek,
  fixture: WaOpaqueFixture,
): Promise<string> {
  return await insertSealedWaEvent(client, {
    externalEventId:
      fixture.externalEventId ?? `${fixture.chatJid}:${fixture.messageId}`,
    eventType: "opaque",
    twinId: fixture.twinId,
    occurredAt: fixture.occurredAt ?? DEFAULT_OCCURRED_AT,
    payloadEnc: sealWaOpaquePayload(dek, fixture),
    companyId: fixture.companyId ?? null,
    seatId: fixture.seatId ?? null,
  });
}

/** Injects one `wa_events` reaction row; returns its id. */
export async function insertWaReactionFixture(
  client: pg.ClientBase,
  dek: Dek,
  fixture: WaReactionFixture,
): Promise<string> {
  return await insertSealedWaEvent(client, {
    externalEventId:
      fixture.externalEventId ?? `${fixture.chatJid}:${fixture.messageId}`,
    eventType: "reaction",
    twinId: fixture.twinId,
    occurredAt: fixture.occurredAt ?? DEFAULT_OCCURRED_AT,
    payloadEnc: sealWaReactionPayload(dek, fixture),
    companyId: fixture.companyId ?? null,
    seatId: fixture.seatId ?? null,
  });
}

/** Injects one wa_events row with the pinned metadata envelope; returns its id. */
export async function insertWaEventFixture(
  client: pg.ClientBase,
  dek: Dek,
  fixture: WaEventFixture,
): Promise<string> {
  return await insertSealedWaEvent(client, {
    // Composed as the plane composes it; opaque to the runtime.
    externalEventId:
      fixture.externalEventId ?? `${fixture.chatJid}:${fixture.messageId}`,
    eventType: fixture.eventType ?? "message",
    twinId: fixture.twinId,
    occurredAt: fixture.occurredAt ?? DEFAULT_OCCURRED_AT,
    payloadEnc: sealWaMessagePayload(dek, fixture),
    companyId: fixture.companyId ?? null,
    seatId: fixture.seatId ?? null,
  });
}

/** The instant a fixture row occurred at unless the suite pins one. */
const DEFAULT_OCCURRED_AT = new Date("2026-08-27T14:03:00Z");

/**
 * THE ONE INSERT: the pinned plaintext envelope with an already-sealed
 * payload. Every typed fixture above composes its own payload and lands it
 * here, so the row shape has one definition whatever the event type.
 */
async function insertSealedWaEvent(
  client: pg.ClientBase,
  row: {
    externalEventId: string;
    eventType: string;
    twinId: string;
    occurredAt: Date;
    payloadEnc: Uint8Array;
    companyId: string | null;
    seatId: string | null;
  },
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO wa_events
       (source, external_event_id, event_type, company_id, seat_id, twin_id,
        occurred_at, payload_enc)
     VALUES ('whatsapp', $1, $2,
             COALESCE($6::uuid, gen_random_uuid()),
             COALESCE($7::uuid, gen_random_uuid()),
             $3, $4, $5)
     RETURNING id`,
    [
      row.externalEventId,
      row.eventType,
      row.twinId,
      row.occurredAt,
      Buffer.from(row.payloadEnc),
      row.companyId,
      row.seatId,
    ],
  );
  return res.rows[0]!.id;
}

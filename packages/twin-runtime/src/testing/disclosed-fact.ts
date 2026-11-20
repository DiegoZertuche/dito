/**
 * THE DAY'S RECORD, FOR A SUITE (tickets #224 and #344): one fact filed
 * through the aperture and the numbering the post printed — the card a
 * **Retirar** and a correction in place both act on.
 *
 * IT LIVES HERE BECAUSE SEVERAL SUITES DRIVE IT: the dashboard's acts, the
 * door's message and the day's thread each correct the same line, and a copy
 * in each is the copy that drifts (`door.ts` beside it, for the same reason).
 */
import { randomUUID } from "node:crypto";
import { fileCandidateFact, fileEntityCreate } from "@dito/aperture";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { withDbTransaction } from "../db-tx.js";
import { insertNoticeWithSystemSend } from "../notices.js";
import { TEST_AUDIT_HMAC_KEY } from "./db.js";
import { insertWaEvent } from "./seam-fixtures.js";

const SELF_CHAT = "5215550000@s.whatsapp.net";
const CUSTOMER = "5215550001@s.whatsapp.net";
const PUSH_NAME = "Sra. Garza";
const DISCLOSURE_DAY = "2026-09-08";

/** When the record reached the rep, unless a case says otherwise. */
export const RECORD_REACHED = new Date("2026-09-08T19:00:00.000Z");

/** The twin and the seat the record is filed under. */
export interface RecordTwin {
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly dek: Dek;
}

/**
 * The day's record: one fact filed through the aperture, and the numbering the
 * post printed, recorded against a `disclosure_posts` row.
 *
 * THE POST IS A NOTICE LIKE ANY OTHER — one the rep really received, because
 * the card's window is computed from the instant its `system_send` resolved
 * `sent`. `executedAt` is therefore the whole subject of this fixture rather
 * than a detail (ADR-0004: the clock starts at rep-reachability).
 */
export async function disclosedFact(
  client: pg.Client,
  twin: RecordTwin,
  options: {
    readonly reachedAt?: Date;
    /** The record's day — one record per twin per day (`disclosure_posts`). */
    readonly day?: string;
    /**
     * The customer's entity create printed as line 2 beside the fact's line 1,
     * so a case can name a second line the post really printed.
     */
    readonly withCreateLine?: boolean;
  } = {},
): Promise<{ postId: string; factId: string; lineId: string }> {
  const entityId = randomUUID();
  const sourceEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: CUSTOMER,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: `3EB0-QUOTE-${randomUUID().slice(0, 8)}`,
    text: "te las dejo en 4500",
    occurredAt: new Date("2026-09-08T15:07:00.000Z"),
  });
  // THE CUSTOMER, THROUGH THE APERTURE — the single writer (ADR-0003), which
  // files the entity, its creation grant and its disclosure line in one
  // transaction. A hand-inserted entity is refused by FR-72's own trigger
  // before the line could be written, which is the invariant doing its job:
  // an entity create puts a name into the Ledger and is disclosed.
  const confirmMessageId = `3EB0-BIND-${randomUUID().slice(0, 8)}`;
  const confirmEventId = await insertWaEvent(client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: SELF_CHAT,
    senderJid: SELF_CHAT,
    fromMe: true,
    messageId: confirmMessageId,
    text: "va",
    occurredAt: new Date("2026-09-08T15:00:00.000Z"),
  });
  await fileEntityCreate(
    { db: client, dek: twin.dek, hmacKey: TEST_AUDIT_HMAC_KEY },
    {
      twinId: twin.twinId,
      entityId,
      kind: "business",
      displayName: PUSH_NAME,
      evidence: {
        surface: "twin_thread",
        sourceEventId: confirmEventId,
        waMessageId: confirmMessageId,
      },
      disclosureText: "Lo di de alta como cliente.",
    },
  );
  const filed = await fileCandidateFact(
    { db: client, dek: twin.dek },
    {
      twinId: twin.twinId,
      entityId,
      sourceEventId,
      factType: "QuoteGiven",
      payload: { item: "cajas", amount: 4500, currency: "MXN" },
      confidence: 0.95,
      reading: "stated",
      renderDisclosureLine: () => "Le cotizaste cajas en 4500 MXN.",
    },
  );
  if (!filed.filed) throw new Error(`fixture did not file: ${filed.reason}`);
  const line = await client.query<{ id: string }>(
    `SELECT id FROM disclosure_lines
      WHERE twin_id = $1 AND fact_id = $2 AND subject_kind = 'fact'`,
    [twin.twinId, filed.factId],
  );
  const lineId = line.rows[0]!.id;

  // The post the rep read, and the numbering it printed. Composing the prose
  // needs a model; what the act resolves through is this numbering, and it is
  // recorded exactly as `runDailyDisclosure` records it.
  // THE CARD'S LINES ARE A REFERENCE TO THE NUMBERING (ticket #344): the
  // `record-lines` part names the disclosure post, so the feed draws the
  // numbered lines — and a correction's words beside them — off the rows.
  const disclosurePostId = randomUUID();
  const noticeId = await insertNoticeWithSystemSend(client, {
    twinId: twin.twinId,
    selfChatJid: SELF_CHAT,
    dek: twin.dek,
    kind: "daily_disclosure",
    post: {
      parts: [
        { kind: "receipt", text: "Hoy agregué 1 dato al registro." },
        { kind: "record-lines", disclosurePostId },
      ],
      text: "✳️ Hoy agregué 1 dato al registro.",
    },
  });
  // ONE TRANSACTION FOR THE POST AND ITS NUMBERING, which ADR-0034's own
  // trigger insists on: a line may not join a post after the transaction that
  // wrote it, because the numbering IS the record of what the rep saw. The
  // composer writes both in one unit and so does this.
  await withDbTransaction(client, async () => {
    await client.query(
      `INSERT INTO disclosure_posts (id, twin_id, disclosure_day, notice_id)
       VALUES ($1, $2, $3, $4)`,
      [disclosurePostId, twin.twinId, options.day ?? DISCLOSURE_DAY, noticeId],
    );
    await client.query(
      `INSERT INTO disclosure_post_lines
         (twin_id, post_id, line_index, disclosure_line_id)
       VALUES ($1, $2, 1, $3)`,
      [twin.twinId, disclosurePostId, lineId],
    );
    if (options.withCreateLine === true) {
      await client.query(
        `INSERT INTO disclosure_post_lines
           (twin_id, post_id, line_index, disclosure_line_id)
         SELECT $1, $2, 2, id FROM disclosure_lines
          WHERE twin_id = $1 AND entity_id = $3 AND subject_kind = 'entity_create'`,
        [twin.twinId, disclosurePostId, entityId],
      );
    }
  });
  // THE SEND THAT REACHED THE REP, which is what starts the correction window
  // (ADR-0004: the clock starts at rep-reachability, and `'sent'` is the only
  // outcome that means it).
  await client.query(
    `UPDATE send_commands SET outcome = 'sent', executed_at = $2
      WHERE payload_ref = 'notice:' || $1::text`,
    [noticeId, options.reachedAt ?? RECORD_REACHED],
  );
  const post = await client.query<{ id: string }>(
    "SELECT id FROM posts WHERE notice_id = $1",
    [noticeId],
  );
  return { postId: post.rows[0]!.id, factId: filed.factId, lineId };
}

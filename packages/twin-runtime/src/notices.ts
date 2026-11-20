/**
 * Notice emission (ticket #25): a notice row — what the twin tells the
 * rep in the twin thread, DEK-encrypted at rest like a draft (ADR-0008) —
 * and the system_send that posts it (ADR-0006: system_send reaches only
 * the self-chat; the plane re-derives "self" from live session identity
 * at execution, so the destination here is advisory like the consumer's).
 *
 * Runs inside the caller's open transaction: the callers own atomicity —
 * the refusal path commits notice + command with its processing marker;
 * the confirmation sweep commits notice + command as one emission, made
 * exactly-once by the notices unique index, not by sweep bookkeeping.
 *
 * IT NAMES ONE ORIGIN, NEVER TWO (ticket #224). A notice that acknowledges an
 * act says which act: the rep's own seam event, or the dashboard act row the
 * local API wrote for a button press. `dashboardActId` argues why the store
 * refuses both at once.
 *
 * IT WRITES THE POST ROW TOO (ticket #220). A notice is a twin post's
 * thread-rendering record and `posts` is that post's surface-independent
 * one, so both are written here — the two commit together or neither does,
 * and there is no order of statements in which a notice reaches the rep
 * with no post beside it. What the caller hands over is a `ComposedPost`:
 * the parts and the rendering they amount to, in one value, so a post
 * cannot be emitted with text its parts do not account for.
 */
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { assertFramed } from "./grammar.js";
import { composeReceiptPost, insertPost, type AskedAt, type ComposedPost } from "./posts.js";

/**
 * WHAT KIND OF THING THE TWIN JUST POSTED — the eleven words the `notices`
 * CHECK constraint accepts, as a type (named at #174).
 *
 * IT WAS AN INLINE UNION ON ONE PARAMETER and is a type now because a
 * second reader appeared: a thread execution's receipt takes the kind of
 * the act it acknowledges (`receiptNoticeKind` in `consumer.ts`), and a
 * function returning "one of these eleven" needs a name for them.
 *
 * IT LOST `aperture_question` AT #218, and that is the one narrowing this
 * set has ever taken (spec #214 decision 3). Nothing composes such a post
 * any more — the candidate-question route is retired — so the word is
 * neither a kind this build can write nor a kind the store will accept from
 * it. The posts the rep already read keep theirs: a notice is immutable by
 * trigger and ADR-0034 is why, so the CHECK is narrowed for new rows alone
 * (…20260907100010).
 */
export type NoticeKind =
  | "send_confirmation"
  | "affirmation_refusal"
  | "dismissal_ack"
  | "binding_question"
  | "binding_ack"
  | "answer"
  | "daily_disclosure"
  | "correction_ack"
  | "correction_refusal"
  // A run's question card (ticket #324), answered on the card or in prose.
  | "ask"
  // A rutina the twin proposes (ticket #386), accepted on the card or in prose.
  | "proposal";

/**
 * Emits one twin post. Returns the notice's id — the handle the daily
 * disclosure records against its post (ticket #51), so a later quoted
 * correction resolves through the same `notice:<uuid>` ref the executor
 * already posts under.
 */
export async function insertNoticeWithSystemSend(
  client: pg.ClientBase,
  args: {
    twinId: string;
    selfChatJid: string;
    dek: Dek;
    kind: NoticeKind;
    aboutCommandId?: string;
    aboutEventId?: string;
    /**
     * The DASHBOARD ACT this post acknowledges, when the rep pressed a button
     * on a card (ticket #224).
     *
     * IT IS THE OTHER ORIGIN AND NEVER A SECOND ONE. A receipt names what it
     * acknowledges, and `notices` has enforced that per kind since slice 2 —
     * `about_event_id NOT NULL` for an ack, so an acknowledgement nobody could
     * trace to a rep was unrepresentable. A button has no seam row behind it,
     * so …20260908100060 re-cuts each of those constraints to «an event or an
     * act» and adds `notices_one_origin_check`: both set is refused by the
     * store, because a post claiming to acknowledge two acts is one no reader
     * could resolve.
     */
    dashboardActId?: string;
    /** The post itself: its typed parts and their thread rendering (#220). */
    post: ComposedPost;
    /**
     * The execution that composed this post, when one did (tickets #172,
     * #198). Absent for every notice code composes on its own — the send
     * confirmation, the refusal microcopy — and for every notice written
     * before executions existed.
     *
     * THE DAY'S POST CARRIES ONE, and it is the reason
     * `notices_execution_id_fkey` is DEFERRABLE (…2026090610003·): the
     * disclosure posts from inside its own execution's run, so the record it
     * names is written a few statements later in the same transaction.
     */
    executionId?: string;
    /**
     * WHICH DOOR ASKED FOR THE POST THIS NOTICE DELIVERS (ticket #261).
     *
     * `twin_thread` ON AN ANSWER; `dashboard` ON A RECEIPT THAT IS THE REPLY
     * TO A LINE TYPED IN THE BAR (ticket #358; `postReceipt`), which goes to
     * both surfaces and is the reply the day's thread shows under that line;
     * absent on everything else. The dashboard's answer in words has no
     * notice at all (`insertPost` argues why). What `twin_thread` buys is the
     * other half of «an answer goes where it was asked»: Inicio reads that
     * column and leaves a phone-asked answer off, so the rep is not shown
     * twice what they were already told once.
     */
    asked?: AskedAt;
    /** The rep's zone, for the reminder a card that can lapse is born with (`insertPost`). */
    timeZone?: string;
  },
): Promise<string> {
  // Every twin-authored post opens with the ✳️ frame (ticket #30): text
  // reaches this seam only through the grammar module, and an unframed
  // notice is refused loudly here — structural, not disciplinary.
  const contentEnc = Buffer.from(
    args.dek.encrypt(Buffer.from(assertFramed(args.post.text), "utf8")),
  );
  const noticeRes = await client.query<{ id: string }>(
    `INSERT INTO notices (twin_id, kind, about_command_id, about_event_id,
                          dashboard_act_id, content_enc, execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      args.twinId,
      args.kind,
      args.aboutCommandId ?? null,
      args.aboutEventId ?? null,
      args.dashboardActId ?? null,
      contentEnc,
      args.executionId ?? null,
    ],
  );
  const noticeId = noticeRes.rows[0]!.id;
  await insertPost(client, {
    twinId: args.twinId,
    dek: args.dek,
    parts: args.post.parts,
    ...(args.executionId === undefined
      ? {}
      : { executionId: args.executionId }),
    delivery: { noticeId },
    ...(args.asked === undefined ? {} : { asked: args.asked }),
    ...(args.timeZone === undefined ? {} : { timeZone: args.timeZone }),
  });
  await insertSystemSendCommand(client, {
    twinId: args.twinId,
    destination: args.selfChatJid,
    payloadRef: `notice:${noticeId}`,
  });
  return noticeId;
}

/**
 * A STAND-ALONE RECEIPT, TO BOTH SURFACES (ticket #358; glossary *Door*: «a
 * receipt goes to both surfaces»; ADR-0037 as amended).
 *
 * THE ONE DELIVERY A RECEIPT HAS WHEN NO WORDS CARRY IT: a notice and its
 * send, so the phone has it in the self-chat and the dashboard has the post.
 * A button's receipt and a thread turn's that said nothing come here with the
 * same arguments: the act's notice kind, the tool's receipt, the execution,
 * and what it acknowledges — the rep's thread message, the dashboard act, or
 * nothing beyond the execution, whose trigger names the line or the event.
 * `asked` is the door a typed line came in at, so the day's thread shows the
 * receipt as the reply to it. A receipt that rides with the twin's words is
 * part of that reply instead (`postAnswer`).
 */
export async function postReceipt(
  client: pg.ClientBase,
  args: {
    readonly twinId: string;
    readonly selfChatJid: string;
    readonly dek: Dek;
    readonly kind: NoticeKind;
    readonly receipt: string;
    readonly executionId: string;
    readonly about?: { readonly eventId: string } | { readonly dashboardActId: string };
    readonly asked?: AskedAt;
  },
): Promise<string> {
  return await insertNoticeWithSystemSend(client, {
    twinId: args.twinId,
    selfChatJid: args.selfChatJid,
    dek: args.dek,
    kind: args.kind,
    post: composeReceiptPost(args.receipt),
    executionId: args.executionId,
    ...(args.about === undefined
      ? {}
      : "eventId" in args.about
        ? { aboutEventId: args.about.eventId }
        : { dashboardActId: args.about.dashboardActId }),
    ...(args.asked === undefined ? {} : { asked: args.asked }),
  });
}

/**
 * The ONE way a twin post's `system_send` command is written — the notice
 * seam and the draft emission both come here.
 *
 * It exists for the `created_at` stamp. The executor dispatches
 * `ORDER BY created_at, id`, and the column's `now()` default is
 * TRANSACTION time — so two posts emitted in one transaction (a draft and
 * its binding question) share a timestamp and fall back to comparing random
 * uuids, which leaves their order in the rep's thread a coin flip.
 * `clock_timestamp()` advances within the transaction, so thread order is
 * emission order: what the rep asked for lands first and the ceremony
 * follows it (#34 decision 5). Keeping it in one place means a third
 * emission site cannot silently restore the coin flip by forgetting the
 * stamp. The thread's own answer has no order to get wrong: one post
 * carries the reply and the question it asks (#195).
 */
export async function insertSystemSendCommand(
  client: pg.ClientBase,
  args: {
    twinId: string;
    destination: string;
    payloadRef: string;
    /** The draft this command posts, when it is a draft emission. */
    draftId?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO send_commands (twin_id, send_class, destination, payload_ref, draft_id, created_at)
     VALUES ($1, 'system_send', $2, $3, $4, clock_timestamp())`,
    [args.twinId, args.destination, args.payloadRef, args.draftId ?? null],
  );
}

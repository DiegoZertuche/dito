/**
 * WHICH ROW STANDS FOR A MESSAGE THE PLANE COULD NOT READ (ticket #124;
 * ADR-0042). Both readers that put a chat's beats in front of a model —
 * the bundle's `readConversation` and the extraction window's seam read —
 * end here, so «one message, one beat» has exactly one answer.
 *
 * WHY THERE IS ANYTHING TO FOLD. The seam records DELIVERIES and folds
 * nothing (ADR-0042), and an opaque row composes its own identity
 * (`<stanza>:opaque`) precisely so it can never collide with the readable
 * row for the same message. That is what keeps a re-delivery from being
 * swallowed by the dedupe — and it means twin memory can genuinely hold
 * two rows about one message. Deciding between them is a READ-TIME job,
 * because both rows are real deliveries and append-only memory never
 * rewrites either.
 *
 * TWO RULES, AND THE SECOND IS AN INVERSION:
 *
 *   1. A READABLE ROW STANDS OVER AN OPAQUE ONE. An undecryptable message
 *      the sender re-delivers after whatsmeow's retry receipt, or a photo
 *      re-captured typed after a promotion, arrives as words — and words
 *      are what the twin should read. Rendering both would tell the model
 *      the customer said the thing twice, once in silence.
 *
 *   2. AN OPAQUE ROW STANDS OVER THE LEGACY EMPTY-TEXT HUSK. Before
 *      ADR-0042 every shape the seam had no slot for wrote a `'message'`
 *      row with empty text, which reads as somebody saying nothing.
 *      Without this inversion, relink backfill would write honest opaque
 *      rows BESIDE the old husks and rule 1 would hand the husk the win —
 *      so existing twin memory would never heal, which is the whole point
 *      of re-capturing it.
 *
 * THE HUSK IS A CLASS, NOT AN EMPTY STRING (`/code-review`, spec axis).
 * Rule 2 asks whether the row is a `'message'` with no text, and it reads
 * `reactionTo` to know — because a GESTURE's `content` is legitimately
 * empty in one of the two readers. The extraction window builds every
 * gesture beat with `content: ""` and composes its line afterwards, once
 * it knows which targets the model will be shown. Testing emptiness alone
 * would therefore classify a real reaction as a husk in that reader and
 * not in the bundle's — and where an opaque row stands for the same stanza
 * id (a reaction the plane first saw malformed, then well-formed), it
 * would DROP the gesture and leave the placeholder standing. A gesture is
 * readable whatever its `content` says at the moment of the fold.
 *
 * NOTHING ELSE FOLDS HERE. Two readable rows for one message id are left
 * exactly as they are: that is a re-delivery question (#33's suffixed ids)
 * and collapsing it would be a silent change to what a transcript shows,
 * decided by nobody. This function only ever discards a row that LOST to a
 * row of the other class.
 *
 * IT IS A FILTER, NOT A REORDER. Every surviving row keeps its place, so
 * a caller may fold before or after ordering its beats without the two
 * rules interfering (`inDeliveryOrder` is the other one).
 */
import type { ConversationRow } from "./bundle.js";

/**
 * Everything the fold is decided from — one row, five fields, and every
 * one of them a question about the row's CLASS rather than about its text.
 * `opaqueKind` says the row is opaque (the store's own answer),
 * `opaqueOf` says which message it stands for, and `reactionTo` is what
 * tells a gesture from a message so that an empty `content` means "husk"
 * only where it can.
 */
export type OpaqueFoldBeat = Pick<
  ConversationRow,
  "chatJid" | "messageId" | "content" | "opaqueKind" | "opaqueOf" | "reactionTo"
>;

/**
 * Drops the row that lost, per (chat, message).
 *
 * The caller keeps its own row shape and says which part of it is the beat
 * (`beatOf`), so the seam window's beats and the bundle's conversation
 * rows share one rule without sharing a type — the same shape
 * `inDeliveryOrder` takes, and for the same reason.
 */
export function foldOpaqueDeliveries<T>(
  rows: readonly T[],
  beatOf: (row: T) => OpaqueFoldBeat,
): T[] {
  // Which messages have a row of each class. An opaque row that stands for
  // no message (the id-less `opaque:<hash>` shape) is keyed by nothing and
  // therefore folds with nothing, which is the honest answer: the rail told
  // us nothing that could identify what was delivered.
  const readable = new Set<string>();
  const opaque = new Set<string>();
  for (const row of rows) {
    const beat = beatOf(row);
    const message = messageOf(beat);
    if (message === undefined) continue;
    if (beat.opaqueKind !== undefined) opaque.add(message);
    else if (!isHusk(beat)) readable.add(message);
  }
  return rows.filter((row) => {
    const beat = beatOf(row);
    const message = messageOf(beat);
    if (message === undefined) return true;
    // Rule 1: what the twin can read wins.
    if (beat.opaqueKind !== undefined) return !readable.has(message);
    // Rule 2: the husk loses to an honest opaque row; anything the twin can
    // read loses to nothing.
    return !isHusk(beat) || !opaque.has(message);
  });
}

/**
 * The legacy shape ADR-0042 retired: a `'message'` row carrying no text,
 * which reads as somebody saying nothing. A GESTURE is never one, whatever
 * its `content` holds at this moment — see the header.
 */
function isHusk(beat: OpaqueFoldBeat): boolean {
  return beat.reactionTo === undefined && beat.content === "";
}

/**
 * The (chat, message) this beat is about — the fold's key. A readable row
 * is about itself; an opaque row is about the message its identity names.
 */
function messageOf(beat: OpaqueFoldBeat): string | undefined {
  if (beat.opaqueKind === undefined) return key(beat.chatJid, beat.messageId);
  return beat.opaqueOf === undefined
    ? undefined
    : key(beat.chatJid, beat.opaqueOf);
}

/**
 * Chat and message, as one string. Both halves matter — ADR-0042 states
 * the fold per (chat, stanza), and a WhatsApp message id is unique only
 * within its chat, which is why the seam's own identity carries the chat
 * too.
 *
 * LENGTH-PREFIXED rather than joined on a character no JID is supposed
 * to contain: the prefix makes the composition injective whatever the
 * rail puts in either half, so the key rests on arithmetic rather than
 * on an assumption about somebody else's alphabet.
 */
function key(chatJid: string, messageId: string): string {
  return `${chatJid.length}:${chatJid}${messageId}`;
}

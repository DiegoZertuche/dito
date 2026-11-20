/**
 * How a reaction READS (ticket #97; ADR-0041).
 *
 * A reaction crosses the seam as its own typed event carrying an emoji and
 * the id of the message it points at (see `@dito/seam`'s wa-payload
 * header). Neither half is prose, and both halves are meaningless alone: a
 * bare 👍 is somebody saying nothing, and a bare stanza id is a pointer the
 * model cannot follow. So wherever a conversation is rendered for the model
 * — the drafting transcript, retrieved Q&A memory, and the extraction
 * transcript when #98 widens its window — a reaction renders as ONE
 * gesture line naming the emoji and, inlined by deterministic read-back,
 * the words it points at.
 *
 * COMPOSED AT READ TIME, NOT FROZEN AT INGEST (Codex r1, promoted by
 * Diego). The store holds the DELIVERY — the target's id and the emoji —
 * and `renderGesturesForModel` composes the line against twin memory as it
 * stands the moment the model is about to be shown it. A gesture can
 * legitimately be consumed before the message it points at: a live 👍 on a
 * message this twin has not captured, an unordered history walk, a
 * live/backfill overlap. Rendering once at ingest would leave that gesture
 * bare for good, and no later ticket could repair it — the row is already
 * consumed. Rendering at read costs one indexed lookup per gesture in a
 * window of about twenty rows and is always current.
 *
 * The row's stored `content` is still the line as it read when the row was
 * stored, because that is what the vector indexes and the index must have
 * exactly one state to index (ADR-0007's "one bundle state, one index").
 * Best-effort there is the right trade: the target's own message carries
 * its own words into retrieval regardless.
 *
 * BRACKETED, AND NOT PROSE. The line sits in the `content` slot of a
 * conversation row, beside lines that are literally what somebody typed.
 * The rep did not SAY «reaccionó 👍»; they tapped an emoji. The brackets
 * are what keeps the two distinguishable to a reader — human or model —
 * that meets the line with no other context.
 *
 * NOTHING FOLDS HERE. A set, a change and a removal are three deliveries
 * and three lines, in order, because a retraction is a beat in the
 * conversation rather than a correction to an earlier one — «puso 👍 y
 * luego lo quitó» is a different story from «no reaccionó», and only the
 * model reading the transcript can tell which one matters (ADR-0041).
 *
 * AND NOTHING SORTS HERE (ticket #109). `renderGesturesForModel` is a MAP:
 * it takes whatever order it was handed, because its callers hand it two
 * different KINDS of order — the drafting transcript and the entity-kind
 * read pass a CHRONOLOGICAL slice of `readConversation`, while drafting's
 * retrieved block and the Q&A citation list pass hits ranked by vector
 * DISTANCE. Sorting here would silently re-rank search results by time.
 *
 * Every one of those four call sites is nonetheless covered, because the
 * same-second tie-break lives at each one's own source instead:
 * `readConversation` and the extraction window's seam read refine their
 * coarse `(occurred_at, id)` order, and the two retrieval paths deal
 * same-second gestures into their own relevance slots after their final
 * slice (`consumer.ts`, `answering.ts`). One rule, `inDeliveryOrder`,
 * applied where each order is actually produced — never here, where the
 * kind of order is unknown.
 *
 * AND NOTHING FOLDS DOWNSTREAM EITHER — this ticket guessed otherwise and
 * the guess was wrong (ticket #99). #97 named the aperture's agreement
 * evidence as the consumer that would need "the reaction that STANDS" and
 * would fold last-write per (reactor, target) by `sender_ts_ms`. #99 built
 * that consumer and built no fold: the aperture refuses a CITED removal,
 * because a retraction is not the gesture that agreed, and looks for no
 * LATER one, because whether an agreement still stands is the model's
 * reading of these beats. Determinism binds the evidence and the target,
 * never the intent (ADR-0003 as amended; ADR-0041 says it outright). The
 * fold key stays on the row for a consumer that genuinely needs current
 * state; none exists.
 */
import type { Bundle, ConversationRow } from "@dito/bundle";

/**
 * One conversation row as the MODEL should read it: an ordinary message
 * unchanged, a reaction re-composed against the target twin memory holds
 * right now. Every surface that puts a conversation in front of a model
 * goes through this — drafting context, retrieved Q&A memory, the
 * entity-kind read — so "the gesture appears at its target" is one rule in
 * one place rather than a habit each call site has to remember.
 */
export function renderGesturesForModel(
  bundle: TargetLookup,
  rows: readonly ConversationRow[],
): ConversationRow[] {
  return rows.map((row) => {
    if (row.reactionTo === undefined) return row;
    const target = bundle.readMessage(row.chatJid, row.reactionTo);
    return {
      ...row,
      content: renderReactionGesture({
        // Written together with `reactionTo` and never null beside it; the
        // fallback is the removal, which is the fail-safe reading.
        emoji: row.reactionEmoji ?? "",
        // AN EMPTY TARGET IS NO TARGET (ticket #124, Codex r1). The two
        // seam-side read-backs — extraction's and the aperture's — have
        // always answered `undefined` for a row with no text, and this one
        // quoted «» instead. Nobody noticed while the only empty row was a
        // media husk that read as empty everywhere; now that the same
        // message can ALSO stand in the transcript as «[foto]» (ADR-0042's
        // fold), a gesture quoting «» beside it is two readers of one
        // message disagreeing in front of the model. Bare is the honest
        // answer, and it is the one the other two already give.
        target: target?.content === "" ? undefined : target?.content,
      }),
    };
  });
}

/** The one bundle read this module needs: the target, by its rail id. */
type TargetLookup = Pick<Bundle, "readMessage">;

/**
 * The es-MX gesture line for one reaction delivery — ONE wording, for
 * every surface that shows a model a reaction.
 *
 * The surfaces differ in how they NAME the target, and in nothing else.
 * Twin memory's readers (drafting context, retrieved Q&A memory, the
 * entity-kind read) show a conversation whose rows carry no ids, so a
 * gesture there quotes the words and nothing else. The EXTRACTION
 * transcript is cited BY ID — every line carries one, and a candidate fact
 * names the message it was read in — so a gesture there names its target's
 * id too, and inlines the words only when that id belongs to no line the
 * model was shown (ticket #98; ADR-0041).
 */
export function renderReactionGesture(args: {
  /** The emoji placed; the EMPTY STRING is the rail's removal. */
  readonly emoji: string;
  /**
   * The target's rail id, for a reader that cites by id. Omitted by the
   * readers whose rows are unnumbered.
   */
  readonly targetId?: string;
  /**
   * The target's own words, when the reader could resolve the message it
   * points at. Undefined is the honest answer for a gesture at something
   * that never crossed — a message from before the QR code, an
   * out-of-scope chat's — and nothing is invented for it.
   */
  readonly target: string | undefined;
}): string {
  const gesture =
    args.emoji === "" ? "reacción retirada" : `reacción ${args.emoji}`;
  if (args.targetId === undefined && args.target === undefined) {
    return `[${gesture}]`;
  }
  // es-MX takes «de» after «retirada» and «a» after «reacción»; one line
  // rather than two templates, because the two differ by this word alone.
  const preposition = args.emoji === "" ? "de" : "a";
  const at = args.targetId === undefined ? "" : ` ${args.targetId}`;
  const words = args.target === undefined ? "" : `: «${oneLine(args.target)}»`;
  return `[${gesture} ${preposition}${at}${words}]`;
}

/**
 * The inlined target, flattened to one line. A transcript line is one
 * line — that is what lets a reader tell where one speaker's turn ends —
 * and a multi-line message quoted inside a gesture would break the shape
 * of every block it appears in.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

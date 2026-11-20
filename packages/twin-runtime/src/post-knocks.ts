/**
 * EVERY KNOCK: THE ROW THE TWIN THREAD'S KNOCK TOOL WRITES ABOUT A POST THAT
 * WAITS (tickets #320, #358; spec #318 decisions 19 and 21; design D4, D5 and
 * §3.4; ADR-0031 as amended).
 *
 * A card lands with no knock; the thread's turn — the one that wrote the card,
 * or the one its landing woke — decides from what the day holds whether the
 * rep's phone hears of it. `posts` is immutable by trigger, so what the turn
 * decides is a row of its own (`post_knocks`, …20261004100010), the one store
 * every reader of a post's parts joins (`feed.ts`) and the at-once tier
 * delivers (`notify-tiers.ts`).
 *
 * THE FLOORS THAT LIVE HERE ARE THE STORE'S. One landing knock per post,
 * and one more for each reminder that fired for it (ticket #364; ADR-0031 as
 * amended 2026-10-07): a knock the thread adds after a card's reminder fired
 * is that reminder's, read off the clock store, and a card that already had
 * its landing knock and no reminder owing one is refused
 * (`post_knocks_one_per_reminder`, floor (a)); the
 * sentence passes the one fence every knock passes (`acceptsKnock`). Nothing
 * here decides whether a knock is warranted: that is the twin's call in its turn
 * (agentic first, 2026-09-29), and the two other floors — the focused
 * Inicio tab and the quiet hours on reminders — stay where they are.
 */
import type { Bundle } from "@dito/bundle";
import type pg from "pg";
import { stillWaits, waitingCandidates } from "./canvas.js";
import type { HeldDraft } from "./drafts.js";
import { readPostsByIds, type FeedDeps, type FeedPost } from "./feed.js";
import { acceptsKnock } from "./posts.js";
import { renderNames, spellReference } from "./thread/references.js";

/** Why a knock was not added, in words the model can act on. */
export type KnockRefusal =
  | "unknown_post"
  | "not_a_hand_off"
  | "no_longer_waits"
  | "already_knocked"
  | "names_another"
  | "sentence_refused";

/** What one call to add a knock came to. */
export type KnockOutcome =
  | { readonly knocked: true }
  | { readonly knocked: false; readonly refusal: KnockRefusal };

/**
 * The post's own words a knock's figures are checked against — the draft's
 * body and the name it is for, a question's prose and the names it offers.
 *
 * The draft's body and its counterparty are both the post's own words — the
 * name reaches the card from the rail or from a confirmed binding, never from
 * the model — so a knock naming a «Farmacia 24» grounds its figure.
 */
export function announcedTextOf(post: FeedPost): string {
  const said: string[] = [];
  for (const part of post.parts) {
    if (part.kind === "prose") said.push(renderNames(part.text, part.mentions ?? []));
    if (part.kind === "draft") said.push(draftAnnounced(part.body, part.counterparty));
    if (part.kind === "question") {
      if (part.proposedName !== undefined) said.push(part.proposedName);
      if (part.chatName !== undefined) said.push(part.chatName);
    }
    if (part.kind === "ask") {
      said.push(renderNames(part.question, part.mentions ?? []));
      for (const field of part.fields) said.push(...(field.options ?? []).map((option) => option.label));
    }
  }
  return said.join("\n");
}

/** A draft's own words a knock is checked against: its body and the name it is for. */
function draftAnnounced(body: string, counterparty: string): string {
  return `${body}\n${counterparty}`;
}

/**
 * Whether a post is a hand-off a knock may announce (CONTEXT.md *Hand-off*):
 * a draft waiting on the rep's tap, a question waiting on their answer — a
 * binding question or a run's question card (ticket #324) — or the day's
 * notes while their correction window is open (ticket #364).
 */
export function isHandOff(post: FeedPost): boolean {
  return post.parts.some(
    (part) => part.kind === "draft" || part.kind === "question" || part.kind === "ask" || part.kind === "record-lines",
  );
}

/**
 * Adds the knock, inside the caller's open transaction — or says why not.
 *
 * A REFUSED SENTENCE COSTS THE KNOCK AND NEVER THE TURN: every refusal is a
 * value the caller hands the model, and nothing here throws on the model's
 * account. A second knock racing this one in another transaction is the
 * primary key's, and it arrives as the constraint error the caller's
 * savepoint takes.
 */
export async function addKnock(
  deps: FeedDeps & { readonly executionId: string },
  knock: {
    readonly postId: string;
    readonly sentence: string;
    /**
     * The customers the sentence names, by reference (ticket #321). Each must
     * be the customer THIS card is about: a lock screen naming another
     * card's customer is the wrong person told about the right draft.
     */
    readonly customers: readonly string[];
  },
  now: Date,
): Promise<KnockOutcome> {
  const post = (await readPostsByIds(deps, [knock.postId], now)).get(knock.postId);
  if (post === undefined) return { knocked: false, refusal: "unknown_post" };
  if (!isHandOff(post)) return { knocked: false, refusal: "not_a_hand_off" };
  // A CARD THAT HAS SETTLED IS NOT NEWS: a sent or discarded draft and an
  // answered question announce work that is already gone — the canvas's own
  // reading of what waits.
  if (!(await waitingCandidates(deps, now)).includes(post.id) || !stillWaits(post)) {
    return { knocked: false, refusal: "no_longer_waits" };
  }
  // THE KNOCK A FIRED REMINDER IS OWED, when the card has one (ticket #364):
  // otherwise the card's one landing knock.
  const reminder = await reminderOwingAKnock(deps.db, deps.twinId, knock.postId);
  const knocked = reminder === undefined && (await alreadyKnocked(deps.db, deps.twinId, knock.postId));
  const refusal = refusalOnCard(
    { ...(post.customer === undefined ? {} : { customer: post.customer }), announced: announcedTextOf(post), knocked },
    knock,
  );
  if (refusal !== undefined) return { knocked: false, refusal };
  await deps.db.query(
    `INSERT INTO post_knocks (post_id, twin_id, text_enc, execution_id, subject)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      knock.postId,
      deps.twinId,
      deps.dek.encrypt(Buffer.from(knock.sentence, "utf8")),
      deps.executionId,
      reminder ?? null,
    ],
  );
  return { knocked: true };
}

/**
 * WHETHER A KNOCK MAY BE HELD ON THE POST A HELD DRAFT LANDS UNDER (ticket
 * #358) — or why not. The thread's `create_draft` holds its draft until the
 * turn's words exist and names the post's id to the twin, which knocks on it
 * in the same turn: the floors are the ones `addKnock` reads off a landed card,
 * read here off the held one. It is a hand-off that waits — a draft nobody has
 * tapped — so what remains is its one landing knock, the customer it is about
 * (read as the feed reads a draft's) and its own words; `landDraft` writes the
 * knock through `addKnock` once the post exists.
 */
export function refusalOnHeldDraft(
  held: HeldDraft,
  bundle: Bundle,
  knock: { readonly sentence: string; readonly customers: readonly string[] },
): KnockRefusal | undefined {
  return refusalOnCard(
    {
      customer: spellReference(bundle.referenceForChat(held.destination)),
      announced: draftAnnounced(held.body, held.counterparty),
      knocked: held.knock !== undefined,
    },
    knock,
  );
}

/**
 * The floors read off the card itself: its one landing knock, the customer it
 * is about and its own words.
 */
function refusalOnCard(
  card: { readonly customer?: string; readonly announced: string; readonly knocked: boolean },
  knock: { readonly sentence: string; readonly customers: readonly string[] },
): KnockRefusal | undefined {
  if (card.knocked) return "already_knocked";
  if (knock.customers.some((customer) => customer !== card.customer)) return "names_another";
  if (!acceptsKnock(knock.sentence, card.announced)) return "sentence_refused";
  return undefined;
}

/**
 * The subject of the card's latest fired reminder that has no knock of its
 * own yet — or nothing, when no reminder of this card owes one.
 */
async function reminderOwingAKnock(
  db: pg.ClientBase,
  twinId: string,
  postId: string,
): Promise<string | undefined> {
  const res = await db.query<{ subject: string }>(
    `SELECT s.subject
       FROM schedules s
      WHERE s.twin_id = $1 AND s.post_id = $2 AND s.fired_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM post_knocks k
                         WHERE k.post_id = s.post_id AND k.subject = s.subject)
      ORDER BY s.fired_at DESC, s.id
      LIMIT 1`,
    [twinId, postId],
  );
  return res.rows[0]?.subject;
}

/** Whether the post already had its landing knock. */
async function alreadyKnocked(
  db: pg.ClientBase,
  twinId: string,
  postId: string,
): Promise<boolean> {
  const res = await db.query(
    "SELECT 1 FROM post_knocks WHERE twin_id = $1 AND post_id = $2 AND subject IS NULL",
    [twinId, postId],
  );
  return res.rows.length > 0;
}

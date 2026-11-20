/**
 * THE FEED READ MODEL (ticket #220; spec #214's *The feed, in detail* and
 * *The runtime's local API, in detail*; ADR-0010).
 *
 * One twin's posts, newest first, cursor-paged, with their parts OPENED: the
 * read the dashboard's Inicio is (#224) and the local API serves (#221). It
 * lives in the runtime because the runtime is the lease holder and therefore
 * the only process that may unseal a part — "dashboards are clients of that
 * service's authenticated API" (ADR-0010), never store readers.
 *
 * WHAT «OPENED» MEANS. A part that carries its own content is decrypted; a
 * part that carries a REFERENCE is followed to the row it names, so the
 * draft's body is `drafts.content_enc` and the day's numbered lines are the
 * rows ADR-0034's seal holds — the one numbering the rep read, never
 * re-derived. Each opened part also names the answer ACTS its surface may
 * offer, so a card is drawn from the part rather than from a switch over
 * post kinds.
 *
 * NO DELIVERY STATE, DELIBERATELY. The dashboard must stand with the rail
 * down (spec #214 story 8), so this read joins nothing about whether the
 * plane ever posted a post. "Did it arrive" is a question about delivery and
 * is asked where delivery is known — against `send_commands.outcome`, the way
 * `readPendingLines` asks it. It is also why nothing here joins
 * `send_executions` to `send_commands`: that join is the twin-post
 * registry's one join and stays there (`twin-posts.test.ts` sweeps for it).
 *
 * ONE TWIN, IN THE WHERE CLAUSE. Every row of this table belongs to some
 * twin and they share one database, so the twin is a predicate on the query
 * rather than a filter afterwards — and the cursor carries no twin at all, so
 * a page of somebody else's feed cannot be asked for by holding a cursor.
 */
import { CORRECTION_WINDOW_HOURS } from "@dito/aperture";
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type {
  Door,
  TwinFeedMention,
  TwinFeedPage,
  TwinFeedPart,
  TwinFeedPost,
} from "@dito/seam";
import type pg from "pg";
import {
  bindingQuestionState,
  chatOfBindingQuestion,
} from "./binding-question.js";
import { counterpartyName, renderDisclosureProvenance } from "./grammar.js";
import {
  answerActsOf,
  clearable,
  openKnock,
  openSealedParts,
  reexpressedParts,
  type DraftPart,
  type Mention,
  type PostAnswerAct,
  type PostOrigin,
  type PostPart,
  type ProsePart,
  type QuestionAnswer,
  type AskPart,
  type ProposalPart,
  type QuestionPart,
  type RecordLinesPart,
  type ReceiptPart,
  type CurationPart,
  type DataPart,
  type DocumentPart,
} from "./posts.js";
import { keepMarksOn, spellReference } from "./thread/references.js";

/** What the read needs: the seam, the twin, and the key that opens its parts. */
export interface FeedDeps {
  /** A connection to ask on — borrowed or the runtime's own (`lanes.ts`). */
  readonly db: pg.ClientBase;
  readonly twinId: string;
  readonly dek: Dek;
  /** The rep's own clock, for the record lines' «hoy»/«ayer» clause. */
  readonly timeZone?: string;
  /**
   * THE ENTITY MIRROR, for the one thing this read cannot answer from the seam
   * (ticket #255; boundary #225, F34): whether a binding question's chat is
   * bound. It is the authority BOTH surfaces write through, so a card
   * confirmed in the thread settles on the dashboard and the other way round.
   *
   * OPTIONAL, because a runtime can serve the reads with no bundle open
   * (`LocalApiDeps.acts`) — and one that has no bundle serves no acts either,
   * so a question it cannot read a binding for goes on offering its buttons to
   * a surface whose presses it would refuse anyway. A DECLINE still reads,
   * there and everywhere: its authority is an act row on the seam.
   */
  readonly bundle?: Bundle;
}

/** Which page to read, and what «hoy» means while it is rendered. */
export interface FeedRead {
  /**
   * THE INSTANT THE REP IS READING AT, explicit (the `reconcileFr70At` shape
   * — time is a parameter, never a clock read inside a package).
   *
   * A record line's provenance clause is RELATIVE — «hoy 10:20», «ayer
   * 18:53», «29 ago 10:20» — so it is a sentence about the reader's own day
   * rather than about the post's. A card opened three days after the post was
   * written must not still say «hoy», and a caller replaying a post's own
   * composition instant gets back exactly the clause the thread printed.
   */
  readonly now: Date;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * A MENTION AS A SURFACE READS IT (ticket #321): what the post sealed. The
 * card a name opens is the twin's, in the prose itself (`linkToCanvas`).
 */
export type OpenedMention = Mention;

/** Every part, opened, with the acts a surface may offer on it. */
export interface OpenedProsePart extends Omit<ProsePart, "mentions"> {
  readonly acts: readonly PostAnswerAct[];
  readonly mentions?: readonly OpenedMention[];
}

export interface OpenedDraftPart extends DraftPart {
  readonly acts: readonly PostAnswerAct[];
  /**
   * Who the draft is for, as the rep reads it — ALWAYS THERE (ticket #298).
   *
   * The name the post recorded when it recorded one: the confirmed binding,
   * or the rail name marked «(sin confirmar)». A post re-expressed from
   * before parts existed recorded none, and is named here by the same rule
   * against the entity mirror as it stands now (`unrecordedCounterparty`), so
   * no surface is left to name a send card from its routing address.
   */
  readonly counterparty: string;
  /**
   * The message body a tap would release — `drafts.content_enc`, opened
   * here (ADR-0006). Absent for a draft row the feed cannot find, which is
   * a broken reference rather than an empty draft.
   */
  readonly body: string;
}

/** One numbered line of the day's record, as the post printed it. */
export interface OpenedRecordLine {
  readonly index: number;
  /** The claim, exactly as the aperture stored it (ADR-0034: never re-rendered). */
  readonly text: string;
  /** The provenance clause — «su chat, ayer 18:53» — off the one renderer. */
  readonly provenance: string;
  /** What a retraction of this line acts on (#54). */
  readonly disclosureLineId: string;
  /**
   * The customer the post printed this line under, from the part's own sealed
   * grouping — so a claim the rep may retract is attributed to the name they
   * READ (`RecordLineGroup` argues why it is not resolved later). Absent on a
   * post re-expressed from before parts existed.
   */
  readonly counterparty?: string;
  /**
   * ...and the customer the line was FILED against, which is always there
   * (`disclosure_lines.entity_id`, NOT NULL for both subject kinds).
   *
   * IT IS THE IDENTITY BESIDE THE NAME (Codex r2): a re-expressed post
   * recorded no heading, and a retractable claim the rep cannot attribute is
   * one they cannot judge. The NAME for it is the API's to resolve from the
   * entity mirror (ADR-0004).
   */
  readonly entityId: string;
  /**
   * Whether a **Retirar** on this line would do anything (ticket #224; FR-33,
   * ADR-0004).
   *
   * THREE THINGS, AND ALL THREE ARE READ REP-SIDE. The line has to disclose a
   * FACT — the first line every rep reads is an entity create, and no verb
   * undoes a binding (`RetractionRefusal.not_a_fact`); nobody may have
   * retracted it already, which is `fact_retractions`; and the correction
   * window has to be open, which is the part's own `windowClosesAt` compared
   * to the read's `now`.
   *
   * THE LEDGER IS NOT ASKED, and that is a wall boundary rather than an
   * approximation somebody settled for. Whether a fact has finalized or been
   * retracted is company-side state, and `dito_twin_runtime` holds no
   * privilege in that schema at all (FR-71a; `sole-writer.test.ts` sweeps this
   * package for a mention of one) — the runtime is on the rep side of
   * ADR-0002's wall. So the window is computed under finalization's own RULE
   * from `send_commands`, which is rep-side, and the retraction is read from
   * the aperture's rep-side evidence row.
   *
   * WHICH LEAVES ONE HONEST DIVERGENCE, recorded rather than hidden. The
   * aperture refuses a retraction only when the fact has actually FINALIZED
   * (`retraction.ts`: "the window is finalization, not a clock read here"), so
   * a finalization pass that has not run leaves a late retraction acceptable
   * while this says the window shut. The card then offers less than the act
   * would allow, which is the direction that cannot mislead: a rep is never
   * shown a button whose refusal they would have to be told about, and the
   * refusal path exists anyway for the post redelivered into a second card.
   */
  readonly retractable: boolean;
  /**
   * ...AND WHETHER SOMEBODY ALREADY RETRACTED IT, which is a different fact
   * and has to be (the two-axis review's Spec axis).
   *
   * `retractable` IS FALSE FOR THREE REASONS and a surface that read it as
   * «retracted» would tell the rep their record was corrected when it was
   * not: an entity-create line is not a fact and no verb undoes a binding, and
   * every line stops being retractable once the window shuts. Only this says
   * a correction really happened.
   */
  readonly retracted: boolean;
  /**
   * WHAT THE REP SAID THE LINE SHOULD READ, when they corrected it on the card
   * (ticket #344): their own words, kept by the aperture beside the
   * annotation and opened here under the twin key. The claim in `text` stays
   * exactly as stored — a correction annotates, never rewrites (ADR-0034).
   */
  readonly corrected?: string;
}

export interface OpenedRecordLinesPart extends RecordLinesPart {
  readonly acts: readonly PostAnswerAct[];
  readonly lines: readonly OpenedRecordLine[];
  /**
   * WHEN THIS RECORD'S CORRECTION WINDOW CLOSES (ticket #224; ADR-0004;
   * `finalization.ts`).
   *
   * ADR-0004 is exact that the clock starts "only once the fact's disclosure
   * line is rep-reachable", and `finalizeDueFacts` reads that as
   * `min(send_commands.executed_at)` over the sends of the post that carried
   * the line, `outcome = 'sent'` and nothing else, plus
   * `CORRECTION_WINDOW_HOURS`. This is the same join over the same rows, so
   * the sentence the card prints and the instant the clock will actually use
   * are one computation rather than two that agree today.
   *
   * IT IS COMPUTED HERE AND NEVER ON THE DASHBOARD. rep-web holds no reach at
   * all into `disclosure_posts` or `disclosure_post_lines` (ADR-0010), and a
   * window derived on a surface from rows it could not see would be a second
   * answer to when a fact goes firm.
   *
   * ABSENT MEANS THE WINDOW HAS NOT OPENED — no send of this post has resolved
   * `sent`, so the rep was never reached ON THE RAIL and `finalizeDueFacts`
   * will finalize nothing. They are reading it on the dashboard instead, which
   * is exactly the case spec #214 story 8 exists for: the lines are
   * retractable, and there is no closing instant to print because none has
   * been decided.
   */
  readonly windowClosesAt?: Date;
}

/**
 * A QUESTION, WITH WHAT THE REP ANSWERED AND WHICH CHAT IT IS ABOUT (ticket
 * #255; boundary #225, F34 and F35).
 *
 * ═══ THE ANSWER, AND WHERE IT IS READ FROM
 *
 * On the rig the card went on offering «Sí, es este cliente» and «Es otro
 * cliente» under a question the rep had answered five minutes earlier, while
 * the twin's receipt sat two cards below as a post of its own.
 *
 * `confirmed` IS THE STANDING BINDING FOR THE QUESTION'S CHAT, which is the
 * one authority both surfaces already share: «va» in the thread and the card's
 * own button both land in the entity mirror, and a repeat yes reads back the
 * binding that stands (`confirmBinding`'s own rule). Anything narrower — this
 * post's act row — would leave a card the rep answered on their phone still
 * asking on their laptop.
 *
 * `declined` IS THE ACT ROW NAMING THIS POST, because a decline WRITES NOTHING
 * (`declineBinding` argues why: an unconfirmed binding is the chat staying
 * provisional, which is what an unanswered question already means). So the
 * only record of one is the act, and the thread's decline leaves a
 * `matcher_dispositions` marker on the rep's own MESSAGE rather than anything
 * naming the question — a card declined in the thread therefore stays open,
 * and is recorded on the ticket rather than given a table of its own.
 *
 * CONFIRMED IS ASKED FIRST, which is what makes the pair total: a decline that
 * arrives after the rep already confirmed is refused and undoes nothing, so a
 * chat with a binding reads `confirmed` however many acts sit beside it.
 *
 * ═══ AND THE CHAT, WHICH IS WHAT THE QUESTION IS ACTUALLY ABOUT
 *
 * The label «Ligar chat con cliente» and the name under it name the PROPOSED
 * customer and not the conversation, so the rep could not tell which chat they
 * were binding (F35). Both facts come from the question's own anchor — the
 * customer-chat event whose sealed payload names the chat, the same column the
 * confirmation re-derives from — and the name from the directory row keyed on
 * it, opened here because rep-web holds no key.
 */
export interface OpenedQuestionPart extends QuestionPart {
  readonly acts: readonly PostAnswerAct[];
  /** What the rep answered on either surface, absent while it is open. */
  readonly answer?: QuestionAnswer;
  /** The chat's number as a rep reads it, absent for a LID-addressed chat. */
  readonly chatNumber?: string;
  /** ...and what their phone calls it, where the directory holds a name. */
  readonly chatName?: string;
}

/**
 * A RUN'S QUESTION CARD, OPENED (ticket #324): its parts as sealed, and
 * `answer` among its acts exactly while a step of a run still waits on it —
 * read off the step's checkpoint, so a card answered on either surface, or
 * whose run has ended, offers nothing. The answer itself is the run's sealed
 * content and is never read here.
 */
export interface OpenedAskPart extends Omit<AskPart, "mentions"> {
  readonly acts: readonly PostAnswerAct[];
  readonly mentions?: readonly OpenedMention[];
}

/**
 * A RUTINA THE TWIN PROPOSES, OPENED (ticket #386): its parts as sealed, and
 * `activate` and `discard` among its acts exactly while the rutina it names
 * is pending and live — read off the rutina's own row, so a card accepted or
 * discarded on either surface offers nothing.
 */
export interface OpenedProposalPart extends Omit<ProposalPart, "mentions"> {
  readonly acts: readonly PostAnswerAct[];
  readonly mentions?: readonly OpenedMention[];
}

export interface OpenedReceiptPart extends ReceiptPart {
  readonly acts: readonly PostAnswerAct[];
}

/**
 * THE KNOCK THE THREAD WROTE ABOUT THIS POST (tickets #320, #358): its
 * landing knock's sentence, off the one store (`post_knocks`), opened beside
 * the parts — read by `read_post` and by the permission ask on the canvas,
 * which shows the rep the thing a push carries (ADR-0031 as amended).
 */
export interface OpenedKnockPart {
  readonly kind: "knock";
  readonly text: string;
  readonly acts: readonly PostAnswerAct[];
}

/** The arrival post's layout, opened: post ids, and no acts of its own (#266). */
export interface OpenedCurationPart extends CurationPart {
  readonly acts: readonly PostAnswerAct[];
}

/** A workspace document by its version, opened: no acts — opening it is a read (#326). */
export interface OpenedDocumentPart extends DocumentPart {
  readonly acts: readonly PostAnswerAct[];
}

/** A list, opened: each row's mentions linked as a prose part's are (#326). */
export interface OpenedDataPart extends Omit<DataPart, "rows"> {
  readonly rows: readonly { readonly text: string; readonly mentions?: readonly OpenedMention[] }[];
  readonly acts: readonly PostAnswerAct[];
}

export type OpenedPart =
  | OpenedProsePart
  | OpenedDraftPart
  | OpenedRecordLinesPart
  | OpenedQuestionPart
  | OpenedAskPart
  | OpenedProposalPart
  | OpenedReceiptPart
  | OpenedKnockPart
  | OpenedCurationPart
  | OpenedDocumentPart
  | OpenedDataPart;

/** One post, as a surface reads it. */
export interface FeedPost {
  readonly id: string;
  /** When the twin composed it — the order the rep's Inicio reads. */
  readonly at: Date;
  /** The execution that composed it, or `null` where code did (`posts.ts`). */
  readonly executionId: string | null;
  readonly origin: PostOrigin;
  /**
   * WHICH DOOR ASKED FOR IT — absent on a proactive post (ticket #261;
   * ADR-0044 as amended).
   *
   * Carried rather than decided here: what a surface does with it is the
   * surface's, and Inicio's rule — render an answer only at the door it was
   * asked through — is the page's to apply. It comes off the post's own
   * column, so this read never joins `executions` to learn it.
   */
  readonly askedOn?: Door;
  readonly parts: readonly OpenedPart[];
  /**
   * THE CUSTOMER A HAND-OFF IS ABOUT, by their reference (ticket #321): the
   * chat a draft goes to, or the chat a binding question asks about. It is
   * what a mention in a twin's answer is matched to, so a name the rep reads
   * can lead to the card that waits on them. Absent on a post about nobody.
   */
  readonly customer?: string;
}

export interface FeedPage {
  readonly posts: readonly FeedPost[];
  /** Pass it back as `cursor` for the next page; absent at the end. */
  readonly nextCursor?: string;
}

/**
 * How many posts a page holds when the caller does not say. Twenty is a
 * screenful of cards and a bounded amount of unsealing per request; the
 * caller may ask for fewer or more up to the cap below.
 */
const DEFAULT_LIMIT = 20;

/**
 * ...and the cap, which is a REFUSAL rather than a clamp. A caller asking for
 * ten thousand posts is asking the lease holder to unseal ten thousand
 * payloads inside one request, and silently giving them a hundred would look
 * to them like a feed that ends.
 */
const MAX_LIMIT = 200;

export async function readFeed(
  deps: FeedDeps,
  page: FeedRead,
): Promise<FeedPage> {
  const limit = page.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(
      `a feed page of ${String(limit)} is not one this read serves — between 1 and ${String(MAX_LIMIT)} posts, because every part on a page is unsealed inside the request (ticket #220)`,
    );
  }
  const after = page.cursor === undefined ? undefined : parseCursor(page.cursor);
  // ONE STATEMENT PER PAGE for the posts and their delivery rows, then one
  // per record-lines part (`POST_SELECT` argues the joins).
  const res = await deps.db.query<PostRow>(
    `${POST_SELECT}
      WHERE p.twin_id = $1
        AND ($2::timestamptz IS NULL
             OR (p.posted_at, p.id) < ($2::timestamptz, $3::uuid))
      ORDER BY p.posted_at DESC, p.id DESC
      LIMIT $4`,
    [deps.twinId, after?.postedAt ?? null, after?.id ?? null, limit + 1],
  );
  // ONE MORE THAN ASKED FOR is how the end of the feed is known without a
  // second count: a page that came back full has a next one, and the extra
  // row is dropped rather than shown.
  const rows = res.rows.slice(0, limit);
  const posts: FeedPost[] = [];
  for (const row of rows) posts.push(await feedPostOf(deps, row, page.now));
  const last = rows[rows.length - 1];
  return {
    posts,
    ...(res.rows.length > limit && last !== undefined
      ? { nextCursor: cursorFor(last) }
      : {}),
  };
}

/**
 * A POST'S MARKED WORDS OPEN THE CARDS THE TWIN MARKED THEM WITH (tickets
 * #321, #401; Diego, 2026-10-13: which card words open is the twin's, never
 * code's). The twin writes `[words](<post id>)`; the wire keeps the mark while
 * `onCanvas` holds its card — what Inicio shows at this read — and drops it
 * otherwise, so the words draw plain (`keepMarksOn`). Resolved at every read,
 * never stored; a caller that does not know the canvas passes nothing, and
 * every word is plain.
 */
const NO_CARDS: ReadonlySet<string> = new Set();

/**
 * THE READ MODEL, PROJECTED ONTO THE WIRE (ticket #224; `TwinFeedPage` in
 * `@dito/seam` argues why the two are two types).
 *
 * ONE FUNCTION AND NOT A `JSON.stringify` AT THE HANDLER, because exactly one
 * thing has to change and it must change everywhere it occurs: an instant
 * becomes an ISO string. `JSON.stringify` would do that on its own — `Date`
 * serializes to ISO — and that is precisely the trap: it would do it silently,
 * so the wire's type would be a claim nothing checks and a `Date` added to a
 * part next year would arrive as a string that TypeScript still called a
 * `Date` on the far side. Naming every field is what makes
 * `feed-wire.test.ts`' pin possible.
 *
 * IT ADDS AND DROPS NOTHING ELSE. Every name is the read model's, so a part
 * the runtime opened and a part the dashboard renders are the same object with
 * one field type changed.
 */
export function feedPageOnTheWire(page: FeedPage, onCanvas: ReadonlySet<string> = NO_CARDS): TwinFeedPage {
  return {
    posts: page.posts.map((post) => feedPostOnTheWire(post, onCanvas)),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

/**
 * ...and ONE post, which the exchanges read needs on its own (ticket #261).
 *
 * SPLIT OUT RATHER THAN COPIED. A reply under the door's composer is a post
 * like any other — the same parts, the same instants, the same rule that a
 * `Date` does not survive JSON — so the two reads project through one
 * function, and `feed-wire.test.ts`' field-by-name pin covers both.
 */
export function feedPostOnTheWire(post: FeedPost, onCanvas: ReadonlySet<string> = NO_CARDS): TwinFeedPost {
  return {
    id: post.id,
    at: post.at.toISOString(),
    executionId: post.executionId,
    origin: post.origin,
    ...(post.askedOn === undefined ? {} : { askedOn: post.askedOn }),
    parts: post.parts.map((part) => partOnTheWire(part, onCanvas)),
    ...(post.customer === undefined ? {} : { customer: post.customer }),
  };
}

/**
 * A mention as rep-web receives it: the reference, the name and the tails.
 * The entity id stays with the runtime — rep-web matches by
 * reference and holds no entity.
 */
export function mentionOnTheWire(mention: OpenedMention): TwinFeedMention {
  return {
    reference: mention.reference,
    name: mention.name,
    ...(mention.tails === undefined ? {} : { tails: mention.tails }),
  };
}

function partOnTheWire(part: OpenedPart, onCanvas: ReadonlySet<string>): TwinFeedPart {
  switch (part.kind) {
    case "prose":
      return {
        kind: "prose",
        text: keepMarksOn(part.text, onCanvas),
        acts: part.acts,
        ...(part.mentions === undefined
          ? {}
          : { mentions: part.mentions.map(mentionOnTheWire) }),
      };
    case "draft":
      return {
        kind: "draft",
        draftId: part.draftId,
        counterparty: part.counterparty,
        ...(part.tail === undefined ? {} : { tail: part.tail }),
        body: part.body,
        ...(part.blanks === undefined ? {} : { blanks: part.blanks }),
        ...(part.filled === undefined ? {} : { filled: part.filled }),
        ...(part.reason === undefined ? {} : { delicate: true, reason: part.reason }),
        acts: part.acts,
      };
    case "record-lines":
      return {
        kind: "record-lines",
        disclosurePostId: part.disclosurePostId,
        ...(part.groups === undefined ? {} : { groups: part.groups }),
        lines: part.lines.map((line) => ({
          index: line.index,
          text: line.text,
          provenance: line.provenance,
          disclosureLineId: line.disclosureLineId,
          ...(line.counterparty === undefined
            ? {}
            : { counterparty: line.counterparty }),
          entityId: line.entityId,
          retractable: line.retractable,
          retracted: line.retracted,
          ...(line.corrected === undefined ? {} : { corrected: line.corrected }),
        })),
        ...(part.windowClosesAt === undefined
          ? {}
          : { windowClosesAt: part.windowClosesAt.toISOString() }),
        acts: part.acts,
      };
    case "question":
      return {
        kind: "question",
        subject: part.subject,
        aboutEventId: part.aboutEventId,
        ...(part.proposedName === undefined
          ? {}
          : { proposedName: part.proposedName }),
        ...(part.answer === undefined ? {} : { answer: part.answer }),
        ...(part.chatNumber === undefined
          ? {}
          : { chatNumber: part.chatNumber }),
        ...(part.chatName === undefined ? {} : { chatName: part.chatName }),
        acts: part.acts,
      };
    case "ask":
      return {
        kind: "ask",
        question: keepMarksOn(part.question, onCanvas),
        ...(part.mentions === undefined ? {} : { mentions: part.mentions.map(mentionOnTheWire) }),
        fields: part.fields.map((field) => ({
          name: field.name,
          kind: field.kind,
          ...(field.label === undefined ? {} : { label: field.label }),
          ...(field.options === undefined
            ? {}
            : { options: field.options.map((option) => ({ value: option.value, label: option.label })) }),
        })),
        acts: part.acts,
      };
    // THE PROPOSAL CROSSES AS ITS WORDS AND THE RUTINA'S ID (ticket #386): the
    // card's two acts name the rutina, and never the definition.
    case "proposal":
      return {
        kind: "proposal",
        automationId: part.automationId,
        name: part.name,
        sentence: keepMarksOn(part.sentence, onCanvas),
        ...(part.mentions === undefined ? {} : { mentions: part.mentions.map(mentionOnTheWire) }),
        when: part.when,
        plan: part.plan.map((line) => ({ text: line.text, depth: line.depth })),
        replaces: part.replaces,
        acts: part.acts,
      };
    case "receipt":
      return { kind: "receipt", text: part.text, acts: part.acts };
    case "knock":
      return { kind: "knock", text: part.text, acts: part.acts };
    case "curation":
      return {
        kind: "curation",
        ...(part.spotlight === undefined ? {} : { spotlight: part.spotlight }),
        order: part.order,
        acts: part.acts,
      };
    // THE DOCUMENT CROSSES AS ITS VERSION'S ID, ITS TITLE AND ITS NUMBER
    // (ticket #326): never its path inside the workspace and never its text,
    // which the card asks the runtime for by that id.
    case "document":
      return { kind: "document", documentId: part.versionId, title: part.title, version: part.version, acts: part.acts };
    case "data":
      return {
        kind: "data",
        rows: part.rows.map((row) => ({
          text: keepMarksOn(row.text, onCanvas),
          ...(row.mentions === undefined ? {} : { mentions: row.mentions.map(mentionOnTheWire) }),
        })),
        acts: part.acts,
      };
  }
}

interface PostRow {
  id: string;
  posted_at: Date;
  posted_at_text: string;
  execution_id: string | null;
  origin: PostOrigin;
  asked_on: Door | null;
  asked_message_id: string | null;
  parts_enc: Buffer | null;
  draft_id: string | null;
  notice_kind: string | null;
  about_event_id: string | null;
  posted_enc: Buffer | null;
  draft_enc: Buffer | null;
  destination: string | null;
  disclosure_post_id: string | null;
  knock_enc: Buffer | null;
}

/**
 * THE POSTS AND THEIR DELIVERY ROWS, in one statement (ticket #220; widened at
 * #261).
 *
 * The joins are LEFT because AT MOST one of the two delivery references is set
 * (`posts_one_delivery_check`), and a post answered at the dashboard's door has
 * NEITHER: it is delivered by nothing and rendered from its own sealed parts.
 *
 * `disclosure_posts` IS JOINED FOR THE RE-EXPRESSION ALONE, and through the
 * notice because that is the direction the day's post points
 * (…20260829100025). A post this build COMPOSED carries the reference in its
 * own part; a post re-expressed from a `daily_disclosure` notice has to be told
 * which disclosure post that notice carried, because the migration could seal
 * nothing.
 *
 * ONE CONSTANT, TWO READS. The feed pages it by cursor and the exchanges read
 * picks replies out of it by id, and a second copy of this SELECT would be a
 * second chance for a column to be added to one read and not the other.
 */
const POST_SELECT = `SELECT p.id, p.posted_at, p.posted_at::text AS posted_at_text,
            p.execution_id, p.origin, p.parts_enc, p.draft_id,
            p.asked_on, p.asked_message_id,
            n.kind AS notice_kind, n.about_event_id::text AS about_event_id,
            COALESCE(n.content_enc, d.post_enc) AS posted_enc,
            d.content_enc AS draft_enc, d.destination,
            dp.id AS disclosure_post_id, k.text_enc AS knock_enc
       FROM posts p
       LEFT JOIN notices n ON n.id = p.notice_id
       LEFT JOIN drafts d ON d.id = p.draft_id
       LEFT JOIN disclosure_posts dp ON dp.notice_id = p.notice_id
       LEFT JOIN post_knocks k ON k.post_id = p.id AND k.twin_id = p.twin_id AND k.subject IS NULL`;

/**
 * THE REPLIES AT THE DOOR, BY THE MESSAGES THEY ANSWER (ticket #261).
 *
 * The exchanges read has the message ids and needs the posts; it asks for them
 * by the `asked_message_id` they carry rather than by their own, because that
 * is the join the pair is made on and a unique index makes it one reply apiece
 * (`posts_one_reply_per_dashboard_message`). Keyed by the MESSAGE in what comes
 * back, so the caller pairs without a second walk.
 *
 * SCOPED TO THE TWIN like every read in this module, even though the message
 * ids were already read under it: a read that trusted its caller's ids would be
 * the one place in this file where a row's tenancy came from somewhere other
 * than the WHERE clause.
 */
export async function readRepliesAtTheDoor(
  deps: FeedDeps,
  messageIds: readonly string[],
  now: Date,
): Promise<Map<string, FeedPost>> {
  const replies = new Map<string, FeedPost>();
  if (messageIds.length === 0) return replies;
  const res = await deps.db.query<PostRow>(
    `${POST_SELECT}
      WHERE p.twin_id = $1 AND p.asked_message_id = ANY($2::uuid[])`,
    [deps.twinId, [...messageIds]],
  );
  for (const row of res.rows) {
    replies.set(row.asked_message_id!, await feedPostOf(deps, row, now));
  }
  return replies;
}

/**
 * SOME OF THIS TWIN'S POSTS, BY THEIR OWN IDS, opened (ticket #266) — what the
 * canvas read asks for once it knows which posts wait.
 *
 * THROUGH `POST_SELECT`, THE ONE STATEMENT BOTH OTHER READS USE, so a card on
 * the canvas is opened exactly as the feed opens it: the same parts, the same
 * acts, the same answer on a question. Scoped to the twin in the WHERE clause,
 * `readRepliesAtTheDoor`'s rule, so an id of another twin's post opens nothing.
 */
export async function readPostsByIds(
  deps: FeedDeps,
  ids: readonly string[],
  now: Date,
): Promise<Map<string, FeedPost>> {
  const posts = new Map<string, FeedPost>();
  if (ids.length === 0) return posts;
  const res = await deps.db.query<PostRow>(
    `${POST_SELECT}
      WHERE p.twin_id = $1 AND p.id = ANY($2::uuid[])`,
    [deps.twinId, [...ids]],
  );
  for (const row of res.rows) {
    posts.set(row.id, await feedPostOf(deps, row, now));
  }
  return posts;
}

/** One row, opened into the post a surface reads. */
async function feedPostOf(
  deps: FeedDeps,
  row: PostRow,
  now: Date,
): Promise<FeedPost> {
  const parts = await openParts(deps, row, now);
  const customer = await customerOfPost(deps, row, parts);
  return {
    id: row.id,
    at: row.posted_at,
    executionId: row.execution_id,
    origin: row.origin,
    ...(row.asked_on === null ? {} : { askedOn: row.asked_on }),
    parts,
    ...(customer === undefined ? {} : { customer }),
  };
}

/**
 * WHO A HAND-OFF IS ABOUT, by reference (ticket #321): a draft's destination,
 * or the chat its binding question asks about.
 *
 * A CHAT NOBODY HAS CONFIRMED IS GIVEN ITS REFERENCE HERE, the first time a
 * card about it is read, so the reference the twin is shown on the canvas and
 * the one this card is matched by are one row (`Bundle.referenceForChat`). A
 * runtime serving reads with no bundle open names nobody.
 */
async function customerOfPost(
  deps: FeedDeps,
  row: PostRow,
  parts: readonly OpenedPart[],
): Promise<string | undefined> {
  if (deps.bundle === undefined) return undefined;
  let chatJid: string | undefined;
  for (const part of parts) {
    if (part.kind === "draft" && row.destination !== null) chatJid = row.destination;
    if (part.kind === "question") chatJid = await chatOfBindingQuestion(deps, part.aboutEventId);
  }
  if (chatJid === undefined) return undefined;
  return spellReference(deps.bundle.referenceForChat(chatJid));
}

async function openParts(
  deps: FeedDeps,
  row: PostRow,
  now: Date,
): Promise<readonly OpenedPart[]> {
  const parts =
    row.parts_enc === null
      ? // A post the migration re-expressed: no sealed parts, because SQL
        // holds no key, so `posts.ts` derives them from the delivery row's
        // own kind (…20260907100030 section 3).
        reexpressedParts({
          postId: row.id,
          draftId: row.draft_id,
          noticeKind: row.notice_kind,
          aboutEventId: row.about_event_id,
          disclosurePostId: row.disclosure_post_id,
          ...(row.posted_enc === null
            ? {}
            : {
                frozenText: Buffer.from(
                  deps.dek.decrypt(row.posted_enc),
                ).toString("utf8"),
              }),
        })
      : openSealedParts(deps.dek, row.parts_enc);
  // «LISTO» WHILE IT MEANS SOMETHING (ticket #368): on a card with no act of
  // its own, until the rep's own `clear_card` took it off the canvas.
  const offersClear = clearable(parts) && !(await clearedByRep(deps, row.id));
  const opened: OpenedPart[] = [];
  for (const part of parts) opened.push(await openPart(deps, row, part, now, offersClear));
  // THE KNOCK THE THREAD WROTE ABOUT THE POST (tickets #320, #358), opened
  // beside its parts.
  if (row.knock_enc !== null) {
    opened.push({ kind: "knock", text: openKnock(deps.dek, row.knock_enc), acts: [] });
  }
  return opened;
}

async function openPart(
  deps: FeedDeps,
  row: PostRow,
  part: PostPart,
  now: Date,
  offersClear: boolean,
): Promise<OpenedPart> {
  const acts = answerActsOf(part).filter((act) => act !== "clear" || offersClear);
  switch (part.kind) {
    case "draft": {
      const { body, destination } = draftBody(deps, row, part);
      return {
        ...part,
        acts,
        body,
        counterparty: part.counterparty ?? unrecordedCounterparty(deps, destination),
      };
    }
    case "record-lines":
      return { ...part, acts, ...(await recordLinesPart(deps, row, part, now)) };
    case "question": {
      const asked = await questionPart(deps, row, part);
      // AN ANSWERED QUESTION OFFERS NOTHING, which is the half of F34 a
      // surface reads: the acts a part names are what a card draws its buttons
      // from, so an answer and an empty list are decided in one place rather
      // than by every renderer agreeing to check both.
      return {
        ...part,
        acts: asked.answer === undefined ? acts : [],
        ...asked,
      };
    }
    case "ask":
      return { ...part, acts: (await askStillWaits(deps, row.id)) ? acts : [] };
    case "proposal":
      return { ...part, acts: (await proposalStillWaits(deps, row.id)) ? acts : [] };
    default:
      return { ...part, acts };
  }
}

/**
 * Whether the rep pressed «Listo» on this card and it was performed (ticket
 * #368) — the `dashboard_acts` row is the record, and the canvas's candidate
 * query reads the same row.
 */
async function clearedByRep(deps: Pick<FeedDeps, "db" | "twinId">, postId: string): Promise<boolean> {
  const res = await deps.db.query(
    `SELECT 1 FROM dashboard_acts
      WHERE twin_id = $1 AND post_id = $2 AND verb = 'clear_card' AND outcome = 'performed'
      LIMIT 1`,
    [deps.twinId, postId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Whether a step of a run that has not ended still waits on this card for
 * its answer (ticket #324) — the opened card's reading; the canvas's
 * candidate query asks the same of `run_steps` in its own SQL.
 */
async function askStillWaits(deps: Pick<FeedDeps, "db" | "twinId">, postId: string): Promise<boolean> {
  const res = await deps.db.query(
    `SELECT 1 FROM run_steps s JOIN runs r ON r.id = s.run_id
      WHERE s.awaits_post_id = $1 AND s.state = 'waiting' AND s.answered_at IS NULL
        AND s.kind IN ('ask', 'agent') AND r.ended_at IS NULL AND r.twin_id = $2
      LIMIT 1`,
    [postId, deps.twinId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Whether the rutina a proposal card names still waits on the rep (ticket
 * #386) — pending and live; the canvas's candidate query asks the same of
 * `automations` in its own SQL.
 */
async function proposalStillWaits(deps: Pick<FeedDeps, "db" | "twinId">, postId: string): Promise<boolean> {
  const res = await deps.db.query(
    `SELECT 1 FROM automations
      WHERE twin_id = $1 AND proposal_post_id = $2 AND state = 'pending' AND ended_at IS NULL
      LIMIT 1`,
    [deps.twinId, postId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * What the rep answered, and which chat the question is about (ticket #255;
 * boundary #225, F34 and F35) — `OpenedQuestionPart` argues both authorities.
 *
 * THE CHAT IS RE-DERIVED FROM THE QUESTION'S OWN ANCHOR, the way every other
 * reader of a binding question derives it (`askedQuestion` in `rep-acts.ts`):
 * the customer-chat event's sealed payload, opened under the key this read
 * already holds. An event this twin does not have leaves every field absent,
 * which draws the card exactly as it drew before this ticket.
 *
 * THE ANSWER IS `bindingQuestionState`'s, SHARED WITH THE CANVAS (ticket
 * #268): both ask "is this question still open", and the third authority —
 * the thread's own «no va» — is read there.
 */
async function questionPart(
  deps: FeedDeps,
  row: PostRow,
  part: QuestionPart,
): Promise<{
  readonly answer?: QuestionAnswer;
  readonly chatNumber?: string;
  readonly chatName?: string;
}> {
  const chatJid = await chatOfBindingQuestion(deps, part.aboutEventId);
  if (chatJid === undefined) return {};
  const number = chatNumberOf(chatJid);
  const name = await chatDirectoryName(deps, chatJid);
  const state = await bindingQuestionState(deps, {
    postId: row.id,
    chatJid,
    askedAt: row.posted_at,
  });
  return {
    ...(state === "open" ? {} : { answer: state }),
    ...(number === undefined ? {} : { chatNumber: number }),
    ...(name === undefined ? {} : { chatName: name }),
  };
}

/**
 * The chat's number as a rep reads it, or nothing at all.
 *
 * THE DIGITS OF THE ADDRESS AND NO GROUPING, which is the twin's own fallback
 * in `counterpartyDisplayName`: one chat's number reads the same way wherever
 * this product prints it, and a grouping would be a claim about a numbering
 * plan nothing here holds — «+52 1 81 …» is right for Monterrey and wrong for
 * León, and a wrongly grouped number reads as a different number.
 *
 * IT IS NOT `counterpartyDisplayName` WITH A CONDITION, though it sits one
 * module away in this package: that one answers «what do I CALL this
 * counterparty», falling through to the digits when no push name is known,
 * and this answers «is there a number here at all» — which is a question with
 * an honest NO, and the whole of the LID case.
 *
 * A LID-ADDRESSED CHAT HAS NONE, and that is a fact about the rail rather than
 * a gap: a LID is an opaque identifier the phone assigns, its digits are not a
 * number anybody can dial, and printing them would offer the rep something to
 * compare that cannot match. The card names the chat by its directory name
 * then, or by the proposal alone.
 */
function chatNumberOf(chatJid: string): string | undefined {
  const [user, server] = chatJid.split("@");
  if (user === undefined || user === "" || server !== "s.whatsapp.net") {
    return undefined;
  }
  return user;
}

/** What the rep's own phone calls that chat, opened under the twin's key. */
async function chatDirectoryName(
  deps: FeedDeps,
  chatJid: string,
): Promise<string | undefined> {
  const res = await deps.db.query<{ name_enc: Buffer | null }>(
    // EITHER SPELLING, because a modern DM has two and the directory row may
    // be keyed on the one the plane saw first — the same pair the scoping
    // read's own predicate resolves (`readChatDirectory`).
    `SELECT name_enc FROM chat_directory
      WHERE twin_id = $1 AND (chat_jid = $2 OR lid_jid = $2)`,
    [deps.twinId, chatJid],
  );
  const nameEnc = res.rows[0]?.name_enc;
  return nameEnc === undefined || nameEnc === null
    ? undefined
    : Buffer.from(deps.dek.decrypt(nameEnc)).toString("utf8");
}

/**
 * The name for a draft post that recorded none (ticket #298; boundary #270,
 * F5) — a post re-expressed from before parts existed.
 *
 * `counterpartyName`, THE ONE NAMING RULE THE FRAME IS RENDERED BY: the
 * rep-confirmed name when the entity mirror binds the draft's own chat, the
 * chat's number marked «(sin confirmar)» when it does not. No push name: the
 * one such a post showed was rendered into `post_enc` and stored nowhere a
 * reader can name (ADR-0034), and one read now off another row could be a
 * name the post never showed.
 *
 * READ FROM THE MIRROR AS IT STANDS NOW, and read at all only here: the post
 * itself is immutable (ADR-0044) and nothing is written back. A runtime
 * serving the reads with no bundle open has no mirror to ask, and names every
 * such chat as unconfirmed — which is all it knows.
 */
function unrecordedCounterparty(deps: FeedDeps, destination: string): string {
  return counterpartyName({
    confirmedName: deps.bundle?.readChatBinding(destination)?.displayName,
    pushName: undefined,
    senderJid: destination,
  });
}

/**
 * The body a tap would release, opened from the draft row the part names —
 * and the chat it goes to, which only names a draft no post named and never
 * leaves the read (ticket #305).
 *
 * LOUD ON A REFERENCE THAT RESOLVES TO NOTHING, because a draft card with no
 * body is the one thing worse than no card: the rep would be shown a
 * proposal they cannot read and offered a button that sends it. The reference
 * and the row are written in one transaction, so a miss is a broken store.
 */
function draftBody(
  deps: FeedDeps,
  row: PostRow,
  part: DraftPart,
): { readonly body: string; readonly destination: string } {
  if (
    row.draft_enc === null ||
    row.destination === null ||
    row.draft_id !== part.draftId
  ) {
    throw new Error(
      `post ${row.id} carries a draft part naming ${part.draftId}, which is not the draft this post delivers — a card with no body would offer the rep a send of something they cannot read (ticket #220)`,
    );
  }
  return {
    body: Buffer.from(deps.dek.decrypt(row.draft_enc)).toString("utf8"),
    destination: row.destination,
  };
}

/**
 * The day's numbered lines, read from the rows ADR-0034's trigger sealed with
 * their post — the numbering the rep SAW, in stored order.
 *
 * THE PROVENANCE CLAUSE IS RENDERED AGAINST THE READ'S OWN INSTANT
 * (`FeedRead.now`), off the renderer the post itself used — so a caller who
 * replays the post's composition instant gets the clause the thread printed,
 * and a rep opening the card three days later is not told a chat happened
 * «hoy».
 */
async function recordLinesPart(
  deps: FeedDeps,
  row: PostRow,
  part: RecordLinesPart,
  now: Date,
): Promise<{
  readonly lines: readonly OpenedRecordLine[];
  readonly windowClosesAt?: Date;
}> {
  // THE REFERENCE MUST BE THIS POST'S OWN, refused for the reason `draftBody`
  // refuses a mismatched draft: the sealed reference is not something the
  // store can check, and a part naming ANOTHER post's numbering would put a
  // day the rep never read behind their retract buttons. The post, its notice
  // and its `disclosure_posts` row are written in one transaction, so a
  // mismatch is a broken store rather than a path.
  if (row.disclosure_post_id !== part.disclosurePostId) {
    throw new Error(
      `post ${row.id} carries a record-lines part naming ${part.disclosurePostId}, which is not the disclosure post its own notice carried — the numbering a rep retracts from is the one their post printed (ADR-0034; ticket #220)`,
    );
  }
  const windowClosesAt = await correctionWindowClose(
    deps,
    part.disclosurePostId,
  );
  // THE WINDOW IS SHUT ONLY WHEN IT OPENED AND PASSED. An absent close is the
  // rep reading a record the rail never delivered — `finalizeDueFacts` will
  // finalize nothing, so the fact is still provisional and a correction still
  // applies (`OpenedRecordLinesPart.windowClosesAt` argues it).
  const windowOpen =
    windowClosesAt === undefined || now.getTime() < windowClosesAt.getTime();
  const res = await deps.db.query<{
    line_index: number;
    disclosure_line_id: string;
    rendered_text: string;
    subject_kind: "fact" | "entity_create";
    entity_id: string;
    act_at: Date;
    retracted: boolean;
    correction_enc: Buffer | null;
  }>(
    `SELECT pl.line_index, pl.disclosure_line_id, dl.rendered_text,
            dl.subject_kind, dl.entity_id,
            COALESCE(act.occurred_at, dact.acted_at) AS act_at,
            fr.fact_id IS NOT NULL AS retracted,
            fr.correction_enc
       FROM disclosure_post_lines pl
       JOIN disclosure_lines dl
         ON dl.id = pl.disclosure_line_id AND dl.twin_id = pl.twin_id
       -- ONE OF TWO ACT ROWS CARRIES THE INSTANT, since #224: the seam event
       -- for a fact and for a binding the rep confirmed in their thread, the
       -- dashboard act for one they confirmed on a card.
       -- disclosure_lines_one_evidence_check refuses a line naming neither, so
       -- the COALESCE is total and an inner join on either alone would silently
       -- drop lines the rep really read.
       LEFT JOIN wa_events act ON act.id = dl.source_event_id
       LEFT JOIN dashboard_acts dact ON dact.id = dl.dashboard_act_id
       -- THE APERTURE'S REP-SIDE EVIDENCE ROW, and not the Ledger's own: that
       -- schema is on the far side of ADR-0002's wall and this runtime holds
       -- no privilege in it (FR-71a). A retraction writes here in the same
       -- transaction as the annotation it evidences (…20260829100040), so this
       -- row's existence and the annotation are one write.
       LEFT JOIN fact_retractions fr
         ON fr.twin_id = dl.twin_id AND fr.disclosure_line_id = dl.id
      WHERE pl.post_id = $1 AND pl.twin_id = $2
      ORDER BY pl.line_index`,
    [part.disclosurePostId, deps.twinId],
  );
  const heading = new Map<number, string>();
  for (const group of part.groups ?? []) {
    for (const index of group.indexes) heading.set(index, group.counterparty);
  }
  return {
    lines: res.rows.map((line) => ({
      index: line.line_index,
      text: line.rendered_text,
      ...(heading.has(line.line_index)
        ? { counterparty: heading.get(line.line_index)! }
        : {}),
      provenance: renderDisclosureProvenance(
        // WHO DID IT decides the clause, which is exactly the subject kind —
        // the rule `provenanceOf` states in full (`disclosure.ts`).
        {
          kind: line.subject_kind === "fact" ? "chat" : "rep_act",
          at: line.act_at,
        },
        now,
        deps.timeZone,
      ),
      disclosureLineId: line.disclosure_line_id,
      entityId: line.entity_id,
      retractable:
        line.subject_kind === "fact" && !line.retracted && windowOpen,
      retracted: line.retracted,
      ...(line.correction_enc === null
        ? {}
        : {
            corrected: Buffer.from(deps.dek.decrypt(line.correction_enc)).toString("utf8"),
          }),
    })),
    ...(windowClosesAt === undefined ? {} : { windowClosesAt }),
  };
}

/**
 * When this record's correction window closes — finalization's own join,
 * asked of the same rows (ticket #224; ADR-0004; `finalization.ts`).
 *
 * `min(executed_at)` AND `'sent'` AND NOTHING ELSE, because that is what
 * `finalizeDueFacts` reads: a line can ride more than one post (#51's
 * redelivery returns the lines of a post whose send definitively failed), so
 * the clock starts at the earliest post that actually reached the rep — and a
 * `failed` or `held` outcome, or a command still in flight, all mean the rep
 * was not reached at all.
 *
 * IT IS SCOPED TO THE POST THIS CARD IS, which is where it differs from the
 * clock's own query one function call away: the clock groups by FACT across
 * every post that carried it, and a card is one post. The two coincide in the
 * ordinary case (a line rides one post) and diverge on redelivery, where this
 * names the later window — so the card offers a retraction the aperture may
 * refuse with `window_closed` rather than withholding one it would accept.
 * That refusal is a first-class outcome on both surfaces (the thread's own
 * `correction_refused`), and it is the direction that cannot lose a correction.
 *
 * `undefined` MEANS THE WINDOW NEVER OPENED, never that it closed — the rail
 * delivered nothing, so `finalizeDueFacts` will finalize nothing and the facts
 * are still correctable. Both readers turn on that distinction: the card keeps
 * its retract buttons, and the door says nothing about a deadline that does
 * not exist.
 *
 * TAKING THE ID RATHER THAN THE PART, so the door asks the same question of
 * the same rows: two derivations of one instant is exactly the drift that
 * would let two surfaces disagree about when the rep's day is firm.
 */
export async function correctionWindowClose(
  deps: Pick<FeedDeps, "db" | "twinId">,
  disclosurePostId: string,
): Promise<Date | undefined> {
  const res = await deps.db.query<{ reachable_at: Date | null }>(
    `SELECT min(sc.executed_at) AS reachable_at
       FROM disclosure_posts p
       JOIN send_commands sc
         ON sc.twin_id = p.twin_id
        AND sc.payload_ref = 'notice:' || p.notice_id
      WHERE p.id = $1 AND p.twin_id = $2 AND sc.outcome = 'sent'`,
    [disclosurePostId, deps.twinId],
  );
  const reachableAt = res.rows[0]?.reachable_at ?? null;
  if (reachableAt === null) return undefined;
  return new Date(
    reachableAt.getTime() + CORRECTION_WINDOW_HOURS * 60 * 60 * 1000,
  );
}

/**
 * The cursor: the keyset this read's ORDER BY already uses, so a page cannot
 * skip or repeat a post when two share an instant.
 *
 * THE TIMESTAMP TRAVELS AS POSTGRES RENDERS IT, microseconds and all. A
 * JavaScript `Date` holds milliseconds, so a cursor built from one would
 * round — and two posts of one transaction are microseconds apart
 * (`clock_timestamp()`), which is exactly the pair a rounded cursor would
 * either show twice or lose.
 *
 * IT CARRIES NO TWIN. The twin is a predicate on the query, from the caller's
 * own authenticated identity, so holding somebody else's cursor buys nothing.
 */
function cursorFor(row: PostRow): string {
  return Buffer.from(`${row.posted_at_text}|${row.id}`, "utf8").toString(
    "base64url",
  );
}

function parseCursor(cursor: string): { postedAt: string; id: string } {
  const [postedAt, id, ...rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (postedAt === undefined || id === undefined || rest.length > 0) {
    throw new Error(
      "this feed cursor is not one this read minted — a cursor is the keyset of the last post on the previous page (ticket #220)",
    );
  }
  return { postedAt, id };
}

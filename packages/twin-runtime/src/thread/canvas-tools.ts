/**
 * WHAT THE TWIN THREAD SEES OF THE CANVAS, AND THE TWO THINGS IT DOES WITH IT
 * (ticket #320; spec #318 decisions 10, 19, 20 and 21; design D4, D5, §3.2,
 * §4 and §6).
 *
 * The thread is the only presence that knocks the phone and curates the
 * canvas. An automation posts its own hand-off and stops there; the landing
 * wakes the thread, and the thread's turn decides — from what the day holds,
 * never from a rule in code — whether the rep's phone hears of it and which
 * card the rep starts with.
 *
 * ═══ ONE RENDERING, TWO PLACES ═══
 *
 * `renderCanvas` is what every wake's message carries as its canvas block and
 * what `read_canvas` returns: what waits, by post id, with its kind, the
 * customer it is about by their reference, since when, whether the rep has
 * looked at it, how it settled if it did in the last hour, and the current
 * spotlight.
 * The events keep the twin's picture current between turns; the read gives
 * the exact state at the moment of deciding, because a card may have settled
 * since the event was told (design §6).
 *
 * ═══ THE TOOLS AND THEIR GATES (ADR-0013) ═══
 *
 *   read_canvas, read_post   projection — pinned columns, no widening.
 *   move_cards               disclosed-and-undoable-after — the dashboard
 *                            shows the arrangement, every version is kept,
 *                            the next one replaces it (ticket #401).
 *   spotlight                disclosed-and-undoable-after — the card held up
 *                            is shown lifted, every version is kept, the next
 *                            one or the card leaving ends it (ticket #401).
 *   knock                    disclosed-and-undoable-after — the closest of
 *                            ADR-0013's words to its class 4 through notify:
 *                            disclosed on the card and on the bell's list, and
 *                            what it changes is the rep's attention, not
 *                            their record. Undoable it is not once a phone
 *                            showed it; that half is what the floors are for.
 *   say_on_card              disclosed-and-undoable-after — the sentence is
 *                            shown under the card and kept in the day's
 *                            thread the moment it lands, and the twin's next
 *                            sentence on the same card replaces it there
 *                            (ticket #340). It changes nothing on the rep's
 *                            record and reaches no phone. Only a turn a
 *                            summons woke may speak there (ticket #384).
 *
 * NONE OF THE FOUR WRITES NEEDS THE REP'S EVIDENCE, so a turn an event woke
 * can knock, move the cards and spotlight one (spec #318 decision 19), and a turn a summons woke
 * can speak on a card (tickets #340, #384); and NONE REACHES NOTIFY OR A SEND: the knock writes its row and the
 * runtime's pass delivers it, the sentence on a card is a post at the
 * dashboard's door, and the dependency wall keeps every registry away from
 * notify.
 */
import {
  defineTool,
  renderTurnInstant,
  type EffectOutcome,
  type GatedEffectToolDeclaration,
  type ProjectionToolDeclaration,
} from "@dito/execution";
import {
  readCuration,
  readSeen,
  readSpotlight,
  readWaiting,
  recentSettles,
  writeCuration,
  writeSpotlight,
  type Curation,
  type CurationOffer,
  type RecentSettle,
  type Spotlight,
} from "../canvas.js";
import { readPostsByIds, type FeedDeps, type FeedPost } from "../feed.js";
import { readRunContent } from "../runs/content.js";
import { addKnock, announcedTextOf, refusalOnHeldDraft, type KnockRefusal } from "../post-knocks.js";
import { acceptsKnock, insertPost, KNOCK_MAX, prosePart, type Mention } from "../posts.js";
import type { ThreadDeps } from "./deps.js";
import { typedReferencedName } from "./guard.js";
import {
  annotateNames,
  mentionsIn,
  parseReference,
  REFERENCE_EXAMPLE,
  referencesIn,
  renderNames,
  writeReference,
  type Customers,
} from "./references.js";
import { UUID, type ServedHits } from "./served.js";

/**
 * The act a sentence said on a card reports (ticket #340): the twin speaking
 * where the rep brought it, recorded as the turn's own execution and its
 * chain entry (ADR-0020), like the spotlight's.
 */
export const SAID_ON_CARD_ACT = "said_on_card";

/**
 * The acts a knock, an arrangement of the cards, a spotlight and a sentence on
 * a card report — presence, never a rep's act (ticket #401: `cards_moved` is
 * `move_cards`'s, `spotlit` the spotlight's).
 */
export const PRESENCE_ACT_WORDS = ["knocked", "cards_moved", "spotlit", SAID_ON_CARD_ACT] as const;

/**
 * WHERE A CARD CAME FROM (ticket #401), read from facts code already has: the
 * execution that posted it and, for a run's step, that run. Never a sentence
 * anybody wrote, beyond a run's own name — the twin's words, references and
 * all.
 */
export type CardOrigin =
  | { readonly kind: "customer" }
  | { readonly kind: "ask" }
  | {
      readonly kind: "run";
      /** The run's own name as the twin or Dito wrote it, when its content opens. */
      readonly name?: string;
      /** `rutina` for one a rutina fired, else a shipped automation's name or `inline`. */
      readonly automation: string;
      readonly startedAt: Date;
      /** The step that posted it, from 1. */
      readonly step: number;
    }
  | { readonly kind: "turn" }
  | { readonly kind: "code" };

export interface CanvasView {
  /** What waits, oldest first. */
  readonly waiting: readonly FeedPost[];
  /** When the rep last saw each waiting card, by post id; absent, never seen. */
  readonly seen: ReadonlyMap<string, Date>;
  /** When each waiting card was last knocked, by post id; absent, never. */
  readonly knocked?: ReadonlyMap<string, Date>;
  /** Where each waiting card came from, by post id. */
  readonly origins?: ReadonlyMap<string, CardOrigin>;
  /** What stopped waiting in the last hour. */
  readonly settled: readonly RecentSettle[];
  readonly curation?: Curation;
  /**
   * THE CARD IN THE SPOTLIGHT NOW — held up by the twin's `spotlight`, lifted
   * — and since when; never first place, which is its spot number (ticket #401).
   */
  readonly spotlight?: Spotlight;
}

/** The canvas as the twin reads it, now. */
export async function readCanvasView(
  deps: FeedDeps,
  seatId: string | undefined,
  now: Date,
  /** The harness directory, where a run's name is read from its sealed content. */
  harnessDirectory?: string,
): Promise<CanvasView> {
  const waiting = await readWaiting(deps, now);
  const curation = await readCuration(deps);
  const spotlight = await readSpotlight(deps, now);
  const ids = waiting.map((post) => post.id);
  return {
    waiting,
    seen: seatId === undefined ? new Map() : await readSeen(deps.db, seatId, ids),
    knocked: await lastKnocks(deps, ids),
    origins: await originsOf(deps, ids, harnessDirectory),
    settled: await recentSettles(deps, now),
    ...(curation === undefined ? {} : { curation }),
    ...(spotlight === undefined ? {} : { spotlight }),
  };
}

/** When each card was last knocked. */
async function lastKnocks(deps: FeedDeps, ids: readonly string[]): Promise<ReadonlyMap<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.db.query<{ post_id: string; at: Date }>(
    `SELECT post_id, max(knocked_at) AS at FROM post_knocks
      WHERE twin_id = $1 AND post_id = ANY($2::uuid[]) GROUP BY post_id`,
    [deps.twinId, [...ids]],
  );
  return new Map(rows.rows.map((row) => [row.post_id, row.at] as const));
}

/** Where each card came from: its execution's trigger and, for a run's step, the run. */
async function originsOf(
  deps: FeedDeps,
  ids: readonly string[],
  harnessDirectory: string | undefined,
): Promise<ReadonlyMap<string, CardOrigin>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.db.query<{
    id: string;
    trigger_kind: string | null;
    run_id: string | null;
    step_index: number | null;
    automation: string | null;
    automation_id: string | null;
    created_at: Date | null;
    definition_digest: string | null;
  }>(
    `SELECT p.id, e.trigger_kind, s.run_id, s.step_index, r.automation, r.automation_id, r.created_at, r.definition_digest
       FROM posts p
       LEFT JOIN executions e ON e.id = p.execution_id
       LEFT JOIN run_steps s ON s.execution_id = p.execution_id
       LEFT JOIN runs r ON r.id = s.run_id
      WHERE p.twin_id = $1 AND p.id = ANY($2::uuid[])`,
    [deps.twinId, [...ids]],
  );
  const origins = new Map<string, CardOrigin>();
  for (const row of rows.rows) origins.set(row.id, originOf(deps, row, harnessDirectory));
  return origins;
}

/** One card's origin, off its row. */
function originOf(
  deps: FeedDeps,
  row: {
    readonly trigger_kind: string | null;
    readonly run_id: string | null;
    readonly step_index: number | null;
    readonly automation: string | null;
    readonly automation_id: string | null;
    readonly created_at: Date | null;
    readonly definition_digest: string | null;
  },
  harnessDirectory: string | undefined,
): CardOrigin {
  if (row.trigger_kind === null) return { kind: "code" };
  if (row.trigger_kind === "chat_turn") return { kind: "customer" };
  if (row.trigger_kind === "twin_thread_message") return { kind: "ask" };
  if (row.run_id === null || row.automation === null || row.created_at === null) return { kind: "turn" };
  // DRAFTING IS A CUSTOMER'S MESSAGE, whichever shape ran it.
  if (row.automation === "drafting") return { kind: "customer" };
  let name: string | undefined;
  if (harnessDirectory !== undefined && row.definition_digest !== null) {
    try {
      name = readRunContent(harnessDirectory, deps.dek, row.run_id, row.definition_digest).definition.name;
    } catch {
      name = undefined;
    }
  }
  return {
    kind: "run",
    ...(name === undefined || name.trim() === "" ? {} : { name }),
    automation: row.automation_id === null ? row.automation : "rutina",
    startedAt: row.created_at,
    step: (row.step_index ?? 0) + 1,
  };
}

/**
 * THE CANVAS, IN WORDS (design §3.2's reference block; ticket #401).
 *
 * THE CARDS IN THE ORDER THE REP SEES THEM ON INICIO, top first, each with
 * its spot — 1 is the top — so first place is a number and never a word. Per
 * card: its post id, what it is and who it is for, where it came from,
 * waiting since, when the rep last saw it, when it was last knocked, whether
 * it carries an offer, and whether it is in the spotlight now. The cards the
 * twin took off the dashboard follow on their own, so it knows they are
 * hidden.
 *
 * EACH CARD NAMES ITS CUSTOMER BY THEIR REFERENCE AND ITSELF BY ITS POST ID
 * (ticket #321): the reference is how the twin writes the customer's name in
 * the line it says about the card, and the post id is what `knock`,
 * `move_cards` and `read_post` take and every event names. The rendering
 * itself is grounds for the figures a line may use (`thread/line.ts`).
 */
export function renderCanvas(
  view: CanvasView,
  served: ServedHits,
  timeZone: string,
): string {
  const lines: string[] = [];
  const left = new Set(view.curation?.left ?? []);
  const shown = inicioOrder(view.waiting, view.curation);
  const off = view.waiting.filter((post) => left.has(post.id));
  if (shown.length === 0) {
    lines.push("Nothing waits on the rep's dashboard right now.");
  } else {
    lines.push(
      `${String(shown.length)} card${shown.length === 1 ? "" : "s"} on the rep's dashboard right now, in the order they see them, top first:`,
    );
    shown.forEach((post, at) => {
      lines.push(`${String(at + 1)}. ${cardLine(post, served.customers, view, timeZone)}`);
    });
  }
  if (off.length > 0) {
    lines.push(
      `${String(off.length)} card${off.length === 1 ? "" : "s"} you took off the dashboard, still waiting and hidden from the rep there until you place ${off.length === 1 ? "it" : "them"} again:`,
    );
    for (const post of off) lines.push(`- ${cardLine(post, served.customers, view, timeZone)}`);
  }
  if (view.settled.length > 0) {
    lines.push(
      `Settled in the last hour: ${view.settled
        .map((settle) => `post ${settle.postId} ${SETTLED_WORDS[settle.outcome]}`)
        .join("; ")}.`,
    );
  }
  const text = lines.join("\n");
  served.ground(text);
  return text;
}

/**
 * THE CARDS IN THE ORDER INICIO LAYS THEM OUT (ticket #401), the page's own
 * rule (`lienzo/model.ts`'s `arrange`): the card the twin put at the top,
 * then its order where each still waits, then every card it did not place,
 * oldest first — less the cards it took off.
 */
export function inicioOrder(waiting: readonly FeedPost[], curation: Curation | undefined): readonly FeedPost[] {
  const left = new Set(curation?.left ?? []);
  const shown = waiting.filter((post) => !left.has(post.id));
  const byId = new Map(shown.map((post) => [post.id, post] as const));
  const placed: FeedPost[] = [];
  for (const id of curation?.order ?? []) {
    const post = byId.get(id);
    if (post !== undefined && !placed.includes(post)) placed.push(post);
  }
  const cards = [...placed, ...shown.filter((post) => !placed.includes(post))];
  const top = curation?.spotlight === undefined ? undefined : byId.get(curation.spotlight);
  return top === undefined ? cards : [top, ...cards.filter((post) => post !== top)];
}

/**
 * The customer a card is about, as the block prints them: their reference
 * alone — `[c7]` — or nothing. NEVER THE NAME: the canvas block rides every
 * wake into the day's session, and what a card is about reaches the thread as
 * an id the twin writes back, the name staying code's to render (spec #318
 * decision 12; `read_entity` and `read_post` are how the twin looks closer).
 */
function customerOfCard(post: FeedPost, customers: Customers): string | undefined {
  const reference = parseReference(post.customer);
  const customer = reference === undefined ? undefined : customers(reference);
  return customer === undefined ? undefined : writeReference(customer.reference);
}

/** How a settle reads in the block. */
const SETTLED_WORDS: Readonly<Record<RecentSettle["outcome"], string>> = {
  sent: "sent",
  queued: "approved, waiting for the phone link to send it",
  failed: "refused by the phone link",
  held: "sent, with no confirmation back from the phone",
  dismissed: "discarded",
};

/** Where a card came from, as the block says it. */
function originWords(origin: CardOrigin | undefined, timeZone: string): string {
  switch (origin?.kind) {
    case "customer":
      return "from a customer's message";
    case "ask":
      return "from the rep's ask";
    case "run": {
      const which = origin.automation === "rutina" ? "your rutina" : origin.automation === "inline" ? "your run" : `Dito's ${origin.automation} run`;
      return `from ${which}${origin.name === undefined ? "" : ` "${origin.name}"`}, the pass started [${renderTurnInstant(origin.startedAt, timeZone)}], step ${String(origin.step)}`;
    }
    case "turn":
      return "from a turn of yours";
    case "code":
    case undefined:
      return "written by Dito";
  }
}

/** One card's line. */
function cardLine(
  post: FeedPost,
  customers: Customers,
  view: CanvasView,
  timeZone: string,
): string {
  const seen = view.seen.get(post.id);
  const knocked = view.knocked?.get(post.id);
  const facts = [
    `post ${post.id}`,
    describe(post, customerOfCard(post, customers)),
    originWords(view.origins?.get(post.id), timeZone),
    `waiting since [${renderTurnInstant(post.at, timeZone)}]`,
    seen === undefined ? "not seen yet" : `seen [${renderTurnInstant(seen, timeZone)}]`,
    knocked === undefined ? "never knocked" : `knocked [${renderTurnInstant(knocked, timeZone)}]`,
  ];
  const offer = view.curation?.offers.find((one) => one.postId === post.id);
  // THE OFFER IS NAMED, NEVER QUOTED: its stored sentence carries the name
  // code rendered, and the block never does (`customerOfCard`); the twin's own
  // `move_cards` call, with the reference, is in the session.
  if (offer !== undefined) facts.push("you left an offer on it");
  if (view.spotlight?.postId === post.id) facts.push(`in the spotlight since [${renderTurnInstant(view.spotlight.since, timeZone)}]`);
  return facts.join(" · ");
}

/** What a card is, in a phrase. */
function describe(post: FeedPost, customer: string | undefined): string {
  for (const part of post.parts) {
    if (part.kind === "draft") {
      return customer === undefined ? "a draft reply" : `a draft reply for ${customer}`;
    }
    if (part.kind === "question") {
      return customer === undefined
        ? "a question asking who a chat belongs to"
        : `a question asking whether a chat is ${customer}`;
    }
    if (part.kind === "ask") return "a question a run of yours asked the rep, waiting for their answer";
    if (part.kind === "record-lines") {
      const open = part.lines.filter((line) => line.retractable).length;
      return `the day's notes, ${String(open)} line${open === 1 ? "" : "s"} the rep can still mark wrong`;
    }
  }
  return "a card";
}

/** The pieces of `ThreadDeps` a canvas read takes. */
function feedOf(deps: ThreadDeps): FeedDeps {
  return {
    db: deps.db,
    twinId: deps.twinId,
    dek: deps.dek,
    timeZone: deps.timeZone,
    bundle: deps.bundle,
  };
}

/** Whether a string is a post id at all — checked before it reaches a query. */
function isPostId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${UUID.source}$`, "iu").test(value);
}

// ─── read_canvas ────────────────────────────────────────────────────────

/** The tool's registered name. */
export const READ_CANVAS_TOOL = "read_canvas";

/**
 * WHAT IT RETURNS, PINNED (ADR-0013; ticket #401): per card its spot on
 * Inicio, its post id, kind, its customer's reference, where it came from,
 * since when, when the rep last saw it, when it was last knocked, whether it
 * carries an offer and whether it is in the spotlight; the cards taken off;
 * what settled in the last hour. No post's content: a draft's words are
 * `read_post`'s.
 */
export const READ_CANVAS_COLUMNS: readonly string[] = [
  "spot",
  "post_id",
  "kind",
  "customer",
  "came_from",
  "since",
  "seen_at",
  "knocked_at",
  "offer",
  "spotlight",
  "off",
  "settled",
];

export const READ_CANVAS_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: READ_CANVAS_TOOL,
  gate: "projection",
  description:
    "What is on the rep's dashboard at this moment: every card in the order they see it, top first, with its place, its post id, what it is, who it is about, where it came from, since when, when they last looked at it, when it was last knocked, whether it carries your offer and whether it is held up in the spotlight; the cards you took off; what settled in the last hour. Your message already shows this as it was when the turn began; read it again when a card may have changed since.",
  columns: READ_CANVAS_COLUMNS,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** The read, bound to this twin and its customers' references. */
export function readCanvasTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...READ_CANVAS_DECLARATION,
    run: async () => {
      const view = await readCanvasView(feedOf(deps), deps.seatId, new Date(), deps.harness?.directory);
      const text = renderCanvas(view, deps.served, deps.timeZone);
      deps.served.read(text);
      return text;
    },
  });
}

// ─── read_post ──────────────────────────────────────────────────────────

/** The tool's registered name. */
export const READ_POST_TOOL = "read_post";

/**
 * WHAT IT RETURNS, PINNED (ADR-0013): one of this twin's posts, whole — when
 * it was posted and each opened part: what the twin said, a draft's text and
 * the reason it gave, a question and whether it was answered, the day's
 * numbered lines, a receipt, the knock if it has one. Never another twin's
 * post, never the chat's address.
 */
export const READ_POST_COLUMNS: readonly string[] = ["post_id", "posted_at", "part", "text"];

export const READ_POST_DECLARATION: Omit<ProjectionToolDeclaration, "run"> = {
  name: READ_POST_TOOL,
  gate: "projection",
  description:
    "One of your posts, whole, by its post id: when it was posted and everything in it — a draft's text and why you wrote it, a question and whether the rep answered it, the day's numbered lines, the knock if the rep's phone was told of it.",
  columns: READ_POST_COLUMNS,
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "The post's id, as the canvas or an event named it.",
      },
    },
    required: ["post_id"],
    additionalProperties: false,
  },
};

/** The read, bound to this twin. */
export function readPostTool(deps: ThreadDeps): ProjectionToolDeclaration {
  return defineTool({
    ...READ_POST_DECLARATION,
    run: async (input: unknown) => {
      const given = (input as { post_id?: unknown }).post_id;
      if (!isPostId(given)) {
        return "rejected: `post_id` is a post's id, as the canvas or an event named it.";
      }
      const post = (await readPostsByIds(feedOf(deps), [given], new Date())).get(given);
      if (post === undefined) return `No post of yours has the id ${given}.`;
      const text = renderPost(post, deps.served, deps.timeZone);
      deps.served.read(text);
      return text;
    },
  });
}

/** One post, part by part, its customer by their reference. */
function renderPost(post: FeedPost, served: ServedHits, timeZone: string): string {
  const customer = customerOfCard(post, served.customers);
  const lines = [`post ${post.id}, posted [${renderTurnInstant(post.at, timeZone)}]:`];
  for (const part of post.parts) {
    switch (part.kind) {
      case "prose":
        lines.push(`- what you said: ${annotateNames(part.text, part.mentions ?? [])}`);
        break;
      case "draft":
        lines.push(
          `- a draft reply${customer === undefined ? "" : ` for ${customer}`}: <draft>${part.body}</draft>`,
          // THE REASON THE REP READS BEFORE THE TAP (ticket #343), so the twin
          // can speak to it when they ask.
          ...(part.reason === undefined ? [] : [`- the reason you gave the rep to read before sending it: ${part.reason}`]),
        );
        break;
      case "question":
        lines.push(
          `- a question asking whether a chat is ${customer ?? "the customer the phone named"}: ${
            part.answer === undefined ? "not answered yet" : `the rep ${part.answer} it`
          }`,
        );
        break;
      case "ask":
        lines.push(
          `- a question a run of yours asked the rep: ${annotateNames(part.question, part.mentions ?? [])} — ${
            part.acts.includes("answer") ? "waiting for their answer" : "answered, or its run has ended"
          }`,
          ...part.fields.map(
            (field) =>
              `  - field ${field.name} (${field.kind})${field.label === undefined ? "" : `, ${field.label}`}${
                field.options === undefined
                  ? ""
                  : `: ${field.options.map((option) => `${option.value} (${option.label})`).join(", ")}`
              }`,
          ),
        );
        break;
      case "record-lines":
        for (const line of part.lines) {
          lines.push(
            `- line ${String(line.index)}: ${line.text}${line.retractable ? "" : " (no longer correctable)"}`,
          );
        }
        break;
      case "receipt":
        lines.push(`- receipt: ${part.text}`);
        break;
      case "knock":
        lines.push(`- the knock the rep's phone was told: ${part.text}`);
        break;
      case "curation":
        break;
    }
  }
  return lines.join("\n");
}

// ─── move_cards ─────────────────────────────────────────────────────────

/** The tool's registered name (ticket #401: the arranging tool, which moves nothing but cards). */
export const MOVE_CARDS_TOOL = "move_cards";

/** The act a move of the cards reports: the twin's arrangement of the dashboard, never a rep's act. */
export const CARDS_MOVED_ACT = "cards_moved";

/** The declared half — the instructions render from it, the registry builds from it. */
export const MOVE_CARDS_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: MOVE_CARDS_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    `Arrange the cards on the rep's dashboard: which card is at the top, and the order of the rest. The dashboard puts \`top\` first and the rest in your order; anything you leave out follows, oldest first. Only cards that wait now can be placed. Your next arrangement replaces this one. With it you may leave an offer on any card you placed: one sentence of yours about what you would do for them on that card, which the rep sees above their composer when they rest on the card, and which a tap asks you to do. Written the way a knock is — the customer as their reference, like ${REFERENCE_EXAMPLE}, at most ${String(KNOCK_MAX)} characters, one line, no link and no figure the card does not already carry. An offer that does not pass is refused and nothing is arranged, so you can write it again. You may also take cards off the dashboard with \`leave\`: the rep stops seeing them there, and they still wait — a draft taken off still sends from its message in the rep's own thread, and the bell still reaches it. A card you took off stays off until you place it again; with every card off, \`top\` is null. It moves cards and nothing else.`,
  inputSchema: {
    type: "object",
    properties: {
      top: {
        type: ["string", "null"],
        description: "The post id of the card at the top; null only when you take every card off.",
      },
      order: {
        type: "array",
        items: { type: "string" },
        description: "The post ids of the other cards, in the order the rep should see them after the top one. Each at most once.",
      },
      offers: {
        type: "array",
        description: "Your offers, at most one per card you placed. Leave it out when you have none.",
        items: {
          type: "object",
          properties: {
            post_id: { type: "string", description: "The post id of a card you placed." },
            sentence: { type: "string", description: "The one sentence the rep sees when they rest on that card." },
          },
          required: ["post_id", "sentence"],
          additionalProperties: false,
        },
      },
      leave: {
        type: "array",
        items: { type: "string" },
        description: "The post ids of cards you take off the rep's dashboard. Leave it out when you take none off.",
      },
    },
    required: ["top", "order"],
    additionalProperties: false,
  },
};

/** The write, bound to this twin and this turn's execution. */
export function moveCardsTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...MOVE_CARDS_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as { top?: unknown; order?: unknown; leave?: unknown };
      const top = given.top ?? null;
      if (top !== null && !isPostId(top)) {
        return refused("`top` is the post id of the card at the top, as the canvas named it.");
      }
      if (!Array.isArray(given.order) || !given.order.every(isPostId)) {
        return refused("`order` is a list of post ids, as the canvas named them.");
      }
      if (given.leave !== undefined && (!Array.isArray(given.leave) || !given.leave.every(isPostId))) {
        return refused("`leave` is a list of post ids, as the canvas named them.");
      }
      const order = top === null ? [...given.order] : [top, ...given.order.filter((id) => id !== top)];
      const repeated = order.find((id, at) => order.indexOf(id) !== at);
      if (repeated !== undefined) {
        return refused(`post ${repeated} is placed twice — each card has one place.`);
      }
      const leave: readonly string[] = given.leave ?? [];
      const both = leave.find((id) => order.includes(id));
      if (both !== undefined) {
        return refused(`post ${both} is both placed and taken off — a card is one or the other.`);
      }
      const waiting = new Set(
        (await readWaiting(feedOf(deps), new Date())).map((post) => post.id),
      );
      const stray = [...order, ...leave].find((id) => !waiting.has(id));
      if (stray !== undefined) {
        return refused(
          `post ${stray} is not a card that waits on the rep now — place or take off only the cards the canvas shows.`,
        );
      }
      const offered = await offersOf(deps, order, (input as { offers?: unknown }).offers);
      if ("refused" in offered) return refused(offered.refused);
      // A CARD STAYS OFF UNTIL THE TWIN PLACES IT AGAIN (ticket #368): the
      // version holds the whole set, the earlier one's cards that still wait
      // and this call's, less any this call placed.
      // ...AND TWO CURATIONS TAKE TURNS (Codex r3): a thread turn and a run's
      // step may write at once, and each rebuilds the set from the version
      // before it, so the second reads the first's under the same lock.
      await deps.db.query("SELECT pg_advisory_xact_lock(hashtextextended('dito:curation:' || $1, 0))", [deps.twinId]);
      const before = (await readCuration(feedOf(deps)))?.left ?? [];
      const left = [...new Set([...before, ...leave])].filter((id) => waiting.has(id) && !order.includes(id));
      await writeCuration(feedOf(deps), {
        twinId: deps.twinId,
        executionId: deps.executionId,
        ...(top === null ? {} : { spotlight: top }),
        order,
        offers: offered.offers,
        left,
      });
      const off = left.length === 0 ? "" : ` ${String(left.length)} card${left.length === 1 ? " is" : "s are"} off the dashboard.`;
      return {
        performed: true,
        act: CARDS_MOVED_ACT,
        told:
          top === null
            ? `The rep's dashboard has no card at the top now.${off}`
            : `The rep's dashboard now starts with post ${top}${order.length > 1 ? ", the rest in your order" : ""}.${off}`,
      };
    },
  });
}

// ─── spotlight ──────────────────────────────────────────────────────────

/** The tool's registered name (ticket #401; ruled by Diego 2026-10-13). */
export const SPOTLIGHT_TOOL = "spotlight";

/** The act a spotlight reports: the twin holding a card up, or ending it. */
export const SPOTLIT_ACT = "spotlit";

/** The declared half — the instructions render from it, the registry builds from it. */
export const SPOTLIGHT_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: SPOTLIGHT_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    "Hold one card up for the rep: on their dashboard it is lifted, the other cards step back, and your mark goes beside it. It stays held up until you spotlight another card, end it with null, or the card leaves their dashboard — sent, discarded, lapsed or taken off. The rep moving your mark around never ends it. Only a card the canvas shows can be held up. It changes no card's place: that is move_cards.",
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: ["string", "null"],
        description: "The post id of the card to hold up, as the canvas named it; null ends the spotlight.",
      },
    },
    required: ["post_id"],
    additionalProperties: false,
  },
};

/** The write, bound to this twin and this turn's execution. */
export function spotlightTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...SPOTLIGHT_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as { post_id?: unknown };
      const postId = given.post_id ?? null;
      if (postId !== null && !isPostId(postId)) {
        return refused("`post_id` is the post id of a card, as the canvas named it, or null.");
      }
      if (postId !== null) {
        const waiting = new Set((await readWaiting(feedOf(deps), new Date())).map((post) => post.id));
        const left = new Set((await readCuration(feedOf(deps)))?.left ?? []);
        if (!waiting.has(postId) || left.has(postId)) {
          return refused(
            `post ${postId} is not a card on the rep's dashboard now — hold up only a card the canvas shows them.`,
          );
        }
      }
      await writeSpotlight(feedOf(deps), { twinId: deps.twinId, executionId: deps.executionId, postId });
      return {
        performed: true,
        act: SPOTLIT_ACT,
        told: postId === null ? "Nothing is held up on the rep's dashboard now." : `Post ${postId} is held up on the rep's dashboard.`,
      };
    },
  });
}

/**
 * THE LEAN-IN OFFERS AN ARRANGEMENT CARRIES, FENCED — or why not, as a sentence
 * the model can act on (ticket #322; spec #318 decision 32).
 *
 * A KNOCK'S FENCE, because it is a knock's kind of sentence about one card
 * shown to the rep unasked: the customer only as that card's slot, which code
 * fills with the card's own name, a name typed out refused, one line of at
 * most `KNOCK_MAX`, no link, no number the card does not carry (`acceptsKnock`).
 * One offer per card, and only on a card this curation placed — so the pill
 * can never raise a sentence about a card other than the one the rep rests on.
 */
async function offersOf(
  deps: ThreadDeps,
  placed: readonly string[],
  given: unknown,
): Promise<{ readonly offers: readonly CurationOffer[] } | { readonly refused: string }> {
  if (given === undefined) return { offers: [] };
  if (
    !Array.isArray(given) ||
    !given.every(
      (offer: unknown) =>
        offer !== null &&
        typeof offer === "object" &&
        isPostId((offer as { post_id?: unknown }).post_id) &&
        typeof (offer as { sentence?: unknown }).sentence === "string",
    )
  ) {
    return { refused: "`offers` is a list of offers, each a card's `post_id` and its `sentence`." };
  }
  const offers = given as readonly { post_id: string; sentence: string }[];
  const customers = deps.served.customers;
  const posts = await readPostsByIds(
    feedOf(deps),
    offers.map((offer) => offer.post_id),
    new Date(),
  );
  const fenced: CurationOffer[] = [];
  for (const offer of offers) {
    if (!placed.includes(offer.post_id)) {
      return {
        refused: `the offer on post ${offer.post_id} is about a card this choice does not place — offer only on the cards you placed.`,
      };
    }
    if (fenced.some((kept) => kept.postId === offer.post_id)) {
      return { refused: `post ${offer.post_id} has two offers — each card has one.` };
    }
    const typed = typedReferencedName(offer.sentence, customers);
    if (typed !== undefined) {
      return {
        refused: `the offer on post ${offer.post_id} types the name "${typed}" beside the reference that already names them: write only the reference and code puts the name in.`,
      };
    }
    const post = posts.get(offer.post_id);
    const own = post === undefined ? undefined : parseReference(post.customer);
    if (referencesIn(offer.sentence).some((reference) => reference !== own || customers(reference) === undefined)) {
      return {
        refused: `the offer on post ${offer.post_id} names somebody that card is not about — name only the card's own customer, by their reference.`,
      };
    }
    const mentions = mentionsIn(offer.sentence, customers);
    if (post === undefined || !acceptsKnock(renderNames(offer.sentence, mentions), announcedTextOf(post))) {
      return {
        refused: `the offer on post ${offer.post_id} was refused: it must be one line of at most ${String(KNOCK_MAX)} characters, with no link and no figure the card does not carry.`,
      };
    }
    // KEPT AS THE TWIN WROTE IT, with the customers it names (ticket #404): a
    // page draws the names and the marks the way it draws every line of the
    // twin's, so the sentence is never a rendered string with its marks left in.
    fenced.push({ postId: offer.post_id, sentence: offer.sentence, ...(mentions.length === 0 ? {} : { mentions }) });
  }
  return { offers: fenced };
}

// ─── knock ──────────────────────────────────────────────────────────────

/** The tool's registered name. */
export const KNOCK_TOOL = "knock";

/** The declared half — the instructions render from it, the registry builds from it. */
export const KNOCK_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: KNOCK_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    `Tell the rep's phone about a card that waits on them: a draft for a customer, a question you asked, or the day's notes while their lines can still be taken back. The sentence is what their lock screen shows, the way a coworker would say it in passing — what it is and who it is for, the customer written as their reference, like ${REFERENCE_EXAMPLE}, so code puts the name in. Under ${String(KNOCK_MAX)} characters, one line, no link and no figure the card does not already carry. A card knocks once when it lands, and once more each time it is about to lapse — when an expiring event names it; a card that announced itself when it landed already has its landing knock. A dashboard already open on its home page keeps quiet on its own, so where the rep is looking is never yours to judge.`,
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "The post id of the card, as the canvas or an event named it.",
      },
      sentence: {
        type: "string",
        description: "The one sentence the rep's lock screen shows.",
      },
    },
    required: ["post_id", "sentence"],
    additionalProperties: false,
  },
};

/** What the model is told when a knock is not added. */
const KNOCK_REFUSALS: Readonly<Record<KnockRefusal, string>> = {
  unknown_post: "no post of yours has that id.",
  not_a_hand_off:
    "that post is not a card waiting on the rep — only a draft, a question or the day's notes can be announced.",
  no_longer_waits:
    "that card no longer waits on the rep — it was sent, discarded or answered — so there is nothing to tell their phone.",
  already_knocked:
    "that card has already had its knock, and nothing about it is lapsing now, so the rep's phone hears nothing more about it.",
  names_another:
    "the sentence names a customer that card is not about — name only the card's own customer, by their reference.",
  sentence_refused: `the sentence was refused: it must be one line under ${String(KNOCK_MAX)} characters, with no link and no figure the card does not carry. The card still waits; you may write the sentence again.`,
};

/** The write, bound to this twin and this turn's execution. */
export function knockTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...KNOCK_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const given = input as { post_id?: unknown; sentence?: unknown };
      if (!isPostId(given.post_id)) {
        return refused("`post_id` is the post id of the card, as the canvas or an event named it.");
      }
      if (typeof given.sentence !== "string") {
        return refused("`sentence` is the one sentence the rep's lock screen shows.");
      }
      // A NAME IS A REFERENCE HERE AS EVERYWHERE, AND CODE FILLS IT before
      // the fence reads the sentence: the lock screen shows the name, never a
      // bare reference. A reference that names nobody costs the knock.
      const customers = deps.served.customers;
      const unnamed = referencesIn(given.sentence).find(
        (reference) => customers(reference) === undefined,
      );
      if (unnamed !== undefined) {
        return refused(
          `the sentence carries ${writeReference(unnamed)}, which names no customer — use the card's own customer's reference or no name at all.`,
        );
      }
      // ...AND A NAME TYPED BESIDE ITS REFERENCE IS REFUSED, so the only names
      // a lock screen carries are code's (Codex r3 on #320).
      const typed = typedReferencedName(given.sentence, customers);
      if (typed !== undefined) {
        return refused(
          `the sentence types the name "${typed}" beside the reference that already names them: write only the reference and code puts the name in.`,
        );
      }
      const mentions: readonly Mention[] = mentionsIn(given.sentence, customers);
      const knock = {
        sentence: renderNames(given.sentence, mentions),
        customers: mentions.map((mention) => mention.reference),
      };
      // THE DRAFT THIS TURN HOLDS (ticket #358): its post lands when the turn
      // ends, under the id `create_draft` named, so the knock passes the
      // landed card's floors read off the held one and is held with it; the
      // landing writes both in one transaction (`landDraft`).
      const held = deps.draft.held;
      if (held !== undefined && held.postId === given.post_id) {
        const refusal = refusalOnHeldDraft(held, deps.bundle, knock);
        if (refusal !== undefined) return refused(KNOCK_REFUSALS[refusal]);
        deps.draft.knock(knock);
        return {
          performed: true,
          act: "knocked",
          told: `The rep's phone will be told about post ${given.post_id} when it reaches them, as this turn ends.`,
        };
      }
      const outcome = await addKnock(
        { ...feedOf(deps), executionId: deps.executionId },
        { postId: given.post_id, ...knock },
        new Date(),
      );
      if (!outcome.knocked) return refused(KNOCK_REFUSALS[outcome.refusal]);
      return {
        performed: true,
        act: "knocked",
        told: `The rep's phone will be told about post ${given.post_id}.`,
      };
    },
  });
}

// ─── say_on_card ────────────────────────────────────────────────────────

/** The tool's registered name. */
export const SAY_ON_CARD_TOOL = "say_on_card";

/** The declared half — the instructions render from it, the registry builds from it. */
export const SAY_ON_CARD_DECLARATION: Omit<GatedEffectToolDeclaration, "run"> = {
  name: SAY_ON_CARD_TOOL,
  gate: "disclosed-and-undoable-after",
  description:
    `Say one sentence of yours on one of your cards that waits on the rep. It appears under the card's own text, where they are looking, and stays in today's conversation as one of your lines; your next sentence on the same card takes its place there. It is how you answer when the rep brings you to a card — a summons — and only then: on any other turn it is refused, and what you have to say goes in your line. Write it as you would say it standing beside them, about that card, a customer as their reference, like ${REFERENCE_EXAMPLE}, so code puts the name in. It reaches no phone and changes nothing on the card. Once it is said your turn ends there: the sentence on the card is all you say.`,
  inputSchema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "The post id of the card, as the canvas or an event named it.",
      },
      sentence: {
        type: "string",
        description: "The one sentence shown under the card's text.",
      },
    },
    required: ["post_id", "sentence"],
    additionalProperties: false,
  },
  // THE SENTENCE IS THE TURN'S WHOLE ANSWER (ticket #401): said, the turn ends
  // on it, so the SDK never asks the model for a line after it.
  endsTurn: true,
};

/**
 * THE CARD THE REP BROUGHT THE TWIN TO, or nothing (ticket #384, ruled
 * 2026-10-10): the twin speaks beside a card only on a turn a summons woke,
 * and only on that card; on its own it speaks in the bar. The day's session is
 * told its tools once, when its child opens (`Session`'s shape), so every turn
 * lists `say_on_card`; this is where a turn nobody summoned is answered that
 * it was not given it — off the turn's trigger, never off anything the model
 * wrote.
 */
function summonedCard(deps: Pick<ThreadDeps, "trigger">): string | undefined {
  return deps.trigger.kind === "twin_thread_event" && deps.trigger.event === "summons"
    ? deps.trigger.postId
    : undefined;
}

/** What a turn nobody summoned is told when it reaches for a card. */
const UNSUMMONED =
  "you speak on a card only when the rep brought you to it, on a turn a summons began; this turn was not one, so say it in your line.";

/** The write, bound to this twin and this turn's execution. */
export function sayOnCardTool(deps: ThreadDeps): GatedEffectToolDeclaration {
  return defineTool({
    ...SAY_ON_CARD_DECLARATION,
    run: async (input: unknown): Promise<EffectOutcome> => {
      const summoned = summonedCard(deps);
      if (summoned === undefined) return refused(UNSUMMONED);
      const given = input as { post_id?: unknown; sentence?: unknown };
      if (!isPostId(given.post_id)) {
        return refused("`post_id` is the post id of the card, as the canvas or an event named it.");
      }
      if (typeof given.sentence !== "string" || given.sentence.trim() === "") {
        return refused("`sentence` is the one sentence shown under the card's text.");
      }
      const postId = given.post_id;
      const waiting = await readWaiting(feedOf(deps), new Date());
      if (!waiting.some((post) => post.id === postId)) {
        return refused(
          `post ${postId} is not a card of yours that waits on the rep now — say it on a card the canvas shows.`,
        );
      }
      // ...AND ONLY ON THE CARD THEY BROUGHT IT TO (Codex r1).
      if (postId !== summoned) {
        return refused(
          `the rep brought you to post ${summoned}, so a sentence on a card goes there; anything about post ${postId} goes in your line.`,
        );
      }
      // A NAME IS A REFERENCE HERE AS EVERYWHERE, AND CODE FILLS IT: one that
      // names nobody has no name to draw, and the rep would read the bracket.
      const customers = deps.served.customers;
      const unnamed = referencesIn(given.sentence).find((reference) => customers(reference) === undefined);
      if (unnamed !== undefined) {
        return refused(
          `the sentence carries ${writeReference(unnamed)}, which names no customer — use a customer's reference from what you were shown, or no name at all.`,
        );
      }
      await insertPost(deps.db, {
        twinId: deps.twinId,
        dek: deps.dek,
        parts: [prosePart(given.sentence, mentionsIn(given.sentence, customers))],
        executionId: deps.executionId,
        asked: { door: "dashboard", unasked: true, onPostId: postId },
      });
      return {
        performed: true,
        act: SAID_ON_CARD_ACT,
        told: `Your sentence is under post ${postId}, where the rep is.`,
      };
    },
  });
}

/** A write that did not happen, told to the model as feedback it can act on. */
function refused(why: string): EffectOutcome {
  return { performed: false, told: `refused: ${why}` };
}

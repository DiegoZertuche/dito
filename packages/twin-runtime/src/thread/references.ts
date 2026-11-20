/**
 * HOW THE TWIN THREAD NAMES A CUSTOMER (ticket #321; spec #318 decision 18;
 * D15, ruled 2026-09-28; ADR-0037, ADR-0039 and ADR-0013 as amended;
 * CONTEXT.md *Reference*).
 *
 * ONE REFERENCE PER CUSTOMER, ALL DAY LONG. The bundle gives every customer
 * the twin can name one small number of its own (`customer_references`), and
 * the twin writes it `[c7]` wherever it speaks of them — in the prose the rep
 * reads and in every tool argument. A reference from the morning and one from
 * the afternoon sit in the same day's conversation and name the same row, so
 * «el segundo» and «otro así» hours later land on the customer the twin
 * already holds; nothing is re-served and nothing is numbered per run.
 *
 * WHICH CARD WORDS OPEN IS THE TWIN'S (ticket #401; Diego, 2026-10-13): it
 * marks the words that mean a card — a name or any short run of words —
 * `[[c7]](<post id>)`, `[el segundo intento](<post id>)`, and the dashboard
 * links those words to exactly that card while it is on the canvas, and the
 * mark goes there as the line plays back. Unmarked words are plain. Code
 * chooses no card.
 *
 * THE SPELLING IS A LETTER AND THE NUMBER, IN SINGLE BRACKETS IN PROSE.
 * Short, so the model copies it without a slip and a reply streams it
 * cleanly; a letter, so it can never be read as a citation's per-turn number
 * or a quantity in a sentence; brackets, so the bar's preview can hold back a
 * half-typed one and the renderer finds every whole one. In a tool argument
 * the same token travels bare or bracketed — `c7` and `[c7]` are one
 * reference.
 *
 * CODE RENDERS THE NAME. A reference resolves through the bundle to the name
 * the rep confirmed — or, for a chat nobody has confirmed, to the name the
 * phone offered with the provisional mark — and to the number's tail only
 * where the customer has more than one chat. The twin never types a name the
 * record holds, and a reference that resolves to no row sends the call
 * back: that is the one check left on a reference.
 */
import type { Bundle } from "@dito/bundle";
import { markInProse, referenceInProse } from "@dito/seam";
import { counterpartyName } from "../grammar.js";
import type { Mention } from "../posts.js";

/** The letter a reference is spelled with. */
const LETTER = "c";

/** A reference written into prose, as a fresh pattern (`referenceInProse`). */
export function referencePattern(): RegExp {
  return referenceInProse();
}

/** A reference as it travels in a tool argument: `c7`. */
export function spellReference(number: number): string {
  return `${LETTER}${String(number)}`;
}

/** ...and as the twin writes it in prose: `[c7]`. */
export function writeReference(number: number): string {
  return `[${spellReference(number)}]`;
}

/** The reference the instructions show, so the grammar is written down once. */
export const REFERENCE_EXAMPLE = writeReference(7);

/** ...and marked with a card, the name opening that card (ticket #401; `markInProse`). */
export const MARKED_REFERENCE_EXAMPLE = `[${writeReference(7)}](<post id>)`;

/**
 * A reference out of a tool argument, bare or bracketed, or nothing when the
 * value is not one.
 */
export function parseReference(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(?:c(\d+)|\[\s*c(\d+)\s*\])$/iu.exec(value.trim());
  return match === null ? undefined : Number(match[1] ?? match[2]);
}

/** The references a piece of prose carries, each once, in the order written. */
export function referencesIn(prose: string): readonly number[] {
  return [
    ...new Set([...prose.matchAll(referencePattern())].map((match) => Number(match[1]))),
  ];
}

/** ...and the prose with every reference taken out, and every mark down to its words: what the model TYPED. */
export function withoutReferences(prose: string): string {
  return unmarked(prose).replace(referencePattern(), " ");
}

/** The prose with every mark down to its words (ticket #401): what any reader reads, no card in it. */
export function unmarked(prose: string): string {
  return prose.replace(markInProse(), (_written, words: string) => words);
}

/** The cards the prose marks, in the order written (ticket #401). */
export function marksIn(prose: string): readonly string[] {
  return [...prose.matchAll(markInProse())].map((match) => match[2]!);
}

/**
 * THE PROSE WITH A MARK KEPT ONLY WHILE ITS CARD IS ON THE CANVAS (ticket
 * #401): `[words](<id>)` stays as the twin wrote it when `onCanvas` holds the
 * id, and reads as the words alone — plain — when the card was sent,
 * dismissed or taken off. Rendering, resolved at each read; the sealed words
 * are never rewritten.
 */
export function keepMarksOn(prose: string, onCanvas: ReadonlySet<string>): string {
  return prose.replace(markInProse(), (written, words: string, card: string) => (onCanvas.has(card) ? written : words));
}

/** One chat of a customer's, and its number's last four digits where it has a number. */
export interface CustomerChat {
  readonly chatJid: string;
  readonly tail?: string;
}

/**
 * A customer as code renders them.
 *
 * `entityId` IS PRESENT EXACTLY WHEN THE REP CONFIRMED THEM. A chat nobody
 * has confirmed is still somebody the twin may talk about — with the mark —
 * and may ask about, but never somebody it may write to or offer as a choice.
 */
export interface Customer {
  readonly reference: number;
  readonly entityId?: string;
  /** The name itself: the one the rep confirmed, or the one the phone offered. */
  readonly name: string;
  /** The name as the rep reads it: unmarked when confirmed, marked otherwise. */
  readonly shown: string;
  /** Their chats, in the order the rep confirmed them; one for an unconfirmed chat. */
  readonly chats: readonly CustomerChat[];
  /**
   * For a chat nobody has confirmed: the other side's messages written under
   * `name`, newest first — what its binding question can rest on.
   */
  readonly anchors: readonly string[];
}

/** A run's way from a reference to the customer it names. */
export type Customers = (reference: number) => Customer | undefined;

/**
 * How many of a chat's newest push-named messages are read to name it.
 * Enough to find the current name and a handful of messages to anchor a
 * question on; the name is the newest one the other side wrote under.
 */
const PUSH_NAME_WINDOW = 20;

/**
 * The bundle's references, read once per reference per run.
 *
 * ONE READING PER RUN, which is why it is memoized: the guard judges the
 * string the rep will read and the renderer writes it, so the two must see one
 * name for one reference even if the bundle moved between them.
 *
 * THE REP'S OWN THREAD IS NOBODY'S CUSTOMER, so a reference to it — which no
 * path gives, but a row could name — resolves to nothing.
 */
export function customersOf(
  bundle: Pick<
    Bundle,
    "readReference" | "chatsOfEntity" | "readChatBinding" | "pushNamesFromOtherSide"
  >,
  selfChatJid: string,
): Customers {
  const read = new Map<number, Customer | undefined>();
  return (reference) => {
    if (!read.has(reference)) read.set(reference, customerOf(bundle, selfChatJid, reference));
    return read.get(reference);
  };
}

function customerOf(
  bundle: Pick<
    Bundle,
    "readReference" | "chatsOfEntity" | "readChatBinding" | "pushNamesFromOtherSide"
  >,
  selfChatJid: string,
  reference: number,
): Customer | undefined {
  const row = bundle.readReference(reference);
  if (row === undefined) return undefined;
  if ("entityId" in row) {
    const chats = bundle.chatsOfEntity(row.entityId);
    const first = chats[0];
    if (first === undefined) return undefined;
    return {
      reference,
      entityId: row.entityId,
      name: first.displayName,
      shown: first.displayName,
      chats: chats.map((chat) => chatOf(chat.chatJid)),
      anchors: [],
    };
  }
  if (row.chatJid === selfChatJid) return undefined;
  const binding = bundle.readChatBinding(row.chatJid);
  if (binding !== undefined) return undefined;
  const named = bundle.pushNamesFromOtherSide(row.chatJid, PUSH_NAME_WINDOW);
  const pushName = named[0]?.pushName;
  const shown = counterpartyName({
    confirmedName: undefined,
    pushName,
    senderJid: row.chatJid,
  });
  return {
    reference,
    name: pushName ?? row.chatJid.split("@")[0] ?? row.chatJid,
    shown,
    chats: [chatOf(row.chatJid)],
    anchors: named.filter((one) => one.pushName === pushName).map((one) => one.messageId),
  };
}

/** A chat, with its number's tail where it has a number. */
function chatOf(chatJid: string): CustomerChat {
  const tail = tailOf(chatJid);
  return tail === undefined ? { chatJid } : { chatJid, tail };
}

/**
 * The last four digits of a chat's number, or nothing.
 *
 * A LID-ADDRESSED CHAT HAS NONE: a LID is an identifier the phone assigns and
 * its digits are not a number anybody could recognise (`feed.ts`'s
 * `chatNumberOf` states the rule for the card).
 */
export function tailOf(chatJid: string): string | undefined {
  const [user, server] = chatJid.split("@");
  if (server !== "s.whatsapp.net" || user === undefined || user.length < 4) return undefined;
  return user.slice(-4);
}

/**
 * THE TAILS A CUSTOMER'S NAME CARRIES: none for a customer with one chat, and
 * every chat's that has a number for a customer with more than one — the one
 * case where a name alone does not say which of their numbers is meant.
 */
export function tailsOf(customer: Customer): readonly string[] {
  if (customer.chats.length < 2) return [];
  return customer.chats.flatMap((chat) => (chat.tail === undefined ? [] : [chat.tail]));
}

/**
 * The customers a piece of prose names, as the post seals them: each
 * reference once, with the name code renders and its tails.
 *
 * A REFERENCE THAT RESOLVES TO NOTHING IS LEFT OUT here and refused by the
 * contract, which runs first (`guard.ts`); `renderNames` is what notices.
 */
export function mentionsIn(prose: string, customers: Customers): readonly Mention[] {
  return referencesIn(prose).flatMap((reference) => {
    const customer = customers(reference);
    return customer === undefined ? [] : [mentionOf(customer)];
  });
}

/** One customer as a post's mention. */
export function mentionOf(customer: Customer): Mention {
  const tails = tailsOf(customer);
  return {
    reference: spellReference(customer.reference),
    name: customer.shown,
    ...(tails.length === 0 ? {} : { tails }),
    ...(customer.entityId === undefined ? {} : { entityId: customer.entityId }),
  };
}

/**
 * A name as the phone reads it: the name, and the tails after it in
 * parentheses — `Torres (…8416, …0537)` — digits and punctuation, so it reads
 * the same in any language the rep writes in. No tails, the name alone.
 */
export function withTails(name: string, tails: readonly string[] | undefined): string {
  return tails === undefined || tails.length === 0
    ? name
    : `${name} (${tails.map((tail) => `…${tail}`).join(", ")})`;
}

/** A mention as the phone reads it. */
export function phoneName(mention: Mention): string {
  return withTails(mention.name, mention.tails);
}

/**
 * Every reference in some prose replaced by what `fill` makes of it — the one
 * walk the renderers, the twin's read-back and the guard share. `fill` gets
 * the reference as written and its number.
 */
export function replaceReferences(
  prose: string,
  fill: (written: string, reference: number) => string,
): string {
  // A MARK IS NOTHING A READER SEES (ticket #401): its words stand, its card goes.
  return unmarked(prose).replace(referencePattern(), (written, digits: string) => fill(written, Number(digits)));
}

/**
 * THE PROSE WITH EVERY REFERENCE REPLACED BY ITS NAME, as the phone and the
 * twin's own record read it.
 *
 * A REFERENCE THE MENTIONS DO NOT HOLD THROWS: the contract refused every
 * reference that resolves to nothing before anything renders, so one here is
 * the guard and the renderer disagreeing — and leaving it would show the rep
 * `[c12]`.
 */
export function renderNames(prose: string, mentions: readonly Mention[]): string {
  const byReference = new Map(mentions.map((mention) => [mention.reference, mention] as const));
  return replaceReferences(prose, (written, reference) => {
    const mention = byReference.get(spellReference(reference));
    if (mention === undefined) {
      throw new Error(
        `the prose carries ${written}, which names no customer — the contract should have refused it (ticket #321)`,
      );
    }
    return phoneName(mention);
  });
}

/**
 * THE PROSE AS THE TWIN READS IT BACK — each reference kept, its name beside
 * it: `[c7] Torres`. What the twin reads of its own earlier words carries the
 * reference it wrote, so it can write the same one again.
 */
export function annotateNames(prose: string, mentions: readonly Mention[]): string {
  const byReference = new Map(mentions.map((mention) => [mention.reference, mention] as const));
  // THE MARKS STAY (ticket #401): the twin reads back the cards it marked.
  return prose.replace(referencePattern(), (written, digits: string) => {
    const mention = byReference.get(spellReference(Number(digits)));
    return mention === undefined ? written : `${written} ${phoneName(mention)}`;
  });
}

/** One customer as a tool result prints them: `[c7] Torres`. */
export function customerLine(customer: Customer): string {
  return `${writeReference(customer.reference)} ${customer.shown}`;
}

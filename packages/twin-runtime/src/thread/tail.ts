/**
 * YESTERDAY'S TAIL, CARRIED INTO TODAY'S SESSION (ticket #319; spec #318
 * decision 1; design §3.1).
 *
 * A new day's session opens with one user message holding the last lines the
 * rep and the twin said to each other before it — word for word, marked as
 * carried over, nothing summarised — so «¿dónde quedamos?» at 08:00 has an
 * answer. Older days are reached by search (#320), never by a longer tail.
 *
 * BUILT FROM THE DOORS' OWN RECORDS, never from the previous session's file:
 * the rep's self-chat lines in the bundle's conversation store, the twin's replies
 * the executor posted there, and the bar's sealed messages with the answers
 * posted at the door — the rows each door already keeps (spec #318 decision
 * 13). The SDK's session read API resolves a file's location from the CALLING
 * process's environment rather than the child's (spike #290 fact 2), so
 * nothing the runtime relies on is built on it.
 *
 * ONLY WHAT THE TWO OF THEM SAID: a rep's line and the twin's reply to one.
 * Never a draft's body, never a customer's words — a draft is a card the rep
 * acts on, not a thing either of them said in the thread, and nothing a
 * customer writes is pushed into the thread (spec #318 decision 12).
 */
import { renderTurnInstant } from "@dito/execution";

/**
 * How many lines the carried message holds.
 *
 * TWENTY, THE BEATS A CUSTOMER CHAT'S RECENT WINDOW CARRIES (ticket #319): the
 * thread is not carried less of itself than a customer conversation is shown —
 * counted across both sides and both doors, so the morning reads the end of last night's
 * exchange rather than ten lines of the rep talking to themselves. Short
 * enough to cost a fraction of what one search page does.
 */
export const CARRIED_TAIL_ITEMS = 20;

/** One line of the tail, from either door, by either of the two. */
export interface TailItem {
  readonly door: "twin_thread" | "dashboard";
  readonly side: "rep" | "twin";
  readonly at: Date;
  readonly text: string;
}

/**
 * The last `size` items of the two doors' lines, merged by time, oldest
 * first.
 */
export function carriedTail(
  items: readonly TailItem[],
  size: number = CARRIED_TAIL_ITEMS,
): readonly TailItem[] {
  return [...items]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-size);
}

/**
 * The carried message, as the model reads it: what it is, then one line per
 * item tagged with its door, its instant in the seat's zone and who said it.
 * Nothing at all when there is nothing to carry.
 */
export function renderCarriedTail(
  items: readonly TailItem[],
  timeZone: string,
): string | undefined {
  if (items.length === 0) return undefined;
  return [
    "[Carried over: the last lines you and the rep said to each other before this conversation began, word for word, oldest first. They were already dealt with.]",
    ...items.map(
      (item) =>
        `[${DOOR_NAMES[item.door]} · ${renderTurnInstant(item.at, timeZone)}] ${item.side === "rep" ? "the rep" : "you"}: ${item.text}`,
    ),
  ].join("\n");
}

/** The two doors, named as the model reads them (`recipes.ts` uses the same words). */
export const DOOR_NAMES: Readonly<Record<TailItem["door"], string>> = {
  twin_thread: "WhatsApp",
  dashboard: "dashboard",
};

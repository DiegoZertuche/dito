/**
 * THE CHAT, AS THE CLASSIFICATION READS IT (ticket #176; the harness's
 * `renderUserTurn`, moved and not rewritten).
 *
 * BOTH ENDS, BECAUSE THEY ANSWER DIFFERENT HALVES (the harness's own Codex
 * round 2, kept verbatim as the reason). Who a counterparty IS is settled at
 * the OPENING far more often than anywhere else — a first message saying who
 * is speaking and for whom is the whole answer, and a window taken off the
 * tail of a year-old chat drops it entirely, leaving a personal push-name and
 * some recent orders to drive the guess. The recent end is kept anyway
 * because a chat whose opening says nothing may still show what this customer
 * buys and at what scale.
 *
 * WHAT MUST NOT CHANGE, and this file is where it is kept: the two window
 * sizes, the marked gap, and the speaker prefixes. Spec #171 decision 26
 * names the context as "the chat's recent messages", and #176's own contract
 * says the classification decides "from the confirmed name plus that chat's
 * own conversation … the opening and recent tail as today".
 */
import type { ConversationRow } from "@dito/bundle";

/** How much of the chat's opening the judgement gets. */
export const OPENING_MESSAGES = 12;
/** ...and how much of its tail. */
export const RECENT_MESSAGES = 8;

/** One message, as the classification reads it: who spoke, and what they said. */
function line(row: ConversationRow): string {
  return `${row.fromMe ? "rep" : "customer"}: ${row.content}`;
}

/**
 * The conversation as one block, windowed at both ends when it is long.
 *
 * THE GAP IS MARKED RATHER THAN ELIDED SILENTLY: two blocks run together
 * read as one continuous conversation, and the model would take the second
 * block's first line as the answer to the first block's last.
 *
 * Returns `undefined` for a chat twin memory holds nothing for — the recipe
 * says what an absence means rather than rendering an empty block, which is
 * the rule every part of every automation here follows.
 */
export function renderConversationWindow(
  conversation: readonly ConversationRow[],
): string | undefined {
  if (conversation.length === 0) return undefined;
  if (conversation.length <= OPENING_MESSAGES + RECENT_MESSAGES) {
    return `The conversation so far (oldest first):\n${conversation.map(line).join("\n")}`;
  }
  const opening = conversation.slice(0, OPENING_MESSAGES).map(line).join("\n");
  const recent = conversation.slice(-RECENT_MESSAGES).map(line).join("\n");
  const omitted = conversation.length - OPENING_MESSAGES - RECENT_MESSAGES;
  return [
    `How the conversation began (oldest first):\n${opening}`,
    `[…${omitted} messages omitted…]`,
    `The most recent messages:\n${recent}`,
  ].join("\n\n");
}

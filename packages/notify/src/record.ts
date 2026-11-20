/**
 * THE SEND RECORD'S CLOSED VOCABULARIES (ticket #219; ADR-0022).
 *
 * `notify_sends` carries three enumerated columns (ticket #276 added the
 * channel), and Postgres has no "add a value to a CHECK" — a set is extended
 * by DROP + re-CREATE, which is safe
 * on one branch and dangerous on several. So the words live HERE, in the
 * package that writes them, and `migration-vocabulary.test.ts` compares
 * this constant against the last cut of the constraint across every
 * migration. What that catches is the sharp failure for this table: a
 * narrowing re-cut would refuse the settle of a send that has ALREADY gone
 * out, leaving a message in somebody's inbox and an unsettled row that says
 * it might not have.
 *
 * THEY ARE A MODULE OF THEIR OWN so the vocabulary test can read them
 * without taking the service, its connection or the SDK with them.
 */

/**
 * WHICH TRANSPORT ONE ATTEMPT LEFT BY (ticket #276; ADR-0022 as amended).
 *
 * A ROW IS ONE ATTEMPT AT ONE DESTINATION, and this word is half of what
 * identifies the destination — the browser's id is the other half. Before this
 * ticket one row stood for a whole ask: a grave event that mails AND pushes
 * settled its single row on the email's rejection and skipped the push exactly
 * when mail was down, and a later pass found the row and tried neither again.
 *
 * TWO WORDS BECAUSE THERE ARE TWO TRANSPORTS, and a third would be a spine
 * change rather than a value (ADR-0019 pins both at the network layer).
 */
export const NOTIFY_CHANNELS = ["email", "push"] as const;

/** One of the two. */
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** What became of one ask. NULL on the row means still in flight. */
export const NOTIFY_OUTCOMES = ["sent", "refused", "failed"] as const;

/**
 * Why an ask did not become a send — a closed word, never a sentence.
 *
 * `no_email` is the seat's state and not anybody's bug: a seat exists before
 * an address does. `no_subscription` is the same fact one transport along —
 * no browser of this seat has accepted notifications, which is a choice the
 * rep is allowed to make and the reason there is no digest to fall back on
 * (ADR-0031 as amended). `transport_failed` is a provider saying no. Every
 * OTHER refusal this service makes is a caller's bug and writes no row at
 * all, so it needs no word here — see `notify.ts`'s header for the line.
 */
export const NOTIFY_REFUSAL_REASONS = [
  "no_email",
  "transport_failed",
  "no_subscription",
] as const;

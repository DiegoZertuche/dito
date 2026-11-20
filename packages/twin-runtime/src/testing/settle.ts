/**
 * The settle window, off (ticket #75).
 *
 * Drafting batches: a customer chat's new messages wait ~90 seconds of
 * quiet and are then answered by one draft. Every suite written before
 * that asserts the older, per-message shape — inject an inbound, run a
 * pass, read the draft — and none of them is ABOUT batching. Spreading
 * this into their runtime deps says so once and in one place, instead of
 * each suite re-deciding for itself what a window of zero means: a turn
 * settles the instant it is seen, which is exactly the behaviour those
 * suites were written against.
 *
 * The suite that IS about batching (`batching.int.test.ts`) sets its own
 * small window and drives real elapsed time against it, because the
 * predicate under test is one over `wa_events.received_at` and a window of
 * zero would test nothing.
 */
export const SETTLE_IMMEDIATELY = { settleWindowMs: 0 } as const;

-- The near-expiry tier's resume read, given an index to stand on (ticket #276;
-- Codex round 3 on PR #277; ADR-0031 as amended, ADR-0016's latency budget).
--
-- NUMBERING: …20260922100070, after …20260922100060 (the notification fan-out,
-- this same ticket). Forward-only: no migration in this repo is ever edited
-- once it has applied anywhere, because a migration is a statement about what
-- a database has already been through.
--
-- ═══ WHY A SECOND FILE IN ONE TICKET ═══
--
-- …20260922100060 gave the AT-ONCE tier its own partial index for exactly this
-- reason and the near-expiry tier had no read to index at the time. It has one
-- now: `resumeUnsentNudges` asks, on every two-second poll, which of this
-- twin's composed sentences were never delivered — and `nudges` carries only
-- its primary key `(post_id, kind)` and the one-per-execution unique index,
-- neither of which this predicate can use.
--
-- WHAT THAT COSTS WITHOUT THIS FILE is a sequential scan of every twin's
-- nudges, on the pass the rep is waiting on, growing for as long as the
-- deployment lives. The table is append-only and nothing prunes it: a
-- migration cannot make it smaller and the four-hour window bounds the ROWS
-- RETURNED without bounding the rows examined. That is the same hazard
-- `ANNOUNCE_WINDOW_MS` argues one file over, and the same answer.
--
-- THE ORDER IS THE PREDICATE'S. `twin_id` is the equality and `composed_at`
-- the range, so the twin's own rows are contiguous and the window is a seek
-- inside them. Nothing else in the read is selective: `body_enc IS NOT NULL`
-- is true of almost every row, and the kind exclusion takes one word out of
-- three.
--
-- NO PARTIAL PREDICATE, unlike `posts_twin_knock_idx`. There the mark is
-- false for most of the table and the index holds almost nothing; here every
-- row of `nudges` is a candidate until its window passes, so a partial index
-- would be the same index with a clause that stops being true four hours
-- after each write — which is not a thing an index expression can say.
--
-- RE-RUNNABLE. Atlas never re-applies a file; `IF NOT EXISTS` is for an
-- operator replaying it by hand against a database whose revision history
-- says nothing. Creating an index writes no row and changes no value, so the
-- populated replay is a no-op over existing data by construction.

CREATE INDEX IF NOT EXISTS nudges_twin_composed_idx
    ON nudges (twin_id, composed_at);

COMMENT ON INDEX nudges_twin_composed_idx IS
    'Ticket #276: the resume read''s own index — which of this twin''s composed sentences were never delivered, inside the window. The table is append-only and the read runs on every pass, so without it the poll scans every twin''s history for as long as the deployment lives.';

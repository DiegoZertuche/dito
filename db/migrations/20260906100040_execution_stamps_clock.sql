-- Every stamp an execution writes reads the STATEMENT's clock (#200 hotfix 1).
--
-- An execution runs its whole transaction on a borrowed connection and the
-- model round-trips happen INSIDE it (`db-tx.ts`, `lanes.ts`, `tool-savepoints.ts`).
-- Postgres `now()` is the TRANSACTION's start, so every stamp defaulted to it
-- records the instant the transaction began rather than the instant the row
-- was written — early by the execution's whole duration, which on the rig on
-- 2026-09-06 was 2 min 4 s for one extraction: the chain entry, both filed
-- facts, both disclosure lines and the run's settle all read 22:14:53 for
-- work that ended at 22:16:58. Three things are wrong at once.
-- `audit_chain.created_at` stops being the append instant and lands BEFORE
-- the execution record's own `started_at`, so the chain misstates when it was
-- extended (ADR-0020). `ledger.facts.filed_at` is the TRANSACTION-TIME half
-- of a bi-temporal record — when the aperture filed it — and it names an
-- instant before the model had even read the day. And two rows one execution
-- wrote are indistinguishable in time, so a run's duration is unrecoverable
-- from its row and insertion order survives only in the ids.
--
-- WHAT IS NOT AFFECTED, because the rig evidence guessed otherwise and the
-- code says otherwise: the 24-hour correction window. `finalizeDueFacts`
-- cuts `finalized_at` from `min(send_commands.executed_at)` — when a post
-- actually reached the rep — and that stamp is written post-commit by the
-- sequential loop on the real clock. The window opened and closed correctly
-- throughout.
--
-- `clock_timestamp()` IS THE STATEMENT'S WALL CLOCK, and it advances within a
-- transaction — so these stamps become the write instant and, between two
-- rows written by one execution, insertion order. THE TRANSACTION IS NOT
-- SHORTENED and must not be (#194, #195, #205: the record insert, the chain
-- append and the settle are one transaction, with the tools savepointed
-- inside it); the clock is what moves.
--
-- IN SCOPE IS A RULE, NOT A LIST: a column is here when a REP-SIDE EXECUTION
-- writes its row inside the execution's transaction. Everything else keeps
-- `now()`, and each exclusion has a reason. The sequential loop's own rows —
-- `send_commands`, `send_attempts`, `send_executions`, `taps`,
-- `rail_status_events` — are written outside any execution transaction or
-- after it commits, and `send_commands.created_at` is already passed
-- `clock_timestamp()` explicitly by `insertSystemSendCommand`, which is what
-- makes thread order emission order. The seam's ingest (`wa_events`,
-- `wa_event_processing`), the config tables (`scope_allowlist`,
-- `send_allowlist`, `pacing_thresholds`, `twin_keys`) and
-- `runtime_requests.requested_at` are the requester's or the operator's own
-- inserts. `ledger.entity_merges` / `entity_unmerges` are break-glass scripts.
-- The `owner` schema is the far side of the wall (ADR-0031) and not this
-- fix's to touch.
--
-- `disclosure_posts.posted_at` MEETS THE RULE AND IS STILL LEFT AT `now()`,
-- because the column is not only a stamp: `disclosure_post_lines_sealed`
-- (…20260829100025) admits a line only while `p.posted_at = now()`, which is
-- how "this line was written by the transaction that wrote the post" is
-- stated in the store — and ADR-0034's sealed numbering is the record of
-- what the rep saw. Under `clock_timestamp()` that equality can never hold
-- and every disclosure post loses its lines. The post's own stamp being the
-- transaction's start costs nothing that is read: when the rep actually
-- received the post is the send's `executed_at`, real-clock already, and that
-- is the stamp the correction window is cut from. Lifting the exclusion means
-- giving the seal another way to say "one transaction wrote this", which is
-- open on the horizon (#117).
--
-- `aperture_questions.asked_at` IS THE FILING STATEMENT'S CLOCK TWICE OVER
-- (#200 hotfix 1). The default below is the store's own stamp for any writer
-- that leans on it, and `recordQuestion`
-- (`packages/aperture/src/questions.ts`) names the column: it writes
-- `asked_at` and FR-32's `expires_at` from one materialized
-- `clock_timestamp()` reading, so both come off a single instant that no
-- caller supplies.
--
-- NUMBERING: …2026090610004·, after …20260906100030 (the disclosure became an
-- execution). Forward-only: no migration in this repo is ever edited once it
-- has applied anywhere, because a migration is a statement about what a
-- database has already been through.
--
-- THIS FILE NAMES NO ENTITY BEYOND THE LEDGER'S OWN and no chat in any form
-- (binding-wall.test.ts): it re-cuts three Ledger defaults and ten rep-side
-- ones, and adds no column, no constraint and no grant.
--
-- ONE STATEMENT PER COLUMN, on purpose. A DEFAULT is per-column state, the
-- diff reads as the scope list it is, and a column added to the rule later
-- joins by one line rather than by editing a compound statement.

-- The Ledger: what the crossing filed, and when the correction window on it
-- opens (ADR-0004).
ALTER TABLE ledger.facts ALTER COLUMN filed_at SET DEFAULT clock_timestamp();
ALTER TABLE ledger.entities ALTER COLUMN filed_at SET DEFAULT clock_timestamp();
ALTER TABLE ledger.entity_grants ALTER COLUMN granted_at SET DEFAULT clock_timestamp();

-- The chain: `created_at` is the append instant or it is nothing (ADR-0020).
ALTER TABLE audit_chain ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- The rep's thread, as the execution wrote it: the post, the record of which
-- post asked which question, and the day's attempt. `disclosure_posts` is the
-- one column the rule reaches and this file leaves alone; the header says why.
ALTER TABLE notices ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE question_posts ALTER COLUMN posted_at SET DEFAULT clock_timestamp();
ALTER TABLE disclosure_attempts ALTER COLUMN attempted_at SET DEFAULT clock_timestamp();

-- The disclosure's own lines, and the question a below-threshold candidate
-- became.
ALTER TABLE disclosure_lines ALTER COLUMN filed_at SET DEFAULT clock_timestamp();
ALTER TABLE aperture_questions ALTER COLUMN asked_at SET DEFAULT clock_timestamp();

-- The run row, so its span is its span.
ALTER TABLE extraction_runs ALTER COLUMN started_at SET DEFAULT clock_timestamp();

-- What a drafting or a thread execution wrote.
ALTER TABLE drafts ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE draft_dismissals ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE fact_retractions ALTER COLUMN filed_at SET DEFAULT clock_timestamp();

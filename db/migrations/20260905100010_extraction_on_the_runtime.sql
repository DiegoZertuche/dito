-- Extraction becomes an execution (ticket #194; spec #193 decisions 10, 19
-- and 28; ADR-0014 as amended, ADR-0016, ADR-0020).
--
-- NUMBERING: …2026090510001·, after …20260904100020 (the rep side's
-- executions table, #172). Forward-only: no migration in this repo is ever
-- edited once it has applied anywhere, because a migration is a statement
-- about what a database has already been through.
--
-- ONE FILE FOR THREE CHANGES, and they are one change: an extraction run is
-- an execution from this ticket on, so the run row has to be able to NAME the
-- execution, the execution has to be able to end the way an extraction ends,
-- and a run whose execution failed has to be able to say so. Splitting them
-- would leave a migration that grants a column no build can fill beside one
-- that widens a vocabulary nothing writes.
--
-- THIS FILE NAMES NO ENTITY, and that is enforced (binding-wall.test.ts).
-- `extraction_runs` carries a CHAT, which is why …100027 kept it in a file of
-- its own; the two `executions` tables carry neither a chat nor an entity, so
-- naming them beside it adds nothing the wall forbids.
--
-- EVERY CHECK BELOW IS EXTENDED, NEVER NARROWED. Postgres has no "add a value
-- to a CHECK", so each is DROP + re-CREATE carrying everything it already
-- said — the shape `migration-vocabulary.test.ts` watches, in both
-- directions and across files.

-- ── The run row names its execution (spec #193 decision 28) ────────────────
--
-- IT CLOSES …100020's ONE FORWARD POINTER ("`extraction_runs` gains its own
-- in 5b"). That header is left as it stands: a migration's bytes are what
-- `atlas.sum` hashes, so editing an applied file's comment would break the
-- checksum of every deployment that has run it.
--
-- NULLABLE, and that is exact rather than lenient — the rule
-- `notices.execution_id` and `draft_timings.execution_id` already state
-- (…100020). Every run written before this migration was produced by a
-- harness, not by an execution, so there is no execution for those rows to
-- name and inventing one would be a claim about history. The rig carries its
-- runs across slices, so those rows are real and they stay NULL. A `deferred`
-- run stays NULL for a second and better reason: an unbound chat gets the
-- pass's binding proposal and NO execution at all (FR-32; spec #193 decision
-- 9), so there is nothing to point at.
ALTER TABLE extraction_runs
    ADD COLUMN execution_id uuid REFERENCES executions (id);

COMMENT ON COLUMN extraction_runs.execution_id IS
    'The execution that read this chat''s day, when one did (ticket #194). NULL for every run written before extraction ran on the shared runtime, and for a deferred run — an unbound chat gets the pass''s binding proposal and no execution (FR-32).';

-- The join a boundary session makes: this run's execution, and back again.
-- One row each way, so a plain index on the reference is what the FK check
-- and the report both read.
CREATE INDEX extraction_runs_execution_idx
    ON extraction_runs (execution_id);

-- ── The fourth state: `failed` (spec #193 decision 10) ─────────────────────
--
-- A failed batch execution is RECORDED AND THE LANE MOVES ON. It writes its
-- execution record and its chain entry; this row settles `failed`; the loop
-- continues; and the chat is NOT read again that day — `claimRun` excludes
-- `failed` exactly as it excludes `filed`, so one bad chat costs a day rather
-- than a model call every two seconds.
--
-- NOTHING IS LOST BY WAITING. The next day's window already reaches back
-- seven days for anything unfiled (`windowFor`), and only a `filed` run
-- advances the watermark — so tomorrow's pass reads the same messages a day
-- late.
--
-- AND THE DISCLOSURE STILL POSTS. The pass's `settled` result counts a failed
-- run as settled (spec #193 decision 10), so one chat the model would not
-- read cannot silence the day's post for every other chat.
ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_state_check;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_state_check
        CHECK (state IN ('submitted', 'filed', 'deferred', 'failed'));

COMMENT ON COLUMN extraction_runs.state IS
    'submitted — claimed and handed to an execution, nothing filed. filed — the candidates the aperture accepted are filed with their disclosure lines; terminal. deferred — in scope with traffic but UNBOUND, so it got the binding proposal and no execution (FR-32). failed — the execution produced no submission, so nothing was filed and the chat is not read again today (ticket #194; spec #193 decision 10).';

-- `extraction_runs_settled_check` is NOT re-cut, and its shape is why:
-- `(state = 'submitted') = (settled_at IS NULL)` says one thing about
-- `submitted` rather than enumerating the other states, so `failed` is
-- covered by it already — settled, with an instant, like `filed` and
-- `deferred`.

-- A FAILED RUN FILED NOTHING, the way a deferred one read nothing. The
-- execution ended with no submission the contract accepted, so no candidate
-- ever reached the aperture: every counter is zero, and `messages` stays free
-- because the run DID read a window and its size is what a reader needs to
-- know how much is owed to tomorrow.
ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_failed_files_nothing CHECK (
        state <> 'failed'
        OR (candidates = 0 AND filed = 0 AND below_threshold = 0
            AND unresolved_reference = 0 AND refused = 0)
    );

-- ── The disposition set: eight words to ten (spec #193 decision 19) ────────
--
-- `filed` and `nothing-to-file` are how an extraction execution ends, and
-- they are the aperture's two ordinary outcomes seen from the RUNTIME's side:
-- the model came back with candidates to file, or it came back with an empty
-- list, which the contract calls a normal day and a better one than a guess.
-- Neither is `no-action` — an extraction that found nothing DID the work and
-- read the day — and neither is `answered`, because nobody was answered.
--
-- BOTH TABLES, IN ONE FILE, because they are one vocabulary
-- (`migration-vocabulary.test.ts` asserts the two sets are equal): a
-- migration that widened one and forgot the other would leave two stores
-- disagreeing about how an execution may end.
ALTER TABLE executions
    DROP CONSTRAINT executions_disposition_check;

ALTER TABLE executions
    ADD CONSTRAINT executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file'));

COMMENT ON COLUMN executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified · filed · nothing-to-file (spec #171 decision 11; spec #193 decision 19). Widened, never narrowed; the rep side writes drafted, no-action, acted, classified, filed, nothing-to-file and failed.';

ALTER TABLE owner.executions
    DROP CONSTRAINT owner_executions_disposition_check;

ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file'));

COMMENT ON COLUMN owner.executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified · filed · nothing-to-file (spec #171 decision 11). Widened at #178 and #194, never narrowed. FR-48''s failed-query log is a count over this column; the owner side writes only the first five.';

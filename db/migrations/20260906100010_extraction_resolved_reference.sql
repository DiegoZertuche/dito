-- The third reading, counted (ticket #196; spec #193 decisions 18 and 19;
-- ADR-0034, ADR-0039 as amended).
--
-- Extraction looks before it files. When a customer's message points at
-- something the day does not spell out, the execution searches the rep's own
-- history; if exactly one referent turns up, the candidate is filed with the
-- goods that referent named and the model says so by reading it
-- `resolved_reference`. Two differing referents, or none, are still
-- `unresolved_reference` and still dropped.
--
-- ONE FILE, ONE COLUMN, because there is one change: the run row has to be
-- able to say HOW OFTEN LOOKING PAID. Without it a build where the tools
-- resolve nothing is indistinguishable from one where they resolve
-- constantly — the same hole `unresolved_reference` was added to close for
-- the drop (…20260830100090), and the same answer.
--
-- NUMBERING: …2026090610001·, after …20260905100010 (extraction became an
-- execution, #194). The request channel (#197) takes …2026090610002·, so the
-- two branches in flight order the same way whichever merges first.
-- Forward-only: no migration in this repo is ever edited once it has applied
-- anywhere, because a migration is a statement about what a database has
-- already been through.
--
-- THIS FILE NAMES NO ENTITY, and that is enforced (binding-wall.test.ts).
-- `extraction_runs` carries a CHAT, which is why …100027 kept it in a file of
-- its own and why this one touches nothing else.
--
-- NOTHING ABOUT THE REFERENT IS STORED, HERE OR ANYWHERE. This is a COUNT.
-- Which order, which chat and which message the resolution came from are
-- never written down — not in the fact payload, not on the disclosure line,
-- not on this row (ADR-0004: owner-visible provenance is the day's own
-- message, and the line the rep reads carries a generic code-rendered mark).
--
-- EVERY CHECK BELOW IS EXTENDED, NEVER NARROWED. Postgres has no "add a term
-- to a CHECK", so each is DROP + re-CREATE carrying everything it already
-- said. A row written by a build that predates this column carries the
-- column's DEFAULT 0 and satisfies all three unchanged.

ALTER TABLE extraction_runs
    -- Every candidate the model read as a RESOLVED reference, whichever door
    -- the aperture then sent it out of. The four counters below are what say
    -- which: a resolved candidate that filed is counted here and under
    -- `filed`, because these are two different questions about one candidate.
    ADD COLUMN resolved_reference integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN extraction_runs.resolved_reference IS
    'Candidates the extraction RESOLVED by looking — it searched the rep''s own history, found exactly one referent, and wrote the goods that referent named (ticket #196; CANDIDATE_READINGS'' resolved_reference). Counted so the price of looking has a denominator: this is the only place the resolution RATE can be read, and it is the pair of `unresolved_reference`, which counts the ones that stayed unresolvable and were dropped. It counts every candidate under that reading whatever became of it — `filed`, `below_threshold` and `refused` are what say which. It names nothing about the referent: the column is a count.';

-- A SECOND AXIS, NOT A SIXTH OUTCOME, and that is why it is not a term in the
-- inequality below. `filed`, `below_threshold`, `unresolved_reference` and
-- `refused` partition what the APERTURE did with a candidate; this one says
-- how the MODEL read it, and a resolved candidate that filed is correctly
-- counted in both. Adding it to the sum would make the constraint refuse
-- exactly the rows this ticket exists to produce. It is bounded by
-- `candidates` instead, which is the true statement about it.
ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_counts_check;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_counts_check CHECK (
        messages >= 0 AND candidates >= 0 AND filed >= 0
        AND below_threshold >= 0 AND unresolved_reference >= 0
        AND refused >= 0
        AND filed + below_threshold + unresolved_reference + refused
            <= candidates
        AND resolved_reference >= 0
        AND resolved_reference <= candidates
    );

-- A deferred run never reached the model, so it resolved nothing.
ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_deferred_files_nothing;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_deferred_files_nothing CHECK (
        state <> 'deferred'
        OR (candidates = 0 AND filed = 0 AND below_threshold = 0
            AND unresolved_reference = 0 AND refused = 0
            AND resolved_reference = 0)
    );

-- ...and a failed one produced no submission the contract accepted, so no
-- candidate ever reached the aperture and none was resolved either.
ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_failed_files_nothing;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_failed_files_nothing CHECK (
        state <> 'failed'
        OR (candidates = 0 AND filed = 0 AND below_threshold = 0
            AND unresolved_reference = 0 AND refused = 0
            AND resolved_reference = 0)
    );

-- The gate's second route to a question, counted (ticket #66, the fix half;
-- FR-31; ADR-0003, ADR-0016).
--
-- #66's diagnosis measured the confidence gate against 88 graded candidates
-- and found it inert: every WRONG crossing arrived at 0.95–1.00, the middle
-- band `[0.7, 0.9)` held ONE of the 88, and the emitter produced five
-- distinct values in total. There was no threshold to move — a gate set
-- above the least-confident error would have discarded 83 of the 88,
-- nearly all of them correct.
--
-- The cause is a mismatch of predicates, not a mistuned number. The
-- extraction prompt asks how sure the model is that a fact is STATED IN THE
-- CONVERSATION; the aperture reads that number as SAFE TO CROSS INTO THE
-- LEDGER. On plainly-worded traffic the first question's answer is 0.95
-- whether the reading is right or wrong. So the fix gives the model a
-- second, categorical thing to say — `stated` or `unresolved_reference` —
-- and the aperture's gate reads both.
--
-- THIS COLUMN IS THE MEASUREMENT, and that is why it is a column rather
-- than an addition to `below_threshold`. `below_threshold` counts the
-- candidates the CONFIDENCE gate turned into questions, which is a true
-- sentence about it today and stays true: it is not widened, not renamed,
-- and not re-cut. The new route lands beside it, so a report can say how
-- many questions each test raised — and a run where the new one never fires
-- is visibly different from one where it fires constantly. A ticket whose
-- whole finding is "the gate could not see what it was measuring" cannot
-- leave its own effect unmeasurable.
--
-- BOTH CHECKS ARE EXTENDED RATHER THAN NARROWED. The counts check gains one
-- non-negative term on each side of its inequality, and the deferred-run
-- check gains one more zero; every value either constraint accepted before
-- it is still accepted, and a run written by a build that predates this
-- column carries the column's DEFAULT 0 and satisfies both unchanged.
-- Postgres has no "add a term to a CHECK", so both are DROP + re-CREATE
-- carrying everything they already said.

ALTER TABLE extraction_runs
    -- Questions raised by the READING rather than by the number: the model
    -- said outright that what the record would name points at something the
    -- day does not spell out («lo mismo del pedido pasado»), so the rep is
    -- asked before anything crosses — however sure the model was that the
    -- words were there.
    ADD COLUMN unresolved_reference integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN extraction_runs.unresolved_reference IS
    'Candidates the aperture turned into questions because the model read them as naming something outside the day (ticket #66). Counted apart from below_threshold, which stays exactly what its name says: the ones the CONFIDENCE gate stopped.';

ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_counts_check;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_counts_check CHECK (
        messages >= 0 AND candidates >= 0 AND filed >= 0
        AND below_threshold >= 0 AND unresolved_reference >= 0
        AND refused >= 0
        AND filed + below_threshold + unresolved_reference + refused
            <= candidates
    );

ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_deferred_files_nothing;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_deferred_files_nothing CHECK (
        state <> 'deferred'
        OR (candidates = 0 AND filed = 0 AND below_threshold = 0
            AND unresolved_reference = 0 AND refused = 0)
    );

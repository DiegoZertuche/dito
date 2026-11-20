-- The seam's word for a trigger whose execution failed (ticket #240; the
-- ruling on boundary #225, F1; ADR-0042 as it reads on fail-stop).
--
-- NUMBERING: …2026090910001·, the first of 2026-09-09, after
-- …20260908100070 (link day, #223). Forward-only: no migration in this repo
-- is ever edited once it has applied anywhere, because a migration is a
-- statement about what a database has already been through.
--
-- ═══ WHAT THE WORD IS FOR ═══
--
-- A realtime execution that cannot finish CONSUMES its trigger, and this is
-- the word it consumes it with (`execution-failure.ts` argues the rule). It
-- says exactly what happened to the row and nothing about why: an execution
-- ran for it and produced no outcome. The reason lives on
-- `executions.disposition` — `failed`, which that set has carried since
-- …20260904100010 and which needs no widening here — and in the run's own
-- audit-chain entry beside it.
--
-- IT IS WHAT STOPS A POISON ROW, and that is the hazard it exists for. An
-- execution the model cannot finish is deterministic: unmarked, its trigger
-- is re-read on the next pass, re-run at the same cost, and re-run again on
-- every restart, for as long as nothing about the input changes. One marker
-- is one paid attempt.
--
-- A MARKER, NEVER A DELETE. The `wa_events` row is untouched: what the
-- plane delivered is what the seam holds, and this table is the record of
-- what the runtime DECIDED about it (ADR-0042's row invariant).
--
-- ═══ WHY NOT ONE OF THE EIGHTEEN ═══
--
-- `captured` is the closest and it would be a lie in the one direction
-- that matters: it means twin memory holds this and nothing else was owed,
-- which is what an opaque customer-chat delivery and a gesture are. Here
-- something WAS owed and was not delivered. `no_answer_needed` is the
-- model's own judgement that a message needs no reply, and there was no
-- accepted judgement at all. `deliberate_silence` is the twin choosing not
-- to speak. A reader of this table asking «did anything go wrong for this
-- rep on Tuesday?» must be able to answer it from the disposition, and none
-- of the three lets them.
--
-- ═══ WIDENED, NEVER NARROWED (…100022's rule, machine-checked) ═══
--
-- Postgres has no "add a value to a CHECK", so a closed set is extended by
-- DROP + re-CREATE — which means every extension re-writes the WHOLE list
-- from whatever the author's ancestor said. Every value an earlier
-- migration granted therefore rides forward, all eighteen of them, and
-- `packages/twin-runtime/src/migration-vocabulary.test.ts` is what proves
-- this cut is a superset of the one before it and is exactly what the
-- consumer's `Disposition` union writes.
ALTER TABLE wa_event_processing
    DROP CONSTRAINT wa_event_processing_disposition_check;
ALTER TABLE wa_event_processing
    ADD CONSTRAINT wa_event_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'drafted_in_batch',
        'answered_by_rep',
        'affirmed',
        'affirmation_refused',
        'dismissed',
        'binding_confirmed',
        'declined',
        'question_answered',
        'question_answer_refused',
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored',
        'retracted',
        'correction_refused',
        -- #240: an execution ran for this row and produced no outcome. The
        -- record and the chain entry beside it carry the ending; this is
        -- the seam's half, and what stops a poison row being re-read for
        -- ever.
        'execution_failed'
    ));

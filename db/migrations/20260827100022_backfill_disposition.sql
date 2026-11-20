-- Backfill ingestion's disposition (ticket #33; spec #29 decision 12:
-- dispositions grow, machinery doesn't).
--
-- 'backfill_ingested' — a backfill-marked seam event (the plane's
-- history-sync normalization, decision 5) landed in twin memory through
-- the one ingest path and stopped there: backfill never drafts, never
-- reaches the matcher (decision 6).
--
-- Renumbered ...100021 → ...100022 at the #35 integration merge: #33 and
-- #34 both cut a ...100021 on parallel branches, and both re-cut THIS
-- constraint. Filename order decides, so the collision was a real
-- narrowing — whichever ran last dropped the other's value. The rule
-- both files state is honored here by carrying every value an earlier
-- migration granted: 'dismissed' (#30, ...100020) and
-- 'binding_confirmed' (#34, ...100021) ride forward with
-- 'backfill_ingested' whether or not those migrations have run.
ALTER TABLE wa_event_processing
    DROP CONSTRAINT wa_event_processing_disposition_check;
ALTER TABLE wa_event_processing
    ADD CONSTRAINT wa_event_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'affirmed',
        'affirmation_refused',
        'dismissed',
        'binding_confirmed',
        'backfill_ingested'
    ));

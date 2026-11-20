-- The correction's vocabulary (ticket #54; spec #48 grilling decisions 14
-- and 18: dispositions grow, machinery doesn't).
--
-- Two event-processing dispositions and two notice kinds. Nothing else
-- changes: taps, the sole executor, the transactional writer, the refusal
-- taxonomy and the hash-chained audit are untouched, exactly as decision 18
-- says.
--
-- 'retracted'          — a quoted «N no» on the daily disclosure post
--                        resolved to a numbered line, and the fact that
--                        line disclosed was annotated retracted through the
--                        aperture. Deliberately not 'dismissed': a
--                        dismissal is about a draft the rep declined to
--                        send, and a retraction is about a fact that has
--                        already crossed.
-- 'correction_refused' — the same reply resolved to something that cannot
--                        be retracted: a number the post never showed, an
--                        entity create (no rep verb undoes one yet), or a
--                        fact whose 24h window has already closed. Mints
--                        nothing, and the rep is told.
--
-- Every value an earlier migration granted rides forward — the rule
-- …100022 states, and the reason a re-cut must never narrow the set.
--
-- RE-CUT AT THE INTEGRATION MERGE (ticket #56). This file was written on
-- `ticket/54-corrections-finalization`, whose ancestor was #52 — so its
-- list was complete for the branch it was cut on and INCOMPLETE the moment
-- #53's …100030 sorted ahead of it in the merged set. #53 added
-- 'question_answered' and 'question_answer_refused'; this migration ran
-- after it and dropped both, which would have turned every rep «si» on an
-- aperture question into a constraint violation at the marker.
--
-- `migration-vocabulary.test.ts` — which BOTH #53 and #54 wrote,
-- independently, for exactly this hazard — went red here and named the two
-- dropped values. This is the rule being enforced rather than an exception
-- to it: the set is re-cut from the true merged ancestor, not from the
-- branch's.
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
        'declined',
        'question_answered',
        'question_answer_refused',
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored',
        'retracted',
        'correction_refused'
    ));

-- The two posts the correction can produce, both ABOUT the raw rep-side
-- event that prompted them, like the dismissal ack and the refusal notice.
--
-- WHY A SUCCESSFUL CORRECTION ACKS AT ALL. The ticket names only the
-- refusal, and the ack is the deviation this migration is honest about: the
-- disclosure post teaches «1 no» in its closing line, and #36 finding 2
-- settled that silence after a rep act reads as failure — which is what
-- shipped `binding_ack` (spec #48 grilling decision 3) in the «Descartado»
-- shape. A verb whose FAILURE speaks and whose SUCCESS is silent teaches
-- the rep that silence means it did not land, on the one surface the whole
-- slice's trust claim rests on. Both halves therefore speak.
ALTER TABLE notices
    DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question',
        'binding_ack',
        'answer',
        'daily_disclosure',
        -- #53's, carried forward at the integration merge (see the
        -- disposition set above): dropping it would have made every
        -- aperture question the twin posts a constraint violation.
        'aperture_question',
        'correction_ack',
        'correction_refusal'
    ));

-- At most ONE post per rep message, structurally — the bound
-- `notices_one_answer_per_event` already puts on answers, for the same
-- reason: a second ack or refusal for the same «N no» cannot be
-- represented, whatever a retry or a replay attempts. The correction, its
-- post and its processing marker commit in one transaction, so this is belt
-- over construction; belt is what survives a future caller.
CREATE UNIQUE INDEX notices_one_correction_per_event
    ON notices (twin_id, about_event_id)
    WHERE kind IN ('correction_ack', 'correction_refusal');

ALTER TABLE notices
    ADD CONSTRAINT notices_correction_about_event_check
    CHECK (kind NOT IN ('correction_ack', 'correction_refusal')
           OR about_event_id IS NOT NULL);

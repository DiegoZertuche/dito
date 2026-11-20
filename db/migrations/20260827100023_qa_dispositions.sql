-- Self-chat Q&A vocabulary (ticket #35; spec #29 grilling decision 2 and
-- decision 12: dispositions grow, machinery doesn't).
--
-- The twin thread becomes fully routed. Three outcomes join the
-- event-processing dispositions, one closed notice kind joins the posts:
--
-- 'answered'          — an unquoted rep text (or a quoted follow-up on a
--                       twin post) was twin input, the Q&A call decided it
--                       warranted an answer, and the framed answer posted.
-- 'deliberate_silence' — the same route, opposite judgment: an obvious
--                       note-to-self. The twin says nothing ON PURPOSE, and
--                       the disposition records that it chose to. This is a
--                       model judgment INSIDE the Q&A call, never a
--                       pre-classifier (grilling decision 2), which is why
--                       it is a disposition of its own and not 'captured':
--                       'captured' means "nothing addressed the twin",
--                       silence means "the twin considered it and held".
-- 'media_ignored'     — a media-only message in the twin thread. Saving a
--                       photo to yourself must never trigger anything
--                       (story 13).
--
-- Every value an earlier migration granted rides forward: migrations apply
-- in filename order and a later re-cut must never narrow the set (the rule
-- ...100022 states, and the reason #33's and #34's colliding ...100021 had
-- to be renumbered at the #35 integration merge).
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
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored'
    ));

-- 'answer' joins the closed notice kinds: the framed Q&A answer the twin
-- posts to its own thread, carrying its compact citation line. Like the
-- dismissal ack and the binding question it is ABOUT the raw rep-side
-- event that prompted it — which is also the structural bound on answer
-- volume (spec #29 decision 12: at most one answer per rep message), made
-- unrepresentable rather than merely intended by the unique index below.
ALTER TABLE notices
    DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question',
        'answer'
    ));
ALTER TABLE notices
    ADD CONSTRAINT notices_answer_about_event_check
    CHECK (kind <> 'answer' OR about_event_id IS NOT NULL);

-- At most ONE answer per rep message, structurally (spec #29 decision 12).
-- The bound is a database constraint, not consumer discipline: a second
-- answer for the same rep event cannot be represented, whatever a retry,
-- a replay, or a future caller attempts.
CREATE UNIQUE INDEX notices_one_answer_per_event
    ON notices (twin_id, about_event_id)
    WHERE kind = 'answer';

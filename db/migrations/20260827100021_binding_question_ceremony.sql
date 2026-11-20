-- The binding ceremony's seam vocabulary (ticket #34; spec #29 grilling
-- decision 3, decision 12: dispositions grow, machinery doesn't).
--
-- The binding itself — the rep-confirmed chat↔entity association — NEVER
-- touches shared Postgres (ADR-0004): it lives only in the bundle's
-- entity mirror, written through the bundle API at the rep's quoted «va».
-- What the seam carries is ceremony plumbing only, in vocabulary already
-- present: a new closed notice kind for the framed once-ever question the
-- twin posts to its own thread, and a new disposition for the raw rep
-- event whose «va» confirmed. No new table, no new column.
--
-- 'binding_confirmed' joins the event-processing dispositions: the rep's
-- quoted «va» on the binding-question post, committed after the bundle's
-- entity-mirror write (idempotent: a crash between them replays onto the
-- already-confirmed binding, like ingest).
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
        'binding_confirmed'
    ));

-- 'binding_question' joins the closed notice kinds: the framed
-- «¿Este chat es de {nombre}?» posted at most once per chat — the
-- once-ever rule is anchored in THIS store (the committed question is the
-- asked-state, atomic with the draft that triggered it), and the chat it
-- asks about is recoverable only by decrypting its source event's payload
-- under the twin DEK — chat naming stays inside the envelope. Like the
-- dismissal ack, the question is about the raw rep-side event that
-- triggered it; that reference is also how a quoted «va» resolves back to
-- the chat being confirmed.
ALTER TABLE notices
    DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question'
    ));
ALTER TABLE notices
    ADD CONSTRAINT notices_question_about_event_check
    CHECK (kind <> 'binding_question' OR about_event_id IS NOT NULL);

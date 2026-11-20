-- The grammar pass's seam vocabulary (ticket #49; spec #48 grilling
-- decision 3, spec #48 decision 18: dispositions grow, machinery doesn't).
--
-- Two additions, no new table and no new column. The verbs themselves are
-- code (the accepted set is a function of the quoted post's kind); what
-- the seam gains is a name for the two outcomes that had none:
--
-- 'declined' joins the event-processing dispositions: the rep quoted a
--   twin QUESTION and answered no («no» or «no va»). Before this the reply
--   fell through to the Q&A as prose, which put a model in the path of a
--   rep act — a decided answer, recorded as one. It is deliberately NOT
--   'captured': 'captured' means "nothing addressed the twin", and a
--   declined question is the rep addressing it precisely. Nothing is
--   minted and nothing is written outside this store — declining leaves
--   the chat exactly as provisional as an unanswered question does.
--
-- The ack kind joins the closed notice kinds: the framed
-- «Listo, guardé este chat como *…*» the twin posts when a confirmation
-- lands (#36 finding 2 — silence after a confirmation was felt first-hand
-- to be wrong). Like the dismissal ack it is ABOUT the raw rep-side event
-- that confirmed, which is what makes it recoverable under replay: the
-- notice and the event's marker commit together, so a crash between the
-- bundle's mirror write and this store can never leave a confirmation
-- silently acked or silently un-acked.
--
-- Note the constraint NAME carries no schema-shaped word for the
-- rep-confirmed chat association: the binding wall's structural sweep
-- (binding-wall.test.ts, ADR-0004) reads identifiers, not literals, and
-- the association itself lives only in the bundle's mirror. The kind VALUE
-- is vocabulary in a quoted literal, exactly as ...100021's is.
--
-- Every value an earlier migration granted rides forward (the rule
-- ...100022 states).
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
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored'
    ));

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
        'answer'
    ));
ALTER TABLE notices
    ADD CONSTRAINT notices_confirm_ack_about_event_check
    CHECK (kind <> 'binding_ack' OR about_event_id IS NOT NULL);

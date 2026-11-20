-- The dismiss verb's vocabulary (ticket #30; spec #29 decision 12:
-- dispositions grow, machinery doesn't).
--
-- 'dismissed' joins the event-processing dispositions: the raw «no va»
-- event that minted a terminal dismissal — committed atomically with the
-- draft_dismissals row and the «✳️ Descartado» ack (the consumer's one
-- transaction).
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
        'dismissed'
    ));

-- 'dismissal_ack' joins the closed notice kinds: the single framed
-- «Descartado» the twin posts back when a dismissal lands. Like a refusal
-- notice it is about the raw rep event that caused it.
ALTER TABLE notices
    DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN ('send_confirmation', 'affirmation_refusal', 'dismissal_ack'));
ALTER TABLE notices
    ADD CONSTRAINT notices_dismissal_ack_about_event_check
    CHECK (kind <> 'dismissal_ack' OR about_event_id IS NOT NULL);

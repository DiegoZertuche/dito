-- The affirmation matcher's dispositions (ticket #25), extending the
-- consumer's marker table rather than inventing a second exactly-once
-- anchor (#23 hand-off): a captured self-chat event that the matcher
-- recognized as a quoted-reply affirmation resolves to
--   'affirmed'            — the tap and its customer_send were minted (the
--                           writer's one transaction, ADR-0006); or
--   'affirmation_refused' — the writer refused (already tapped,
--                           off-allowlist, pacing …) and the refusal
--                           notice + its system_send were emitted
--                           atomically with this marker.
-- Everything else in the self-chat stays 'captured'.
ALTER TABLE wa_event_processing
    DROP CONSTRAINT wa_event_processing_disposition_check;
ALTER TABLE wa_event_processing
    ADD CONSTRAINT wa_event_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'affirmed',
        'affirmation_refused'
    ));

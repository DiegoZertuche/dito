-- Notices (ticket #25): what the twin says to the rep in the twin thread
-- about the loop itself — the send confirmation after a customer_send
-- resolves sent («Enviado a …»), and the refusal microcopy when an
-- affirmation cannot mint («ya se envió»). Same custody as drafts:
-- content_enc is DEK-encrypted at rest (ADR-0008), dereferenced and
-- decrypted only inside the plane's executor via payload_ref
-- 'notice:<uuid>' on a system_send row (ADR-0006: system_send reaches the
-- self-chat only). The es-MX strings are hardcoded this slice; the copy
-- catalog is deferred by adjudication (#6).
CREATE TABLE notices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- Closed kind set; a new notice kind is a reviewable migration.
    kind text NOT NULL
        CONSTRAINT notices_kind_check
        CHECK (kind IN ('send_confirmation', 'affirmation_refusal')),
    -- What the notice is about: a resolved customer_send for
    -- confirmations; the refused affirmation's raw event for refusals.
    about_command_id uuid REFERENCES send_commands (id),
    about_event_id bigint REFERENCES wa_events (id),
    content_enc bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notices_confirmation_about_command_check
        CHECK (kind <> 'send_confirmation' OR about_command_id IS NOT NULL),
    CONSTRAINT notices_refusal_about_event_check
        CHECK (kind <> 'affirmation_refusal' OR about_event_id IS NOT NULL)
);

-- Exactly one confirmation per resolved send: the sweep that emits
-- confirmations is re-runnable and crash-replayable; this index, not the
-- sweep's query, is the exactly-once guarantee.
CREATE UNIQUE INDEX notices_one_confirmation_per_command_key
    ON notices (about_command_id)
    WHERE kind = 'send_confirmation';

-- A notice is what was actually said to the rep — evidence, frozen like
-- drafts (ADR-0006 construction: refused in the store, not promised).
CREATE FUNCTION notices_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'notices are immutable: % refused — a notice is the record of what the twin told the rep', TG_OP;
END;
$$;

CREATE TRIGGER notices_no_update_delete
    BEFORE UPDATE OR DELETE ON notices
    FOR EACH ROW EXECUTE FUNCTION notices_immutable();
CREATE TRIGGER notices_no_truncate
    BEFORE TRUNCATE ON notices
    FOR EACH STATEMENT EXECUTE FUNCTION notices_immutable();

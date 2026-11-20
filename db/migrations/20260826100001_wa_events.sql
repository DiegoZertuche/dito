-- Inbound seam (ADR-0005): the plane's filtered ingest writes here.
-- Plaintext metadata envelope only — content lives in the DEK-encrypted
-- payload (ADR-0008); nothing else about the message is persisted.
CREATE TABLE wa_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source text NOT NULL,
    external_event_id text NOT NULL,
    event_type text NOT NULL,
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload_enc bytea NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    -- Seam dedupe: one row per rail event (ADR-0005).
    CONSTRAINT wa_events_source_external_event_id_key UNIQUE (source, external_event_id)
);

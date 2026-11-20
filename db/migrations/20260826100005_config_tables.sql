-- Metadata-only config tables: chat/destination identities and thresholds,
-- never content. The plane reads scope_allowlist for the capture guard
-- (ADR-0023 skeleton — out-of-scope inbound never leaves the plane); the
-- send_commands writer reads send_allowlist and pacing_thresholds
-- (ADR-0017: pacing and the hard allowlist are domain logic at the writer;
-- the plane stays dumb).

CREATE TABLE scope_allowlist (
    twin_id uuid NOT NULL,
    chat_jid text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (twin_id, chat_jid)
);

CREATE TABLE send_allowlist (
    twin_id uuid NOT NULL,
    destination_jid text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (twin_id, destination_jid)
);

CREATE TABLE pacing_thresholds (
    twin_id uuid PRIMARY KEY,
    max_sends_per_hour integer NOT NULL CHECK (max_sends_per_hour > 0),
    min_seconds_between_sends integer NOT NULL CHECK (min_seconds_between_sends >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

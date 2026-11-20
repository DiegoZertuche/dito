-- The wrapped DEK's home (decided on #20): per-twin state on the shared
-- Postgres seam, because both custody processes — the Go plane and the
-- twin-runtime lease holder (ADR-0008) — reach each other only across the
-- seam (ADR-0005), and the bundle file cannot hold its own opening key.
--
-- wrapped_dek is KMS ciphertext under the twin's own key: NEVER plaintext
-- key material. Destroying the twin's KMS key at retirement (ADR-0009)
-- turns this row — and the bundle it opens — into noise.
--
-- One twin, one wrapped DEK (ADR-0007: memory is one file under one key).
-- Rewrap/rotation would be an explicit later migration, never an UPDATE.

CREATE TABLE twin_keys (
    twin_id uuid PRIMARY KEY,
    wrapped_dek bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

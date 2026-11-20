-- A draft: a twin-composed outbound message awaiting the rep's tap.
-- Content is DEK-encrypted at rest (ADR-0008); the destination JID is seam
-- metadata, like the chat identities in the config allowlists.
CREATE TABLE drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    in_reply_to_event_id bigint REFERENCES wa_events (id),
    destination text NOT NULL,
    content_enc bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

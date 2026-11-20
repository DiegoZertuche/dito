-- The send lock (ADR-0006). Birth order is deliberate: taps exists before
-- send_commands, so no unlocked send window ever exists in the schema's
-- history. One taps table; UNIQUE (draft_id) *is* the cross-surface
-- single-use lock — late losers get "ya se envió".
--
-- source_event_id pins the tap to the raw plane-delivered event that minted
-- it (slice 1's only minter is the quoted-reply affirmation matcher); model
-- output can never mint a tap.
CREATE TABLE taps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id uuid NOT NULL UNIQUE REFERENCES drafts (id),
    -- Closed minter set: slice 1 has exactly one. rep-web's authz layer (the
    -- other ADR-0006 minter) joins this CHECK via migration when its surface
    -- ships — a schema change, visible in review, never a runtime value.
    minter text NOT NULL
        CONSTRAINT taps_minter_check
        CHECK (minter IN ('affirmation_matcher')),
    source_event_id bigint REFERENCES wa_events (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- The matcher's input is pinned to the raw plane-delivered event: an
    -- affirmation tap with no source event cannot exist (ADR-0006).
    CONSTRAINT taps_matcher_requires_event_check
        CHECK (minter <> 'affirmation_matcher' OR source_event_id IS NOT NULL),
    -- Composite key target so send_commands can bind (tap, draft) as a pair.
    CONSTRAINT taps_id_draft_id_key UNIQUE (id, draft_id)
);

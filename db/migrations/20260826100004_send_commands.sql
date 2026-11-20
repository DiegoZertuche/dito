-- Outbound seam (ADR-0005/0006): rows consumed by the plane's executor, the
-- sole caller of the rail's send APIs. Two send classes:
--   customer_send — requires a recorded tap (enforced here, by CHECK);
--   system_send   — permitted only to the rep's own self-chat JID, where
--                   "self" derives exclusively from the live whatsmeow
--                   session identity inside the plane (never a table value,
--                   so it is enforced in the plane, not here).
-- Outcomes: sent(acked) / failed / unknown→held — never silent, never
-- auto-retried; NULL means not yet executed. A retry is a new tap, hence
-- the unique index on tap_id.
CREATE TABLE send_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    send_class text NOT NULL
        CONSTRAINT send_commands_send_class_check
        CHECK (send_class IN ('customer_send', 'system_send')),
    destination text NOT NULL,
    payload_ref text NOT NULL,
    tap_id uuid REFERENCES taps (id),
    draft_id uuid REFERENCES drafts (id),
    outcome text
        CONSTRAINT send_commands_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('sent', 'failed', 'held')),
    created_at timestamptz NOT NULL DEFAULT now(),
    executed_at timestamptz,
    -- The lock's schema half: no customer_send row exists without a tap and
    -- its tapped draft, and a tap never rides a system_send. Together with
    -- the composite FK below, a tap authorizes exactly its own draft — a
    -- command cannot pair a real tap with some other payload.
    CONSTRAINT send_commands_customer_send_requires_tap_check
        CHECK (send_class <> 'customer_send'
               OR (tap_id IS NOT NULL AND draft_id IS NOT NULL)),
    CONSTRAINT send_commands_system_send_carries_no_tap_check
        CHECK (send_class <> 'system_send' OR tap_id IS NULL),
    CONSTRAINT send_commands_tap_matches_draft_fkey
        FOREIGN KEY (tap_id, draft_id) REFERENCES taps (id, draft_id)
);

-- One send per tap: a retry is a new tap (ADR-0006).
CREATE UNIQUE INDEX send_commands_tap_id_key
    ON send_commands (tap_id)
    WHERE tap_id IS NOT NULL;

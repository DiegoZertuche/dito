-- The executor's bookkeeping (ticket #25, ADR-0006): at-most-once execution
-- and the record of what actually left the rail.
--
-- send_attempts is the claim half: the executor commits the claim BEFORE
-- touching the socket, so a crash anywhere between claim and finalization
-- leaves a claimed-but-pending command that the next pass finalizes as
-- held ("unknown → held") — never re-sent. Without this, a crash after the
-- socket send but before finalization would auto-retry a customer_send
-- with no new tap, violating the lock. A retry is a new tap.
CREATE TABLE send_attempts (
    command_id uuid PRIMARY KEY REFERENCES send_commands (id),
    attempted_at timestamptz NOT NULL DEFAULT now()
);

-- send_executions is the result half: one row per send that actually left,
-- carrying the rail's message id for the posted message. Two consumers:
--   * the affirmation matcher resolves a rep quoted-reply's
--     quoted_message_id → draft through the system_send rows here — the
--     draft↔posted-message mapping is born at execution (#23 hand-off);
--   * the same ids are the origin tag for echo protection: an inbound
--     self-chat event whose message id appears here is the twin's own
--     post echoing back, and can never be matcher input.
CREATE TABLE send_executions (
    command_id uuid PRIMARY KEY REFERENCES send_commands (id),
    twin_id uuid NOT NULL,
    wa_message_id text NOT NULL,
    executed_at timestamptz NOT NULL DEFAULT now(),
    -- The matcher's lookup key; message ids are unique per chat on the
    -- rail, and the twin qualifier keeps the constraint honest when the
    -- fleet arrives.
    CONSTRAINT send_executions_twin_message_key UNIQUE (twin_id, wa_message_id)
);

-- Both tables are execution evidence (same construction as drafts, taps,
-- and send_commands): refused in the store, not promised in code. Deleting
-- an attempt would re-open a re-send; retargeting an execution would
-- launder the origin tag the echo protection depends on.
CREATE FUNCTION send_bookkeeping_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'executor bookkeeping is immutable (ADR-0006): % refused', TG_OP;
END;
$$;

CREATE TRIGGER send_attempts_no_update_delete
    BEFORE UPDATE OR DELETE ON send_attempts
    FOR EACH ROW EXECUTE FUNCTION send_bookkeeping_immutable();
CREATE TRIGGER send_attempts_no_truncate
    BEFORE TRUNCATE ON send_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION send_bookkeeping_immutable();
CREATE TRIGGER send_executions_no_update_delete
    BEFORE UPDATE OR DELETE ON send_executions
    FOR EACH ROW EXECUTE FUNCTION send_bookkeeping_immutable();
CREATE TRIGGER send_executions_no_truncate
    BEFORE TRUNCATE ON send_executions
    FOR EACH STATEMENT EXECUTE FUNCTION send_bookkeeping_immutable();

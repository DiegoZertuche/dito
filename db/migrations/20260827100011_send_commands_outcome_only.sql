-- A validated command is frozen (ticket #24, ADR-0006/0017): the writer
-- checked the tap, the allowlist, and pacing against exactly these values,
-- and the plane's executor sends exactly what was validated. After insert,
-- the one legal write is outcome finalization — outcome set once (with its
-- executed_at), then final: sent / failed / held, never silent, never
-- rewritten, never auto-retried. Everything else — destination, payload
-- ref, identity, the tap/draft binding, and the pacing clock (created_at,
-- which backdating would let evade pacing) — is immutable by construction.
-- Rows are never deleted: the outbox is FR-70's evidence.
CREATE FUNCTION send_commands_outcome_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.twin_id IS DISTINCT FROM OLD.twin_id
        OR NEW.send_class IS DISTINCT FROM OLD.send_class
        OR NEW.destination IS DISTINCT FROM OLD.destination
        OR NEW.payload_ref IS DISTINCT FROM OLD.payload_ref
        OR NEW.tap_id IS DISTINCT FROM OLD.tap_id
        OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'send_commands is frozen after validation (ADR-0006): only outcome finalization may be written';
    END IF;
    IF OLD.outcome IS NOT NULL
        AND (NEW.outcome IS DISTINCT FROM OLD.outcome
             OR NEW.executed_at IS DISTINCT FROM OLD.executed_at)
    THEN
        RAISE EXCEPTION 'send outcome is final (ADR-0006): a retry is a new tap';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION send_commands_no_remove() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'send_commands rows are FR-70 evidence: % refused', TG_OP;
END;
$$;

CREATE TRIGGER send_commands_outcome_only
    BEFORE UPDATE ON send_commands
    FOR EACH ROW EXECUTE FUNCTION send_commands_outcome_only();

CREATE TRIGGER send_commands_no_delete
    BEFORE DELETE ON send_commands
    FOR EACH ROW EXECUTE FUNCTION send_commands_no_remove();

CREATE TRIGGER send_commands_no_truncate
    BEFORE TRUNCATE ON send_commands
    FOR EACH STATEMENT EXECUTE FUNCTION send_commands_no_remove();

-- Taps are immutable (ticket #24, ADR-0006): a tap is the recorded proof
-- of one rep affirmation of one draft, minted from one raw plane-delivered
-- event. Retargeting its source event or draft after the writer's one-time
-- validation would launder an authorization; removing it would erase FR-70
-- evidence. Same construction as drafts and send_commands: refused in the
-- store, not promised in code.
CREATE FUNCTION taps_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'taps are immutable (ADR-0006): % refused — a tap is single-use authorization evidence', TG_OP;
END;
$$;

CREATE TRIGGER taps_no_update_delete
    BEFORE UPDATE OR DELETE ON taps
    FOR EACH ROW EXECUTE FUNCTION taps_immutable();

CREATE TRIGGER taps_no_truncate
    BEFORE TRUNCATE ON taps
    FOR EACH STATEMENT EXECUTE FUNCTION taps_immutable();

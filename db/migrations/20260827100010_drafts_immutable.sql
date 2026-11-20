-- Drafts are immutable in the store (ticket #24, ADR-0006): a tap is the
-- rep's affirmation of one specific draft, so nothing may swap a draft's
-- content or destination between the tap and the executor's dereference —
-- the binding holds by construction, not by the absence of an UPDATE path.
-- Slice 1's draft revision loop is out of scope by decision (#6): a revised
-- message is a NEW draft awaiting its own tap, never an edit. If a later
-- slice needs draft state transitions, it relaxes this in a reviewable
-- migration — the same pattern as the taps minter CHECK.
CREATE FUNCTION drafts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'drafts are immutable (ADR-0006): % refused — a revised message is a new draft', TG_OP;
END;
$$;

CREATE TRIGGER drafts_no_update_delete
    BEFORE UPDATE OR DELETE ON drafts
    FOR EACH ROW EXECUTE FUNCTION drafts_immutable();

CREATE TRIGGER drafts_no_truncate
    BEFORE TRUNCATE ON drafts
    FOR EACH STATEMENT EXECUTE FUNCTION drafts_immutable();

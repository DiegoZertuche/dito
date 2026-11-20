-- The hash-chained audit log skeleton (ADR-0020): append-only, HMAC
-- hash-chained, content-free — caller identity, action type, opaque refs,
-- outcome. Slice-1 writers are the refusal paths (send-allowlist, pacing)
-- at the send_commands writer; chain construction/verification lives in
-- @dito/audit. Append-only is enforced here, in the store itself.
CREATE TABLE audit_chain (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    caller text NOT NULL,
    action text NOT NULL,
    ref text,
    outcome text NOT NULL,
    prev_hash bytea,
    entry_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION audit_chain_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'audit_chain is append-only (ADR-0020): % refused', TG_OP;
END;
$$;

CREATE TRIGGER audit_chain_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_chain
    FOR EACH ROW EXECUTE FUNCTION audit_chain_append_only();

CREATE TRIGGER audit_chain_no_truncate
    BEFORE TRUNCATE ON audit_chain
    FOR EACH STATEMENT EXECUTE FUNCTION audit_chain_append_only();

-- The OWNER SIDE'S OWN AUDIT CHAIN — one per company, in the owner's own
-- schema, under the owner's own key (ticket #165; the decision on #157,
-- 2026-09-03; ADR-0020 as amended, ADR-0002, ADR-0004 as amended, ADR-0025,
-- ADR-0009, ADR-0030, ADR-0029).
--
-- NUMBERING: the …20260903100010 range opens the day after …100080/…100090.
-- Both of those are merged and stay exactly as they are — Atlas holds their
-- hashes (ADR-0029) — so this is the forward-only correction of the last
-- line …100080 wrote.
--
-- WHAT THIS REVERSES, AND ON WHAT FACT. …100080 granted `dito_owner` SELECT
-- and INSERT on `public.audit_chain`, because the owner twin is an execution
-- and every execution owes the chain one content-free entry — and appending
-- reads the tail before extending it. The ruling of 2026-09-02 weighed what
-- a compromised owner web could WRITE with that grant. It did not weigh what
-- the grant lets it READ, and that is the whole of #157: the shared chain is
-- a same-company REP-ACTIVITY RECORD. Its entries carry `twin:<id>` — the
-- one identifier ADR-0004 as amended says never crosses, and which the seats
-- view withholds even inside the owner's own company — beside every
-- `customer_send` with its outcome and its timestamp, every refusal and
-- every `question_answer`. Per-rep send volume, send timing and refusal
-- counts are exactly the usage signal ADR-0025 forbids deriving owner-side,
-- and one SELECT is all it takes. Row-level security on the shared chain
-- does not fix it (the owner would still read its OWN company's send log),
-- so the grant goes.
--
-- SO THE OWNER SIDE MAY READ ONLY WHAT IT WROTE. It appends here instead:
-- its own chain, in the schema it already owns, partitioned per company by
-- forced row-level security, under `DITO_OWNER_AUDIT_HMAC_KEY`. The rep
-- chain keeps its schema, its key and its append path, untouched. The owner
-- environment then holds nothing that can name, read, write or verify a
-- rep-side store — ADR-0002's letter with no footnote.
--
-- ONE TABLE, ONE CHAIN PER COMPANY, and that is a shape rather than a
-- convenience: `audit-verify` walks each company's rows in id order under
-- the owner key and reports each, and no G16 claim orders an owner act
-- against a rep act, so nothing is lost to the split (ADR-0020 as amended).
-- This chain is the audit chain of ADR-0009 and ADR-0030 for the owner side:
-- it survives erasure and company wind-down, and is not owner state those
-- delete.

-- THE SHARED CHAIN'S COLUMNS, PLUS THE TENANT. Same names, same types, same
-- order as `public.audit_chain` (…100006) so one verifier reads both and a
-- reader comparing the two tables sees one difference.
--
-- `company_id` IS NOT IN THE HASH, deliberately. The entry ADR-0020 defines
-- is caller, action, ref, outcome — content-free, and the same four whichever
-- chain it lands on. The tenant is what partitions the table and keys the
-- lock; folding it into the digest would give the two chains two entry
-- formats and one verifier that had to know which table a row came from.
CREATE TABLE owner.audit_chain (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- The tenant, on every row, for the reason …100080 gives on its own
    -- three: the `owner` schema is not shared between deployments today, but
    -- the ROLE is cluster-global and the tables are one schema, so two
    -- deployments against one database would chain onto each other's tails
    -- with nothing in the way.
    company_id uuid NOT NULL,
    caller text NOT NULL,
    action text NOT NULL,
    ref text,
    outcome text NOT NULL,
    prev_hash bytea,
    entry_hash bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE owner.audit_chain IS
    'Ticket #165 (#157): the owner side''s hash-chained audit log — one chain per company, under DITO_OWNER_AUDIT_HMAC_KEY. Content-free (ADR-0020). The rep side''s chain is public.audit_chain and dito_owner holds nothing on it.';

-- THE TAIL READ'S INDEX. Every append reads one row — the greatest `id` for
-- one company — under a lock keyed to that company, so this is the access
-- path the whole design turns on.
CREATE INDEX owner_audit_chain_company_id_idx
    ON owner.audit_chain (company_id, id DESC);

-- APPEND-ONLY, ENFORCED IN THE STORE, exactly as `public.audit_chain` is.
--
-- ITS OWN FUNCTION IN ITS OWN SCHEMA rather than a reference to the `public`
-- one. The two are five identical lines and that duplication is the price of
-- the boundary this ticket exists to draw: the owner chain must be
-- describable without naming a `public` object, its refusal must name the
-- table the writer actually touched, and ADR-0009/0030 make this chain
-- outlive things the rep side owns. SECURITY INVOKER (the default), so it
-- lends nobody its definer's reach — FR-71a claim 7 checks exactly that.
CREATE FUNCTION owner.audit_chain_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'owner.audit_chain is append-only (ADR-0020): % refused', TG_OP;
END;
$$;

CREATE TRIGGER owner_audit_chain_no_update_delete
    BEFORE UPDATE OR DELETE ON owner.audit_chain
    FOR EACH ROW EXECUTE FUNCTION owner.audit_chain_append_only();

CREATE TRIGGER owner_audit_chain_no_truncate
    BEFORE TRUNCATE ON owner.audit_chain
    FOR EACH STATEMENT EXECUTE FUNCTION owner.audit_chain_append_only();

-- THE STATE ROLE OWNS IT, NOT THE LOGIN (…100090's ruling, and FR-71a claim
-- 8). A relation's owner may `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, and
-- FORCE makes an owner SUBJECT to its policies rather than unable to remove
-- them — so a login that owned this table would be one statement away from
-- reading every company's chain. Atlas runs as `dito` (ADR-0029), so a plain
-- CREATE TABLE here lands owned by `dito`; this is the ALTER that makes the
-- claim true. The identity column's sequence moves with it.
ALTER TABLE owner.audit_chain OWNER TO dito_owner_state;

-- TENANT ISOLATION, ENABLED AND FORCED, with the same pinned predicate every
-- Ledger policy and every other `owner` table reads (…100040, …100080). One
-- definition of "the company this connection declared", so a connection that
-- declared none reads ZERO ROWS here and can append nothing.
--
-- WITH CHECK ON THE INSERT ARM: without it a deployment serving company A
-- could stamp an entry with company B's id — invisible to itself afterwards,
-- and chained onto B's tail.
--
-- NO UPDATE AND NO DELETE POLICY, deliberately. A policy is permissive and
-- there is none for either command, so neither is permitted to anybody the
-- policies bind. That is the row-level half of append-only; the trigger
-- above is the half that also binds the roles policies do not.
ALTER TABLE owner.audit_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner.audit_chain FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_audit_chain_company_read ON owner.audit_chain
    FOR SELECT
    USING (company_id = ledger.declared_company());
CREATE POLICY owner_audit_chain_company_write ON owner.audit_chain
    FOR INSERT
    WITH CHECK (company_id = ledger.declared_company());

-- EXACTLY WHAT THE OWNER APP DOES WITH ITS OWN CHAIN: it reads the tail and
-- it appends. …100090 already narrowed this schema's default privileges to
-- SELECT and INSERT, so the table arrived with those two and no more — this
-- says so out loud instead of relying on it, because the ACL is the artifact
-- FR-71a diffs and a default privilege is a grant nobody wrote down here.
REVOKE ALL ON owner.audit_chain FROM dito_owner;
GRANT SELECT, INSERT ON owner.audit_chain TO dito_owner;

-- ...AND NOTHING ON THE IDENTITY COLUMN'S SEQUENCE (ticket #165, Codex r1).
--
-- THE LEAK THIS CLOSES. `…100090` wrote `ALTER DEFAULT PRIVILEGES IN SCHEMA
-- owner GRANT USAGE, SELECT ON SEQUENCES TO dito_owner`, so the sequence this
-- table's identity column creates arrived readable by the login. ROW-LEVEL
-- SECURITY DOES NOT APPLY TO SEQUENCES: `SELECT last_value FROM
-- owner.audit_chain_id_seq` is the GLOBAL allocation counter, so one
-- company's connection could read how many entries EVERY company has
-- written, and poll it to time their executions. That contradicts the one
-- sentence this whole ticket exists for — the owner side reads only what it
-- wrote — inside the owner's own schema.
--
-- AND THE APP NEEDS NEITHER PRIVILEGE, which is what makes this free rather
-- than a trade. A column `GENERATED ALWAYS AS IDENTITY` is allocated by the
-- system on the caller's behalf; PostgreSQL checks no sequence privilege for
-- it. Verified as the behaviour and not the documentation: with the grant
-- revoked, `dito_owner` inserts and gets its id, and `SELECT last_value`
-- on the same connection is refused 42501.
--
-- THE DEFAULT GOES TOO, so the NEXT table created here does not bring its
-- sequence back. `…100090`'s sequence default was written for exactly this
-- case and, now that the case exists, it turns out to grant something no
-- table in this schema needs.
REVOKE ALL ON SEQUENCE owner.audit_chain_id_seq FROM dito_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA owner REVOKE ALL ON SEQUENCES FROM dito_owner;

-- ...AND THE GRANT THIS TICKET TAKES AWAY (#157 decision 2). `dito_owner`
-- now holds NOTHING on any `public` table — zero, not "one named exception"
-- — which is spec #126's AC 2 as written before the erratum, and ADR-0002's
-- letter. REVOKE ALL rather than the two by name: the claim is the whole
-- ACL entry, and FR-71a turns red on any privilege at all here, in either
-- direction.
REVOKE ALL ON public.audit_chain FROM dito_owner;

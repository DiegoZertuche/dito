-- The owner login owns nothing it is policy-bound on (Diego's ruling of
-- 2026-09-02 on #130's remainder item 2; ADR-0002, ADR-0029).
--
-- THE DEFECT THIS CLOSES, stated plainly because the shape below is
-- otherwise surprising: a relation's OWNER can `ALTER TABLE … DISABLE ROW
-- LEVEL SECURITY`, and FORCE does not reach that — it makes the owner
-- SUBJECT to its policies, not unable to remove them. So while `dito_owner`
-- owned the three tables …100080 created, the login those policies exist to
-- bind was one DDL statement away from unbinding itself, and every
-- company's questions and answers with it. Two deployments against one
-- database is the case the policies are for, and it is the case that defect
-- breaks.
--
-- A SECOND MIGRATION AND NOT AN EDIT TO …100080, which is merged. Atlas
-- records the hash of every file it applied (ADR-0029), so changing an
-- applied migration is a checksum mismatch on the next `migrate apply`
-- against any database that already ran it — the rig's included. Forward
-- only, like every correction in this directory.
--
-- SO OWNERSHIP AND USE ARE SPLIT, exactly as …100020 split them for the
-- finalized views: `dito_ledger_views` owns those so the policy applies
-- through them to every reader, and it is NOLOGIN because nothing should
-- ever connect as the role that could change them. `dito_owner_state` is
-- that role for the owner's own three tables. The name says what it owns
-- rather than what it is — the repo's other two say `ledger_views` and
-- `twin_runtime` the same way — and it is deliberately NOT `dito_owner_ddl`
-- or `dito_owner_admin`, which would name a capability nobody exercises: no
-- process ever connects as this role, and Atlas as `dito` is what creates
-- and alters these tables.
--
-- WHAT `dito_owner` HOLDS INSTEAD is written out below: USAGE on the schema,
-- SELECT and INSERT on the three tables, and nothing else. That is the whole
-- of what the owner app does with its own state — it appends a conversation
-- and reads it back — so the grant is not a reduction of what it needs. It
-- can no longer create a table here either, which is the other half of the
-- same hole: a table `dito_owner` created, it would own, and could unbind.
--
-- «THE OWNER APP OWNS ITS OWN STATE» WAS #127'S SENTENCE AND IT IS NOW
-- NARROWER: the owner app's state is its own, and the owner app's
-- CREDENTIAL is not what owns it. FR-71a claim 8 is rewritten to say so, and
-- the audit refuses the old shape — a relation here owned by `dito_owner`,
-- or an UPDATE or DELETE granted to it — rather than merely stopping
-- requiring it.

-- ROLES ARE CLUSTER-GLOBAL AND GRANTS ARE PER-DATABASE, so creation is
-- written idempotently exactly as …100012 and …100020 write it, and the
-- ALTER after it makes this migration CONVERGE rather than merely not fail:
-- a second database in the same cluster finds the role already there, and
-- the attributes the FR-71a audit checks are then asserted rather than
-- assumed.
DO $$
BEGIN
    CREATE ROLE dito_owner_state;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;

-- NOLOGIN AND NOBYPASSRLS FOR THE REASONS `dito_ledger_views` CARRIES BOTH.
-- Nothing authenticates as this role, so the DDL rights that come with
-- ownership are reachable by nobody who connects; and a BYPASSRLS owner
-- would read every company's rows through the very policies this split
-- exists to protect.
ALTER ROLE dito_owner_state
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- THE SCHEMA MOVES TOO, and that is a decision rather than a tidy-up.
-- `CREATE SCHEMA owner AUTHORIZATION dito_owner` in …100020 is merged and
-- immutable, so the change is made here. It has to be made: a schema's owner
-- may CREATE in it, a table `dito_owner` created it would OWN, and an owned
-- table can have its row-level security disabled — which is the identical
-- hole one level up. Leaving the schema with `dito_owner` while its
-- relations moved would close the door and leave the key in it.
ALTER SCHEMA owner OWNER TO dito_owner_state;

ALTER TABLE owner.questions OWNER TO dito_owner_state;
ALTER TABLE owner.executions OWNER TO dito_owner_state;
ALTER TABLE owner.answers OWNER TO dito_owner_state;

-- THE DEFAULT PRIVILEGES ALREADY FIRED, so this is a revoke and not a
-- precaution. …100020 wrote `ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT
-- ALL ON TABLES TO dito_owner`, attached to `dito` — the role Atlas runs as
-- — so …100080's three CREATE TABLEs handed `dito_owner` ALL, including the
-- UPDATE, DELETE and TRUNCATE the append-only policy shape exists to
-- refuse. Changing an owner does not touch an ACL that was already written.
--
-- `ALTER TABLE … OWNER TO` ALSO REWRITES AN ACL — the old owner's entries
-- fold into the new owner's — so this runs after the ownership move and
-- says exactly what `dito_owner` keeps rather than relying on what survived.
REVOKE ALL ON owner.questions, owner.executions, owner.answers
    FROM dito_owner;

-- ...AND THE DEFAULT ITSELF IS NARROWED, so the NEXT table created here does
-- not arrive with the same excess. It cannot fix the next table's OWNER —
-- no default privilege can — which is why the audit checks ownership over
-- the catalog rather than trusting this line.
ALTER DEFAULT PRIVILEGES IN SCHEMA owner REVOKE ALL ON TABLES FROM dito_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA owner REVOKE ALL ON SEQUENCES FROM dito_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA owner
    GRANT SELECT, INSERT ON TABLES TO dito_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA owner
    GRANT USAGE, SELECT ON SEQUENCES TO dito_owner;

-- EXACTLY WHAT THE OWNER APP DOES WITH ITS OWN STATE. USAGE lets it NAME
-- these tables and grants nothing on them; SELECT and INSERT are the two
-- things it does — it appends a conversation and reads it back. No UPDATE
-- and no DELETE, which the policies already refuse and which the grant now
-- refuses first: an answer that could be rewritten after the fact is a
-- record the audit chain's digest could no longer speak for.
GRANT USAGE ON SCHEMA owner TO dito_owner;
GRANT SELECT, INSERT ON owner.questions, owner.executions, owner.answers
    TO dito_owner;

-- THERE ARE NO SEQUENCES IN THIS SCHEMA TODAY — all three primary keys
-- default to `gen_random_uuid()` — and the grant is written anyway so the
-- claim stays true of a table that arrives with one. A grant over an empty
-- set is a no-op, not an error.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA owner TO dito_owner;

-- ROW-LEVEL SECURITY IS UNCHANGED AND STAYS FORCED. …100080 enabled and
-- forced it on all three, and FORCE stays: `dito_owner_state` owns them and
-- never connects, so it binds nobody in practice today — and the property
-- it asserts is «these tables have no exempt reader», which is what this
-- split would silently give back the day ownership moved again.
COMMENT ON SCHEMA owner IS
    'Ticket #127, narrowed by the ruling on #130 (2026-09-02): the owner app''s own state — execution records, questions and answers. OWNED BY dito_owner_state (NOLOGIN) so the login the policies bind cannot disable them; dito_owner holds USAGE here and SELECT + INSERT on the three tables.';

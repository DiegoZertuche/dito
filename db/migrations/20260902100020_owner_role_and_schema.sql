-- The owner side's credential boundary becomes real (ticket #127; spec #126
-- decision 3; ADR-0002, ADR-0029).
--
-- NUMBERING: the …202609021000·0 range, reserved for this ticket.
--
-- `dito_owner` IS THE FIRST APPLICATION ROLE ANYTHING WILL CONNECT AS. Two
-- roles have existed since …100012 and both are `NOLOGIN`: nothing
-- authenticates as either, and the single-writer claim they carry is
-- enforced by an audit rather than by a login. …100010 and …100012 both
-- said `dito_owner` "arrives in slice 4 with the surface that authenticates
-- as it, and a role with no client would leave a half-green audit". The
-- surface arrives in this slice (#129), so the role arrives here.
--
-- NO PASSWORD. A secret does not belong in a migration — a migration is a
-- reviewed, checksummed, forever-readable artifact (ADR-0029), and a
-- password written into one is a password in every clone of this repo. The
-- password is set where the credential lives: the rig's by
-- `rig-seed-owner.ts` out of `.env.rig`, a test database's by the suite
-- that opens a second connection. A role with LOGIN and no password
-- authenticates nothing, which is the right default.
--
-- ROLES ARE CLUSTER-GLOBAL AND GRANTS ARE PER-DATABASE, so creation is
-- written idempotently exactly as …100012 writes it, and the ALTER after it
-- is what makes this migration CONVERGE rather than merely not fail: a
-- second database in the same cluster finds the role already there, and the
-- attributes this ticket's audit checks — LOGIN, not superuser, no
-- BYPASSRLS — are then asserted rather than assumed.
DO $$
BEGIN
    CREATE ROLE dito_owner;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;

-- NOBYPASSRLS IS NOT DECORATION. The whole of this ticket's tenant
-- isolation is row-level security keyed to a per-connection setting
-- (…100040). A role with BYPASSRLS reads every company's rows through the
-- same granted views and nothing about the grant diff would look different,
-- which is why the FR-71a audit asserts this attribute rather than trusting
-- that nobody ever runs one ALTER ROLE.
ALTER ROLE dito_owner
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- THE ROLE THE OWNER-VISIBLE VIEWS RUN AS, and the one deviation from the
-- ticket's letter in this ticket — argued here because a migration is where
-- a reader will look for it.
--
-- The ticket asks for two things that PostgreSQL cannot both grant:
-- (a) the finalized views become INVOKER-RIGHTS views "so RLS applies
-- through them", and (b) `dito_owner` holds nothing on a `ledger` table,
-- nothing on a `public` table — any such SELECT must fail on privilege.
-- `security_invoker = true` checks the INVOKER's privileges on every base
-- relation the view reads, so an invoker-rights `finalized_facts` requires
-- `dito_owner` to hold SELECT on `ledger.facts` AND on `public.seats`. Both
-- are wall breaches with a one-line proof: `SELECT filed_by_twin_id FROM
-- ledger.facts` hands the owner the exact column the view exists to
-- withhold, `SELECT payload FROM ledger.facts` hands it shadow rows
-- (ADR-0016), and `SELECT twin_id FROM seats` hands it the twin ADR-0004's
-- amendment says must never cross. (b) is stated three times — in the
-- ticket, in its acceptance criteria and in spec #126's definition of done
-- — and it is what the FR-71a audit this ticket writes must be able to
-- claim, so (b) wins.
--
-- What (a) is FOR is that the RLS policy applies through the view rather
-- than being bypassed by it, and that is what this role delivers. The views
-- stay DEFINER-rights and change owner: base-relation privileges and RLS
-- policies are then evaluated as `dito_ledger_views`, which is not a
-- superuser, does not hold BYPASSRLS, and is not the tables' owner — so the
-- company policy in …100040 applies to every read through every one of
-- these views. `dito` (the schema owner, and a superuser in every cluster
-- this runs in) keeps reading the tables directly exactly as it does today.
--
-- NOTHING EVER CONNECTS AS THIS ROLE: it is NOLOGIN, it holds SELECT and
-- nothing else, and it exists so that "the view runs as somebody RLS binds"
-- has a name.
--
-- THE COST, said out loud because it is real. Spec #126 decision 4 expects
-- RLS to bite "only on the owner path this slice", and this shape is
-- slightly wider than that: a definer view is evaluated as its OWNER for
-- every caller, so `dito` — the schema owner, a superuser that bypasses RLS
-- at the tables — now reads the FINALIZED VIEWS through a policy-bound
-- role, and a session naming no company reads nothing through one. Reads of
-- the tables underneath are untouched, which is every rep-side path in the
-- repo; what moves is three test assertions that read a finalized view and
-- now declare which company is reading, which is what the owner app does
-- anyway. The alternative was granting `dito_owner` SELECT on
-- `ledger.facts`, and a wall that costs three `set_config` calls is the
-- cheaper of the two.
DO $$
BEGIN
    CREATE ROLE dito_ledger_views;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;

ALTER ROLE dito_ledger_views
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- THE OWNER'S OWN STATE (spec #126 decision 3). Execution records,
-- questions and answers live in a schema the owner app OWNS, so its own
-- writes need no grant from anybody and its own tables can never be
-- confused with the Ledger's. The TABLES arrive with #130 and #131; this
-- migration creates the schema and the default privileges, so that a table
-- created there by a later Atlas migration — which runs as `dito`, not as
-- `dito_owner` — is usable by the owner app the moment it exists rather
-- than after somebody remembers a GRANT.
--
-- FR-73's store count is unchanged by this schema: it enumerates REP-SIDE
-- stores, and everything in `owner` is owner-side (spec #126, Testing
-- Decisions).
CREATE SCHEMA owner AUTHORIZATION dito_owner;

COMMENT ON SCHEMA owner IS
    'Ticket #127: the owner app''s own state — execution records, questions and answers (#130, #131). Owned by dito_owner; holds no Ledger data and no rep-side store.';

-- No `FOR ROLE`, so these attach to the role running the migration — which
-- is the role that will CREATE the #130 tables, and default privileges
-- attach to the creator rather than to the schema. Naming a role literally
-- would silently do nothing on a cluster whose migration user is called
-- something else. Without this the #130 tables would be owned by the
-- migration role and unreadable by the app that is supposed to own them.
ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT ALL ON TABLES TO dito_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA owner GRANT ALL ON SEQUENCES TO dito_owner;

-- THE OWNER'S REACH, in full. Two schema USAGEs and nothing else in this
-- migration: USAGE lets a role NAME an object in a schema and grants no
-- privilege on any object in it, so `wa_events`, `disclosure_lines`,
-- `aperture_questions`, `twin_keys` and every `ledger` table stay a
-- privilege error. The three views and the one function it may reach are
-- granted in …100030 and …100050, where they are defined.
GRANT USAGE ON SCHEMA ledger TO dito_owner;
GRANT USAGE ON SCHEMA public TO dito_owner;
GRANT USAGE ON SCHEMA ledger TO dito_ledger_views;
GRANT USAGE ON SCHEMA public TO dito_ledger_views;

-- Neither may create objects outside the owner's own schema — the same rule
-- …100012 applies to the two rep-side roles, and for the same reason:
-- schema changes are Atlas's, run as the owner (ADR-0029). `dito_owner`
-- creating a function in `public` would also be a way to smuggle a leaky
-- operator past a view's WHERE clause, which is why the views this ticket
-- ships are `security_barrier` as well.
REVOKE CREATE ON SCHEMA public FROM dito_owner, dito_ledger_views;

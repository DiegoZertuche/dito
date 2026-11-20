-- Tenant isolation in the database, now (ticket #127; spec #126 decision 4;
-- ADR-0002, ADR-0029).
--
-- NUMBERING: the …202609021000·0 range, reserved for this ticket.
--
-- ADR-0002 has said "every shared table carries `company_id` under Postgres
-- RLS" since the spine was written, and until this migration NO ROW-LEVEL
-- SECURITY EXISTED ANYWHERE in this database: not a policy, not an ENABLE,
-- not one `current_setting` in SQL. That was defensible while nothing
-- connected as an application role — a policy that binds nobody is a
-- comment — and it stops being defensible in the slice where an app
-- authenticates as `dito_owner` and reads another company's Ledger if a
-- WHERE clause is ever forgotten.
--
-- THE POLICY IS KEYED TO A PER-CONNECTION SETTING, `dito.company_id`, which
-- the owner app sets once per connection from the company it is serving,
-- and which every policy below reads through ONE function rather than by
-- repeating the expression. `ledger.declared_company()` is defined first,
-- for a reason the TypeScript side already acts on: the setting's name is
-- exported as a single constant so #129 and #130 cannot drift apart on it,
-- and five copies of the same predicate in SQL would take back exactly that
-- drift. It is also what makes the FR-71a audit able to PIN the policy: one
-- short expression it can compare against, instead of a fragment of SQL
-- text nobody can diff.
--
-- Three properties of that function matter and each is a deliberate choice:
--
--   * `current_setting(…, true)` is the MISSING-OK form, so an unset
--     setting yields NULL rather than an error, and `company_id = NULL` is
--     NULL, so the row is filtered. A connection that forgot to declare its
--     company therefore reads ZERO ROWS — never everything.
--   * `NULLIF(…, '')` because a setting explicitly set to the empty string
--     is the same statement as not setting one, and `''::uuid` would raise
--     instead of returning nothing.
--   * It is a SETTING and not a role, because the alternative — one
--     database role per company — makes onboarding a migration.
--
-- WHO RLS ACTUALLY BINDS THIS SLICE, said plainly because the answer is
-- narrower than "everyone". `dito`, the schema owner, is a SUPERUSER in
-- every cluster this runs in, and a superuser bypasses row-level security
-- outright — `FORCE ROW LEVEL SECURITY` below makes the table's owner
-- subject to its policies, and cannot reach past `rolsuper`. So the rep
-- side, which connects as `dito` today, keeps working exactly as it does
-- and this migration changes nothing for it. What RLS binds is
-- `dito_ledger_views` — the role the owner-visible views now run as — and
-- through it every read `dito_owner` can perform. That is the path this
-- slice opens, and it is the path this migration closes.
--
-- FORCE anyway, on every table, because the day the schema owner stops
-- being a superuser is the day someone discovers which of these ENABLEs was
-- load-bearing, and finding that out from a policy is cheaper than finding
-- it out from a leak.
--
-- REP-SIDE PROCESSES ARE OUT OF SCOPE (spec #126, Out of Scope: "rep-side
-- roles becoming connections"). `dito_aperture` holds SELECT and INSERT on
-- every `ledger` table and is NOT the tables' owner, so ENABLE alone would
-- start filtering its reads and refusing its writes — silently, since a
-- policy denial is an empty result rather than an error. It gets an
-- unrestricted policy below, which preserves today's behaviour exactly.
-- That is the same unscoped grant …100012 recorded as slice 4's debt, and
-- it is still debt: when the aperture becomes a connection it needs a
-- policy that derives its company from the seam row it is filing off,
-- rather than one that says `true`. Recorded, not repaired here.
--
-- `dito_twin_runtime` gets NO policy on a `ledger` table, and needs none:
-- it holds no privilege on one (the grant audit's second claim), and its
-- SELECT on the two finalized views now goes through `dito_ledger_views`,
-- so it too reads inside whatever company its connection declares.

CREATE FUNCTION ledger.declared_company() RETURNS uuid
LANGUAGE sql
STABLE
-- PARALLEL SAFE: reading a GUC is safe in a parallel worker (settings are
-- copied into one), and the default for a SQL function is UNSAFE — which
-- would quietly cost every owner timeline read its parallel plan.
PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('dito.company_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION ledger.declared_company() IS
    'Ticket #127: the company this connection declared, or NULL if it declared none. The single definition every row-level policy and the resolution function read.';

-- WHO MAY EVALUATE THE POLICY. …100050 revokes PUBLIC's default EXECUTE
-- across this schema, so the grant has to be explicit, and it has to name
-- BOTH the role the views run as and `dito_owner` itself: PostgreSQL checks
-- a policy expression's function privileges against the SESSION's user even
-- when the relation underneath is reached through a definer view, so an
-- owner connection without this grant fails on `permission denied for
-- function declared_company` instead of reading its own company's rows.
--
-- That makes two `ledger` functions the owner may call rather than one, and
-- the second is safe by construction: `declared_company()` reads a setting
-- the caller itself set and touches no table, so calling it tells the
-- caller only what the caller already said. Both are pinned by name in the
-- FR-71a audit, so a third one is still a violation.
GRANT EXECUTE ON FUNCTION ledger.declared_company() TO dito_ledger_views;
GRANT EXECUTE ON FUNCTION ledger.declared_company() TO dito_owner;
-- ...and the twin-side reader, which is the other half of a grant it has
-- held since …100012. Its SELECT on the two finalized views now goes
-- through a policy, and a policy's function privileges are checked against
-- the SESSION's role even inside a definer view — so without this that
-- SELECT fails on `permission denied for function declared_company`, and
-- the grant audit's claim about it would be green over a read that cannot
-- happen.
GRANT EXECUTE ON FUNCTION ledger.declared_company() TO dito_twin_runtime;

-- ledger.entities
ALTER TABLE ledger.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.entities FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_entities_company_read ON ledger.entities
    FOR SELECT TO dito_ledger_views
    USING (company_id = ledger.declared_company());
COMMENT ON POLICY ledger_entities_company_read ON ledger.entities IS
    'Ticket #127: the owner path. This connection reads the rows of the company it declared, and of no other — a missing declaration is NULL, so it reads nothing.';
CREATE POLICY ledger_entities_aperture ON ledger.entities
    FOR ALL TO dito_aperture USING (true) WITH CHECK (true);
COMMENT ON POLICY ledger_entities_aperture ON ledger.entities IS
    'Ticket #127: UNRESTRICTED, and recorded as debt rather than designed. The aperture is the Ledger''s writer and derives its company from the seam row it files off, not from a connection setting; this policy preserves exactly the behaviour it had before RLS existed. Scoping it belongs with the slice that makes it a connection.';

-- ledger.entity_grants
ALTER TABLE ledger.entity_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.entity_grants FORCE ROW LEVEL SECURITY;
-- No read policy for the view owner: no owner-visible view reads this
-- table. A grant says which rep twin may read which entity's timeline, and
-- it is rep-side reach, not owner-visible provenance. RLS is on so that the
-- day one is written, it is written on purpose.
CREATE POLICY ledger_entity_grants_aperture ON ledger.entity_grants
    FOR ALL TO dito_aperture USING (true) WITH CHECK (true);
COMMENT ON POLICY ledger_entity_grants_aperture ON ledger.entity_grants IS
    'Ticket #127: UNRESTRICTED, and recorded as debt rather than designed. The aperture is the Ledger''s writer and derives its company from the seam row it files off, not from a connection setting; this policy preserves exactly the behaviour it had before RLS existed. Scoping it belongs with the slice that makes it a connection.';

-- ledger.entity_merges
ALTER TABLE ledger.entity_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.entity_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_entity_merges_aperture ON ledger.entity_merges
    FOR ALL TO dito_aperture USING (true) WITH CHECK (true);
COMMENT ON POLICY ledger_entity_merges_aperture ON ledger.entity_merges IS
    'Ticket #127: UNRESTRICTED, and recorded as debt rather than designed. The aperture is the Ledger''s writer and derives its company from the seam row it files off, not from a connection setting; this policy preserves exactly the behaviour it had before RLS existed. Scoping it belongs with the slice that makes it a connection.';

-- ledger.entity_unmerges
ALTER TABLE ledger.entity_unmerges ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.entity_unmerges FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_entity_unmerges_aperture ON ledger.entity_unmerges
    FOR ALL TO dito_aperture USING (true) WITH CHECK (true);
COMMENT ON POLICY ledger_entity_unmerges_aperture ON ledger.entity_unmerges IS
    'Ticket #127: UNRESTRICTED, and recorded as debt rather than designed. The aperture is the Ledger''s writer and derives its company from the seam row it files off, not from a connection setting; this policy preserves exactly the behaviour it had before RLS existed. Scoping it belongs with the slice that makes it a connection.';

-- ledger.facts
ALTER TABLE ledger.facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.facts FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_facts_company_read ON ledger.facts
    FOR SELECT TO dito_ledger_views
    USING (company_id = ledger.declared_company());
COMMENT ON POLICY ledger_facts_company_read ON ledger.facts IS
    'Ticket #127: the owner path. This connection reads the rows of the company it declared, and of no other — a missing declaration is NULL, so it reads nothing.';
CREATE POLICY ledger_facts_aperture ON ledger.facts
    FOR ALL TO dito_aperture USING (true) WITH CHECK (true);
COMMENT ON POLICY ledger_facts_aperture ON ledger.facts IS
    'Ticket #127: UNRESTRICTED, and recorded as debt rather than designed. The aperture is the Ledger''s writer and derives its company from the seam row it files off, not from a connection setting; this policy preserves exactly the behaviour it had before RLS existed. Scoping it belongs with the slice that makes it a connection.';

-- THE REGISTRIES (…100010). `seats` is read by two owner-visible views and
-- carries its company on the row, so it takes the same policy the Ledger's
-- tables take.
ALTER TABLE seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE seats FORCE ROW LEVEL SECURITY;
CREATE POLICY seats_company_read ON seats
    FOR SELECT TO dito_ledger_views
    USING (company_id = ledger.declared_company());
COMMENT ON POLICY seats_company_read ON seats IS
    'Ticket #127: the owner path. This connection reads the rows of the company it declared, and of no other — a missing declaration is NULL, so it reads nothing.';

-- `companies` gets RLS with NO POLICY AT ALL, which is a deny-all for every
-- role that is not a superuser. That is the correct state today and it is
-- not an oversight: nothing owner-visible reads this table, and the two
-- things that will — the aperture reading a company's mode at filing, and
-- the lift act setting `shadow_lifted_at` — arrive with their own tickets
-- and owe their own policy, written where the reader is.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

-- AND ONLY NOW, THE OWNER'S THREE OBJECTS — the whole of its reach into
-- anybody else's data, and FR-71a's job is to keep it that way.
--
-- The grants are HERE rather than in …100030 where the views are defined,
-- because Atlas applies one transaction per migration file: granting them
-- beside the views would leave a window, between two files, in which the
-- owner could select three views that no policy yet scopes. Nothing else in
-- the repo is granted away from its definition, and this one is, on
-- purpose — the same transaction that can see the rows is the one that
-- restricts them.
GRANT SELECT ON ledger.finalized_entities TO dito_owner;
GRANT SELECT ON ledger.finalized_facts TO dito_owner;
GRANT SELECT ON seats_status TO dito_owner;

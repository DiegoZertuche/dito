-- The other half of the owner's merge-resolved read (ticket #129; spec #126
-- decision 15; ADR-0035, ADR-0002).
--
-- NUMBERING: the …2026090210006x range. Ticket #127 took …10 through …50 and
-- ticket #132 — running in parallel with this one — owns …7x, so the two
-- never collide in the Atlas directory.
--
-- WHY A SECOND FUNCTION AT ALL. …100050 gave the owner
-- `resolve_entity_for_declared_company(entity)`, which answers "which record
-- is this one NOW". That is one of the two questions a resolved timeline
-- asks, and on its own it renders a merged cliente WRONG in the direction
-- the spec cares about: merge is a redirect and facts NEVER MOVE (ADR-0035),
-- so the survivor's own `entity_id` selects only the facts filed against the
-- survivor, and everything the loser carried — the older half of the
-- customer's history, which is usually the interesting half — silently
-- disappears from the page. Spec #126 decision 15 asks for the opposite:
-- "lists facts filed against every member, unmoved, so a merged cliente
-- reads as one".
--
-- THE OWNER CANNOT ENUMERATE THOSE MEMBERS ITSELF, by design. Membership is
-- a walk over `ledger.entity_merges` and `ledger.entity_unmerges`, and
-- `dito_owner` holds nothing on either and may not call
-- `ledger.active_entity_merges` — …100050 says why in full: that function
-- returns the merge GRAPH, which is Ledger machinery rather than provenance,
-- and handing the owner "who merged with whom" is a different disclosure
-- from "this customer's history is one history". So the walk happens inside
-- a definer function that returns entity ids and nothing else: no edge, no
-- status, no direction, no timestamp. What comes out is a membership set,
-- which is exactly what the timeline read needs and the least the owner can
-- be told to get it.
--
-- IT TAKES NO COMPANY, for …100050's reason and not a new one (spec #126
-- decision 6): a read's parameters narrow ROWS and never the company. A
-- company parameter on an owner-callable SECURITY DEFINER function lends the
-- definer's reach to whatever company the caller names. The company comes
-- off the same per-connection setting the row-level policies read, and a
-- connection that declared none is REFUSED with `insufficient_privilege`
-- rather than answered about a company nobody named.
--
-- THE WALK IS `readResolvedTimeline`'s, MOVED RATHER THAN REDERIVED
-- (`packages/aperture/src/merge.ts`). Same three properties, and each one is
-- load-bearing:
--
--   * it follows `ledger.active_entity_merges`, so a reversed edge is not
--     followed (ADR-0035 as amended — the unmerge is an appended reversal
--     and every one of the graph's walks must respect it);
--   * it takes only `status = 'merged'`, because a `created_in_error` loser
--     still RESOLVES — its id never dangles — and its facts do NOT read
--     forward. The two statuses mean opposite things for exactly this
--     question, which is why the status is on the edge;
--   * it seeds from the RESOLVED entity rather than from the argument, so
--     asking about the loser and asking about the winner return the same
--     set. That is what makes "the loser's id resolves to the same page"
--     true (ticket #129's second acceptance criterion) rather than
--     accidental.
--
-- `UNION` rather than `UNION ALL` terminates the recursion over a graph that
-- should be impossible: the store's trigger refuses a cycle, and a walk that
-- hangs is a worse failure than a wrong answer, so the guard stays.
--
-- `search_path = pg_catalog` is pinned for the reason every SECURITY DEFINER
-- function in this schema pins it: resolving names through the CALLER's
-- search path is the classic privilege-escalation hole. Every reference in
-- the body is schema-qualified.
CREATE FUNCTION ledger.resolved_members_for_declared_company(p_entity_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
    company uuid := ledger.declared_company();
BEGIN
    IF company IS NULL THEN
        RAISE EXCEPTION
            'ledger.resolved_members_for_declared_company refused: this connection declared no company'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
    WITH RECURSIVE members (entity_id) AS (
        SELECT ledger.resolve_entity(company, p_entity_id)
      UNION
        SELECT e.loser_entity_id
          FROM ledger.active_entity_merges(company) e
          JOIN members m ON m.entity_id = e.winner_entity_id
         WHERE e.status = 'merged'
    )
    SELECT entity_id FROM members;
END;
$$;

COMMENT ON FUNCTION ledger.resolved_members_for_declared_company(uuid) IS
    'Ticket #129: every entity whose facts read forward under the resolved record, for the company this connection declared and no other. Returns entity ids only — never an edge, a status or a direction — so a merged cliente reads as one timeline without the owner reading the merge graph (spec #126 decision 15; ADR-0035).';

-- PUBLIC'S DEFAULT EXECUTE, REVOKED BY NAME — AND …100050's `ALTER DEFAULT
-- PRIVILEGES` DID NOT DO IT.
--
-- That migration ends with `ALTER DEFAULT PRIVILEGES IN SCHEMA ledger REVOKE
-- EXECUTE ON FUNCTIONS FROM PUBLIC` and says it makes "a new `ledger`
-- function private by construction rather than by whoever remembers". It
-- does not: PostgreSQL records no `pg_default_acl` row for that statement,
-- and the function created above arrived with `proacl = {=X/dito, …}` —
-- PUBLIC holding EXECUTE — on a freshly migrated database. FR-71a is what
-- caught it, which is the response the pin exists for, and this line is the
-- fix for this function. The claim itself is recorded on #129 as a standing
-- correction to …100050's comment; nothing rewrites an applied migration.
REVOKE ALL ON FUNCTION ledger.resolved_members_for_declared_company(uuid)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ledger.resolved_members_for_declared_company(uuid)
    TO dito_owner;

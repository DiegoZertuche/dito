-- The one function the owner may run (ticket #127; spec #126 decisions 3
-- and 15; ADR-0035, ADR-0002).
--
-- NUMBERING: the …202609021000·0 range, reserved for this ticket.
--
-- WHY THE OWNER NEEDS IT AT ALL. Spec #126 decision 15: "Timelines read
-- resolved. The timeline read follows standing merge edges to the resolved
-- entity (ADR-0035) and lists facts filed against every member, unmoved, so
-- a merged cliente reads as one." Merge is a redirect — the loser keeps its
-- row and points at the winner, facts never move — so an owner timeline
-- that did not resolve would show one customer as two. `resolve_entity` is
-- how every other walk in this system answers that question, and the owner
-- gets the same answer from the same function rather than a second
-- implementation that can disagree with it.
--
-- TWO THINGS WERE IN THE WAY, and this migration is both of them.
--
-- FIRST, EXECUTE WAS NEVER GRANTED TO ANYBODY. PostgreSQL grants EXECUTE on
-- a new function to PUBLIC by default, so both `ledger` functions have been
-- executable by every role in the cluster since they were written, on an
-- ACL of NULL that no audit could read as a decision. "The owner holds
-- EXECUTE on exactly the named function" is unclaimable while PUBLIC holds
-- EXECUTE on all of them, so the default is revoked here and every caller
-- is named. The trigger functions are revoked too: a trigger's EXECUTE
-- privilege is checked when the trigger is CREATED, not each time it fires,
-- so the constraint triggers on `ledger.facts` and `ledger.entities` are
-- unaffected — and a function nobody may call by hand is one less way to
-- reach a Ledger row.
--
-- SECOND, THE FUNCTION READ TABLES ITS NEW CALLER MAY NOT READ. Both
-- `ledger` functions are plain `LANGUAGE sql`, so they run with the
-- CALLER's rights, and `resolve_entity` walks `ledger.entity_merges` and
-- `ledger.entity_unmerges` through `ledger.active_entity_merges`. Under
-- `dito_owner` — which holds nothing on any `ledger` table, by design and
-- by FR-71a — that is a privilege error, and a granted function that always
-- fails is worse than no grant. `SECURITY DEFINER` with a pinned
-- `search_path` is the established PostgreSQL shape for precisely this: a
-- function the caller may run over tables the caller may not read.
--
-- SO THE OWNER GETS A DIFFERENT FUNCTION, NOT A DIFFERENT `resolve_entity`.
-- `resolve_entity(company, entity)` is untouched by this migration: same
-- body, same `LANGUAGE sql`, same caller's rights, and the aperture's four
-- call sites behave bit-for-bit as they did. What the owner is granted is
-- `resolve_entity_for_declared_company(entity)`, which TAKES NO COMPANY AT
-- ALL and reads it off the connection instead.
--
-- That shape is the spec's, not a workaround. Spec #126 decision 6: a
-- read-only tool's "parameters select rows (entity, window, fact type,
-- seat) and NEVER columns, tables or company". A company parameter on an
-- owner-callable `SECURITY DEFINER` function is exactly the thing that
-- sentence forbids — it lends the definer's reach to whatever company the
-- caller names, so `dito_owner` could ask about another company's merge
-- graph and be answered. Removing the parameter removes the question: the
-- company comes from the same per-connection setting the row-level policies
-- read, and there is nothing for a caller to widen.
--
-- IT REFUSES A CONNECTION THAT DECLARED NOTHING, rather than answering
-- about whatever it was handed. A NULL declared company is how an owner
-- session reads zero rows through the views, and here it is a caller with
-- no tenant at all — so it raises `insufficient_privilege`, the same
-- SQLSTATE everything else the owner may not reach answers with, instead of
-- resolving against a company nobody named. `plpgsql` is what lets it
-- raise; the walk itself is still `resolve_entity`'s, so there is one
-- implementation of resolution and no second one to disagree with it.
--
-- `search_path = pg_catalog` is pinned because a `SECURITY DEFINER`
-- function that resolves names through the caller's search path is the
-- classic privilege-escalation hole; every reference in the body is
-- schema-qualified and the path can hold nothing the caller controls.
CREATE FUNCTION ledger.resolve_entity_for_declared_company(p_entity_id uuid)
RETURNS uuid
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
            'ledger.resolve_entity_for_declared_company refused: this connection declared no company'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN ledger.resolve_entity(company, p_entity_id);
END;
$$;

COMMENT ON FUNCTION ledger.resolve_entity_for_declared_company(uuid) IS
    'Ticket #127: the resolved entity, for the company this connection declared and no other. The owner''s only route to ADR-0035''s resolution: it takes no company, because a read''s parameters narrow rows and never the company (spec #126 decision 6).';

-- PUBLIC's default EXECUTE, revoked everywhere in `ledger` so that "exactly
-- the named function" is a fact about the catalog rather than a hope.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
-- ...and on anything a later migration adds, so a new `ledger` function is
-- private by construction rather than by whoever remembers.
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- THE APERTURE calls `resolve_entity` on the merge path (merge.ts) and
-- `active_entity_merges` under it, and it is the Ledger's writer: it gets
-- both, so the day something authenticates as it the merge does not fail on
-- a privilege.
GRANT EXECUTE ON FUNCTION ledger.resolve_entity(uuid, uuid) TO dito_aperture;
GRANT EXECUTE ON FUNCTION ledger.active_entity_merges(uuid) TO dito_aperture;

-- THE OWNER gets the no-company wrapper and nothing else — not
-- `resolve_entity` itself, whose company parameter it must not be able to
-- choose, and not `active_entity_merges`, which would return the merge
-- graph. The owner asks "which record is this one now" about a customer of
-- its own company and is answered; it does not get to read who merged with
-- whom, which is Ledger machinery rather than provenance.
GRANT EXECUTE ON FUNCTION ledger.resolve_entity_for_declared_company(uuid)
    TO dito_owner;

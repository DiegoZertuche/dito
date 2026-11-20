-- The undo ADR-0036's argument already assumes (ticket #62; ADR-0035,
-- ADR-0036, ADR-0020, ADR-0003 as amended, ADR-0004).
--
-- ADR-0036 spends one rule to justify merging without asking anybody:
-- "automation that cannot be undone does not get to skip the human;
-- automation that can be undone should." What …100050 shipped was UNDOABLE
-- DATA — an immutable edge, a recorded effect set, facts that never move —
-- and no undo. This file is the undo.
--
-- AN UNMERGE IS AN APPENDED REVERSAL, NEVER AN UPDATE. `entity_merges`
-- stays immutable by trigger and by privilege; the store recorded the merge
-- that actually happened and goes on recording it. What changes is that a
-- SECOND row, here, says that edge no longer stands — and every walk over
-- the graph reads the edges that still stand.
--
-- NOTHING MOVES. A merge redirects only at READ time, through
-- `ledger.resolve_entity`; facts are filed against the entity they were
-- filed against and stay there, before and after. So an unmerge deactivates
-- the redirect and nothing else: every fact falls back where it always was,
-- because it never left. This is why the crux that defeats every MDM vendor
-- surveyed — who owns facts written AFTER the merge (Reltio refuses,
-- Informatica deletes) — does not arise here. FHIR models it identically:
-- `Linkage` carries an `active` boolean, and unmerge is deactivate the
-- assertion, don't delete it.
--
-- THIS FILE NAMES NO CONVERSATION, and that is enforced
-- (binding-wall.test.ts). Reversing a merge is entity-to-entity, exactly as
-- making one was.

-- The company-scoped identity of an edge, so a reversal can name one
-- without a bare id addressing a row across companies. Same reasoning as
-- the merge edge's own composite foreign keys: the company is half of every
-- Ledger key precisely because the ids are client-minted (ADR-0035).
CREATE UNIQUE INDEX ledger_entity_merges_company_scoped_id
    ON ledger.entity_merges (company_id, id);

CREATE TABLE ledger.entity_unmerges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    -- The edge this reverses. NOT the two entities: an unmerge takes back
    -- ONE recorded decision, and after `A→B→C` the two ids alone would not
    -- say which of the two merges was wrong.
    merge_id uuid NOT NULL,
    -- The human-or-machine stamp the merge carries, on the reversal too
    -- (ADR-0035). Everything written today is 'human': nothing detects a
    -- wrong merge, so there is no machine that could reverse one, and the
    -- value exists so that the day a detector arrives its reversals are
    -- stamped differently rather than indistinguishably — which is the
    -- mirror image of why `human` sat unwritten on the merge edge.
    performed_by text NOT NULL,
    unmerged_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entity_unmerges_performed_by_check
        CHECK (performed_by IN ('human', 'machine')),
    CONSTRAINT ledger_entity_unmerges_merge_fkey
        FOREIGN KEY (company_id, merge_id)
        REFERENCES ledger.entity_merges (company_id, id)
);

-- ONE REVERSAL PER EDGE. A merge either stands or it does not; a second
-- reversal of the same edge would record a state change that did not
-- happen. Re-merging after an unmerge files a NEW edge, which then has a
-- reversal of its own available — the history is a sequence of decisions,
-- never a toggled flag.
CREATE UNIQUE INDEX ledger_entity_unmerges_one_per_merge
    ON ledger.entity_unmerges (company_id, merge_id);

-- THE REVERSAL IS IMMUTABLE TOO, for the reason the edge is: an undo that
-- could itself be erased puts the graph back in a state nothing recorded.
-- Reuses the edge's own trigger function, so the two can never diverge in
-- what they refuse.
CREATE TRIGGER ledger_entity_unmerges_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger.entity_unmerges
    FOR EACH ROW EXECUTE FUNCTION ledger.entity_merges_immutable();

CREATE TRIGGER ledger_entity_unmerges_no_truncate
    BEFORE TRUNCATE ON ledger.entity_unmerges
    FOR EACH STATEMENT EXECUTE FUNCTION ledger.entity_merges_immutable();

-- THE EDGES THAT STILL STAND, in one definition.
--
-- Six walks read this graph — resolution, the timeline's membership, the
-- matcher's struck-record filter, the effect set's component, the writer's
-- cycle check and the store's own — and "a reversed edge is not followed"
-- has to be true of every one of them. Written once, as a function rather
-- than a view, because a `ledger` VIEW must filter `shadow` on a
-- shadow-flagged table and be twin-runtime-selectable (ADR-0016, enforced
-- by the grant audit), and the merge edge has neither a `shadow` column nor
-- a twin-side reader.
CREATE FUNCTION ledger.active_entity_merges(p_company_id uuid)
RETURNS TABLE (
    id uuid,
    loser_entity_id uuid,
    winner_entity_id uuid,
    status text
)
LANGUAGE sql
STABLE
AS $$
    SELECT m.id, m.loser_entity_id, m.winner_entity_id, m.status
      FROM ledger.entity_merges m
     WHERE m.company_id = p_company_id
       AND NOT EXISTS (
           SELECT 1
             FROM ledger.entity_unmerges u
            WHERE u.company_id = m.company_id AND u.merge_id = m.id
       );
$$;

COMMENT ON FUNCTION ledger.active_entity_merges(uuid) IS
    'Ticket #62: the merge edges that have not been reversed. An unmerge is an appended reversal, so "does this edge still stand?" is a join and never a column on the edge.';

-- RESOLUTION FOLLOWS THE EDGES THAT STILL STAND. Everything else about
-- this function is unchanged from …100050, including the two things a
-- reader should not have to re-derive: the `CYCLE` guard, so a walk
-- terminates even over a graph that should be impossible; and the
-- deliberate silence about `status`, because a `created_in_error` id still
-- RESOLVES — what its status changes is whether its facts read forward.
--
-- After an unmerge the loser resolves to ITSELF, which is the whole
-- observable effect of the undo.
CREATE OR REPLACE FUNCTION ledger.resolve_entity(p_company_id uuid, p_entity_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    WITH RECURSIVE walk (entity_id, depth) AS (
        SELECT p_entity_id, 0
      UNION ALL
        SELECT m.winner_entity_id, w.depth + 1
          FROM ledger.active_entity_merges(p_company_id) m
          JOIN walk w ON w.entity_id = m.loser_entity_id
    ) CYCLE entity_id SET is_cycle USING path
    SELECT entity_id
      FROM walk
     WHERE NOT is_cycle
     ORDER BY depth DESC
     LIMIT 1;
$$;

-- ONE ACTIVE OUT-EDGE PER LOSER, moved from an index into the trigger.
--
-- …100050 stated it as `UNIQUE (company_id, loser_entity_id)`, which made
-- an entity a loser at most ONCE IN ITS LIFE. That is right while merges
-- are forever and wrong the moment one can be reversed: unmerge A from B
-- and A could never merge into anything again, so the undo would cost the
-- record its future. The RULE is unchanged — every entity points at one
-- successor or at none, which is what makes resolution a walk rather than
-- a search — but "one" now means one that still stands, and no index can
-- express a predicate over a second table.
--
-- It lands in the same trigger as the cycle check, under the same
-- company-scoped lock, taken before either read. Serialization is what
-- makes both rules true against a concurrent writer, and the lock is
-- already here.
--
-- STATED PLAINLY, BECAUSE IT IS A REAL LOSS: an index holds whether or not
-- triggers are enabled, and this now does not — it is one DISABLE TRIGGER
-- away from being untrue, which is the exact weakness this file rejects
-- below for `entity_unmerges`'s own append-only rule. There is no way to
-- keep the index: Postgres has no cross-table uniqueness, and "one that
-- still stands" is a predicate over the reversals. The mandatory cycle
-- check has always rested on this same trigger, so the rule joins it
-- rather than being demoted below it.
DROP INDEX ledger.ledger_entity_merges_one_per_loser;

-- The lookup the resolution walk makes, kept: only its uniqueness went.
CREATE INDEX ledger_entity_merges_loser
    ON ledger.entity_merges (company_id, loser_entity_id);

CREATE OR REPLACE FUNCTION ledger.entity_merges_refuse_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    closes boolean;
    standing uuid;
BEGIN
    -- ONE INSERTION AT A TIME PER COMPANY, taken BEFORE either read (Codex
    -- r1 on #55). A graph read under READ COMMITTED cannot see an edge
    -- another transaction has written and not yet committed, so two
    -- transactions inserting A→B and B→A each look and each find nothing.
    --
    -- The lock lives HERE rather than in the writer so that it holds for
    -- every path into this table: a repair script, a future human merge
    -- verb, a hand-run INSERT. The matcher takes the same key before it
    -- reads, and advisory transaction locks are re-entrant, so that costs
    -- nothing and the two compose.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('dito:merge:company:' || NEW.company_id::text, 0));

    -- Does this loser already point somewhere that STILL STANDS? A second
    -- live out-edge would silently overwrite the first one's answer.
    -- Raised as a unique violation because that is exactly what it is —
    -- and it is the SQLSTATE the writer already translates into its own
    -- typed refusal, unchanged from when an index raised it.
    SELECT m.id INTO standing
      FROM ledger.active_entity_merges(NEW.company_id) m
     WHERE m.loser_entity_id = NEW.loser_entity_id
     LIMIT 1;
    IF standing IS NOT NULL THEN
        RAISE EXCEPTION
            'entity % already resolves through a merge that still stands (%): one active out-edge per loser (ADR-0035)',
            NEW.loser_entity_id, standing
            USING ERRCODE = 'unique_violation';
    END IF;

    -- Is the new loser already reachable FROM the winner? If so this edge
    -- closes the ring. The degenerate case (winner = loser) is caught by
    -- the seed row of the same walk. Over the edges that still stand: a
    -- reversed edge closes nothing, which is what lets a reversed A→B be
    -- followed by a deliberate B→A.
    WITH RECURSIVE walk (entity_id) AS (
        SELECT NEW.winner_entity_id
      UNION ALL
        SELECT m.winner_entity_id
          FROM ledger.active_entity_merges(NEW.company_id) m
          JOIN walk w ON w.entity_id = m.loser_entity_id
    ) CYCLE entity_id SET is_cycle USING path
    SELECT EXISTS (
        SELECT 1 FROM walk WHERE entity_id = NEW.loser_entity_id
    ) INTO closes;

    IF closes THEN
        RAISE EXCEPTION
            'refusing a merge that closes a cycle: % already resolves through % (ADR-0035: a cycle check is mandatory)',
            NEW.winner_entity_id, NEW.loser_entity_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- A REVERSAL TAKES THE SAME COMPANY LOCK. It changes which edges the graph
-- walks follow, so it is a write to the same graph the cycle check reads —
-- and a reversal committing between another transaction's reachability
-- read and its INSERT would let through an edge decided against a graph
-- that no longer existed. The lock is re-entrant, so the writer taking it
-- first costs nothing.
CREATE FUNCTION ledger.entity_unmerges_serialize() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended('dito:merge:company:' || NEW.company_id::text, 0));
    RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entity_unmerges_serialize
    BEFORE INSERT ON ledger.entity_unmerges
    FOR EACH ROW EXECUTE FUNCTION ledger.entity_unmerges_serialize();

-- Grants, on purpose — …100012's ALTER DEFAULT PRIVILEGES already reaches
-- a Ledger table added later, and this states the same thing where a
-- reviewer reads it. UPDATE and DELETE are refused at the privilege as
-- well as at the trigger, because "append-only" resting on a trigger alone
-- is one DISABLE TRIGGER away from being untrue.
GRANT SELECT, INSERT ON ledger.entity_unmerges TO dito_aperture;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger.entity_unmerges FROM dito_aperture;

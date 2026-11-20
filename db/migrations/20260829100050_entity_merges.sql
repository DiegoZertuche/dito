-- Two records of one customer become one (ticket #55; spec #48 grilling
-- decision 11; ADR-0035, ADR-0036, ADR-0003 as amended, ADR-0004).
--
-- THIS FILE NAMES NO CONVERSATION, and that is enforced
-- (binding-wall.test.ts). Merge is Ledger-side: the matcher compares
-- identifiers already filed against entities and never reads a binding or a
-- WhatsApp address, so nothing conversation-shaped belongs in this schema.
--
-- MERGE IS A REDIRECT, AND THE EDGE IS THE POINTER. The losing entity keeps
-- its row; nothing on `ledger.entities` is rewritten, and no column there
-- gains a winner. That is deliberate twice over: an UPDATE on
-- `ledger.entities` is the privilege migration …100012 withholds by name ("a
-- blanket UPDATE is a rename without a disclosure waiting to happen"), and a
-- mutable pointer is precisely the thing that can be re-pointed — which is
-- the flattening this ADR forbids. An append-only edge cannot be re-pointed
-- at all.
--
-- THE EDGE IS NEVER REWRITTEN. `A→B→C` is stored as two rows and stays two
-- rows; the transitive answer is DERIVED by `ledger.resolve_entity` below.
-- MediaWiki shipped the flattening, found it "cannot function properly", and
-- removed it in 1.39 — and in an append-only store it is worse than a
-- performance bug, because it writes down a merge nobody performed.
--
-- WHAT MAKES IT SAFE TO ASK NOBODY (ADR-0036) is not a human confirming but
-- the merge being undoable by construction: the immutable edge, the recorded
-- effect set, and facts that never move. Those three are load-bearing, not
-- bookkeeping — remove any one and the automatic merge stops being
-- defensible.
CREATE TABLE ledger.entity_merges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    -- The record that stops being the anchor. It keeps its row, its facts
    -- and its grants; only new reads follow the pointer.
    loser_entity_id uuid NOT NULL,
    winner_entity_id uuid NOT NULL,
    -- merged           — a genuine same-customer. The loser's facts read
    --                    forward under the winner: it is one customer's
    --                    history, recorded twice.
    -- created_in_error — a record that should never have existed. The id
    --                    still resolves, so no reference dangles, but its
    --                    facts do NOT read forward.
    -- They mean opposite things for exactly that question (ADR-0035), which
    -- is why the status is on the edge rather than implied by it.
    status text NOT NULL,
    -- The human-or-machine stamp. This is what makes any claim about
    -- automation provable in the data rather than asserted in a document.
    -- Nothing this slice writes is 'human': there is no human merge verb,
    -- and the value exists so that the day one arrives it is stamped
    -- differently rather than indistinguishably.
    performed_by text NOT NULL,
    -- Which rung of ADR-0035's ladder fired. Null only for a human merge,
    -- which is decided by judgement rather than by a key — and the CHECK
    -- below makes a machine merge that names no rung unrepresentable, so
    -- "the ladder is what fires automatically" is a property of the store.
    matched_on text,
    -- THE EFFECT SET AT MERGE TIME, unreconstructable afterwards (FHIR and
    -- Reltio both record one). Which facts each side carried and which
    -- twins could read them is TRUE ONLY AT THIS INSTANT: facts keep being
    -- filed against the loser afterwards, and grants are added and revoked.
    -- Without this, "what did this merge actually affect?" has no answer a
    -- year later, and an undo has nothing to restore to.
    effect_set jsonb NOT NULL,
    merged_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entity_merges_status_check
        CHECK (status IN ('merged', 'created_in_error')),
    CONSTRAINT ledger_entity_merges_performed_by_check
        CHECK (performed_by IN ('human', 'machine')),
    CONSTRAINT ledger_entity_merges_matched_on_check
        CHECK (matched_on IS NULL OR matched_on IN ('rfc', 'email', 'phone')),
    CONSTRAINT ledger_entity_merges_machine_names_its_rung
        CHECK (performed_by <> 'machine' OR matched_on IS NOT NULL),
    -- A record cannot be its own duplicate. The trigger below refuses this
    -- too, as the degenerate one-step cycle; the constraint states it where
    -- a reader of the schema will see it.
    CONSTRAINT ledger_entity_merges_not_self
        CHECK (loser_entity_id <> winner_entity_id),
    -- Both ends are real entities OF THIS COMPANY. The composite foreign
    -- key is what makes a cross-company merge unrepresentable rather than
    -- audited: the company is half the entity's primary key precisely
    -- because the id itself is client-minted (ADR-0035).
    CONSTRAINT ledger_entity_merges_loser_fkey
        FOREIGN KEY (company_id, loser_entity_id)
        REFERENCES ledger.entities (company_id, entity_id),
    CONSTRAINT ledger_entity_merges_winner_fkey
        FOREIGN KEY (company_id, winner_entity_id)
        REFERENCES ledger.entities (company_id, entity_id)
);

-- ONE OUT-EDGE PER LOSER, which is what makes resolution a WALK rather than
-- a search: every entity points at one successor or at none, so the graph
-- is functional and `resolve_entity` terminates on a chain rather than
-- exploring a tree. It is also the constraint that stops a second, later
-- merge silently overwriting the first one's answer.
CREATE UNIQUE INDEX ledger_entity_merges_one_per_loser
    ON ledger.entity_merges (company_id, loser_entity_id);

-- The other direction: everything that resolved INTO one winner. The
-- resolved-timeline read walks this way.
CREATE INDEX ledger_entity_merges_winner
    ON ledger.entity_merges (company_id, winner_entity_id);

-- THE DERIVED PROJECTION (ADR-0035). Transitive resolution is COMPUTED from
-- the edges, every time, and stored nowhere — so there is no cache to go
-- stale, no rebuild step to forget, and above all no row that claims a
-- merge nobody performed.
--
-- `CYCLE` is Postgres's own loop guard: recursion stops the moment an id
-- repeats, and the repeated row is marked rather than returned. A cycle
-- cannot get in (the trigger below refuses one), and this function still
-- terminates if one ever did — a resolution walk that hangs is a worse
-- failure than a wrong answer.
--
-- Status is deliberately NOT consulted here. `created_in_error` still
-- RESOLVES — "the loser's id stays resolvable forever" is about references
-- never dangling — and what its status changes is whether its facts read
-- forward, which is the timeline's question and not this one's.
CREATE FUNCTION ledger.resolve_entity(p_company_id uuid, p_entity_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    WITH RECURSIVE walk (entity_id, depth) AS (
        SELECT p_entity_id, 0
      UNION ALL
        SELECT m.winner_entity_id, w.depth + 1
          FROM ledger.entity_merges m
          JOIN walk w ON w.entity_id = m.loser_entity_id
         WHERE m.company_id = p_company_id
    ) CYCLE entity_id SET is_cycle USING path
    SELECT entity_id
      FROM walk
     WHERE NOT is_cycle
     ORDER BY depth DESC
     LIMIT 1;
$$;

COMMENT ON FUNCTION ledger.resolve_entity(uuid, uuid) IS
    'ADR-0035: transitive resolution is a derived, rebuildable projection. A→B→C is stored as two edges and never flattened to A→C.';

-- A CYCLE CHECK IS MANDATORY (ADR-0035), and it lives in the store rather
-- than in the writer, so that no path — a future human merge verb, a repair
-- script, a hand-run INSERT — can produce a graph whose resolution does not
-- terminate. Refused loudly: a cycle is a broken store, not a candidate
-- quality problem, and it is never something to file and sort out later.
CREATE FUNCTION ledger.entity_merges_refuse_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    closes boolean;
BEGIN
    -- ONE INSERTION AT A TIME PER COMPANY, taken BEFORE the reachability
    -- read (Codex r1). A reachability check under READ COMMITTED cannot see
    -- an edge another transaction has written and not yet committed, so two
    -- transactions inserting A→B and B→A each look and each find nothing —
    -- and the unique index does not conflict, because their LOSERS differ.
    -- Both commit, and the graph has a ring the mandatory check was supposed
    -- to make unrepresentable.
    --
    -- The lock lives HERE rather than in the writer so that it holds for
    -- every path into this table: a repair script, a future human merge
    -- verb, a hand-run INSERT. The matcher takes the same key before it
    -- reads, and advisory transaction locks are re-entrant, so that costs
    -- nothing and the two compose.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('dito:merge:company:' || NEW.company_id::text, 0));

    -- Is the new loser already reachable FROM the winner? If so this edge
    -- closes the ring. The degenerate case (winner = loser) is caught by
    -- the seed row of the same walk.
    WITH RECURSIVE walk (entity_id) AS (
        SELECT NEW.winner_entity_id
      UNION ALL
        SELECT m.winner_entity_id
          FROM ledger.entity_merges m
          JOIN walk w ON w.entity_id = m.loser_entity_id
         WHERE m.company_id = NEW.company_id
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

CREATE TRIGGER ledger_entity_merges_no_cycle
    BEFORE INSERT ON ledger.entity_merges
    FOR EACH ROW EXECUTE FUNCTION ledger.entity_merges_refuse_cycle();

-- THE EDGE IS IMMUTABLE. Same construction as taps, drafts and
-- send_commands: refused in the store, not promised in code. An edge that
-- could be re-pointed is a flattening waiting to happen, and one that could
-- be deleted takes the effect set — the only record of what the merge
-- affected — with it. Reversal, when it is built, is another append: an
-- edge is undone by recording that it was undone, never by erasing it.
CREATE FUNCTION ledger.entity_merges_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION
        'entity merges are immutable (ADR-0035): % refused — the edge records the merge that actually happened and is never rewritten',
        TG_OP;
END;
$$;

CREATE TRIGGER ledger_entity_merges_no_update_delete
    BEFORE UPDATE OR DELETE ON ledger.entity_merges
    FOR EACH ROW EXECUTE FUNCTION ledger.entity_merges_immutable();

CREATE TRIGGER ledger_entity_merges_no_truncate
    BEFORE TRUNCATE ON ledger.entity_merges
    FOR EACH STATEMENT EXECUTE FUNCTION ledger.entity_merges_immutable();

-- Grants, on purpose. …100012's ALTER DEFAULT PRIVILEGES already reaches a
-- Ledger table added later, and this states the same thing where a reviewer
-- reads it: the aperture writes, the twin runtime holds nothing at all.
-- UPDATE and DELETE are refused at the privilege as well as at the trigger,
-- because "append-only" that rests on a trigger alone is one DISABLE
-- TRIGGER away from being untrue.
GRANT SELECT, INSERT ON ledger.entity_merges TO dito_aperture;
REVOKE UPDATE, DELETE, TRUNCATE ON ledger.entity_merges FROM dito_aperture;

-- The resolution function's EXECUTE is left at Postgres's default (PUBLIC),
-- deliberately and not by omission: it is neither SECURITY DEFINER nor
-- privileged, so it reads `ledger.entity_merges` with the CALLER's rights —
-- and a caller with no SELECT there gets a permission error from inside it
-- exactly as it would from outside. Narrowing EXECUTE would add a second
-- gate over the same table and a second thing to keep in step.

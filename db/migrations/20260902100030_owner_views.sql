-- The filing seat crosses (ticket #127; spec #126 decisions 1, 13 and 14;
-- ADR-0004 as amended 2026-09-02, ADR-0016, ADR-0002).
--
-- NUMBERING: the …202609021000·0 range, reserved for this ticket.
--
-- ADR-0004's amendment is one sentence and this migration is that sentence
-- in SQL: "Owner-visible provenance is now timestamp + confidence + source
-- type + the seat the fact was filed under — rendered as the rep's display
-- name through the owner's seats view. The seat, not the twin: twins are
-- erased at retirement, seats persist as retired, and attribution must
-- outlive the key." …100010's view comment said `filed_by_twin_id` was
-- "deliberately absent — owner-visible provenance is timestamp, confidence
-- and source type only", and the slice-3 view had read *never chat
-- identity* as *never rep identity*, which left the owner twin unable to
-- answer the PRD's own example («¿cuántas cotizaciones dio Mauricio esta
-- semana?»). The twin is still absent. The SEAT is what arrives.
--
-- THREE THINGS CHANGE ABOUT THE VIEWS, and one thing deliberately does not.
--
--  1. `finalized_facts` gains `filed_by_seat_id`, derived by joining the
--     fact's `filed_by_twin_id` to the seats registry INSIDE the view. The
--     twin id is the join key and never a column: it enters the definition
--     and does not come out, which is exactly the shape ADR-0004 asks for.
--  2. Both views become `security_barrier`. A barrier view evaluates its
--     own qualifiers before any user-supplied function in the caller's
--     WHERE clause. Without it, `dito_owner` — which OWNS the `owner`
--     schema and may create functions in it — could pass a leaky operator
--     that observes rows the `shadow = false` qualifier was about to
--     discard. The shadow filter is the product's launch gate; it may not
--     be routed around by a caller's own function.
--  3. Both views change OWNER, to `dito_ledger_views`. The argument is in
--     …100020: PostgreSQL cannot give the owner role an invoker-rights view
--     without also giving it SELECT on `ledger.facts` and `public.seats`,
--     which hands it shadow rows and the twin id in the same breath. A
--     definer view owned by a role that RLS BINDS gets the effect the
--     ticket asked for — the policy applies through the view — with none of
--     the privilege.
--
-- WHAT DOES NOT CHANGE: `finalized_entities` keeps its five columns and its
-- shadow filter; `finalized_facts` keeps its eleven, in order, with the new
-- one appended; and neither view gains a company predicate. Tenancy is
-- …100040's job and belongs in a policy, so that a view stays a projection
-- and the answer to "can this connection see company B" is one mechanism in
-- one place.

-- What the views read, granted to the role they now run as. SELECT and
-- nothing else, ever: this role exists to project, and a projection that
-- can write is a second Ledger writer (ADR-0003). The grant audit sweeps
-- every write grantee on `ledger`, so an INSERT added here later goes red.
GRANT SELECT ON ledger.entities TO dito_ledger_views;
GRANT SELECT ON ledger.facts TO dito_ledger_views;
GRANT SELECT ON seats TO dito_ledger_views;

-- `CREATE OR REPLACE`, not DROP and re-create, and that is on purpose: a
-- replace keeps every grant the view already carries (…100012's SELECT to
-- `dito_twin_runtime`), so no grant has to be re-issued and none can be
-- forgotten. It also constrains what this migration can do — a replace may
-- only APPEND columns — which is why `filed_by_seat_id` is last.
CREATE OR REPLACE VIEW ledger.finalized_entities WITH (security_barrier = true) AS
SELECT company_id,
       entity_id,
       kind,
       display_name,
       created_at
  FROM ledger.entities
 WHERE shadow = false;

-- LEFT JOIN, DELIBERATELY, and this is the decision a reader should not
-- have to reconstruct. Every fact filed before this migration was filed by
-- a twin with no `seats` row — the registry did not exist — and an INNER
-- JOIN would make every one of those facts vanish from the owner's view
-- while the audit stayed green and the row count stayed unexplained. A
-- fact's existence is not conditional on its filer being registered: an
-- unregistered twin yields a NULL seat, and the owner reads a fact whose
-- attribution is *not recorded* rather than a Ledger with a hole in it,
-- which is also ADR-0034's rule for an absent field.
--
-- The join carries `company_id` as well as `twin_id`. `seats_one_seat_per_twin`
-- already makes the twin unique, so the company is not what makes the join
-- single-valued — it is what makes the two RLS policies agree: the fact's
-- row and its seat's row are filtered by the same company on the same
-- connection, so a cross-company pairing is not merely unwritten but
-- unrepresentable.
CREATE OR REPLACE VIEW ledger.finalized_facts WITH (security_barrier = true) AS
SELECT f.id,
       f.company_id,
       f.entity_id,
       f.fact_type,
       f.payload_version,
       f.payload,
       f.occurred_at,
       f.confidence,
       f.source_type,
       f.filed_at,
       f.finalized_at,
       s.id AS filed_by_seat_id
  FROM ledger.facts f
  LEFT JOIN seats s
    ON s.company_id = f.company_id
   AND s.twin_id = f.filed_by_twin_id
 WHERE f.shadow = false
   AND f.finalized_at IS NOT NULL
   AND f.retracted_at IS NULL;

-- THE SEATS VIEW ADR-0002 NAMED. "The owner DB user is granted named views
-- with pinned column lists only: finalized-fact Ledger views …, a seats
-- status view, …" — this is that view, and its column list is the pinned
-- one: seat id, display name, state. No company (the policy scopes the
-- read, and a column the owner cannot vary is not information), no twin id,
-- no number, no JID. ADR-0004's amendment ends "no owner-granted object can
-- join a fact to any of them", and this object is where that sentence is
-- either true or false: `filed_by_seat_id` joins to `seat_id` here and
-- stops, because there is nothing else here to reach.
--
-- IT LIVES IN `public`, BESIDE ITS TABLE, not in `ledger`. A `ledger` view
-- owes two things the grant audit enforces — it must filter `shadow` and it
-- must be selectable by the twin runtime — and a seats view has no `shadow`
-- column to filter and no twin-side reader to serve. …100120 placed
-- `active_entity_merges` outside the view namespace for exactly this
-- reason.
CREATE VIEW seats_status WITH (security_barrier = true) AS
SELECT s.id AS seat_id,
       s.rep_display_name AS display_name,
       s.state
  FROM seats s;

-- OWNERSHIP, and the two-step that makes it possible. `ALTER … OWNER TO`
-- requires the new owner to hold CREATE on the containing schema, which
-- `dito_ledger_views` must not keep — …100012's rule is that no application
-- role may create objects, because schema changes are Atlas's (ADR-0029).
-- So the privilege is granted, spent, and taken back inside this migration.
GRANT CREATE ON SCHEMA ledger TO dito_ledger_views;
GRANT CREATE ON SCHEMA public TO dito_ledger_views;
ALTER VIEW ledger.finalized_entities OWNER TO dito_ledger_views;
ALTER VIEW ledger.finalized_facts OWNER TO dito_ledger_views;
ALTER VIEW seats_status OWNER TO dito_ledger_views;
REVOKE CREATE ON SCHEMA ledger FROM dito_ledger_views;
REVOKE CREATE ON SCHEMA public FROM dito_ledger_views;

-- THE APERTURE HOLDS NOTHING ON THESE VIEWS, and until now it did:
-- …100012's `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ledger` landed on
-- views as well as tables, and its `ALTER DEFAULT PRIVILEGES` keeps doing
-- so for new ones. The aperture is the Ledger's WRITER and reads the tables
-- directly; a writer holding INSERT on a simple auto-updatable view is a
-- second door into the same table, and a grantee on an owner-visible view
-- is one more principal FR-71a has to account for. Revoked so the owner
-- views have exactly three grantees: the role they run as, the owner, and
-- the twin-side reader …100012 named.
REVOKE ALL ON ledger.finalized_entities FROM dito_aperture;
REVOKE ALL ON ledger.finalized_facts FROM dito_aperture;


-- THE OWNER IS GRANTED NOTHING HERE, AND THAT IS THE POINT. Atlas applies
-- one transaction per migration FILE, so a rollout that stopped between
-- this file and the next would leave three views the owner may select and
-- no row-level security under them — every company's finalized rows, to a
-- role that is cluster-global and may already carry a password from another
-- database. The grants therefore live in …100040, after the policies commit
-- in the same transaction as themselves. A partial deployment can leave the
-- owner unable to read; it cannot leave it able to read everything.

COMMENT ON VIEW ledger.finalized_entities IS
    'ADR-0016: the shadow filter lives in the view definition. Readers select here, never from ledger.entities. Runs as dito_ledger_views, so the company policy (…100040) applies through it.';
COMMENT ON VIEW ledger.finalized_facts IS
    'ADR-0016: the shadow filter lives in the view definition. Readers select here, never from ledger.facts. Owner-visible provenance is timestamp, confidence, source type and the SEAT the fact was filed under (ADR-0004 as amended 2026-09-02); filed_by_twin_id is the join key and is deliberately still absent as a column.';
COMMENT ON VIEW seats_status IS
    'ADR-0002''s seats status view, ADR-0004''s rendering of the filing seat: seat id, display name, state. Nothing here names a number, a JID or a twin.';
COMMENT ON COLUMN ledger.finalized_facts.filed_by_seat_id IS
    'The seat this fact was filed under, joined from ledger.facts.filed_by_twin_id. NULL when the filing twin has no seat row — the fact is real either way (ADR-0034: an absent field is not recorded, never a default).';

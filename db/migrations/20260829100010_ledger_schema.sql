-- The Ledger is born (ticket #50; spec #48 grilling decisions 2, 10;
-- ADR-0004, ADR-0016, ADR-0034, ADR-0035).
--
-- The company-owned, append-only, bi-temporal store of entity-scoped
-- business facts lives in its own `ledger` schema alongside `public`,
-- Atlas-managed. The Ledger is WALL-RELEVANT, so ADR-0029's
-- library-owned-store exemption does not apply: every object here is a
-- migration artifact, visible in review before it is live — which is what
-- makes FR-71(a)'s later grant diff run against migration output.
--
-- Nothing in this schema is rep-side. Chat↔entity bindings never appear
-- here (ADR-0004: they live only in the bundle's entity mirror), and no
-- column carries chat identity: owner-visible provenance is timestamp,
-- confidence and source type only.
CREATE SCHEMA ledger;

-- ENTITIES (ADR-0035). One entity type; `kind` drives display and merge
-- safety and NOTHING else — the moment it branches the fact model, the
-- grant model or retrieval, we have rebuilt the Contact/Account split the
-- glossary rejected.
--
-- The id is CLIENT-MINTED: a UUID created rep-side when the rep confirms a
-- binding, carried into the Ledger unchanged, so the bundle's entity
-- mirror stays a mirror rather than a translation table and a retried
-- confirmation is idempotent. Client-supplied ids are client-supplied
-- data, so the COMPANY SCOPE is applied server-side by the aperture and
-- never accepted from the device — it is the primary key's other half,
-- and it is read off the rep-act evidence row, never off a parameter.
--
-- `created_at` is stored because random UUIDs carry no ordering and
-- survivorship (which row wins a merge) is decided by a written rule
-- rather than by whichever row a query returns first.
CREATE TABLE ledger.entities (
    company_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    -- Valid time: when the rep confirmed the binding that minted this id.
    created_at timestamptz NOT NULL,
    -- Transaction time: when the aperture filed it. Bi-temporal, both halves.
    filed_at timestamptz NOT NULL DEFAULT now(),
    -- Shadow mode (ADR-0016): a row flag whose filter lives inside the
    -- finalized-view definitions below. Every row this slice files is
    -- shadow; nothing flips it. The launch gate is a WHERE clause.
    shadow boolean NOT NULL DEFAULT true,
    PRIMARY KEY (company_id, entity_id),
    CONSTRAINT ledger_entities_kind_check CHECK (kind IN ('person', 'business')),
    CONSTRAINT ledger_entities_display_name_check CHECK (btrim(display_name) <> '')
);

-- GRANTS (CONTEXT.md, schema session). Permission for a rep twin to read
-- an entity's timeline, in two sources with different authority: a
-- CREATION grant arises automatically when the rep binds a chat to a new
-- entity (self-scoped — it returns only what that rep's own conversation
-- filed), and every other grant is OWNER-ASSIGNED, which is what lets one
-- rep read what another filed. Grants attach to the entity a fact was
-- filed against, never the resolved one (ADR-0035) — which is what stops a
-- merge from being privilege escalation.
--
-- All grants die with the twin (ADR-0004/0009): retirement destroys the
-- twin key and deletes these rows; the entities and facts survive.
CREATE TABLE ledger.entity_grants (
    company_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    source text NOT NULL,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, entity_id, twin_id),
    CONSTRAINT ledger_entity_grants_source_check
        CHECK (source IN ('creation', 'owner_assigned')),
    CONSTRAINT ledger_entity_grants_entity_fkey
        FOREIGN KEY (company_id, entity_id)
        REFERENCES ledger.entities (company_id, entity_id)
);

-- One entity has exactly one creator: the rep whose binding minted the id.
CREATE UNIQUE INDEX ledger_entity_grants_one_creator
    ON ledger.entity_grants (company_id, entity_id)
    WHERE source = 'creation';

-- FACTS (ADR-0034, FR-32, FR-35). Entity-scoped, provenance-carrying,
-- provisional for 24 hours then final; corrections annotate, never erase.
--
-- `payload_version` is on every row, so `(fact_type, payload_version)`
-- identifies the payload shape — per-type evolution, additive-only. A new
-- reader treats an absent field as NOT RECORDED THEN, never as a default:
-- a missing currency on a 2026 quote is unknown, not USD. The seam's
-- refuse-on-mismatch rule deliberately does NOT apply here — a fact must
-- stay readable for as long as it is kept.
--
-- Every fact attaches to exactly one entity; there is no non-entity slot
-- (FR-32, absolute — ADR-0035). The composite FK is what makes an
-- out-of-company attachment unrepresentable.
--
-- No writer files facts in this ticket: extraction is its own. The table,
-- its view and its FR-72 obligation are born together so no reader is ever
-- tempted at the table, which is the rebuild ADR-0016 exists to prevent.
--
-- FOUR fact types, not CONTEXT.md's five: `CustomerPattern` is DEFERRED by
-- spec #48 grilling decision 5. FR-30 defines it narrowly and warns by name
-- against "rep tactics, judgments, or selling approach", ADR-0035 names an
-- entity-less observation slot as the natural drain for exactly the
-- rep-level inference ADR-0033 exists to prevent, and its false positives
-- are aperture BREACHES rather than noise — with no labelled corpus yet to
-- tell those apart. It joins once one exists, and adding it is a code
-- change plus a CHECK, storing nothing new.
CREATE TABLE ledger.facts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    fact_type text NOT NULL,
    payload_version integer NOT NULL,
    payload jsonb NOT NULL,
    -- Provenance, and nothing beyond it (ADR-0004): valid time, confidence,
    -- source type. Never chat identity.
    occurred_at timestamptz NOT NULL,
    confidence numeric(4, 3),
    source_type text NOT NULL,
    -- Transaction time.
    filed_at timestamptz NOT NULL DEFAULT now(),
    -- Rep-side attribution, deliberately kept OUT of the finalized view:
    -- it exists so a creation grant can be honoured and a retirement can
    -- find its grants, not so an owner can read who said what.
    filed_by_twin_id uuid NOT NULL,
    shadow boolean NOT NULL DEFAULT true,
    -- The correction window (ADR-0004): a fact finalizes 24h after its
    -- disclosure line was rep-reachable, not after filing. Null until then.
    finalized_at timestamptz,
    -- Corrections annotate, never erase (FR-33): a retracted fact keeps its
    -- row, and never finalizes.
    retracted_at timestamptz,
    CONSTRAINT ledger_facts_fact_type_check
        CHECK (fact_type IN ('QuoteGiven', 'OrderTaken', 'DatePromised', 'ContactEstablished')),
    CONSTRAINT ledger_facts_payload_version_check CHECK (payload_version >= 1),
    CONSTRAINT ledger_facts_confidence_check
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT ledger_facts_source_type_check
        CHECK (source_type IN ('extraction', 'rep_act')),
    -- A retracted fact never finalizes (FR-33).
    CONSTRAINT ledger_facts_retracted_never_finalizes
        CHECK (retracted_at IS NULL OR finalized_at IS NULL),
    CONSTRAINT ledger_facts_entity_fkey
        FOREIGN KEY (company_id, entity_id)
        REFERENCES ledger.entities (company_id, entity_id),
    -- Not redundant: it is the target a rep-side disclosure line points at,
    -- so a line can never name a fact from a different company than its own
    -- scope. Company-crossed disclosure is unrepresentable, not audited.
    CONSTRAINT ledger_facts_company_scoped_key UNIQUE (company_id, id)
);

CREATE INDEX ledger_facts_timeline
    ON ledger.facts (company_id, entity_id, occurred_at);

-- THE FINALIZED VIEWS (ADR-0016). The shadow filter lives INSIDE these
-- definitions, and readers select from them — never from the tables. That
-- is what makes flipping the launch gate a WHERE clause instead of a
-- pipeline rebuild, and it is why they are built now, in the same
-- migration as the tables they guard: tables without views invite a
-- direct-table reader that slice 4 would then have to undo.
--
-- `dito_owner` is deliberately NOT created here. It arrives in slice 4
-- with the surface that authenticates as it; a role with no client would
-- leave a half-green audit.
CREATE VIEW ledger.finalized_entities AS
SELECT company_id,
       entity_id,
       kind,
       display_name,
       created_at
  FROM ledger.entities
 WHERE shadow = false;

CREATE VIEW ledger.finalized_facts AS
SELECT id,
       company_id,
       entity_id,
       fact_type,
       payload_version,
       payload,
       occurred_at,
       confidence,
       source_type,
       filed_at,
       finalized_at
  FROM ledger.facts
 WHERE shadow = false
   AND finalized_at IS NOT NULL
   AND retracted_at IS NULL;

COMMENT ON VIEW ledger.finalized_entities IS
    'ADR-0016: the shadow filter lives in the view definition. Readers select here, never from ledger.entities.';
COMMENT ON VIEW ledger.finalized_facts IS
    'ADR-0016: the shadow filter lives in the view definition. Readers select here, never from ledger.facts. filed_by_twin_id is deliberately absent — owner-visible provenance is timestamp, confidence and source type only (ADR-0004).';

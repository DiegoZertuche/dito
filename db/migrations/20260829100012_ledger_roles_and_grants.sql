-- Grants, not convention (ticket #50; spec #48 grilling decision 2;
-- ADR-0003, ADR-0016).
--
-- "Exactly one component holds Ledger write credentials" is a claim about
-- database privileges, not about where the code happens to live. Two roles
-- exist after this migration:
--
--   dito_aperture      — the single Ledger writer. Write on ledger.*, and
--                        write on the aperture's own two rep-side stores.
--   dito_twin_runtime  — everything else twin-side. NO Ledger write at
--                        all, and no privilege on a Ledger TABLE: its only
--                        reach into `ledger` is SELECT on the finalized
--                        views, which is where the shadow filter lives
--                        (ADR-0016).
--
-- `dito_owner` is deliberately NOT created. It arrives in slice 4 with the
-- surface that authenticates as it; creating it now would leave a role
-- with no client and a half-green audit.
--
-- Roles are cluster-global while grants are per-database, so creation is
-- written idempotently: the same cluster hosts several development
-- databases, and a role that already exists is not an error to re-run
-- into.
DO $$
BEGIN
    CREATE ROLE dito_aperture NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;

DO $$
BEGIN
    CREATE ROLE dito_twin_runtime NOLOGIN;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;

-- THE APERTURE: the sole Ledger writer.
--
-- INSERT and SELECT, and nothing else. No DELETE and no TRUNCATE, because
-- the Ledger is append-only and expungement (ADR-0026) is a different
-- mechanism arriving with its own migration and its own grant — and no
-- table-wide UPDATE either, because nothing in this slice updates a Ledger
-- row and a blanket UPDATE is a rename without a disclosure waiting to
-- happen (ADR-0003's amendment: a rename puts a name from the rep's
-- conversation into the Ledger and IS disclosed). Finalization and
-- retraction annotate rows in place, and they arrive with COLUMN-LEVEL
-- UPDATE grants on exactly the columns they annotate — which is a
-- reviewable migration each, rather than a privilege nobody notices.
GRANT USAGE ON SCHEMA ledger TO dito_aperture;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ledger TO dito_aperture;
-- A Ledger table added by a later migration is aperture-writable and
-- twin-runtime-invisible by construction, rather than by whoever remembers.
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger
    GRANT SELECT, INSERT ON TABLES TO dito_aperture;

-- The aperture reads the seam to verify class-2 rep-act evidence (the raw
-- plane-delivered `wa_events` row), and owns its two rep-side stores.
-- Reading everything and writing only its own is the shape: the aperture
-- is not the runtime.
GRANT USAGE ON SCHEMA public TO dito_aperture;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dito_aperture;
-- INSERT only. No UPDATE — a disclosure line is what a rep was told, and
-- the trigger below says the same thing twice. And no DELETE either: a
-- deleted line leaves an undisclosed Ledger subject behind it forever,
-- with FR-72 permanently red and no path back, so nothing gets that
-- privilege before there is a design for it. See the OPEN QUESTION on
-- retirement recorded with FR-73's exception
-- (packages/twin-runtime/src/fr73-shared-stores.ts).
GRANT INSERT ON disclosure_lines TO dito_aperture;
GRANT INSERT, UPDATE, DELETE ON aperture_questions TO dito_aperture;

-- THE TWIN RUNTIME: everything twin-side except the crossing.
--
-- Its reach into `ledger` is exactly one thing — SELECT on the finalized
-- views. A view runs with its owner's privileges, so this reader gets the
-- shadow-filtered rows and NOTHING at the tables underneath: selecting
-- ledger.facts directly is a permission error for this role, which is the
-- enforcement behind "no reader selects from a fact table where a view
-- exists".
--
-- RECORDED LIMITATION: this SELECT is UNSCOPED — it is not filtered by
-- company and it does not consult `entity_grants`. Nothing reads the
-- Ledger from the twin side yet, and ADR-0004 puts that reading behind
-- scoped query tools (entity-resolve → grant-filtered timeline read) which
-- arrive with the surfaces that need them. Tenant- and grant-scoped
-- reading — RLS or security-definer functions deriving identity
-- server-side — is FR-71's and slice 4's, and this grant must narrow when
-- it lands. It is written down here rather than left to be discovered.
GRANT USAGE ON SCHEMA ledger TO dito_twin_runtime;
GRANT SELECT ON ledger.finalized_entities TO dito_twin_runtime;
GRANT SELECT ON ledger.finalized_facts TO dito_twin_runtime;

GRANT USAGE ON SCHEMA public TO dito_twin_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO dito_twin_runtime;
-- ...except the aperture's own stores, which it may read and never write.
-- Deliberately NOT covered by ALTER DEFAULT PRIVILEGES: a rep-side store
-- added later must be granted on purpose, so a future aperture store never
-- becomes runtime-writable by inheritance.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON disclosure_lines
    FROM dito_twin_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON aperture_questions
    FROM dito_twin_runtime;
-- ...and except the seam's INBOUND table, which the connection plane's
-- ingest writes and nothing else ever does. This one is not tidiness: the
-- aperture reads `wa_events` to verify class-2 rep-act evidence and takes
-- the company, seat and twin scope off that row (ADR-0003, ADR-0035). A
-- runtime that could insert or rewrite a row could therefore mint its own
-- evidence and choose its own tenant — which is precisely the
-- model-laundered rep act the single-writer rule exists to prevent.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON wa_events FROM dito_twin_runtime;

-- Neither application role owns anything, and neither may create objects:
-- schema changes are Atlas's, run as the owner (ADR-0029).
REVOKE CREATE ON SCHEMA public FROM dito_aperture, dito_twin_runtime;

-- ...and neither may touch the migration tool's own revision history,
-- which the blanket grant above would otherwise have handed them. Atlas
-- writes its bookkeeping into `public` as it applies, so the table already
-- exists by the time this runs — guarded anyway, because an Atlas that
-- ever keeps it elsewhere must not turn this migration into a failure.
DO $$
BEGIN
    IF to_regclass('public.atlas_schema_revisions') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public.atlas_schema_revisions FROM dito_aperture, dito_twin_runtime';
    END IF;
END;
$$;

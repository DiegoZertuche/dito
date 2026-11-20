-- The correction, recorded (ticket #54; spec #48 grilling decision 14;
-- ADR-0003, ADR-0004, ADR-0020, ADR-0034; FR-33).
--
-- Being wrong stays fixable. A rep who reads the daily disclosure and sees
-- a line that is wrong quotes the post and says «N no»; the fact that line
-- disclosed is annotated RETRACTED. It is never erased — the record shows
-- what happened rather than pretending it did not — and a retracted fact
-- never finalizes (the CHECK on ledger.facts, …100010, already says so).
--
-- EXPUNGEMENT IS A DIFFERENT MECHANISM AND IS NOT THIS (ADR-0026). A
-- correction annotates a fact the aperture was right to accept and wrong
-- about; expungement physically replaces the content of a fact that should
-- never have crossed at all, is sev-1 only, and arrives with the closing
-- window. Nothing here removes anything.
--
-- TWO THINGS ARRIVE. The rep-side evidence store below, and the ONE column
-- privilege the annotation needs — which …100012 promised in exactly these
-- words: "Finalization and retraction annotate rows in place, and they
-- arrive with COLUMN-LEVEL UPDATE grants on exactly the columns they
-- annotate — which is a reviewable migration each, rather than a privilege
-- nobody notices."
--
-- NUMBERING. The …10004x range, because three branches cut from #52 are in
-- flight at once (#53 owns …10003x, #55 owns …10005x). Parallel branches
-- take their numbers from disjoint ranges so the merged set is linear from
-- any subset — the lesson wave 1 of this slice learned the hard way.

-- ---------------------------------------------------------------------
-- 1. THE REP ACT BEHIND THE ANNOTATION
-- ---------------------------------------------------------------------
-- `ledger.facts.retracted_at` says THAT a fact was retracted. It cannot say
-- WHO retracted it, and it must not: the evidence is a `wa_events` row, and
-- the seam composes `external_event_id` as `<chat jid>:<message id>`, so a
-- Ledger column holding that id would hand an owner chat identity one join
-- away (ADR-0004). The evidence therefore lives rep-side, exactly where an
-- entity create's does (`disclosure_lines.source_event_id`, …100011) and a
-- draft dismissal's does (`draft_dismissals.source_event_id`, …100019).
--
-- Without this row the only record of who corrected what is the audit
-- chain, which is content-free with opaque refs by design (ADR-0020) — and
-- "a retraction nobody can trace to a rep" is precisely the shape a
-- model-laundered rep act would take, which is the failure mode ADR-0003
-- exists to prevent.
--
-- It is an APERTURE store: the aperture writes it (in the same transaction
-- as the annotation it evidences), the twin runtime only reads it. It
-- therefore joins `APERTURE_REP_SIDE_STORES` (the grant audit) and FR-73's
-- enumeration, both of which fail on a store that is in one list and not
-- the other.
CREATE TABLE fact_retractions (
    -- Seat scope, like the disclosure line's: aperture infrastructure is
    -- seat-scoped rather than twin-session-scoped (ADR-0003).
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    fact_id uuid NOT NULL,
    -- WHICH LINE THE REP POINTED AT. The correction resolves quoted message
    -- id → disclosure post → line index → disclosure line → fact, in code,
    -- with no model anywhere in the path (ADR-0003 class 2). Storing the
    -- line is storing the middle of that walk: it is what the rep actually
    -- saw and named, and it is what makes the retraction auditable against
    -- the post rather than against a fact id nobody typed.
    disclosure_line_id uuid NOT NULL,
    -- The rep's own «N no», raw and plane-delivered — the class-2 evidence
    -- the aperture re-verified for itself rather than taking the caller's
    -- word for it.
    source_event_id bigint NOT NULL REFERENCES wa_events (id),
    -- Valid time: WHEN THE REP SAID IT, off the verified act, never this
    -- pass's wall clock. Mirrors `ledger.facts.retracted_at`, which the
    -- aperture sets from the same value in the same transaction.
    retracted_at timestamptz NOT NULL,
    -- Transaction time.
    filed_at timestamptz NOT NULL DEFAULT now(),
    -- One retraction per fact. A repeat «N no» finds the first one standing
    -- and writes nothing: a correction is terminal, like a draft dismissal.
    PRIMARY KEY (company_id, fact_id),
    CONSTRAINT fact_retractions_fact_fkey
        FOREIGN KEY (company_id, fact_id)
        REFERENCES ledger.facts (company_id, id),
    -- Twin-scoped, so a retraction cannot name one twin's fact through
    -- another twin's disclosure line. Composite, for the same reason
    -- …100025's mappings are: the scoped key exists precisely so this is
    -- unrepresentable rather than merely unwritten.
    CONSTRAINT fact_retractions_line_fkey
        FOREIGN KEY (twin_id, disclosure_line_id)
        REFERENCES disclosure_lines (twin_id, id)
);

-- ONE REP ACT AUTHORIZES ONE RETRACTION — the same rule
-- `disclosure_lines_one_create_per_rep_act` states for the create. A single
-- «1 no» is the rep saying one numbered line is wrong; it must not be
-- reusable as the evidence for a second, unrelated retraction (ADR-0003
-- class 2: the act is bound to the thing it authorized, not merely to a
-- message that exists).
CREATE UNIQUE INDEX fact_retractions_one_per_rep_act
    ON fact_retractions (source_event_id);

CREATE INDEX fact_retractions_by_twin ON fact_retractions (twin_id, retracted_at);

-- A retraction is the record of something a rep did. It is never rewritten
-- and never removed — same construction as `disclosure_lines`, `notices`
-- and `draft_dismissals`: refused in the store, not promised in a comment.
CREATE FUNCTION fact_retractions_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'fact retractions are immutable (ADR-0034): % refused — a correction is a record of what the rep did, and undoing one is a different act with no verb', TG_OP;
END;
$$;

CREATE TRIGGER fact_retractions_no_update_delete
    BEFORE UPDATE OR DELETE ON fact_retractions
    FOR EACH ROW EXECUTE FUNCTION fact_retractions_immutable();
CREATE TRIGGER fact_retractions_no_truncate
    BEFORE TRUNCATE ON fact_retractions
    FOR EACH STATEMENT EXECUTE FUNCTION fact_retractions_immutable();

-- Granted on purpose, never by inheritance (…100012's own rule: ALTER
-- DEFAULT PRIVILEGES deliberately does not cover `public`, so a rep-side
-- store added later must be granted deliberately). The aperture writes it;
-- the runtime reads it and nothing more. No UPDATE and no DELETE for
-- anyone: the triggers above refuse them, and the grants say the same thing
-- a second way.
GRANT SELECT, INSERT ON fact_retractions TO dito_aperture;
GRANT SELECT ON fact_retractions TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON fact_retractions
    FROM dito_aperture, dito_twin_runtime;

-- THE APERTURE MAY APPEND TO THE AUDIT CHAIN, which until now it could
-- not. …100012 gave it SELECT on every `public` table and INSERT on its own
-- two stores, and that was enough while nothing it did was audit-chained.
-- Rep acts and refusals ARE audit-chained (ADR-0020, spec #48 decision 18),
-- and the aperture is the component that performs them — the entity create
-- as much as the retraction — so without this the first act filed by a
-- process authenticating as `dito_aperture` would fail on a privilege, not
-- on anything about the act.
--
-- INSERT only. The chain is append-only in the store as well (…100006's
-- trigger), and this grant says the same thing a second way.
GRANT INSERT ON audit_chain TO dito_aperture;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_chain FROM dito_aperture;

-- ---------------------------------------------------------------------
-- 2. THE ONE COLUMN THE ANNOTATION MAY WRITE
-- ---------------------------------------------------------------------
-- Column-level, and only this column. …100012 refused table-wide UPDATE
-- because "a blanket UPDATE is a rename without a disclosure waiting to
-- happen" (ADR-0003's amendment: a rename puts a name from the rep's
-- conversation into the Ledger and IS disclosed) and because it would let
-- provenance be rewritten in an append-only store. Neither is loosened
-- here: after this migration the aperture may set exactly `retracted_at`,
-- and `has_table_privilege(…, 'UPDATE')` — which the grant audit probes —
-- still answers false, because column privileges are not table privileges.
GRANT UPDATE (retracted_at) ON ledger.facts TO dito_aperture;

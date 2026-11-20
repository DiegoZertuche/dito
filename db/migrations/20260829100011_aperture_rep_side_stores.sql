-- The aperture's two rep-side stores, and FR-72 made unrepresentable
-- (ticket #50; spec #48 grilling decisions 8 and 9; ADR-0003 as amended,
-- ADR-0034).
--
-- ADR-0003 splits the aperture's own storage by whether the content has
-- crossed:
--
--   QUESTIONS are uncrossed rep content, so they live as twin-DEK
--   ciphertext and are decrypted only at delivery.
--
--   DISCLOSURE LINES are already-crossed content, so they live PLAINTEXT
--   in this seat-scoped rep-side store — delivery of the daily disclosure
--   must never depend on lease availability. That makes them a rep-side
--   store which is not bundle-resident, which is exactly the shape FR-73
--   exists to catch, so they enter FR-73's enumeration as a DELIBERATE,
--   RECORDED exception carrying this justification — never as a silent
--   skip (see packages/twin-runtime/src/fr73.ts).
--
-- Both stores are rep-side and live in `public` alongside the seam, not in
-- `ledger`: nothing here is company-owned, and no owner surface will ever
-- hold a grant on them.

-- The disclosure line a filed item gets, 1:1 (CONTEXT.md). Stored as
-- RENDERED TEXT carrying no version (ADR-0034): a disclosure line is what
-- a rep was told had crossed, and re-rendering it later from a changed
-- template would retroactively rewrite that statement, which defeats the
-- purpose of disclosing. Rendering itself happens at the twin's one
-- grammar point; the aperture stores what it is handed.
--
-- The subject is one of the two things that can cross: a FACT, or an
-- ENTITY CREATE. ADR-0003's 2026-08-29 amendment narrows "every entity
-- mutation is disclosed" to the principle that a mutation is disclosed
-- when it carries rep-derived content across the wall — create (and later
-- rename) puts a name taken from the rep's conversation into the Ledger
-- for the first time; a merge restructures what already crossed and is
-- not disclosed.
CREATE TABLE disclosure_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Seat scope. Aperture infrastructure is seat-scoped, not
    -- twin-session-scoped (ADR-0003): it outlives sessions and serves the
    -- closing window.
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    subject_kind text NOT NULL,
    fact_id uuid,
    entity_id uuid,
    rendered_text text NOT NULL,
    filed_at timestamptz NOT NULL DEFAULT now(),
    -- The rep act this line's subject was filed on, when there was one:
    -- the raw plane-delivered `wa_events` row the aperture verified
    -- (ADR-0003 class 2). It lives HERE and never in `ledger` because it
    -- dereferences to chat identity: the seam composes
    -- `external_event_id` as `<chat jid>:<message id>`, so a Ledger column
    -- holding this id would hand an owner the chat one join away, and
    -- owner-visible provenance is timestamp, confidence and source type
    -- only (ADR-0004). Null for a class-1 candidate fact, whose
    -- provenance is its extraction.
    source_event_id bigint REFERENCES wa_events (id),
    CONSTRAINT disclosure_lines_subject_kind_check
        CHECK (subject_kind IN ('fact', 'entity_create')),
    -- Exactly one subject, matching its kind.
    CONSTRAINT disclosure_lines_subject_check CHECK (
        (subject_kind = 'fact' AND fact_id IS NOT NULL AND entity_id IS NULL)
        OR (subject_kind = 'entity_create' AND entity_id IS NOT NULL AND fact_id IS NULL)
    ),
    CONSTRAINT disclosure_lines_rendered_text_check
        CHECK (btrim(rendered_text) <> ''),
    -- Company-scoped on purpose (MATCH SIMPLE, so it is not enforced when
    -- fact_id is null — the entity-create case): a line can never disclose
    -- a fact belonging to another company.
    CONSTRAINT disclosure_lines_fact_fkey
        FOREIGN KEY (company_id, fact_id)
        REFERENCES ledger.facts (company_id, id),
    -- MATCH SIMPLE: not enforced when entity_id is null, which is exactly
    -- the fact-subject case.
    CONSTRAINT disclosure_lines_entity_fkey
        FOREIGN KEY (company_id, entity_id)
        REFERENCES ledger.entities (company_id, entity_id)
);

-- FR-72's 1:1, half of it: one line per filed item, never two.
CREATE UNIQUE INDEX disclosure_lines_one_per_fact
    ON disclosure_lines (fact_id)
    WHERE subject_kind = 'fact';
CREATE UNIQUE INDEX disclosure_lines_one_per_entity_create
    ON disclosure_lines (company_id, entity_id)
    WHERE subject_kind = 'entity_create';

-- And the other direction: ONE rep act authorizes ONE entity create. A
-- confirmation is the rep saying "this chat is Fuentes" about one chat, so
-- a single «va» must not be reusable as the evidence for a second, unrelated
-- create (ADR-0003 class 2: the act is bound to the thing it authorized,
-- not merely to a message that exists). Idempotent replay is unaffected —
-- a repeat confirmation is a different seam row, and the repeat path
-- writes no second line at all.
CREATE UNIQUE INDEX disclosure_lines_one_create_per_rep_act
    ON disclosure_lines (source_event_id)
    WHERE subject_kind = 'entity_create';

-- An entity create is a rep act, so its line always names the rep act it
-- came from. Null evidence here would mean a create nobody can trace to a
-- rep, which is the shape a model-laundered crossing would take.
ALTER TABLE disclosure_lines
    ADD CONSTRAINT disclosure_lines_entity_create_evidence_check
    CHECK (subject_kind <> 'entity_create' OR source_event_id IS NOT NULL);

CREATE INDEX disclosure_lines_seat_day
    ON disclosure_lines (twin_id, filed_at);

-- A disclosure line is a statement made to a rep. It is never rewritten:
-- a correction annotates the FACT (FR-33), it does not edit the line that
-- disclosed it. DELETE is left available on purpose — disclosure lines are
-- plaintext, so retirement's cryptographic erasure (ADR-0009) cannot reach
-- them and must remove them by hand. If a later slice needs line state
-- transitions it relaxes this in a reviewable migration, the same pattern
-- as drafts_immutable.
CREATE FUNCTION disclosure_lines_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'disclosure lines are immutable (ADR-0034): % refused — a correction annotates the fact, it never rewrites what the rep was told', TG_OP;
END;
$$;

CREATE TRIGGER disclosure_lines_no_update
    BEFORE UPDATE ON disclosure_lines
    FOR EACH ROW EXECUTE FUNCTION disclosure_lines_immutable();

CREATE TRIGGER disclosure_lines_no_truncate
    BEFORE TRUNCATE ON disclosure_lines
    FOR EACH STATEMENT EXECUTE FUNCTION disclosure_lines_immutable();

-- FR-72, ENFORCED BY THE DATABASE. "A fact that crossed without being
-- disclosed" is not a bug we hope to catch — it is a state this database
-- cannot hold. The constraint trigger is DEFERRABLE INITIALLY DEFERRED, so
-- it runs at COMMIT: the aperture inserts the row and its disclosure line
-- inside one transaction, and a transaction that files one without the
-- other cannot commit at all.
--
-- The converse direction — every line maps to a filed subject — is the
-- foreign keys above. The reconciliation in packages/aperture/src/fr72.ts
-- is the independent auditor over both, and the only catcher of what a
-- superuser can still do by disabling these triggers.
CREATE FUNCTION ledger.assert_fact_disclosed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.disclosure_lines
         WHERE subject_kind = 'fact' AND fact_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'FR-72: fact % was filed with no disclosure line — the fact and its line commit together or not at all (ADR-0003)', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_facts_disclosed
    AFTER INSERT ON ledger.facts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.assert_fact_disclosed();

CREATE FUNCTION ledger.assert_entity_create_disclosed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.disclosure_lines
         WHERE subject_kind = 'entity_create'
           AND company_id = NEW.company_id
           AND entity_id = NEW.entity_id
    ) THEN
        RAISE EXCEPTION 'FR-72: entity % was created with no disclosure line — an entity create puts a name from the rep''s conversation into the Ledger, and is disclosed (ADR-0003 as amended)', NEW.entity_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entities_create_disclosed
    AFTER INSERT ON ledger.entities
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.assert_entity_create_disclosed();

-- The creation grant, on the same terms. "Binding a chat auto-grants the
-- creating rep" is the whole reason the rep can read the timeline their own
-- conversation filled, and the partial unique index on entity_grants
-- enforces AT MOST one creator — not at least one. Without this, an entity
-- could commit with no creator at all: filed, disclosed, and unreadable by
-- the rep who created it, with every audit green. Deferred, so the aperture
-- writes the entity and its grant in whichever order suits it.
-- And it must be the RIGHT rep's grant. "Some creation grant exists" would
-- accept a transaction that grants twin A and discloses to twin B: the
-- creator recorded in the Ledger and the rep who was told about the
-- crossing would be two different people, each audit green. The grant and
-- the disclosure line name the same twin, or the transaction does not
-- commit.
CREATE FUNCTION ledger.assert_entity_has_creator() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE creator uuid;
BEGIN
    SELECT twin_id INTO creator
      FROM ledger.entity_grants
     WHERE company_id = NEW.company_id
       AND entity_id = NEW.entity_id
       AND source = 'creation';
    IF creator IS NULL THEN
        RAISE EXCEPTION 'entity % was created with no creation grant — binding a chat auto-grants the creating rep, and an entity nobody may read is not a crossing anyone can correct', NEW.entity_id;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.disclosure_lines
         WHERE subject_kind = 'entity_create'
           AND company_id = NEW.company_id
           AND entity_id = NEW.entity_id
           AND twin_id = creator
    ) THEN
        RAISE EXCEPTION 'entity % records twin % as its creator but discloses the create to a different rep — the rep who created it is the rep who is told about it', NEW.entity_id, creator;
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entities_have_creator
    AFTER INSERT ON ledger.entities
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ledger.assert_entity_has_creator();

-- The questions store, born aperture-side (ADR-0003). A question is an ask
-- back to the rep — a below-threshold candidate fact, or an unresolved
-- entity attachment — and it is UNCROSSED rep content, so `content_enc`
-- holds twin-DEK ciphertext (ADR-0008) decrypted only at delivery. It is
-- EMPTY this ticket: the confidence gate that fills it is extraction's.
CREATE TABLE aperture_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    -- DEK ciphertext, never plaintext: this is the store the split in
    -- ADR-0003 puts on the encrypted side.
    content_enc bytea NOT NULL,
    asked_at timestamptz NOT NULL DEFAULT now(),
    -- An unanswered question expires on its own (FR-32) — ignoring one is
    -- a valid ending rather than a growing debt.
    expires_at timestamptz NOT NULL,
    answered_at timestamptz,
    -- Voided at departure (CONTEXT.md: the closing window).
    voided_at timestamptz,
    CONSTRAINT aperture_questions_content_enc_check
        CHECK (octet_length(content_enc) > 0),
    CONSTRAINT aperture_questions_expiry_check CHECK (expires_at > asked_at)
);

CREATE INDEX aperture_questions_open
    ON aperture_questions (twin_id, expires_at)
    WHERE answered_at IS NULL AND voided_at IS NULL;

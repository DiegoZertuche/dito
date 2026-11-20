-- The fact disclosure line, and where a crossing was read (ticket #52;
-- spec #48 grilling decisions 4, 5 and 6; ADR-0003, ADR-0004, ADR-0034,
-- ADR-0035).
--
-- Extraction files the first facts, so the disclosure has to be able to
-- render one. #51 refused a fact line loudly rather than rendering it
-- speculatively: it reached the seam with `entity_id` null and no
-- `source_event_id`, so neither its counterparty heading nor its «su chat»
-- instant had a rep-side source. Both arrive here, along with the question
-- store's own source column.
--
-- THIS FILE NAMES NO CHAT, and that is enforced (binding-wall.test.ts): it
-- is on the crossing's exemption list, which trades the entity ban for the
-- stricter rule that a crossing migration may not name a chat in any form.
-- A chat id beside an entity id IS the binding ADR-0004 keeps out of shared
-- Postgres. Extraction's own chat-carrying table is therefore a SEPARATE
-- migration (…100027), which in turn may never name an entity — the two
-- halves of one rule, each checked where it applies.
--
-- NUMBERING. Strictly above every existing migration, on purpose: wave 1
-- of this slice numbered two branches into interleaving ranges, which is
-- linear on a fresh database and refused by one that applied only a
-- subset. Parallel branches take their numbers from the top.

-- ---------------------------------------------------------------------
-- 1. THE FACT DISCLOSURE LINE
-- ---------------------------------------------------------------------
-- THE ENTITY, rep-side. A fact's entity lives on its Ledger row, and the
-- twin runtime holds no privilege on a Ledger TABLE (…100012) — so the
-- pass that groups the daily post by counterparty cannot read it there,
-- and must not be given a reason to try. The entity id is CLIENT-MINTED
-- rep-side in the first place (ADR-0035); carrying it on the line is
-- carrying back a value the rep's own device produced, not reaching over
-- the wall.
ALTER TABLE disclosure_lines
    DROP CONSTRAINT disclosure_lines_subject_check;
ALTER TABLE disclosure_lines
    ADD CONSTRAINT disclosure_lines_subject_check CHECK (
        (subject_kind = 'fact' AND fact_id IS NOT NULL AND entity_id IS NOT NULL)
        OR (subject_kind = 'entity_create' AND entity_id IS NOT NULL AND fact_id IS NULL)
    );

-- ...and it must be the fact's OWN entity. A line naming one entity while
-- disclosing a fact filed against another would group a crossing under the
-- wrong customer in the rep's own account of what crossed — and a later
-- «N no» would retract against a heading the rep never meant. The scoped
-- key below makes that unrepresentable rather than audited: the line's
-- (company, fact, entity) triple must exist as a row.
ALTER TABLE ledger.facts
    ADD CONSTRAINT ledger_facts_entity_scoped_key UNIQUE (company_id, id, entity_id);
ALTER TABLE disclosure_lines
    DROP CONSTRAINT disclosure_lines_fact_fkey;
ALTER TABLE disclosure_lines
    -- MATCH SIMPLE, like the constraint it replaces: unenforced when
    -- `fact_id` is null, which is exactly the entity-create case.
    ADD CONSTRAINT disclosure_lines_fact_fkey
        FOREIGN KEY (company_id, fact_id, entity_id)
        REFERENCES ledger.facts (company_id, id, entity_id);

-- THE INSTANT, and the ADR-0033 invariant's anchor. `source_event_id` was
-- documented as "the rep act this line's subject was filed on… null for a
-- class-1 candidate fact, whose provenance is its extraction". That
-- narrower reading does not survive the fact line: the «su chat, 27 ago
-- 19:23» clause the prototype settled needs an instant, and the only
-- honest one is WHEN THE MESSAGE WAS SENT — which is this row's
-- `occurred_at`.
--
-- Widened, therefore, to: THE SEAM ROW THIS LINE'S SUBJECT WAS READ IN.
-- For an entity create that is the rep's own «si»; for an extracted fact
-- it is the customer message the claim was read in. Both are rep-side and
-- neither reaches `ledger`, for the reason the column already gave — the
-- seam composes `external_event_id` as `<chat jid>:<message id>`, so this
-- id dereferences to chat identity and an owner-visible column holding it
-- would hand them the chat one join away (ADR-0004).
--
-- NOT NULL now, for every subject kind. A disclosure line that cannot name
-- the message it came from is a crossing nobody can trace to a
-- conversation — and it is exactly the row the ADR-0033 invariant would
-- have to pass over. The kind-specific CHECK it replaces is dropped as
-- redundant.
ALTER TABLE disclosure_lines
    DROP CONSTRAINT disclosure_lines_entity_create_evidence_check;
ALTER TABLE disclosure_lines
    ALTER COLUMN source_event_id SET NOT NULL;

COMMENT ON COLUMN disclosure_lines.source_event_id IS
    'The seam row this line''s subject was read in: the rep''s own confirmation for an entity create (ADR-0003 class 2 evidence), the customer message a fact was extracted from. Rep-side only — it dereferences to chat identity (ADR-0004) and never reaches `ledger`. NOT NULL: it is what the ADR-0033 exclusion invariant walks.';

-- ---------------------------------------------------------------------
-- 2. THE QUESTION'S SOURCE
-- ---------------------------------------------------------------------
-- A question is a below-threshold candidate fact or an unresolved entity
-- attachment (ADR-0003) — it is read in a chat, the same as a fact. The
-- store is still EMPTY after this ticket (below-threshold candidates file
-- nothing here; ticket #53 fills it), and the column arrives now anyway
-- because the ADR-0033 invariant covers CANDIDATE FACTS, QUESTIONS AND
-- FACTS. An invariant that cannot see the questions store until the ticket
-- that fills it remembers to add a column is the silent rot decision 4
-- exists to prevent.
--
-- Nullable, unlike the disclosure line's: nothing writes it yet, and a NOT
-- NULL on an unwritten column is a promise made by a migration rather than
-- by a caller. #53 tightens it when it has a writer.
ALTER TABLE aperture_questions
    ADD COLUMN source_event_id bigint REFERENCES wa_events (id);

COMMENT ON COLUMN aperture_questions.source_event_id IS
    'The seam row this question was read in. Rep-side only, for the same reason as the disclosure line''s. Unwritten until ticket #53 — it exists now so the ADR-0033 exclusion invariant covers this store from the day it is born.';

-- A question seals the claim it showed (ticket #73; FR-31, FR-32, FR-72;
-- ADR-0003 as amended, ADR-0008, ADR-0033, ADR-0034).
--
-- ADR-0034 already states the rule for the far side of this crossing:
--
--     "Disclosure lines are stored as rendered text, not as a template
--      reference, and carry no version. A disclosure line is what a rep was
--      told had crossed; re-rendering it later from a changed template
--      would retroactively rewrite that statement, which defeats the
--      purpose of disclosing."
--
-- A QUESTION IS THE SAME OBJECT ONE STEP EARLIER — what the rep was ASKED —
-- and until this migration the rule held on only one side. `answerQuestion`
-- re-rendered the line from the sealed payload at the moment the rep said
-- «si», so a question posted before a line-template change and answered
-- after filed a sentence the rep never saw.
--
-- NOT HYPOTHETICAL DRIFT. Slice 4 shipped two such changes into one branch
-- stack: #65 gave `DatePromised` its date and gave the commercial line
-- «— sin cantidad, sin precio», and #70 added the day, so the same line now
-- reads «— sin precio, sin fecha». A question shown as «— sin precio» files
-- «— sin precio, sin fecha» today. It has never bitten because
-- `aperture_questions` is empty on the rig across three runs (#57 finding
-- 3) and #66 measured 1 middle-band candidate in 88 — and slice 4 is the
-- slice that changes that.
--
-- STORED, NOT DERIVED, AND SEALED. The claim is a THIRD envelope beside the
-- question's own text and its candidate, and it is sealed for the same
-- reason both of those are: a question is UNCROSSED rep content, so a
-- plaintext column here would say in the clear what the twin believes it
-- read in a customer's chat (ADR-0003's storage split, …100030's rule that
-- "no plaintext column here describes what the twin read"). Only when the
-- rep affirms does the same string become a `disclosure_lines.rendered_text`
-- in the clear — which is exactly right, because affirming is when it
-- crosses.
--
-- THIS STORES NO NEW KIND OF CONTENT. The claim is the disclosure line an
-- affirmative would have filed anyway, held one step earlier and one step
-- more privately. Nothing here names an entity or a chat, so this file is
-- not on the crossing's exemption list (binding-wall.test.ts) and does not
-- need to be; the ADR-0033 exclusion still walks the row through
-- `source_event_id`, unchanged.
--
-- HOW THIS COMPOSES WITH `payload_version` (#70). They are the same rule at
-- two layers and they now agree. #70 made `FACT_PAYLOAD_VERSIONS` per-type
-- and had a pending question re-file its STORED `payloadVersion` from
-- `subject_enc`, so a shape change under an open question cannot restructure
-- what a «si» files. This seals the STATEMENT for the same reason: a
-- renderer carries no version at all (ADR-0034 says so in as many words),
-- so the stamp could never have reconstructed the sentence, and the
-- sentence could never have reconstructed the payload. After this
-- migration an affirmative re-files all three of the things it owes the
-- rep — the payload, its stamp and its statement — and derives none of
-- them.
--
-- NUMBERING. …1000 8 x, this ticket's own range; a sibling owns …070–…079.

-- ---------------------------------------------------------------------
-- 1. THE CLAIM THE QUESTION SHOWED
-- ---------------------------------------------------------------------

ALTER TABLE aperture_questions
    ADD COLUMN claim_enc bytea;

COMMENT ON COLUMN aperture_questions.claim_enc IS
    'The RENDERED DISCLOSURE LINE this question showed the rep, sealed under the twin DEK (ticket #73; ADR-0008, ADR-0034) — a sentence, not a candidate: `subject_enc` holds the candidate fact, this holds the one statement about it the rep was asked to agree to, and an affirmative files it verbatim. Never re-rendered at answer time, because re-rendering from a changed template retroactively rewrites what the rep was asked.';

-- NULLABLE, AND THEN CLOSED BY A CHECK — rather than `NOT NULL`, and the
-- difference is a question that already exists.
--
-- …100030 could write `subject_enc bytea NOT NULL` outright because the
-- table had no writer at all and "was born empty". That argument is spent:
-- #53 gave it one. A question asked by an earlier build carries no sealed
-- claim, and there is no honest way to supply one — the value is
-- ciphertext under a key no migration holds, and RE-RENDERING IT IS THE
-- DEFECT THIS FILE EXISTS TO CLOSE. So a bare `NOT NULL` would either fail
-- the upgrade or force the very fabrication the ticket forbids.
--
-- The domain answer is the one the store already has a verb for: a
-- question whose claim was never sealed can no longer be honoured, and it
-- ENDS. Voiding is that ending — the same one departure uses — and it is
-- silent, which is what FR-32 already says an unanswered question's ending
-- is. In practice this updates nothing: the store is empty on the rig
-- across three runs. It is here so that a database where it is NOT empty
-- migrates in place (#69's first acceptance criterion) instead of stopping,
-- and so that no such question can be affirmed afterwards. A question that
-- was already ANSWERED needs nothing: it had its ending, and rewriting its
-- past is exactly what this file forbids.
UPDATE aperture_questions
   SET voided_at = now()
 WHERE claim_enc IS NULL
   AND answered_at IS NULL
   AND voided_at IS NULL;

-- AN OPEN QUESTION ALWAYS CARRIES THE TEXT IT SHOWED. Stated this way
-- round rather than as a bare `NOT NULL` because it is the true rule and
-- because it is the rule the code leans on. The store's own definition of
-- a question that can still be delivered or answered is `answered_at IS
-- NULL AND voided_at IS NULL AND expires_at > now`, and the two NULL tests
-- are precisely the ones below — so every row that either door can reach
-- has its claim, by construction. `answerQuestion` therefore needs no null
-- branch and has none, which matters: a null branch could only fall back
-- to re-rendering, and re-rendering is the defect.
ALTER TABLE aperture_questions
    ADD CONSTRAINT aperture_questions_claim_sealed_check CHECK (
        (claim_enc IS NOT NULL AND octet_length(claim_enc) > 0)
        OR answered_at IS NOT NULL
        OR voided_at IS NOT NULL
    );

-- ---------------------------------------------------------------------
-- 2. AND IT NEVER MOVES
-- ---------------------------------------------------------------------
-- The claim joins the list of things a question never changes. Without
-- this the whole point leaks: freezing the payload while leaving the
-- SENTENCE rewritable would let an update do exactly what re-rendering
-- did, one statement instead of one deploy.
--
-- EXTENDED, NOT RE-CUT (the lesson `migration-vocabulary.test.ts` was
-- written for): every column …100030 froze is still frozen below, and
-- `claim_enc` is added to them. The answer half is untouched.
--
-- The privilege says it a second way already and needs no edit: …100030
-- revoked table-level UPDATE from `dito_aperture` and granted it back on
-- exactly five columns, so a column added here is one the aperture cannot
-- move at all.
CREATE OR REPLACE FUNCTION aperture_questions_answer_is_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
       OR NEW.twin_id IS DISTINCT FROM OLD.twin_id
       OR NEW.content_enc IS DISTINCT FROM OLD.content_enc
       OR NEW.subject_enc IS DISTINCT FROM OLD.subject_enc
       -- Ticket #73: what the rep was SHOWN, frozen beside what they would
       -- be filing. A question that could be re-worded after the fact is
       -- one whose answer means nothing.
       OR NEW.claim_enc IS DISTINCT FROM OLD.claim_enc
       -- The identity too (Codex r2): with the MAC mutable, rewriting it
       -- frees the unique key and the very next pass asks the same claim
       -- again — the one thing "asked once" is.
       OR NEW.candidate_kind_mac IS DISTINCT FROM OLD.candidate_kind_mac
       OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
       OR NEW.asked_at IS DISTINCT FROM OLD.asked_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    THEN
        RAISE EXCEPTION 'a question never changes what it asked (ADR-0034): % is immutable once recorded', TG_TABLE_NAME;
    END IF;
    -- AN ANSWER IS TERMINAL IN ALL FOUR OF ITS PARTS (Codex r2). Freezing
    -- only `answer` left the rest of it rewritable: an update keeping
    -- `answer = 'affirmed'` while moving `answered_at`, `answer_event_id`
    -- or `filed_fact_id` would leave the question naming a different rep
    -- act and a different crossing than the audit chain, the processing
    -- marker and the disclosure line all record — a disagreement nothing
    -- could ever reconcile, in a store whose whole job is to say what the
    -- rep authorized.
    IF OLD.answer IS NOT NULL
       AND (NEW.answer IS DISTINCT FROM OLD.answer
            OR NEW.answered_at IS DISTINCT FROM OLD.answered_at
            OR NEW.answer_event_id IS DISTINCT FROM OLD.answer_event_id
            OR NEW.filed_fact_id IS DISTINCT FROM OLD.filed_fact_id)
    THEN
        RAISE EXCEPTION 'question % was already answered "%" — an answer is terminal, and changing one''s mind about a fact that already crossed is a correction (FR-33), never a rewrite of the answer', OLD.id, OLD.answer;
    END IF;
    RETURN NEW;
END;
$$;

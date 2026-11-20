-- The aperture asks back (ticket #53; spec #48 grilling decisions 7 and 9;
-- FR-31, FR-32, FR-39; ADR-0003 as amended, ADR-0004, ADR-0008, ADR-0020,
-- ADR-0034).
--
-- `aperture_questions` was born empty in …100011 and stayed empty through
-- …100026, which added its `source_event_id` so the ADR-0033 invariant
-- could cover the store from the day it was born. This migration gives it
-- a writer, and everything a writer needs:
--
--   THE SUBJECT. A question is a below-threshold candidate fact (FR-31),
--     and an affirmative FILES that candidate. So the question has to hold
--     it — the aperture-normalized fact, not what the model said — and it
--     is UNCROSSED rep content, so it is sealed under the twin DEK exactly
--     like the question's own text (ADR-0003's storage split, spec #48
--     decision 9). There is no plaintext column here describing what the
--     twin read.
--
--   ASKED ONCE. `UNIQUE (twin_id, source_event_id, candidate_kind_mac)`:
--     at most one question per message PER KIND OF CLAIM, ever. Restarts
--     and further daily runs re-read a window (extraction's watermark
--     recovers an abandoned or deferred run), and a second pass over the
--     same message must never put the same ask in front of the rep again.
--
--     The kind rather than the whole candidate, because two model runs
--     over one message need not word a candidate identically — a key over
--     the payload would deduplicate nothing on exactly the path it exists
--     for. And the kind as an OPAQUE MAC rather than as `fact_type`,
--     because a question is UNCROSSED rep content: a plaintext column
--     saying "the twin read something order-shaped in message N" is a
--     small disclosure of exactly what has not crossed. The MAC is keyed
--     off the twin DEK (`deriveQuestionKey`), so it is opaque without the
--     key and dies with it (ADR-0009).
--
--     WHAT THIS STILL COLLAPSES, recorded and not closed (Codex r3): two
--     candidates of the SAME kind read in one message ask once. «100 cajas
--     de cemento y quizá 50 de cal» is two OrderTaken readings of one
--     sentence, and only the first is asked.
--
--     Closing it means keying on the candidate's normalized subject — and
--     that is precisely the key that stops deduplicating when a recovered
--     run's model rewords the same claim, which asks the rep twice and
--     lets them affirm two conflicting facts. The two acceptance criteria
--     — "a below-threshold candidate becomes a question" and "a question
--     is asked once" — cannot both hold literally under any key, because
--     "the model changed its mind" and "there really were two claims" are
--     the same rows. This key chooses the side where NOTHING WRONG
--     CROSSES, which is what FR-31 is for; the other side puts a duplicate
--     in an append-only store. It is a steering question, not a defect to
--     patch here.
--
--   THE ANSWER, and its evidence. An answer is a class-2 rep act
--     (ADR-0003): it names the raw plane-delivered `wa_events` row of the
--     rep's own reply. That id lives HERE and never in `ledger`, for the
--     reason `disclosure_lines.source_event_id` already gives — the seam
--     composes `external_event_id` as `<chat jid>:<message id>`, so it
--     dereferences to chat identity and owner-visible provenance is
--     timestamp, confidence and source type only (ADR-0004).
--
-- ...and one new twin-side store, `question_posts`: which twin post asked
-- which question, so a quoted «si» resolves back to it in stored rows with
-- no model in the path (ADR-0003 class 2). Prior art and shape: the daily
-- disclosure's `disclosure_posts` (…100025).
--
-- THIS FILE NAMES NO ENTITY AND NO CHAT, so it is not on the crossing's
-- exemption list (binding-wall.test.ts) and does not need to be. The
-- entity a question's candidate is attached to travels inside `subject_enc`
-- with the rest of the candidate — which is where it belongs anyway: it is
-- the twin's own client-minted id, and nothing joins on it until the
-- aperture opens the envelope to file.
--
-- NUMBERING. …1000 3 x, this ticket's own range: three branches cut from
-- #52 are in flight at once (#53 questions, #54 corrections, #55 merge)
-- and wave 1 of this slice already showed what interleaving costs — a set
-- that is linear on a fresh database and refused by one that applied only
-- a subset. Each branch takes a range from the top.

-- ---------------------------------------------------------------------
-- 1. THE QUESTION GETS A SUBJECT, A KEY, AND AN ANSWER
-- ---------------------------------------------------------------------

-- The candidate this question is about, DEK-sealed (ADR-0008): the fact
-- type, the payload version, the payload AS THE APERTURE NORMALIZED IT,
-- the model's confidence, and the entity the candidate is attached to.
-- Sealed rather than columnar because all of it is uncrossed rep content —
-- a `fact_type` column would say in the clear what the twin believes it
-- read in a customer's chat, which is precisely the thing that has not
-- crossed yet.
--
-- Normalized, not raw: the affirmative files THIS, so the rep is answering
-- about what would actually be stored rather than about what a model said
-- (the same rule that makes the disclosure line render from the shaped
-- payload, …100026).
ALTER TABLE aperture_questions
    ADD COLUMN subject_enc bytea NOT NULL,
    ADD CONSTRAINT aperture_questions_subject_enc_check
        CHECK (octet_length(subject_enc) > 0);

COMMENT ON COLUMN aperture_questions.subject_enc IS
    'The below-threshold candidate fact this question is about, as the aperture normalized it, sealed under the twin DEK (ADR-0003/0008). Opened only to file on an affirmative. No plaintext column here describes what the twin read.';

-- NOT NULL now that there is a writer, exactly as …100026 said it would
-- be: "a NOT NULL on an unwritten column is a promise made by a migration
-- rather than by a caller". A question that cannot name the message it was
-- read in is one the ADR-0033 exclusion invariant would have to pass over.
ALTER TABLE aperture_questions
    ALTER COLUMN source_event_id SET NOT NULL;

-- The candidate's KIND, as an opaque MAC keyed off the twin DEK
-- (`deriveQuestionKey`, ADR-0008). It is the deduplication key's other
-- half and it is not readable: the fact type of an uncrossed candidate is
-- still a statement about what the twin read in a customer's chat.
ALTER TABLE aperture_questions
    ADD COLUMN candidate_kind_mac bytea NOT NULL,
    ADD CONSTRAINT aperture_questions_candidate_kind_mac_check
        CHECK (octet_length(candidate_kind_mac) = 32);

COMMENT ON COLUMN aperture_questions.candidate_kind_mac IS
    'HMAC-SHA-256 of the candidate''s fact type under a DEK-derived key (ticket #53). Opaque without the twin key and erased with it — a plaintext fact type would say, in the clear, what the twin believes it read in a message that has not crossed.';

-- ASKED ONCE (the ticket's own AC). Not partial, deliberately: an answered
-- or an expired question still blocks a second ask about the same claim.
-- "A question is asked once" is about the rep's experience of being asked,
-- and having already answered is the strongest possible reason not to ask
-- again.
ALTER TABLE aperture_questions
    ADD CONSTRAINT aperture_questions_one_per_claim
        UNIQUE (twin_id, source_event_id, candidate_kind_mac);

-- The scoped key `question_posts` points at, so a post can never name one
-- twin's question under another twin's post (…100025's own lesson).
ALTER TABLE aperture_questions
    ADD CONSTRAINT aperture_questions_twin_scoped_key UNIQUE (twin_id, id);

-- THE ANSWER. `answered_at` already existed; these say WHAT the answer was
-- and WHICH REP ACT carried it.
ALTER TABLE aperture_questions
    -- 'affirmed' — the rep said yes and the candidate crossed, with its
    --              disclosure line, in the same transaction (FR-72).
    -- 'declined' — the rep said no. The question closes and NOTHING is
    --              filed. Named for the grammar class, like the seam
    --              disposition it shares a word with (…100024).
    ADD COLUMN answer text,
    -- The raw plane-delivered `wa_events` row of the rep's own reply —
    -- ADR-0003 class-2 evidence, re-verified by the aperture rather than
    -- taken from the caller. Rep-side only, like every other seam row id
    -- in this file.
    ADD COLUMN answer_event_id bigint REFERENCES wa_events (id),
    -- What an affirmative filed. The Ledger row is company-owned and this
    -- table is rep-side, so the reference points ACROSS in the same
    -- direction `disclosure_lines` already does — and company-scoped for
    -- the same reason, so a question can never name another company's
    -- fact.
    ADD COLUMN filed_fact_id uuid,
    ADD CONSTRAINT aperture_questions_answer_check
        CHECK (answer IS NULL OR answer IN ('affirmed', 'declined')),
    -- An answer is one thing: a verdict, an instant and the act that
    -- carried it. Half of one is not an answer.
    ADD CONSTRAINT aperture_questions_answered_check CHECK (
        (answer IS NULL AND answered_at IS NULL AND answer_event_id IS NULL)
        OR (answer IS NOT NULL AND answered_at IS NOT NULL
            AND answer_event_id IS NOT NULL)
    ),
    -- An affirmative filed a fact; a decline filed nothing; an OPEN
    -- question filed nothing either. All three halves, so neither a silent
    -- affirmative, nor a fact filed by a "no", nor a fact hanging off a
    -- question nobody has answered can be represented.
    --
    -- `IS NOT DISTINCT FROM` rather than `=`, and that is the whole point:
    -- on an open question `answer = 'affirmed'` is NULL, `NULL = true` is
    -- NULL, and a CHECK passes on NULL — so the plain equality would have
    -- admitted exactly the row it was written to forbid.
    ADD CONSTRAINT aperture_questions_filed_check CHECK (
        (answer IS NOT DISTINCT FROM 'affirmed') = (filed_fact_id IS NOT NULL)
    ),
    -- MATCH SIMPLE: unenforced while `filed_fact_id` is null, which is
    -- every open and every declined question.
    ADD CONSTRAINT aperture_questions_fact_fkey
        FOREIGN KEY (company_id, filed_fact_id)
        REFERENCES ledger.facts (company_id, id);

COMMENT ON COLUMN aperture_questions.answer_event_id IS
    'The rep''s own reply, as a raw plane-delivered seam row: ADR-0003 class-2 evidence for the answer. Rep-side only — it dereferences to chat identity (ADR-0004) and never reaches `ledger`.';

-- A question is asked once and answered once, and it never changes what it
-- asked. Refused in the store rather than promised in a comment, the same
-- construction as `drafts_immutable` and `disclosure_lines_immutable` —
-- but a targeted one, because unlike those rows this one HAS a legitimate
-- transition: open → answered, and open → voided at departure.
--
-- What may never move: the scope, the sealed question, the sealed
-- candidate, the message it was read in, when it was asked, when it
-- expires — and an answer, once given. A rep who answered «si» and then
-- «no» has changed their mind about a fact that already crossed, and the
-- verb for that is a correction on the disclosure post (#54), not a
-- rewrite of the question that never happened twice.
CREATE FUNCTION aperture_questions_answer_is_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
       OR NEW.twin_id IS DISTINCT FROM OLD.twin_id
       OR NEW.content_enc IS DISTINCT FROM OLD.content_enc
       OR NEW.subject_enc IS DISTINCT FROM OLD.subject_enc
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

CREATE TRIGGER aperture_questions_answer_terminal
    BEFORE UPDATE ON aperture_questions
    FOR EACH ROW EXECUTE FUNCTION aperture_questions_answer_is_terminal();

-- ...and the privilege says the same thing a second way (Codex r2), in the
-- shape …100012 already named for exactly this case: "annotation paths
-- take COLUMN-LEVEL UPDATE grants on exactly the columns they annotate —
-- a reviewable migration each, rather than a privilege nobody notices".
-- The aperture annotates a question's ending and nothing else; the two
-- envelopes, the identity, the scope and the message it was read in are
-- not its to move.
REVOKE UPDATE ON aperture_questions FROM dito_aperture;
GRANT UPDATE (answered_at, answer, answer_event_id, filed_fact_id, voided_at)
    ON aperture_questions TO dito_aperture;

-- ---------------------------------------------------------------------
-- 2. WHICH POST ASKED WHICH QUESTION
-- ---------------------------------------------------------------------
-- One post per question, one question per post. The rep answers by quoting
-- the post, so the walk a «si» takes is
--
--     quoted WhatsApp message id
--       → send_executions → send_commands.payload_ref = 'notice:<id>'
--       → notices (kind 'aperture_question')
--       → question_posts.notice_id
--       → aperture_questions
--
-- in stored rows, with no model anywhere in the path (ADR-0003 class 2,
-- spec #48 decision 7: no index to mistype). The quoted-id half of that
-- walk is the twin-post registry's one join (#49); this table is what the
-- registry's `aperture_question` entry resolves through.
--
-- ONE POST PER QUESTION, FOREVER (the primary key). This is deliberately
-- STRICTER than the daily disclosure's rule, where a line carried only by
-- a definitively failed post is owed again (…100025). The two differ
-- because of what is at stake: an undelivered disclosure line hides a
-- crossing the rep was promised an account of (FR-38), while an
-- undelivered question simply means a below-threshold candidate is never
-- confirmed and therefore never crosses — which is the fail-safe direction
-- FR-31 asks for in the first place. A rep meeting the same question twice
-- is a worse outcome than a candidate quietly expiring unasked.
CREATE TABLE question_posts (
    -- Carried, not derived, so both foreign keys below are twin-scoped and
    -- a post naming one twin's question is unrepresentable rather than
    -- merely unwritten (…100025's Codex r2 lesson, applied on the way in).
    twin_id uuid NOT NULL,
    question_id uuid NOT NULL PRIMARY KEY,
    notice_id uuid NOT NULL,
    posted_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT question_posts_one_per_notice UNIQUE (notice_id),
    CONSTRAINT question_posts_notice_fkey
        FOREIGN KEY (twin_id, notice_id) REFERENCES notices (twin_id, id),
    CONSTRAINT question_posts_question_fkey
        FOREIGN KEY (twin_id, question_id)
        REFERENCES aperture_questions (twin_id, id)
);

-- NO SECONDARY INDEX HERE, deliberately. Both reads this table serves are
-- already covered: "has this question been asked?" is an anti-join on
-- `question_id`, which is the primary key, and "which question did this
-- post ask?" is `notice_id`, which is unique above. An index by twin would
-- serve nothing and would say, falsely, that something reads this table
-- that way.

-- What the rep was shown is never rewritten — same construction as
-- `disclosure_posts` (…100025).
CREATE FUNCTION question_posts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'question posts are immutable: % refused — the post is the record of what the rep was asked (ADR-0034)', TG_OP;
END;
$$;

CREATE TRIGGER question_posts_no_update_delete
    BEFORE UPDATE OR DELETE ON question_posts
    FOR EACH ROW EXECUTE FUNCTION question_posts_immutable();
CREATE TRIGGER question_posts_no_truncate
    BEFORE TRUNCATE ON question_posts
    FOR EACH STATEMENT EXECUTE FUNCTION question_posts_immutable();

-- Grants, on purpose (…100012's rule: ALTER DEFAULT PRIVILEGES
-- deliberately does not cover `public`, so a store added later is granted
-- deliberately or not at all). This is a TWIN-side store — the record of
-- what the twin asked its own rep — so the runtime writes it and the
-- aperture only reads it. The aperture holds no INSERT: nothing on the far
-- side of the wall decides what the rep is shown. No UPDATE or DELETE for
-- anyone; the triggers above say the same thing a second way.
GRANT SELECT, INSERT ON question_posts TO dito_twin_runtime;
GRANT SELECT ON question_posts TO dito_aperture;
REVOKE UPDATE, DELETE, TRUNCATE ON question_posts
    FROM dito_twin_runtime, dito_aperture;

-- ---------------------------------------------------------------------
-- 3. VOCABULARY: dispositions grow, machinery doesn't (spec #48 decision 18)
-- ---------------------------------------------------------------------
-- 'question_answered' joins the event-processing dispositions: the rep
-- quoted an aperture question and said YES, and the candidate crossed with
-- its disclosure line in the same transaction as this marker. A NO reuses
-- 'declined' (…100024) — it is the same grammar class answering the same
-- way, and the seam already has the word.
--
-- Every value an earlier migration granted rides forward (the rule
-- …100022 states).
ALTER TABLE wa_event_processing
    DROP CONSTRAINT wa_event_processing_disposition_check;
ALTER TABLE wa_event_processing
    ADD CONSTRAINT wa_event_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'affirmed',
        'affirmation_refused',
        'dismissed',
        'binding_confirmed',
        'declined',
        'question_answered',
        -- ...and the rep answered, but the question was no longer theirs to
        -- answer: expired, already answered, voided, or its candidate no
        -- longer filable. A REP ACT HAPPENED and nothing was minted, and
        -- the marker says exactly that rather than claiming an answer the
        -- store does not hold (Codex r1). The audit chain carries the
        -- reason (ADR-0020).
        'question_answer_refused',
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored'
    ));

-- 'aperture_question' joins the closed notice kinds: one framed post per
-- question, posted AHEAD of the day's facts post (FR-39, spec #48 decision
-- 7). It is about the message the candidate was read in — the same
-- `about_event_id` the question itself names — so the post carries the
-- provenance the rep needs to go and check it.
ALTER TABLE notices
    DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question',
        'binding_ack',
        'answer',
        'daily_disclosure',
        'aperture_question'
    ));

ALTER TABLE notices
    ADD CONSTRAINT notices_aperture_question_about_event_check
    CHECK (kind <> 'aperture_question' OR about_event_id IS NOT NULL);

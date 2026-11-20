-- A line of the day's notes, corrected where it stands (ticket #344; spec
-- #318; ADR-0003 as amended, ADR-0008, ADR-0020, ADR-0034; FR-33, FR-37).
--
-- NUMBERING: …20261005100020, after …20261005100010 (the offers the rep
-- spent, #335). Forward-only: no migration in this repo is ever edited once
-- it has applied anywhere.
--
-- The rep taps a line of the notes card inside its correction window, edits
-- it in place and commits. What travels is the rep's own line through the
-- dashboard's door — their words, typed by them — POINTED AT the line they
-- edited. The twin reads it as a correction of that fact and calls the
-- retraction tool it already has; the aperture annotates the fact exactly as
-- a «3 está mal» in the thread does, and keeps the corrected words beside the
-- annotation. Three columns on two tables carry that, and nothing else moves.
--
-- ═══ 1. THE LINE THE REP EDITED, ON THE MESSAGE ROW ═══
--
-- ON THE ROW AND NOT ONLY ON THE TRIGGER, because this row is the class-2
-- evidence the act rests on (ADR-0003; `thread/evidence.ts`) and «the target
-- is what the rep pointed at» must be on the record the trigger is built
-- from. The thread's door has the same property for free — the quoted
-- message id is inside the seam row's sealed envelope — and the dashboard's
-- door gets it here: the card the rep tapped (the rep side's own post id, as
-- `dashboard_acts.post_id` names a card) and the number the card printed.
--
-- METADATA, IN THE CLEAR, the shape `dashboard_acts.post_id` already has: an
-- opaque id and a position. Neither is anything the rep said — the words stay
-- sealed in `text_enc` — so FR-73's custody of this table is unchanged.
--
-- BOTH OR NEITHER, by a CHECK: a post without a line names a whole record and
-- no target, and a line without a post names a number in nothing. A line is
-- a printed position, so it is at least one.
--
-- THE ROW STAYS IMMUTABLE: the columns are written by the INSERT and the
-- trigger `dashboard_messages_no_update_delete` refuses everything after it.
-- The grants are untouched — table-level SELECT and INSERT reach new columns
-- without a statement here, and nothing is granted to anyone new.

ALTER TABLE dashboard_messages
    ADD COLUMN IF NOT EXISTS about_post_id uuid REFERENCES posts (id),
    ADD COLUMN IF NOT EXISTS about_line_index integer;

ALTER TABLE dashboard_messages
    DROP CONSTRAINT IF EXISTS dashboard_messages_about_check;
ALTER TABLE dashboard_messages
    ADD CONSTRAINT dashboard_messages_about_check
    CHECK ((about_post_id IS NULL) = (about_line_index IS NULL)
           AND (about_line_index IS NULL OR about_line_index >= 1));

COMMENT ON COLUMN dashboard_messages.about_post_id IS
    'Ticket #344: the notes card the rep edited a line of, when this message is that edit — the rep side''s own post id. Set exactly when about_line_index is (dashboard_messages_about_check). The router sets the trigger''s quoted post from it, so the retraction tool resolves its target from the rep''s tap rather than from anything the model sends.';
COMMENT ON COLUMN dashboard_messages.about_line_index IS
    'Ticket #344: the number the card printed beside the line the rep edited — a position in the post, resolved against the numbering stored when the post was rendered (ADR-0034).';

-- ═══ 2. THE RETRACTION, EVIDENCED BY THE DOOR'S MESSAGE ═══
--
-- A line edited on the card is the one door message that names a target, so
-- a retraction is the one Ledger act a door message can evidence
-- (`repActEvidenceColumns` in `@dito/aperture` argues why the other stores
-- refuse one). `fact_retractions` gets the third evidence column, and the
-- exactly-one CHECK …20260908100060 put over two becomes one over three: an
-- act came from one surface, never two and never none.
--
-- ONE MESSAGE AUTHORIZES ONE RETRACTION, by its own partial unique index, for
-- the reason `fact_retractions_one_per_dashboard_act` gives: a unique index
-- over several nullable columns is unique over the tuple and says nothing
-- about one of them.

ALTER TABLE fact_retractions
    ADD COLUMN IF NOT EXISTS dashboard_message_id uuid
        REFERENCES dashboard_messages (id);

ALTER TABLE fact_retractions
    DROP CONSTRAINT IF EXISTS fact_retractions_one_evidence_check;
ALTER TABLE fact_retractions
    ADD CONSTRAINT fact_retractions_one_evidence_check
    CHECK ((source_event_id IS NOT NULL)::int
           + (dashboard_act_id IS NOT NULL)::int
           + (dashboard_message_id IS NOT NULL)::int = 1);

CREATE UNIQUE INDEX IF NOT EXISTS fact_retractions_one_per_dashboard_message
    ON fact_retractions (dashboard_message_id)
    WHERE dashboard_message_id IS NOT NULL;

COMMENT ON COLUMN fact_retractions.dashboard_message_id IS
    'Ticket #344: the door message that retracted this fact, when the rep edited the line on the notes card and the twin took it as a correction. Exactly one of this, source_event_id and dashboard_act_id is set, and each is unique.';

-- ═══ 3. THE CORRECTED WORDS, KEPT BESIDE THE ANNOTATION ═══
--
-- «Corrections annotate, never erase» (FR-37): the fact keeps its row and its
-- line, and what the rep said it should read is kept beside the annotation —
-- not over the claim the aperture stored (ADR-0034 forbids rewriting that),
-- and not in the Ledger (the words are the rep's, rep-side, and erasure must
-- reach them).
--
-- THE REP'S OWN WORDS, COPIED BY CODE, NEVER THE MODEL'S. The aperture writes
-- this column from the door message row that evidences the act — the same
-- sealed bytes, under the same twin DEK (ADR-0008) — inside the same unit as
-- the retraction, and hashes those bytes into the `fact_retraction` chain
-- entry's ref, so the chain covers the annotation by construction rather than
-- by a second write somebody has to remember (ADR-0020).
--
-- ONLY A DOOR CORRECTION CARRIES ONE: «el 3 está mal» in the thread and
-- **Retirar** on the card say a line is wrong without saying what it should
-- read, so their rows keep NULL here. The CHECK says so.

ALTER TABLE fact_retractions
    ADD COLUMN IF NOT EXISTS correction_enc bytea;

ALTER TABLE fact_retractions
    DROP CONSTRAINT IF EXISTS fact_retractions_correction_from_door_check;
ALTER TABLE fact_retractions
    ADD CONSTRAINT fact_retractions_correction_from_door_check
    CHECK (correction_enc IS NULL OR dashboard_message_id IS NOT NULL);

COMMENT ON COLUMN fact_retractions.correction_enc IS
    'Ticket #344: the line as the rep says it should read — the bytes of the evidencing dashboard message''s text_enc, copied by the aperture in the retraction''s own unit and hashed into the fact_retraction chain entry. Sealed under the twin DEK (ADR-0008); NULL for a retraction that named no corrected text.';

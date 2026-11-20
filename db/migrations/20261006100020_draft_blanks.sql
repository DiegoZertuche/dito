-- A blank the twin leaves in a draft, and the rep's answer that fills it
-- (ticket #342; spec #318; the spine's movement 8, «Me falta un dato»;
-- ADR-0006, ADR-0008, ADR-0013 as amended, ADR-0037 as amended).
--
-- NUMBERING: …20261006100020, after …20261005100020 (a notes line corrected
-- in place, #344) and clear of …20261006100010 (the card notes, #340).
-- Forward-only: no migration in this repo is ever edited once it has applied
-- anywhere.
--
-- When the twin drafts and one fact is missing that only the rep has — the
-- price they will give, the hour they can deliver — it leaves a BLANK rather
-- than guessing: a marker in the body and a typed slot in the post's sealed
-- draft part (the key, a short label, the one question it would ask). The
-- rep answers the question in prose through the dashboard's door, and the
-- twin fills the blank by writing a NEW draft — drafts are immutable, and a
-- revised message is a new draft awaiting its own tap (…20260827100010).
-- Three things in the store carry that.
--
-- ═══ 1. WHICH DRAFTS CARRY AN OPEN BLANK ═══
--
-- A TABLE AND NOT A COLUMN ON `drafts`, for three reasons. `drafts` is
-- immutable and a flag set at birth would be one more column every writer
-- must remember; a draft carries one row per blank, so «one fewer» is a
-- count and not a rewrite; and the send lock has to read it WITHOUT A KEY —
-- rep-web is the second minter and holds none (ADR-0006, ADR-0010) — so it
-- must be plaintext, which the sealed part never is.
--
-- CONTENT-FREE BY SHAPE: the draft and the blank's key, which code assigns —
-- `b1`, `b2`… in the order the body marks them — and a CHECK holds to that
-- shape, so nothing the model wrote, and nothing about the customer, is here.
-- The label and the question — the twin's words — live in the post's sealed
-- part.
--
-- IMMUTABLE, like the draft it belongs to: a filled blank is not a deleted
-- row but a new draft without it, so a draft with a row here is refused by
-- the send lock for good (`blank_open`), and the draft that superseded it is
-- the one that sends.

CREATE TABLE IF NOT EXISTS draft_blanks (
    draft_id uuid NOT NULL REFERENCES drafts (id),
    key text NOT NULL
        CONSTRAINT draft_blanks_key_shape_check
        CHECK (key ~ '^b[1-9][0-9]{0,2}$'),
    PRIMARY KEY (draft_id, key)
);

COMMENT ON TABLE draft_blanks IS
    'Ticket #342: one row per blank the twin left in a draft — a fact only the rep has. Content-free: the draft and the blank''s key, assigned by code (b1, b2…); the label and the question are sealed in the post''s draft part. The send lock refuses a draft with any row here (blank_open). Immutable: a fill writes a new draft without the blank.';

CREATE OR REPLACE FUNCTION draft_blanks_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'draft_blanks are immutable (ticket #342): % refused — a blank is filled by a new draft, never by editing this one', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS draft_blanks_no_update_delete ON draft_blanks;
CREATE TRIGGER draft_blanks_no_update_delete
    BEFORE UPDATE OR DELETE ON draft_blanks
    FOR EACH ROW EXECUTE FUNCTION draft_blanks_immutable();

DROP TRIGGER IF EXISTS draft_blanks_no_truncate ON draft_blanks;
CREATE TRIGGER draft_blanks_no_truncate
    BEFORE TRUNCATE ON draft_blanks
    FOR EACH STATEMENT EXECUTE FUNCTION draft_blanks_immutable();

-- The lease holder writes it with the draft; both minters read it. rep-web
-- reads the one column the lock asks about, `draft_dismissals`' shape.
GRANT SELECT, INSERT ON draft_blanks TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON draft_blanks FROM dito_twin_runtime;
GRANT SELECT (draft_id) ON draft_blanks TO dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON draft_blanks FROM dito_rep_web;

-- ═══ 2. WHICH DRAFT A FILL SUPERSEDED ═══
--
-- The rep answered, and the twin wrote the draft again with the blank filled.
-- The old draft is not edited and its post is not withdrawn — the post is the
-- record of what the twin put in front of the rep (ADR-0034) — so what says
-- the old card stopped waiting is this row: the draft, the draft that took
-- its place, and the thread execution that wrote it.
--
-- ONE FILL PER DRAFT: the primary key is the draft, so a superseded draft is
-- superseded once, and the draft that took its place is unique too, so one
-- new draft fills one old one.
--
-- THE EXECUTION IS DEFERRED, `posts.execution_id`'s reason: the fill is
-- written from inside the model loop, before the run's record exists, and the
-- reference is checked at COMMIT.

CREATE TABLE IF NOT EXISTS draft_fills (
    draft_id uuid PRIMARY KEY REFERENCES drafts (id),
    filled_draft_id uuid NOT NULL UNIQUE REFERENCES drafts (id),
    execution_id uuid NOT NULL
        CONSTRAINT draft_fills_execution_id_fkey
        REFERENCES executions (id) DEFERRABLE INITIALLY DEFERRED,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT draft_fills_not_itself_check CHECK (draft_id <> filled_draft_id)
);

COMMENT ON TABLE draft_fills IS
    'Ticket #342: a draft the twin wrote again with a blank filled from the rep''s answer — the superseded draft, the draft that took its place and the thread execution that wrote it. A superseded draft stops waiting on the canvas; its blanks keep it refused by the send lock. Content-free and immutable.';

CREATE OR REPLACE FUNCTION draft_fills_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'draft_fills are immutable (ticket #342): % refused — a fill is the record of which draft took another''s place', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS draft_fills_no_update_delete ON draft_fills;
CREATE TRIGGER draft_fills_no_update_delete
    BEFORE UPDATE OR DELETE ON draft_fills
    FOR EACH ROW EXECUTE FUNCTION draft_fills_immutable();

DROP TRIGGER IF EXISTS draft_fills_no_truncate ON draft_fills;
CREATE TRIGGER draft_fills_no_truncate
    BEFORE TRUNCATE ON draft_fills
    FOR EACH STATEMENT EXECUTE FUNCTION draft_fills_immutable();

-- The lease holder alone: the canvas is read through its API.
GRANT SELECT, INSERT ON draft_fills TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON draft_fills FROM dito_twin_runtime;

-- ═══ 3. THE BLANK A DOOR MESSAGE ANSWERS, ON THE MESSAGE ROW ═══
--
-- #344 put the line a message corrects on the row it arrived as; a blank's
-- answer is the same kind of pointing — the card the rep tapped and which of
-- its blanks — so it is the same two columns' sibling: the post id already
-- there, and the blank's key beside the line index. A reference names a line
-- or a blank, never both, and a post with neither names no target.
--
-- METADATA, IN THE CLEAR, `draft_blanks.key`'s own shape; the words stay
-- sealed in `text_enc`. The row stays immutable and no grant changes.

ALTER TABLE dashboard_messages
    ADD COLUMN IF NOT EXISTS about_blank_key text;

ALTER TABLE dashboard_messages
    DROP CONSTRAINT IF EXISTS dashboard_messages_about_check;
ALTER TABLE dashboard_messages
    ADD CONSTRAINT dashboard_messages_about_check
    CHECK ((about_post_id IS NULL)
               = (about_line_index IS NULL AND about_blank_key IS NULL)
           AND (about_line_index IS NULL OR about_blank_key IS NULL)
           AND (about_line_index IS NULL OR about_line_index >= 1)
           AND (about_blank_key IS NULL
                OR about_blank_key ~ '^b[1-9][0-9]{0,2}$'));

COMMENT ON COLUMN dashboard_messages.about_blank_key IS
    'Ticket #342: the blank of the draft card about_post_id names that this message answers — the rep tapped it and replied in prose. Set exactly when about_post_id is and about_line_index is not (dashboard_messages_about_check). The router points the turn at that draft and blank, so fill_blank resolves its target from the rep''s tap.';

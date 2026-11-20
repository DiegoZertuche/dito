-- What the rep has already been shown (ticket #262; spec #258 *Notification
-- end to end*; ADR-0031 as amended's promise, boundary #225's F17).
--
-- NUMBERING: …20260922100040, after …20260922100030 (the push subscription).
-- Forward-only: no migration in this repo is ever edited once it has applied
-- anywhere, because a migration is a statement about what a database has
-- already been through.
--
-- ═══ THE FACT NOTHING RECORDED ═══
--
-- «Shown once» is the rule two surfaces want and neither could hold: the fill
-- card reports how a fill ended and should retire when the rep has READ that,
-- and a card the rep is looking at should not also arrive on their phone. Both
-- need one fact — this seat has seen this thing — and nothing in the rep side
-- recorded it. The fill card's stand-in was a twenty-four hour window measured
-- from the plane's own stop marker, which is the honest bound available without
-- a stamp and is not the rule (…20260909100020's card, and `fill.ts`).
--
-- ═══ CONTENT-FREE, AND THE SHAPE IS WHAT MAKES IT SO ═══
--
-- A mark is a seat, a KIND out of a closed set this repo owns, a REFERENCE
-- that is an identifier this database minted or an instant this database's
-- clock produced, and when it was seen. Nothing a rep or a customer said can
-- reach any of the four, and the CHECK below is a membership and a shape rather
-- than a hope: the store says what was seen and never what it said.
--
-- ═══ WHO WRITES IT, WHICH IS THE WHOLE OF THE RULE ═══
--
-- The PAGE'S OWN READ writes it, and nothing else may: Inicio renders a post to
-- a logged-in session, and that render is the moment. A HEAD READ — the poll
-- that asks whether anything is newer — stamps nothing, and neither does a
-- prefetch, because neither is the rep looking at the card. That is a rule
-- about rep-web's code paths and cannot be a constraint here; what this table
-- contributes is that only ONE role can write a mark at all.
--
-- ═══ ONE MARK PER THING, AND THE FIRST SIGHTING IS THE ONE ═══
--
-- A second render is not a second sighting, so the unique key is the triple and
-- a repeat write does nothing. `seen_at` therefore answers «when did they first
-- see it», which is the only version of the question a retirement rule needs.
--
-- ═══ RE-RUNNABLE ═══
--
-- Atlas never re-applies a file; this is for an OPERATOR replaying it by hand
-- against a database whose revision history says nothing. `IF NOT EXISTS` on
-- everything that takes it, a duplicate-object handler on the policy, and every
-- GRANT, REVOKE and COMMENT idempotent as written.

CREATE TABLE IF NOT EXISTS seen_marks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- ADR-0002: every shared table carries `company_id` under Postgres RLS.
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    -- WHAT KIND OF THING WAS SEEN, out of a closed set. `post` is a card on
    -- Inicio; `fill_stop` is the report that a chat's fill ended. The
    -- vocabulary is `@dito/seam`'s `SEEN_SUBJECT_KINDS` and this CHECK is its
    -- other half (`migration-vocabulary.test.ts`).
    subject_kind text NOT NULL,
    -- WHICH one: a `posts` id, or the instant the plane stamped the fill's end
    -- rendered as text. Never content — see the header.
    subject_ref text NOT NULL,
    seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT seen_marks_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id),
    CONSTRAINT seen_marks_subject_kind_check
        CHECK (subject_kind IN ('post', 'fill_stop')),
    -- A REFERENCE IS AN IDENTIFIER OR AN INSTANT, AND BOUNDED SO. A uuid and
    -- an ISO instant share this character set, and nothing anybody typed does:
    -- a sentence needs a space or a letter past `f` and `t`, and 64 characters
    -- is room for neither.
    CONSTRAINT seen_marks_subject_ref_check
        CHECK (subject_ref ~ '^[0-9A-Za-z:.+-]{1,64}$'),
    CONSTRAINT seen_marks_once
        UNIQUE (seat_id, subject_kind, subject_ref)
);

COMMENT ON TABLE seen_marks IS
    'Ticket #262: one row per thing one seat has been shown — a post Inicio rendered to a logged-in session, or a fill''s reported end. Content-free: a kind out of a closed set and an identifier this database minted. Written by the page''s own read and by nothing else; a head read and a prefetch stamp nothing (spec #258).';
COMMENT ON COLUMN seen_marks.subject_kind IS
    'post (a card Inicio rendered) · fill_stop (the report that a chat''s fill ended). The vocabulary is `@dito/seam`''s constant and this column''s CHECK is its other half (ticket #262).';
COMMENT ON COLUMN seen_marks.subject_ref IS
    'Which one: a `posts` id, or the instant the plane stamped the fill''s end rendered as text. An identifier, never content (ticket #262).';
COMMENT ON CONSTRAINT seen_marks_once ON seen_marks IS
    'A second render is not a second sighting, so `seen_at` answers when the rep FIRST saw it — which is the only version of the question a «shown once» rule needs (ticket #262).';

-- The retirement question, asked on every render: «has this seat seen this?».
-- The unique key above already indexes the triple, so nothing else is needed.

-- ── Row-level security, born under it ─────────────────────────────────────
--
-- `sessions`' own shape (…20260907100040): ENABLED and FORCED, one policy
-- `FOR ALL` for the one role that reads and writes here, keyed on the pinned
-- expression FR-71a diffs against a string. Nobody else gets a policy, which
-- is a deny-all for every other non-superuser — the twin runtime has no
-- business in what a browser has been shown, and the owner is on the far side
-- of the wall from both.
ALTER TABLE seen_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE seen_marks FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    CREATE POLICY seen_marks_rep_web ON seen_marks
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY seen_marks_rep_web ON seen_marks IS
    'Ticket #262: rep-web reads and writes the seen marks of the company its connection declared, and of no other — a missing declaration is NULL, so it reads nothing and can write nothing.';

-- ── Grants, on purpose (…20260829100012's rule) ───────────────────────────
--
-- SELECT AND INSERT, AND NOTHING ELSE. A mark is appended when the rep is
-- shown something and read back when a card asks whether to retire; there is
-- no verb that un-sees a thing, so UPDATE and DELETE are withheld — the same
-- line `acknowledgments` is held to one table over, and for the same reason: a
-- record a login can rewrite is not a record.
GRANT SELECT, INSERT ON seen_marks TO dito_rep_web;

-- NOTHING FOR ANYBODY ELSE. The REVOKEs are a statement rather than a change:
-- …20260829100012's blanket grant does not reach a table created after it, so
-- nothing is being taken away. They are here so the GRANT DIFF says so too.
REVOKE ALL ON seen_marks FROM dito_twin_runtime;
REVOKE ALL ON seen_marks FROM dito_aperture;
REVOKE ALL ON seen_marks FROM dito_owner;

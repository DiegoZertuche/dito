-- Link day's own stores: the invitation, the acknowledgments, the seat's
-- onboarding stamp, and the two acts whose target is a chat rather than a card
-- (ticket #223; spec #214 decisions 4, 6, 7 and 9, *Link day, in detail*,
-- *Roles and grants*; ADR-0010, ADR-0013, ADR-0031, ADR-0032, FR-23, FR-63).
--
-- NUMBERING: …20260908100070, after …100060 (the dashboard's acts and the
-- second tap minter, #224). Forward-only: no migration in this repo is ever
-- edited once it has applied anywhere, because a migration is a statement
-- about what a database has already been through.
--
-- ═══ WHAT ARRIVES HERE ═══
--
--   1. `invitations` — one seat-scoped, single-use, expiring token per invite,
--      held as a digest, naming the session its opening created.
--   2. `acknowledgments` — one append-only row per document version a rep
--      accepted, carrying the DIGEST of the words they read.
--   3. `seats.onboarded_at` — the one soft fact link day's order rests on, and
--      the second column rep-web may write.
--   4. `dashboard_acts` grows a second kind of target: a scope switch acts on
--      a CHAT DIRECTORY ROW and carries no post, so `post_id` becomes nullable
--      and two CHECKs say which verbs carry which.
--   5. The row-level policies and the grants that make 1–4 reachable by
--      rep-web and by nobody else, pinned in `@dito/aperture`'s `grants.ts`
--      and diffed in both directions by FR-71a's rep-web clause.
--
-- ═══ IDEMPOTENT OVER EXISTING ROWS, AND OVER ITSELF ═══
--
-- The rig has a seat in state `linked` WITH an address, open `sessions`,
-- `dashboard_acts` rows carrying a post, `chat_directory` rows and
-- `plane_requests` rows. This file must survive being applied over them and
-- applied twice: `IF NOT EXISTS` on what takes it, a duplicate-object handler
-- on the constraints and policies that cannot, and every constraint dropped
-- `IF EXISTS` before it is re-added. Atlas never re-applies a file, so what
-- that is for is an OPERATOR replaying it by hand against a database whose
-- revision history says nothing — the upgrade rehearsal #218, #220, #221 and
-- #224 each ran.
--
-- EVERY STAMP DEFAULTS TO `clock_timestamp()` (PR #213's rule): `now()` pins
-- to transaction start, so two rows written in one transaction would tie —
-- and the acknowledgment pair below is written in exactly one transaction.

-- ── The invitation ────────────────────────────────────────────────────────
--
-- ONE SEAT-SCOPED, SINGLE-USE, EXPIRING TOKEN (spec #214 *Link day, in
-- detail*: "an invitation is a seat-scoped single-use token with an expiry,
-- issued by an operator script on the rig"; ADR-0032: onboarding begins on the
-- dashboard, the rep is invited by link and never by a message).
--
-- `login_codes`' SHAPE, AND THE THREE DIFFERENCES ARE THE WHOLE TABLE. Like a
-- login code it is seat-scoped, held as a digest, expiring and consumed once.
-- Unlike one it is issued by an OPERATOR rather than asked for by a device —
-- so there is no attempt to bind it to and rep-web holds no INSERT on it — it
-- lasts DAYS rather than minutes, because a forwarded invitation is read when
-- the rep next opens their mail, and it carries the SESSION its opening
-- created, which is what makes «this invitation let somebody in, and here is
-- the device» answerable from one row.
--
-- THE TOKEN IS A DIGEST AND NEVER THE BYTES, exactly as a session id and a
-- login code are: 32 random bytes base64url in the URL's path, sha-256 in the
-- store. A reader of this table can open no invitation. UNIQUE because the
-- digest is the lookup key — two rows sharing one would make "which invitation
-- is this" ambiguous at the moment it decides who the reader is.
--
-- USED, NEVER DELETED. `used_at` is the single-use fence and the record that
-- the invitation was spent; nothing holds DELETE. The same annotate-never-
-- erase shape the whole rep side is written in (FR-33).
CREATE TABLE IF NOT EXISTS invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    -- sha-256 of the 32 random bytes the link carries. Length-checked, so a
    -- truncated or differently-hashed value cannot be stored at all.
    token_sha256 bytea NOT NULL,
    -- LINK DAY'S CLOCK STARTS HERE (spec #214 DoD 3: "the time from invitation
    -- to linked number under five minutes, recorded"), which is why
    -- `rig-link-day-time.ts` reads this column and no other.
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- The expiry is the ISSUER's, passed in rather than defaulted here, so the
    -- store never disagrees with the script about how long an invitation lasts
    -- (`INVITATION_LIFETIME_DAYS` in `@dito/seam`).
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    -- THE DEVICE THAT CAME IN THROUGH IT. Nullable because an unused
    -- invitation opened none; a foreign key because a session id that named no
    -- session would be a record of a login nobody can find.
    session_id uuid REFERENCES sessions (id),
    CONSTRAINT invitations_token_sha256_length_check
        CHECK (length(token_sha256) = 32),
    CONSTRAINT invitations_token_unique UNIQUE (token_sha256),
    CONSTRAINT invitations_expires_after_issued_check
        CHECK (expires_at > issued_at),
    -- A SESSION IS A CONSEQUENCE OF A USE. A row naming a session and no
    -- `used_at` would say a device came in through an invitation nobody spent,
    -- which is the one thing this table exists to make unrepresentable.
    CONSTRAINT invitations_session_needs_use_check
        CHECK (session_id IS NULL OR used_at IS NOT NULL),
    -- The composite key, for `sessions`' own reason (…20260907100040): the
    -- row-level policy compares the COMPANY, so without this an invitation
    -- could name one company's seat while carrying another company's id,
    -- satisfy every constraint, and be readable by the wrong deployment.
    CONSTRAINT invitations_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id)
);

COMMENT ON TABLE invitations IS
    'Ticket #223: one row per invitation — the seat, the company, the sha-256 of the 32 random bytes the link''s path carries, when it was issued, when it expires, when it was spent and the session that spending opened. Never the token. Issued by an operator script (rep-web holds no INSERT); consumed once, under an advisory lock, in the transaction that opens the session (spec #214 *Link day, in detail*; ADR-0032).';
COMMENT ON COLUMN invitations.token_sha256 IS
    'sha-256 of the invitation token, never the token — a read of this table opens no invitation (ticket #223).';
COMMENT ON COLUMN invitations.issued_at IS
    'Where link day''s clock starts. `rig-link-day-time.ts` reads this and the first `linked` rail row after it, and prints the delta — recorded, never gated (spec #214 *Testing Decisions*).';
COMMENT ON COLUMN invitations.session_id IS
    'The session the opening of this invitation created. Set exactly when `used_at` is — so «this invitation let somebody in, and here is the device» is one row rather than a join nobody can make (ticket #223).';

-- The operator's own read, and `rig-link-day-time.ts`': one seat's
-- invitations, newest first.
CREATE INDEX IF NOT EXISTS invitations_seat_issued_idx
    ON invitations (seat_id, issued_at DESC);

-- ── The acknowledgment ────────────────────────────────────────────────────
--
-- ONE ROW PER DOCUMENT VERSION A REP ACCEPTED (spec #214 decision 6: "each
-- page shows the text and ends in an explicit acknowledgment recorded as seat,
-- document, version, instant, device"; user story 12: "I want every
-- acknowledgment to record exactly which version of the text I read, so that
-- nobody can later claim I agreed to different words").
--
-- THE DIGEST IS WHY THIS ROW IS WORTH MORE THAN A VERSION NUMBER, and
-- `@dito/copy`'s `documents.ts` asks for it by name: the digest sits beside the
-- text it describes, so an author who edits a published text AND re-runs its
-- digest publishes different words under an existing version and every local
-- assertion still passes. `copy-versions-check.mjs` closes that from HISTORY;
-- this column closes it from the RECORD a rep's consent actually lives in — the
-- row carries the sha-256 of the words that were on the page, so a text changed
-- under an unchanged version is detectable from the acknowledgment itself.
--
-- THE DEVICE IS THE SESSION, and it is NOT NULL. «Recorded as … device» is what
-- decision 6 asks for, and `sessions` holds no user agent and no IP by design
-- (…20260907100040 argues it) — so the honest reading of "device" is the
-- session row, which is exactly one device's login. An acknowledgment with no
-- session would be one nobody can place.
--
-- APPEND-ONLY BY TRIGGER, AND NOT ONLY BY GRANT. rep-web holds INSERT and
-- SELECT and nothing else, which is the fence in front of the dashboard; the
-- trigger is the fence in front of the SCHEMA OWNER, which every migration,
-- every script and every suite connects as. A consent record that the process
-- running the migrations can silently rewrite is not a consent record, and
-- `dashboard_acts` and `send_refusals` both already carry this shape — the
-- difference here is that there is no permitted UPDATE at all, because there is
-- nothing about an acknowledgment that is learned after it is made.
CREATE TABLE IF NOT EXISTS acknowledgments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    -- The device, which is the session (see the header). A foreign key, so an
    -- acknowledgment cannot name a login that does not exist.
    session_id uuid NOT NULL REFERENCES sessions (id),
    -- WHICH DOCUMENT. A closed set, swept against `@dito/copy`'s own
    -- `DOCUMENT_KEYS` by `migration-vocabulary.test.ts` — so a key the pages
    -- can write that the store refuses is a red build rather than a
    -- constraint violation in front of a rep on link day.
    document text NOT NULL,
    -- ...AND WHICH VERSION OF IT. 1-based and contiguous per key in the
    -- package; the store checks only that it is a version at all, because the
    -- package is where versions are published and a store that enumerated
    -- them would need a migration per legal text.
    version integer NOT NULL,
    -- The sha-256 of the words that were on the page (see the header).
    digest bytea NOT NULL,
    acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT acknowledgments_document_check
        CHECK (document IN ('contract_summary',
                            'contract_text',
                            'ban_risk_disclosure')),
    CONSTRAINT acknowledgments_version_check CHECK (version > 0),
    CONSTRAINT acknowledgments_digest_length_check CHECK (length(digest) = 32),
    CONSTRAINT acknowledgments_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id)
);

COMMENT ON TABLE acknowledgments IS
    'Ticket #223: one append-only row per document version a rep accepted — the seat, the company, the session that acknowledged (the device), the document key from a closed set, the version, the sha-256 of the words that were on the page, and the instant. No UPDATE and no DELETE, by trigger as well as by grant: a consent record the schema owner can rewrite is not a consent record (spec #214 decision 6; user story 12).';
COMMENT ON COLUMN acknowledgments.session_id IS
    'The device, which is the session — `sessions` holds no user agent and no IP by design, so one device''s login is the honest reading of «recorded as … device» (spec #214 decision 6).';
COMMENT ON COLUMN acknowledgments.digest IS
    'sha-256 of the document text the rep actually read. `documents.ts` asks the row to carry it: an author who edits a published text and re-runs its digest passes every local assertion, and this column is what makes that detectable from the record a rep''s consent lives in (ticket #223).';

-- Every version of every document one seat has accepted — the onboarding
-- step's own read, asked once per request.
CREATE INDEX IF NOT EXISTS acknowledgments_seat_document_idx
    ON acknowledgments (seat_id, document, version);

CREATE OR REPLACE FUNCTION acknowledgments_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'acknowledgments are append-only (ticket #223): % refused — the row is what a rep agreed to and when, and nothing about it is learned afterwards (spec #214 decision 6)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS acknowledgments_no_update ON acknowledgments;
CREATE TRIGGER acknowledgments_no_update
    BEFORE UPDATE ON acknowledgments
    FOR EACH ROW EXECUTE FUNCTION acknowledgments_append_only();
DROP TRIGGER IF EXISTS acknowledgments_no_delete ON acknowledgments;
CREATE TRIGGER acknowledgments_no_delete
    BEFORE DELETE ON acknowledgments
    FOR EACH ROW EXECUTE FUNCTION acknowledgments_append_only();
DROP TRIGGER IF EXISTS acknowledgments_no_truncate ON acknowledgments;
CREATE TRIGGER acknowledgments_no_truncate
    BEFORE TRUNCATE ON acknowledgments
    FOR EACH STATEMENT EXECUTE FUNCTION acknowledgments_append_only();

-- ── The seat's onboarding stamp ───────────────────────────────────────────
--
-- THE ONE SOFT FACT LINK DAY'S ORDER RESTS ON (FR-23; spec #214 decision 9).
--
-- Every other step is decided by a DURABLE FACT somewhere else: the address is
-- `seats.email`, the two acknowledgments are rows, the link is the rail seam's
-- latest row. Leaving scoping is the one step that records nothing anywhere
-- else — «Seguir sin marcar nada» is allowed at zero (Diego's reaction), so
-- there may be no allowlist row to read and no request to find — and without a
-- stamp the rep would be sent back to the scoping page for ever.
--
-- ON THE SEAT AND NOT ON THE SESSION, because it is a fact about the REP and
-- not about a device: a rep who finished link day on their phone and then logs
-- in on a laptop is not on link day again.
--
-- IT IS ALSO THE NAV'S SWITCH. While it is NULL every other route redirects
-- into onboarding and the pages render without the nav; once it is set the
-- `/primer-dia/…` paths redirect to their Conexiones twins. One column, read
-- fresh on every request.
ALTER TABLE seats ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

COMMENT ON COLUMN seats.onboarded_at IS
    'When the rep left link day''s scoping step — the one onboarding fact no other store records, since «Seguir sin marcar nada» is allowed at zero. NULL means the dashboard renders in the onboarding shell with no nav and every other route redirects into it (ticket #223; FR-23).';

-- ── A dashboard act may now name a CHAT instead of a card ─────────────────
--
-- THE TWO SCOPE SWITCHES ARE DASHBOARD ACTS IN EVERY SENSE #224'S FOUR ARE —
-- a rep decision, recorded as class-2 evidence (ADR-0003), run as an execution
-- (ADR-0014 as amended), answered in the same four words — and they are the
-- first two whose target is not a post. `post_id` was NOT NULL because every
-- act #224 built was performed on a CARD; a switch is performed on a row of
-- the chat directory, and there is no post anywhere in it.
--
-- WIDENED RATHER THAN GIVEN A TABLE OF ITS OWN, and the choice is worth
-- arguing because both were available. A second table would mean a second
-- evidence column on everything a scope act can authorize, a second row shape
-- for `audit-coverage.ts` to enumerate, and a second place the API's fences
-- have to be re-stated — for a row that differs from this one in exactly one
-- column. `dashboard_acts` is «one row per rep act performed on the dashboard»
-- and that is what a switch is; what a widening costs is the two CHECKs below,
-- which say out loud what each verb carries.
--
-- IDEMPOTENT: `DROP NOT NULL` on a column that already allows null is a no-op,
-- and every constraint is dropped `IF EXISTS` before it is re-added.
ALTER TABLE dashboard_acts ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE dashboard_acts
    ADD COLUMN IF NOT EXISTS chat_directory_id uuid
        REFERENCES chat_directory (id);

COMMENT ON COLUMN dashboard_acts.post_id IS
    'The card the rep acted on, for an act performed on one. NULL on a scope switch, whose target is a chat directory row instead — `dashboard_acts_one_target_check` and `dashboard_acts_target_by_verb_check` are what make exactly one of the two present, and the right one for the verb (ticket #223).';
COMMENT ON COLUMN dashboard_acts.chat_directory_id IS
    'The chat directory row whose switch the rep flipped, for a scope act. The ROW and not the chat''s JID: the row is what the scoping page listed and what the form carried, so no page and no request ever holds a customer''s number (ADR-0004; ticket #223).';

ALTER TABLE dashboard_acts DROP CONSTRAINT IF EXISTS dashboard_acts_verb_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_verb_check
        CHECK (verb IN ('dismiss_draft', 'retract_line',
                        'confirm_binding', 'decline_binding',
                        'scope_in', 'scope_out'));

-- EXACTLY ONE TARGET, NEVER BOTH AND NEVER NEITHER. `num_nulls` is the shape
-- `chat_directory_anchor_whole_check` already uses one table over; the
-- alternative — two `IS NULL` clauses joined by `<>` — says the same thing and
-- reads worse.
ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_one_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_one_target_check
        CHECK (num_nulls(post_id, chat_directory_id) = 1);

-- ...AND THE RIGHT ONE FOR THE VERB. Read with PostgreSQL's own precedence —
-- `IN` binds tighter than `=` — this is «(the verb is one of the two scope
-- verbs) equals (this row names a directory row)», so a scope act carrying a
-- post and a post act carrying a directory row are both refused. Written in
-- this order, with the verb list first, because
-- `migration-vocabulary.test.ts`' parser reads `CONSTRAINT <name> CHECK (…
-- IN (…))` and needs no parenthesis between the two — which is what puts this
-- list under the sweep that compares it with `DASHBOARD_ACT_TARGET_OF_ROUTE`
-- in `@dito/seam`.
ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_target_by_verb_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_target_by_verb_check
        CHECK (verb IN ('scope_in', 'scope_out')
               = (chat_directory_id IS NOT NULL));

-- THE IMMUTABILITY TRIGGER LEARNS ABOUT THE SECOND TARGET, and the change is
-- not only the new column: every comparison becomes `IS DISTINCT FROM`.
-- `NEW.post_id <> OLD.post_id` is NULL when both are null and NULL when one
-- is — and `IF NULL THEN` does not fire — so on a scope act's row, whose
-- `post_id` is NULL, the old function would have let an UPDATE set a post
-- without raising. A guard that goes quiet on exactly the rows the widening
-- adds is worse than no guard, because the table still claims to be immutable.
CREATE OR REPLACE FUNCTION dashboard_acts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'dashboard_acts are immutable (ticket #224): % refused — an act row is class-2 rep-act evidence (ADR-0003)', TG_OP;
    END IF;
    IF OLD.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % is already stamped (ticket #224) — the outcome is what the rep was told, and a second stamp would rewrite it', OLD.id;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
       OR NEW.twin_id IS DISTINCT FROM OLD.twin_id
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR NEW.chat_directory_id IS DISTINCT FROM OLD.chat_directory_id
       OR NEW.verb IS DISTINCT FROM OLD.verb
       OR NEW.acted_at IS DISTINCT FROM OLD.acted_at THEN
        RAISE EXCEPTION 'dashboard_acts hold one permitted UPDATE (tickets #224, #223): the outcome stamp. Row % tried to change what the act WAS', OLD.id;
    END IF;
    IF NEW.outcome IS NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % cannot be un-stamped (ticket #224) — the entries and rows it authorized name it already', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

-- ── Row-level security on the two new stores ──────────────────────────────
--
-- ADR-0002: "every shared table carries `company_id` under Postgres RLS".
-- Both are born under it, ENABLED and FORCED, and FORCED for
-- …20260902100040's reason: an unforced policy stops applying to the table's
-- own owner, and "the schema owner is a superuser so it never applied anyway"
-- is true today and is exactly the assumption that will be quietly false the
-- first time a deployment stops running migrations as one.
--
-- `FOR ALL` ON BOTH, and on `seats` below, because the AUDIT PINS ONE COMMAND
-- PER RELATION (`REP_WEB_COMPANY_POLICIES`, and `auditRepWebPolicies` compares
-- `polcmd` against it). rep-web reads AND writes all three — it consumes an
-- invitation, appends an acknowledgment, and writes the address and the
-- onboarding stamp — so a `FOR SELECT` policy would leave the write with no
-- `WITH CHECK` and PostgreSQL refuses a write no policy permits. Two policies
-- per relation, one per command, would make the pin ambiguous: the audit would
-- read the first as a mismatch. What stops rep-web INSERTing an invitation or
-- deleting an acknowledgment is therefore the GRANT, which is the same fence
-- `sessions` uses to withhold DELETE — and the grants are pinned in code and
-- diffed against the catalog in both directions.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    CREATE POLICY invitations_rep_web ON invitations
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY invitations_rep_web ON invitations IS
    'Ticket #223: rep-web reads and consumes the invitations of the company its connection declared, and of no other — a missing declaration is NULL, so it reads nothing and can change nothing. It holds no INSERT: an invitation is issued by an operator.';

ALTER TABLE acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE acknowledgments FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    CREATE POLICY acknowledgments_rep_web ON acknowledgments
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY acknowledgments_rep_web ON acknowledgments IS
    'Ticket #223: rep-web reads and appends the acknowledgments of the company its connection declared, and of no other. UPDATE and DELETE are refused by the grant and by the trigger.';

-- ...AND THE SEAT REGISTRY, whose policy widens from SELECT to ALL because
-- rep-web now WRITES two of its columns. …20260907100040's own comment said
-- what changed this: "SELECT only — the acts that move a seat between FR-63's
-- states are #223's". The STATE is still not rep-web's to write — the runtime
-- moves a seat to `linked` when the rail does, and the grant below is two
-- columns — but the address and the onboarding stamp are, so the policy has to
-- permit an UPDATE at all.
DROP POLICY IF EXISTS seats_rep_web_read ON seats;
DO $$
BEGIN
    CREATE POLICY seats_rep_web ON seats
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY seats_rep_web ON seats IS
    'Ticket #223: rep-web reads the seats of the company its connection declared and writes two of their columns — `email`, which the rep types when the invitation was forwarded, and `onboarded_at`, which link day''s last step stamps. The column-level GRANT is what withholds every other column, `state` included (spec #214 *Roles and grants*).';

-- ── The grants, in full ───────────────────────────────────────────────────
--
-- WHAT rep-web MAY REACH is pinned in `@dito/aperture`'s `REP_WEB_REACH` and
-- `REP_WEB_COLUMN_REACH`, and diffed against this catalog in both directions
-- by FR-71a's rep-web clause: a privilege here that nobody pinned is a
-- violation, and a pinned privilege this file forgot is a violation too. This
-- block and those constants are one statement written twice, and neither can
-- move alone.

-- The invitation: rep-web CONSUMES and never issues. SELECT to find the row by
-- digest, UPDATE to stamp `used_at` and the session it opened — and no INSERT,
-- because an invitation is a decision an operator makes about a seat and a
-- login surface that could mint one could invite itself. No DELETE, for
-- `sessions`' reason: the record that an invitation was spent is the record.
GRANT SELECT, UPDATE ON invitations TO dito_rep_web;
REVOKE INSERT, DELETE, TRUNCATE ON invitations FROM dito_rep_web;

-- The acknowledgment: INSERT and SELECT and nothing else. It INSERTS one row
-- per document the rep accepts and SELECTS them to decide which onboarding
-- step is next; UPDATE and DELETE are refused here as well as by the trigger,
-- because a consent record a login can rewrite is not a consent record.
GRANT SELECT, INSERT ON acknowledgments TO dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON acknowledgments FROM dito_rep_web;

-- ...AND THE SEAT'S TWO WRITABLE COLUMNS, column by column.
--
-- `email` IS AN ACCOUNT FACT IN THE CLEAR THAT THE WALL DOES NOT GUARD, and
-- the standing `sessions` already has (#221 decision 5): it is not the rep's
-- conversation, no key protects it, and the login rests on it. The email step
-- must work with the runtime DOWN — a rep whose invitation was forwarded has
-- no address on file and cannot come back without giving one — so routing it
-- through the lease holder's API would make the one step that precedes linking
-- depend on a process link day has not started yet.
--
-- `onboarded_at` is the stamp link day's last step writes (see its comment).
--
-- AND NOT `state`. A seat's state is written by the LEASE HOLDER, from the
-- rail's own row, so there is no path from a page to it: a dashboard that
-- could write `linked` could claim a number was linked that never was.
GRANT UPDATE (email, onboarded_at) ON seats TO dito_rep_web;
REVOKE INSERT, DELETE, TRUNCATE ON seats FROM dito_rep_web;

-- ...AND THE ALLOWLIST'S TWO METADATA COLUMNS, which is what makes Inicio's
-- fill card render with the runtime STOPPED (ticket #224 built the card;
-- spec #214 story 8 is why it reads the seam). The card names the date the
-- fill has reached across the chats the rep scoped, and the two halves of that
-- are `chat_directory`'s plaintext fill columns — already granted
-- (…20260908100050) — and which chats are in scope, which is this. Two
-- columns: the twin the read is scoped by and the chat it joins on.
-- `created_at` is withheld because nothing renders when a chat was scoped.
GRANT SELECT (twin_id, chat_jid) ON scope_allowlist TO dito_rep_web;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON scope_allowlist FROM dito_rep_web;

-- ── AND NOTHING ELSE, SAID OUT LOUD ───────────────────────────────────────
--
-- …20260829100012 granted the two twin-side roles across `ALL TABLES IN SCHEMA
-- public` at a point in time and its own header states the rule this rests on:
-- a store added later is granted on purpose. `invitations` and
-- `acknowledgments` were created in THIS file, so they start from nothing —
-- and nothing twin-side has any business in either. The invitation is a login
-- credential and the acknowledgment is a consent record; neither is content,
-- neither is sealed, and the lease holder serves neither.
--
-- The REVOKEs are a statement rather than a change — nothing above granted any
-- of this — and they are here so the GRANT DIFF says so too, and so a later
-- migration handing one of these roles a login store is visible in FR-71a's
-- own diff rather than discovered from a page (…20260904100020's argument).
REVOKE ALL ON invitations FROM dito_twin_runtime, dito_aperture;
REVOKE ALL ON acknowledgments FROM dito_twin_runtime, dito_aperture;

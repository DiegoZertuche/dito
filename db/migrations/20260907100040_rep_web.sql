-- rep-web's credential, its two stores, and FR-63's three seat states
-- (ticket #221; spec #214 decisions 4 and 5, *Roles and grants*, *Link day,
-- in detail*; ADR-0002, ADR-0006, ADR-0010, ADR-0022, ADR-0032).
--
-- NUMBERING: …20260907100040, after …100030 (the post primitive, #220) and
-- …100020 (the seat's email, #219). Forward-only: no migration in this repo
-- is ever edited once it has applied anywhere, because a migration is a
-- statement about what a database has already been through.
--
-- ═══ WHAT ARRIVES HERE ═══
--
--   1. `seats.state` takes FR-63's three words, and today's one is renamed.
--   2. `dito_rep_web`, the SECOND application role anything connects as.
--   3. `sessions` — one long-lived per-device session, opaque id hashed.
--   4. `login_codes` — the record of every six-digit code that was asked
--      for, the code itself held only as a digest.
--   5. The grants and the row-level policies that make 2 mean something,
--      pinned in `@dito/aperture`'s `grants.ts` and diffed in both
--      directions by FR-71a's rep-web clause.
--
-- ═══ WHY THE SEAT'S STATES CHANGE ═══
--
-- …20260902100010 wrote `CHECK (state IN ('active'))` and argued for the one
-- value: ADR-0027's lifecycle names four states, no executor could reach the
-- other three, and "a CHECK naming states nothing can write would read as a
-- lifecycle that exists". rep-web is the surface that reaches them (spec
-- #214: "the seat gains an optional email and the FR-63 states invited /
-- linked / retired"), so the CHECK widens here and the word `active` goes.
--
-- RENAMED RATHER THAN KEPT BESIDE THE THREE. `active` and `linked` are the
-- same statement about the same rig — a seat whose number the plane holds a
-- session for — so keeping both would leave two words for one state and
-- nothing to decide between them.
--
-- THE ORDER IS DROP, UPDATE, ADD, and getting it wrong is not a style
-- question: the standing CHECK is `state = 'active'`, so an UPDATE that ran
-- before the drop would be refused by the constraint it is here to replace —
-- on the rig, over the one row that matters, with the whole migration rolled
-- back. Proven by replaying this file over a planted `active` seat (ticket
-- #221). The three statements are one transaction (Atlas applies a file in
-- one), so the window in which `seats` has no state constraint is not
-- observable.
--
-- IDEMPOTENT OVER EXISTING ROWS, AND OVER ITSELF. The rig has `seats` rows in
-- state `active`; this file must survive being applied over them and applied
-- twice. The UPDATE is scoped to the old word, so a second run touches
-- nothing; the constraint is dropped `IF EXISTS` and re-added, so a second
-- run re-states it. `NOT VALID` is deliberately NOT used, unlike
-- …20260907100010's: there is nothing to grandfather — every row is rewritten
-- one statement earlier, in the same transaction — and a validated constraint
-- is the stronger claim.
--
-- EVERY OTHER STATEMENT IN THIS FILE IS RE-RUNNABLE TOO — `IF NOT EXISTS` on
-- what can take it, a duplicate-object handler on the constraints and
-- policies that cannot. Atlas never re-applies a file, so what this is for is
-- an OPERATOR replaying it by hand against a database whose revision history
-- says nothing: the upgrade rehearsal #218 and #220 ran, and the one that
-- established the ordering above. A grant, a REVOKE, a COMMENT and `ENABLE
-- ROW LEVEL SECURITY` are idempotent as written.

ALTER TABLE seats DROP CONSTRAINT IF EXISTS seats_state_check;

UPDATE seats SET state = 'linked' WHERE state = 'active';

ALTER TABLE seats
    ADD CONSTRAINT seats_state_check
        CHECK (state IN ('invited', 'linked', 'retired'));

COMMENT ON COLUMN seats.state IS
    'FR-63''s three states: invited (the invitation is out, the number is not linked) · linked (the plane holds a session for it) · retired (the twin is erased and the seat persists for attribution — ADR-0004 as amended, ADR-0009). The vocabulary is `@dito/seam`''s `SEAT_STATES` and this column''s CHECK is its other half (ticket #221).';

-- THE COMPOSITE KEY A SEAT-SCOPED ROW POINTS AT (…20260907100030's shape, for
-- the same reason). Both stores below carry the company as well as the seat,
-- because their row-level policy compares the COMPANY — so without this a
-- session row could name one company's seat while carrying another company's
-- id, satisfy every constraint, and be readable by the wrong deployment.
-- Refused in the store, not promised in a comment.
-- ONE SEAT PER ADDRESS INSIDE A COMPANY, AND THE LOGIN RESTS ON IT. The
-- login form has no company in it — rep-web knows which company it serves
-- (spec #214: "the company id in the environment") — so the lookup is
-- `WHERE lower(email) = …` under the company policy, and two seats sharing an
-- address would make "which rep asked for this code" a question with two
-- answers. `lower()` because the store's lookup folds case: «Mauricio@…» and
-- «mauricio@…» are one person, and a rep told to check their spelling over a
-- capital letter is a rep who cannot log in.
--
-- PARTIAL, because a seat exists before anybody has an address for it
-- (…20260907100020) and NULLs are not each other's duplicates in Postgres
-- anyway — the predicate says so rather than relying on that.
CREATE UNIQUE INDEX IF NOT EXISTS seats_company_email_key
    ON seats (company_id, lower(email))
    WHERE email IS NOT NULL;

DO $$
BEGIN
    ALTER TABLE seats ADD CONSTRAINT seats_id_company_key UNIQUE (id, company_id);
-- A UNIQUE constraint builds an index, so a repeat raises `duplicate_table`
-- rather than `duplicate_object`. DROP IF EXISTS + ADD is NOT the shape here:
-- on the second run the two stores below already reference this key, and
-- dropping a constraint two foreign keys depend on fails outright.
EXCEPTION WHEN duplicate_table THEN
    NULL;
END;
$$;

-- ── The second application role ───────────────────────────────────────────
--
-- `dito_owner` was the first process in this repo to authenticate as an
-- application role (…20260902100020). rep-web is the second, and everything
-- that migration argued applies here word for word: no password in a
-- checksummed artifact, idempotent creation because roles are cluster-global,
-- and the attributes asserted rather than assumed so that FR-71a measures
-- something.
--
-- NO PASSWORD. The rig's is set by `rig-seed-rep-web.ts` out of `.env.rig`; a
-- test database's by the suite that opens a second connection
-- (`borrowOwnerPassword`, which takes the role by name). A role with LOGIN and
-- no password authenticates nothing, which is the right default.
--
-- NOBYPASSRLS IS NOT DECORATION, for exactly …100020's reason: this role's
-- reach into `seats` and into its own two stores is row-level security keyed
-- to the company its connection declares, and a role with BYPASSRLS reads
-- every company through the same grants with nothing in the diff to show it.
DO $$
BEGIN
    CREATE ROLE dito_rep_web;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;

-- The attribute list is `dito_owner`'s, word for word, and deliberately so:
-- two application roles differing in one attribute is a difference somebody
-- has to explain, and the audit's own claim — zero role memberships, in both
-- directions — is stronger than NOINHERIT would be.
ALTER ROLE dito_rep_web
    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;

-- ── The session ───────────────────────────────────────────────────────────
--
-- ONE ROW PER DEVICE, LONG-LIVED (spec #214 decision 4: "sessions are
-- long-lived per device; «Cerrar sesiones» ends them all"; user story 6: "I
-- want the session on each device to last months").
--
-- WHAT THE ROW HOLDS IS THE SEAT AND THE INSTANTS, AND NOTHING THAT
-- IDENTIFIES A PERSON BEYOND IT — no address, no user agent, no IP. The
-- prototype's Ajustes drew a device list («iPhone · Safari · desde hoy
-- 9:20»); building it would mean storing what a rep's browser says about
-- them in the one table whose whole content is "somebody is logged in", and
-- ADR-0019's flow 4 keeps far less than that out of a store. So Ajustes
-- renders the email row and the close, and the device list is not built
-- (recorded on #221).
--
-- THE COOKIE'S VALUE IS NEVER HERE. `token_sha256` is the digest of an
-- opaque 32-byte id the browser holds, so a read of this table recovers no
-- session — the same shape `login_codes` uses one section down, and the
-- reason neither store is a credential at rest. UNIQUE because the digest is
-- the lookup key: two rows sharing one would make "which session is this"
-- ambiguous at exactly the moment it decides who the reader is.
--
-- ENDED, NEVER DELETED. `ended_at` is what «Cerrar sesiones» writes, and a
-- closed session stays as the record that it was open — the annotate-never-
-- erase shape the whole rep side is written in (FR-33). Nothing holds DELETE.
CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    -- sha-256 of the opaque id in the cookie. 32 bytes, checked, so a
    -- truncated or a differently-hashed value cannot be stored at all.
    token_sha256 bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- Moved forward on each request the session serves, so an operator can
    -- see a session that is open and unused. Not a person and not a place.
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- MONTHS, NOT FOREVER. The constant is rep-web's (`SESSION_LIFETIME_DAYS`)
    -- and it is passed in rather than defaulted here, so the store never
    -- disagrees with the code about how long a login lasts.
    expires_at timestamptz NOT NULL,
    ended_at timestamptz,
    CONSTRAINT sessions_token_sha256_length_check
        CHECK (length(token_sha256) = 32),
    CONSTRAINT sessions_token_unique UNIQUE (token_sha256),
    CONSTRAINT sessions_expires_after_created_check
        CHECK (expires_at > created_at),
    CONSTRAINT sessions_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id)
);

COMMENT ON TABLE sessions IS
    'Ticket #221: one long-lived per-device session — the seat, the company, the digest of the opaque id the browser holds, three instants and the instant «Cerrar sesiones» ended it. No address, no user agent, no IP: nothing that identifies a person beyond the seat (spec #214 decision 4).';
COMMENT ON COLUMN sessions.token_sha256 IS
    'sha-256 of the opaque session id in the cookie, never the id — a read of this table recovers no session (ticket #221).';
COMMENT ON COLUMN sessions.ended_at IS
    'When «Cerrar sesiones» closed it. A closed session stays as the record that it was open; nothing deletes a row here (ticket #221).';

-- Every open session of one seat, which is what «Cerrar sesiones» writes over
-- and what a read authenticates through.
CREATE INDEX IF NOT EXISTS sessions_seat_open_idx
    ON sessions (seat_id, created_at DESC)
    WHERE ended_at IS NULL;

-- ── The login code ────────────────────────────────────────────────────────
--
-- ONE ROW PER ASK (spec #214 decision 4: "email → six-digit single-use code,
-- ten-minute expiry, bound to the attempt that requested it, rate-limited").
--
-- THE CODE IS A DIGEST, exactly as the session's id is. Six digits is a
-- credential that reaches a rep's inbox, and a store that held it in the
-- clear would be a store whose reader can log in as anybody who asked for
-- one. `code_sha256` is what is compared, and the comparison is timing-safe
-- in rep-web.
--
-- BOUND TO THE ATTEMPT, AND THE ATTEMPT IS NOT THE SEAT. An attempt is one
-- device asking once: rep-web mints a uuid, the device holds it in a cookie,
-- and the email's same-device link carries it in its path so the link is a
-- second door to the same row. The verification looks a code up BY ATTEMPT,
-- so a code from another device's attempt is not found — which is what "a
-- code presented under another attempt is refused" means in a store.
--
-- APPEND-ONLY, AND THE NEWEST ROW OF AN ATTEMPT IS THE LIVE ONE. «Mandar otro
-- código» writes a second row rather than rewriting the first, so this table
-- is also the record the rate limit counts — and the older code stops working
-- because the verification reads one row, the newest, and never a set.
--
-- `guesses` IS THE BRUTE-FORCE FENCE, and it is not belt-and-braces: six
-- digits is a million values, and a credential with a ten-minute life and no
-- cap on attempts is one an attacker walks through at HTTP speed. The cap is
-- rep-web's `MAX_CODE_GUESSES`; the column is what makes it survive a
-- restart and a second app process.
--
-- NO ADDRESS, EVER. An email that names no seat writes NOTHING here (#221's
-- recorded decision): `seat_id` is a foreign key, so a row for an unknown
-- address would need either a seat that is nobody or a column holding the
-- address — and an address in a second table is exactly what ADR-0019's
-- flow 4 and ADR-0022 keep out. The screen an unknown address gets is the
-- screen a known one gets, so nothing is learned from the difference.
CREATE TABLE IF NOT EXISTS login_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    -- The device's own attempt. Not unique: a resend is a new row under the
    -- same attempt, and the newest is the live one (see the header).
    attempt_id uuid NOT NULL,
    code_sha256 bytea NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- Ten minutes, as spec #214 decision 4 says. The number is rep-web's
    -- `CODE_LIFETIME_MINUTES` — the same constant the email's «vence en {N}
    -- minutos» slot is filled from — so the store, the code and the sentence
    -- a rep reads cannot disagree.
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    guesses integer NOT NULL DEFAULT 0,
    CONSTRAINT login_codes_code_sha256_length_check
        CHECK (length(code_sha256) = 32),
    CONSTRAINT login_codes_guesses_check CHECK (guesses >= 0),
    CONSTRAINT login_codes_expires_after_requested_check
        CHECK (expires_at > requested_at),
    CONSTRAINT login_codes_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id)
);

COMMENT ON TABLE login_codes IS
    'Ticket #221: one row per six-digit login code that was asked for — the seat, the company, the device''s attempt, the code''s sha-256, the ten-minute expiry, whether it was used and how many wrong guesses it took. Never the code, never an address (spec #214 decision 4).';
COMMENT ON COLUMN login_codes.attempt_id IS
    'The device''s own attempt, minted by rep-web and held in a cookie; the email''s same-device link carries it in its path. A code is looked up BY attempt, so one presented under another attempt is not found (ticket #221).';
COMMENT ON COLUMN login_codes.guesses IS
    'Wrong guesses against this code. Six digits with no cap is a credential an attacker walks through in minutes, so rep-web burns the row at `MAX_CODE_GUESSES` (ticket #221).';

-- The verification's own read: the newest code of one attempt.
CREATE INDEX IF NOT EXISTS login_codes_attempt_idx
    ON login_codes (attempt_id, requested_at DESC);
-- ...and the rate limit's, which counts one seat's asks inside a window.
CREATE INDEX IF NOT EXISTS login_codes_seat_idx
    ON login_codes (seat_id, requested_at DESC);

-- ── Row-level security on the two new stores ──────────────────────────────
--
-- ADR-0002: "every shared table carries `company_id` under Postgres RLS".
-- These two are born under it, so there is no window in which they were not:
-- ENABLED and FORCED, and one policy for the one role that reads them.
--
-- FORCED as well as ENABLED, for …20260902100040's reason: an unforced policy
-- stops applying to the table's own owner, and "the schema owner is a
-- superuser so it never applied anyway" is true today and is exactly the
-- assumption that will be quietly false the first time a deployment stops
-- running migrations as one.
--
-- ONE POLICY, `FOR ALL`, because rep-web reads AND writes its own stores:
-- a SELECT-only policy would leave the INSERT with no `WITH CHECK` and
-- Postgres refuses an INSERT no policy permits — so a login would fail on a
-- policy rather than on anything about the login. The qualifier is the one
-- pinned expression `ledger.declared_company()`, so FR-71a can diff it
-- against a string rather than against a fragment of SQL text nobody can
-- read (…20260902100040 argues why the function exists at all).
--
-- NOBODY ELSE GETS A POLICY, which is a deny-all for every non-superuser
-- that is not rep-web. That is the correct state: the twin runtime has no
-- business in a login, the aperture has none, and the owner is on the far
-- side of the wall from both.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    CREATE POLICY sessions_rep_web ON sessions
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY sessions_rep_web ON sessions IS
    'Ticket #221: rep-web reads and writes the sessions of the company its connection declared, and of no other — a missing declaration is NULL, so it reads nothing and can write nothing.';

ALTER TABLE login_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_codes FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    CREATE POLICY login_codes_rep_web ON login_codes
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY login_codes_rep_web ON login_codes IS
    'Ticket #221: rep-web reads and writes the login codes of the company its connection declared, and of no other.';

-- ...AND THE SEAT REGISTRY, which already carries RLS for the owner's views
-- (…20260902100040) and now needs a second policy for a second reader.
-- SELECT ONLY: rep-web reads a seat to resolve an email to it and to render
-- the email row on Ajustes, and it writes no seat at all — the invitation and
-- the link that move a seat between states are #223's.
DO $$
BEGIN
    CREATE POLICY seats_rep_web_read ON seats
        FOR SELECT TO dito_rep_web
        USING (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY seats_rep_web_read ON seats IS
    'Ticket #221: rep-web reads the seats of the company its connection declared, and of no other. SELECT only — the acts that move a seat between FR-63''s states are #223''s.';

-- ── The grants, in full ───────────────────────────────────────────────────
--
-- WHAT rep-web MAY REACH is pinned in `@dito/aperture`'s `REP_WEB_REACH` and
-- diffed against this catalog in both directions by FR-71a's rep-web clause:
-- a privilege here that nobody pinned is a violation, and a pinned privilege
-- this file forgot is a violation too. So this block and that constant are
-- one statement written twice on purpose, and neither can move alone.
--
-- USAGE ON `ledger`, AND EXACTLY ONE FUNCTION IN IT. A policy expression's
-- function privileges are checked against the SESSION's role, so a connection
-- without EXECUTE on `ledger.declared_company()` fails on `permission denied
-- for function` instead of reading its own company's rows — the same grant
-- …20260902100040 had to make to `dito_twin_runtime` for the same reason.
-- USAGE lets a role NAME an object in a schema and grants no privilege on any
-- object in it, so every `ledger` table and both finalized views stay a
-- privilege error. The clause asserts that: rep-web holds nothing on any
-- `ledger` relation, and exactly one `ledger` function.
GRANT USAGE ON SCHEMA public TO dito_rep_web;
GRANT USAGE ON SCHEMA ledger TO dito_rep_web;
GRANT EXECUTE ON FUNCTION ledger.declared_company() TO dito_rep_web;

-- Its own two stores. SELECT, INSERT and UPDATE — a code is consumed and its
-- guesses counted, a session's last-seen moves and «Cerrar sesiones» writes
-- `ended_at` — and NO DELETE, for the reason `ended_at` exists: a login that
-- can erase its own record is a login whose record proves nothing.
GRANT SELECT, INSERT, UPDATE ON sessions TO dito_rep_web;
GRANT SELECT, INSERT, UPDATE ON login_codes TO dito_rep_web;

-- The seat registry, under the policy above.
GRANT SELECT ON seats TO dito_rep_web;

-- The rail's own status rows, which is what Conexiones renders (spec #214
-- *Roles and grants*: "SELECT on rail status").
--
-- COLUMN BY COLUMN, AND `detail` IS NOT ONE OF THEM. The table is plane status
-- metadata and never rep content (…20260827100007 states that in full) — but
-- `detail` is not empty on every row: on a `qr` row it carries the raw pairing
-- code the plane generated, which is a LIVE CREDENTIAL for linking a WhatsApp
-- account. This table has no `company_id` and no row-level security, so a
-- table-wide SELECT would hand one login role every twin in the fleet's
-- pairing tokens, and a link-hijack needs nothing else. Nothing in 6a renders
-- one: the inline re-link needs the link ask, which is #223's. So the grant is
-- the four columns Conexiones reads and `detail` is unreachable — for its own
-- twin as much as for anybody's.
--
-- `id` IS AMONG THEM because it is the ORDER. Consumers read a twin's
-- transitions in emission order (…20260827100007's own index), and two
-- transitions of one reconnect can share a wall-clock instant.
--
-- WHAT IS LEFT IS RECORDED RATHER THAN CLOSED: with no company on the row,
-- these four columns are readable for any twin id rep-web can name, and what
-- bounds that is that the only twin id it can learn comes off a seat its
-- company policy let it read. Rep-side row-level security is the debt
-- …20260902100040 records in its own header, and #221 leaves it where it
-- found it.
GRANT SELECT (id, twin_id, status, occurred_at) ON rail_status_events
    TO dito_rep_web;

-- ...AND THE SEND RECORD notify WRITES AS rep-web. The login code goes out
-- through `@dito/notify`, which opens its own session on rep-web's pool and
-- writes one content-free `notify_sends` row before the send and settles it
-- after (…20260907100020 argues the shape). …100020 deliberately granted
-- nobody anything on that table, saying "the process that will call it in
-- production is rep-web, whose role does not exist yet (#221 creates it with
-- its own migration and its own clause in the grants check)". This is that
-- grant. No DELETE: the record of a message that has left is not erasable.
GRANT SELECT, INSERT, UPDATE ON notify_sends TO dito_rep_web;

-- ── ADR-0006's SECOND MINTER, granted before its caller ───────────────────
--
-- Spec #214 decision 5: "the send tap does not [go through the API] — rep-web
-- mints the tap and the send command in one transaction under its own role,
-- ADR-0006's second non-model path". The Enviar button that uses it is #224's;
-- the GRANT is here, and that is a deliberate choice rather than a leak.
--
-- WHY NOW AND NOT WITH ITS CALLER. FR-71a's rep-web clause is a diff in BOTH
-- directions over a pinned list. A role whose grants arrive one ticket at a
-- time cannot be audited as a whole: #224 would have to both grant and re-pin,
-- which is two tickets re-cutting one list from two ancestors — the exact
-- drift `migration-vocabulary.test.ts` exists to catch, one artifact over. So
-- the role's whole reach lands once, is pinned once, and is proven red once
-- against a planted grant on a sealed column and on a key table.
--
-- WHAT THE GRANT CANNOT DO ON ITS OWN. `taps_minter_check` still names one
-- minter, `affirmation_matcher` (…20260826100003, whose own comment says
-- rep-web "joins this CHECK via migration when its surface ships"), so an
-- INSERT from rep-web is refused by the store until #224 widens it with the
-- path that writes it. A word in a closed set that nothing writes would read
-- as a minter that exists. And `send_commands`' own CHECK refuses a
-- `customer_send` with no tap, so neither privilege is a send on its own.
GRANT INSERT ON taps TO dito_rep_web;
GRANT INSERT ON send_commands TO dito_rep_web;

-- ...AND THE DRAFT'S PLAINTEXT COLUMNS, COLUMN BY COLUMN. A draft card's
-- state needs the draft's identity, its twin, where a tap would send it and
-- when it was composed. It does NOT need `content_enc` — the body a tap
-- releases, which the runtime opens and serves through the local API
-- (ADR-0010) — and it does not need `post_enc`, the frozen bytes the rep read
-- in their thread (ADR-0034). Those two are the sealed columns of this table,
-- and a column-level grant is the only way to say "everything but them" in a
-- way `has_table_privilege` cannot quietly widen: the clause pins this exact
-- list, so a later `GRANT SELECT (content_enc)` is a violation with a name.
GRANT SELECT (id, twin_id, destination, created_at) ON drafts TO dito_rep_web;

-- ── AND NOTHING ELSE, SAID OUT LOUD ───────────────────────────────────────
--
-- …20260829100012 granted the two rep-side roles across `ALL TABLES IN SCHEMA
-- public` at a point in time, and its own header states the rule this block
-- rests on: a store added later is granted on purpose. `dito_rep_web` was
-- created in THIS file, so it starts from nothing and holds exactly what the
-- statements above hand it.
--
-- The REVOKEs are a statement rather than a change — nothing above granted
-- any of this — and they are here so the GRANT DIFF says so too, and so a
-- later migration handing rep-web one of them is visible in FR-71a's own diff
-- rather than discovered from a page that rendered something it should not
-- have (…20260904100020's block makes exactly this argument).
--
-- `twin_keys` IS THE KEY TABLE, and rep-web holding no key is not the reason
-- it is named here: ADR-0008's custody of two says the process that may
-- unseal is the LEASE HOLDER, so the row naming a wrapped DEK is not
-- rep-web's to read at all. `wa_events`, `notices`, `posts` and
-- `disclosure_lines` are the content, and the feed reaches rep-web through
-- the runtime's local API (ADR-0010) — so rep-web reads no post ever, and
-- what it shows is the API's answer rather than a second copy of a store.
-- `audit_chain` is the rep side's own chain: nothing rep-web does in this
-- ticket is a rep act (#78's rule), and the refusal the Enviar path chains is
-- #224's to grant with the path that writes it.
REVOKE ALL ON twin_keys FROM dito_rep_web;
REVOKE ALL ON wa_events FROM dito_rep_web;
REVOKE ALL ON notices FROM dito_rep_web;
REVOKE ALL ON posts FROM dito_rep_web;
REVOKE ALL ON disclosure_lines FROM dito_rep_web;
REVOKE ALL ON audit_chain FROM dito_rep_web;
REVOKE ALL ON companies FROM dito_rep_web;

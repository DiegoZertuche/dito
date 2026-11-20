-- The browser's registration to receive the twin's knocks, and the send record
-- widened to hold them (ticket #262; spec #258 *Notification end to end* and
-- decision 7; ADR-0022 as amended, ADR-0031 as amended, ADR-0019's sixth flow,
-- ADR-0002, ADR-0013 class 4).
--
-- NUMBERING: …20260922100030, after …20260919100010 (the system chat kind) on
-- this branch. The two slots between are left to ticket #261's dashboard
-- message, which merges first: a migration's number is its ORDER, and two
-- branches cutting one number is a sum neither can apply — so the later branch
-- moves up rather than the earlier one down, because a file that has applied
-- anywhere is never renamed.
-- Forward-only: no migration in this repo is ever edited once it has applied
-- anywhere, because a migration is a statement about what a database has
-- already been through.
--
-- ═══ WHAT A PUSH SUBSCRIPTION IS, AND WHY IT IS A SECRET ═══
--
-- A browser that accepts notifications hands the page three values: an
-- ENDPOINT at the push service its vendor runs, and two keys — the browser's
-- own P-256 public key and an authentication secret — that every payload is
-- encrypted to (RFC 8291). Anybody holding all three can put a notification on
-- that device's lock screen for as long as it lives.
--
-- So the three are held like a credential and not like metadata: rep-web
-- writes and removes them under its own role and row-level policy, the twin
-- runtime reads them to deliver and removes one the push service calls gone,
-- and nothing else in this database may name the table at all. The endpoint
-- also IDENTIFIES a device and its vendor, which is exactly what …20260907100040
-- refused to keep about a session — so it is here because the transport cannot
-- work without it, and for no other reason. Nothing renders one, nothing logs
-- one, and `scripts/ledger-grants-check.mjs` is what keeps that a fact rather
-- than a habit.
--
-- ═══ IT DIES WITH THE SESSION THAT GRANTED IT ═══
--
-- `session_id` references `sessions(id)`, because the grant is the browser's
-- and the browser is the login: «Cerrar sesiones» stops a lost laptop from
-- knocking (spec #258 user story 25), and it stops it by ending the sessions —
-- so the subscriptions have to end in the same statement (`endAllSessions`).
--
-- ENDED, NEVER DELETED BY THE SESSION PATH, which is `sessions`' own rule one
-- table along: a closed session stays as the record that it was open. What
-- `ended_at` buys here beyond that is an ANSWER to «why did this device stop
-- being notified» that an absent row cannot give. DELETE exists for one
-- caller only — a rep-web replacing this browser's own registration, where the
-- old row is not a record of anything, it is the same browser's stale address.
--
-- ═══ THE SEND RECORD LEARNS WHAT AN ASK WAS ABOUT ═══
--
-- The at-once tier is fired from the runtime's pass and has to answer «has
-- this post already been announced» on every tick. `about_ref` is that memory:
-- the post the knock rides, or the rail transition a grave event reports. It is
-- CONTENT-FREE and enforced so — an id this database minted or a bigint key,
-- never text a person wrote — which is the same line `notify_sends`' own
-- provider-id column is held to.
--
-- ═══ RE-RUNNABLE, IN …20260908100060'S SHAPE ═══
--
-- Atlas never re-applies a file. What this is for is an OPERATOR replaying it
-- by hand against a database whose revision history says nothing: `IF NOT
-- EXISTS` on everything that takes it, a duplicate-object handler on the
-- constraints and policies that cannot, and every GRANT, REVOKE and COMMENT
-- idempotent as written.
--
-- AND IDEMPOTENT OVER EXISTING ROWS. The widened CHECK accepts every word a
-- standing `notify_sends` row carries — the set only grows — and the new column
-- is nullable with no default, so both ALTERs are catalog changes and every row
-- already satisfies them.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE SUBSCRIPTION
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- ADR-0002: every shared table carries `company_id` under Postgres RLS.
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    -- The login this browser granted the permission under. ON DELETE is
    -- deliberately absent: nothing deletes a session, so nothing cascades.
    session_id uuid NOT NULL REFERENCES sessions (id),
    -- The push service's own address for this browser. A URL, and the one
    -- column on the rep side that names a third party's host.
    endpoint text NOT NULL,
    -- The browser's P-256 public key and its auth secret, base64url as the
    -- Push API hands them over. Both are inputs to the payload's encryption
    -- (RFC 8291) and neither is ever rendered.
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- When it stopped being a place to deliver: the session ended, or the push
    -- service answered that this registration is gone.
    ended_at timestamptz,
    CONSTRAINT push_subscriptions_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id),
    -- AN ENDPOINT IS AN https URL, PLUS LOOPBACK http. The transport posts to
    -- whatever is in this column, so a value carrying a scheme of its own
    -- would be a request this process makes on behalf of a row somebody wrote
    -- — and `javascript:` and `data:` are exactly what the scheme allowlist
    -- exists for. Loopback `http:` is admitted for `@dito/copy`'s own reason
    -- one package over: the suite's push receiver and an operator's rig both
    -- run on the machine that is sending, and a rule that refused them would
    -- be a rule the proof had to work around. Bounded, because the column is
    -- an address and never a place for a body.
    CONSTRAINT push_subscriptions_endpoint_check
        CHECK ((endpoint LIKE 'https://%'
                OR endpoint LIKE 'http://127.0.0.1:%'
                OR endpoint LIKE 'http://localhost:%')
               AND length(endpoint) BETWEEN 12 AND 2000),
    -- THE TWO KEYS ARE base64url AND ARE THE SIZES THE STANDARD FIXES: an
    -- uncompressed P-256 point is 65 bytes (88 characters) and the auth secret
    -- is 16 (24). A column that accepted prose would be a column a sentence
    -- could be stored in.
    CONSTRAINT push_subscriptions_p256dh_check
        CHECK (p256dh ~ '^[A-Za-z0-9_-]{16,200}$'),
    CONSTRAINT push_subscriptions_auth_check
        CHECK (auth ~ '^[A-Za-z0-9_-]{16,64}$')
);

COMMENT ON TABLE push_subscriptions IS
    'Ticket #262: one browser''s registration to receive the twin''s knocks — the seat, the login session it was granted under, the push service''s endpoint and the two keys each payload is encrypted to (RFC 8291). A secret: rep-web writes and removes it, the twin runtime reads it to deliver, and nothing else in this database may name it (ADR-0022 as amended).';
COMMENT ON COLUMN push_subscriptions.endpoint IS
    'The push service''s own address for this browser. Never rendered, never logged: it identifies a device and anybody holding it with the two keys can reach that lock screen (ticket #262).';
COMMENT ON COLUMN push_subscriptions.p256dh IS
    'The browser''s P-256 public key, base64url — half of what a payload is encrypted to (RFC 8291). A secret, like the endpoint beside it (ticket #262).';
COMMENT ON COLUMN push_subscriptions.auth IS
    'The browser''s authentication secret, base64url — the other half of the payload''s encryption (RFC 8291). A secret (ticket #262).';
COMMENT ON COLUMN push_subscriptions.ended_at IS
    'When this registration stopped being a place to deliver: its session ended, or the push service answered that it is gone (ticket #262).';

-- The tier's own read: every live subscription of one seat.
CREATE INDEX IF NOT EXISTS push_subscriptions_seat_live_idx
    ON push_subscriptions (seat_id)
    WHERE ended_at IS NULL;
-- ...and the session path's, which ends every subscription a login granted.
CREATE INDEX IF NOT EXISTS push_subscriptions_session_idx
    ON push_subscriptions (session_id)
    WHERE ended_at IS NULL;

-- ── Row-level security, born under it ─────────────────────────────────────
--
-- `sessions`' own shape (…20260907100040): ENABLED and FORCED, one policy
-- `FOR ALL` for the one login role, because rep-web reads AND writes here and
-- a SELECT-only policy would leave the INSERT with no `WITH CHECK`. The
-- qualifier is the pinned expression FR-71a diffs against a string.
--
-- THE TWIN RUNTIME GETS NO POLICY AND STILL READS, which is worth saying out
-- loud: row-level security applies to a role only where a policy names it, and
-- `dito_twin_runtime` is not a member of any policy on this table — so the
-- table-level grant below is its whole reach, exactly as it is on every other
-- rep-side store it reads. Its scope is the twin it holds a lease on.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    CREATE POLICY push_subscriptions_rep_web ON push_subscriptions
        FOR ALL TO dito_rep_web
        USING (company_id = ledger.declared_company())
        WITH CHECK (company_id = ledger.declared_company());
EXCEPTION WHEN duplicate_object THEN
    NULL;
END;
$$;
COMMENT ON POLICY push_subscriptions_rep_web ON push_subscriptions IS
    'Ticket #262: rep-web reads and writes the push subscriptions of the company its connection declared, and of no other — a missing declaration is NULL, so it reads nothing and can write nothing.';

-- ── Grants, on purpose (…20260829100012's rule) ───────────────────────────
--
-- …20260829100012 granted `dito_twin_runtime` write on ALL TABLES IN SCHEMA
-- public at a point in time, and its own header states the rule: a rep-side
-- store added later must be granted on purpose. So a table created now is
-- reachable by nobody until this block says so.
--
-- rep-web WRITES AND REMOVES, AND NEVER UPDATES A KEY. `SELECT, INSERT,
-- DELETE` and `UPDATE (ended_at)`: the permission flow registers a browser and
-- replaces this browser's own stale address, «Cerrar sesiones» ends every one,
-- and there is no privilege through which an endpoint or a key could be
-- rewritten in place — a row is the registration a browser handed over, whole
-- or not at all.
GRANT SELECT, INSERT, DELETE ON push_subscriptions TO dito_rep_web;
GRANT UPDATE (ended_at) ON push_subscriptions TO dito_rep_web;

-- ...and the lease holder DELIVERS. SELECT to find the seat's live
-- registrations, and `UPDATE (ended_at)` for the one answer a push service
-- gives that means «this browser is gone»: the runtime is the process that
-- hears it, so it is the process that has to be able to write it down.
GRANT SELECT ON push_subscriptions TO dito_twin_runtime;
GRANT UPDATE (ended_at) ON push_subscriptions TO dito_twin_runtime;

-- NOTHING FOR THE APERTURE AND NOTHING FOR THE OWNER, and the REVOKEs are a
-- statement rather than a change: …20260829100012's blanket grant does not
-- reach a table created after it, so nothing is being taken away. They are
-- here so the GRANT DIFF says so too. The owner is on the far side of the wall
-- (ADR-0002, FR-71a claim 6) and a rep's devices are not on any of its three
-- views; the aperture writes the Ledger and has no business with a browser.
REVOKE ALL ON push_subscriptions FROM dito_aperture;
REVOKE ALL ON push_subscriptions FROM dito_owner;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE SEND RECORD, WIDENED
-- ═══════════════════════════════════════════════════════════════════════
--
-- DROP THEN ADD, which is the only way PostgreSQL re-cuts a CHECK, and it is
-- safe here because every standing row's word is in the new set: the vocabulary
-- GROWS and is never narrowed, which is what `migration-vocabulary.test.ts`
-- reads these constraints to hold. Atlas applies a file in one transaction, so
-- the window in which the table has no constraint is not observable.

ALTER TABLE notify_sends DROP CONSTRAINT IF EXISTS notify_sends_message_type_check;

ALTER TABLE notify_sends
    ADD CONSTRAINT notify_sends_message_type_check
    CHECK (message_type IN ('invitation', 'login_code', 'draft_ready',
                            'question_asked', 'nudge', 'rail_dropped',
                            'rail_logged_out'));

COMMENT ON COLUMN notify_sends.message_type IS
    'The closed catalog''s name for the message: invitation · login_code (email) · draft_ready · question_asked · nudge (push, carrying a post''s composed sentence) · rail_dropped · rail_logged_out (email and push, code-written). The vocabulary is `@dito/notify`''s constant and this column''s CHECK is its other half (ADR-0022 as amended).';

ALTER TABLE notify_sends DROP CONSTRAINT IF EXISTS notify_sends_reason_check;

ALTER TABLE notify_sends
    ADD CONSTRAINT notify_sends_reason_check
    CHECK (reason IS NULL OR reason IN ('no_email', 'transport_failed',
                                        'no_subscription'));

COMMENT ON COLUMN notify_sends.reason IS
    'A closed word, never a sentence: no_email (the seat has no address yet) · no_subscription (no browser of this seat has accepted notifications) · transport_failed. Present exactly when the outcome is not `sent` (ticket #219, widened by #262).';

-- ── What the ask was about ────────────────────────────────────────────────
--
-- THE SEND RECORD IS THE TIER'S MEMORY, and this column is the whole of it: a
-- knock is delivered once because the pass asks «is there a row about this
-- post», and a grave event fires once per transition because the pass asks the
-- same question about a `rail_status_events` id. Without it the tier would need
-- a store of its own for a fact this table already half holds.
--
-- CONTENT-FREE, ENFORCED. Both references this build writes are identifiers
-- this database minted — a `posts` uuid, a `rail_status_events` bigint rendered
-- as text — so the shape is bounded to exactly that and a sentence has nowhere
-- to arrive. Text rather than two typed columns because the two referents live
-- in tables with different key types and a reader never joins on this: it asks
-- «is there a row about X», with X in hand.
--
-- NOT A FOREIGN KEY, and that is the point of a single column for two
-- referents: the reference outlives what it names. A send record is the record
-- that a message left, and it must not become unwritable — or worse,
-- cascade-deletable — because the post it announced was re-expressed away.
ALTER TABLE notify_sends ADD COLUMN IF NOT EXISTS about_ref text;

ALTER TABLE notify_sends DROP CONSTRAINT IF EXISTS notify_sends_about_ref_check;

ALTER TABLE notify_sends
    ADD CONSTRAINT notify_sends_about_ref_check
    CHECK (about_ref IS NULL OR about_ref ~ '^[0-9a-f-]{1,64}$');

COMMENT ON COLUMN notify_sends.about_ref IS
    'What this ask was about, as an identifier this database minted: a `posts` id for a knock or a nudge, a `rail_status_events` id for a grave event. Content-free and never a foreign key — the record of a message that left outlives what it announced (ticket #262).';

-- The tier's own question, asked on every pass: «is there already a send about
-- this post?». Partial on the column, so a pass with nothing to announce costs
-- one index probe and the index holds nothing for the email types.
CREATE INDEX IF NOT EXISTS notify_sends_about_idx
    ON notify_sends (about_ref)
    WHERE about_ref IS NOT NULL;

-- ── ...and the runtime becomes notify's second caller ─────────────────────
--
-- …20260907100020 granted this table to nobody and said why: notify is class 4
-- of ADR-0013, and putting a send recorder inside the process that holds the
-- model would have been a privilege with no caller. 6b gives it one. The at-once
-- tier and the grave-event step both run from the lease holder's pass, they are
-- CODE and not a tool, and `dependency-wall.test.ts` is what keeps them off
-- every model surface — the runtime package declares no dependency on notify at
-- all and receives the service through its composition root.
--
-- SELECT, INSERT AND UPDATE, which is what notify does on this table: it asks
-- whether an ask about something already exists, opens a row before the send and
-- settles it after. No DELETE: a send record is never erased.
--
-- THE SEAT REGISTRY IS NOT GRANTED HERE, and that is recorded rather than
-- forgotten. Notify resolves a recipient from `seats` (ADR-0022), and a grave
-- event's email therefore reads one — but `dito_twin_runtime` holds no
-- privilege on that table AND no row-level policy on it, and the runtime
-- already writes `seats.state` on every pass with neither (…20260907100040's
-- `linkSeatWhenRailLinked`), because the lease holder authenticates as the
-- schema owner today. Granting a read without a policy would buy nothing, and
-- the policy this role would need is unrestricted — it is scoped by the twin it
-- holds a lease on and declares no company. So the registry's reach for this
-- role is ONE question, and it belongs to the ticket that makes the runtime
-- authenticate as its own role rather than to this one.
GRANT SELECT, INSERT, UPDATE ON notify_sends TO dito_twin_runtime;

-- The aperture and the owner keep nothing, exactly as …20260907100020 left them.
REVOKE ALL ON notify_sends FROM dito_aperture;
REVOKE ALL ON notify_sends FROM dito_owner;

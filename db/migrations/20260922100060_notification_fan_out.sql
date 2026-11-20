-- What became of a post's knock, and what one ask reached: the two columns the
-- notification tier needs to survive load and failure (ticket #276; spec #258
-- *Notification end to end* and decision 7; ADR-0031 as amended, ADR-0022 as
-- amended, ADR-0044 as amended, ADR-0037).
--
-- NUMBERING: …20260922100060, after …20260922100050 (the nudge, #268).
-- Forward-only: no migration in this repo is ever edited once it has applied
-- anywhere, because a migration is a statement about what a database has
-- already been through.
--
-- ONE FILE FOR THREE COLUMNS, and they are one change: the at-once tier reads
-- posts, hands notify one ask and remembers the answer, and all three of its
-- reachable failures are the same omission — the store held no answer to
-- «what became of this». Splitting them would leave a mark nothing reads
-- beside a record nothing writes.
--
-- RE-RUNNABLE. Atlas never re-applies a file; this is for an OPERATOR
-- replaying it by hand against a database whose revision history says nothing.
-- `IF NOT EXISTS` on every ADD, `DROP CONSTRAINT IF EXISTS` before each cut,
-- and every COMMENT idempotent as written.
--
-- AND IDEMPOTENT OVER EXISTING ROWS. Every column added here is nullable or
-- carries a default every standing row satisfies, so all three ALTERs are
-- catalog changes and nothing is rewritten.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. WHAT BECAME OF A POST'S KNOCK
-- ═══════════════════════════════════════════════════════════════════════
--
-- THE TIER COULD NOT TELL A KNOCK-LESS POST FROM AN UNANNOUNCED ONE, and that
-- was a rep's knock arriving four hours late (Codex on PR #274, finding 1).
-- The at-once tier reads the window's posts, takes the first twenty and only
-- THEN opens the sealed parts to see whether there is a sentence to deliver —
-- so a receipt, an answer and the day's record acquire no send record, occupy
-- the batch on every pass, and silence every knock behind them. Twenty
-- receipts on a busy afternoon is a draft the rep is never told about.
--
-- A POST NOW SAYS SO IN THE CLEAR, so the read never selects one of them at
-- all. `knock_disposition` is the tier's whole eligibility question and the
-- window's `LIMIT` cuts a batch of posts that really have something to say.
--
-- WHY IN THE CLEAR: it is a closed vocabulary about the SHAPE of a post and
-- not about its content — `question_subject` one column up is the same
-- decision, for the same reason. A surface asks «does this post announce
-- itself» without a key; the sentence itself stays sealed with the parts and
-- is read by notify's transport and by nothing else (ADR-0008).
--
-- AND `refused` IS THE TRACE A DROPPED KNOCK HAD NOT LEFT (the remainder
-- PR #274 recorded, now finding 6). A sentence the composition rules refuse —
-- past the lock screen's bound, carrying a link, carrying a line break, or
-- carrying a digit run the announced post does not — is DROPPED rather than
-- handed back to the model, because refusing the submission would cost the rep
-- the draft they are waiting on. Dropped and unrecorded, nothing said why the
-- post never pushed. This column is where it says so, on the row it is about.
--
-- WHAT IT DOES NOT HOLD IS WHICH RULE REFUSED IT. The rules are one function
-- (`acceptsKnock`), and a second vocabulary naming each of them would have to
-- be re-cut every time that function gains a clause — for a fact an operator
-- reproduces from the run's own trace. What a reader needs from this table is
-- that a sentence existed and was not carried.

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS knock_disposition text NOT NULL DEFAULT 'none';

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_knock_disposition_check;

ALTER TABLE posts
    ADD CONSTRAINT posts_knock_disposition_check
    CHECK (knock_disposition IN ('carried', 'none', 'refused'));

COMMENT ON COLUMN posts.knock_disposition IS
    'What became of the sentence this post would have been announced with (ticket #276): carried — a `knock` part is among the sealed parts · none — the execution composed none, or code wrote the post · refused — one was composed and the composition rules would not carry it (ADR-0044 as amended). The tier''s eligibility question, and the trace a dropped knock leaves.';

-- The at-once tier's own read: this twin's announceable posts inside the
-- window, oldest first. Partial on the disposition, so the index holds nothing
-- for the receipts, the answers and the day's record — which are most of the
-- table and none of the tier's business.
CREATE INDEX IF NOT EXISTS posts_twin_knock_idx
    ON posts (twin_id, posted_at, id)
    WHERE knock_disposition = 'carried';

-- A POST WRITTEN BEFORE THIS FILE CARRIES `none` AND IS NEVER ANNOUNCED, and
-- that is stated rather than worked around. The parts are sealed under the
-- twin DEK and no migration holds a key (ADR-0008), so there is no backfill to
-- write — and the cost is bounded by the window the tier already keeps: a post
-- older than four hours was never going to be announced anyway, so what this
-- loses is at most the knocks of the four hours before an operator migrates.
-- It is the same direction as a runtime that was down for longer than the
-- window, which …20260922100030 argues is the honest one: an announcement of
-- something that happened before the build came up is not an announcement.

-- ═══════════════════════════════════════════════════════════════════════
-- 2. WHAT ONE ASK REACHED
-- ═══════════════════════════════════════════════════════════════════════
--
-- ONE ROW PER ASK WAS THREE FAILURES IN ONE SHAPE (Codex on PR #274, findings
-- 3 and 4). A grave event mails AND pushes: the single row was settled by the
-- email's rejection and the push was then skipped exactly when mail was down,
-- and a later pass found the row and never tried either again. And the row was
-- opened once for a fan-out over every browser the seat has, so a crash after
-- the first device lost the second's delivery for good and a 201 beside a 500
-- collapsed into one `sent`.
--
-- SO A ROW IS NOW ONE ATTEMPT AT ONE DESTINATION. `channel` says which rail it
-- left by and `subscription_id` says which browser it was for, and together
-- they make «what is still owed about this» a question the store can answer:
-- the channel that failed is retried on the next pass, the one that succeeded
-- never is, and a fan-out interrupted by a crash resumes with the browsers it
-- never reached.

-- ── The rail one attempt left by ──────────────────────────────────────────
--
-- TWO WORDS, AND THEY ARE THE TWO TRANSPORTS ADR-0022 NAMES. `@dito/notify`'s
-- `NOTIFY_CHANNELS` is the other half of this constraint and
-- `migration-vocabulary.test.ts` compares the two, which is this table's own
-- rule for an enumerated column (…20260907100020).
--
-- NULL MEANS «ONE ROW FOR THE ASK, WHATEVER IT REACHED» — the shape every row
-- written before this file has, and the reason there is no backfill. A grave
-- event announced yesterday holds one such row, and a reader that took it for
-- neither channel would mail and push about it a second time; so the pending
-- question treats a NULL row as recorded for BOTH, which is exactly what it
-- meant when it was written.
ALTER TABLE notify_sends ADD COLUMN IF NOT EXISTS channel text;

ALTER TABLE notify_sends DROP CONSTRAINT IF EXISTS notify_sends_channel_check;

ALTER TABLE notify_sends
    ADD CONSTRAINT notify_sends_channel_check
    CHECK (channel IS NULL OR channel IN ('email', 'push'));

COMMENT ON COLUMN notify_sends.channel IS
    'Which transport this attempt left by — email · push (ADR-0022 as amended). NULL on a row written before ticket #276, when one row stood for the whole ask whatever it reached, and read as recorded for both.';

-- ── ...and the browser it was for ─────────────────────────────────────────
--
-- CONTENT-FREE AND NOT A FOREIGN KEY, which is `about_ref`'s own argument one
-- column along (…20260922100030). A uuid this database minted, shaped by a
-- CHECK so a sentence has nowhere to arrive — and never a reference the store
-- enforces, because rep-web DELETES a registration when the same browser hands
-- over a new address, and a send record must not become unwritable or, worse,
-- cascade-deletable because the device it reached was re-registered. The
-- record that a notification left outlives the row it was addressed to.
--
-- NULL WHERE THERE WAS NO ONE DEVICE: every email attempt, and a push channel
-- refused because no browser of the seat has accepted notifications.
ALTER TABLE notify_sends ADD COLUMN IF NOT EXISTS subscription_id uuid;

COMMENT ON COLUMN notify_sends.subscription_id IS
    'The push subscription this attempt was addressed to (ticket #276) — content-free, and never a foreign key: the record that a notification left outlives the registration it reached. NULL on every email attempt and on a push channel refused for want of any registration at all.';

-- The fan-out's own question, asked once per destination before it is
-- attempted: «is there already a row about this, for this browser?».
-- `notify_sends_about_idx` (…20260922100030) is the prefix; this pairs the
-- reference with the destination so the anti-join reads one index.
CREATE INDEX IF NOT EXISTS notify_sends_about_subscription_idx
    ON notify_sends (about_ref, subscription_id)
    WHERE about_ref IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WHAT THIS FILE DELIBERATELY DOES NOT GRANT
-- ═══════════════════════════════════════════════════════════════════════
--
-- Delivery now joins `sessions`, because a login that EXPIRES without anybody
-- pressing «Cerrar sesiones» left its browser able to receive the twin's words
-- for ever (Codex on PR #274, finding 5). `dito_twin_runtime` is granted
-- nothing on that table here, and that is …20260922100030's own decision about
-- `seats` rather than an omission: the lease holder authenticates as the
-- schema owner today, so a grant with no row-level policy beside it would buy
-- nothing, and the policy this role would need is unrestricted — it is scoped
-- by the twin it holds a lease on and declares no company. Both reads belong
-- to the ticket that makes the runtime authenticate as its own role.

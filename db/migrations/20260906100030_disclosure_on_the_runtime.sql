-- The daily disclosure becomes an execution (ticket #198; spec #193
-- decisions 10, 21 and 24; the ruling on #194, 2026-09-06; ADR-0014 as
-- amended, ADR-0020, ADR-0034, ADR-0037 as amended).
--
-- NUMBERING: …2026090610003·, after …20260906100020 (the request channel,
-- #197) and …20260906100010 (extraction's third reading, #196). Forward-only:
-- no migration in this repo is ever edited once it has applied anywhere,
-- because a migration is a statement about what a database has already been
-- through.
--
-- ONE FILE FOR FOUR CHANGES, and they are one change: the day's post is an
-- execution from this ticket on, so the execution has to be able to end the
-- way a post ends, the post has to be able to NAME the execution that
-- composed it, the day has to be able to say that it was attempted, and an
-- operator asking for a day the rep has not lived has to be refusable in a
-- word. Splitting them would leave a migration widening a vocabulary nothing
-- writes beside one creating a table no disposition can settle.
--
-- THIS FILE NAMES NO ENTITY AND NO CHAT, and that is enforced
-- (`binding-wall.test.ts`). A disclosure attempt is one twin's civil day and
-- the execution that read it: the post's own text is `notices.content_enc`
-- under the twin DEK, and which lines it carried is `disclosure_post_lines`.
--
-- THE CHECKS BELOW ARE EXTENDED, NEVER NARROWED. Postgres has no "add a value
-- to a CHECK", so each is DROP + re-CREATE carrying everything it already
-- said — the shape `migration-vocabulary.test.ts` watches, in both directions
-- and across files.

-- ── The eleventh disposition: `posted` (spec #193 decision 24) ─────────────
--
-- `posted` MEANS POSTED, which is the ruling on #194 applied to this occasion:
-- the word is assigned through the runner's submission-handler hook, so the
-- record says `posted` only after the day's post and every question post it
-- carried have committed inside the execution's own transaction. A submission
-- the structural guard refuses every time exhausts the budget and the
-- execution ends `failed`, never `posted`.
--
-- BOTH TABLES IN ONE FILE, because the two hold one vocabulary
-- (`migration-vocabulary.test.ts` asserts they are the same words). The owner
-- side never writes this word — nothing on the far side of the wall posts to a
-- rep's thread — and it carries it for the same reason it carries `drafted`
-- and `filed`: `DISPOSITIONS` is one closed set in `@dito/execution`, and two
-- vocabularies would be two answers to FR-48's count.

ALTER TABLE executions
    DROP CONSTRAINT executions_disposition_check;

ALTER TABLE executions
    ADD CONSTRAINT executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted'));

COMMENT ON COLUMN executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified · filed · nothing-to-file · posted (spec #171 decision 11; spec #193 decisions 19 and 24). Widened, never narrowed; the rep side writes drafted, no-action, acted, classified, filed, nothing-to-file, posted and failed.';

ALTER TABLE owner.executions
    DROP CONSTRAINT owner_executions_disposition_check;

ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted'));

COMMENT ON COLUMN owner.executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified · filed · nothing-to-file · posted (spec #171 decision 11). Widened at #178, #194 and #198, never narrowed. FR-48''s failed-query log is a count over this column; the owner side writes only the first five.';

-- ── The post names the execution that composed it (spec #193 decision 24) ──
--
-- `notices.execution_id` HAS EXISTED SINCE …0904100020 AND COULD NOT BE
-- WRITTEN FROM A SUBMISSION HANDLER, which is what this re-cut fixes. The
-- reference is a foreign key, and it was IMMEDIATE: the row it points at has
-- to exist by the time the notice's INSERT returns.
--
-- Every earlier writer could satisfy that because it posted AFTER its
-- execution finished — `runExecution` returns, the record is written, then the
-- notice. The submission-handler hook built at #196 inverts that on purpose
-- (the ruling on #194): the app's handling of an accepted submission runs
-- INSIDE the run, before the disposition is fixed, so that the record and the
-- chain entry attest to what the app really did. The disclosure is the first
-- automation whose handling POSTS, and its notice therefore names a record
-- that is three statements away.
--
-- DEFERRABLE INITIALLY IMMEDIATE, not `INITIALLY DEFERRED`, and the
-- difference is the point: nothing changes for any existing writer — the
-- constraint is still checked at statement time everywhere — and the one
-- transaction that needs the other order asks for it by name
-- (`SET CONSTRAINTS notices_execution_id_fkey DEFERRED`, in
-- `disclosure.ts`'s posting). At COMMIT the reference is checked exactly as
-- strictly as before, so a notice naming an execution that never got a record
-- still cannot commit.
--
-- WIDENING, NEVER NARROWING: a deferrable constraint admits strictly more
-- orderings within one transaction and the same rows at its end.
ALTER TABLE notices
    DROP CONSTRAINT notices_execution_id_fkey;

ALTER TABLE notices
    ADD CONSTRAINT notices_execution_id_fkey
        FOREIGN KEY (execution_id) REFERENCES executions (id)
        DEFERRABLE INITIALLY IMMEDIATE;

COMMENT ON COLUMN notices.execution_id IS
    'The execution that produced this post, when one did (ticket #172). NULL for every notice written before executions existed, and for the posts no execution composes — the send confirmation and the refusal microcopy. The daily disclosure and its question posts carry one since #198, written from inside the execution''s own transaction: the reference is DEFERRABLE so the notice may be inserted before the record it names, and it is still checked at COMMIT.';

-- ── The request channel's sixth reason word (spec #193 decision 26) ───────
--
-- `day_not_lived`. The channel serves `daily_disclosure` from this ticket on,
-- and the one refusal it needs a word for is a steering clock later than the
-- real day: the post is keyed (twin, day), so a request that posted tomorrow's
-- account today would BE the post that day gets, and the scheduled pass would
-- then say nothing on a real day the rep had traffic. The refusal belongs to
-- the channel rather than to the rig's own script, so a hand-written row
-- cannot do what that script would not.
--
-- IT IS NOT `malformed_parameter`, which is the word for a value this runtime
-- cannot use: the instant is well formed, the store admits it, and an operator
-- told their parameter was malformed would go looking for a typo instead of
-- for the rule.
--
-- Extended, never narrowed: DROP + re-CREATE carrying all five earlier words.
ALTER TABLE runtime_requests
    DROP CONSTRAINT runtime_requests_reason_check;

ALTER TABLE runtime_requests
    ADD CONSTRAINT runtime_requests_reason_check
        CHECK (reason IS NULL OR reason IN ('malformed_parameter',
                                            'rail_not_linked',
                                            'chat_in_flight',
                                            'pass_failed',
                                            'interrupted',
                                            'day_not_lived'));

COMMENT ON COLUMN runtime_requests.reason IS
    'A closed word, never a sentence: malformed_parameter · rail_not_linked · chat_in_flight · pass_failed · interrupted · day_not_lived (tickets #197, #198). Present exactly when the outcome is not `served`.';

COMMENT ON TABLE runtime_requests IS
    'Ticket #197: one row per operator request to the RUNNING runtime — the twin, which daily job, an optional chat, metadata-only parameters (the steering clock, the re-read), when it was asked, when the loop took it, how many executions it created, how many chats it left alone, and what became of the ask (spec #193 decision 26). Content-free: the parameters and the chat selector are both fenced by CHECK. Both occasions are served since #198.';

-- ── One attempt per occasion per day (spec #193 decision 10) ───────────────
--
-- WHY THE MARK IS A ROW AND NOT THE POST. `disclosure_posts_one_per_twin_day`
-- already makes a second POST unrepresentable, and it says nothing about a day
-- whose execution FAILED: a failed disclosure posts nothing, so it writes no
-- post row, and without this table every tick after it would create another
-- execution and pay for another model call — on every poll, until midnight.
-- Spec #193 decision 10 is explicit that the disclosure follows extraction's
-- rule ("one attempt per occasion per day; a failed post leaves its lines
-- pending for the next day"), and the lines really do ride tomorrow's post
-- because `readPendingLines` asks about DELIVERY rather than about attempts.
--
-- ...AND WHY IT IS NOT A CLAIM ROW. `extraction_runs` is claimed BEFORE its
-- execution because a chat-day is claimed from a set the pass enumerates and
-- two claims of one chat would pay twice. There is one disclosure per twin per
-- day and one runtime per twin, so what has to be durable is the ATTEMPT
-- rather than the intention: this row is written inside the execution's own
-- transaction, beside the record it names and the chain entry that attests to
-- it, so "one execution, one record, one entry" gains a third leg that commits
-- with the other two. The in-memory flag beside the batch lane is what stops
-- a second tick firing before that commit (`BatchWork.disclosing`), exactly as
-- the in-flight set does for extraction — and the one thing left uncovered is
-- named on the ticket: a transaction that is GONE leaves no attempt, and the
-- next start re-fires the day, which is what a run with no record anywhere
-- should do.
--
-- `execution_id` IS NOT NULL, unlike every other execution reference in this
-- repo. Those are nullable because rows predating executions exist; there is
-- no attempt row predating this table, and an attempt with no execution would
-- be a mark nobody could account for.

CREATE TABLE disclosure_attempts (
    -- Carried, not derived, so the reference below is twin-scoped and the
    -- primary key is the rule rather than a convention (…100025's shape).
    twin_id uuid NOT NULL,
    -- The rep's own calendar day, in the rep's own zone, derived by the pass
    -- from its explicit `now` — a `date` for the reason `disclosure_posts`
    -- gives: "the day" is the unit of idempotence, and storing an instant
    -- would let two runs disagree about which day they were in.
    disclosure_day date NOT NULL,
    -- The execution that composed the day, whichever way it ended. The join
    -- to what it cost: its iterations, its tokens, its two instants and its
    -- disposition are `executions`, and its one chain entry names the same
    -- content-free reference (ADR-0020).
    execution_id uuid NOT NULL REFERENCES executions (id),
    attempted_at timestamptz NOT NULL DEFAULT now(),
    -- ONE ATTEMPT PER (twin, day) — the whole of spec #193 decision 10 for
    -- this occasion, as a property of the store rather than of a loop's
    -- bookkeeping. A second execution for a day already attempted cannot
    -- commit, so a build that lost its in-memory guard would pay for a model
    -- call and record nothing rather than post a second account of one day.
    CONSTRAINT disclosure_attempts_one_per_twin_day
        PRIMARY KEY (twin_id, disclosure_day),
    -- One execution attempts one day. Belt: the pass mints the execution id
    -- itself and writes this row beside the record, so nothing can arrange
    -- two days around one run.
    CONSTRAINT disclosure_attempts_one_per_execution UNIQUE (execution_id)
);

COMMENT ON TABLE disclosure_attempts IS
    'Ticket #198: one row per twin per day the disclosure automation ran at all — the day, and the execution that composed it, whichever way that execution ended (spec #193 decisions 10 and 24). It is what makes "one attempt per occasion per day" a property of the store: a failed post writes no disclosure_posts row, so without this the next tick would pay for another model call. Content-free: the post''s text is notices.content_enc under the twin DEK and its lines are disclosure_post_lines.';
COMMENT ON COLUMN disclosure_attempts.execution_id IS
    'The execution that composed this day, `posted` or `failed` (ticket #198). NOT NULL: there is no attempt row predating executions, and an attempt with no execution would be a mark nobody could account for.';

-- What the rep was told, and what the twin tried to tell them, are never
-- rewritten — the construction `disclosure_posts` (…100025) and
-- `question_posts` (…0829100030) both use, with its own function so the message
-- names this table.
CREATE FUNCTION disclosure_attempts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'disclosure attempts are immutable: % refused — a day the twin tried to account for was tried, and one attempt per day is the rule the row exists to hold (spec #193 decision 10)', TG_OP;
END;
$$;

CREATE TRIGGER disclosure_attempts_no_update_delete
    BEFORE UPDATE OR DELETE ON disclosure_attempts
    FOR EACH ROW EXECUTE FUNCTION disclosure_attempts_immutable();
CREATE TRIGGER disclosure_attempts_no_truncate
    BEFORE TRUNCATE ON disclosure_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION disclosure_attempts_immutable();

-- ── Grants, on purpose (…100012's rule) ───────────────────────────────────
--
-- `SELECT, INSERT` for the runtime, which is the only writer: it reads the row
-- to decide whether today has been attempted and writes one when it attempts.
-- The REVOKE is a statement rather than a change — …100012's blanket grant
-- does not reach a table created after it — so it stands here for the same
-- reason …100020's does, and a later migration handing the runtime UPDATE is
-- visible in FR-71a's own grant diff.
--
-- NOTHING FOR THE APERTURE, unlike `disclosure_posts` and `question_posts`
-- beside it. Those two are read by the aperture's own invariant walk over what
-- the rep was told; this row is not about what the rep was told at all — it is
-- the runtime's mark that it tried — and a grant nothing reads is a widening
-- FR-71a would have to carry for ever. The REVOKE says so, so a later
-- migration handing the aperture this table is visible in the grant diff.
GRANT SELECT, INSERT ON disclosure_attempts TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON disclosure_attempts FROM dito_twin_runtime;

REVOKE ALL ON disclosure_attempts FROM dito_aperture;

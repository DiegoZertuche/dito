-- The nudge: one sentence the twin composed on the clock, and the memory that
-- once (ticket #268; spec #258 *Notification end to end* and decision 7;
-- ADR-0031 as amended, ADR-0008, ADR-0014 as amended).
--
-- NUMBERING: …20260922100050, after …20260922100040 (the seen marks, #262).
-- Forward-only: no migration in this repo is ever edited once it has applied
-- anywhere, because a migration is a statement about what a database has
-- already been through.
--
-- ONE FILE FOR TWO CHANGES, and they are one change: the nudge is an
-- execution from this ticket on, so the execution has to be able to end the
-- way a nudge ends, and the nudge has to leave a row that stops it being
-- composed twice. Splitting them would leave a migration widening a vocabulary
-- nothing writes beside one creating a table no disposition can settle.
--
-- THIS FILE NAMES NO CHAT, NO DRAFT AND NO ENTITY, and that is enforced
-- (`binding-wall.test.ts`). A nudge is one post, one word out of three, and a
-- sentence sealed under the twin DEK.
--
-- RE-RUNNABLE. Atlas never re-applies a file; this is for an OPERATOR
-- replaying it by hand against a database whose revision history says nothing.
-- `IF NOT EXISTS` on everything that takes it, `DROP CONSTRAINT IF EXISTS`
-- before each re-cut, and every GRANT, REVOKE and COMMENT idempotent as
-- written.

-- ── The twelfth disposition: `nudged` (spec #258 decision 7) ──────────────
--
-- `nudged` MEANS A SENTENCE EXISTS. It is read off the submission, the way
-- `filed` is and unlike `posted`: a nudge writes no post, so there is nothing
-- for a submission handler to attest to. What it says is that the twin
-- composed one usable line about one thing about to lapse; whether that line
-- reached a device is notify's own send record.
--
-- NOT `answered`, which would be a lie — nobody asked the twin anything — and
-- not `posted`, because there is no post: a nudge is push-only, and its record
-- is `nudges` below.
--
-- BOTH TABLES IN ONE FILE, because the two hold one vocabulary
-- (`migration-vocabulary.test.ts` asserts they are the same words). The owner
-- side never writes this word — nothing on the far side of the wall nudges a
-- rep about anything — and it carries it for the same reason it carries `drafted`
-- and `posted`: `DISPOSITIONS` is one closed set in `@dito/execution`, and two
-- vocabularies would be two answers to FR-48's count.
--
-- EXTENDED, NEVER NARROWED. Postgres has no "add a value to a CHECK", so each
-- is DROP + re-CREATE carrying everything it already said — the shape
-- `migration-vocabulary.test.ts` watches, in both directions and across files.

ALTER TABLE executions
    DROP CONSTRAINT IF EXISTS executions_disposition_check;

ALTER TABLE executions
    ADD CONSTRAINT executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted', 'nudged'));

COMMENT ON COLUMN executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified · filed · nothing-to-file · posted · nudged (spec #171 decision 11; spec #193 decisions 19 and 24; spec #258 decision 7). Widened, never narrowed; the rep side writes drafted, no-action, acted, classified, filed, nothing-to-file, posted, nudged and failed.';

ALTER TABLE owner.executions
    DROP CONSTRAINT IF EXISTS owner_executions_disposition_check;

ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted', 'nudged'));

COMMENT ON COLUMN owner.executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified · filed · nothing-to-file · posted · nudged (spec #171 decision 11). Widened at #178, #194, #198 and #268, never narrowed. FR-48''s failed-query log is a count over this column; the owner side writes only the first five.';

-- ── One nudge per post per kind, and what it said ─────────────────────────
--
-- ═══ WHY THIS STORE EXISTS AT ALL ═══
--
-- Every other tier reads its memory off `notify_sends.about_ref`: a knock is
-- delivered once because the pass asks «is there a row about this post», and
-- that works because a knock is READ from something already written. A nudge
-- is COMPOSED — a model call, paid for, before anything can be sent — so the
-- send record answers the question one step too late: a refused transport, a
-- seat with no subscription, a crash between the commit and the send all leave
-- no `notify_sends` row, and the next pass would compose the sentence again,
-- and again, for the life of the process.
--
-- So the memory is written where the sentence is: the primary key below IS
-- the once-per-post-per-kind rule, the pass writes the row inside the
-- execution's own transaction, and a second nudge of one kind about one post
-- is unrepresentable rather than merely avoided.
--
-- ...AND A FAILED RUN WRITES ONE TOO, which is why `body_enc` is nullable. A
-- run that produced no usable sentence is exactly the run that must not be
-- retried: it already cost a model call, and the failure is the model writing
-- something the cap or the no-link rule refused, which a second run would
-- reproduce. NULL therefore means «this was attempted and left no sentence»,
-- and the execution row it names says how it ended (ADR-0034's rule that an
-- absent field is NOT RECORDED, never a default).
--
-- ═══ THE SENTENCE IS SEALED, LIKE EVERY OTHER WORD THE TWIN WRITES ═══
--
-- `body_enc` is a DEK envelope (ADR-0008), exactly as a post's parts are. A
-- nudge is the one thing the twin says that never becomes a post, so without
-- this column what the rep was told on their lock screen would exist nowhere
-- at all — and cryptographic erasure at retirement reaches it for the same
-- reason it reaches `posts.parts_enc` (ADR-0009).
--
-- ═══ CONTENT-FREE EVERYWHERE ELSE ═══
--
-- A twin, a post, a word out of three, an execution and an instant. There is
-- no column outside `body_enc` anybody could put a chat address, a customer's
-- name or a draft's body into.

CREATE TABLE IF NOT EXISTS nudges (
    twin_id uuid NOT NULL,
    -- The card this nudge is about. A REAL foreign key, unlike
    -- `notify_sends.about_ref` beside it: that column is the record that a
    -- message LEFT and must outlive what it announced, and this one is the
    -- memory that stops a model call — it has no meaning without its post, and
    -- a post that is gone is a post nothing can nudge about.
    --
    -- ON THE POST'S OWN KEY AND NOT ON A TWIN-SCOPED PAIR, which is
    -- `dashboard_acts.post_id_fkey`'s shape one table over: `posts` carries no
    -- unique index on (twin_id, id), and the twin beside it is the predicate
    -- every read here is scoped by rather than a second half of an identity.
    post_id uuid NOT NULL REFERENCES posts (id),
    -- WHICH LATENESS, out of a closed set. The vocabulary is the runtime's
    -- `NUDGE_KINDS` and this CHECK is its other half
    -- (`migration-vocabulary.test.ts`).
    kind text NOT NULL,
    -- The execution that composed it, whichever way that execution ended. The
    -- join to what it cost: its iterations, its tokens, its two instants and
    -- its disposition are `executions`, and its one chain entry names the same
    -- content-free reference (ADR-0020).
    execution_id uuid NOT NULL REFERENCES executions (id),
    -- The sentence, under the twin DEK — NULL when the run left none.
    body_enc bytea,
    composed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- THE WHOLE OF «ONCE PER POST PER KIND», as a property of the store rather
    -- than of a loop's bookkeeping. A second execution for a post and kind
    -- already nudged cannot commit, so a build that lost track would pay for a
    -- model call and record nothing rather than knock twice about one thing.
    CONSTRAINT nudges_once_per_post_kind PRIMARY KEY (post_id, kind),
    CONSTRAINT nudges_kind_check
        CHECK (kind IN ('question_expiring', 'window_closing', 'draft_waiting')),
    -- One execution composes one nudge. Belt: the pass mints the execution id
    -- itself and writes this row beside the record, so nothing can arrange two
    -- nudges around one run.
    CONSTRAINT nudges_one_per_execution UNIQUE (execution_id)
);

COMMENT ON TABLE nudges IS
    'Ticket #268: one row per nudge the twin composed about one card, keyed by the card and which lateness it was about (spec #258 decision 7). The primary key IS the once-per-post-per-kind rule: the row is written inside the execution''s own transaction, before anything is sent, so a refused send, a seat with no subscription and a restart all leave the nudge composed exactly once. A run that left no usable sentence writes a row with no body_enc, and is not tried again.';
COMMENT ON COLUMN nudges.kind IS
    'question_expiring (a binding question on its sixth day) · window_closing (the day''s record, two hours before its correction window shuts) · draft_waiting (a draft untouched since yesterday). The vocabulary is the runtime''s `NUDGE_KINDS` and this column''s CHECK is its other half (ticket #268).';
COMMENT ON COLUMN nudges.body_enc IS
    'The one line the rep read on their lock screen, sealed under the twin DEK (ADR-0008) exactly as a post''s parts are. NULL when the execution produced no usable sentence — the record it names says how it ended (ticket #268).';

-- The pass's own question, asked per candidate on every pass it runs: «has
-- this post already been nudged this way?». The primary key above indexes the
-- pair, so nothing else is needed.

-- What the twin told a rep is never rewritten — the construction
-- `disclosure_attempts` (…20260906100030) and `disclosure_posts`
-- (…20260829100025) both use, with its own function so the message names this
-- table.
CREATE OR REPLACE FUNCTION nudges_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'nudges are immutable: % refused — a nudge that was composed was composed, and once per post per kind is the rule the row exists to hold (ticket #268)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS nudges_no_update_delete ON nudges;
CREATE TRIGGER nudges_no_update_delete
    BEFORE UPDATE OR DELETE ON nudges
    FOR EACH ROW EXECUTE FUNCTION nudges_immutable();
DROP TRIGGER IF EXISTS nudges_no_truncate ON nudges;
CREATE TRIGGER nudges_no_truncate
    BEFORE TRUNCATE ON nudges
    FOR EACH STATEMENT EXECUTE FUNCTION nudges_immutable();

-- ── Grants, on purpose (…20260829100012's rule) ───────────────────────────
--
-- SELECT AND INSERT FOR THE RUNTIME, which is the only writer and the only
-- reader: the lease holder asks whether a post has been nudged and writes the
-- row when it composes one. No UPDATE and no DELETE — the trigger above
-- refuses both, and withholding the privilege says the same thing in the
-- grant diff FR-71a watches.
--
-- NOTHING FOR ANYBODY ELSE. The REVOKEs are a statement rather than a change:
-- …20260829100012's blanket grant does not reach a table created after it, so
-- nothing is being taken away. rep-web must not read it — a nudge is not a
-- card and no surface renders one — and the owner is on the far side of the
-- wall from both.
GRANT SELECT, INSERT ON nudges TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON nudges FROM dito_twin_runtime;

REVOKE ALL ON nudges FROM dito_rep_web;
REVOKE ALL ON nudges FROM dito_aperture;
REVOKE ALL ON nudges FROM dito_owner;

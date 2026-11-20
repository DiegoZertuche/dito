-- The post primitive (ticket #220; spec #214 decision 2; ADR-0006, ADR-0008,
-- ADR-0013, ADR-0034, ADR-0037 as amended).
--
-- EVERY TWIN POST BECOMES ONE RECORD WITH TYPED PARTS. A draft, the day's
-- record, a question and an acknowledgement are four shapes today, and every
-- surface that shows them has to know all four. From this migration they are
-- one row with an ordered list of parts — prose the twin composed, the draft
-- it proposes, the day's numbered lines, a question with a subject that names
-- the act its answer performs, a receipt rendered from a tool's result — so
-- the dashboard (#224) reads ONE feed through the runtime's local API (#221)
-- and the thread keeps rendering exactly what it renders today.
--
-- ═══ ONE ROW BESIDE THE ROW THAT DELIVERED IT
--
-- `notices` and `drafts` are NOT folded in, and that is the decision this
-- migration makes rather than a step it postponed. Three things rest on those
-- two tables staying exactly as they are:
--
--   the SEND LOCK. The executor claims a `send_commands` row and dereferences
--   `payload_ref` — 'draft:<uuid>' or 'notice:<uuid>' — and knows nothing
--   else (ADR-0006). Folding the text into `posts` would mean a third word in
--   that contract, a plane change, and FR-70's reconciliation walking a new
--   store. Nothing here gives it one.
--
--   ADR-0034. A notice is the record of what the twin TOLD the rep, immutable
--   by trigger (…20260827100015), and a draft's `post_enc` is frozen with the
--   body a tap releases (…20260827100018). The bytes the rep read are those
--   rows. A post that re-derived its own rendering could differ from them, and
--   the whole of this ticket's byte-identity claim is that nothing re-derives.
--
--   the FEED WITH THE RAIL DOWN. `posts` carries no delivery state at all, so
--   the dashboard shows a draft card whether or not the plane ever posted it
--   (spec #214 story 8). "Was it delivered" is asked where delivery is known,
--   against `send_commands.outcome`, exactly as `readPendingLines` asks it.
--
-- So a post NAMES its delivery row. `posts.notice_id` or `posts.draft_id`,
-- exactly one of them, twin-scoped, unique — one post per delivery and one
-- delivery per post.
--
-- ═══ WHAT THE PARTS HOLD, AND WHAT THEY ONLY POINT AT
--
-- `parts_enc` is the ordered list, sealed under the twin DEK exactly as a
-- notice's own words are (ADR-0008): the twin's prose, the counterparty a
-- draft post named, a receipt's sentence. What it never holds is anything that
-- lives in a row of its own — the draft's body, because that is the one thing
-- a tap releases and a copy could disagree with it, and the day's numbered
-- lines, because `disclosure_post_lines` is the record of what the rep SAW and
-- a second numbering is what a correction cannot survive. Those parts carry a
-- REFERENCE and the runtime opens it (`posts.ts`, `feed.ts`).
--
-- THE REFERENCES ARE NOT FOREIGN KEYS, and they cannot be: they are inside
-- sealed bytes, and the store cannot read them. What the store enforces is the
-- delivery reference above; what keeps a part's reference honest is that the
-- post, its delivery row and the row it points at are written in ONE
-- transaction by one function.
--
-- ═══ THE RE-EXPRESSION, AND WHY IT SEALS NOTHING
--
-- Section 3 re-expresses every notice and every draft that already exists as a
-- post. It writes NO `parts_enc`, because SQL holds no key and this repository
-- does not put one in a migration — so those rows carry `origin =
-- 'reexpressed'` and the feed derives their parts from the delivery row they
-- name: the notice's kind says which part it is, the draft says it is a draft,
-- and every field nothing recorded then is simply ABSENT (ADR-0034 — an absent
-- field is NOT RECORDED THEN, never a default). `posts_composed_parts_check`
-- ties the two together, so a re-expressed row cannot carry sealed parts and a
-- composed one cannot lack them.
--
-- FORWARD-ONLY AND IDEMPOTENT. There is no down migration in this repo. The
-- re-expression is a plain INSERT … SELECT guarded by the delivery row's
-- unique constraint, so re-running it inserts nothing; nothing is ever
-- rewritten, because a post is immutable for the same reason a notice is.
--
-- AND IT RUNS A SECOND TIME, AT EVERY START, which is not belt-and-braces but
-- the close of a window this migration cannot reach. `README.md` brings a rig
-- to a slice tip by migrating and THEN restarting the three processes, so
-- between these statements and the new runtime coming up the OLD runtime is
-- still polling — and every notice and draft it writes in that gap gets no
-- post. Nothing would ever notice: the delivery row is valid, its
-- `system_send` goes out, the event's marker is written, so no pass replays it
-- and no invariant reads it, and the post is simply absent from the rep's
-- Inicio for ever. `reexpressStrayPosts` (`posts.ts`) is the same two
-- statements scoped to one twin, swept once at startup before the loop writes
-- anything new — `crossPendingBindings`' own shape, for the same reason. This
-- migration does NOT depend on the plane or the runtime being stopped, which
-- is what makes the gap reachable rather than merely conceivable: an operator
-- who does not quiesce loses nothing and is told nothing.

-- ---------------------------------------------------------------------
-- 1. THE SCOPED KEY A POST POINTS AT
-- ---------------------------------------------------------------------
-- The seam has no composite key on `drafts` to point a scoped foreign key at,
-- so this adds one — the shape …20260829100025 used for `notices` and
-- `disclosure_lines`, for the same reason. Without it a post could name one
-- twin's row while carrying another twin's id and satisfy every constraint,
-- and the feed filters on the POST's twin: a rep would be handed a draft card
-- for somebody else's draft. Refused in the store, not promised in a comment.
ALTER TABLE drafts
    ADD CONSTRAINT drafts_twin_scoped_key UNIQUE (twin_id, id);

-- ---------------------------------------------------------------------
-- 2. THE POST
-- ---------------------------------------------------------------------
CREATE TABLE posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- The execution that composed it, when one did.
    --
    -- NULLABLE FOR TWO REASONS, and both are the present state rather than a
    -- gap. A `reexpressed` row predates executions on this side. And code
    -- composes some posts on its own with no execution at all — the send
    -- confirmation the resolved-send sweep emits, the send lock's refusal
    -- microcopy, the binding ack on the replay path — exactly the notices
    -- `notices.execution_id` is already null for.
    --
    -- DEFERRABLE INITIALLY DEFERRED, and that is load-bearing. Two paths write
    -- the post BEFORE the execution's own record exists in the same
    -- transaction: the day's disclosure posts from inside its own run (the
    -- reason `notices_execution_id_fkey` is deferrable at all), and the
    -- thread's `create_draft` writes from inside the model loop, before the
    -- run has ended. Checked at COMMIT, so a post naming an execution that
    -- never got a record still cannot commit.
    execution_id uuid
        CONSTRAINT posts_execution_id_fkey REFERENCES executions (id)
        DEFERRABLE INITIALLY DEFERRED,
    -- How this post's parts came to be written — `posts.ts`'s `POST_ORIGINS`.
    origin text NOT NULL
        CONSTRAINT posts_origin_check
        CHECK (origin IN ('composed', 'reexpressed')),
    -- The ordered typed parts, sealed under the twin DEK (ADR-0008).
    parts_enc bytea,
    -- THE SUBJECT OF THE ONE QUESTION THIS POST ASKS, in the clear, because
    -- it is a closed vocabulary rather than content: a surface asks "is there
    -- a question here, and what does answering it do" without a key. In 6a
    -- the binding is the only subject — the chat↔entity binding is one of the
    -- two acts reserved to the rep (ADR-0037 as amended), not the twin
    -- filling a hole in its own record, which is the route #218 retired.
    -- `posts.ts` holds the same set as `QUESTION_SUBJECTS` and
    -- `migration-vocabulary.test.ts` compares the two.
    question_subject text
        CONSTRAINT posts_question_subject_check
        CHECK (question_subject IS NULL OR question_subject IN ('binding')),
    -- The delivery row: the notice, or the draft, whose `payload_ref` the
    -- executor posts. Exactly one.
    notice_id uuid,
    draft_id uuid,
    -- When the twin composed it. `clock_timestamp()` rather than `now()` (the
    -- 5b boundary rule, PR #213): the feed orders newest first and two posts
    -- of one transaction — a draft and its binding question — would otherwise
    -- share a transaction timestamp and fall back to comparing random uuids,
    -- which is the same coin flip `insertSystemSendCommand` avoids for thread
    -- order. A re-expressed row takes its delivery row's own instant instead,
    -- so the feed's order is the order the rep read.
    posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT posts_one_delivery_check
        CHECK ((notice_id IS NULL) <> (draft_id IS NULL)),
    -- Composed means sealed parts; re-expressed means none. Stated as an
    -- equivalence so neither half can drift: a composed post with no parts is
    -- a post with nothing in it, and a re-expressed one carrying parts would
    -- be a migration claiming to have sealed something.
    CONSTRAINT posts_composed_parts_check
        CHECK ((origin = 'composed') = (parts_enc IS NOT NULL)),
    CONSTRAINT posts_notice_fkey
        FOREIGN KEY (twin_id, notice_id) REFERENCES notices (twin_id, id),
    CONSTRAINT posts_draft_fkey
        FOREIGN KEY (twin_id, draft_id) REFERENCES drafts (twin_id, id),
    CONSTRAINT posts_one_per_notice UNIQUE (notice_id),
    CONSTRAINT posts_one_per_draft UNIQUE (draft_id)
);

-- The feed's own read: one twin's posts, newest first, paged by a cursor over
-- exactly this order (`readFeed`). The tiebreaker is in the index because it
-- is in the ORDER BY: two posts sharing an instant must page deterministically
-- or a cursor can skip one.
CREATE INDEX posts_twin_posted_idx ON posts (twin_id, posted_at DESC, id DESC);

-- A post is the record of what the rep was told, like the notice and the draft
-- it names (…20260827100015, …20260827100010, ADR-0034). Refused in the store,
-- not promised in a comment.
CREATE FUNCTION posts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'posts are immutable: % refused — a post is the record of what the twin told the rep (ADR-0034)', TG_OP;
END;
$$;

CREATE TRIGGER posts_no_update_delete
    BEFORE UPDATE OR DELETE ON posts
    FOR EACH ROW EXECUTE FUNCTION posts_immutable();
CREATE TRIGGER posts_no_truncate
    BEFORE TRUNCATE ON posts
    FOR EACH STATEMENT EXECUTE FUNCTION posts_immutable();

-- Grants, on purpose (…20260829100012's rule: ALTER DEFAULT PRIVILEGES
-- deliberately does not cover `public`, so a rep-side store added later is
-- granted by hand). This is a TWIN-side store — the record of what the twin
-- told its own rep — so the twin runtime writes it and NOTHING on the far side
-- of the wall holds anything here at all: the aperture does not read what the
-- rep is shown. rep-web's own read arrives with its role (#222); it is not
-- granted here, because a role that does not exist yet cannot be audited.
GRANT SELECT, INSERT ON posts TO dito_twin_runtime;
-- No UPDATE, no DELETE, for anyone: the triggers above refuse them and the
-- grants say the same thing a second way.
REVOKE UPDATE, DELETE, TRUNCATE ON posts FROM dito_twin_runtime;

-- ---------------------------------------------------------------------
-- 3. THE RE-EXPRESSION
-- ---------------------------------------------------------------------
-- Every notice becomes a post. `notices.kind` is what the feed reads the
-- part shape off, so nothing about the shape needs storing here: a
-- `daily_disclosure` is the day's record lines, a `binding_question` is a
-- question, an `answer` is prose, and the six acknowledgement kinds are
-- receipts. What DOES need storing is the question's subject, because that is
-- a column a surface reads without a key — and every binding question ever
-- posted has the one subject 6a declares.
--
-- `posted_at` IS THE NOTICE'S OWN INSTANT, never this migration's: the feed
-- orders newest first, and re-expressing a year of posts under one instant
-- would hand the rep their history in the order the INSERT happened to walk
-- it.
INSERT INTO posts (twin_id, execution_id, origin, question_subject, notice_id, posted_at)
SELECT n.twin_id,
       n.execution_id,
       'reexpressed',
       CASE WHEN n.kind = 'binding_question' THEN 'binding' END,
       n.id,
       n.created_at
  FROM notices n
ON CONFLICT (notice_id) DO NOTHING;

-- ...and every draft. Its execution comes off `draft_timings`, which is where
-- the run that wrote a draft is already recorded (…20260827100014) — a draft
-- from slice 1 has no timing row and therefore no execution, which is the
-- honest reading of a row that predates executions on this side.
INSERT INTO posts (twin_id, execution_id, origin, draft_id, posted_at)
SELECT d.twin_id,
       dt.execution_id,
       'reexpressed',
       d.id,
       d.created_at
  FROM drafts d
  LEFT JOIN draft_timings dt ON dt.draft_id = d.id
ON CONFLICT (draft_id) DO NOTHING;

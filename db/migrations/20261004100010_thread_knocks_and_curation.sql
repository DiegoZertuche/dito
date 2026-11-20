-- The thread alone knocks and curates (ticket #320; spec #318 decisions 15,
-- 19, 20 and 21; design D4, D5 and §6; ADR-0031, ADR-0044 and ADR-0013 as
-- amended 2026-09-27).
--
-- NUMBERING: …20261004100010, after …20261003100010. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ FOUR THINGS ═══
--
--   THE KNOCK THE THREAD ADDS — one row per post the twin thread knocked
--   about with its `knock` tool: the post, the sentence sealed under the twin
--   DEK, the execution, when. `posts` is immutable by trigger, so a knock
--   decided after a post landed cannot become one of its parts; it is a row
--   of its own that every reader of a post's parts joins. The primary key on
--   the post IS floor (a) — at most one knock about one post — and the
--   insert trigger refuses a post that already carries a knock of its own.
--
--   THE CANVAS'S CURATION — one current curation per twin, kept as a version
--   per write: which waiting post is the spotlight and the order of the
--   rest, by post id. Written by the thread's `spotlight` tool; the canvas
--   read returns the newest. Every version stays (disclosed-and-undoable-
--   after: the canvas shows it and the next turn rewrites it).
--
--   THE UNASKED LINE — a post at the dashboard's door that answers no message
--   and no arrival: what a turn the seam's events woke said, delivered to the
--   dashboard only (design D4, «a line in the bar»; ADR-0031's self-chat is a
--   pull surface the twin never pushes into unasked). The arrival line's kind,
--   generalised: no notice, no draft, no knock.
--
--   THE SEEN-STAMPS, READ BY THE RUNTIME — `read_canvas` says which waiting
--   posts the rep has looked at, and rep-web's `seen_marks` is the one record
--   of it. SELECT and nothing else: a seat's seen-stamps are shared by
--   construction between the page that writes them and the twin that serves
--   that seat.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE KNOCK THE THREAD ADDS
-- ═══════════════════════════════════════════════════════════════════════

-- The scoped key a knock points at: a knock naming one twin's post while
-- carrying another twin's id would satisfy a plain foreign key, and the
-- delivery reads by the KNOCK's twin.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_twin_scoped_key;
ALTER TABLE posts
    ADD CONSTRAINT posts_twin_scoped_key UNIQUE (twin_id, id);

CREATE TABLE IF NOT EXISTS post_knocks (
    -- ONE KNOCK PER POST, BY CONSTRUCTION (floor (a), design §3.4).
    post_id uuid PRIMARY KEY,
    twin_id uuid NOT NULL,
    -- The sentence the lock screen shows, sealed under the twin DEK
    -- (ADR-0008) exactly as a post's own parts are.
    text_enc bytea NOT NULL,
    -- The thread turn that decided it. DEFERRABLE because the tool writes
    -- inside the model loop, before the turn's own record exists in the same
    -- transaction — `posts.execution_id`'s reason.
    execution_id uuid NOT NULL
        CONSTRAINT post_knocks_execution_fkey REFERENCES executions (id)
        DEFERRABLE INITIALLY DEFERRED,
    knocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT post_knocks_post_fkey
        FOREIGN KEY (twin_id, post_id) REFERENCES posts (twin_id, id)
);

COMMENT ON TABLE post_knocks IS
    'Ticket #320: the knock the twin thread decided about a post that had already landed — one row per post (the primary key is floor (a)), the sentence sealed under the twin DEK, the execution, the instant. Joined into a post''s parts by every reader; delivered by the runtime''s at-once tier exactly as a carried knock is.';

CREATE INDEX IF NOT EXISTS post_knocks_by_twin
    ON post_knocks (twin_id, knocked_at, post_id);

-- A POST THAT LANDED CARRYING ITS OWN KNOCK REFUSES A SECOND ONE. A
-- question of the thread's own and a rep-asked draft announce themselves
-- (`knock_disposition = 'carried'`), and a row here about one of them would
-- be a second push about one card through the same two message types.
CREATE OR REPLACE FUNCTION post_knocks_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM posts p
                WHERE p.id = NEW.post_id AND p.knock_disposition = 'carried') THEN
        RAISE EXCEPTION 'post % already carries its own knock (ticket #320): one knock per post', NEW.post_id
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS post_knocks_not_carried ON post_knocks;
CREATE TRIGGER post_knocks_not_carried
    BEFORE INSERT ON post_knocks
    FOR EACH ROW EXECUTE FUNCTION post_knocks_once();

CREATE OR REPLACE FUNCTION post_knocks_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'post_knocks are immutable (ticket #320): % refused — a knock that reached a phone cannot be taken back', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS post_knocks_no_update_delete ON post_knocks;
CREATE TRIGGER post_knocks_no_update_delete
    BEFORE UPDATE OR DELETE ON post_knocks
    FOR EACH ROW EXECUTE FUNCTION post_knocks_immutable();

DROP TRIGGER IF EXISTS post_knocks_no_truncate ON post_knocks;
CREATE TRIGGER post_knocks_no_truncate
    BEFORE TRUNCATE ON post_knocks
    FOR EACH STATEMENT EXECUTE FUNCTION post_knocks_immutable();

GRANT SELECT, INSERT ON post_knocks TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON post_knocks FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE CANVAS'S CURATION
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS canvas_curations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    twin_id uuid NOT NULL,
    -- The post the rep starts with; NULL when nothing waited.
    spotlight uuid,
    -- Every post the twin placed, spotlight first. Post ids — layout over the
    -- rep's own cards, never content.
    post_order uuid[] NOT NULL,
    execution_id uuid NOT NULL
        CONSTRAINT canvas_curations_execution_fkey REFERENCES executions (id)
        DEFERRABLE INITIALLY DEFERRED,
    written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT canvas_curations_spotlight_first_check
        CHECK (spotlight IS NULL OR post_order[1] = spotlight)
);

COMMENT ON TABLE canvas_curations IS
    'Ticket #320: the canvas''s curation as the twin thread''s spotlight tool wrote it — the spotlight and the order of the rest by post id, one version per write; the newest is the current one the canvas read returns. Metadata only.';

CREATE INDEX IF NOT EXISTS canvas_curations_current
    ON canvas_curations (twin_id, id DESC);

CREATE OR REPLACE FUNCTION canvas_curations_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'canvas_curations are immutable (ticket #320): % refused — every version is kept and the next write supersedes', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS canvas_curations_no_update_delete ON canvas_curations;
CREATE TRIGGER canvas_curations_no_update_delete
    BEFORE UPDATE OR DELETE ON canvas_curations
    FOR EACH ROW EXECUTE FUNCTION canvas_curations_immutable();

DROP TRIGGER IF EXISTS canvas_curations_no_truncate ON canvas_curations;
CREATE TRIGGER canvas_curations_no_truncate
    BEFORE TRUNCATE ON canvas_curations
    FOR EACH STATEMENT EXECUTE FUNCTION canvas_curations_immutable();

GRANT SELECT, INSERT ON canvas_curations TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON canvas_curations FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE UNASKED LINE
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS unasked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN posts.unasked IS
    'Ticket #320: true on the line a turn the seam''s events woke composed — delivered to the dashboard''s door only (asked_on = dashboard, no message, no arrival, no notice, no draft, no knock). The arrival line''s kind, generalised (ADR-0044 as amended).';

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_door_message_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_door_message_check
    CHECK ((asked_on IS NOT DISTINCT FROM 'dashboard')
           = (asked_message_id IS NOT NULL OR arrival_id IS NOT NULL OR unasked));

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_door_one_reason_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_door_one_reason_check
    CHECK ((asked_message_id IS NOT NULL)::int
           + (arrival_id IS NOT NULL)::int
           + unasked::int <= 1);

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_unasked_door_only_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_unasked_door_only_check
    CHECK (NOT unasked
           OR (notice_id IS NULL AND draft_id IS NULL
               AND knock_disposition = 'none'));

-- The arrival line's writer is the twin thread's arrival turn, and its marker
-- says so.
COMMENT ON TABLE rep_arrival_executions IS
    'Tickets #266, #320: one row per arrival the twin thread''s arrival turn answered — the primary key is the exactly-once lock, committed with the execution record and chain entry it names (ADR-0020). execution_id is NULL only on a row an older build marked overtaken.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. THE SEEN-STAMPS, READ BY THE RUNTIME
-- ═══════════════════════════════════════════════════════════════════════

-- READ ONLY. The page writes a stamp on its own read and the twin reads it
-- when it looks at the canvas; the runtime holds no policy here, which is
-- `push_subscriptions`' shape (…20260922100030): the table-level grant is its
-- whole reach and its scope is the twin it holds a lease on.
GRANT SELECT ON seen_marks TO dito_twin_runtime;

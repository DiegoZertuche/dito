-- The daily disclosure post (ticket #51; spec #48 decisions 7, 14 and 17;
-- ADR-0003 as amended, ADR-0004, ADR-0016, ADR-0034).
--
-- What crosses, crosses disclosed — and this is where the disclosure
-- actually reaches the rep. The aperture writes a `disclosure_lines` row
-- in the same transaction as the crossing (…100011); once a day the twin
-- assembles the lines nobody has been told about yet into ONE grouped
-- post, by counterparty, numbered, and posts it to the twin thread
-- through the existing notice → system_send path.
--
-- Two tables, and neither holds rep content: the post's TEXT lives where
-- every other twin post's text lives — DEK-encrypted in `notices`
-- (ADR-0008) — and these rows carry ids, a day, and the numbering. That is
-- deliberate: the rendered post is evidence of what the rep was told, and
-- there is exactly one store for that.
--
-- WHY THE NUMBERING IS RECORDED. The correction is deterministic end to
-- end (spec #48 decision 14): a quoted «N no» resolves
--
--     quoted WhatsApp message id
--       → send_executions → send_commands.payload_ref = 'notice:<id>'
--       → notices          → disclosure_posts.notice_id
--       → disclosure_post_lines.line_index = N
--       → disclosure_lines → the fact
--
-- in code, with no model anywhere in the path (ADR-0003). The number the
-- rep typed is the number the rep SAW, which is only true if the mapping
-- is stored at render time rather than recomputed later from a query whose
-- ordering may have drifted. Prior art: `drafts.post_enc` (…100018) — the
-- twin stores what it showed, not a recipe for re-deriving it.
--
-- Nothing consumes this yet. Ticket #54 does.

-- The seam has no composite key to point a scoped foreign key at, so the
-- two tables below add one each. Without them a line mapping could name
-- one twin's post and another twin's line and satisfy every constraint —
-- and since the resolver filters on the POST's twin, a quoted «N no» would
-- then hand ticket #54 another twin's disclosure line to retract. Refused
-- in the store, not promised in a comment (Codex r2).
ALTER TABLE disclosure_lines
    ADD CONSTRAINT disclosure_lines_twin_scoped_key UNIQUE (twin_id, id);
ALTER TABLE notices
    ADD CONSTRAINT notices_twin_scoped_key UNIQUE (twin_id, id);

-- One post per twin per day, carrying the notice that delivered it.
CREATE TABLE disclosure_posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- The rep's own calendar day, in the rep's own zone — derived by the
    -- pass from its explicit `now` (ADR-0004's no-clock-seam shape, prior
    -- art `reconcileFr70At`). A `date`, not a timestamp: "the day" is the
    -- unit of idempotence, and storing an instant would let two runs
    -- disagree about which day they were in.
    disclosure_day date NOT NULL,
    -- The twin post itself: its text, DEK-encrypted, in the one store for
    -- twin posts. The quoted-id chain for a later correction lands here.
    -- Twin-scoped like the line mapping below: a post can only name a
    -- notice of its OWN twin, so no arrangement of rows puts one rep's
    -- post text under another rep's disclosure. (The notice's KIND is not
    -- enforceable by a foreign key without a redundant column; the pass is
    -- the only writer and always writes `daily_disclosure`.)
    notice_id uuid NOT NULL,
    posted_at timestamptz NOT NULL DEFAULT now(),
    -- IDEMPOTENT PER (twin, day) — the whole restart-safety claim (spec
    -- #48 decision 19). A crash mid-assembly re-runs the day and this
    -- index, not the pass's own bookkeeping, is what stops the second
    -- post. An empty day inserts NO row at all, so a day that filed
    -- nothing is never "done" and a line landing later that same day is
    -- still disclosed on the next run.
    CONSTRAINT disclosure_posts_one_per_twin_day UNIQUE (twin_id, disclosure_day),
    -- One notice carries one post. Belt: the pass mints the notice inside
    -- the same transaction, so a shared notice is unreachable — but a
    -- second post claiming an existing notice would make the quoted-id
    -- chain ambiguous, which is the one thing decision 14 forbids.
    CONSTRAINT disclosure_posts_one_per_notice UNIQUE (notice_id),
    CONSTRAINT disclosure_posts_notice_fkey
        FOREIGN KEY (twin_id, notice_id) REFERENCES notices (twin_id, id),
    -- The scoped key the line mapping points at.
    CONSTRAINT disclosure_posts_twin_scoped_key UNIQUE (twin_id, id)
);

CREATE INDEX disclosure_posts_twin_day ON disclosure_posts (twin_id, disclosure_day);

-- The numbering, exactly as rendered.
CREATE TABLE disclosure_post_lines (
    -- Carried, not derived: it is what makes the two foreign keys below
    -- SCOPED, so a mapping naming one twin's post and another's line is
    -- unrepresentable rather than merely unwritten (Codex r2).
    twin_id uuid NOT NULL,
    post_id uuid NOT NULL,
    -- The number the rep read: 1-based, continuous across the whole post
    -- (never restarted per counterparty — «N no» must name one line, and a
    -- per-group number would name several).
    line_index integer NOT NULL,
    disclosure_line_id uuid NOT NULL,
    PRIMARY KEY (post_id, line_index),
    CONSTRAINT disclosure_post_lines_post_fkey
        FOREIGN KEY (twin_id, post_id)
        REFERENCES disclosure_posts (twin_id, id),
    CONSTRAINT disclosure_post_lines_line_fkey
        FOREIGN KEY (twin_id, disclosure_line_id)
        REFERENCES disclosure_lines (twin_id, id),
    CONSTRAINT disclosure_post_lines_index_check CHECK (line_index >= 1)
);

-- DELIBERATELY NOT UNIQUE on `disclosure_line_id` (Codex r1 → r2).
--
-- The first cut had one, on the reading that a line is disclosed exactly
-- once. It is not: recording a mapping records that the twin QUEUED the
-- line in a post, and a post whose `system_send` the executor resolves
-- `failed` reached nobody. A unique index there made a failed delivery
-- into permanent silence — the line claimed by a post the rep never saw,
-- with every audit green.
--
-- So the claim the schema makes is the weaker true one: a line appears at
-- most once PER POST (the primary key, plus the pass's own single pass
-- over the pending set). "Disclosed" is a question about DELIVERY, and it
-- is asked where delivery is known — against `send_commands.outcome`, in
-- `readPendingLines`. A line carried only by definitively failed posts is
-- pending again, and the next day's post carries it under its own
-- numbering; a line carried by a delivered, in-flight or unknown post is
-- not.
CREATE INDEX disclosure_post_lines_by_line
    ON disclosure_post_lines (disclosure_line_id);

-- Both tables record what the rep was shown. A disclosure the twin can
-- edit afterwards is not a disclosure — same construction as `notices`
-- and `disclosure_lines` (…100015, …100011): refused in the store, not
-- promised in a comment.
CREATE FUNCTION disclosure_posts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'disclosure posts are immutable: % refused — the post is the record of what the rep was told crossed (ADR-0034)', TG_OP;
END;
$$;

CREATE TRIGGER disclosure_posts_no_update_delete
    BEFORE UPDATE OR DELETE ON disclosure_posts
    FOR EACH ROW EXECUTE FUNCTION disclosure_posts_immutable();
CREATE TRIGGER disclosure_posts_no_truncate
    BEFORE TRUNCATE ON disclosure_posts
    FOR EACH STATEMENT EXECUTE FUNCTION disclosure_posts_immutable();

CREATE TRIGGER disclosure_post_lines_no_update_delete
    BEFORE UPDATE OR DELETE ON disclosure_post_lines
    FOR EACH ROW EXECUTE FUNCTION disclosure_posts_immutable();
CREATE TRIGGER disclosure_post_lines_no_truncate
    BEFORE TRUNCATE ON disclosure_post_lines
    FOR EACH STATEMENT EXECUTE FUNCTION disclosure_posts_immutable();

-- AND SEALED AGAINST APPENDS (Codex r3). Refusing UPDATE and DELETE is not
-- enough: on a post the rep has already read, an INSERT of
-- `(same twin, same post, 2, some other line)` satisfies the primary key,
-- both foreign keys and every trigger above — and `«2 no»` would then
-- resolve to a line that was never printed beside a 2. The numbering is
-- the record of what the rep SAW, so it is complete at the moment the post
-- is written or it is not a record at all.
--
-- `posted_at` defaults to `now()`, which is TRANSACTION time, so a line
-- inserted by the transaction that created its post matches and a line
-- inserted by any later transaction does not. That is exactly the
-- distinction: the pass writes the post and all of its lines together.
CREATE FUNCTION disclosure_post_lines_sealed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM disclosure_posts p
         WHERE p.id = NEW.post_id AND p.posted_at = now()
    ) THEN
        RAISE EXCEPTION 'a disclosure post''s numbering is sealed with the post (ADR-0034): line % cannot join post % after the transaction that wrote it — the numbering is the record of what the rep saw', NEW.line_index, NEW.post_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER disclosure_post_lines_sealed_at_the_post
    BEFORE INSERT ON disclosure_post_lines
    FOR EACH ROW EXECUTE FUNCTION disclosure_post_lines_sealed();

-- Grants, on purpose (…100012's own rule: "a rep-side store added later
-- must be granted on purpose" — ALTER DEFAULT PRIVILEGES deliberately does
-- not cover `public`). These two are TWIN-side stores, the record of what
-- the twin told its own rep, so the twin runtime writes them and the
-- aperture only reads them. In particular the aperture holds no INSERT
-- here: nothing on the far side of the wall decides what the rep is shown.
GRANT SELECT, INSERT ON disclosure_posts, disclosure_post_lines TO dito_twin_runtime;
GRANT SELECT ON disclosure_posts, disclosure_post_lines TO dito_aperture;
-- No UPDATE, no DELETE, for anyone: the triggers above refuse them, and
-- the grants say the same thing a second way.
REVOKE UPDATE, DELETE, TRUNCATE ON disclosure_posts, disclosure_post_lines
    FROM dito_twin_runtime, dito_aperture;

-- 'daily_disclosure' joins the closed notice kinds: the framed grouped
-- post the twin writes once a day. It is about neither a command nor a
-- single event — it is about a DAY — so it carries neither
-- `about_command_id` nor `about_event_id`, and no kind-specific NOT NULL
-- check applies to it. What it is about is `disclosure_posts`, which
-- points the other way.
--
-- Every value an earlier migration granted rides forward (the rule
-- …100022 states).
ALTER TABLE notices
    DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question',
        'binding_ack',
        'answer',
        'daily_disclosure'
    ));

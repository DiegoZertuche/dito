-- The sentence the twin says on one of its cards (ticket #340; spec #318; the
-- UX spine's movement 6, «Ven conmigo»; ADR-0008, ADR-0013, ADR-0020,
-- ADR-0037).
--
-- NUMBERING: …20261006100010, after …20261005100020 (the door's corrections,
-- #344). Forward-only: no migration in this repo is ever edited once it has
-- applied anywhere.
--
-- The rep taps the twin's mark in the pill and it follows them onto a card; the
-- twin may say one sentence there with its `say_on_card` tool. The sentence
-- is a post of the unasked line's kind — delivered to the dashboard's door
-- only, no notice, no draft, no knock (`posts_unasked_door_only_check`) — so
-- the day's thread keeps it as one of the twin's own lines with nothing new
-- to read it. What it adds is the card it was said on, which is what lets the
-- canvas draw it under that card's text.
--
-- ═══ ONE COLUMN ON `posts`, NOT A TABLE OF ITS OWN ═══
--
-- The sentence IS a post: its words are sealed in `parts_enc` under the twin
-- DEK (ADR-0008) as every post's are, its execution is `execution_id`, and
-- the exchanges read and the feed already open it. A table beside it would
-- hold one opaque id per row and a second place a reader must join to learn
-- what one post is. The column is that id.
--
-- METADATA, IN THE CLEAR: an opaque post id, the shape `post_knocks.post_id`
-- and `dashboard_acts.post_id` already have. Nothing anybody said — FR-73's
-- custody of `posts` stays `dek-ciphertext`.
--
-- SCOPED TO THE TWIN, by the composite key `posts_twin_scoped_key` gives
-- (…20261004100010): a sentence naming another twin's card would satisfy a
-- plain foreign key.
--
-- ONLY ON AN UNASKED LINE, and never on itself, by CHECKs: a draft, a notice
-- or an answer to a message is no sentence said on a card.
--
-- THE ROW STAYS IMMUTABLE: the column is written by the INSERT and the
-- trigger on `posts` refuses everything after it — the twin's next sentence
-- on the same card is a new post, and the page draws the newest. The grants
-- are untouched: table-level SELECT and INSERT reach the new column without a
-- statement here, and nothing is granted to anyone new.

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS on_post_id uuid;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_on_post_fkey;
ALTER TABLE posts
    ADD CONSTRAINT posts_on_post_fkey
    FOREIGN KEY (twin_id, on_post_id) REFERENCES posts (twin_id, id);

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_on_post_unasked_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_on_post_unasked_check
    CHECK (on_post_id IS NULL OR (unasked AND on_post_id <> id));

CREATE INDEX IF NOT EXISTS posts_on_post
    ON posts (twin_id, on_post_id, posted_at)
    WHERE on_post_id IS NOT NULL;

COMMENT ON COLUMN posts.on_post_id IS
    'Ticket #340: the twin''s card this unasked line was said on (say_on_card) — drawn under that card''s text on the dashboard, kept in the day''s thread as one of the twin''s own lines. NULL on every other post. Metadata only; the sentence is sealed in parts_enc.';

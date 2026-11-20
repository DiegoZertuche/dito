-- The fill's stop marker on the chat directory, and the fact that a fill
-- resumed (ticket #245 F17 and the F23 rider; boundary #225's ruling round of
-- 2026-09-09; spec #214 *Link day, in detail*, *Roles and grants*; ADR-0005,
-- ADR-0008, ADR-0010, ADR-0023, ADR-0025).
--
-- NUMBERING: …20260909100020, after …20260909100010 (a failed execution's
-- marker word, #240). Forward-only: no migration in this repo is ever edited once it has
-- applied anywhere, because a migration is a statement about what a database
-- has already been through.
--
-- ═══ WHY THE ROW NEEDS THE FILL'S END ═══
--
-- The fill's end lived on `plane_requests` alone — its `stopped_by` word — and
-- rep-web holds no grant on that table and must not: a dashboard that could
-- read the plane's asks could read every chat a rep ever scoped. So Inicio's
-- fill card INFERRED «still working» from how long ago a page had landed, and
-- on the rig it sat on «Trayendo tu historial … Ya llegó hasta el domingo, 17
-- de mayo» long after the fill had stopped at the ninety-day line, and past
-- that line's own date (boundary #225, F17).
--
-- So the same fact is stamped where the card may read it: WHEN this chat's
-- last fill attempt ended and WHICH WORD it ended with. The plane stamps it at
-- every end; a new fill clears it; the card reads it and infers nothing.
--
-- ═══ CONTENT-FREE, AND THAT IS WHAT KEEPS THE CLASS UNCHANGED ═══
--
-- Both columns are the PLANE's own account of its own work: an instant this
-- database's clock produced and a word out of a closed set this repo owns.
-- Neither says anything a rep or a customer said, neither names a chat beyond
-- the row it sits on, and neither can hold a sentence — the CHECK below is a
-- membership and not a shape. `chat_directory` therefore keeps its FR-73 class
-- (`dek-ciphertext`, for `name_enc` alone) and its registry note grows by these
-- three columns.
--
-- ═══ THE RESUMED FACT IS STAMPED AND NEVER INFERRED (the F23 rider) ═══
--
-- A message that arrived while a chat was OUT of scope is not recoverable by a
-- later fill, by construction: the on-demand request returns only messages
-- OLDER than its anchor, and the plane pages backwards from the newest message
-- it knows. So a chat scoped out and back in has a hole in it, and the rep is
-- told at the moment the hole is made rather than discovering it in a draft
-- that misses a week.
--
-- IT CANNOT BE INFERRED FROM ACTS, which is why it is a column. rep-web can see
-- that a row has pages and that a fill is running, but once the new fill has
-- moved the page count the two shapes — a first fill and a resumed one — are
-- identical. Only the plane knows what stood on the row at the moment the fill
-- began, and it knows it for exactly one statement.
--
-- ═══ IDEMPOTENT OVER EXISTING ROWS, AND OVER ITSELF ═══
--
-- The rig has `chat_directory` rows with `fill_pages` 1 and 2, `plane_requests`
-- rows of every kind, and a group's row whose fill failed. This file must
-- survive being applied over them and applied twice: `ADD COLUMN IF NOT EXISTS`
-- on the three columns, `DROP CONSTRAINT IF EXISTS` + `ADD` on each constraint,
-- and a default on the boolean so every existing row satisfies its NOT NULL
-- without a backfill statement. Atlas never re-applies a file; what that is for
-- is an OPERATOR replaying it by hand against a database whose revision history
-- says nothing — the rehearsal #218, #220, #221, #223 and #224 each ran, and
-- this one ran too, over planted rows.
--
-- EVERY STAMP DEFAULTS TO `clock_timestamp()` WHERE IT DEFAULTS AT ALL (PR
-- #213's rule). `fill_stopped_at` has no default on purpose — an absent marker
-- is the running state, so a default would make every row born stopped — and
-- the plane writes `clock_timestamp()` into it, never `now()`, which pins to
-- transaction start and would tie the final page's stamp with the page's own.

-- ── The marker, and the resumed fact ──────────────────────────────────────

ALTER TABLE chat_directory
    -- WHEN this chat's last fill attempt ended. NULL is «a fill is running or
    -- none has ended yet», which is the state the card renders as «Trayendo tu
    -- historial»: the running state is an ABSENCE rather than a word, so a
    -- plane that stamped nothing can never read as finished.
    ADD COLUMN IF NOT EXISTS fill_stopped_at timestamptz,
    -- ...AND WHICH WORD IT ENDED WITH, out of the closed set below. Fourteen
    -- words rather than the seven `plane_requests.stopped_by` holds, because
    -- that column answers "how did a SERVED fill end" and this one answers
    -- "how did this chat's ATTEMPT end" — and an attempt refused by name,
    -- failed, or cut off by a plane that went away ended just as finally. See
    -- the CHECK.
    ADD COLUMN IF NOT EXISTS fill_stopped_by text,
    -- WHETHER THE CURRENT ATTEMPT BEGAN OVER HISTORY THAT WAS ALREADY THERE —
    -- the chat was scoped out and back in, so there is a hole a fill cannot
    -- close (the header argues it). Written by the plane in the same statement
    -- that clears the marker, from the page count that stood at that instant;
    -- false for a first fill, and NOT NULL with a default so the rig's existing
    -- rows are correct the moment this applies.
    ADD COLUMN IF NOT EXISTS fill_resumed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN chat_directory.fill_stopped_at IS
    'When this chat''s last fill attempt ended, stamped by the plane at EVERY end and cleared when a new fill starts (ticket #245). NULL is the running state, which is why it is an absence rather than a word: Inicio''s fill card reads this instead of inferring «still working» from how long ago a page landed (boundary #225, F17). The plane''s own clock instant — never anything a rep or a customer said.';
COMMENT ON COLUMN chat_directory.fill_stopped_by IS
    'Which word the attempt ended with — THE WORD THE REQUEST ROW CARRIES, which is why the set is `plane_requests.stopped_by`''s seven stops plus the seven reasons a scope-in''s own row can hold. A wider set than `stopped_by` on purpose: that column answers how a SERVED fill ended, and an attempt refused by name, failed, or cut off by a plane that went away ended just as finally — so a refusal that left no marker would leave the card running for ever over a chat nothing will ever fill (ticket #245). The vocabulary is `plane/planereq`''s `FillStops` and this CHECK is its other half.';
COMMENT ON COLUMN chat_directory.fill_resumed IS
    'Whether the current fill attempt began over history that was already on the row — the chat was scoped out and back in (ticket #245, the F23 rider). A message that arrived while a chat was out of scope is not recoverable by a later fill: the on-demand request returns only messages OLDER than its anchor. Stamped by the plane from the page count that stood when the fill began, because once the new fill moves that count a first fill and a resumed one are identical — so the fact cannot be inferred, and rep-web never infers it.';

-- THE CLOSED SET, AND IT IS DERIVED FROM THE PLANE'S OWN TWO (ticket #245).
--
-- `plane/planereq`'s `FillStops` builds this list from `Stops` and the
-- scope-in refusals rather than restating the spellings, and
-- `planereq_test.go` sweeps this constraint against it — the shape
-- `plane_requests`' four vocabularies are already pinned in. The hazard is the
-- sharpest one this repo has: the marker is stamped in the SAME statement as
-- the final page's progress, so a word the store refuses rolls back a page of
-- the rep's history that the seam already holds.
--
-- WHY `no_directory_row` IS IN IT: the fill stamps its outcome by one rule with
-- no exception, and the marker is an UPDATE keyed by the twin and the chat — so
-- for a chat the directory has never seen it finds no row to mark, which is the
-- same absence the word names. WHY `already_linked` AND `malformed_parameter`
-- ARE NOT: the first is the pairing ask's, and the second belongs to a row
-- whose chat does not parse, which no directory row names.
ALTER TABLE chat_directory DROP CONSTRAINT IF EXISTS chat_directory_fill_stopped_by_check;

ALTER TABLE chat_directory
    ADD CONSTRAINT chat_directory_fill_stopped_by_check
        CHECK (fill_stopped_by IS NULL
               OR fill_stopped_by IN ('ninety_day_line',
                                      'empty_page',
                                      'no_more_on_primary',
                                      'no_access',
                                      'wait_timeout',
                                      'anchor_repeated',
                                      'descoped',
                                      'no_directory_row',
                                      'no_anchor',
                                      'no_lid',
                                      'no_history_window',
                                      'rail_not_linked',
                                      'pass_failed',
                                      'interrupted'));

-- A MARKER IS BOTH HALVES OR NEITHER. An instant with no word would say a fill
-- ended and refuse to say how; a word with no instant would say how and refuse
-- to say when — and the card decides the running state from the INSTANT, so a
-- half-written marker would read as still working while the row named its own
-- stop. `chat_directory_anchor_whole_check` is the same claim about the anchor.
ALTER TABLE chat_directory DROP CONSTRAINT IF EXISTS chat_directory_fill_stop_whole_check;

ALTER TABLE chat_directory
    ADD CONSTRAINT chat_directory_fill_stop_whole_check
        CHECK ((fill_stopped_at IS NULL) = (fill_stopped_by IS NULL));

-- ── THE ATTEMPTS THAT ENDED BEFORE THE MARKER EXISTED ─────────────────────
--
-- A ROW WITH NO MARKER IS THE RUNNING STATE, so every directory row this
-- database already holds would read as a fill still working — and the card that
-- reads it would stand on Inicio for ever over chats whose ninety days arrived
-- last week. The rig has exactly those rows: a chat filled to the line, and a
-- group whose fill ended `pass_failed` in eight milliseconds (boundary #225).
--
-- AND THE ANSWER IS THE MARKER'S OWN DEFINITION APPLIED BACKWARDS. The marker
-- says "the word the request row carries", and the requests are still here — so
-- the newest SETTLED scope-in per chat is exactly what the fill would have
-- stamped, at exactly the instant it settled. Nothing is guessed: a chat whose
-- scope-in was never settled keeps no marker, which is honest, because either
-- it is pending (the plane will serve it and stamp its own end) or it was taken
-- by a process that went away — and the next start settles it and marks the row
-- through `SettleStranded`.
--
-- «NEWEST» IS WHEN IT WAS ASKED AND NOT WHEN IT SETTLED, which is the same rule
-- `directory.ProjectStops` reads by and argues in full: settling is absorbed on
-- failure, so an earlier ask can settle AFTER a later one and ordering by
-- settlement would pick the older attempt's word.
--
-- `malformed_parameter` IS THE ONE WORD EXCLUDED: it belongs to a request whose
-- chat does not parse, so it names no directory row, and the CHECK above does
-- not hold it.
UPDATE chat_directory d
   SET fill_stopped_at = r.settled_at,
       fill_stopped_by = COALESCE(r.stopped_by, r.reason),
       updated_at = clock_timestamp()
  FROM (SELECT DISTINCT ON (twin_id, chat_jid)
               twin_id, chat_jid, settled_at, stopped_by, reason
          FROM plane_requests
         WHERE kind = 'scope_in'
           AND outcome IS NOT NULL
           AND settled_at IS NOT NULL
           AND COALESCE(stopped_by, reason) <> 'malformed_parameter'
         ORDER BY twin_id, chat_jid, requested_at DESC, id DESC) r
 WHERE d.twin_id = r.twin_id
   AND d.chat_jid = r.chat_jid
   AND d.fill_stopped_at IS NULL;

-- ...AND THE RESUME IS NOT BACKFILLED, deliberately: whether an attempt began
-- over history that was already there is knowable only in the statement that
-- began it (`chat_directory.fill_resumed`'s own comment), so the default
-- `false` stands for every row that predates the column. A rep who marks a
-- chat again after this applies is told, which is what the fact is for.

-- ── ...AND rep-web READS THE MARKER, COLUMN BY COLUMN ─────────────────────
--
-- Spec #214 *Roles and grants*: "SELECT on … the chat directory's plaintext
-- columns". The list is pinned in `@dito/aperture`'s `REP_WEB_COLUMN_REACH`
-- and diffed against this catalog in both directions by FR-71a's rep-web
-- clause, so this block and that constant are one statement written twice.
--
-- THREE COLUMNS AND NOT THE TABLE. `name_enc` is still the sealed one and
-- rep-web still holds no key (ADR-0008's custody of two), so the grant stays
-- column-level — `has_table_privilege` cannot express "everything but one".
-- The three added here are the marker's two halves and the resumed fact, which
-- are exactly what the card renders its four states from; the anchor columns,
-- the LID and the two stamps stay out.
GRANT SELECT (fill_stopped_at, fill_stopped_by, fill_resumed)
    ON chat_directory TO dito_rep_web;

-- ...AND WHEN THE CHAT WAS SCOPED, which is the one thing that tells a STALE
-- marker from a live one (ticket #245).
--
-- The plane clears the marker when a fill STARTS, and it serves requests one at
-- a time — so a rep who re-scopes a chat while another chat's fill is running
-- has a row that still carries LAST month's stop for as long as the queue
-- takes. Read against the scoping's own instant, that marker is visibly older
-- than the ask it would answer, and the card says «Trayendo tu historial» from
-- the moment the rep pressed the switch rather than from the moment the plane
-- got round to it.
--
-- …20260908100070 withheld this column because "nothing renders when a chat was
-- scoped". Something does now: not the instant itself, which no page shows, but
-- the comparison that decides whether the fill's marker belongs to this
-- scoping. It is plaintext metadata beside the two columns that role already
-- reads, and the writer is still the runtime's scope act rather than a page.
GRANT SELECT (created_at) ON scope_allowlist TO dito_rep_web;

-- AND NOTHING ELSE, SAID OUT LOUD. The REVOKEs are statements rather than
-- changes — nothing above granted any of this — and they are here so the GRANT
-- DIFF says so too, and so a later migration handing one of them over is
-- visible in FR-71a's own diff (…20260908100050's block makes this argument).
--
-- rep-web STILL READS NO PLANE REQUEST. The marker exists precisely so that it
-- does not have to: the fill's end is on the directory row now, and the ask
-- that produced it stays the plane's own business.
REVOKE ALL ON plane_requests FROM dito_rep_web;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON scope_allowlist FROM dito_rep_web;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON chat_directory FROM dito_rep_web;

-- The twin thread's day-long session (ticket #319; spec #318 decisions 1,
-- 8, 11, 13 and 14; design D1, D3 and D7; ADR-0014 and ADR-0012 as amended
-- 2026-09-27).
--
-- NUMBERING: …20261003100010, after …20260926100010. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ THREE THINGS ═══
--
--   THE SESSION ROW — one row per Agent SDK session the twin thread holds: the
--   twin, the seat-local day it belongs to, its id, the session it carried
--   from, when it opened, when its last turn ended, the last entry it keeps,
--   the turn in flight, and when it closed. METADATA ONLY: the session
--   itself is the child's file under the twin's harness directory, FR-73's
--   recorded gap until the per-twin volume (spec #318 decision 3). Nothing
--   anybody said can reach a column here.
--
--   A WORD FOR A FOLDED LINE — both doors' processing markers gain `folded`:
--   a rep line that reached a running turn at its next tool boundary and was
--   answered by that turn's one result, whose execution record is keyed to
--   the first line's trigger (design D7). Never a second record for a turn.
--
--   AN ANSWER NOBODY ASKED FOR — a turn the seam's events woke has no rep
--   message under it, so an answer notice may anchor on nothing when an
--   execution composed it.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE SESSION ROW
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS thread_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- THE SEAT-LOCAL DAY the session belongs to, cut in the zone the «now»
    -- recipe, the arrival's day and the exchanges read already use. A
    -- session that ran past midnight because the rep was mid-exchange
    -- keeps the day it opened in (spec #318 decision 1).
    day date NOT NULL,
    -- The child's own id, the name of its file. Chosen by the runtime when the
    -- session opens or forks, so this row exists before the file does.
    session_id uuid NOT NULL
        CONSTRAINT thread_sessions_session_unique UNIQUE,
    -- WHAT IT CARRIED FROM: yesterday's session whose tail it opened with, or
    -- the session a failed turn was forked out of. NULL on a twin's first.
    previous_session_id uuid,
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- When its last turn ended — what the ten-minute rule is measured from.
    last_turn_at timestamptz,
    -- THE LAST ENTRY THE SESSION KEEPS, and THE TURN IN FLIGHT: two
    -- message ids, so a runtime that restarts in the middle of a turn resumes
    -- without it (`resumeSessionAt` + `resumeDropsTurn`) instead of carrying a
    -- half-written turn into the day.
    kept_through uuid,
    open_turn uuid,
    closed_at timestamptz,
    -- THE CLI'S REFUSAL OF A TRUNCATING RESUME, kept as the evidence the SDK
    -- asks for: entry ids and entry types, never content. The session
    -- was resumed plainly and still holds the failed turn.
    resume_refusal text,
    CONSTRAINT thread_sessions_closed_after_open_check
        CHECK (closed_at IS NULL OR closed_at >= opened_at),
    CONSTRAINT thread_sessions_refusal_check
        CHECK (resume_refusal IS NULL OR resume_refusal NOT LIKE '%@%')
);

COMMENT ON TABLE thread_sessions IS
    'Ticket #319: one row per Agent SDK session the twin thread holds — one per rep per seat-local day, plus one per fork that dropped a failed turn. Metadata only: the conversation is the SDK child''s file under the twin''s harness directory (FR-73''s recorded gap, spec #318 decision 3).';
COMMENT ON COLUMN thread_sessions.kept_through IS
    'The last entry of the conversation that is kept: the last entry of its last good turn, or an append after it. A truncating resume cuts there (ticket #319).';
COMMENT ON COLUMN thread_sessions.open_turn IS
    'The prompt of the turn in flight, NULL between turns. A runtime that finds one set on restart drops that turn on resume (ticket #319).';

-- ONE OPEN SESSION PER TWIN, by the store and not by the runtime's care: two
-- processes, or two wakes racing past the runtime's own lock, cannot both
-- open a session for one twin.
CREATE UNIQUE INDEX IF NOT EXISTS thread_sessions_one_open
    ON thread_sessions (twin_id) WHERE closed_at IS NULL;
-- The read a runtime makes on its first wake: the twin's newest session.
CREATE INDEX IF NOT EXISTS thread_sessions_by_twin
    ON thread_sessions (twin_id, opened_at DESC);

-- THE LEASE HOLDER WRITES IT AND NOTHING ELSE TOUCHES IT: rep-web never
-- reads a session (the bar's history reads the door's rows, spec #318
-- decision 13). UPDATE because a session's row moves as the day does — its
-- last turn, its kept entry, its close — and never DELETE: the day's id is
-- what tomorrow's carry names.
GRANT SELECT, INSERT, UPDATE ON thread_sessions TO dito_twin_runtime;
REVOKE DELETE, TRUNCATE ON thread_sessions FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. A FOLDED LINE, ON BOTH DOORS
-- ═══════════════════════════════════════════════════════════════════════
--
-- Both CHECKs are re-cut together with the same word added, because one
-- vocabulary serves both doors (`markThreadMessage`) and
-- `migration-vocabulary.test.ts` holds them to each other.

ALTER TABLE wa_event_processing
    DROP CONSTRAINT wa_event_processing_disposition_check;
ALTER TABLE wa_event_processing
    ADD CONSTRAINT wa_event_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'drafted_in_batch',
        'answered_by_rep',
        'affirmed',
        'affirmation_refused',
        'dismissed',
        'binding_confirmed',
        'declined',
        'question_answered',
        'question_answer_refused',
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored',
        'retracted',
        'correction_refused',
        'execution_failed',
        'folded'
    ));

ALTER TABLE dashboard_message_processing
    DROP CONSTRAINT dashboard_message_processing_disposition_check;
ALTER TABLE dashboard_message_processing
    ADD CONSTRAINT dashboard_message_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'drafted_in_batch',
        'answered_by_rep',
        'affirmed',
        'affirmation_refused',
        'dismissed',
        'binding_confirmed',
        'declined',
        'question_answered',
        'question_answer_refused',
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored',
        'retracted',
        'correction_refused',
        'execution_failed',
        'folded'
    ));

-- ═══════════════════════════════════════════════════════════════════════
-- 3. AN ANSWER NOBODY ASKED FOR
-- ═══════════════════════════════════════════════════════════════════════
--
-- An answer still anchors on the rep's message whenever there is one, and
-- one answer per message stays a unique index (`notices_one_answer_per_event`,
-- unchanged). What is admitted is the answer of a turn an EVENT woke — a post
-- landed, the rail moved — composed by an execution with no rep message under
-- it: strictly weaker than the CHECK it replaces, so every standing row
-- survives.
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_answer_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_answer_about_event_check
    CHECK (kind <> 'answer' OR about_event_id IS NOT NULL OR execution_id IS NOT NULL);

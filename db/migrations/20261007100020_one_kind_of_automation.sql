-- Ticket #364: one kind of automation. Dito's own automations become rows
-- beside the rep's rutinas, the clock store fires every schedule and keeps
-- every row it ever held, the reminders become one-shot rows that wake the
-- thread, and the nudge retires (spec #318 decision 26 as amended; ADR-0014,
-- ADR-0031 and ADR-0010 as amended 2026-10-06/07).
--
-- EIGHT CHANGES IN ONE FILE, in the order the code needs them:
--
--   1. `automations` holds Dito's own: `origin = 'dito'` and the `shipped`
--      name — drafting, extraction, the daily disclosure, the reminders, the
--      overnight requests — one row of each per seat. A Descartar or a replacement marks the row
--      ended instead of deleting it, because its cadence row may not be deleted.
--   2. `schedules` carries a cadence's precondition by name, an ended mark,
--      and the reminders' one-shot rows (a post and the subject that can
--      expire); its automation reference RESTRICTs a delete instead of
--      cascading one, so the clock store's rows are never deleted, not even by
--      cascade (ADR-0010, 2026-10-06).
--   3. `automation_pauses` keeps one way to name what is switched: the row.
--   4. `runs` of Dito's automations name their row.
--   5. `nudged` leaves the dispositions, the `nudges` table goes, and notify's
--      `nudge` message becomes `reminder` — the knock a reminder fired.
--   6. `post_knocks` holds one knock per post and reminder: the landing knock
--      and one more for each reminder that fired for the card (ADR-0031,
--      2026-10-07).
--   7. The day's read and the day's post name the step that wrote them, and
--      the step's record is written after its tool ran, so the two references
--      are checked at COMMIT.
--   8. A rep's request starts the automation's run, names it, and is answered
--      when the run ends; an automation the rep switched off refuses it.
--
-- THE RIG'S SHIPPED SWITCHES AND ITS NUDGES ARE NOT CARRIED. Pre-pilot rig
-- data is disposable (2026-09-03); a switch named by its shipped word has no
-- row to point at until the runtime writes Dito's rows on its first pass, and
-- a nudge's sentence is a push that already went.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. DITO'S AUTOMATIONS ARE ROWS
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_origin_check;
ALTER TABLE automations
    ADD CONSTRAINT automations_origin_check CHECK (origin IN ('rep', 'twin', 'dito'));

-- WHICH OF DITO'S DEFINITIONS THE ROW RUNS, by its name; a rep's rutina has none.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS shipped text
    CONSTRAINT automations_shipped_check
    CHECK (shipped IS NULL OR shipped IN ('drafting', 'extraction', 'daily_disclosure', 'reminders',
                                          'overnight_requests'));

ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_shipped_origin_check;
ALTER TABLE automations
    ADD CONSTRAINT automations_shipped_origin_check CHECK ((origin = 'dito') = (shipped IS NOT NULL));

ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_one_shipped_per_seat;
ALTER TABLE automations
    ADD CONSTRAINT automations_one_shipped_per_seat UNIQUE (seat_id, shipped);

-- WHEN THE ROW STOPPED FIRING: Descartar, or Activar on the version that
-- replaces it. The row stays, with its schedule rows and its runs pointing at
-- it.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS ended_at timestamptz;

-- A SCHEDULE WITH NO CADENCE OF ITS OWN fires from one-shot rows only — the
-- reminders' rows, each written when its subject is born.
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_schedule_check;
ALTER TABLE automations
    ADD CONSTRAINT automations_schedule_check
        CHECK (wake <> 'schedule'
               OR (trigger_event IS NULL AND trigger_customer IS NULL
                   AND ((every IS NULL AND weekday IS NULL AND at_hour IS NULL)
                        OR (every IS NOT NULL AND at_hour IS NOT NULL
                            AND (every = 'week') = (weekday IS NOT NULL)))));

COMMENT ON TABLE automations IS
    'Tickets #325, #364: one row per automation of a seat — Dito''s own (origin dito, its shipped name) and the rutinas the twin authored — with who asked, the FR-75 state, the pinned definition digest, the wake as metadata (a cadence, a seam event kind and a customer reference, or one-shot rows only), the version it would replace, and four instants. Never deleted: Descartar and a replacement set ended_at. Metadata only: a rutina''s definition and the twin''s sentence about it are in the bundle under the twin''s key (ADR-0014).';

REVOKE DELETE, TRUNCATE ON automations FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE CLOCK STORE
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS precondition text
    CONSTRAINT schedules_precondition_check
    CHECK (precondition IS NULL OR precondition IN ('seam_settled_and_chat_day_unsettled',
                                                    'runs_settled_and_disclosure_owed_and_day_unposted',
                                                    'customer_chat_traffic_overnight'));

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS ended_at timestamptz;

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS post_id uuid
    CONSTRAINT schedules_post_fkey REFERENCES posts (id);

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS subject text
    CONSTRAINT schedules_subject_check
    CHECK (subject IS NULL OR subject IN ('question_expiring', 'window_closing', 'draft_waiting'));

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_automation_fkey;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_automation_fkey
        FOREIGN KEY (automation_id) REFERENCES automations (id) ON DELETE RESTRICT;

-- A PRECONDITION IS A CADENCE'S; A REMINDER IS ONE ONE-SHOT ROW about one
-- post, of one of Dito's automations, never a run's wait.
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_reminder_check;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_reminder_check
        CHECK ((post_id IS NULL) = (subject IS NULL)
               AND (post_id IS NULL OR (kind = 'once' AND automation_id IS NOT NULL))
               AND (precondition IS NULL OR kind = 'cadence'));

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_one_reminder_per_subject;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_one_reminder_per_subject UNIQUE (post_id, subject);

-- ONE LIVE CADENCE PER AUTOMATION: an ended one stays beside it.
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_one_per_rutina;
CREATE UNIQUE INDEX IF NOT EXISTS schedules_one_cadence_per_automation
    ON schedules (automation_id) WHERE kind = 'cadence' AND ended_at IS NULL;

-- The reminders' read: the one-shot rows of an automation not yet fired.
CREATE INDEX IF NOT EXISTS schedules_reminders_due
    ON schedules (twin_id, fire_at) WHERE post_id IS NOT NULL AND fired_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. ONE SWITCH, ONE ROW
-- ═══════════════════════════════════════════════════════════════════════

DELETE FROM automation_pauses WHERE automation_id IS NULL;
ALTER TABLE automation_pauses DROP CONSTRAINT IF EXISTS automation_pauses_one_automation_check;
ALTER TABLE automation_pauses DROP CONSTRAINT IF EXISTS automation_pauses_one_per_shipped;
ALTER TABLE automation_pauses DROP CONSTRAINT IF EXISTS automation_pauses_shipped_check;
ALTER TABLE automation_pauses DROP COLUMN IF EXISTS shipped;
ALTER TABLE automation_pauses ALTER COLUMN automation_id SET NOT NULL;

COMMENT ON TABLE automation_pauses IS
    'Tickets #325, #364: the pause switch on Rutinas, one row per seat and automation whose switch the rep has touched — Dito''s own and the rep''s alike, by the automation''s row — and whether it stands at «En pausa». Every wake consults it before it creates anything; the gate re-asserts it in the statement that moves a run. Metadata only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. A RUN OF DITO'S NAMES ITS ROW
-- ═══════════════════════════════════════════════════════════════════════
--
-- `automation` stays the word the row carries — `rutina` for the rep's, the
-- shipped name for Dito's — and `automation_id` names the row whenever a wake
-- or a firing of an automation started it.

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_rutina_check;
ALTER TABLE runs
    ADD CONSTRAINT runs_rutina_check
        CHECK ((automation NOT IN ('rutina', 'extraction', 'daily_disclosure') OR automation_id IS NOT NULL)
               AND (woken_by IS NULL OR automation_id IS NOT NULL));

-- ═══════════════════════════════════════════════════════════════════════
-- 5. THE NUDGE RETIRES
-- ═══════════════════════════════════════════════════════════════════════
--
-- NARROWED, AND NOT VALID: an execution row is a record of a turn that ran
-- and its chain entry attests to its word, so the narrowed CHECK binds every
-- new record and is never re-checked against one already written
-- (`migration-vocabulary.test.ts`' `NARROWED_ONCE`).

ALTER TABLE executions
    DROP CONSTRAINT IF EXISTS executions_disposition_check;
ALTER TABLE executions
    ADD CONSTRAINT executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted', 'asked')) NOT VALID;

ALTER TABLE owner.executions
    DROP CONSTRAINT IF EXISTS owner_executions_disposition_check;
ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted', 'asked')) NOT VALID;

DROP TABLE IF EXISTS nudges;

-- A send is a record of what reached a phone, so the narrowed CHECK is NOT
-- VALID for the same reason.
ALTER TABLE notify_sends DROP CONSTRAINT IF EXISTS notify_sends_message_type_check;
ALTER TABLE notify_sends
    ADD CONSTRAINT notify_sends_message_type_check
    CHECK (message_type IN ('invitation', 'login_code', 'draft_ready',
                            'question_asked', 'reminder', 'rail_dropped',
                            'rail_logged_out')) NOT VALID;

COMMENT ON COLUMN notify_sends.message_type IS
    'The closed catalog''s name for the message: invitation · login_code (email) · draft_ready · question_asked (push, a card''s landing knock) · reminder (push, the knock a reminder fired for a card) · rail_dropped · rail_logged_out (email and push, code-written). The vocabulary is `@dito/notify`''s constant and this column''s CHECK is its other half (ADR-0022 as amended).';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. A KNOCK PER POST AND REMINDER
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE post_knocks ADD COLUMN IF NOT EXISTS subject text
    CONSTRAINT post_knocks_subject_check
    CHECK (subject IS NULL OR subject IN ('question_expiring', 'window_closing', 'draft_waiting'));

ALTER TABLE post_knocks DROP CONSTRAINT IF EXISTS post_knocks_pkey;
ALTER TABLE post_knocks DROP CONSTRAINT IF EXISTS post_knocks_one_per_reminder;
ALTER TABLE post_knocks
    ADD CONSTRAINT post_knocks_one_per_reminder UNIQUE NULLS NOT DISTINCT (post_id, subject);

-- A POST THAT LANDED CARRYING ITS OWN KNOCK REFUSES A SECOND LANDING KNOCK;
-- a reminder's knock is its own.
CREATE OR REPLACE FUNCTION post_knocks_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.subject IS NULL AND EXISTS (SELECT 1 FROM posts p
                WHERE p.id = NEW.post_id AND p.knock_disposition = 'carried') THEN
        RAISE EXCEPTION 'post % already carries its own knock (ticket #320): one landing knock per post', NEW.post_id
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON TABLE post_knocks IS
    'Tickets #320, #364: the knock the twin thread decided about a post that had already landed — one landing knock per post, and one more for each reminder that fired for it (subject) — the sentence sealed under the twin DEK, the execution, the instant. Joined into a post''s parts by every reader; delivered by the runtime''s at-once tier.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7. THE STEP'S RECORD IS WRITTEN AFTER ITS TOOL
-- ═══════════════════════════════════════════════════════════════════════
--
-- `file_facts` settles the claim and `post_disclosure` records the day's
-- attempt inside the agent step's turn, naming the step's execution, whose
-- row is written when the turn ends — so each reference is checked at COMMIT,
-- as `notices.execution_id` already is (…20260906100030).

ALTER TABLE extraction_runs
    ALTER CONSTRAINT extraction_runs_execution_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE disclosure_attempts
    ALTER CONSTRAINT disclosure_attempts_execution_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- ═══════════════════════════════════════════════════════════════════════
-- 8. A REQUEST STARTS A RUN
-- ═══════════════════════════════════════════════════════════════════════
--
-- A rep's ask for the day's extraction or its disclosure starts the same run
-- the clock fires, with the rep as its creator; the request names that run,
-- and it is answered when the run ends, with the executions its steps wrote.
-- An automation whose switch stands at «En pausa» starts nothing, and the
-- ask is told why.

ALTER TABLE runtime_requests ADD COLUMN IF NOT EXISTS run_id uuid
    CONSTRAINT runtime_requests_run_fkey REFERENCES runs (id);

ALTER TABLE runtime_requests
    DROP CONSTRAINT IF EXISTS runtime_requests_reason_check;
ALTER TABLE runtime_requests
    ADD CONSTRAINT runtime_requests_reason_check
        CHECK (reason IS NULL OR reason IN ('malformed_parameter',
                                            'rail_not_linked',
                                            'chat_in_flight',
                                            'pass_failed',
                                            'interrupted',
                                            'day_not_lived',
                                            'automation_paused'));

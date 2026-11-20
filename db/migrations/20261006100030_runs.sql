-- Workflow runs, their step checkpoints and the clock store (ticket #323;
-- spec #318 decisions 4, 22–26; ADR-0012 as amended 2026-09-27: a workflow run
-- is a session, run rows and step checkpoints are opaque seam rows; ADR-0014:
-- the clock engine reads Schedule rows off a store).
--
-- NUMBERING: …20261006100030, after …20261006100020. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ FOUR THINGS ═══
--
--   THE RUN ROW — one per workflow run: the twin, the seat it serves, which
--   automation it runs (a shipped definition's name, or `inline` for one the
--   twin thread wrote for a one-off job), the digest of the definition it
--   pinned at its start, its parent (NULL until child runs, #324), its Agent
--   SDK session id, its state and the step it stands at, its one budget and
--   what it has spent of it, the two flags, who started it, and five
--   instants.
--
--   THE STEP CHECKPOINT — one row per step that began: its index in the
--   definition, its kind, its state, the execution it left, the card a wait
--   on a settle watches, and its instants.
--
--   THE CLOCK STORE — one row per wake the pass fires at an instant (a run's
--   wait) or on a cadence (a rutina, #325): the twin, when, what it wakes,
--   and when it was fired. The first store the runtime's clock reads (spec
--   #318 decision 26); extraction and the disclosure keep firing from the
--   daily pass.
--
--   A RUN AS A DASHBOARD ACT'S TARGET — Pausar, Reanudar and Cancelar on
--   Trabajos en curso are rep acts on a run, which is neither a card nor a
--   chat nor the notebook: `dashboard_acts` gains `run_id` and three verbs.
--
-- ═══ METADATA ONLY, ALL THREE (FR-73: `no-rep-content`) ═══
--
-- A run's content — its definition with the instructions the twin wrote, its
-- inputs, every step's typed output, the rep's guidance — lives in its SDK
-- session file under the twin's harness directory and in the run's content
-- file beside it, sealed under the twin's key; what a step posts is a post.
-- Nothing anybody said can reach a column here: ids, closed words, counts
-- and instants.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE RUN ROW
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS runs (
    -- Minted by the runtime before the row, so the content file and the
    -- session are named by it from their first byte.
    id uuid PRIMARY KEY,
    twin_id uuid NOT NULL,
    -- THE SEAT THE RUN SERVES: the seat-state gate reads its state before
    -- the pass fires anything for the run (ADR-0012's gate).
    seat_id uuid NOT NULL,
    -- WHICH DEFINITION: a shipped one's registry name, or `inline` for a run
    -- the thread wrote. A lowercase identifier, never a sentence.
    automation text NOT NULL
        CONSTRAINT runs_automation_check
        CHECK (automation ~ '^[a-z][a-z0-9_]{0,63}$'),
    -- THE PIN: the digest of the definition the run started with. A shipped
    -- definition that changes later changes nothing for this run, because the
    -- engine refuses content whose digest is not this one.
    definition_digest text NOT NULL
        CONSTRAINT runs_digest_check
        CHECK (definition_digest ~ '^[0-9a-f]{32}$'),
    parent_run_id uuid REFERENCES runs (id),
    -- The run's own Agent SDK session, the file its agent steps resume.
    session_id uuid NOT NULL
        CONSTRAINT runs_session_unique UNIQUE,
    -- THE FIVE STATES (ADR-0012 as amended; the design's §7.1).
    state text NOT NULL
        CONSTRAINT runs_state_check
        CHECK (state IN ('ready', 'running', 'waiting', 'succeeded', 'failed')),
    -- The index of the step the run stands at: the one running, waiting, or
    -- next to begin; on an ended run, the step it ended at.
    current_step integer NOT NULL DEFAULT 0
        CONSTRAINT runs_current_step_check CHECK (current_step >= 0),
    -- How many steps the pinned definition holds, so Trabajos can say «paso 2
    -- de 3» without opening the content.
    step_count integer NOT NULL
        CONSTRAINT runs_step_count_check CHECK (step_count >= 1),
    -- ONE BUDGET PER RUN, ACROSS STEPS: model calls and tokens, each agent
    -- step's execution counted against it.
    budget_iterations integer NOT NULL
        CONSTRAINT runs_budget_iterations_check CHECK (budget_iterations >= 1),
    budget_tokens integer NOT NULL
        CONSTRAINT runs_budget_tokens_check CHECK (budget_tokens >= 1),
    spent_iterations integer NOT NULL DEFAULT 0
        CONSTRAINT runs_spent_iterations_check CHECK (spent_iterations >= 0),
    spent_tokens integer NOT NULL DEFAULT 0
        CONSTRAINT runs_spent_tokens_check CHECK (spent_tokens >= 0),
    -- THE TWO FLAGS (ADR-0012): a paused run fires nothing until it is taken
    -- up again; a cancelled one is ended at the pass with its report.
    paused boolean NOT NULL DEFAULT false,
    cancelled boolean NOT NULL DEFAULT false,
    -- WHO STARTED IT: the twin thread's turn, the clock (a rutina, #325), or
    -- the rep's own act.
    created_by text NOT NULL
        CONSTRAINT runs_created_by_check
        CHECK (created_by IN ('thread', 'clock', 'rep')),
    -- The execution that started it, when one did: the thread's turn.
    created_by_execution_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- When the engine first took it — what `run.started` is raised at.
    started_at timestamptz,
    last_change_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    CONSTRAINT runs_ended_check
        CHECK ((state IN ('succeeded', 'failed')) = (ended_at IS NOT NULL)),
    CONSTRAINT runs_current_step_in_range_check
        CHECK (current_step < step_count)
);

COMMENT ON TABLE runs IS
    'Ticket #323: one row per workflow run — the twin, the seat, the automation and the pinned definition digest, the parent, the Agent SDK session id, the state and the step it stands at, the budget and its spend, the paused and cancelled flags, who started it, and five instants. Metadata only: the run''s content is its session file and its sealed content file under the twin''s harness directory (spec #318 decisions 3 and 22).';

CREATE INDEX IF NOT EXISTS runs_by_twin_live
    ON runs (twin_id, state) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS runs_by_twin_created
    ON runs (twin_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE STEP CHECKPOINT
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS run_steps (
    run_id uuid NOT NULL REFERENCES runs (id),
    -- The step's index in the pinned definition, its branches laid out in
    -- order. A run moves forward only, so each index begins at most once.
    step_index integer NOT NULL
        CONSTRAINT run_steps_index_check CHECK (step_index >= 0),
    kind text NOT NULL
        CONSTRAINT run_steps_kind_check
        CHECK (kind IN ('agent', 'code', 'act', 'post', 'wait', 'if', 'check')),
    state text NOT NULL
        CONSTRAINT run_steps_state_check
        CHECK (state IN ('running', 'waiting', 'succeeded', 'failed')),
    -- THE EXECUTION THE STEP LEFT — one record and one chain entry per step
    -- that ran, written in the transaction that ends the step.
    execution_id uuid REFERENCES executions (id),
    -- The card a wait on a settle watches: an id, never what it says.
    awaits_post_id uuid,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    PRIMARY KEY (run_id, step_index),
    CONSTRAINT run_steps_ended_check
        CHECK ((state IN ('succeeded', 'failed')) = (ended_at IS NOT NULL)),
    CONSTRAINT run_steps_execution_check
        CHECK ((state IN ('succeeded', 'failed')) = (execution_id IS NOT NULL))
);

COMMENT ON TABLE run_steps IS
    'Ticket #323: one checkpoint per step of a workflow run that began — its index and kind, its state, the execution it left, the card a wait watches, two instants. Metadata only: what the step was told and produced is in the run''s session and sealed content.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE CLOCK STORE
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schedules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- `once` fires at an instant; `cadence` comes round every day at an hour
    -- of the seat's day (ADR-0014's Cadence; the rutinas of #325).
    kind text NOT NULL
        CONSTRAINT schedules_kind_check CHECK (kind IN ('once', 'cadence')),
    fire_at timestamptz,
    every text
        CONSTRAINT schedules_every_check CHECK (every IS NULL OR every IN ('day')),
    at_hour smallint
        CONSTRAINT schedules_at_hour_check CHECK (at_hour IS NULL OR at_hour BETWEEN 0 AND 23),
    -- WHAT IT WAKES: one step of one run, or an automation by name (#325).
    run_id uuid REFERENCES runs (id),
    step_index integer,
    automation text
        CONSTRAINT schedules_automation_check
        CHECK (automation IS NULL OR automation ~ '^[a-z][a-z0-9_]{0,63}$'),
    fired_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT schedules_once_check
        CHECK (kind <> 'once' OR (fire_at IS NOT NULL AND every IS NULL AND at_hour IS NULL)),
    CONSTRAINT schedules_cadence_check
        CHECK (kind <> 'cadence' OR (fire_at IS NULL AND every IS NOT NULL AND at_hour IS NOT NULL)),
    CONSTRAINT schedules_one_target_check
        CHECK ((run_id IS NOT NULL AND step_index IS NOT NULL AND automation IS NULL)
            OR (run_id IS NULL AND step_index IS NULL AND automation IS NOT NULL)),
    -- A run's wait is one row: written once, by whichever of the thread's
    -- start and the engine reaches it first.
    CONSTRAINT schedules_one_per_step UNIQUE (run_id, step_index)
);

COMMENT ON TABLE schedules IS
    'Ticket #323: the clock store — one row per wake the runtime''s pass fires at an instant (a run''s wait) or on a cadence (a rutina, #325), what it wakes, and when it was fired. Read by the pass after the seat-state gate; metadata only.';

-- The pass's one read: this twin's rows not yet fired, by when they fall due.
CREATE INDEX IF NOT EXISTS schedules_due
    ON schedules (twin_id, fire_at) WHERE fired_at IS NULL;

-- THE LEASE HOLDER WRITES ALL THREE AND NOTHING ELSE TOUCHES THEM: rep-web
-- reads runs through the runtime's local API. UPDATE because a run, a step
-- and a schedule move; never DELETE — a run's row is what its executions and
-- its posts are read beside.
GRANT SELECT, INSERT, UPDATE ON runs, run_steps, schedules TO dito_twin_runtime;
REVOKE DELETE, TRUNCATE ON runs, run_steps, schedules FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. A RUN AS A DASHBOARD ACT'S TARGET
-- ═══════════════════════════════════════════════════════════════════════
--
-- THE TABLE IS WIDENED RATHER THAN ONE BORN BESIDE IT: an act on a run is a
-- rep act on the dashboard in every sense the others are — one row per press,
-- the evidence the act's execution names, an outcome the API answered — and
-- audit coverage, the outcome sweep and the immutability trigger already
-- watch this table. A second table would be a second copy of all three.
--
-- `dashboard_acts_one_target_check` says «at most one of the three»;
-- `dashboard_acts_notepad_target_check` keeps the notebook verb naming none
-- and every other verb naming one; `dashboard_acts_run_target_check` says
-- the three run verbs, and only they, name a run. Every existing row names no
-- run, so all three hold over any table the old ones held over.

ALTER TABLE dashboard_acts ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES runs (id);

COMMENT ON COLUMN dashboard_acts.run_id IS
    'The workflow run the rep paused, took up again or cancelled on Trabajos en curso (ticket #323). NULL on every other act — dashboard_acts_run_target_check holds it to the three run verbs.';

ALTER TABLE dashboard_acts DROP CONSTRAINT IF EXISTS dashboard_acts_verb_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_verb_check
        CHECK (verb IN ('dismiss_draft', 'retract_line',
                        'confirm_binding', 'decline_binding',
                        'scope_in', 'scope_out',
                        'edit_notepad',
                        'pause_run', 'resume_run', 'cancel_run'));

ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_one_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_one_target_check
        CHECK (num_nulls(post_id, chat_directory_id, run_id) >= 2);

ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_notepad_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_notepad_target_check
        CHECK (verb IN ('edit_notepad')
               = (num_nulls(post_id, chat_directory_id, run_id) = 3));

-- Read with PostgreSQL's precedence, as «(the verb acts on a run) equals
-- (this row names a run)».
ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_run_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_run_target_check
        CHECK (verb IN ('pause_run', 'resume_run', 'cancel_run')
               = (run_id IS NOT NULL));

COMMENT ON CONSTRAINT dashboard_acts_run_target_check ON dashboard_acts IS
    'Ticket #323: the three run verbs name a run and no other verb does. Swept against DASHBOARD_ACT_TARGET_OF_ROUTE in @dito/seam.';

-- THE IMMUTABILITY TRIGGER LEARNS THE THIRD TARGET: an UPDATE that sets or
-- changes `run_id` is a change to what the act WAS.
CREATE OR REPLACE FUNCTION dashboard_acts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'dashboard_acts are immutable (ticket #224): % refused — an act row is class-2 rep-act evidence (ADR-0003)', TG_OP;
    END IF;
    IF OLD.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % is already stamped (ticket #224) — the outcome is what the rep was told, and a second stamp would rewrite it', OLD.id;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
       OR NEW.twin_id IS DISTINCT FROM OLD.twin_id
       OR NEW.post_id IS DISTINCT FROM OLD.post_id
       OR NEW.chat_directory_id IS DISTINCT FROM OLD.chat_directory_id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.verb IS DISTINCT FROM OLD.verb
       OR NEW.acted_at IS DISTINCT FROM OLD.acted_at THEN
        RAISE EXCEPTION 'dashboard_acts hold one permitted UPDATE (tickets #224, #223, #323): the outcome stamp. Row % tried to change what the act WAS', OLD.id;
    END IF;
    IF NEW.outcome IS NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % cannot be un-stamped (ticket #224) — the entries and rows it authorized name it already', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

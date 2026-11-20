-- Rutinas: the automations the twin authors, the clock that fires them, and
-- the pause switch every automation on Rutinas carries (ticket #325; spec #318
-- decisions 26, 28–31 and 34, as amended 2026-10-06; ADR-0014: an automation
-- is a wake plus a definition, its content in the bundle and an opaque
-- coordination row in the seam; ADR-0012: the seat-state gate and the pause
-- state on every wake; FR-75).
--
-- NUMBERING: …20261006100040, after …20261006100030. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ FIVE THINGS ═══
--
--   THE RUTINA'S ROW (`automations`) — one per automation the twin authored
--   through `create_automation`: whose it is, who asked (the rep, or the twin
--   proposing it), its FR-75 state, the digest of the definition it pinned,
--   its wake as metadata, the version it would replace, and three instants.
--   The definition and the twin's own sentence about it are the bundle's.
--
--   THE PAUSE SWITCH (`automation_pauses`) — one row per seat and automation
--   whose switch the rep has touched on Rutinas: a shipped automation by its
--   registry word, or a rutina by its row.
--
--   THE CADENCE MADE REAL (`schedules`) — a rutina's cadence is one row of
--   the clock store, daily or weekly, with the instant it last fired.
--
--   A RUN BORN OF A RUTINA (`runs`) — the rutina it was born of, what woke it,
--   and `trigger` as a creator beside the clock.
--
--   AN AUTOMATION AS A DASHBOARD ACT'S TARGET — Activar, Descartar and the
--   switch are rep acts on an automation: `dashboard_acts` gains `automation`
--   and four verbs.
--
-- ═══ METADATA ONLY, ALL OF IT (FR-73: `no-rep-content`) ═══
--
-- What a rutina does and what the twin said about it live in the bundle under
-- the twin's key; what is here is ids, closed words, small numbers and
-- instants. A trigger's predicate names an event kind and, optionally, the
-- customer's reference — the bundle's own number for them, never a name or an
-- address — so no predicate reads content (ADR-0012: "wake predicates use a
-- metadata-only vocabulary").

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE RUTINA'S ROW
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS automations (
    -- Minted by the runtime before the row, so the bundle's content is keyed
    -- by it from its first byte.
    id uuid PRIMARY KEY,
    twin_id uuid NOT NULL,
    -- THE SEAT IT SERVES: its runs are this seat's, and the switch is this
    -- seat's (ADR-0012's gate reads the seat's state before it fires).
    seat_id uuid NOT NULL,
    -- WHO ASKED: `rep` when the rep's line asked for it, `twin` when the twin
    -- proposed it and the rep's answer is the evidence (decision 28).
    origin text NOT NULL
        CONSTRAINT automations_origin_check CHECK (origin IN ('rep', 'twin')),
    -- FR-75'S TWO STATES THIS BUILD HOLDS: `pending` until the rep presses
    -- Activar on Rutinas, `active` after. Only an active rutina fires.
    state text NOT NULL
        CONSTRAINT automations_state_check CHECK (state IN ('pending', 'active')),
    -- THE PIN: the digest of the workflow definition in the bundle. A run it
    -- fires starts from exactly this definition; content whose digest is not
    -- this one is refused.
    definition_digest text NOT NULL
        CONSTRAINT automations_digest_check CHECK (definition_digest ~ '^[0-9a-f]{32}$'),
    -- THE WAKE, AS METADATA (ADR-0014's two typed wakes).
    wake text NOT NULL
        CONSTRAINT automations_wake_check CHECK (wake IN ('schedule', 'trigger')),
    -- A schedule: every day or every week, on an ISO weekday (1 = Monday), at
    -- an hour of the seat's day.
    every text
        CONSTRAINT automations_every_check CHECK (every IS NULL OR every IN ('day', 'week')),
    weekday smallint
        CONSTRAINT automations_weekday_check CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
    at_hour smallint
        CONSTRAINT automations_at_hour_check CHECK (at_hour IS NULL OR at_hour BETWEEN 0 AND 23),
    -- A trigger: the seam event it fires on, and optionally the customer it
    -- is about, by the bundle's reference number for them.
    trigger_event text
        CONSTRAINT automations_trigger_event_check
        CHECK (trigger_event IS NULL OR trigger_event IN ('customer_message', 'card_settled')),
    trigger_customer integer
        CONSTRAINT automations_trigger_customer_check
        CHECK (trigger_customer IS NULL OR trigger_customer >= 1),
    -- THE VERSION THIS ONE WOULD REPLACE (FR-75): a change to an active
    -- rutina is a new pending row naming it, and Activar on the new one
    -- deletes the old in the same transaction — so an active rutina is never
    -- edited, and its runs in flight keep their own pinned definition. ON
    -- DELETE CASCADE: once the old version is gone, every other proposal to
    -- replace it is stale and goes with it, so two changes to one rutina can
    -- never both end up active.
    replaces_id uuid
        CONSTRAINT automations_replaces_fkey REFERENCES automations (id) ON DELETE CASCADE,
    -- The thread's turn that wrote it.
    created_by_execution_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    CONSTRAINT automations_activated_check
        CHECK ((state = 'active') = (activated_at IS NOT NULL)),
    CONSTRAINT automations_schedule_check
        CHECK (wake <> 'schedule'
               OR (every IS NOT NULL AND at_hour IS NOT NULL
                   AND (every = 'week') = (weekday IS NOT NULL)
                   AND trigger_event IS NULL AND trigger_customer IS NULL)),
    CONSTRAINT automations_trigger_check
        CHECK (wake <> 'trigger'
               OR (trigger_event IS NOT NULL
                   AND every IS NULL AND weekday IS NULL AND at_hour IS NULL))
);

COMMENT ON TABLE automations IS
    'Ticket #325: one row per automation the twin authored (a rutina) — the twin, the seat, who asked, the FR-75 state, the pinned definition digest, the wake as metadata (a cadence, or a seam event kind and a customer reference), the version it would replace, three instants. Metadata only: the workflow definition and the twin''s sentence about it are in the bundle under the twin''s key (ADR-0014).';

CREATE INDEX IF NOT EXISTS automations_by_twin
    ON automations (twin_id, state, created_at);

-- THE ONE TABLE OF THESE FIVE THE RUNTIME MAY DELETE FROM: Descartar removes
-- the rutina, content and row together (decision 28: «both hard-deleted with
-- the automation»), and Activar on a replacement removes the version it
-- replaces. Its cadence and its switch go with it by cascade; the run tables
-- keep DELETE revoked.
GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO dito_twin_runtime;
REVOKE TRUNCATE ON automations FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE PAUSE SWITCH
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS automation_pauses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- PER SEAT (decision 30): the switch is the rep's consent surface.
    seat_id uuid NOT NULL,
    -- WHICH AUTOMATION: a shipped one by its registry word — the three a
    -- switch is offered for — or a rutina by its row, and never both.
    shipped text
        CONSTRAINT automation_pauses_shipped_check
        CHECK (shipped IS NULL OR shipped IN ('extraction', 'daily_disclosure', 'nudge')),
    automation_id uuid
        CONSTRAINT automation_pauses_automation_fkey
        REFERENCES automations (id) ON DELETE CASCADE,
    paused boolean NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT automation_pauses_one_automation_check
        CHECK (num_nulls(shipped, automation_id) = 1),
    CONSTRAINT automation_pauses_one_per_shipped UNIQUE (seat_id, shipped),
    CONSTRAINT automation_pauses_one_per_rutina UNIQUE (seat_id, automation_id)
);

COMMENT ON TABLE automation_pauses IS
    'Ticket #325: the pause switch on Rutinas, one row per seat and automation whose switch the rep has touched — a shipped automation by its registry word or a rutina by its row — and whether it stands at «En pausa». Every wake consults it before it creates an execution; the gate re-asserts it in the statement that moves a run. Metadata only.';

-- UPDATE because the switch flips; never DELETE — a rutina's row takes its
-- switch with it by cascade.
GRANT SELECT, INSERT, UPDATE ON automation_pauses TO dito_twin_runtime;
REVOKE DELETE, TRUNCATE ON automation_pauses FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE CADENCE MADE REAL
-- ═══════════════════════════════════════════════════════════════════════
--
-- ONE ROW PER RUTINA, FIRED AGAIN AND AGAIN: `last_fired_at` holds the due
-- instant it last fired for, and the statement that fires it asserts that
-- instant is later — so one instant fires one run, whichever pass reaches it
-- and however many passes see it due. `fired_at` stays the once-row's.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS weekday smallint
    CONSTRAINT schedules_weekday_check CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7);
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS automation_id uuid
    CONSTRAINT schedules_automation_fkey REFERENCES automations (id) ON DELETE CASCADE;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_fired_at timestamptz;

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_every_check;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_every_check CHECK (every IS NULL OR every IN ('day', 'week'));

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_once_check;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_once_check
        CHECK (kind <> 'once'
               OR (fire_at IS NOT NULL AND every IS NULL AND at_hour IS NULL
                   AND weekday IS NULL AND last_fired_at IS NULL));

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_cadence_check;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_cadence_check
        CHECK (kind <> 'cadence'
               OR (fire_at IS NULL AND fired_at IS NULL AND every IS NOT NULL AND at_hour IS NOT NULL
                   AND (every = 'week') = (weekday IS NOT NULL)));

-- WHAT IT WAKES: one step of one run, a shipped automation by name (#357), or
-- a rutina by its row — exactly one of the three.
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_one_target_check;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_one_target_check
        CHECK ((run_id IS NOT NULL AND step_index IS NOT NULL AND automation IS NULL AND automation_id IS NULL)
            OR (run_id IS NULL AND step_index IS NULL AND automation IS NOT NULL AND automation_id IS NULL)
            OR (run_id IS NULL AND step_index IS NULL AND automation IS NULL AND automation_id IS NOT NULL));

ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_one_per_rutina;
ALTER TABLE schedules
    ADD CONSTRAINT schedules_one_per_rutina UNIQUE (automation_id);

-- The pass's read of the cadences.
CREATE INDEX IF NOT EXISTS schedules_cadences
    ON schedules (twin_id) WHERE kind = 'cadence';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. A RUN BORN OF A RUTINA
-- ═══════════════════════════════════════════════════════════════════════
--
-- `automation` stays the registry word — `rutina` for every run a rutina
-- fired — and `automation_id` names which one. NO FOREIGN KEY: Descartar and
-- a replacement delete the rutina, and a run it already fired keeps running
-- under its own pinned definition (decision 29: «a run in flight is never
-- under a definition that changed»).
--
-- `woken_by` IS WHAT FIRED IT — `clock:<due instant in ms>` or
-- `event:<kind>:<id>` — and the unique index makes a firing at-most-once per
-- rutina and wake, so an event the consumer hands over twice after a failed
-- pass fires one run.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS automation_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS woken_by text
    CONSTRAINT runs_woken_by_check
    CHECK (woken_by IS NULL OR woken_by ~ '^(clock:[0-9]{1,16}|event:[a-z_]{1,32}:[0-9a-zA-Z-]{1,64})$');

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_rutina_check;
ALTER TABLE runs
    ADD CONSTRAINT runs_rutina_check
        CHECK ((automation = 'rutina') = (automation_id IS NOT NULL)
               AND (woken_by IS NULL OR automation_id IS NOT NULL));

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_created_by_check;
ALTER TABLE runs
    ADD CONSTRAINT runs_created_by_check
        CHECK (created_by IN ('thread', 'clock', 'rep', 'trigger'));

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_per_wake
    ON runs (automation_id, woken_by) WHERE woken_by IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. AN AUTOMATION AS A DASHBOARD ACT'S TARGET
-- ═══════════════════════════════════════════════════════════════════════
--
-- ONE COLUMN FOR BOTH KINDS OF AUTOMATION, because the switch is one act on
-- either: a shipped automation's registry word or a rutina's id. The two
-- shapes cannot be confused — a registry word holds no `-` — and NO FOREIGN
-- KEY, because Descartar deletes the very rutina its act row names, and an
-- act row is immutable.

ALTER TABLE dashboard_acts ADD COLUMN IF NOT EXISTS automation text
    CONSTRAINT dashboard_acts_automation_shape_check
    CHECK (automation IS NULL
           OR automation ~ '^[a-z][a-z0-9_]{0,63}$'
           OR automation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

COMMENT ON COLUMN dashboard_acts.automation IS
    'The automation the rep activated, discarded, paused or took up again on Rutinas (ticket #325): a shipped automation''s registry word or a rutina''s id. NULL on every other act — dashboard_acts_automation_target_check holds it to the four automation verbs.';

ALTER TABLE dashboard_acts DROP CONSTRAINT IF EXISTS dashboard_acts_verb_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_verb_check
        CHECK (verb IN ('dismiss_draft', 'retract_line',
                        'confirm_binding', 'decline_binding',
                        'scope_in', 'scope_out',
                        'edit_notepad',
                        'pause_run', 'resume_run', 'cancel_run',
                        'activate_automation', 'discard_automation',
                        'pause_automation', 'resume_automation'));

ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_one_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_one_target_check
        CHECK (num_nulls(post_id, chat_directory_id, run_id, automation) >= 3);

ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_notepad_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_notepad_target_check
        CHECK (verb IN ('edit_notepad')
               = (num_nulls(post_id, chat_directory_id, run_id, automation) = 4));

-- Read with PostgreSQL's precedence, as «(the verb acts on an automation)
-- equals (this row names one)».
ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_automation_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_automation_target_check
        CHECK (verb IN ('activate_automation', 'discard_automation',
                        'pause_automation', 'resume_automation')
               = (automation IS NOT NULL));

COMMENT ON CONSTRAINT dashboard_acts_automation_target_check ON dashboard_acts IS
    'Ticket #325: the four automation verbs name an automation and no other verb does. Swept against DASHBOARD_ACT_TARGET_OF_ROUTE in @dito/seam.';

-- THE IMMUTABILITY TRIGGER LEARNS THE FOURTH TARGET: an UPDATE that sets or
-- changes `automation` is a change to what the act WAS.
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
       OR NEW.automation IS DISTINCT FROM OLD.automation
       OR NEW.verb IS DISTINCT FROM OLD.verb
       OR NEW.acted_at IS DISTINCT FROM OLD.acted_at THEN
        RAISE EXCEPTION 'dashboard_acts hold one permitted UPDATE (tickets #224, #223, #323, #325): the outcome stamp. Row % tried to change what the act WAS', OLD.id;
    END IF;
    IF NEW.outcome IS NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % cannot be un-stamped (ticket #224) — the entries and rows it authorized name it already', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

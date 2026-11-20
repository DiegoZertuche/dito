-- Ticket #324: the question step and tool, the two repeats, child runs, every
-- tool in the agent step (spec #318 decisions 23, 25, 27 and 34 as amended
-- 2026-10-06; ADR-0012 as amended; ADR-0044 as amended).
--
-- FOUR VOCABULARIES MOVE (five CHECKs) AND ONE COLUMN AND TWO INDEXES JOIN,
-- all of them metadata:
--
--   1. a step's kind gains `ask`, `each`, `while` and `end`, and loses
--      `check` (decision 23 as amended: a code rule over the model's output is
--      a hardcoded check on agent behaviour, withdrawn with the rule that an
--      act is never the model's call mid-step);
--   2. a dashboard act gains `answer_ask` — the rep's typed answer to a
--      question card, a post act like the binding question's two;
--   3. a notice gains the kind `ask` — the question card's thread rendering;
--   4. an execution gains the disposition `asked` — the runtime's word for a
--      turn an effect left waiting on the rep's answer, on both executions
--      tables, since `DISPOSITIONS` is one closed set in `@dito/execution`;
--   and `run_steps.answered_at` — when the rep answered the card a waiting
--      step parks on. The answer itself is the run's content, sealed beside
--      its session (FR-73: no rep content on a seam row); this column is the
--      instant, which is what settles the card, lets the engine resume the
--      step, and refuses a second answer. Two partial indexes serve the
--      reads this adds: the steps waiting on a card, and a run's children.
--
-- A CHILD RUN NEEDS NO COLUMN: `runs.parent_run_id` names its parent.
--
-- EXTENDED, NEVER NARROWED — BUT ONCE. Removing `check` is the third ruled
-- narrowing (`migration-vocabulary.test.ts`' `NARROWED_ONCE` argues it): no
-- code writes the word, and a checkpoint that already carries
-- it is a record of a step that ran, so the narrowed constraint is added
-- `NOT VALID` — enforced on every new checkpoint, never re-checked against
-- the old.

ALTER TABLE run_steps DROP CONSTRAINT IF EXISTS run_steps_kind_check;
ALTER TABLE run_steps
    ADD CONSTRAINT run_steps_kind_check
        CHECK (kind IN ('agent', 'code', 'act', 'ask', 'post', 'wait',
                        'each', 'while', 'end', 'if')) NOT VALID;

ALTER TABLE run_steps ADD COLUMN IF NOT EXISTS answered_at timestamptz;

COMMENT ON COLUMN run_steps.answered_at IS
    'Ticket #324: when the rep answered the question card this waiting step parks on (awaits_post_id) — on the dashboard or through the thread. The instant only; the answer is the run''s sealed content. Set once per park, cleared when the step parks again.';

CREATE INDEX IF NOT EXISTS run_steps_awaiting
    ON run_steps (awaits_post_id) WHERE state = 'waiting';

CREATE INDEX IF NOT EXISTS runs_by_parent
    ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

ALTER TABLE dashboard_acts DROP CONSTRAINT IF EXISTS dashboard_acts_verb_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_verb_check
        CHECK (verb IN ('dismiss_draft', 'retract_line',
                        'confirm_binding', 'decline_binding',
                        'scope_in', 'scope_out',
                        'edit_notepad',
                        'pause_run', 'resume_run', 'cancel_run',
                        'activate_automation', 'discard_automation',
                        'pause_automation', 'resume_automation',
                        'answer_ask'));

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question',
        'binding_ack',
        'answer',
        'daily_disclosure',
        'correction_ack',
        'correction_refusal',
        'ask'
    )) NOT VALID;

ALTER TABLE executions
    DROP CONSTRAINT IF EXISTS executions_disposition_check;
ALTER TABLE executions
    ADD CONSTRAINT executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted', 'nudged', 'asked'));

ALTER TABLE owner.executions
    DROP CONSTRAINT IF EXISTS owner_executions_disposition_check;
ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified', 'filed', 'nothing-to-file',
                               'posted', 'nudged', 'asked'));

-- «Guardar» on Mi libreta is a dashboard act (ticket #264; spec #258 decision
-- 17; ADR-0033 as amended 2026-09-20 and 2026-09-25; ADR-0013 as amended
-- 2026-09-09).
--
-- NUMBERING: …20260925100010, after …20260922100070. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ WHAT THE ACT ROW IS FOR ═══
--
-- A save on Mi libreta appends a version of the rep notepad in the twin's
-- bundle, and the version's evidence is the `dashboard_acts` row the runtime's
-- local API writes for the press — the same class-2 evidence a card's act
-- carries (ADR-0003), read back by the aperture before the write. So the
-- store has to hold a row for a verb whose target is NEITHER a post NOR a chat:
-- a twin has one notebook, the seat on the row already says whose, and there
-- is no id for the row to name.
--
-- ═══ THREE CONSTRAINTS, AND WHY ONE BECOMES TWO ═══
--
-- `dashboard_acts_verb_check` admits the new word, swept against
-- DASHBOARD_ACT_VERBS in @dito/seam by migration-vocabulary.test.ts.
--
-- `dashboard_acts_one_target_check` said «exactly one target», which the
-- notebook edit cannot meet. It becomes «at most one», and a new
-- `dashboard_acts_notepad_target_check` says the rest: the notebook verb names
-- no target and every other verb names one. The two together are exactly the
-- old rule for every verb that existed, plus the new verb's own. Written with
-- the verb list first, like `dashboard_acts_target_by_verb_check`, so the
-- vocabulary sweep reads it and compares it with the verbs
-- DASHBOARD_ACT_TARGET_OF_ROUTE calls notepad acts.
--
-- `dashboard_acts_target_by_verb_check` is untouched: the notebook verb is not
-- a scope verb and carries no directory row, so it already holds.
--
-- ═══ RE-RUNNABLE, AND OVER A POPULATED TABLE ═══
--
-- Every constraint is dropped `IF EXISTS` before it is re-added, so an operator
-- replaying the file by hand lands on the same schema. Every existing row names
-- exactly one target — the old CHECK guaranteed it — so both new constraints
-- hold over any table the old one held over, and re-adding them validates
-- without a row changing (dashboard-acts.int.test.ts replays this file over a
-- table holding every verb).

ALTER TABLE dashboard_acts DROP CONSTRAINT IF EXISTS dashboard_acts_verb_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_verb_check
        CHECK (verb IN ('dismiss_draft', 'retract_line',
                        'confirm_binding', 'decline_binding',
                        'scope_in', 'scope_out',
                        'edit_notepad'));

ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_one_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_one_target_check
        CHECK (num_nulls(post_id, chat_directory_id) >= 1);

-- Read with PostgreSQL's precedence — `IN` binds tighter than `=` — as «(the
-- verb is the notebook edit) equals (this row names no target at all)».
ALTER TABLE dashboard_acts
    DROP CONSTRAINT IF EXISTS dashboard_acts_notepad_target_check;
ALTER TABLE dashboard_acts
    ADD CONSTRAINT dashboard_acts_notepad_target_check
        CHECK (verb IN ('edit_notepad')
               = (num_nulls(post_id, chat_directory_id) = 2));

COMMENT ON CONSTRAINT dashboard_acts_notepad_target_check ON dashboard_acts IS
    'Ticket #264: the notebook edit names no target — the rep notepad is the seat''s own and has no id — and every other verb names exactly one, with dashboard_acts_one_target_check. Swept against DASHBOARD_ACT_TARGET_OF_ROUTE in @dito/seam.';

-- The column's own note said «exactly one of the two»; it is restated for the
-- verb that names neither.
COMMENT ON COLUMN dashboard_acts.post_id IS
    'The card the rep acted on, for an act performed on one. NULL on a scope switch, whose target is a chat directory row instead, and on the notebook edit, which names no target (tickets #223, #264) — dashboard_acts_one_target_check, dashboard_acts_notepad_target_check and dashboard_acts_target_by_verb_check make the right one present for the verb.';

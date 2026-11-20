-- Ticket #368: how a card leaves the canvas (ruled 2026-10-08). Two ways
-- besides the twenty-four hours a report, a document or a list already stays:
-- the twin's curation takes any card off Inicio for the rep, and «Listo» is
-- the rep's own act on a card that has no act of its own.
--
-- TWO CHANGES IN ONE FILE:
--
--   1. `canvas_curations` carries the cards the twin took off the canvas
--      (`left_posts`), beside the order it placed the rest in. Each version
--      holds the whole set as it stands after that write — a card stays off
--      until a later curation places it in its order again — so the canvas
--      reads one row, as it reads the order.
--   2. `dashboard_acts` takes `clear_card`: «Listo», a post act recorded and
--      run as an execution like every other dashboard act. The canvas reads
--      the performed row to leave the card out; no second table records it.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE CARDS THE TWIN TOOK OFF THE CANVAS
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE canvas_curations
    ADD COLUMN IF NOT EXISTS left_posts uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN canvas_curations.left_posts IS
    'Ticket #368: the cards the twin took off Inicio for the rep, by post id, as they stand after this write — kept off until a later curation names them in its order. Layout over the rep''s own cards, never content; the cards themselves still wait.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. «LISTO», A DASHBOARD ACT
-- ═══════════════════════════════════════════════════════════════════════

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
                        'answer_ask',
                        'clear_card'));

CREATE INDEX IF NOT EXISTS dashboard_acts_cleared
    ON dashboard_acts (post_id) WHERE verb = 'clear_card';

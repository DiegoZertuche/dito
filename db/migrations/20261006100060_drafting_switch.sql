-- Drafting carries the pause switch (ticket #325; spec #318 decision 30).
--
-- NUMBERING: …20261006100060, after …20261006100040 (…100050 is #324's). Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- WIDENED, NEVER NARROWED (…100022's rule): the switch's shipped
-- automations gain `chat_turn`, the drafting a customer's message wakes,
-- beside the three that run on their own clock. A paused drafting creates no
-- execution for a customer's message; the message stays recorded as captured
-- and is not drafted when the switch is turned back on — the switch is the rep
-- answering their customers by hand for now, and drafts afterwards would
-- answer a conversation that has moved on. Every row the old CHECK held, the
-- new one holds.

ALTER TABLE automation_pauses DROP CONSTRAINT IF EXISTS automation_pauses_shipped_check;
ALTER TABLE automation_pauses
    ADD CONSTRAINT automation_pauses_shipped_check
        CHECK (shipped IS NULL OR shipped IN ('chat_turn', 'extraction', 'daily_disclosure', 'nudge'));

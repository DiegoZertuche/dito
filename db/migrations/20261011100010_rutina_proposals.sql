-- A rutina the twin proposes is a card where the rep is (ticket #386; Diego's
-- ruling of 2026-10-11 amending spec #318 decision 29; ADR-0044's `proposal`
-- part; CONTEXT.md *Rutinas*, *Post*, *Card*).
--
-- NUMBERING: …20261011100010, after …20261008100020. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ THREE THINGS ═══
--
--   A NOTICE KIND FOR THE PROPOSAL — the card's thread rendering, delivered to
--   the self-chat like a run's question card, so the phone shows the proposal
--   and the canvas reads the post beside it.
--
--   THE RUTINA NAMES ITS PROPOSAL POST — `automations.proposal_post_id`: the
--   canvas reads whether the card still waits off the rutina's own state, and
--   Activar or Descartar pressed on the card settles that post. Metadata
--   only: an id (FR-73).
--
--   THE ROWS «POR ACTIVAR» HELD — a pending rutina written before this has no
--   card and no page left to go live on, so it is settled here once.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE NOTICE KIND
-- ═══════════════════════════════════════════════════════════════════════

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
        'ask',
        'proposal'
    )) NOT VALID;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE RUTINA'S PROPOSAL POST
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE automations ADD COLUMN IF NOT EXISTS proposal_post_id uuid;

ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_proposal_post_fkey;
ALTER TABLE automations
    ADD CONSTRAINT automations_proposal_post_fkey
        FOREIGN KEY (twin_id, proposal_post_id) REFERENCES posts (twin_id, id);

COMMENT ON COLUMN automations.proposal_post_id IS
    'Ticket #386: the post that carries a twin-proposed rutina''s proposal card, at both doors. The card waits while the rutina is pending and live; Activar or Descartar on it, or the rep''s yes in the thread, settles it. NULL for a rutina the rep asked for, which is active at the ask, and for one of Dito''s.';

CREATE UNIQUE INDEX IF NOT EXISTS automations_by_proposal_post
    ON automations (proposal_post_id) WHERE proposal_post_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE ROWS «POR ACTIVAR» HELD (Codex r3)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Rutinas no longer lists a pending rutina, so a row written pending before
-- this applies would have no way to go live. One the rep asked for is live
-- at the ask under the ruling, so it goes active now and fires from its next
-- instant; one the twin proposed has no card to be accepted on, so it ends
-- with its cadence, as Descartar ends one, and the pass's sweep deletes its
-- content. Nothing of either has ever run.

UPDATE automations SET state = 'active', activated_at = clock_timestamp()
 WHERE origin = 'rep' AND state = 'pending' AND ended_at IS NULL AND proposal_post_id IS NULL;

UPDATE schedules s SET ended_at = clock_timestamp()
  FROM automations a
 WHERE s.automation_id = a.id AND s.ended_at IS NULL
   AND a.origin = 'twin' AND a.state = 'pending' AND a.ended_at IS NULL AND a.proposal_post_id IS NULL;

UPDATE automations SET ended_at = clock_timestamp()
 WHERE origin = 'twin' AND state = 'pending' AND ended_at IS NULL AND proposal_post_id IS NULL;

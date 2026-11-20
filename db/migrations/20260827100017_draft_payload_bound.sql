-- The affirmation must bind to the content the rep actually saw (ticket
-- #25 Codex round 1, ADR-0006): the matcher resolves a quoted post to the
-- command's draft_id, while the executor posts what payload_ref names. A
-- row pairing draft_id A with payload_ref 'draft:B' (or a notice ref)
-- would let a «va» on displayed content B mint a tap for unseen content
-- A. No writer produces such a row; this CHECK makes it unrepresentable —
-- authorization holds by construction, not by writer discipline. Covers
-- both classes: a customer_send's canonical ref (FR-70's check) is now
-- also schema-enforced.
ALTER TABLE send_commands
    ADD CONSTRAINT send_commands_draft_payload_bound_check
    CHECK (draft_id IS NULL OR payload_ref = 'draft:' || draft_id);

-- Outcome finalization is atomic (ticket #24, ADR-0006): a command is
-- either pending (no outcome, no execution time) or finalized (both) —
-- an executed command can never be indistinguishable from a pending one.
-- The CHECK covers INSERT and UPDATE alike; together with the
-- outcome-only trigger, the sole legal transition is pending → finalized.
ALTER TABLE send_commands
    ADD CONSTRAINT send_commands_outcome_executed_at_paired_check
    CHECK ((outcome IS NULL) = (executed_at IS NULL));

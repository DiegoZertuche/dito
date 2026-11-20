-- Pacing reads at the send-lock writer (ticket #24, ADR-0017) filter
-- send_commands by twin and recency on every attempted customer_send, while
-- holding the per-twin advisory lock. Indexed so the check stays a lookup,
-- not a growing history scan under the lock.
CREATE INDEX send_commands_twin_id_created_at_idx
    ON send_commands (twin_id, created_at DESC);

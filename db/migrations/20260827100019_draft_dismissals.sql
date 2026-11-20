-- The dismissal record (ticket #30; spec #29 grilling decision 1): the
-- anti-tap. A quoted «no va» on a draft post mints exactly one of these —
-- terminal: the draft leaves the queue (waiting and dismissed are distinct
-- states; silence keeps meaning «ahorita no» and stays waiting), and a
-- later «va» on the draft is refused by the send-lock writer with the
-- audit-chained 'dismissed' reason (ADR-0020) — a dead draft can never
-- quietly come back to life and send.
--
-- Mirrors taps deliberately: PRIMARY KEY (draft_id) is the single-use
-- lock, and source_event_id pins the dismissal to the raw plane-delivered
-- «no va» event — model output can never dismiss a draft (ADR-0006's
-- pattern applied to the dismiss verb).
CREATE TABLE draft_dismissals (
    draft_id uuid PRIMARY KEY REFERENCES drafts (id),
    source_event_id bigint NOT NULL REFERENCES wa_events (id),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- A dismissal is the recorded proof of one rep act on one draft — terminal
-- by construction: refused in the store, not promised in code (the taps/
-- drafts/notices pattern).
CREATE FUNCTION draft_dismissals_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'draft_dismissals are immutable (ticket #30): % refused — a dismissal is terminal rep-act evidence', TG_OP;
END;
$$;

CREATE TRIGGER draft_dismissals_no_update_delete
    BEFORE UPDATE OR DELETE ON draft_dismissals
    FOR EACH ROW EXECUTE FUNCTION draft_dismissals_immutable();

CREATE TRIGGER draft_dismissals_no_truncate
    BEFORE TRUNCATE ON draft_dismissals
    FOR EACH STATEMENT EXECUTE FUNCTION draft_dismissals_immutable();

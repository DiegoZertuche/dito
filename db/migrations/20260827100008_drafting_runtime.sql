-- The twin-runtime's drafting bookkeeping on the seam (ticket #23).

-- wa_event_processing: the consumer's durable position. One row per
-- consumed wa_events row, committed in the same transaction as whatever
-- the event produced (draft + system_send, or nothing), so an event is
-- processed exactly once — the primary key is the lock. Dispositions:
--   'captured'        — conversation row into the bundle only (self-chat
--                       traffic and own-sent messages; the raw self-chat
--                       events remain the affirmation matcher's input);
--   'no_answer_needed'— classified by the drafting harness as needing no
--                       reply: no draft, no command (ticket AC);
--   'drafted'         — a draft record and its system_send command were
--                       emitted atomically with this marker.
CREATE TABLE wa_event_processing (
    event_id bigint PRIMARY KEY REFERENCES wa_events (id),
    twin_id uuid NOT NULL,
    disposition text NOT NULL
        CONSTRAINT wa_event_processing_disposition_check
        CHECK (disposition IN ('captured', 'no_answer_needed', 'drafted')),
    processed_at timestamptz NOT NULL DEFAULT now()
);

-- draft_timings: per-draft timing for the NFR-2 measurement on the rig
-- (ADR-0016: inbound → draft inside the ~1-minute budget, cold start
-- included; measured in the slice-closing ticket). Content-free by
-- construction — identifiers and instants only, never text:
--   event_received_at — when the seam first saw the inbound (wa_events);
--   runtime_seen_at   — when the consumer picked the event up (the gap to
--                       event_received_at is wake/poll latency);
--   draft_ready_at    — when the draft record was ready to commit.
CREATE TABLE draft_timings (
    draft_id uuid PRIMARY KEY REFERENCES drafts (id),
    event_received_at timestamptz NOT NULL,
    runtime_seen_at timestamptz NOT NULL,
    draft_ready_at timestamptz NOT NULL
);

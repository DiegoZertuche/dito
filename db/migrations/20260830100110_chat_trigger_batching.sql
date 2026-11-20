-- The chat trigger batches (ticket #75; spec #29 decision 12 and spec #48
-- decision 18: dispositions grow, machinery doesn't).
--
-- Drafting used to fire once per inbound message, so a customer who typed
-- three short lines got three drafts and cost three model calls — «this
-- causes too much churn to the rep» (#69, finding 2). A burst is one
-- conversational turn, and a turn now earns ONE draft, written once the
-- chat has been quiet for the settle window.
--
-- NO NEW TABLE AND NO NEW COLUMN. The settle window is a predicate over
-- `wa_events.received_at` and the ABSENCE of a `wa_event_processing` row —
-- both already here — which is exactly why the wait survives a restart:
-- there is no timer to lose. Two words are all the seam gains, for the two
-- outcomes batching creates that had no name:
--
-- 'drafted_in_batch' — this event was answered by the draft emitted for its
--                      turn, and the ANCHOR of that turn (the message that
--                      closed it) carries 'drafted'. Deliberately not a
--                      second 'drafted': `drafts.in_reply_to_event_id`
--                      names one row, so exactly one marker per draft may
--                      say 'drafted' or the seam's own count of drafts
--                      stops matching the drafts table. Every event of a
--                      batch is marked inside the SAME transaction that
--                      writes the draft, its system_send and its timing, so
--                      batching cannot leave an event marked without a
--                      draft, drafted without a marker, or marked twice
--                      (ADR-0006's shape: the primary key is the lock).
--
-- 'answered_by_rep'  — the rep answered this message themselves before the
--                      window closed, so the twin drafted nothing for it.
--                      Since #63 the twin can see its own tapped sends and
--                      the rep's phone-typed replies alike, which is what
--                      makes this decidable at all. Deliberately not
--                      'no_answer_needed': that is the MODEL judging a
--                      message to need no reply, and this is the twin
--                      standing down because a human already replied — the
--                      model was never called.
--
-- `draft_timings` keeps its shape and gains meaning rather than columns:
-- `event_received_at` is now the OLDEST arrival in the turn (when the turn
-- began) and `runtime_seen_at` is when the settled turn was picked up, so
-- `draft_ready_at - runtime_seen_at` remains the twin's own work — the
-- ~1-minute NFR-2 budget of ADR-0016 — and the gap below it is the settle
-- window plus poll latency, visible rather than hidden.
--
-- Every value an earlier migration granted rides forward — the rule
-- …100022 states, and the reason a re-cut must never narrow the set.
ALTER TABLE wa_event_processing
    DROP CONSTRAINT wa_event_processing_disposition_check;
ALTER TABLE wa_event_processing
    ADD CONSTRAINT wa_event_processing_disposition_check
    CHECK (disposition IN (
        'captured',
        'no_answer_needed',
        'drafted',
        'drafted_in_batch',
        'answered_by_rep',
        'affirmed',
        'affirmation_refused',
        'dismissed',
        'binding_confirmed',
        'declined',
        'question_answered',
        'question_answer_refused',
        'backfill_ingested',
        'answered',
        'deliberate_silence',
        'media_ignored',
        'retracted',
        'correction_refused'
    ));

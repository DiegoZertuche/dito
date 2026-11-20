-- The rep's wordless asks are rows the pass reads, the knock has one store,
-- and a receipt has one delivery (ticket #358; ADR-0012 as amended — the
-- machine is rows the pass reads; ADR-0031 as amended 2026-10-06 — the thread
-- knocks with its tool, and the carried knock retires; ADR-0044 as amended
-- 2026-10-06 — the knock is a row beside the immutable post; ADR-0037 as
-- amended — a receipt goes to both surfaces; ADR-0008).
--
-- NUMBERING: …20261008100010, after …20261007100020. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ FIVE THINGS ═══
--
--   THE ASKS — one row per pick, selection and summons the local API
--   accepted, keyed by the id the page minted for it, so an ask the rep made
--   is served across a restart: the pass reads the rows that carry no marker.
--
--   THEIR PROCESSING MARKER — `dashboard_message_processing`'s shape and its
--   vocabulary: the primary key is the exactly-once lock, written inside the
--   execution's own transaction.
--
--   THE ARRIVAL'S MARKER IS WHAT THE PASS READS — `rep_arrival_executions`
--   is what the pass reads an arrival's turn as owed from. The rows standing
--   unmarked when this applies, older than the throttle's ten minutes, are
--   marked here, overtaken: each was raised in a process that is gone, and
--   greeting the rep for an arrival of days ago is a line nobody stands at
--   the page for.
--
--   THE KNOCK CARRIED FROM BIRTH RETIRES — `posts.knock_disposition`, its
--   CHECK, its index and the trigger that kept a `post_knocks` row off a post
--   that carried its own. `post_knocks` is the one store. The posts that
--   carried one were announced when they landed; their sealed parts keep the
--   sentence and no reader takes it from there.
--
--   A STAND-ALONE RECEIPT HAS ONE DELIVERY — the notice and its send a
--   button's receipt takes; a thread turn's receipt names its execution as its
--   origin, so the acknowledgements' per-kind checks admit that.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE ASKS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rep_asks (
    -- THE PAGE'S OWN ID FOR THE ASK — the `pickId`, `selectionId` or
    -- `summonsId` the route took — which is also the id the turn's line is
    -- heard under on the seat's stream.
    id uuid PRIMARY KEY,
    -- Seat scope, `rep_arrivals`' own: the values come off the registry row
    -- the API resolved rather than off the request (ADR-0035).
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    -- WHICH ASK. The vocabulary is `rep-asks.ts`' `REP_ASK_KINDS` and this
    -- CHECK is its other half (`migration-vocabulary.test.ts`).
    kind text NOT NULL
        CONSTRAINT rep_asks_kind_check
        CHECK (kind IN ('pick', 'selection', 'summons')),
    -- THE CARD A SELECTION OR A SUMMONS POINTS AT.
    post_id uuid,
    -- WHAT A PICKED MATTER IS ABOUT: a customer or a card, by id.
    about_kind text
        CONSTRAINT rep_asks_about_kind_check
        CHECK (about_kind IS NULL OR about_kind IN ('entity', 'post')),
    about_id uuid,
    -- THE TWIN'S OWN WORDS THE ASK CARRIES, sealed under the twin DEK: a
    -- pick's label from the twin's notes, a selection's phrase as the card
    -- shows it. Never the rep's words and never in the clear.
    words_enc bytea,
    asked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rep_asks_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id),
    CONSTRAINT rep_asks_post_fkey
        FOREIGN KEY (twin_id, post_id) REFERENCES posts (twin_id, id),
    -- EACH KIND CARRIES EXACTLY ITS OWN FIELDS.
    CONSTRAINT rep_asks_shape_check
        CHECK (CASE kind
                 WHEN 'pick' THEN post_id IS NULL AND about_kind IS NOT NULL
                                  AND about_id IS NOT NULL AND words_enc IS NOT NULL
                 WHEN 'selection' THEN post_id IS NOT NULL AND about_kind IS NULL
                                       AND about_id IS NULL AND words_enc IS NOT NULL
                 ELSE post_id IS NOT NULL AND about_kind IS NULL
                      AND about_id IS NULL AND words_enc IS NULL
               END)
);

COMMENT ON TABLE rep_asks IS
    'Ticket #358: one row per pick, selection and summons the runtime''s local API accepted — keyed by the page''s own id for it — which the consumer''s pass serves to the twin thread exactly once (rep_ask_processing). words_enc is the twin''s own label or the card''s phrase, sealed under the twin DEK.';

CREATE INDEX IF NOT EXISTS rep_asks_by_twin
    ON rep_asks (twin_id, asked_at, id);

-- AN ASK IS A RECORD OF SOMETHING THE REP DID, and the turn it woke names it.
CREATE OR REPLACE FUNCTION rep_asks_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'rep_asks are immutable (ticket #358): % refused — an ask is the record the turn it woke names', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS rep_asks_no_update_delete ON rep_asks;
CREATE TRIGGER rep_asks_no_update_delete
    BEFORE UPDATE OR DELETE ON rep_asks
    FOR EACH ROW EXECUTE FUNCTION rep_asks_immutable();

DROP TRIGGER IF EXISTS rep_asks_no_truncate ON rep_asks;
CREATE TRIGGER rep_asks_no_truncate
    BEFORE TRUNCATE ON rep_asks
    FOR EACH STATEMENT EXECUTE FUNCTION rep_asks_immutable();

GRANT SELECT, INSERT ON rep_asks TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON rep_asks FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THEIR PROCESSING MARKER
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rep_ask_processing (
    ask_id uuid PRIMARY KEY REFERENCES rep_asks (id),
    twin_id uuid NOT NULL,
    -- THE DOOR'S VOCABULARY: an ask is answered, met with silence, acted on
    -- or failed exactly as a line typed in the bar is.
    disposition text NOT NULL
        CONSTRAINT rep_ask_processing_disposition_check
        CHECK (disposition IN (
            'captured', 'no_answer_needed', 'drafted', 'drafted_in_batch',
            'answered_by_rep', 'affirmed', 'affirmation_refused', 'dismissed',
            'binding_confirmed', 'declined', 'question_answered',
            'question_answer_refused', 'backfill_ingested', 'answered',
            'deliberate_silence', 'media_ignored', 'retracted',
            'correction_refused', 'execution_failed', 'folded')),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE rep_ask_processing IS
    'Ticket #358: one row per ask the twin thread''s turn answered — the primary key is the exactly-once lock, committed with the execution record and chain entry of the turn (ADR-0020). The vocabulary is the door''s own (dashboard_message_processing).';

CREATE OR REPLACE FUNCTION rep_ask_processing_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'rep_ask_processing is immutable (ticket #358): % refused — an ask is served once', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS rep_ask_processing_no_update_delete ON rep_ask_processing;
CREATE TRIGGER rep_ask_processing_no_update_delete
    BEFORE UPDATE OR DELETE ON rep_ask_processing
    FOR EACH ROW EXECUTE FUNCTION rep_ask_processing_immutable();

DROP TRIGGER IF EXISTS rep_ask_processing_no_truncate ON rep_ask_processing;
CREATE TRIGGER rep_ask_processing_no_truncate
    BEFORE TRUNCATE ON rep_ask_processing
    FOR EACH STATEMENT EXECUTE FUNCTION rep_ask_processing_immutable();

GRANT SELECT, INSERT ON rep_ask_processing TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON rep_ask_processing FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE ARRIVAL'S MARKER IS WHAT THE PASS READS
-- ═══════════════════════════════════════════════════════════════════════

-- ONLY THOSE OLDER THAN THE THROTTLE'S TEN MINUTES (Codex r2): one recorded
-- just before the runtime stopped for this deploy is still the rep standing at
-- the page, and the first pass of the new build greets them; one older than
-- that is an arrival a return would already greet again.
INSERT INTO rep_arrival_executions (arrival_id, twin_id, execution_id)
SELECT a.id, a.twin_id, NULL
  FROM rep_arrivals a
 WHERE a.arrived_at < now() - interval '10 minutes'
   AND NOT EXISTS (SELECT 1 FROM rep_arrival_executions m WHERE m.arrival_id = a.id);

COMMENT ON TABLE rep_arrival_executions IS
    'Tickets #266, #320, #358: the arrival''s processing marker — the consumer''s pass serves every rep_arrivals row with none to the twin thread''s arrival turn, and the turn writes it inside its own transaction, with the execution record and chain entry it names (ADR-0020). execution_id is NULL on a row marked overtaken: by an older build, or by …20261008100010 for the arrivals standing unmarked when it applied.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. THE KNOCK CARRIED FROM BIRTH RETIRES
-- ═══════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS post_knocks_not_carried ON post_knocks;
DROP FUNCTION IF EXISTS post_knocks_once();

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_arrival_door_only_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_arrival_door_only_check
    CHECK (arrival_id IS NULL OR (notice_id IS NULL AND draft_id IS NULL));

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_unasked_door_only_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_unasked_door_only_check
    CHECK (NOT unasked OR (notice_id IS NULL AND draft_id IS NULL));

DROP INDEX IF EXISTS posts_twin_knock_idx;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_knock_disposition_check;
ALTER TABLE posts DROP COLUMN IF EXISTS knock_disposition;

COMMENT ON TABLE post_knocks IS
    'Tickets #320, #364, #358: every knock — the one store. The knock the twin thread''s knock tool wrote about a post that waits on the rep: one landing knock per post, and one more for each reminder that fired for it (subject) — the sentence sealed under the twin DEK, the execution, the instant. Delivered by the runtime''s at-once tier.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. A STAND-ALONE RECEIPT HAS ONE DELIVERY
-- ═══════════════════════════════════════════════════════════════════════
--
-- A receipt goes to both surfaces (glossary *Door*): the button's already did,
-- as a notice and its send, and a thread turn's now takes the same path. A
-- turn answering a line typed in the bar, or woken by an event, has no
-- `wa_events` row and no dashboard act behind it — its origin is the turn's
-- own execution, whose trigger names the line or the event. So each
-- acknowledgement's per-kind check admits the execution as a third origin, as
-- `notices_answer_about_event_check` already does (…20261003100010). Strictly
-- weaker than the cut it replaces: every standing row passes.

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_dismissal_ack_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_dismissal_ack_about_event_check
    CHECK (kind <> 'dismissal_ack'
           OR about_event_id IS NOT NULL OR dashboard_act_id IS NOT NULL
           OR execution_id IS NOT NULL);

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_confirm_ack_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_confirm_ack_about_event_check
    CHECK (kind <> 'binding_ack'
           OR about_event_id IS NOT NULL OR dashboard_act_id IS NOT NULL
           OR execution_id IS NOT NULL);

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_correction_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_correction_about_event_check
    CHECK (kind NOT IN ('correction_ack', 'correction_refusal')
           OR about_event_id IS NOT NULL OR dashboard_act_id IS NOT NULL
           OR execution_id IS NOT NULL);

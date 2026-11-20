-- The dashboard's door: a message the rep types on Inicio, and an answer that
-- goes back through the door it came in (ticket #261; spec #258 *Habla con
-- Dito, the mechanism*; ADR-0044 as amended, ADR-0013 as amended, ADR-0008,
-- ADR-0010).
--
-- NUMBERING: …20260922100010, the first of 2026-09-22, after …20260919100010
-- (WhatsApp's own chat is not a person, #255). Forward-only: no migration in
-- this repo is ever edited once it has applied anywhere.
--
-- ═══ WHY A TABLE OF ITS OWN AND NOT A `wa_events` ROW ═══
--
-- The spec calls a dashboard message «a seam-shaped event with source
-- `dashboard`», and the literal reading — write it into `wa_events` with that
-- source — is refused by the one grant this repo checks hardest.
-- …20260829100012 REVOKES INSERT on `wa_events` from `dito_twin_runtime`, and
-- `ledger-grants-check` fails the build if it ever comes back, because the
-- aperture takes class-2 rep-act evidence and the company/seat/twin scope off
-- those rows: a principal that can write one can forge both (ADR-0003,
-- ADR-0035). The runtime is exactly that principal here — it is the process
-- that runs models and serves the local API — so a runtime holding INSERT on
-- the inbound seam could mint a `whatsapp`-source row and cite it as the rep's
-- own message. That is the attack the single-writer rule exists to refuse, and
-- no door is worth reopening it.
--
-- So the door gets the seam's SHAPE without the rail's table: an append-only
-- row with a sealed payload, a plaintext metadata envelope, an arrival stamp
-- and a processing marker whose primary key is the exactly-once lock. The
-- consumer reads it on the same pass, routes it to the same thread execution
-- and marks it with the same vocabulary. Two sources, two inbound tables; the
-- rail writes one and the lease holder writes the other, and neither can write
-- the other's.
--
-- ═══ WHAT THE ROW HOLDS, AND WHAT IT MUST NOT ═══
--
-- `wa_events` is the model (…20260826100001): plaintext metadata, content
-- inside the DEK envelope. There is no text column outside `text_enc`, so a
-- reader with the database and no key learns that a rep typed something, when,
-- and under which login — and not one syllable of what.
--
-- ═══ AND THE POST LEARNS WHICH DOOR ASKED ═══
--
-- «An answer goes where it was asked» (ADR-0044 as amended): an answer to a
-- door message is delivered to the door only and mints no send command; an
-- answer to a self-chat message mints its send and Inicio does not render it.
-- A post therefore carries which door asked, so the feed decides that without
-- joining executions, and the door's answer names the message it answers.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE DASHBOARD MESSAGE
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dashboard_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Seat scope, like `dashboard_acts`': aperture infrastructure is
    -- seat-scoped rather than twin-session-scoped (ADR-0003), and the values
    -- come off the registry row the API resolved rather than off the request
    -- (ADR-0035).
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    -- THE LOGIN SESSION THAT TYPED IT — the tenancy fence, stated in the
    -- store. `dashboard_acts` leaves the session implicit because a button
    -- names a post of the twin's and the post is the fence; a message names
    -- nothing, so the only thing tying these words to a person is the session
    -- rep-web authenticated. A foreign key, so a message cannot cite a login
    -- that does not exist, and the API checks the session is this seat's and
    -- still open before it writes.
    session_id uuid NOT NULL REFERENCES sessions (id),
    -- The rep's words, sealed under the twin DEK (ADR-0008). The runtime
    -- seals; rep-web holds no key and no privilege on this table.
    text_enc bytea NOT NULL,
    -- VALID TIME: when the rep sent it. The aperture takes an act's valid time
    -- off the row (the rule `wa_events.occurred_at` and `dashboard_acts.acted_at`
    -- both carry), and the seat-local day the exchanges read cuts on is this
    -- column's.
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- ARRIVAL: when this side took the message in. It is `wa_events.received_at`
    -- one table over — the instant NFR-2's budget is measured from, so an answer
    -- the rep waited for is measured by the same arithmetic as a draft. On this
    -- door one statement stamps both, which is a property of a door with no rail
    -- in front of it rather than a reason to collapse two different questions
    -- into one column.
    received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE dashboard_messages IS
    'Ticket #261: one row per message the rep typed through Habla con Dito — the dashboard door''s inbound seam. Written only by the twin runtime''s local API, from a request that passed the bearer, the seat and the twin fences and named an open session of that seat. Plaintext metadata and one sealed column: four ids and two instants, and not a syllable of what was typed outside text_enc (ADR-0008).';
COMMENT ON COLUMN dashboard_messages.session_id IS
    'Ticket #261: the login session the words were typed under — the tenancy fence a message needs and a button does not, because a button names a post of the twin''s and a message names nothing.';
COMMENT ON COLUMN dashboard_messages.occurred_at IS
    'Valid time: when the rep sent it. The seat-local day the exchanges read cuts on, and the instant the aperture records for an act this message authorizes — the rule wa_events.occurred_at carries for the other door.';
COMMENT ON COLUMN dashboard_messages.received_at IS
    'Arrival: when this side took the message in — NFR-2''s first instant, as wa_events.received_at is for the rail''s door (ticket #261).';

-- The consumer's pending read, and the exchanges read's day: one twin's
-- unconsumed messages, and one seat's messages in arrival order.
CREATE INDEX IF NOT EXISTS dashboard_messages_by_twin
    ON dashboard_messages (twin_id, occurred_at);
CREATE INDEX IF NOT EXISTS dashboard_messages_by_seat
    ON dashboard_messages (seat_id, occurred_at);

-- A message is the record of something a rep said. Never rewritten, never
-- deleted — the shape `notices`, `posts`, `drafts` and `dashboard_acts` have,
-- and for ADR-0034's reason applied to evidence: this row is class-2 rep-act
-- evidence (ADR-0013 as amended), so a writer that could edit one could
-- rewrite what the rep asked for after an act was authorized by it.
CREATE OR REPLACE FUNCTION dashboard_messages_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'dashboard_messages are immutable (ticket #261): % refused — a message row is what the rep typed, and class-2 rep-act evidence (ADR-0003)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS dashboard_messages_no_update_delete ON dashboard_messages;
CREATE TRIGGER dashboard_messages_no_update_delete
    BEFORE UPDATE OR DELETE ON dashboard_messages
    FOR EACH ROW EXECUTE FUNCTION dashboard_messages_immutable();

DROP TRIGGER IF EXISTS dashboard_messages_no_truncate ON dashboard_messages;
CREATE TRIGGER dashboard_messages_no_truncate
    BEFORE TRUNCATE ON dashboard_messages
    FOR EACH STATEMENT EXECUTE FUNCTION dashboard_messages_immutable();

-- THE LEASE HOLDER WRITES IT AND THE APERTURE READS IT, and neither may do
-- more. `dito_rep_web` is granted NOTHING AT ALL: the dashboard does not write
-- the rep's words, it asks the lease holder to seal and write them, and it
-- holds no key to read them back with either (ADR-0008, ADR-0010). The
-- aperture reads because this row is the third kind of class-2 evidence and
-- the aperture re-reads every claim for itself (ADR-0003).
GRANT SELECT, INSERT ON dashboard_messages TO dito_twin_runtime;
GRANT SELECT ON dashboard_messages TO dito_aperture;
REVOKE UPDATE, DELETE, TRUNCATE ON dashboard_messages FROM dito_twin_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON dashboard_messages FROM dito_aperture;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. ITS PROCESSING MARKER
-- ═══════════════════════════════════════════════════════════════════════
--
-- `wa_event_processing`'s twin (…20260827100008), and deliberately the same
-- shape: the marker's PRIMARY KEY is the exactly-once lock, the disposition is
-- the seam's own closed vocabulary, and the row commits inside the
-- transaction that carries the execution's record, its chain entry and its
-- post. One vocabulary across both doors — a door message that is answered
-- marks `answered` exactly as a self-chat one does — so
-- `migration-vocabulary.test.ts` sweeps this CHECK against the same constant.
--
-- A SEPARATE TABLE RATHER THAN A COLUMN, for the reason the message table is
-- immutable: a marker stamped onto the message row would be an UPDATE on a row
-- that is evidence, and a store that permits one UPDATE is a store somebody
-- has to prove permits only that one.

CREATE TABLE IF NOT EXISTS dashboard_message_processing (
    message_id uuid PRIMARY KEY REFERENCES dashboard_messages (id),
    twin_id uuid NOT NULL,
    disposition text NOT NULL
        CONSTRAINT dashboard_message_processing_disposition_check
        CHECK (disposition IN ('captured', 'no_answer_needed', 'drafted',
                               'drafted_in_batch', 'answered_by_rep',
                               'affirmed', 'affirmation_refused', 'dismissed',
                               'binding_confirmed', 'declined',
                               'question_answered', 'question_answer_refused',
                               'backfill_ingested', 'answered',
                               'deliberate_silence', 'media_ignored',
                               'retracted', 'correction_refused',
                               'execution_failed')),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE dashboard_message_processing IS
    'Ticket #261: one row per consumed dashboard message — `wa_event_processing` for the other door. The primary key is the exactly-once lock, and the row commits with the execution record, the chain entry and the answer post it accounts for (ADR-0020).';

GRANT SELECT, INSERT ON dashboard_message_processing TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON dashboard_message_processing FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WHICH DOOR ASKED FOR A POST
-- ═══════════════════════════════════════════════════════════════════════
--
-- EVERY STANDING ROW SURVIVES: both columns are nullable with no default, so
-- the ALTER rewrites nothing, and the one re-cut CHECK is strictly weaker than
-- the one it replaces.
--
-- NOTHING IS BACKFILLED, and that is ADR-0034's rule rather than an omission:
-- an absent field is NOT RECORDED THEN, never a default. A post written before
-- this migration is either proactive — a draft, a question, the day's record,
-- a receipt — or an answer that was already delivered to the thread and sent,
-- and neither reading is something this column could restate without inventing
-- a fact. `posts` is immutable besides, so a backfill would mean disabling the
-- trigger that says what a post is.

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS asked_on text
        CONSTRAINT posts_asked_on_check
        CHECK (asked_on IS NULL OR asked_on IN ('twin_thread', 'dashboard')),
    ADD COLUMN IF NOT EXISTS asked_message_id uuid
        REFERENCES dashboard_messages (id);

COMMENT ON COLUMN posts.asked_on IS
    'Ticket #261: which door asked for this post, from its execution''s trigger — `twin_thread` for an answer to a self-chat message, `dashboard` for an answer to a message typed on Inicio. NULL for a PROACTIVE post (a draft, a question, the day''s record, a receipt), which goes to both surfaces because the twin cannot know where the rep is (ADR-0044 as amended).';
COMMENT ON COLUMN posts.asked_message_id IS
    'Ticket #261: the dashboard message this post answers — set exactly when asked_on is `dashboard`, and the join the exchanges read pairs a message with its reply on.';

-- The two columns are one fact, stated as an equivalence so neither half can
-- drift: a door post that names no message would be a reply nothing could be
-- paired with, and a message id on a post the phone asked for would pair an
-- answer with a question it never answered. `IS NOT DISTINCT FROM` rather than
-- `=`, because a CHECK is satisfied by NULL and the plain comparison would let
-- a proactive post carry a message id.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_door_message_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_door_message_check
    CHECK ((asked_on IS NOT DISTINCT FROM 'dashboard')
           = (asked_message_id IS NOT NULL));

-- ONE ANSWER PER DOOR MESSAGE, over the column the door uses — the bound
-- `notices_one_answer_per_event` puts on the other door's answers, and for the
-- same reason: a second reply to one message is a second answer the rep never
-- asked for, whatever a retry or a replay attempts.
CREATE UNIQUE INDEX IF NOT EXISTS posts_one_reply_per_dashboard_message
    ON posts (asked_message_id)
    WHERE asked_message_id IS NOT NULL;

-- A DOOR POST HAS NO DELIVERY ROW, and that is the whole of «delivered to the
-- door only». `notices` is the THREAD's rendering record — the row whose
-- `notice:<uuid>` the plane's executor dereferences and posts (ADR-0006) — so
-- a post no thread renders and no executor sends has none to name. Its parts
-- are its content and the dashboard renders them, which is ADR-0044's own
-- sentence read on a surface that is not WhatsApp.
--
-- The original CHECK said EXACTLY one delivery row; it now says AT MOST one,
-- with the second CHECK naming the only post that may have none. Strictly
-- weaker, so every standing row passes unchanged.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_one_delivery_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_one_delivery_check
    CHECK (notice_id IS NULL OR draft_id IS NULL);

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_delivery_or_door_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_delivery_or_door_check
    CHECK (notice_id IS NOT NULL OR draft_id IS NOT NULL
           OR asked_on = 'dashboard');

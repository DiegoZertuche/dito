-- The rep's arrival on Inicio, and the line the twin writes when they arrive
-- (ticket #266; spec #258 decisions 12, 15 and 16; ADR-0014 as amended — the
-- `arrival` occasion; ADR-0044 as amended — the arrival post and its
-- `curation` part; ADR-0010, ADR-0008).
--
-- NUMBERING: …20260926100010, after …20260925100010. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ═══ THREE THINGS, AND EACH IS THE SMALLEST THE OCCASION NEEDS ═══
--
--   THE ARRIVAL — one row per arrival the runtime's local API recorded: the
--   seat, the instant, the seat-local day and which visit of that day it is.
--   Metadata only, as every trigger is (ADR-0014 as amended): nothing the rep
--   or a customer said can reach a column here.
--
--   ITS PROCESSING MARKER — `dashboard_message_processing`'s shape one
--   occasion over: the primary key is the exactly-once lock, and the row
--   commits inside the execution's own transaction, so an arrival the
--   consumer took is taken once, whichever way its run ended.
--
--   THE ARRIVAL POST — a post that names the arrival it welcomes, delivered to
--   the dashboard's door ONLY: no notice, no draft, so no `system_send` and no
--   `customer_send` can ever name it, and no knock, so no push announces it.
--   The store refuses each of the three rather than a comment promising them.
--
-- ═══ THE THROTTLE IS THE API'S AND NOT THE STORE'S ═══
--
-- A return within ten minutes of the seat's last arrival records nothing
-- (spec #258 decision 15), so there is no row for a throttled return and
-- nothing here to constrain it: `arrival.ts` reads the last row and decides,
-- under a per-seat advisory lock so two tabs opening at once cannot both find
-- the last arrival old enough.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE ARRIVAL
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rep_arrivals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Seat scope, `dashboard_messages`' own: the values come off the registry
    -- row the API resolved rather than off the request (ADR-0035).
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    -- WHEN THE REP ARRIVED — the API's own instant, never the page's.
    arrived_at timestamptz NOT NULL,
    -- THE SEAT-LOCAL DAY IT WAS CUT IN, computed by the same statement that
    -- writes the row and in the zone the exchanges read cuts in, so «the
    -- first of the day» and Trabajos' day heading (#267) are one arithmetic.
    day date NOT NULL,
    -- WHICH VISIT OF THAT DAY: the welcome, or a return. The vocabulary is
    -- `@dito/seam`'s `ARRIVAL_VISITS` and this CHECK is its other half
    -- (`migration-vocabulary.test.ts`).
    visit text NOT NULL
        CONSTRAINT rep_arrivals_visit_check
        CHECK (visit IN ('first_of_day', 'return')),
    -- The seat's previous arrival — what a return line's delta is measured
    -- from. NULL on a seat's first arrival ever.
    last_arrived_at timestamptz,
    CONSTRAINT rep_arrivals_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id),
    -- A return is later than the arrival it returns from, stated so a row
    -- written from a skewed clock cannot claim a delta that runs backwards.
    CONSTRAINT rep_arrivals_after_last_check
        CHECK (last_arrived_at IS NULL OR last_arrived_at < arrived_at)
);

COMMENT ON TABLE rep_arrivals IS
    'Ticket #266: one row per arrival on Inicio the runtime''s local API recorded — the seat, the instant, the seat-local day and which visit of that day (spec #258 decision 15). A return within ten minutes of the last arrival records nothing. Metadata only: no column can hold anything the rep or a customer said.';
COMMENT ON COLUMN rep_arrivals.visit IS
    'first_of_day (the welcome) · return (the line names what changed since the last arrival). The vocabulary is @dito/seam''s ARRIVAL_VISITS and this column''s CHECK is its other half (ticket #266).';
COMMENT ON COLUMN rep_arrivals.day IS
    'The seat-local calendar day the arrival was cut in — the key Trabajos en curso reads a day''s heading by (spec #258 decision 16).';

-- The throttle's read and the day's: one seat's arrivals, newest first. And
-- the consumer's pending read: one twin's arrivals in order.
CREATE INDEX IF NOT EXISTS rep_arrivals_by_seat
    ON rep_arrivals (seat_id, arrived_at DESC);
CREATE INDEX IF NOT EXISTS rep_arrivals_by_twin
    ON rep_arrivals (twin_id, arrived_at);

-- AN ARRIVAL IS A RECORD OF SOMETHING THAT HAPPENED, and it is the trigger an
-- execution's chain entry names. Never rewritten, never deleted — the shape
-- `dashboard_messages` has, for the reason every trigger-bearing row has it.
CREATE OR REPLACE FUNCTION rep_arrivals_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'rep_arrivals are immutable (ticket #266): % refused — an arrival is the record an execution''s trigger names', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS rep_arrivals_no_update_delete ON rep_arrivals;
CREATE TRIGGER rep_arrivals_no_update_delete
    BEFORE UPDATE OR DELETE ON rep_arrivals
    FOR EACH ROW EXECUTE FUNCTION rep_arrivals_immutable();

DROP TRIGGER IF EXISTS rep_arrivals_no_truncate ON rep_arrivals;
CREATE TRIGGER rep_arrivals_no_truncate
    BEFORE TRUNCATE ON rep_arrivals
    FOR EACH STATEMENT EXECUTE FUNCTION rep_arrivals_immutable();

-- THE LEASE HOLDER WRITES IT AND NOTHING ELSE TOUCHES IT. rep-web asks the
-- runtime to record an arrival and is granted nothing here, the door's rule
-- (…20260922100010): what the page needs back comes through the API.
GRANT SELECT, INSERT ON rep_arrivals TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON rep_arrivals FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. ITS PROCESSING MARKER
-- ═══════════════════════════════════════════════════════════════════════
--
-- The consumer's pass routes every arrival with no marker into one execution
-- and writes the marker inside that execution's transaction, beside its
-- record and its chain entry — so an arrival is composed for once, whether
-- its run posted a line or failed. A run that failed leaves the fallback line
-- standing, and the next arrival is the next chance (spec #258 decision 15).
--
-- AN ARRIVAL A LATER ONE OF THE SAME SEAT OVERTOOK is marked with no
-- execution at all. A runtime that was stopped while the rep came and went
-- finds several unrouted arrivals for one seat, and only the newest is the
-- rep standing at the page now; composing a welcome for each would be a model
-- call per arrival for lines nobody reads.

CREATE TABLE IF NOT EXISTS rep_arrival_executions (
    arrival_id uuid PRIMARY KEY REFERENCES rep_arrivals (id),
    twin_id uuid NOT NULL,
    -- The execution that composed for it, whichever way it ended — NULL for
    -- an arrival a later one overtook before the pass reached it. Deferred,
    -- as `posts.execution_id` is, because the marker is written in the same
    -- transaction as the record it names.
    execution_id uuid
        CONSTRAINT rep_arrival_executions_execution_fkey
        REFERENCES executions (id) DEFERRABLE INITIALLY DEFERRED,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT rep_arrival_executions_one_per_execution UNIQUE (execution_id)
);

COMMENT ON TABLE rep_arrival_executions IS
    'Ticket #266: one row per arrival the consumer routed — the primary key is the exactly-once lock, committed with the execution record and chain entry it names (ADR-0020). execution_id is NULL for an arrival a later arrival of the same seat overtook before the pass reached it.';

CREATE OR REPLACE FUNCTION rep_arrival_executions_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'rep_arrival_executions are immutable (ticket #266): % refused — an arrival is composed for once', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS rep_arrival_executions_no_update_delete ON rep_arrival_executions;
CREATE TRIGGER rep_arrival_executions_no_update_delete
    BEFORE UPDATE OR DELETE ON rep_arrival_executions
    FOR EACH ROW EXECUTE FUNCTION rep_arrival_executions_immutable();

DROP TRIGGER IF EXISTS rep_arrival_executions_no_truncate ON rep_arrival_executions;
CREATE TRIGGER rep_arrival_executions_no_truncate
    BEFORE TRUNCATE ON rep_arrival_executions
    FOR EACH STATEMENT EXECUTE FUNCTION rep_arrival_executions_immutable();

GRANT SELECT, INSERT ON rep_arrival_executions TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON rep_arrival_executions FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. THE ARRIVAL POST, DELIVERED TO THE DOOR ONLY
-- ═══════════════════════════════════════════════════════════════════════
--
-- A post names the arrival it welcomes, and that is its kind: the arrival
-- post is the post with `arrival_id` set, as the door's answer is the post
-- with `asked_message_id` set. Nullable with no default, so the ALTER rewrites
-- no row and every standing post is not an arrival post — which is true.

ALTER TABLE posts
    ADD COLUMN IF NOT EXISTS arrival_id uuid REFERENCES rep_arrivals (id);

COMMENT ON COLUMN posts.arrival_id IS
    'Ticket #266: the arrival this post is the twin''s line for — set exactly on an arrival post, which is delivered to the dashboard''s door only (asked_on = dashboard, no notice, no draft, no knock). ADR-0044 as amended.';

-- ONE LINE PER ARRIVAL, the bound `posts_one_reply_per_dashboard_message`
-- puts on the door's answers and for the same reason: a second line for one
-- arrival is a second welcome the rep never arrived for.
CREATE UNIQUE INDEX IF NOT EXISTS posts_one_line_per_arrival
    ON posts (arrival_id)
    WHERE arrival_id IS NOT NULL;

-- THE DOOR'S CHECK, WIDENED FOR THE KIND. A post at the dashboard's door is
-- there for exactly one reason — it answers a message, or it is the line for
-- an arrival — and a post naming either is at that door. Strictly weaker than
-- the cut it replaces for every row that exists: none carries `arrival_id`.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_door_message_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_door_message_check
    CHECK ((asked_on IS NOT DISTINCT FROM 'dashboard')
           = (asked_message_id IS NOT NULL OR arrival_id IS NOT NULL));

-- ...AND NEVER BOTH: a line that also answered a message would be paired with
-- a question in the bar's history and drawn as the welcome on the canvas.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_door_one_reason_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_door_one_reason_check
    CHECK (asked_message_id IS NULL OR arrival_id IS NULL);

-- DELIVERED TO THE DOOR ONLY, AS THE STORE'S OWN RULE (ADR-0044 as amended:
-- «no send command, no knock, no push»). No notice means no `system_send` can
-- name it and no thread renders it; no draft means no tap can release it; a
-- knock disposition of `none` means neither notify tier ever opens it. The
-- disjunct in `posts_delivery_or_door_check` that admits a post with no
-- delivery row is `asked_on = 'dashboard'`, which the check above now grants
-- the arrival post — so that check stands unchanged and this one is what
-- narrows the arrival post to nothing but the door.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_arrival_door_only_check;
ALTER TABLE posts
    ADD CONSTRAINT posts_arrival_door_only_check
    CHECK (arrival_id IS NULL
           OR (notice_id IS NULL AND draft_id IS NULL
               AND knock_disposition = 'none'));

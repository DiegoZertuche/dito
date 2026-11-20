-- The offers the rep spent, kept for the seat-local day (ticket #335).
--
-- NUMBERING: …20261005100010, after …20261004100040. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- WHY A TABLE OF ITS OWN AND NOT A MARK ON THE CURATION. The twin's lean-in
-- offers ride on `canvas_curations`, and that table is immutable by its own
-- triggers: every version is kept and the next write supersedes. A mark the
-- rep makes is not the twin's curation and must outlive the twin's next one —
-- a return arrival rewrites the curation, and an offer the rep let go an hour
-- ago must stay down. So the mark is the seat's: one row per spending, read
-- back for the day.
--
-- THE SENTENCE IS THE OFFER'S VERSION, sealed. A card keeps one offer at a
-- time and the twin may write a new sentence about it; the rep spent the one
-- they saw, so the row holds that sentence and the read compares it — a new
-- sentence on the same card is a new offer. It is the twin's words and may
-- name the card's customer, so it is sealed under the twin DEK (ADR-0008)
-- exactly as `canvas_curations.offers_enc` is, and read by the runtime alone.

CREATE TABLE IF NOT EXISTS offer_spendings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Seat scope, `rep_arrivals`' own: the values come off the registry row
    -- the API resolved rather than off the request (ADR-0035).
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    -- The card the offer is about.
    post_id uuid NOT NULL,
    -- The twin's sentence the rep saw, sealed under the twin DEK.
    sentence_enc bytea NOT NULL,
    -- WHY IT IS SPENT. The vocabulary is `@dito/seam`'s `OFFER_SPENT_REASONS`
    -- and this CHECK is its other half (`migration-vocabulary.test.ts`).
    reason text NOT NULL
        CONSTRAINT offer_spendings_reason_check
        CHECK (reason IN ('taken', 'answered', 'dismissed')),
    -- WHEN, on the API's own clock, and the seat-local day it was cut in by
    -- the same statement, in the zone every day here is cut in.
    spent_at timestamptz NOT NULL,
    day date NOT NULL,
    CONSTRAINT offer_spendings_seat_fkey
        FOREIGN KEY (seat_id, company_id) REFERENCES seats (id, company_id)
);

COMMENT ON TABLE offer_spendings IS
    'Ticket #335: one row per lean-in offer the rep took, answered or let go — the card, the twin''s sentence sealed under the twin DEK, the reason and the seat-local day — so the bar never raises it again that day, after a reload or on another device.';
COMMENT ON COLUMN offer_spendings.reason IS
    'taken · answered · dismissed. The vocabulary is @dito/seam''s OFFER_SPENT_REASONS and this column''s CHECK is its other half (ticket #335).';

-- The bar's read: one seat's spendings for one day.
CREATE INDEX IF NOT EXISTS offer_spendings_by_seat_day
    ON offer_spendings (seat_id, day);

-- A MARK IS A RECORD OF WHAT THE REP DID, never rewritten: the next day reads
-- nothing, and that is how a mark ends.
CREATE OR REPLACE FUNCTION offer_spendings_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'offer_spendings are immutable (ticket #335): % refused — a spending is kept for its day and read no more after it', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS offer_spendings_no_update_delete ON offer_spendings;
CREATE TRIGGER offer_spendings_no_update_delete
    BEFORE UPDATE OR DELETE ON offer_spendings
    FOR EACH ROW EXECUTE FUNCTION offer_spendings_immutable();

DROP TRIGGER IF EXISTS offer_spendings_no_truncate ON offer_spendings;
CREATE TRIGGER offer_spendings_no_truncate
    BEFORE TRUNCATE ON offer_spendings
    FOR EACH STATEMENT EXECUTE FUNCTION offer_spendings_immutable();

-- THE LEASE HOLDER WRITES IT AND NOTHING ELSE TOUCHES IT. rep-web asks the
-- runtime to keep a mark and reads them back through the API; it is granted
-- nothing here, the door's rule (…20260922100010).
GRANT SELECT, INSERT ON offer_spendings TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON offer_spendings FROM dito_twin_runtime;

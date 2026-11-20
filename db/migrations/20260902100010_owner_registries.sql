-- The owner side's two registries (ticket #127; spec #126 decisions 9 and
-- 13; ADR-0027 cited as context, ADR-0002, ADR-0016 as amended).
--
-- NUMBERING: the …202609021000·0 range (…100010 through …100050) is
-- reserved for this ticket, so a parallel ticket cutting a migration on the
-- same day does not collide with the four files that follow this one.
--
-- WHAT DID NOT EXIST UNTIL NOW. Company and seat have been a bare
-- `company_id uuid` and `seat_id uuid` on the seam's rows since the first
-- slice: nothing anywhere said what a company is called, and nothing at all
-- said what a seat is. That was livable while every surface was rep-side —
-- the rep knows who they are and which company they sell for — and it stops
-- being livable the moment an owner reads. ADR-0004 as amended puts the
-- FILING SEAT into owner-visible provenance, "rendered as the rep's display
-- name through the owner's seats view", and there was no seats view because
-- there was no seats table for one to read.
--
-- BOTH ARE STUBS OF ADR-0027, and are named as such here so no reader
-- mistakes them for it. ADR-0027 gives seat lifecycle exactly one executor
-- — a rep-side service that is the sole writer of seat state, owns the
-- pinned transition table, runs the ~72h closing clock and is the sole
-- caller of `DisableKey` — and gives identity a global registry keyed by
-- HMAC with a KMS-held pepper. NONE of that is here. What is here is the
-- minimum the owner's read needs: a company that can be named and lifted,
-- and a seat that can be named and attributed to. The lifecycle behind them
-- is on the horizon under Pilot readiness.
--
-- NOTHING ELSE IN THE REPO CHANGES HOW IT IDENTIFIES A COMPANY OR A SEAT.
-- `wa_events` still carries `company_id`, `seat_id` and `twin_id` per row
-- and the aperture still reads scope off that row (ADR-0003, ADR-0035);
-- `ledger.facts` still carries `filed_by_twin_id` and gains no foreign key
-- to `seats`. These two tables are read, not joined into the write path.

-- THE COMPANY, and the one flag that makes it more than a name (ADR-0016 as
-- amended). `shadow_lifted_at` is the launch gate: NULL means this
-- company's Ledger has never been lifted and every row it holds is shadow;
-- a timestamp means the lift act ran, and facts filed after it land
-- visible. This ticket only defines the column. Two other tickets read and
-- write it — the aperture stamps `shadow` at filing from it, and the lift
-- act sets it in one audited transaction — and neither is here.
--
-- MINIMAL MEANS THREE COLUMNS. No plan, no billing, no created_at: a
-- registry that grows a column nobody reads is the seat-lifecycle service
-- arriving by accident, one field at a time.
CREATE TABLE companies (
    -- Not generated: the company id is minted outside this table and has
    -- been on every seam row since slice 1. On the rig it comes from
    -- `.env.rig`; a row here is a NAME for an id that already exists, and
    -- defaulting it would invite a second identity for the same company.
    id uuid PRIMARY KEY,
    display_name text NOT NULL,
    shadow_lifted_at timestamptz,
    CONSTRAINT companies_display_name_check CHECK (btrim(display_name) <> '')
);

COMMENT ON TABLE companies IS
    'Ticket #127: the minimal company registry — a stub of ADR-0027''s lifecycle, not that lifecycle. Holds a name and the launch gate, nothing else.';
COMMENT ON COLUMN companies.id IS
    'Minted outside this table (the seam has carried it since slice 1); a row here names an id that already exists.';
COMMENT ON COLUMN companies.shadow_lifted_at IS
    'ADR-0016 as amended: NULL while this company''s Ledger is unlifted. The aperture stamps `shadow` from it at filing (#132) and the lift act sets it once, audit-chained.';

-- THE SEAT: a (person × company) employment relationship, which is
-- CONTEXT.md's word for it and the reason this table is not called anything
-- else. It is the unit of twin ownership and of attribution, and it
-- OUTLIVES THE TWIN — that is the whole argument of ADR-0004's amendment.
-- A twin is erased at retirement (its key is destroyed, ADR-0009); a seat
-- persists as retired. So a fact filed two years ago must be attributable
-- to the seat it was filed under, long after the twin that filed it stopped
-- being decryptable. Storing the twin on the fact and the seat on the
-- registry is what makes that possible without ever putting the twin in
-- front of the owner.
--
-- WHAT IS DELIBERATELY ABSENT: any WhatsApp number, any JID, any chat
-- identity. ADR-0004 as amended states the rule in full — "which chat,
-- which number, which group, and what was said stay behind the wall, and no
-- owner-granted object can join a fact to any of them". A seat's phone
-- number is ADR-0027's identity registry's, HMAC-keyed under a KMS pepper,
-- and it is not here and is not owner-visible when it arrives.
CREATE TABLE seats (
    -- Minted outside this table too, for the same reason as the company's:
    -- `wa_events.seat_id` has carried it since slice 1.
    id uuid PRIMARY KEY,
    company_id uuid NOT NULL,
    -- The twin this seat owns. It is the JOIN KEY the finalized-facts view
    -- uses to turn `filed_by_twin_id` into a seat, and it is the reason
    -- that view can expose the seat while the twin stays behind the wall:
    -- the mapping lives here, on an object the owner role holds nothing on.
    twin_id uuid NOT NULL,
    -- The rep's name, as the owner reads it. A NAME, not a judgement:
    -- ADR-0004's amendment says attribution is business provenance and the
    -- wall keeps out conversation content and conversation-derived
    -- behaviour, which is everything else about a rep.
    rep_display_name text NOT NULL,
    -- ADR-0027's lifecycle is active · enforcement-paused · closing ·
    -- retired, and the CHECK below lists ONE of them. That is not a
    -- shortcut: the other three are states some executor must be able to
    -- reach, and no executor exists (ADR-0027 gives that job to a rep-side
    -- service this slice does not build). A CHECK naming states nothing can
    -- write would read as a lifecycle that exists. Widening it is a
    -- reviewable migration, which is the point.
    state text NOT NULL,
    CONSTRAINT seats_state_check CHECK (state IN ('active')),
    CONSTRAINT seats_rep_display_name_check CHECK (btrim(rep_display_name) <> ''),
    -- A NAME, AND NEVER AN ADDRESS. This column is the one free-text value
    -- the owner can read that a person types, and ADR-0004's amendment
    -- states the rule in full: which chat, which number, which group stay
    -- behind the wall, and no owner-granted object can join a fact to any
    -- of them. A rep registered as «5215550001@s.whatsapp.net» would put a
    -- WhatsApp address on the owner's seats view and beside every fact that
    -- seat filed — so the shape is refused by the store rather than swept
    -- for afterwards. The Ledger wall audit sweeps this column too, because
    -- a constraint added today says nothing about rows written before it.
    -- ...AND NOT A NUMBER EITHER, which is the half a suffix check misses.
    -- «5215550001» carries no `@s.whatsapp.net` and is still the rep's own
    -- WhatsApp number sitting beside every fact that seat filed. The wall
    -- sweep cannot save this one: its digit comparison runs against the
    -- CAPTURE SCOPE, and the rep's own thread is excluded from it, so the
    -- rep's own number is the one number that sweep can never recognise.
    -- Ten digits is the same normalization the sweep uses, on the
    -- separators-stripped value, so «55 1234 5678» is refused too and no
    -- real name reaches it.
    CONSTRAINT seats_rep_display_name_not_an_address
        CHECK (
            rep_display_name !~* '@(s\.whatsapp\.net|g\.us|lid|broadcast)'
            AND regexp_replace(rep_display_name, '\D', '', 'g') !~ '[0-9]{10}'
        ),
    CONSTRAINT seats_company_fkey FOREIGN KEY (company_id) REFERENCES companies (id),
    -- ONE SEAT PER TWIN, and this constraint is load-bearing rather than
    -- tidy. The finalized-facts view LEFT JOINs facts to this table on
    -- `twin_id`; a second seat sharing a twin would duplicate every fact
    -- that twin filed, and the owner's timeline would silently double.
    -- CONTEXT.md's Twin says it plainly — the twin belongs to the seat —
    -- so the constraint is the model, not a guard against it.
    CONSTRAINT seats_one_seat_per_twin UNIQUE (twin_id)
);

CREATE INDEX seats_company_idx ON seats (company_id);

COMMENT ON TABLE seats IS
    'Ticket #127: the minimal seat registry — a stub of ADR-0027''s seat lifecycle, not that lifecycle. What the owner''s provenance renders from (ADR-0004 as amended: the seat, not the twin).';
COMMENT ON COLUMN seats.twin_id IS
    'The twin this seat owns — the join key that turns ledger.facts.filed_by_twin_id into a seat inside the finalized view, so the seat crosses and the twin never does (ADR-0004 as amended).';
COMMENT ON COLUMN seats.rep_display_name IS
    'The rep''s name as the owner reads it. Business provenance, never a judgement, and never a number or a JID (ADR-0004 as amended).';
COMMENT ON COLUMN seats.state IS
    'ADR-0027''s lifecycle has four states; this slice can write exactly one, `active`, because the executor that reaches the other three does not exist yet.';

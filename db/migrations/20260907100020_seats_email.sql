-- The seat's email, and the record of what notify sent (ticket #219; spec
-- #214 decision 4 and *Notify, in detail*; ADR-0022, ADR-0019's flow 4,
-- ADR-0013 class 4).
--
-- NUMBERING: …2026090710002·, after …20260906100040 (the execution stamps'
-- clock, #199) and beside …20260907100010 (ticket #218's). Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere,
-- because a migration is a statement about what a database has already been
-- through.
--
-- ═══ WHY THE SEAT GAINS AN EMAIL ═══
--
-- The dashboard is the rep's hub and it must stand with the rail down, so
-- WhatsApp is never a credential (spec #214 decision 4). A seat's email is
-- its identity: the invitation goes to it, the login code goes to it, and
-- notify resolves it from THIS COLUMN rather than from a caller's parameter
-- — which is the mechanism behind ADR-0022's "callers pass seat ids, never
-- addresses".
--
-- NULLABLE, and that is exact rather than lenient. A seat exists before
-- anybody has an address for it: the rig provisions one by hand today, and
-- on the invitation path the owner gives the email at the invite while a rep
-- who was forwarded the link types it as link day's first step (#221, #223).
-- A seat with no email is a seat notify records a refusal against, not an
-- error state.
--
-- NO GRANT MOVES, AND NO VIEW GROWS. `seats_status` (…0902100030) has a
-- PINNED COLUMN LIST — seat id, display name, state — so the owner's three
-- views are exactly what they were and this column is not on any of them.
-- ADR-0002's "named views with pinned column lists only" is why adding a
-- column here is not an owner-visible change, and FR-71a's grant diff should
-- show nothing at all from this file.
--
-- IT IS SWEPT BY THE LEDGER WALL ALL THE SAME, and deliberately left that
-- way. `auditLedgerWall` covers every text column of `public.seats` because
-- the table is owner-visible through that view (#127), so this column is
-- checked for WhatsApp addresses and for subscriber numbers like the display
-- name beside it. Excluding it would be narrowing a coverage class, which
-- this ticket does not authorize — and the day a JID is written here by
-- mistake, the sweep fails.
--
-- ONE FALSE POSITIVE IS REACHABLE, said head-on rather than left to be
-- discovered (the two-axis review's Spec axis). The digit half of that sweep
-- compares a column's stripped digits against the last ten digits of every
-- chat in `scope_allowlist`, so an address BUILT FROM A PHONE NUMBER —
-- «5551234567@gmail.com», ordinary enough in Mexico — turns the wall check
-- red if those ten digits are also a scoped counterparty's. It is a false
-- positive and never a leak: the sweep fails safe, so the cost is a red CI
-- run rather than an address crossing. Refusing such an address in the CHECK
-- below would refuse a real rep's real email, which is worse; the residual
-- is recorded on the ticket.
--
-- ═══ WHY THE SEND RECORD IS CONTENT-FREE ═══
--
-- Email is ADR-0019's flow 4: "magic links, grave events, departure records
-- — Ledger-derived and status content, never conversation content". What the
-- message SAID is the message's; what the store keeps is that a message of a
-- named type was asked for, for a named seat, at a named instant, and what
-- became of the ask. No address, no code, no body, no subject — the CHECK on
-- `provider_message_id` is the one column that could plausibly carry one and
-- it refuses the shape.
--
-- WRITTEN FIRST, SETTLED AFTER — `runtime_requests`' shape (…0906100020) and
-- `send_commands`' before it, which is why `outcome` and `settled_at` are
-- nullable. The argument for it lives on `@dito/notify`'s `notify.ts`, with
-- the service that does the writing.

ALTER TABLE seats
    ADD COLUMN email text;

COMMENT ON COLUMN seats.email IS
    'The seat''s email — its identity for the dashboard, and the address notify resolves a recipient to (ticket #219; spec #214 decision 4). NULL until the owner gives it at the invite or the rep types it on link day (#221, #223). Not on `seats_status`: the owner''s views keep their pinned column lists (ADR-0002).';

-- AN ADDRESS OR NOTHING. The shape is checked at the store for the reason
-- every other selector on this schema is (`runtime_requests_chat_jid_is_an_
-- address_check`, `seats_rep_display_name_not_an_address`): this column is
-- read by a service that then hands its value to SES, and a value that is
-- not an address is either a typo nobody will see until a rep cannot log in,
-- or free text in a column classed as metadata. One local part, one domain
-- with a dot, no whitespace and no second `@` — the shape of an address
-- rather than RFC 5322's grammar, which no CHECK should be trying to be.
--
-- 254 IS THE LIMIT SMTP IMPOSES on a forward path, so a longer value is not
-- an address any transport would take.
ALTER TABLE seats
    ADD CONSTRAINT seats_email_check
        CHECK (email IS NULL
               OR (length(email) <= 254
                   AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));

-- ── The send record ────────────────────────────────────────────────────────

CREATE TABLE notify_sends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The seat the message was for. A foreign key, so a record cannot name a
    -- seat nobody registered — and it is the reason an ask that names no real
    -- seat writes no row at all: there would be nothing to attach it to.
    seat_id uuid NOT NULL REFERENCES seats (id),
    -- Which message, from the closed catalog `@dito/notify` holds. See the
    -- CHECK below: the vocabulary is the code's and this constraint is its
    -- other half (`migration-vocabulary.test.ts`).
    message_type text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    -- NULL while the ask is in flight. See the header: the row is written
    -- before the send and settled after, so an unsettled row is one whose
    -- process ended in the middle of sending.
    outcome text,
    -- Why, as a closed word and never as a sentence: a reason a person typed
    -- would be the one column on this table that could carry content.
    reason text,
    -- The transport's own id for the message, which is what an operator
    -- takes to the provider's console when a rep says nothing arrived. It is
    -- the closest this table comes to content, and the CHECK below is why it
    -- is not: an SES message id is an opaque token, and nothing shaped like
    -- an address fits.
    provider_message_id text,
    settled_at timestamptz,
    CONSTRAINT notify_sends_message_type_check
        CHECK (message_type IN ('invitation', 'login_code')),
    CONSTRAINT notify_sends_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('sent', 'refused', 'failed')),
    CONSTRAINT notify_sends_reason_check
        CHECK (reason IS NULL OR reason IN ('no_email', 'transport_failed')),
    -- A reason belongs to an ask that did not get what it asked for, and to
    -- no other: `sent` explains itself, and an in-flight row has nothing to
    -- explain yet. `runtime_requests_reason_paired_check`'s shape.
    CONSTRAINT notify_sends_reason_paired_check
        CHECK ((reason IS NOT NULL) = (outcome IS NOT NULL AND outcome <> 'sent')),
    -- Settled means settled: an outcome and the instant it was written
    -- arrive together.
    CONSTRAINT notify_sends_settled_check
        CHECK ((outcome IS NULL) = (settled_at IS NULL)),
    -- ONLY A SEND HAS A PROVIDER ID. A refused or failed row carrying one
    -- would say the transport accepted a message the record says it never
    -- took — and that is the one disagreement an operator reading this table
    -- could not resolve from anywhere else.
    CONSTRAINT notify_sends_provider_message_id_paired_check
        CHECK (provider_message_id IS NULL OR outcome = 'sent'),
    -- CONTENT-FREE, ENFORCED. `@` is the one character every email address
    -- carries and no provider token does — the same argument and the same
    -- character `runtime_requests_parameters_content_free_check` makes one
    -- table over. The length bound is what stops the column being a place a
    -- body could be pasted.
    CONSTRAINT notify_sends_provider_message_id_content_free_check
        CHECK (provider_message_id IS NULL
               OR (provider_message_id NOT LIKE '%@%'
                   AND length(provider_message_id) <= 200))
);

COMMENT ON TABLE notify_sends IS
    'Ticket #219: one row per message notify was asked to send — the seat, the message type from the closed catalog, when it was asked, and what became of the ask (spec #214, *Notify, in detail*). Content-free: no address, no code, no body, no subject. Written before the send and settled after, so an unsettled row means the send may have happened.';
COMMENT ON COLUMN notify_sends.message_type IS
    'The closed catalog''s name for the message: invitation · login_code (ADR-0022). The vocabulary is `@dito/notify`''s constant and this column''s CHECK is its other half.';
COMMENT ON COLUMN notify_sends.outcome IS
    'sent — the transport took it. refused — the ask could not be served and nothing was sent (see `reason`). failed — the transport would not take it. NULL while in flight (ticket #219).';
COMMENT ON COLUMN notify_sends.reason IS
    'A closed word, never a sentence: no_email (the seat has no address yet) · transport_failed (ticket #219). Present exactly when the outcome is not `sent`.';
COMMENT ON COLUMN notify_sends.provider_message_id IS
    'The transport''s own opaque id for the message, for an operator taking a complaint to the provider (ticket #219). Present only on a send, and fenced against carrying an address.';

-- What an operator reads: this seat's sends, newest first.
CREATE INDEX notify_sends_seat_idx
    ON notify_sends (seat_id, requested_at DESC);

-- ── Grants, on purpose (…100012's rule) ───────────────────────────────────
--
-- …100012 granted `dito_twin_runtime` write on ALL TABLES IN SCHEMA public
-- at a point in time, and its own header states the rule that makes this
-- block necessary: a rep-side store added later must be granted on purpose.
-- A table created after that migration is reachable by nobody until a
-- migration says so.
--
-- NOBODY IS GRANTED ANYTHING HERE, and that is the decision rather than an
-- omission. Notify is class 4 of ADR-0013 — never on any tool surface — and
-- the process that will call it in production is rep-web, whose role
-- `dito_rep_web` does not exist yet (#221 creates it with its own migration
-- and its own clause in the grants check). Until then the one caller is the
-- operator script, which runs as the schema owner. Granting the twin runtime
-- write on this table today would put a send recorder inside the one process
-- that holds the model, for no caller.
--
-- The REVOKEs are a statement rather than a change: …100012's blanket grant
-- does not reach a table created after it, so nothing is being taken away.
-- They are here so the GRANT DIFF says so too, and so a later migration
-- handing a role write is visible in FR-71a's own diff rather than
-- discovered from a row nobody asked for (…0904100020's block makes exactly
-- this argument).
REVOKE ALL ON notify_sends FROM dito_twin_runtime;
REVOKE ALL ON notify_sends FROM dito_aperture;

-- AND NOTHING FOR THE OWNER, which needs saying because the seat registry it
-- reads is the table this file also touched. `dito_owner` holds SELECT on
-- three views and nothing else (ADR-0002; FR-71a claim 6), and a rep's
-- address is not on any of them.
REVOKE ALL ON notify_sends FROM dito_owner;

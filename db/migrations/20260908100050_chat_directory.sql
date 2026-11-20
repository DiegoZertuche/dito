-- The chat directory, the plane's request seam, the per-twin history window
-- and the pairing code's rail status (ticket #222; spec #214 decisions 7 and
-- 8, *Plane changes*, *Schema changes*, *Link day, in detail*; ADR-0004,
-- ADR-0008, ADR-0012, ADR-0023, ADR-0031, ADR-0042).
--
-- NUMBERING: …20260908100050, after …20260907100040 (rep-web's credential,
-- #221). Forward-only: no migration in this repo is ever edited once it has
-- applied anywhere, because a migration is a statement about what a database
-- has already been through.
--
-- ═══ WHAT ARRIVES HERE ═══
--
--   1. `chat_directory` — one row per twin per PN-canonical chat: the LID,
--      the kind, the display name SEALED, last activity, one forward-only
--      anchor, and the ninety-day fill's progress. Never content.
--   2. `plane_requests` — the requests the PLANE serves: scope in, scope out,
--      and the pairing-code ask. The runtime writes them, the plane serves
--      them, and every one of them ends with an outcome.
--   3. `history_windows` — the ninety-day line, per twin, as an ordinary
--      primitive (FR-15) rather than a constant in the plane.
--   4. `rail_status_events.status` gains `pairing_code` beside `qr`.
--   5. The grants: `dito_rep_web` reads the directory's plaintext columns and
--      no sealed one; `dito_twin_runtime` writes requests and reads back what
--      became of them.
--
-- ═══ WHY THE DIRECTORY EXISTS, AND WHAT LEAVES THE SOCKET ═══
--
-- SCOPING IS A STANDING CAPABILITY, and this table is what makes it one (spec
-- #214 decision 7): the rep scopes a chat in next month and the plane can
-- still ask the phone for its last ninety days, because it kept the chat's
-- ANCHOR. Without a row here a chat the rep did not scope at pairing has no
-- way back to its history at all — the pairing push is dropped at the socket
-- and nothing else remembers that the conversation exists.
--
-- ADR-0023 IS AMENDED BY THIS TABLE, and the amendment is exactly one
-- sentence wide: metadata, a LID and an anchor of an out-of-scope chat now
-- leave the socket, sealed where they are a name; CONTENT never does. The
-- per-event allowlist read stays uncached and still drops every out-of-scope
-- message before persistence, so "nothing the rep did not scope rests
-- anywhere" is unchanged for everything anybody said. (The ADR text is
-- written at the slice boundary from this ticket's record.)
--
-- THE NAME IS SEALED UNDER THE TWIN DEK, exactly as a `wa_events` payload is
-- (ADR-0008): a chat's display name is what a rep's phone calls a person, and
-- the whole point of the wall is that a reader of shared Postgres learns no
-- such thing. It is the ONE sealed column here, which is why rep-web's grant
-- below is column-level: `has_table_privilege` cannot say "everything but
-- one".
--
-- ═══ WHY THE PLANE'S REQUESTS ARE THEIR OWN TABLE ═══
--
-- `runtime_requests` (…20260906100020) is the same SHAPE and could not be the
-- same table, for a reason that migration states about itself: "SELECT AND
-- UPDATE FOR THE RUNTIME, AND NOT INSERT. The runtime is the SERVER of
-- requests and never a requester: a runtime that could write its own rows
-- could fabricate the operator's ask." Here the runtime is the REQUESTER and
-- the plane is the server, so the grants are the exact mirror — INSERT and
-- SELECT for the runtime, nothing else — and one table cannot hold both
-- claims. Two tables, two servers, two grant sets that each mean something.
--
-- NOTHING CROSSES THE WALL HERE (ADR-0004). Push-only crossing governs facts
-- reaching the Ledger; both parties to this seam are rep-side processes on the
-- rep side's own Postgres, and no row here names an entity, a fact or a
-- company-visible object. It is `send_commands` with the direction reversed.
--
-- AND THE PLANE'S POLLER IS STILL ONE LOOP (ADR-0012, which permits "internal
-- sub-loops … same harness, same twin, nothing user-named"): the plane polls
-- this table on its own second-cadence tick beside the executor's, in the same
-- process, over the same twin, and neither loop is anything a rep or an
-- operator can name or schedule.
--
-- ═══ CONTENT-FREE, CHECKED RATHER THAN PROMISED ═══
--
-- Every plaintext column that could plausibly hold a sentence is fenced by a
-- CHECK, the way `runtime_requests` and `notify_sends` fence theirs: the
-- parameters document is a CLOSED typed schema of exactly one key, the phone's
-- own end-of-transfer word is an upper-case protocol name and nothing else,
-- and an address is an address.
--
-- THE ADDRESS FENCE BOUNDS THE SHAPE AND NOT THE VOCABULARY, and that
-- distinction is load-bearing rather than stylistic. The plane writes a
-- directory row for EVERY conversation the rail hands it, before the guard
-- decides scope — so an address form this CHECK did not anticipate is not a
-- refused row, it is a refused INSERT reaching the guard's fail-stop and
-- KILLING CAPTURE over an ordinary delivery. `status@broadcast` is exactly
-- that: whatsmeow's own standing JID for the status feed, with `status` where
-- an enumeration of "digits and four servers" expects digits. Newsletters,
-- `hosted`, `interop`, `msgr` and `c.us` are the same hazard one library
-- release away.
--
-- So the fence is: one `@`, a user part of rail-identity characters within a
-- rail identity's length, and a lower-case dotted server. WHAT IT REFUSES is
-- every shape a message or a person's name takes — whitespace, accented
-- letters, punctuation, anything long. WHAT IT DOES NOT refuse is a bare
-- lower-case word in the user part, because `status` IS one; that is the price
-- of never fail-stopping the plane on an address, and it is worth paying,
-- because a single word carries no sentence, names no person and states no
-- number.
--
-- ═══ IDEMPOTENT OVER EXISTING ROWS, AND OVER ITSELF ═══
--
-- The rig has twins with `wa_events`, `scope_allowlist` and
-- `rail_status_events` rows, `qr` rows among them, so this file must survive
-- being applied over them and applied twice. Every statement is re-runnable:
-- `IF NOT EXISTS` on what can take it, `DROP CONSTRAINT IF EXISTS` +
-- `ADD` on the one CHECK that is re-cut, a duplicate-object handler on what
-- can take neither. Atlas never re-applies a file; what this is for is an
-- OPERATOR replaying it by hand against a database whose revision history
-- says nothing — the upgrade rehearsal #218, #220 and #221 each ran, and this
-- one ran too.
--
-- THE `status` RE-CUT WIDENS AND VALIDATES. …20260827100007 wrote the
-- constraint INLINE and unnamed on the column, so PostgreSQL named it
-- `rail_status_events_status_check`; this drops that name and re-adds the
-- five-word set. `NOT VALID` is deliberately not used: the set only GAINS a
-- word, so every existing row satisfies the new constraint by construction
-- and a validated constraint is the stronger claim. It is also the re-cut
-- that puts this vocabulary under `migration-vocabulary.test.ts`, whose parser
-- looks for `CONSTRAINT <name> CHECK (… IN (…))` and can see none written
-- inline. `@dito/seam`'s `RAIL_STATUSES` is the constraint's other half.

-- ── The chat directory ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_directory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- On every rep-side row since slice 1. One plane process serves one twin.
    twin_id uuid NOT NULL,
    -- THE CHAT'S ONE GUARD IDENTITY, PN-canonical (the plane's
    -- `canonicalDMChat`), so a directory row, an allowlist row and a
    -- `wa_events` row all name the same chat by the same name. A chat the rail
    -- only ever addressed by LID and supplied no alternative for keys on that
    -- LID, exactly as the allowlist does — nothing is guessed.
    chat_jid text NOT NULL,
    -- ...AND ITS OTHER NAME, when the plane has learned it. The phone answers
    -- an on-demand history request only when the chat is addressed by its LID
    -- (#216's readings of 2026-09-07), so this column is what makes a later
    -- scope-in askable at all. Filled when known and NEVER BLANKED: a sync
    -- that omits it says nothing about the mapping, and forgetting a LID would
    -- retire a chat's history for good.
    lid_jid text,
    -- What the rail's address space divides into, as a closed set. See the
    -- COMMENT below for the argument.
    kind text NOT NULL,
    -- The display name, SEALED under the twin DEK exactly as a `wa_events`
    -- payload is (ADR-0008). NULL means the plane has not learned one — an
    -- absence, never an empty stamp, which is the same wire rule `push_name`
    -- follows on the seam.
    name_enc bytea,
    -- The instant of the newest thing the plane has seen happen in this chat.
    -- Metadata: the scoping page orders by it so a rep finds a chat by when
    -- they last spoke in it.
    last_activity_at timestamptz,
    -- THE ANCHOR: the newest message the plane knows of, as the on-demand
    -- request needs it — its rail stanza id, its direction and its instant
    -- (whatsmeow's `BuildHistorySyncRequest` takes exactly those three). It
    -- moves FORWARD ONLY: an anchor that went backwards would ask the phone
    -- for a window the fill has already paged through.
    anchor_message_id text,
    anchor_from_me boolean,
    anchor_at timestamptz,
    -- The fill's progress, which is what the rep's sync view renders (spec
    -- #214 *Link day, in detail*: "the plane records per-chat fill progress on
    -- the directory row; rep-web shows it").
    fill_pages integer NOT NULL DEFAULT 0,
    -- The oldest instant the fill has reached, moving BACKWARDS only for the
    -- same reason the anchor moves forwards only.
    fill_oldest_at timestamptz,
    -- The phone's own last word about whether more remains on the primary
    -- (`endOfHistoryTransferType`). Its VALUE is the protocol's enum name, so
    -- the fence below is a shape rather than a closed set: the words are
    -- WhatsApp's and a library that learns a sixth must not need a migration
    -- to record it.
    fill_end_of_transfer text,
    fill_last_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- ONE ROW PER TWIN PER CHAT, and the upsert's conflict target: every sync
    -- and every contact event writes through it, so two rows for one chat
    -- would make "this chat's anchor" a question with two answers.
    CONSTRAINT chat_directory_twin_chat_key UNIQUE (twin_id, chat_jid),
    CONSTRAINT chat_directory_kind_check
        CHECK (kind IN ('self', 'dm', 'group', 'other')),
    -- AN ADDRESS OR NOTHING. `runtime_requests`' own `chat_jid` CHECK makes
    -- half the argument — every other column here is fenced against content,
    -- and a free-text chat selector let `chat_jid = 'Juan pidió 100 cajas'`
    -- satisfy every constraint. The other half is the header's: this column
    -- takes every address the RAIL can hand the guard, `status@broadcast`
    -- included, because a refused INSERT here kills capture rather than
    -- refusing a row. Shape, not vocabulary.
    CONSTRAINT chat_directory_chat_jid_is_an_address_check
        CHECK (chat_jid ~ '^[A-Za-z0-9._:-]{1,64}@[a-z][a-z.]{0,31}$'),
    -- ...and the LID is a LID. It is the one identity the on-demand request
    -- names the chat by, so a row carrying a phone number here would send a
    -- request the phone answers with silence.
    CONSTRAINT chat_directory_lid_jid_is_a_lid_check
        CHECK (lid_jid IS NULL OR lid_jid ~ '^[0-9]+(:[0-9]+)?@lid$'),
    -- AN ANCHOR IS THREE FACTS OR IT IS NOTHING. The request cannot be built
    -- from two of them, so a row holding a stanza id with no instant would be
    -- a chat that looks fillable and is not.
    CONSTRAINT chat_directory_anchor_whole_check
        CHECK (num_nulls(anchor_message_id, anchor_from_me, anchor_at) IN (0, 3)),
    -- The stanza id is a rail id: WhatsApp's own are hex or base64-ish and
    -- carry no `@`, so this fences the one plaintext column left that could
    -- take a sentence. Bounded too — a rail id is short, and a long one is not
    -- an id.
    CONSTRAINT chat_directory_anchor_message_id_check
        CHECK (anchor_message_id IS NULL
               OR (anchor_message_id ~ '^[A-Za-z0-9_:.-]{1,128}$')),
    CONSTRAINT chat_directory_fill_pages_check CHECK (fill_pages >= 0),
    -- THE PHONE'S OWN WORD AND NOTHING ELSE: an upper-case protocol enum name.
    -- Not a closed set — the values are WhatsApp's, not this repo's — and not
    -- free text either.
    CONSTRAINT chat_directory_end_of_transfer_shape_check
        CHECK (fill_end_of_transfer IS NULL
               OR fill_end_of_transfer ~ '^[A-Z][A-Z0-9_]{0,80}$')
);

COMMENT ON TABLE chat_directory IS
    'Ticket #222: one row per twin per PN-canonical chat — the LID, the kind, the display name SEALED under the twin DEK, last activity, one forward-only anchor and the ninety-day fill''s progress. Upserted for EVERY conversation the plane sees, in scope or not; content is still dropped at the socket on the uncached allowlist read (ADR-0023 as this ticket amends it: metadata, a LID and an anchor leave the socket, content never). What makes a later scope-in askable (spec #214 decision 7).';
COMMENT ON COLUMN chat_directory.kind IS
    'What the rail''s ADDRESS SPACE divides into, not a product taxonomy: self (the rep''s own thread, whose scope is structural — ADR-0023) · dm (one counterparty) · group · other (anything else the rail addresses, a broadcast or status list among them). Four words because a chat is one of those four to the plane, and the plane judges nothing beyond the address (ADR-0005). The vocabulary is `@dito/seam`''s `CHAT_KINDS` and this CHECK is its other half (ticket #222).';
COMMENT ON COLUMN chat_directory.lid_jid IS
    'The chat''s hidden-user identity, when the plane has learned it. Filled and never blanked: the on-demand history request is answered only when it addresses the chat by LID (#216), so forgetting one retires that chat''s history (ticket #222).';
COMMENT ON COLUMN chat_directory.name_enc IS
    'The chat''s display name, sealed under the twin DEK exactly as a wa_events payload is (ADR-0008). The one sealed column here, which is why rep-web''s grant is column-level. NULL is an absence, never an empty name (ticket #222).';
COMMENT ON COLUMN chat_directory.anchor_message_id IS
    'The newest message the plane knows of in this chat — the rail stanza id whatsmeow''s history request pages backwards from. Forward-only: an anchor that moved backwards would re-ask a window the fill has already read (ticket #222).';
COMMENT ON COLUMN chat_directory.fill_end_of_transfer IS
    'The phone''s own last word about whether more of this chat remains on the primary (`endOfHistoryTransferType`). WhatsApp''s vocabulary, not this repo''s, so the CHECK bounds its SHAPE rather than its membership (ticket #222).';

-- The scoping page's own read: one twin's chats, most recently active first.
CREATE INDEX IF NOT EXISTS chat_directory_twin_activity_idx
    ON chat_directory (twin_id, last_activity_at DESC NULLS LAST);

-- ...and the guard's LID resolution, which asks "which chat is this LID" for
-- an on-demand page the phone keyed by LID and stated no `pnJid` for (#216's
-- reading of 2026-09-07, the failure ADR-0042's undecidable drop would
-- otherwise take). Partial: a row with no LID answers nothing.
CREATE INDEX IF NOT EXISTS chat_directory_twin_lid_idx
    ON chat_directory (twin_id, lid_jid)
    WHERE lid_jid IS NOT NULL;

-- ── The ninety-day line, per twin ─────────────────────────────────────────
--
-- FR-15's product default as an ORDINARY PRIMITIVE (spec #214 decision 8:
-- "History per included chat is the last 90 days, a product default owned as
-- an ordinary primitive, tunable per twin later"). Shaped like
-- `pacing_thresholds` (…20260826100005) and seeded the same way, by
-- `rig-provision.ts` from `@dito/twin-runtime`'s own constant.
--
-- A TABLE RATHER THAN A CONSTANT, AND THE PLANE READS IT PER FILL. A number
-- compiled into the plane cannot be tuned for one twin without a deploy, and a
-- number cached in the plane cannot be tuned during a link day at all. It is
-- read with one direct SELECT when a fill starts; a twin with no row is
-- REFUSED by name rather than filled to a default, because a fill that
-- silently chose its own window would write history the product never
-- promised.
--
-- NOT A COLUMN ON `pacing_thresholds`: that table is what the send-lock
-- writer reads to decide how fast the twin may SEND (ADR-0017), and a history
-- window has nothing to do with pacing. One table, one reason to change.
CREATE TABLE IF NOT EXISTS history_windows (
    twin_id uuid PRIMARY KEY,
    -- How many days back a scope-in fills. Positive by construction: a
    -- window of zero days is a fill that asks the phone for nothing, which is
    -- a scope-in that silently does not happen.
    days integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT history_windows_days_check CHECK (days > 0)
);

COMMENT ON TABLE history_windows IS
    'Ticket #222: how many days of history a scope-in fills, per twin — FR-15''s ninety-day product default as an ordinary primitive (spec #214 decision 8). Read by the plane with one SELECT per fill, never compiled in; a twin with no row is refused by name rather than filled to a guess.';

-- ── The requests the plane serves ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plane_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- Which of the three the plane is being asked for. See the COMMENT below.
    kind text NOT NULL,
    -- THE CHAT IS A COLUMN, NEVER A PARAMETER — `runtime_requests` makes this
    -- argument in full, and the CHECK below is what makes it true here: an
    -- address in the parameters document would fail the content-free fence.
    -- NULL for the pairing-code ask, which is about a number and not a chat.
    chat_jid text,
    -- What the ask carries beside its chat, as METADATA: `phone`, the seat's
    -- number as the pairing code is generated from, digits only. A closed,
    -- typed schema at storage time — exactly one key may appear — so nothing
    -- shaped like a sentence fits through it and an operator learns at the
    -- INSERT rather than a tick later.
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- When the plane's poll picked it up. NULL is what the poll selects on, so
    -- a row taken and not settled is one the plane was serving when it went
    -- away — and the next start settles it `interrupted`.
    taken_at timestamptz,
    -- How many pages the fill fetched. Zero is honest: a scope-out fetches
    -- none, and so does a scope-in whose first page was empty.
    pages integer NOT NULL DEFAULT 0,
    outcome text,
    -- Why the ask was not served, as a closed word and never as a sentence.
    reason text,
    -- ...and how a SERVED fill ended, which is a different question from why an
    -- unserved one failed. See the COMMENT below.
    stopped_by text,
    settled_at timestamptz,
    CONSTRAINT plane_requests_kind_check
        CHECK (kind IN ('scope_in', 'scope_out', 'pairing_code')),
    CONSTRAINT plane_requests_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('served', 'refused', 'failed')),
    CONSTRAINT plane_requests_reason_check
        CHECK (reason IS NULL OR reason IN ('no_directory_row',
                                            'no_anchor',
                                            'no_lid',
                                            'no_history_window',
                                            'rail_not_linked',
                                            'already_linked',
                                            'malformed_parameter',
                                            'pass_failed',
                                            'interrupted')),
    CONSTRAINT plane_requests_stopped_by_check
        CHECK (stopped_by IS NULL OR stopped_by IN ('ninety_day_line',
                                                    'empty_page',
                                                    'no_more_on_primary',
                                                    'no_access',
                                                    'wait_timeout',
                                                    'anchor_repeated',
                                                    'descoped')),
    -- A reason belongs to a request that did not get what it asked for, and to
    -- no other: `served` explains itself and a pending row has nothing to
    -- explain yet (`runtime_requests_reason_paired_check`'s shape).
    CONSTRAINT plane_requests_reason_paired_check
        CHECK ((reason IS NOT NULL) = (outcome IS NOT NULL AND outcome <> 'served')),
    -- ...and a STOP belongs to a served fill and to nothing else. A scope-out
    -- and a pairing code do not page, so a stop on one would describe a loop
    -- that never ran; an unserved scope-in has a reason instead.
    CONSTRAINT plane_requests_stopped_by_paired_check
        CHECK ((stopped_by IS NOT NULL) = (kind = 'scope_in' AND outcome = 'served')),
    -- A chat for the two scope acts and no chat for the pairing ask: the
    -- pairing code is about the seat's number, and a chat on it would be a
    -- selector nothing reads.
    CONSTRAINT plane_requests_chat_paired_check
        CHECK ((chat_jid IS NULL) = (kind = 'pairing_code')),
    -- The same shape fence the directory carries, for the same reason and one
    -- more: the chat a scope act names is a chat off the scoping page, and the
    -- page lists everything the directory holds.
    CONSTRAINT plane_requests_chat_jid_is_an_address_check
        CHECK (chat_jid IS NULL
               OR chat_jid ~ '^[A-Za-z0-9._:-]{1,64}@[a-z][a-z.]{0,31}$'),
    CONSTRAINT plane_requests_settled_check
        CHECK ((outcome IS NULL) = (settled_at IS NULL)),
    -- Nothing is settled before it was taken: a row with an outcome and no
    -- `taken_at` would say the plane decided about a request it never read.
    CONSTRAINT plane_requests_taken_before_settled_check
        CHECK (outcome IS NULL OR taken_at IS NOT NULL),
    CONSTRAINT plane_requests_pages_check CHECK (pages >= 0),
    -- A REFUSAL FETCHES NOTHING, and this is what stops a row claiming both.
    -- Every refusal is decided before the first request leaves the socket.
    CONSTRAINT plane_requests_refused_fetches_nothing_check
        CHECK (outcome <> 'refused' OR pages = 0),
    -- A document, not a scalar: a bare `true` here would be a shape no reader
    -- could interpret.
    CONSTRAINT plane_requests_parameters_object_check
        CHECK (jsonb_typeof(parameters) = 'object'),
    -- EXACTLY ONE KEY AND NO OTHER. Subtracting it must leave the empty
    -- document, so `{"message": "…"}` is refused at the INSERT rather than
    -- read and discarded a tick later — which is the difference between
    -- content that never crossed and content the store is holding.
    CONSTRAINT plane_requests_parameters_keys_check
        CHECK (parameters - 'phone' = '{}'::jsonb),
    -- ...and the one key is a phone NUMBER: international digits, as
    -- `rig-provision.ts` validates one and as whatsmeow's `PairPhone` takes
    -- one. Not an address and not a name.
    CONSTRAINT plane_requests_parameters_phone_check
        CHECK (NOT parameters ? 'phone'
               OR parameters ->> 'phone' ~ '^[0-9]{10,15}$'),
    -- A pairing-code ask IS its number, so the parameter is required there and
    -- refused everywhere else: a scope act with a phone on it would be a
    -- number nothing reads, sitting in a store this repo classes
    -- metadata-only.
    CONSTRAINT plane_requests_phone_paired_check
        CHECK ((parameters ? 'phone') = (kind = 'pairing_code')),
    -- CONTENT-FREE, ENFORCED — the last fence, and the one that survives a
    -- future key. `runtime_requests_parameters_content_free_check` argues it:
    -- `@` is the one character every WhatsApp address carries and nothing this
    -- document holds ever does.
    CONSTRAINT plane_requests_parameters_content_free_check
        CHECK (parameters::text NOT LIKE '%@%')
);

COMMENT ON TABLE plane_requests IS
    'Ticket #222: one row per ask the PLANE serves — scope a chat in (and fill its ninety days), scope a chat out, or generate a pairing code. The runtime writes them and the plane serves them, which is the exact mirror of `runtime_requests` and the reason this is a second table rather than a widened one (spec #214 decisions 7 and 8). Content-free: the chat is a column under an address CHECK and the parameters are a closed typed schema of one key.';
COMMENT ON COLUMN plane_requests.kind IS
    'scope_in — the rep marked a chat; the plane writes nothing to the allowlist (the runtime already did, in the act''s own transaction) and pages the chat''s history backwards to the ninety-day line. scope_out — the rep unmarked it; the fill stops mattering and the capture guard drops the chat''s next message at the socket. pairing_code — the plane asks the library for a phone-pairing code and writes it as a rail status row (ADR-0031''s ~160-second window). The vocabulary is `@dito/seam`''s `PLANE_REQUEST_KINDS` (ticket #222).';
COMMENT ON COLUMN plane_requests.outcome IS
    'served — the plane did what was asked; `pages` says how much the fill fetched and `stopped_by` says how it ended. refused — the ask could not be served and nothing was fetched (see `reason`). failed — the PLANE could not serve it, or went away mid-serve; the loop carries on, because a bad request row must never fail-stop the rail (ticket #222).';
COMMENT ON COLUMN plane_requests.reason IS
    'A closed word, never a sentence: no_directory_row · no_anchor · no_lid · no_history_window · rail_not_linked · already_linked · malformed_parameter · pass_failed · interrupted. Present exactly when the outcome is not `served` (ticket #222).';
COMMENT ON COLUMN plane_requests.stopped_by IS
    'How a SERVED fill ended, which is not why an unserved one failed: ninety_day_line (a page reached past the window) · empty_page · no_more_on_primary (the phone''s own word for an exhausted chat) · no_access (the phone says more remains and this companion may not have it — asking again cannot change that) · wait_timeout (the phone stopped answering; the progress that landed stands) · anchor_repeated (the phone returned a page the fill had already asked from) · descoped (the rep switched the chat off while the sitting was running, so the pages after it would be dropped at the socket). Present exactly on a served scope_in (ticket #222).';

-- THE POLL, WHICH RUNS EVERY TICK, over a table that only grows: partial on
-- the untaken rows, keyed by the twin whose plane this is, ordered the way
-- they are served (`runtime_requests_pending_idx`'s shape).
CREATE INDEX IF NOT EXISTS plane_requests_pending_idx
    ON plane_requests (twin_id, requested_at)
    WHERE taken_at IS NULL;

-- ...and the requester's own read: what became of one twin's asks.
CREATE INDEX IF NOT EXISTS plane_requests_twin_requested_idx
    ON plane_requests (twin_id, requested_at DESC);

-- ── The pairing code joins the rail's status vocabulary ───────────────────
--
-- Spec #214 *Schema changes*: "`rail_status_events` gains `pairing_code` as a
-- status value beside `qr`." The row's shape is the `qr` row's shape: the
-- code goes in `detail`, exactly as the QR payload does, because both are
-- transient link credentials the plane itself generated rather than anything
-- a rep or a customer said (…20260827100007 argues that in full).
--
-- WHICH IS ALSO WHY `detail` STAYS UNREACHABLE FOR rep-web. …20260907100040
-- granted four columns and withheld `detail` precisely because a `qr` row's
-- detail is a live credential for linking a WhatsApp account; a
-- `pairing_code` row's detail is the same credential in eight characters, so
-- this migration adds a second reason for a grant that is already correct and
-- changes nothing about it.
ALTER TABLE rail_status_events DROP CONSTRAINT IF EXISTS rail_status_events_status_check;

ALTER TABLE rail_status_events
    ADD CONSTRAINT rail_status_events_status_check
        CHECK (status IN ('qr', 'linked', 'dropped', 'logged_out', 'pairing_code'));

COMMENT ON COLUMN rail_status_events.status IS
    'The rail''s closed lifecycle vocabulary: qr · linked · dropped · logged_out · pairing_code (ticket #222). The two credentials — a QR payload and an eight-character phone-pairing code — ride in `detail`, which is why nothing but the plane may read that column. The vocabulary is `@dito/seam`''s `RAIL_STATUSES` and this CHECK is its other half, which the migration sweep compares — a constraint written inline carries no name for its parser to find.';

-- ── Grants, on purpose (…20260829100012's rule) ───────────────────────────
--
-- …20260829100012 granted the two rep-side roles across `ALL TABLES IN SCHEMA
-- public` at a point in time, and its own header states the rule: a store
-- added later is granted on purpose. All three tables above are created after
-- it, so they start reachable by nobody.
--
-- THE PLANE HAS NO ROLE OF ITS OWN, and that is worth saying rather than
-- leaving to be inferred from an absence. It connects on
-- `DITO_DATABASE_URL` as the schema owner, so it needs no grant here and gets
-- none; the fleet operator role that would change that is slice 7's. Nothing below hands the plane anything,
-- and nothing needs to.

-- THE RUNTIME IS THE REQUESTER HERE — the exact mirror of `runtime_requests`,
-- where it is the server. INSERT because the rep's scope act writes the
-- allowlist row and the request row in one transaction; SELECT because the
-- act's caller has to be able to say what became of it. NO UPDATE and no
-- DELETE: taking and settling a request are the PLANE's transitions, and a
-- runtime that could settle its own ask could report a fill that never ran.
GRANT SELECT, INSERT ON plane_requests TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON plane_requests FROM dito_twin_runtime;

-- The window the runtime seeds at provisioning and the plane reads per fill.
-- SELECT and INSERT and no UPDATE: a re-provision writes the row once, and
-- retuning a twin's window is an act nothing in 6a performs.
GRANT SELECT, INSERT ON history_windows TO dito_twin_runtime;

-- The directory, whole, for the ONE process that holds the key. The runtime
-- opens `name_enc` and serves the directory through its local API (ADR-0010:
-- "dashboards are clients of that service's authenticated API"), so it reads
-- the sealed column and rep-web does not.
GRANT SELECT ON chat_directory TO dito_twin_runtime;

-- ── ...AND rep-web, COLUMN BY COLUMN ──────────────────────────────────────
--
-- Spec #214 *Roles and grants*: "SELECT on … the chat directory's plaintext
-- columns". `name_enc` is the sealed one and rep-web holds no key
-- (ADR-0008's custody of two), so a table-wide SELECT would hand it
-- ciphertext it can never open AND make the pin unable to say so —
-- `has_table_privilege` cannot express "everything but one". The list is
-- pinned in `@dito/aperture`'s `REP_WEB_COLUMN_REACH` and diffed against this
-- catalog in both directions, so a later `GRANT SELECT (name_enc)` is a
-- violation with a name.
--
-- WHAT IS IN THE LIST is what the scoping page and the sync view render: the
-- row's identity, its twin, the chat the switch names, its kind, when it was
-- last active, and the four fill-progress columns. WHAT IS OUT is the sealed
-- name, the LID (a second spelling of an identity no page shows), the three
-- anchor columns (the fill's own input, which no page renders) and the two
-- stamps. Names reach the page through the runtime's API, opened.
GRANT SELECT (id, twin_id, chat_jid, kind, last_activity_at,
              fill_pages, fill_oldest_at, fill_end_of_transfer, fill_last_at)
    ON chat_directory TO dito_rep_web;

-- AND NOTHING ELSE, SAID OUT LOUD. The REVOKEs are statements rather than
-- changes — nothing above granted any of this — and they are here so the
-- GRANT DIFF says so too, and so a later migration handing one of them over
-- is visible in FR-71a's own diff (…20260907100040's block makes exactly this
-- argument).
--
-- rep-web WRITES NO REQUEST. The scope switch and the link ask are rep acts
-- through the runtime's local API (spec #214 decision 5), so the row is the
-- runtime's to write inside the act's own transaction with the allowlist row
-- and the chain entry. A rep-web that could INSERT here could ask the plane
-- to fill a chat with no act, no allowlist row and no audit entry behind it.
REVOKE ALL ON plane_requests FROM dito_rep_web;
REVOKE ALL ON history_windows FROM dito_rep_web;

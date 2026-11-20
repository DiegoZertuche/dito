-- The request wake's channel (ticket #197; spec #193 decision 26; ADR-0010
-- as amended, ADR-0014 as amended, ADR-0020).
--
-- NUMBERING: …2026090610002·, after …20260906100010 (extraction's
-- `resolved_reference`, #196). Forward-only: no migration in this repo is
-- ever edited once it has applied anywhere, because a migration is a
-- statement about what a database has already been through.
--
-- ═══ WHAT THIS TABLE IS FOR ═══
--
-- An operator asks the RUNNING runtime for a daily job and never stops it.
-- Before this table the only way to run extraction by hand was a script that
-- opened twin memory in a process of its own — so a steering session had to
-- kill `rig-run.ts` first, which drops the rail's linked device, silences
-- drafting and ends the one holder ADR-0010 gives the bundle. A request is a
-- ROW instead: the loop reads it on its next tick and creates the execution
-- itself, on the same definition and the same digest the clock fires (ADR-0014
-- as amended — one definition per automation, and the mechanism is the only
-- thing that differs).
--
-- IT NAMES BOTH OCCASIONS AND SERVES ONE. `extraction` is served from this
-- ticket; a `daily_disclosure` row is accepted, left untaken and served by the
-- automation that posts (#198). The CHECK names both because the vocabulary is
-- the closed set `@dito/execution` already holds, and a word added later would
-- be a DROP + re-CREATE of this constraint from whatever ancestor that ticket
-- branched from — the hazard `migration-vocabulary.test.ts` watches.
--
-- ═══ CONTENT-FREE PARAMETERS, AND CHECKED RATHER THAN PROMISED ═══
--
-- `parameters` is METADATA ONLY: the steering clock as an instant and the
-- re-read as a boolean, which is the whole of what a steering session can ask
-- for. Nothing anybody said is in it and nothing may be: a request is written
-- by hand, by a person or a script, so the store refuses the one shape of
-- content that would plausibly arrive here. Every WhatsApp address carries `@`
-- and no instant, boolean or key name this document holds ever does — the same
-- argument and the same character `executions_trigger_ref_content_free_check`
-- refuses on the reference beside it (…0904100020), and the same shapes
-- `ledger-wall-check.mjs` sweeps the Ledger for.
--
-- AND THE `@` IS THE LAST FENCE RATHER THAN THE ONLY ONE (Codex r1). Refusing
-- one character would still admit `{"now": "Juan pidió 100 cajas"}` or a key
-- nobody declared carrying a whole message — and a runtime that then refused
-- to serve the row would leave that plaintext stored anyway, which is the
-- crossing, not the run. So the document is a CLOSED, TYPED schema at storage
-- time: exactly two keys may appear, `reextract` must be a boolean, and `now`
-- must match an ISO-8601 instant with an offset. Nothing shaped like a
-- sentence fits through any of them, and an operator learns at the prompt
-- rather than a tick later.
--
-- THE CHAT IS A COLUMN, NEVER A PARAMETER, and that is what the CHECK above
-- makes it: an address in the document would fail it. It sits beside the
-- parameters the way `ExtractionTrigger` carries its chat on the VALUE while
-- `triggerRef` renders it nowhere — a reader of this row can say which
-- conversation was asked about, and nothing content-free is asked to hold an
-- address. `extraction_runs` (…100027) is the precedent and the reason this
-- file names no entity: the crossing's schema names entities and no chat, this
-- one names a chat and no entity, and neither can quietly become the binding
-- table ADR-0004 forbids (`binding-wall.test.ts`).
--
-- ═══ ONE ROW PER REQUEST, AND WHAT SETTLES IT ═══
--
-- A request is taken once and settled once, in the tick that serves it. It is
-- NOT a run record: the run rows and the execution records are, and duplicating
-- their endings here would be the same fact in two places. So the three
-- outcomes divide by WHOSE problem it was —
--
--   `served`  — the runtime took the request and created the executions it
--               asked for. `executions` says how many, `unclaimed` says how
--               many chats were left alone because their day was already being
--               read, and `execution_id` names the first execution.
--   `refused` — the ask could not be served, and nothing was created: a
--               parameter value the channel cannot read, a twin whose rail is
--               not linked, or a chat whose day is being read right now.
--   `failed`  — the RUNTIME could not serve it, or went away in the middle of
--               trying. The loop carries on: a bad request row must never
--               fail-stop the twin, and a request nothing will ever answer is
--               answered at the next start.
--
-- ...and how each execution ENDED is on `executions.disposition` beside its
-- one audit-chain entry (ADR-0020), which is where the requester reads it.
--
-- ═══ GRANTS, ON PURPOSE ═══
--
-- …100012 granted `dito_twin_runtime` write on ALL TABLES IN SCHEMA public at
-- a point in time, and its own header states the rule that makes this block
-- necessary: a rep-side store added later must be granted on purpose. A table
-- created after that migration is reachable by nobody until a migration says
-- so. See the block at the foot of this file.

CREATE TABLE runtime_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The twin whose runtime is being asked. On every rep-side row since
    -- slice 1, and the loop reads only its own.
    twin_id uuid NOT NULL,
    -- Which daily job — `Occasion` in `@dito/execution`, narrowed to the two
    -- a Schedule wakes. See the header for why both are named here.
    occasion text NOT NULL,
    -- The ONE chat this request is about, or NULL for every chat that still
    -- owes the day. See the header: the chat is a column and never a
    -- parameter, and the CHECK below is what keeps it a chat.
    chat_jid text,
    -- What the operator asked for, as metadata (see the header): `now` — the
    -- steering clock as an ISO-8601 instant, which moves the REP's day and
    -- never the seam's watermark — and `reextract`, which re-reads a chat
    -- whose day is already filed from where the last run read through. An
    -- empty document is the ordinary ask.
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_at timestamptz NOT NULL DEFAULT now(),
    -- When the loop picked it up. NULL is a request nothing has served yet,
    -- which is what the poll selects on — so a row that is taken and not
    -- settled is one this process was serving when it ended, and the next
    -- start is what answers it (`settleStrandedRequests`).
    taken_at timestamptz,
    -- How many executions this request created. Zero is honest: a request
    -- whose day had nothing owed is served and creates none.
    executions integer NOT NULL DEFAULT 0,
    -- ...and how many chats it left alone because an execution for them was
    -- already on the lane (`ExtractionBatch.inFlight`). A whole-day ask over a
    -- chat somebody else's execution is reading right now claims nothing for
    -- it, and the requester has to be able to say so rather than report the
    -- day read (Codex r2).
    unclaimed integer NOT NULL DEFAULT 0,
    -- The FIRST execution this request created — the only one for an ask that
    -- named a chat, and the day's first otherwise. It is written from inside
    -- that execution's own transaction, because it is a foreign key and the
    -- pass submits its executions long before any of them has a record. The
    -- whole set is read through the executions whose content-free reference
    -- names this twin and this day by `request` (`triggerRef`), which is what
    -- the requester does either way.
    execution_id uuid REFERENCES executions (id),
    outcome text,
    -- Why, as a closed word and never as a sentence: a reason a person typed
    -- would be the one column on this table that could carry content.
    reason text,
    settled_at timestamptz,
    CONSTRAINT runtime_requests_occasion_check
        CHECK (occasion IN ('extraction', 'daily_disclosure')),
    CONSTRAINT runtime_requests_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('served', 'refused', 'failed')),
    CONSTRAINT runtime_requests_reason_check
        CHECK (reason IS NULL OR reason IN ('malformed_parameter',
                                            'rail_not_linked',
                                            'chat_in_flight',
                                            'pass_failed',
                                            'interrupted')),
    -- A reason belongs to a request that did not get what it asked for, and
    -- to no other: `served` explains itself, and a pending row has nothing to
    -- explain yet.
    CONSTRAINT runtime_requests_reason_paired_check
        CHECK ((reason IS NOT NULL) = (outcome IS NOT NULL AND outcome <> 'served')),
    -- Settled means settled: an outcome and the instant it was written arrive
    -- together, the shape `extraction_runs_settled_check` uses one table over.
    CONSTRAINT runtime_requests_settled_check
        CHECK ((outcome IS NULL) = (settled_at IS NULL)),
    -- ...and nothing is settled before it was taken. A row with an outcome and
    -- no `taken_at` would say the loop decided about a request it never read.
    CONSTRAINT runtime_requests_taken_before_settled_check
        CHECK (outcome IS NULL OR taken_at IS NOT NULL),
    CONSTRAINT runtime_requests_executions_check
        CHECK (executions >= 0 AND unclaimed >= 0),
    -- THE SELECTOR IS AN ADDRESS OR IT IS NOTHING (Codex r2). Every other
    -- column on this table is fenced against content and this one was free
    -- text, so `chat_jid = 'Juan pidió 100 cajas'` satisfied every check and a
    -- customer's words persisted in a store this repo classes as
    -- metadata-only (`fr73-shared-stores.ts`). A WhatsApp address is digits, an
    -- optional group timestamp or device suffix, and one of four servers —
    -- `seats_rep_display_name_not_an_address` (…0902100010) names the same
    -- four — so nothing shaped like a sentence or a name fits.
    CONSTRAINT runtime_requests_chat_jid_is_an_address_check
        CHECK (chat_jid IS NULL
               OR chat_jid ~
                  '^[0-9]+(-[0-9]+)?(:[0-9]+)?@(s\.whatsapp\.net|g\.us|lid|broadcast)$'),
    -- A REFUSAL CREATES NOTHING, and this is what stops a row claiming both.
    -- It is the one cross-column rule worth a constraint: the refusals are
    -- decided BEFORE the pass is entered, so a refused row carrying an
    -- execution would mean the loop refused an ask it had already served.
    CONSTRAINT runtime_requests_refused_creates_nothing_check
        CHECK (outcome <> 'refused' OR (executions = 0 AND execution_id IS NULL)),
    -- CONTENT-FREE, ENFORCED — the last of the four fences below, and the one
    -- that survives a future key. See the header: `@` is the one character
    -- every WhatsApp address carries and nothing this document holds ever
    -- does.
    CONSTRAINT runtime_requests_parameters_content_free_check
        CHECK (parameters::text NOT LIKE '%@%'),
    -- A document, not a scalar: the parameters are named asks, and a bare
    -- `true` or `"now"` here would be a shape no reader could interpret.
    CONSTRAINT runtime_requests_parameters_object_check
        CHECK (jsonb_typeof(parameters) = 'object'),
    -- EXACTLY THESE TWO KEYS AND NO OTHER (Codex r1). Subtracting both must
    -- leave the empty document, so `{"message": "…"}` is refused at the INSERT
    -- rather than read and discarded a tick later — which is the difference
    -- between content that never crossed and content the store is holding.
    CONSTRAINT runtime_requests_parameters_keys_check
        CHECK (jsonb_typeof(parameters) <> 'object'
               OR parameters - 'now' - 'reextract' = '{}'::jsonb),
    -- ...and each of them typed. A boolean is a boolean.
    CONSTRAINT runtime_requests_parameters_reextract_check
        CHECK (NOT parameters ? 'reextract'
               OR jsonb_typeof(parameters -> 'reextract') = 'boolean'),
    -- ...and the clock is an ISO-8601 instant WITH AN OFFSET, which is the
    -- same rule `parseIsoInstant` holds the rig's own variable to: a zoneless
    -- string keys a session to a day nobody typed. The pattern bounds the
    -- SHAPE and the loop still refuses an impossible calendar day, because a
    -- CHECK cannot know that February has no 31st.
    CONSTRAINT runtime_requests_parameters_now_check
        CHECK (NOT parameters ? 'now'
               OR parameters ->> 'now' ~
                  '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$')
);

COMMENT ON TABLE runtime_requests IS
    'Ticket #197: one row per operator request to the RUNNING runtime — the twin, which daily job, an optional chat, metadata-only parameters (the steering clock, the re-read), when it was asked, when the loop took it, how many executions it created, how many chats it left alone, and what became of the ask (spec #193 decision 26). Content-free: the parameters and the chat selector are both fenced by CHECK. Serving `daily_disclosure` is #198''s.';
COMMENT ON COLUMN runtime_requests.parameters IS
    'Metadata only, as a closed typed schema: `now` (an ISO-8601 instant with an offset — the REP''s clock, never the seam''s watermark) and `reextract` (a boolean), and no other key. No message, no name, no address: four CHECKs say so, and the loop never logs this document.';
COMMENT ON COLUMN runtime_requests.outcome IS
    'served — the runtime created the executions the request asked for. refused — the ask was bad (see `reason`) and nothing was created. failed — the runtime could not serve it, and the loop carried on. How each execution ENDED is `executions.disposition` (ticket #197).';
COMMENT ON COLUMN runtime_requests.reason IS
    'A closed word, never a sentence: malformed_parameter · rail_not_linked · chat_in_flight · pass_failed · interrupted (ticket #197). Present exactly when the outcome is not `served`.';
COMMENT ON COLUMN runtime_requests.execution_id IS
    'The FIRST execution this request created — the only one for an ask that named a chat, the day''s first otherwise (ticket #197). NULL for a refusal and for a day with nothing owed. The whole set is read through the executions whose content-free reference names this twin and this day by `request`.';

-- THE POLL, WHICH RUNS EVERY TICK. The loop asks "has anybody asked me for
-- anything" on every pass, so the read has to be an index hit over a table
-- that only grows: partial on the unserved rows, keyed by the twin whose
-- runtime this is, ordered the way they are served.
CREATE INDEX runtime_requests_pending_idx
    ON runtime_requests (twin_id, occasion, requested_at)
    WHERE taken_at IS NULL;

-- ── The claim row names the request that asked for it ──────────────────────
--
-- WHY THE RUN AND NOT A TIMESTAMP (Codex r1). A requester has to wait for the
-- work its own ask created, and the only other way to find it was "the
-- `request`-mechanism executions that started at or after `taken_at`" — which
-- is another request's work too the moment two asks overlap. One requester
-- could then count another's finished execution towards its own and exit ZERO
-- over a run that had not started, let alone failed. Ownership is a column.
--
-- ON THE RUN RATHER THAN ON THE EXECUTION, because the run is what a request
-- CLAIMS and it exists whichever way the execution ends: a run whose execution
-- died before it could write a record still settles `failed` and still names
-- its request, so a requester waits on rows that are certain to arrive.
-- `extraction_runs.execution_id` is the join to the record from there.
--
-- NULLABLE, and that is exact rather than lenient: the clock claims runs too,
-- and no request asked for those.
ALTER TABLE extraction_runs
    ADD COLUMN request_id uuid REFERENCES runtime_requests (id);

COMMENT ON COLUMN extraction_runs.request_id IS
    'The operator request this run was claimed for, when one asked (ticket #197). NULL for every run the clock claimed, which is all of them on the scheduled path.';

-- What the requester waits on: this request's own runs, and whether they have
-- settled.
CREATE INDEX extraction_runs_request_idx
    ON extraction_runs (request_id)
    WHERE request_id IS NOT NULL;

-- ── Grants, on purpose (…100012's rule; see the header) ────────────────────

-- SELECT AND UPDATE FOR THE RUNTIME, AND NOT INSERT. The runtime is the
-- SERVER of requests and never a requester: a runtime that could write its own
-- rows could fabricate the operator's ask, and the whole value of this table is
-- that the row says a PERSON wanted the run. It needs UPDATE because taking and
-- settling a request are transitions on one row — the argument `extraction_runs`
-- makes for its own UPDATE grant, and for the same reason: "one request, one
-- row" would be unstateable if every transition were a row of its own.
--
-- The REVOKE is a statement rather than a change: …100012's blanket grant does
-- not reach a table created after it, so nothing is being taken away. It is
-- here so the GRANT DIFF says so too, and a later migration handing the runtime
-- INSERT is visible in FR-71a's own diff rather than discovered from a row
-- nobody asked for (…0904100020's block makes exactly this argument).
GRANT SELECT, UPDATE ON runtime_requests TO dito_twin_runtime;
REVOKE INSERT, DELETE, TRUNCATE ON runtime_requests FROM dito_twin_runtime;

-- NOTHING FOR THE APERTURE. It reads the seam to verify rep-act evidence and
-- owns its own two stores; a request is neither. Its blanket SELECT (…100012)
-- does not reach this table either, and it is left that way.

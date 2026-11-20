-- Extraction runs: the run as a row carrying a state (ticket #52; spec
-- #48 grilling decisions 1, 4 and 13; ADR-0016, ADR-0033).
--
-- THIS FILE NAMES NO ENTITY, and that is enforced (binding-wall.test.ts).
-- It carries a CHAT, which is why it is not on the crossing's exemption
-- list and why it is a separate migration from …100026: a chat id beside an
-- entity id IS the binding ADR-0004 keeps out of shared Postgres, and
-- keeping the two in different files makes each half of that rule checkable
-- where it applies. `extraction_runs` is twin-side operational bookkeeping,
-- exactly like `scope_allowlist` — chat JIDs as configuration, never as
-- memory, and nothing company-owned anywhere near it.
--
-- ADR-0016's load-bearing claim is that extraction is BATCH: per-chat,
-- daily, off the NFR-2 drafting path. That is what ships. What does NOT
-- ship is the literal Anthropic Batch API — at one rig its discount is
-- pennies and its 24h worst case fights a DAILY disclosure (spec #48
-- grilling decision 1; the deferral is recorded as a *Fleet & always-on
-- hardening* obligation on #6).
--
-- So the run is modelled as a ROW CARRYING A STATE rather than as a
-- synchronous function call. Today `submitted` lasts the length of one
-- ordinary API call; with the real Batch API it lasts until a poll
-- resolves the batch. Neither the aperture nor the disclosure can tell the
-- difference, which is the whole point of writing it this way now.
--
-- THE UNIT IS (twin, chat, day). ADR-0016 says "a daily PER-CHAT job", and
-- per-chat is also what makes the pass restartable: a crash re-runs one
-- chat, not the day.
CREATE TABLE extraction_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    twin_id uuid NOT NULL,
    -- Rep-side metadata, like `scope_allowlist`'s. It never reaches
    -- `ledger`; it is here so the ADR-0033 invariant can assert, over real
    -- rows, that the twin thread was never among the chats extraction read.
    chat_jid text NOT NULL,
    -- The rep's own calendar day, in the rep's own zone, derived by the
    -- pass from its explicit `now` (the `reconcileFr70At` shape). A `date`
    -- for the same reason `disclosure_posts.disclosure_day` is one: the day
    -- is the unit of idempotence, and an instant would let two runs
    -- disagree about which day they were in.
    extraction_day date NOT NULL,
    -- submitted — claimed and handed to the model; NOTHING is filed. A
    --             crash here re-runs the chat: the model call is pure and
    --             the filing has not happened.
    -- filed     — the candidates that passed the aperture's confidence
    --             gate are filed, with their disclosure lines. TERMINAL.
    -- deferred  — the chat is in scope with traffic but UNBOUND, so it got
    --             slice 2's binding proposal and its extraction waits
    --             (FR-32's orphan rule, spec #48 decision 13). Settled for
    --             the day's disclosure, and re-attempted by the next run —
    --             a chat the rep binds an hour later is extracted then,
    --             rather than waiting for tomorrow.
    state text NOT NULL,
    -- The window this run read: the DAY (spec #48 decision 13 — backfilled
    -- history is not re-extracted). Stored rather than re-derived, so what
    -- a run actually looked at survives a change to how the day is cut.
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL,
    -- What the run saw and did. Counts only — no content, no candidate
    -- text: this table is bookkeeping, and the candidates it counts are
    -- either filed (and disclosed) or dropped.
    messages integer NOT NULL DEFAULT 0,
    candidates integer NOT NULL DEFAULT 0,
    filed integer NOT NULL DEFAULT 0,
    -- Below the aperture's confidence gate. Files NOTHING this ticket;
    -- ticket #53 turns these into questions (FR-31, precision over recall).
    below_threshold integer NOT NULL DEFAULT 0,
    -- Refused by the aperture on grounds other than confidence: an unknown
    -- fact type, a malformed payload, an identifier that is the chat's own
    -- address (ADR-0004).
    refused integer NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    -- IDEMPOTENT PER (twin, chat, day) — the restart-safety claim. A
    -- re-run or a crash never files a fact twice or skips a chat, and this
    -- index rather than the pass's own bookkeeping is what guarantees it.
    CONSTRAINT extraction_runs_one_per_twin_chat_day
        UNIQUE (twin_id, chat_jid, extraction_day),
    CONSTRAINT extraction_runs_state_check
        CHECK (state IN ('submitted', 'filed', 'deferred')),
    -- A run is settled exactly when it is no longer submitted.
    CONSTRAINT extraction_runs_settled_check
        CHECK ((state = 'submitted') = (settled_at IS NULL)),
    CONSTRAINT extraction_runs_window_check CHECK (window_end > window_start),
    CONSTRAINT extraction_runs_counts_check CHECK (
        messages >= 0 AND candidates >= 0 AND filed >= 0
        AND below_threshold >= 0 AND refused >= 0
        AND filed + below_threshold + refused <= candidates
    ),
    -- A deferred run read nothing: it never reached the model, because the
    -- chat had no entity to attach a fact to (FR-32, absolute).
    CONSTRAINT extraction_runs_deferred_files_nothing CHECK (
        state <> 'deferred'
        OR (candidates = 0 AND filed = 0 AND below_threshold = 0 AND refused = 0)
    )
);

-- The pass's own selection: this twin's runs for one day.
CREATE INDEX extraction_runs_twin_day ON extraction_runs (twin_id, extraction_day);

-- ...and the window read the pass makes against the seam. This is the one
-- index the ticket actually needs: after the settle hour the scheduled pass
-- asks "did this chat say anything in its window?" once per in-scope chat
-- on EVERY poll, and without this that question is a sequential scan of
-- every event the twin has ever received, several times every two seconds,
-- on the same loop that drafts. The seam carried no index but its keys
-- until now because nothing read it by time.
CREATE INDEX wa_events_twin_occurred ON wa_events (twin_id, occurred_at);

-- Grants, on purpose (…100012's rule: ALTER DEFAULT PRIVILEGES
-- deliberately does not cover `public`, so a store added later is granted
-- deliberately or not at all). This is a TWIN-side store — the twin's
-- record of what it read and when — so the runtime writes it and the
-- aperture only reads it. In particular the aperture holds no INSERT: the
-- far side of the wall does not decide what the twin reads.
--
-- UPDATE is granted, unlike every other store in this slice, and that is
-- the point of a state machine: `submitted` → `filed` is the transition,
-- and the alternative — a row per transition — would make "one run per
-- (twin, chat, day)" unstateable as a constraint. DELETE and TRUNCATE are
-- refused: a run that happened is a run that happened.
GRANT SELECT, INSERT, UPDATE ON extraction_runs TO dito_twin_runtime;
GRANT SELECT ON extraction_runs TO dito_aperture;
REVOKE DELETE, TRUNCATE ON extraction_runs FROM dito_twin_runtime, dito_aperture;

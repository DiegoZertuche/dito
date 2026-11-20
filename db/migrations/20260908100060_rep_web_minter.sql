-- rep-web BECOMES THE SECOND TAP MINTER, AND THE DASHBOARD BECOMES A PLACE A
-- REP CAN ACT (ticket #224; spec #214 decision 2, decision 5, *The feed, in
-- detail* and *Roles and grants*; ADR-0006, ADR-0002, ADR-0003, ADR-0008,
-- ADR-0010, ADR-0013, ADR-0020, ADR-0034).
--
-- ADR-0006 has said since slice 1 that the send lock has TWO minters, and
-- …20260826100003's own comment names this one: "rep-web's authz layer (the
-- other ADR-0006 minter) joins this CHECK via migration when its surface
-- ships — a schema change, visible in review, never a runtime value." Its
-- surface ships here. The rep taps **Enviar** on a card and the dashboard
-- writes the tap and the `customer_send` command itself, in one transaction
-- under its own role, so a message goes out with the twin runtime stopped
-- (spec #214 story 8) and the plane's executor sends it exactly as today.
--
-- The other four acts on a card — Descartar, Retirar per line, and confirm or
-- decline on the binding question — go the other way, through the runtime's
-- local API, because `posts`, `disclosure_lines` and the bundle are the
-- runtime's alone (ADR-0010). Each of them is a REP ACT, so each needs
-- class-2 evidence (ADR-0003) — and until this file that could only be a
-- WhatsApp message.
--
-- ═══ WHAT THIS FILE DOES, AND EACH IS A CONSEQUENCE OF THAT
--
--   1. `taps_minter_check` WIDENS to the two minters. It never narrows: the
--      rig carries `affirmation_matcher` rows, and a value an earlier
--      migration granted rides forward (`migration-vocabulary.test.ts`).
--   2. `send_refusals` is born — the record a minter WITH NO CHAIN KEY
--      writes, which the lease holder chains at its next wake.
--   3. `dito_rep_web` gains exactly the reads the send-lock writer makes and
--      the card's state needs, column by column where a column would carry
--      something it has no business reading.
--   4. `dashboard_acts` is born: one row per rep act performed on a card, the
--      class-2 evidence of the surface that is not the twin thread.
--   5. The three stores that name a rep act — `draft_dismissals`,
--      `fact_retractions`, `disclosure_lines` — name EITHER surface, under an
--      exactly-one CHECK that keeps "a rep act names the act that authorized
--      it" enforced by the store rather than by a convention.
--   6. Nothing sealed moves. No `posts`, no `notices`, no `disclosure_lines`
--      reach the dashboard, no key table, no `ledger` object, no bundle path.
--
-- ═══ RE-RUNNABLE, IN …20260907100040'S OWN SHAPE
--
-- Atlas never re-applies a file. What this is for is an OPERATOR replaying it
-- by hand against a database whose revision history says nothing — the
-- populated upgrade rehearsal #218, #220 and #221 each ran, and which this
-- ticket ran again. So `IF NOT EXISTS` on everything that can take it, a
-- duplicate-object handler on the constraints that cannot, `CREATE OR REPLACE`
-- on the functions, and a DROP before each trigger. Every GRANT, REVOKE and
-- COMMENT is idempotent as written.
--
-- AND IDEMPOTENT OVER EXISTING ROWS. Nothing here rewrites a row: the widened
-- CHECK accepts the word every standing `taps` row carries, and each new
-- column is nullable with no default, so every ALTER is a catalog change and
-- the exactly-one CHECKs are true of every existing row the moment they are
-- added — each of those rows has a seam event.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE SECOND MINTER
-- ═══════════════════════════════════════════════════════════════════════
--
-- DROP THEN ADD, which is the only way PostgreSQL re-cuts a CHECK, and the
-- ORDER IS SAFE HERE in a way it was not for `seats.state` (…20260907100040,
-- which had to rewrite rows between the two). Nothing is being rewritten:
-- every standing row says `affirmation_matcher` and the new constraint accepts
-- that word, so the ADD is valid against the whole table and is left to
-- validate rather than added `NOT VALID`. Atlas applies a file in one
-- transaction, so the window in which `taps` has no minter constraint is not
-- observable.

ALTER TABLE taps DROP CONSTRAINT IF EXISTS taps_minter_check;

ALTER TABLE taps
    ADD CONSTRAINT taps_minter_check
    CHECK (minter IN ('affirmation_matcher', 'rep_web'));

COMMENT ON COLUMN taps.minter IS
    'ADR-0006''s two non-model tap minters, closed and swept against TAP_MINTERS in @dito/seam: affirmation_matcher is the rep quoting a Borrador with «va» in their own thread, rep_web is the rep tapping Enviar on the card (ticket #224). Widened, never narrowed. taps_matcher_requires_event_check is what keeps the matcher''s arm pinned to a raw plane-delivered event while the dashboard''s carries none — the rep pressed a button, and there is no seam row behind a button.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE REFUSAL A MINTER WITH NO CHAIN KEY RECORDS
-- ═══════════════════════════════════════════════════════════════════════
--
-- The send-lock writer refuses, and a refusal is chained: the destination is
-- off the hard allowlist, the twin is over its pacing, or the rep is sending a
-- draft they already dismissed (ADR-0017, ADR-0020; ticket #24's ACs and spec
-- #29 grilling decision 1). Every one of those is an act whose only trace the
-- chain would be, so none may go unrecorded.
--
-- AND rep-web HOLDS NO CHAIN KEY, BY DESIGN. ADR-0002 puts the dashboard on
-- the far side of a credential boundary and ADR-0008 keeps custody with the
-- lease holder; a chain key in this app's environment would let the audited
-- process write the record that audits it, and `audit_chain` carries no grant
-- for this role at all (FR-71a goes red on one).
--
-- So THE ROW IS THE RECORD AND THE ENTRY IS OWED. rep-web writes here in the
-- same transaction as the rolled-back attempt, and `drainSendRefusals` chains
-- it at the runtime's next wake — `crossPendingBindings`' shape, idempotent on
-- `chained_at`.
--
-- WHAT THAT COSTS, said out loud rather than left to be discovered: between
-- the refusal and the runtime's next wake the entry does not exist, and a
-- deployment whose runtime never starts again leaves the row unchained for
-- ever. The row is append-only either way, so what is at risk is the ORDERING
-- evidence a chain gives and never the fact. Recorded on the horizon, #117.
--
-- CONTENT-FREE BY CONSTRUCTION, not by convention. Two opaque ids, a minter
-- from the closed set, and a reason the CHECK below confines to lower-case
-- words — so there is no column here anybody could put a chat address, a
-- customer's name or a draft's body into. That is the claim
-- `executions_trigger_ref_content_free_check` makes one table over, made by
-- shape rather than by a `LIKE`.

CREATE TABLE IF NOT EXISTS send_refusals (
    -- Identity, because the drain reads oldest-first and an instant ties.
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- On every rep-side row since slice 1, and the token the chain entry
    -- carries.
    twin_id uuid NOT NULL,
    -- The draft the refused send was for. A foreign key, so a refusal cannot
    -- name a draft that does not exist — the writer read the row before it
    -- refused, so anything else is a broken store.
    draft_id uuid NOT NULL REFERENCES drafts (id),
    -- WHICH MINTER WAS REFUSED — the chain's caller identity, off the same
    -- closed set `taps.minter` holds, so the two cannot drift apart and a
    -- third keyless minter needs no migration here.
    minter text NOT NULL
        CONSTRAINT send_refusals_minter_check
        CHECK (minter IN ('affirmation_matcher', 'rep_web')),
    -- The refusal reason word, rendered into 'refused:<reason>' on the chain.
    -- NOT a closed set: #78 recorded that refusal reasons are open by design,
    -- and an enumeration here would refuse the next reason the writer names
    -- AFTER the attempt it was refusing had already rolled back. The CHECK is
    -- on its SHAPE instead, which is what keeps this column content-free.
    reason text NOT NULL
        CONSTRAINT send_refusals_reason_shape_check
        CHECK (reason ~ '^[a-z][a-z_]{0,62}$'),
    -- Transaction time, clock_timestamp() by PR #213's rule: now() pins to
    -- transaction start, and two refusals of one pass would tie.
    refused_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- NULL until the lease holder chained it. The drain's own claim.
    chained_at timestamptz
);

COMMENT ON TABLE send_refusals IS
    'Ticket #224: one row per send-lock refusal recorded by a minter that holds no audit-chain key (ADR-0002, ADR-0008). rep-web writes it in the refused attempt''s own transaction; drainSendRefusals in the twin runtime chains it at the next wake and stamps chained_at. Content-free by shape: two opaque ids, a minter from the closed set and a lower-case reason word. Append-only — the only permitted UPDATE is the drain''s own stamp.';
COMMENT ON COLUMN send_refusals.chained_at IS
    'When the lease holder appended this refusal to the rep chain (ADR-0020). NULL means the entry is still owed; the drain claims rows FOR UPDATE SKIP LOCKED on exactly this predicate, so a pass cannot chain one twice.';

-- The drain's own read, and the only index it needs: the unchained backlog in
-- id order. Partial, because after the backlog clears the answer is «none»,
-- and a full index over a growing table would be paid for on every insert.
CREATE INDEX IF NOT EXISTS send_refusals_unchained ON send_refusals (id)
    WHERE chained_at IS NULL;

-- APPEND-ONLY, WITH ONE PERMITTED UPDATE — the shape `draft_dismissals` and
-- `notices` have, narrowed to let the drain do its one job. A refusal is the
-- record of something the system did to a rep's act, so nothing may rewrite it
-- and nothing may delete it; and `chained_at` may be stamped exactly once,
-- from NULL, because that is the drain's claim and a re-stamp would hide a
-- double append onto a chain that cannot be repaired.
CREATE OR REPLACE FUNCTION send_refusals_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'send_refusals are append-only (ticket #224): % refused — a refusal is the record of a rep act the system declined', TG_OP;
    END IF;
    IF OLD.chained_at IS NOT NULL THEN
        RAISE EXCEPTION 'send_refusals row % is already chained (ticket #224) — a second stamp would hide a second append onto an append-only chain (ADR-0020)', OLD.id;
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.twin_id <> OLD.twin_id
       OR NEW.draft_id <> OLD.draft_id
       OR NEW.minter <> OLD.minter
       OR NEW.reason <> OLD.reason
       OR NEW.refused_at <> OLD.refused_at THEN
        RAISE EXCEPTION 'send_refusals hold one permitted UPDATE (ticket #224): the drain''s chained_at stamp. Row % tried to change what the refusal WAS', OLD.id;
    END IF;
    IF NEW.chained_at IS NULL THEN
        RAISE EXCEPTION 'send_refusals row % cannot be un-chained (ticket #224) — the entry it names is on an append-only chain', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS send_refusals_no_delete ON send_refusals;
CREATE TRIGGER send_refusals_no_delete
    BEFORE DELETE ON send_refusals
    FOR EACH ROW EXECUTE FUNCTION send_refusals_append_only();

DROP TRIGGER IF EXISTS send_refusals_stamp_only ON send_refusals;
CREATE TRIGGER send_refusals_stamp_only
    BEFORE UPDATE ON send_refusals
    FOR EACH ROW EXECUTE FUNCTION send_refusals_append_only();

DROP TRIGGER IF EXISTS send_refusals_no_truncate ON send_refusals;
CREATE TRIGGER send_refusals_no_truncate
    BEFORE TRUNCATE ON send_refusals
    FOR EACH STATEMENT EXECUTE FUNCTION send_refusals_append_only();

-- The lease holder reads the backlog and stamps it; nobody deletes anything.
GRANT SELECT, UPDATE ON send_refusals TO dito_twin_runtime;
REVOKE DELETE, TRUNCATE ON send_refusals FROM dito_twin_runtime;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. WHAT THE DASHBOARD MAY READ TO SEND, AND TO DRAW THE CARD
-- ═══════════════════════════════════════════════════════════════════════
--
-- #221 granted INSERT on `taps` and `send_commands` one ticket before their
-- caller, on the argument that a role whose grants arrive a ticket at a time
-- cannot be audited as a whole. What it could not know without the writer in
-- front of it is what the writer READS — so those grants land here, and
-- `REP_WEB_REACH` / `REP_WEB_COLUMN_REACH` in `packages/aperture/src/grants.ts`
-- are re-pinned in the same commit. The two are one statement written twice
-- and FR-71a diffs them in both directions.
--
-- WHY EACH ONE, and why table-wide or column by column:
--
--   `send_allowlist`, `pacing_thresholds` — the writer's two config reads
--   (ADR-0017). Table-wide, because every column of both is metadata: two twin
--   ids, a destination address of the same class as `drafts.destination` which
--   this role already reads, and three integers. There is no column here to
--   withhold, so a column pin would be a list protecting nothing.
--
--   `send_attempts` — two columns, both metadata (a command id and the instant
--   the rail was actually touched), and the writer reads both: the pacing
--   window measures the WIRE moment rather than the mint moment.
--
--   `draft_dismissals` — COLUMN BY COLUMN, and the withheld column is the
--   point. Both readers ask the same question, "did somebody dismiss this
--   draft", and `source_event_id` answers a different one: WHICH message of
--   the rep's dismissed it. Withholding it is the difference between a state
--   and a history.
--
--   `taps` — COLUMN BY COLUMN. `id` because `INSERT … RETURNING id` needs
--   SELECT on the column it returns, and `draft_id` because the card's state
--   is rep-web's own plaintext read (#220's remainder 8): a draft with a tap
--   draws the send's progress rather than two buttons. `minter` and
--   `source_event_id` are withheld — the dashboard WRITES the first and has no
--   use for the second.
--
--   `send_commands` — COLUMN BY COLUMN, and the sharpest of the three. The
--   writer reads `twin_id`, `send_class` and `created_at` for pacing, `outcome`
--   for the in-flight check and for the card's own «enviando / enviado / no
--   salió», `draft_id` to find a card's command, and `id` for `RETURNING`. It
--   WRITES `destination` and `payload_ref` and never reads them, so both are
--   withheld: a destination is chat identity (ADR-0004) and a `payload_ref` is
--   the plane executor's contract rather than a page's.
--
--   `send_refusals` — INSERT and nothing else, not even SELECT: the dashboard
--   does not read its own refusals back, and a role that could read this table
--   could count another twin's.

GRANT SELECT ON send_allowlist TO dito_rep_web;
GRANT SELECT ON pacing_thresholds TO dito_rep_web;
GRANT SELECT ON send_attempts TO dito_rep_web;
GRANT SELECT (draft_id) ON draft_dismissals TO dito_rep_web;
GRANT SELECT (id, draft_id) ON taps TO dito_rep_web;
GRANT SELECT (id, twin_id, send_class, draft_id, outcome, created_at)
    ON send_commands TO dito_rep_web;
GRANT INSERT ON send_refusals TO dito_rep_web;

-- ...AND NOTHING ELSE MOVES. Restated as REVOKEs rather than left to the
-- audit, for …20260907100040's reason: a grant this file does not make is one
-- somebody could make later, and a role's reach is a claim about what was
-- refused as much as about what was allowed.
REVOKE UPDATE, DELETE, TRUNCATE ON send_allowlist FROM dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON pacing_thresholds FROM dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON send_attempts FROM dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON draft_dismissals FROM dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON taps FROM dito_rep_web;
REVOKE UPDATE, DELETE, TRUNCATE ON send_commands FROM dito_rep_web;
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON send_refusals FROM dito_rep_web;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. THE DASHBOARD ACT — REP-EVIDENCED EVIDENCE, ON THE OTHER SURFACE
-- ═══════════════════════════════════════════════════════════════════════
--
-- ADR-0003's class-2 rule is that a rep act "must reference verifiable rep-act
-- evidence, matched by deterministic code, never by model output". Until this
-- ticket that evidence could only be a WhatsApp message. Spec #214 decision 2
-- widens it in as many words — "rep-evidenced evidence widens from 'a thread
-- message id' to 'a rep act on either surface'" — and this table is the other
-- surface's row: ONE PER ACT, written by the runtime's local API inside the
-- act's own transaction, from a request that got past all three of its fences
-- (the bearer, the seat from rep-web's session, and the twin READ FROM THE
-- REGISTRY rather than taken from the request).
--
-- WHAT MAKES IT EVIDENCE, in the same terms the seam row is evidence: nothing
-- but the API writes it, and a model cannot produce a row in a table it cannot
-- reach. `dito_rep_web` holds NO privilege here at all — the dashboard asks
-- the runtime to act and the runtime records that it was asked, which is the
-- whole of ADR-0010's "dashboards are clients of that service's authenticated
-- API".
--
-- CONTENT-FREE, AND BY SHAPE. Five ids, a verb from a closed set and an
-- instant. Not a syllable of anything anybody said: a button carries no
-- words, which makes this the one act record in the repo that could not leak
-- content if it tried.
--
-- IT NAMES THE POST IT ACTED ON, and that is the dashboard's exact analogue of
-- «what the rep quoted» (`acts.ts` rule TWO, and
-- `TwinThreadMessageTrigger.quotedPostId` on the other surface). A card IS a
-- post, so the post's id is what this side can honestly say the rep acted on;
-- code walks from it to the draft, to the numbering or to the question.
--
-- IT IS ALSO WHAT MAKES A DASHBOARD CONFIRMATION CROSSABLE. A confirmed
-- binding lands in the bundle's entity mirror (ADR-0004) and the Ledger
-- crossing is a separate execution with a model in it, so the sweep that files
-- it has to be able to ask WHICH CHAT a confirmation was about — and for a
-- thread act the answer comes from the quoted post's own question notice
-- (`resolveConfirmations`). Without this column a dashboard confirmation would
-- be a binding nothing could ever cross.
--
-- WHAT IS NOT HERE is which LINE a retraction named. That target lands in
-- `fact_retractions.disclosure_line_id` in the same transaction, so a copy
-- here would be a second answer to the same question — and the line number the
-- rep pressed is a position in a post rather than an id anything joins on.

CREATE TABLE IF NOT EXISTS dashboard_acts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Seat scope, like the disclosure line's: aperture infrastructure is
    -- seat-scoped rather than twin-session-scoped (ADR-0003).
    company_id uuid NOT NULL,
    seat_id uuid NOT NULL,
    twin_id uuid NOT NULL,
    -- The card the rep acted on — the rep side's own identity for a twin post
    -- (see the header). A foreign key, so an act cannot name a post that does
    -- not exist; the API resolves the post under this twin before writing, so
    -- the twin on this row and the twin on that post are the same twin.
    post_id uuid NOT NULL REFERENCES posts (id),
    -- WHICH ACT THE REP PERFORMED. A closed set, swept against
    -- DASHBOARD_ACT_VERBS in @dito/seam by migration-vocabulary.test.ts — so a
    -- verb the API writes that the store refuses is a red build rather than a
    -- constraint violation in front of a rep who pressed a button.
    verb text NOT NULL
        CONSTRAINT dashboard_acts_verb_check
        CHECK (verb IN ('dismiss_draft', 'retract_line',
                        'confirm_binding', 'decline_binding')),
    -- VALID TIME: when the rep tapped. clock_timestamp() by PR #213's rule,
    -- and it is what the Ledger records as the moment of the act — the rule
    -- wa_events.occurred_at carries for the thread's arm, so a pass that runs
    -- late never writes its own processing time into an append-only store.
    acted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- WHAT THE SURFACE ANSWERED THE REP. NULL between the INSERT and the
    -- stamp, and both are in one transaction: the act row has to exist before
    -- the act runs, because its id is the evidence the act's own writes carry
    -- (section 5) — so the result cannot be known at insert time and the row
    -- is stamped once, before the transaction commits.
    --
    -- WHY THE ROW RECORDS THE RESULT AT ALL, since a comment above says an act
    -- row is the act rather than its result. `wa_event_processing.disposition`
    -- is exactly this column one surface over, and the reason is the same:
    -- audit coverage enumerates the acts that OWE the chain an entry, and
    -- «performed», «already» and «refused» owe different entries — a repeat
    -- Retirar chains `already_retracted` while a refused one chains
    -- `refused:<reason>`. Without this word the two are indistinguishable from
    -- outside (an already writes no retraction row and neither does a
    -- refusal), so the class would demand a refusal entry for an act that
    -- correctly wrote none, which is a green that has to be argued away rather
    -- than an invariant.
    --
    -- THE CLOSED SET IS THE API'S OWN ANSWER SET, swept against
    -- TWIN_API_ACT_OUTCOMES by migration-vocabulary.test.ts.
    outcome text
        CONSTRAINT dashboard_acts_outcome_check
        CHECK (outcome IN ('performed', 'already', 'refused',
                           'window_closed'))
    -- NO FOREIGN KEY ON (seat_id, company_id), and the omission is deliberate
    -- rather than an oversight — it is the shape `disclosure_lines`,
    -- `draft_dismissals` and `fact_retractions` already have, and it is
    -- forced. An append-only store refuses TRUNCATE, so a reference into a
    -- tenancy table makes that table un-truncatable too through CASCADE, and
    -- every suite that resets by truncating `seats` would die on a trigger
    -- belonging to a table it never named. The scope on this row is not
    -- supplied by a caller either: it is read off the session the request
    -- authenticated with, which is where the tenancy fence actually lives.
);

COMMENT ON TABLE dashboard_acts IS
    'Ticket #224: one row per rep act performed on the dashboard — the class-2 evidence of ADR-0003 on the surface that is not the twin thread (spec #214 decision 2). Written only by the twin runtime''s local API, inside the act''s own transaction, from a request that passed the bearer, the seat and the twin fences. Content-free: five ids, a verb and an outcome from two closed sets and the instant the rep tapped, and not a syllable of anything anybody said. post_id is the card the rep acted on — the dashboard''s analogue of the quoted post.';
COMMENT ON COLUMN dashboard_acts.acted_at IS
    'Valid time: when the rep tapped. The aperture takes an act''s valid time off this column exactly as it takes a thread act''s off wa_events.occurred_at, so a Ledger write records the moment of the act rather than the moment a pass reached it.';
COMMENT ON COLUMN dashboard_acts.outcome IS
    'Ticket #224: what the surface answered the rep — the API''s own closed answer set (TWIN_API_ACT_OUTCOMES). Stamped once, from NULL, inside the act''s own transaction: the row exists before the act runs because its id is the evidence the act''s writes carry. It is the dashboard''s wa_event_processing.disposition, and audit coverage enumerates by it — «already» and «refused» owe the chain different entries and leave the same absence of rows behind them.';

CREATE INDEX IF NOT EXISTS dashboard_acts_by_twin
    ON dashboard_acts (twin_id, acted_at);

-- An act is the record of something a rep did. Never rewritten, never deleted
-- — the shape `draft_dismissals`, `fact_retractions` and `notices` have, and
-- for the same reason (ADR-0034's argument, applied to evidence) — with the
-- one permitted UPDATE `send_refusals` above has: the outcome stamp, once,
-- from NULL, inside the act's own transaction. Nothing else may move, and a
-- second stamp is refused because it would rewrite what the rep was told.
CREATE OR REPLACE FUNCTION dashboard_acts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION 'dashboard_acts are immutable (ticket #224): % refused — an act row is class-2 rep-act evidence (ADR-0003)', TG_OP;
    END IF;
    IF OLD.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % is already stamped (ticket #224) — the outcome is what the rep was told, and a second stamp would rewrite it', OLD.id;
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.company_id <> OLD.company_id
       OR NEW.seat_id <> OLD.seat_id
       OR NEW.twin_id <> OLD.twin_id
       OR NEW.post_id <> OLD.post_id
       OR NEW.verb <> OLD.verb
       OR NEW.acted_at <> OLD.acted_at THEN
        RAISE EXCEPTION 'dashboard_acts hold one permitted UPDATE (ticket #224): the outcome stamp. Row % tried to change what the act WAS', OLD.id;
    END IF;
    IF NEW.outcome IS NULL THEN
        RAISE EXCEPTION 'dashboard_acts row % cannot be un-stamped (ticket #224) — the entries and rows it authorized name it already', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dashboard_acts_no_update_delete ON dashboard_acts;
DROP TRIGGER IF EXISTS dashboard_acts_no_delete ON dashboard_acts;
CREATE TRIGGER dashboard_acts_no_delete
    BEFORE DELETE ON dashboard_acts
    FOR EACH ROW EXECUTE FUNCTION dashboard_acts_immutable();

DROP TRIGGER IF EXISTS dashboard_acts_stamp_only ON dashboard_acts;
CREATE TRIGGER dashboard_acts_stamp_only
    BEFORE UPDATE ON dashboard_acts
    FOR EACH ROW EXECUTE FUNCTION dashboard_acts_immutable();

DROP TRIGGER IF EXISTS dashboard_acts_no_truncate ON dashboard_acts;
CREATE TRIGGER dashboard_acts_no_truncate
    BEFORE TRUNCATE ON dashboard_acts
    FOR EACH STATEMENT EXECUTE FUNCTION dashboard_acts_immutable();

-- THE RUNTIME WRITES IT AND THE APERTURE READS IT, and neither may do more.
-- `dito_rep_web` is granted nothing at all: the dashboard does not record its
-- own acts, it asks the lease holder to perform them.
GRANT SELECT, INSERT ON dashboard_acts TO dito_twin_runtime;
-- ...AND THE ONE UPDATE THE TRIGGER PERMITS, narrowed to the column it
-- permits: the outcome stamp is the runtime's, and no other column is
-- reachable even by a statement that tried.
GRANT UPDATE (outcome) ON dashboard_acts TO dito_twin_runtime;
GRANT SELECT ON dashboard_acts TO dito_aperture;
REVOKE DELETE, TRUNCATE ON dashboard_acts FROM dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON dashboard_acts FROM dito_aperture;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. THE THREE STORES THAT NAME A REP ACT NOW NAME EITHER SURFACE
-- ═══════════════════════════════════════════════════════════════════════
--
-- `draft_dismissals`, `fact_retractions` and `disclosure_lines` each carry
-- `source_event_id` NOT NULL — the rep's own «no va», «N no» or «va», raw and
-- plane-delivered. From this migration each carries the other surface's id
-- beside it, and an EXACTLY-ONE CHECK: an act came from one surface or the
-- other and never both, which is the statement `RepActEvidence`'s tagged union
-- makes in TypeScript.
--
-- NOT NULL BECOMES AN EXACTLY-ONE CHECK RATHER THAN A DROPPED CONSTRAINT, and
-- the difference is the whole safety of this section. "A rep act names the act
-- that authorized it" stays enforced by the store: a row naming NEITHER is
-- exactly the shape a laundered crossing takes — FR-72 says so in as many
-- words — and dropping NOT NULL without the CHECK would make it
-- representable.

ALTER TABLE draft_dismissals
    ADD COLUMN IF NOT EXISTS dashboard_act_id uuid REFERENCES dashboard_acts (id);
ALTER TABLE draft_dismissals ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE draft_dismissals
    DROP CONSTRAINT IF EXISTS draft_dismissals_one_evidence_check;
ALTER TABLE draft_dismissals
    ADD CONSTRAINT draft_dismissals_one_evidence_check
    CHECK ((source_event_id IS NULL) <> (dashboard_act_id IS NULL));

COMMENT ON COLUMN draft_dismissals.dashboard_act_id IS
    'Ticket #224: the dashboard act that discarded this draft, when the rep pressed Descartar on the card rather than replying «no va» in their thread. Exactly one of this and source_event_id is set — draft_dismissals_one_evidence_check.';

ALTER TABLE fact_retractions
    ADD COLUMN IF NOT EXISTS dashboard_act_id uuid REFERENCES dashboard_acts (id);
ALTER TABLE fact_retractions ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE fact_retractions
    DROP CONSTRAINT IF EXISTS fact_retractions_one_evidence_check;
ALTER TABLE fact_retractions
    ADD CONSTRAINT fact_retractions_one_evidence_check
    CHECK ((source_event_id IS NULL) <> (dashboard_act_id IS NULL));

-- ONE REP ACT AUTHORIZES ONE RETRACTION, on the other surface too — the rule
-- `fact_retractions_one_per_rep_act` states for the thread's. A SECOND partial
-- index rather than a widened one, because a unique index over two nullable
-- columns is unique over the PAIR: (NULL, act-A) and (NULL, act-B) are
-- distinct there whatever the acts are, so one act could authorize two
-- retractions and the constraint would say nothing.
CREATE UNIQUE INDEX IF NOT EXISTS fact_retractions_one_per_dashboard_act
    ON fact_retractions (dashboard_act_id)
    WHERE dashboard_act_id IS NOT NULL;

COMMENT ON COLUMN fact_retractions.dashboard_act_id IS
    'Ticket #224: the dashboard act that retracted this fact, when the rep pressed Retirar on the day''s card rather than replying «N no» in their thread. Exactly one of this and source_event_id is set, and each is unique — one act authorizes one retraction, whichever surface it came from.';

ALTER TABLE disclosure_lines
    ADD COLUMN IF NOT EXISTS dashboard_act_id uuid REFERENCES dashboard_acts (id);
ALTER TABLE disclosure_lines ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE disclosure_lines
    DROP CONSTRAINT IF EXISTS disclosure_lines_one_evidence_check;
ALTER TABLE disclosure_lines
    ADD CONSTRAINT disclosure_lines_one_evidence_check
    CHECK ((source_event_id IS NULL) <> (dashboard_act_id IS NULL));

-- ...AND A FACT LINE STILL NAMES A SEAM EVENT, WHICH IS NOT THE SAME CLAIM.
-- Only the ENTITY CREATE is a rep act the dashboard can perform: a fact line
-- is written by extraction, from a message somebody sent. Three readers follow
-- that column to a seam row without asking — the ADR-0033 exclusion invariant
-- finds which chat a fact was read in (`self-chat-exclusion.ts`), the
-- extraction-precision evals join it, and `readFiledFacts` returns it as a
-- non-null string. Each of them already scopes to `subject_kind = 'fact'`, so
-- this constraint is what makes that scoping SOUND rather than lucky: the
-- store refuses a fact line with no seam event, so a future writer cannot open
-- a silent hole in an invariant by filing one.
ALTER TABLE disclosure_lines
    DROP CONSTRAINT IF EXISTS disclosure_lines_fact_has_seam_evidence_check;
ALTER TABLE disclosure_lines
    ADD CONSTRAINT disclosure_lines_fact_has_seam_evidence_check
    CHECK (subject_kind <> 'fact' OR source_event_id IS NOT NULL);

-- ONE REP ACT AUTHORIZES ONE CREATE, on the other surface too — the rule
-- `disclosure_lines_one_create_per_rep_act` states for the thread's, for the
-- reason the retraction's second index gives one section up.
CREATE UNIQUE INDEX IF NOT EXISTS disclosure_lines_one_create_per_dashboard_act
    ON disclosure_lines (dashboard_act_id)
    WHERE subject_kind = 'entity_create' AND dashboard_act_id IS NOT NULL;

COMMENT ON COLUMN disclosure_lines.dashboard_act_id IS
    'Ticket #224: the dashboard act that authorized this line, when the rep confirmed a binding from Inicio''s card rather than replying «va» in their thread. Exactly one of this and source_event_id is set; a fact line always names the seam event, because only the entity create is an act the dashboard can perform (disclosure_lines_fact_has_seam_evidence_check).';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. A TWIN POST CAN NAME THE DASHBOARD ACT IT ACKNOWLEDGES
-- ═══════════════════════════════════════════════════════════════════════
--
-- A receipt names WHAT IT ACKNOWLEDGES, and `notices` has enforced that per
-- kind since slice 2: a `dismissal_ack`, a `binding_ack`, an `answer`, a
-- `correction_ack` and a `correction_refusal` each carry `about_event_id NOT
-- NULL`, so an acknowledgement that could not be traced to the rep's own
-- message was unrepresentable. That constraint is exactly right and it is
-- exactly what a dashboard act cannot satisfy: the rep pressed a button, and
-- there is no seam row behind a button.
--
-- SO THE NOTICE NAMES ONE OF TWO ORIGINS, which is the widening section 5
-- makes for the three stores that name a rep ACT — the same shape, on the
-- record of what the twin SAID about one. The per-kind constraints stay, and
-- each now reads «an event or an act»; nothing is dropped, so an
-- acknowledgement naming neither is still unrepresentable.
--
-- ...AND ONE ACKNOWLEDGEMENT PER ACT, which is the other half those
-- constraints rest on. `notices_one_answer_per_event` and
-- `notices_one_correction_per_event` make a second post for one rep message
-- unrepresentable "whatever a retry, a replay, or a future caller attempts";
-- the dashboard's acts get the same bound over their own column, as partial
-- unique indexes for the reason section 5 gives — a unique index over two
-- nullable columns is unique over the PAIR, which is no bound at all.
--
-- EVERY STANDING ROW SURVIVES: the column is nullable with no default, so the
-- ALTER rewrites nothing, and each re-cut CHECK is strictly weaker than the
-- one it replaces.

ALTER TABLE notices
    ADD COLUMN IF NOT EXISTS dashboard_act_id uuid REFERENCES dashboard_acts (id);

COMMENT ON COLUMN notices.dashboard_act_id IS
    'Ticket #224: the dashboard act this post acknowledges, when the rep pressed a button on a card rather than replying in their thread. Exactly one of this and about_event_id is set (notices_one_origin_check), and each per-kind constraint accepts either — an acknowledgement that names neither is still unrepresentable.';

-- A NOTICE HAS ONE ORIGIN. Both columns set would be a post claiming to
-- acknowledge two different acts, which no writer does and no reader could
-- resolve; the CHECK is what makes that unrepresentable rather than merely
-- unwritten. It is deliberately NOT «exactly one»: the day's disclosure and
-- the send confirmation name neither, and have not since slice 2.
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_one_origin_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_one_origin_check
    CHECK (about_event_id IS NULL OR dashboard_act_id IS NULL);

-- The five kind-specific constraints, re-cut to accept either origin. Each is
-- dropped `IF EXISTS` and re-added, so a hand replay re-states it.
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_dismissal_ack_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_dismissal_ack_about_event_check
    CHECK (kind <> 'dismissal_ack'
           OR about_event_id IS NOT NULL OR dashboard_act_id IS NOT NULL);

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_confirm_ack_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_confirm_ack_about_event_check
    CHECK (kind <> 'binding_ack'
           OR about_event_id IS NOT NULL OR dashboard_act_id IS NOT NULL);

ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_correction_about_event_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_correction_about_event_check
    CHECK (kind NOT IN ('correction_ack', 'correction_refusal')
           OR about_event_id IS NOT NULL OR dashboard_act_id IS NOT NULL);

-- `affirmation_refusal` AND `answer` ARE NOT RE-CUT, and that is a statement
-- rather than an omission. An affirmation refusal is the send lock's own
-- microcopy about a rep message the matcher read, and an `answer` is a thread
-- execution answering one — neither has a dashboard arm in 6a, and *Habla con
-- Dito* is 6b's (spec #214's out-of-scope list). A constraint widened ahead of
-- the caller that needs it is a constraint that stops saying anything.

-- ONE ACKNOWLEDGEMENT PER ACT, over the column the acts use.
CREATE UNIQUE INDEX IF NOT EXISTS notices_one_ack_per_dashboard_act
    ON notices (twin_id, dashboard_act_id)
    WHERE dashboard_act_id IS NOT NULL;

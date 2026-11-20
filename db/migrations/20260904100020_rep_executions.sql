-- The REP side's execution record (ticket #172; spec #171 decision 12;
-- ADR-0014 as amended 2026-09-04, ADR-0020, ADR-0029).
--
-- NUMBERING: …2026090410002·, after …20260904100010 (the grown disposition
-- set and the lane, #178). Forward-only: no migration in this repo is ever
-- edited once it has applied anywhere, because a migration is a statement
-- about what a database has already been through.
--
-- ═══ WHY A SECOND EXECUTIONS TABLE, REP-SIDE ═══
--
-- `owner.executions` is the OWNER app's own state, in the schema
-- `dito_owner` owns, behind row-level security keyed to the company a
-- connection declared. It is on the far side of the wall from everything a
-- rep does (`fr73-shared-stores.ts` puts the whole `owner` schema out of
-- FR-73's frame with that written reason), and the owner role holds no
-- privilege at all on any `public` table since #165. So the rep side cannot
-- write there and must not: a drafting execution is the rep's twin working
-- for the rep, and its record belongs where the rep's other stores are.
--
-- IT IS `ExecutionRecord` COLUMN FOR COLUMN, the way the owner's is — the
-- trigger's kind and mechanism, the content-free trigger reference, the
-- instructions digest, the tool list the execution was GIVEN, the lane, two
-- instants, three numbers and a word. Nothing else is on the record and
-- nothing else is here.
--
-- ═══ CONTENT-FREE, AND CHECKED RATHER THAN PROMISED ═══
--
-- Every column is metadata about a run. There is no message, no draft body,
-- no «porque», no counterparty name and no chat address: the draft's text is
-- `drafts.content_enc` and the post the rep read is `drafts.post_enc`, both
-- DEK envelopes (ADR-0008), and the twin's own words to the rep are
-- `notices.content_enc`. That is what earns the `no-rep-content` custody
-- class in FR-73's registry, where this table is declared — an undeclared
-- rep-side store outside the bundle fails that audit in both directions,
-- which is the point.
--
-- `trigger_ref` IS THE ONE COLUMN THAT COULD DRIFT, so it carries a CHECK.
-- It is rendered by `triggerRef` in `@dito/execution`, which renders the
-- twin, the anchor event and the turn's event count and deliberately not the
-- chat — but this column is written by an INSERT, and an INSERT is what a
-- later occasion, a fixture or a psql session can write by hand. A chat
-- address is the one shape of content that would plausibly arrive here (the
-- occasion IS a chat's turn), it always carries `@` (`ledger-wall-check.mjs`
-- sweeps the Ledger for exactly these shapes), and no id this reference can
-- hold ever does — event ids are bigints and every other id is a UUID. So
-- the store refuses one. A reference that cannot be rendered content-free is
-- a reference that must not be stored, and the same string is on an
-- append-only chain beside it.
--
-- ═══ APPEND-ONLY, BY TRIGGER, THE WAY `notices` IS ═══
--
-- A record of a run that happened does not change. `notices` (…100015) is
-- the shape: a BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE
-- statement trigger, both raising. The reason is stronger here than for a
-- notice, because this row's twin is the audit chain: the runner appends one
-- content-free entry per execution and this row is written beside it in the
-- same transaction (ADR-0020, spec #171 decision 12). An entry that cannot
-- be unwritten beside a record that could be edited would make the pair
-- meaningless — the chain would attest to a run whose record now says
-- something else. `extraction_runs` (…100027) is the one rep-side store that
-- DOES take UPDATE, and its own header says why: `submitted` → `filed` is a
-- state machine, and a row per transition would make "one run per (twin,
-- chat, day)" unstateable. An execution has no states; it has an ending.
--
-- ═══ GRANTS, ON PURPOSE ═══
--
-- …100012 granted `dito_twin_runtime` write on ALL TABLES IN SCHEMA public
-- at a point in time, and its own header states the rule that makes this
-- block necessary: "Deliberately NOT covered by ALTER DEFAULT PRIVILEGES: a
-- rep-side store added later must be granted on purpose". A table created
-- after that migration is reachable by nobody until a migration says so.
--
-- SELECT AND INSERT FOR THE RUNTIME, AND NOT UPDATE. The append-only
-- triggers above already refuse an UPDATE at run time; the point of revoking
-- it here as well is that the GRANT DIFF says so too, so a later migration
-- handing the runtime one is visible in FR-71a's own diff rather than caught
-- by a trigger in front of a rep (…100080's block makes exactly this
-- argument for the owner's grant on `audit_chain`). SELECT is needed because
-- the runtime reads its own records — a boundary session reads latency,
-- iterations and tokens per execution out of this table (spec #171 user
-- story 27), and the coverage check joins it.
--
-- READ-ONLY FOR THE APERTURE, exactly as …100027 grants it on
-- `extraction_runs`. `@dito/aperture` is the package that OWNS the coverage
-- enumeration — ADR-0003 puts every statement naming a Ledger object inside
-- the single writer's package, which is what moved `audit-coverage.ts` there
-- — and its class for this table joins these rows against the rep chain. It
-- holds no INSERT and never will: the far side of the wall does not get to
-- say that an execution ran.
--
-- ═══ THE TWO NULLABLE REFERENCES ═══
--
-- `notices.execution_id` and `draft_timings.execution_id` are NULL-able, and
-- that is exact rather than lenient: every draft and every notice written
-- before this migration was produced by a harness, not by an execution, so
-- there is no execution for those rows to name and inventing one would be a
-- claim about history. The rig carries its bundle, its drafts and its
-- notices across slices (spec #171's definition of done, item 1), so those
-- rows are real and they stay NULL. Every notice and timing this build
-- writes from the drafting path carries one.
--
-- `extraction_runs` gains its own in 5b (spec #171's out-of-scope list), and
-- `drafts` gains none: a draft is named BY its timing row, which is the
-- 1:1 the timings table already is, so a second reference on the draft would
-- be the same fact stored twice.

CREATE TABLE executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The twin whose runtime ran it. On every rep-side row since slice 1.
    twin_id uuid NOT NULL,
    -- The trigger's occasion and how it came to be — `Trigger.kind` and
    -- `Trigger.mechanism` (spec #171 decision 10). Stored as text and NOT
    -- constrained to a list, deliberately: `OCCASIONS` is a six-word closed
    -- set in `@dito/execution` that gains a rep-side record type per ticket
    -- (#173–#176), and a CHECK enumerating them here would have to be re-cut
    -- by every one of those tickets from its own ancestor — the exact DROP +
    -- re-CREATE hazard the disposition CHECK below is watched for. What
    -- would be gained is nothing the type does not already give: the store
    -- writes `record.trigger.kind` off a closed TypeScript union, and no
    -- acceptance criterion anywhere asks this column to refuse a word typed
    -- by hand into an append-only table.
    trigger_kind text NOT NULL,
    trigger_mechanism text NOT NULL,
    -- The rendered, content-free reference — the same string the execution's
    -- one chain entry carries, from the same function, so the row and the
    -- entry cannot describe different runs. See the header for the CHECK.
    trigger_ref text NOT NULL,
    instructions_digest text NOT NULL,
    -- The tool list the execution was GIVEN, not the one it called: the
    -- digest beside it is 32 opaque hex characters, so without this a reader
    -- of this table could not say what a run was able to reach.
    tool_names text[] NOT NULL,
    -- Which of the runtime's two lanes ran it (spec #171 decision 3).
    -- Declared by the automation and copied off the record, never chosen by
    -- whatever code fired the run.
    lane text NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz NOT NULL,
    iterations integer NOT NULL,
    tokens_input integer NOT NULL,
    tokens_output integer NOT NULL,
    -- THE CLOSED SET, VERBATIM from `DISPOSITIONS` in `@dito/execution`, and
    -- watched from birth by `migration-vocabulary.test.ts` rather than after
    -- its first re-cut. The type in TypeScript cannot reach a psql session,
    -- and this constraint cannot reach a build ahead of it — so the sweep is
    -- what makes the two one vocabulary (spec #171 decision 11).
    disposition text NOT NULL,
    CONSTRAINT executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified')),
    CONSTRAINT executions_lane_check CHECK (lane IN ('realtime', 'batch')),
    CONSTRAINT executions_trigger_ref_check CHECK (btrim(trigger_ref) <> ''),
    -- CONTENT-FREE, ENFORCED. See the header: `@` is the one character every
    -- WhatsApp address carries and no id this reference holds ever does.
    CONSTRAINT executions_trigger_ref_content_free_check
        CHECK (trigger_ref NOT LIKE '%@%'),
    CONSTRAINT executions_digest_check CHECK (btrim(instructions_digest) <> ''),
    CONSTRAINT executions_iterations_check CHECK (iterations >= 0),
    CONSTRAINT executions_tokens_check
        CHECK (tokens_input >= 0 AND tokens_output >= 0),
    CONSTRAINT executions_window_check CHECK (ended_at >= started_at)
);

COMMENT ON TABLE executions IS
    'Ticket #172: one row per REP-SIDE execution — the trigger''s occasion and mechanism, its content-free reference, the instructions digest, the tool list it was given, the lane, timings, tokens and disposition (spec #171 decision 12). Content-free: the draft is drafts.content_enc, the post is drafts.post_enc, the twin''s words are notices.content_enc. Append-only, beside one audit-chain entry per row (ADR-0020).';
COMMENT ON COLUMN executions.trigger_ref IS
    'The trigger as an opaque audit reference, rendered by triggerRef in @dito/execution — the same string this execution''s chain entry carries. No chat, no message: a chat address dereferences to chat identity (ADR-0004) and a chain entry is content-free (ADR-0020), and the CHECK is what keeps that true of an INSERT.';
COMMENT ON COLUMN executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified (spec #171 decision 11). Widened, never narrowed; the rep side writes drafted, no-action and failed this slice.';
COMMENT ON COLUMN executions.lane IS
    'Which of the runtime''s two lanes ran it — realtime · batch (spec #171 decision 3). Copied off the execution record. No DEFAULT here, unlike owner.executions: there is no row predating the column and no writer that could omit it, so a default would be a value nobody chose.';

-- The read a boundary session makes: this twin's executions, newest first
-- (spec #171 user story 27 — latency and cost per execution are numbers on
-- the boundary ticket). Same shape as `owner_executions_company_started_idx`.
CREATE INDEX executions_twin_started_idx
    ON executions (twin_id, started_at DESC, id DESC);

-- APPEND-ONLY (see the header). `notices_immutable`'s shape, with its own
-- function so the message names this table.
CREATE FUNCTION executions_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'executions are append-only: % refused — a record of a run that happened does not change, and its audit-chain entry cannot be unwritten (ADR-0020)', TG_OP;
END;
$$;

CREATE TRIGGER executions_no_update_delete
    BEFORE UPDATE OR DELETE ON executions
    FOR EACH ROW EXECUTE FUNCTION executions_immutable();
CREATE TRIGGER executions_no_truncate
    BEFORE TRUNCATE ON executions
    FOR EACH STATEMENT EXECUTE FUNCTION executions_immutable();

-- ── The two references (see the header) ────────────────────────────────────

ALTER TABLE notices
    ADD COLUMN execution_id uuid REFERENCES executions (id);
COMMENT ON COLUMN notices.execution_id IS
    'The execution that produced this post, when one did (ticket #172). NULL for every notice written before executions existed, and for the posts no execution composes — the send confirmation, the refusal microcopy, the daily disclosure.';

ALTER TABLE draft_timings
    ADD COLUMN execution_id uuid REFERENCES executions (id);
COMMENT ON COLUMN draft_timings.execution_id IS
    'The execution that produced this draft, when one did (ticket #172). NULL for every draft the drafting harness wrote before the runtime existed. NFR-2''s numbers and the execution''s own iterations and tokens join here.';

-- ── Grants, on purpose (…100012's rule; see the header) ────────────────────

GRANT SELECT, INSERT ON executions TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON executions FROM dito_twin_runtime;

GRANT SELECT ON executions TO dito_aperture;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON executions FROM dito_aperture;

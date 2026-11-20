-- The owner twin's own state, and the one public table the owner may append
-- to (ticket #130; spec #126 decisions 3, 5(e), 5(f) and 18; ADR-0002,
-- ADR-0014 as amended, ADR-0020, ADR-0029).
--
-- NUMBERING: the …2026090210008· range, reserved for this ticket. …100010
-- through …100060 are #127's and #129's.
--
-- WHAT LIVES HERE. Three tables in the schema `dito_owner` owns (…100020):
-- the owner's questions in the owner's own words, the execution record
-- ADR-0014's runtime produces, and the typed submission the twin came back
-- with. Nothing here is Ledger data and nothing here is a rep-side store —
-- FR-73 enumerates rep-side stores and the `owner` schema is owner-side
-- (spec #126, Testing Decisions; `fr73-shared-stores.ts` already says so).
--
-- OWNERSHIP IS SET EXPLICITLY, and it is not decoration. Atlas runs this as
-- `dito` (ADR-0029), so a plain CREATE TABLE here lands owned by `dito` —
-- and FR-71a's own claim 8 is that every relation in the `owner` schema is
-- a table or a sequence OWNED BY `dito_owner`. Without the ALTERs below the
-- grant audit goes red on the first table this ticket creates, which is
-- exactly what that claim is for: the owner app owns its own state, which
-- is what makes it need no grant from anybody to write it.
--
-- TABLES, NEVER A VIEW (#127's handoff, and Codex's finding behind it): the
-- schema's default privileges grant the owner ALL on every table created
-- here, and PostgreSQL applies TABLE defaults to VIEWS — so an `owner.…`
-- view over `ledger.facts` would arrive owner-readable through a grant
-- nobody wrote. `auditOwnerSchema` refuses any relation kind but a table, a
-- partition or a sequence, and these three are tables.

-- THE OWNER'S QUESTION, in the owner's own words.
--
-- THE TEXT IS OWNER-SIDE DATA AND IT IS NOT AUDIT (ADR-0025: "the
-- failed-query log is owner-side data in the owner app"; ADR-0020: chain
-- entries are content-free). The chain records that an execution ran, under
-- an opaque trigger reference; the words the owner typed are a row here,
-- readable by the owner app and by nobody else.
CREATE TABLE owner.questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The tenant, on every row, because the policy below is what makes a
    -- second company's questions unreadable through the one owner role
    -- (ADR-0002: "every shared table carries `company_id` under Postgres
    -- RLS"). The `owner` schema is not shared between deployments today —
    -- one owner app serves one company — but the ROLE is cluster-global and
    -- the tables are one schema, so two deployments against one database
    -- would read each other's questions with nothing in the way.
    company_id uuid NOT NULL,
    asked_at timestamptz NOT NULL DEFAULT now(),
    text text NOT NULL,
    CONSTRAINT owner_questions_text_check CHECK (btrim(text) <> '')
);

COMMENT ON TABLE owner.questions IS
    'Ticket #130: what the owner asked the owner twin, in the owner''s own words. Owner-side data (ADR-0025), never audit (ADR-0020 entries are content-free).';

CREATE INDEX owner_questions_company_asked_idx
    ON owner.questions (company_id, asked_at DESC, id DESC);

-- THE EXECUTION RECORD — `ExecutionRecord` from `@dito/execution`, column
-- for column (spec #126 decision 5(e); user story 36).
--
-- NO CONTENT. A trigger's ids, a digest, tool names, two instants, three
-- numbers and a word. The question's text is the row above; the twin's
-- prose is the row below. That separation is the reason the failed-query
-- log (FR-48) is a DISPOSITION here and not a second system: counting
-- `schema-miss` over this table is the whole of the log.
CREATE TABLE owner.executions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- ONE EXECUTION PER QUESTION, and the UNIQUE is what makes the coverage
    -- join in `audit-coverage.ts` sound: it enumerates acts as one row per
    -- execution and matches the entry whose `ref` carries
    -- `owner_question:<id>`, so two executions sharing a question would be
    -- two acts one entry could cover.
    owner_question_id uuid NOT NULL UNIQUE REFERENCES owner.questions (id),
    company_id uuid NOT NULL,
    -- The trigger's kind, from `Trigger` — one member this slice, open by
    -- design (slice 5 adds kinds). Stored rather than assumed so a reader of
    -- this table can tell an owner question from whatever comes next
    -- without joining the column that happens to be NOT NULL today.
    trigger_kind text NOT NULL,
    instructions_digest text NOT NULL,
    tool_names text[] NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz NOT NULL,
    iterations integer NOT NULL,
    tokens_input integer NOT NULL,
    tokens_output integer NOT NULL,
    -- THE CLOSED SET, VERBATIM from `DISPOSITIONS` in `@dito/execution`. A
    -- sixth word invented at a call site makes "what did the Ledger fail to
    -- answer" unanswerable in the quietest possible way, and the type in
    -- TypeScript cannot reach a psql session.
    disposition text NOT NULL,
    CONSTRAINT owner_executions_trigger_kind_check
        CHECK (trigger_kind IN ('owner_question')),
    CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed')),
    CONSTRAINT owner_executions_iterations_check CHECK (iterations >= 0),
    CONSTRAINT owner_executions_tokens_check
        CHECK (tokens_input >= 0 AND tokens_output >= 0),
    CONSTRAINT owner_executions_window_check CHECK (ended_at >= started_at)
);

COMMENT ON TABLE owner.executions IS
    'Ticket #130: one row per execution — trigger, instructions digest, tool names, timings, tokens, disposition (ADR-0014 as amended; spec #126 decision 5(e)). Content-free: the question is owner.questions, the answer is owner.answers.';
COMMENT ON COLUMN owner.executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed. FR-48''s failed-query log is a count over this column.';

CREATE INDEX owner_executions_company_started_idx
    ON owner.executions (company_id, started_at DESC, id DESC);

-- THE TYPED SUBMISSION, AS SUBMITTED (spec #126 decision 18).
--
-- `refs` HOLDS THE ROWS' OWN IDS AND NOT THE WIRE'S SMALL INTEGERS. The
-- model cites a run-scoped ref — a small integer that means nothing outside
-- its own execution and therefore cannot be forged from a previous answer —
-- and the served map translates it here into the row's own id before it is
-- stored. So a stored answer re-renders from the Ledger by id (the room
-- reads the fact again, with whatever provenance it has today) rather than
-- from stored HTML, and a ref from yesterday's run resolves to nothing
-- today, which is correct.
CREATE TABLE owner.answers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id uuid NOT NULL UNIQUE REFERENCES owner.executions (id),
    owner_question_id uuid NOT NULL REFERENCES owner.questions (id),
    company_id uuid NOT NULL,
    -- The four kinds of the owner twin's submission. `failed` is not among
    -- them and never can be: a failed execution produced no submission, so
    -- it has an execution row and no answer row, which is exactly how the
    -- failed-query log reads.
    kind text NOT NULL,
    prose text NOT NULL,
    -- FR-46's third part, on the one kind that has one: the suggested human
    -- follow-up, composed by the twin like the refusal above it. A column
    -- rather than a field inside `refs`, because it is prose the owner reads
    -- and not a reference at all.
    follow_up text,
    -- The submission's references, resolved to row ids: an array of
    -- `{ ref, kind, factId | entityId | seatId | count, roles }` objects,
    -- where `roles` says what each one was to this answer — cited in the
    -- receipt, offered as a candidate, pointed at as a timeline, rendered as
    -- a count. JSONB rather than a table because nothing joins them: the
    -- room re-reads each id through the owner reads, and a reference is
    -- meaningful only inside the answer it belongs to.
    refs jsonb NOT NULL,
    CONSTRAINT owner_answers_kind_check
        CHECK (kind IN ('answer', 'refusal', 'ask', 'schema-miss')),
    CONSTRAINT owner_answers_refs_check CHECK (jsonb_typeof(refs) = 'array'),
    -- A refusal carries a follow-up and nothing else does: FR-46's structure
    -- is three parts, and a refusal without its third part is a refusal that
    -- leaves the owner nowhere to go.
    CONSTRAINT owner_answers_follow_up_check
        CHECK ((kind = 'refusal') = (follow_up IS NOT NULL))
);

COMMENT ON TABLE owner.answers IS
    'Ticket #130: the twin''s typed submission as submitted — kind, composed prose with its slots, and the references resolved to row ids so the room re-renders from the Ledger rather than from stored markup (spec #126 decision 18).';

CREATE INDEX owner_answers_question_idx ON owner.answers (owner_question_id);

-- THE OWNER APP OWNS ITS OWN STATE (FR-71a claim 8). Set explicitly because
-- Atlas runs as `dito`; see the header.
ALTER TABLE owner.questions OWNER TO dito_owner;
ALTER TABLE owner.executions OWNER TO dito_owner;
ALTER TABLE owner.answers OWNER TO dito_owner;

-- TENANT ISOLATION ON THE OWNER'S OWN TABLES.
--
-- FORCE, because the owner role OWNS these tables and a table's owner is
-- exempt from its own policies unless forced — which would make the policy
-- true of everybody except the one role that ever reads through it.
--
-- The predicate is the same `ledger.declared_company()` every Ledger policy
-- reads (…100040), and `dito_owner` already holds EXECUTE on it. One
-- definition of "the company this connection declared", so the owner's own
-- rows and the Ledger's rows can never disagree about which tenant is
-- reading, and an owner app that forgot to declare a company reads ZERO
-- ROWS here exactly as it does through the views.
--
-- WITH CHECK ON THE INSERT ARM, not only USING on the read: without it a
-- deployment serving company A could write a question stamped with company
-- B's id — invisible to itself afterwards, and readable by B. The company
-- on the row and the company on the connection are the same company or the
-- insert fails.
--
-- NO UPDATE AND NO DELETE POLICY, deliberately. A policy is permissive and
-- there is none for either command, so neither is permitted to anybody the
-- policies bind. The owner app appends its conversation; it does not edit
-- it, and an answer that could be rewritten after the fact is a record the
-- audit chain's digest could no longer speak for.
ALTER TABLE owner.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner.questions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_questions_company_read ON owner.questions
    FOR SELECT
    USING (company_id = ledger.declared_company());
CREATE POLICY owner_questions_company_write ON owner.questions
    FOR INSERT
    WITH CHECK (company_id = ledger.declared_company());

ALTER TABLE owner.executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner.executions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_executions_company_read ON owner.executions
    FOR SELECT
    USING (company_id = ledger.declared_company());
CREATE POLICY owner_executions_company_write ON owner.executions
    FOR INSERT
    WITH CHECK (company_id = ledger.declared_company());

ALTER TABLE owner.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner.answers FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_answers_company_read ON owner.answers
    FOR SELECT
    USING (company_id = ledger.declared_company());
CREATE POLICY owner_answers_company_write ON owner.answers
    FOR INSERT
    WITH CHECK (company_id = ledger.declared_company());

-- THE ONE PUBLIC TABLE THE OWNER MAY TOUCH — Diego's ruling on #130,
-- 2026-09-02, recorded as an erratum to spec #126 decision 3.
--
-- ADR-0020 says there is one chain, and #128's runner appends exactly one
-- content-free entry per execution before it returns or throws. The owner
-- twin IS an execution, so the owner app appends — which needs SELECT (the
-- append reads and authenticates the tail before extending it) and INSERT,
-- and nothing else, ever. UPDATE and DELETE are refused by the append-only
-- TRIGGER on this table already; the point of revoking them here is that
-- the GRANT DIFF says so too, so a future migration handing the owner one
-- goes red in `ledger-grants-check` rather than being caught by a trigger at
-- run time.
--
-- REJECTED, and recorded so the question is not reopened: an in-database
-- HMAC (the key would live in Postgres, breaking ADR-0020's fail-closed env
-- custody) and a second owner-side chain (which splits audit-verify into two
-- verdicts that cannot be reconciled). A compromised owner web can append
-- valid-looking entries — it holds the same key every rep-side process holds
-- — and can never alter history, which is the property the chain has always
-- claimed.
GRANT SELECT, INSERT ON audit_chain TO dito_owner;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_chain FROM dito_owner;

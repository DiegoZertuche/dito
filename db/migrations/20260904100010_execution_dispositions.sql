-- The execution record's grown vocabulary: eight dispositions, and the lane
-- (ticket #178; spec #171 decisions 3 and 11; ADR-0014 as amended
-- 2026-09-04, ADR-0029).
--
-- NUMBERING: …2026090410001·, the first of 2026-09-04, after …20260903100010
-- (the owner chain, #165). Forward-only: no migration in this repo is ever
-- edited once it has applied anywhere, because a migration is a statement
-- about what a database has already been through.
--
-- ═══ WHY A CHECK IS WIDENED AND NEVER NARROWED ═══
--
-- Postgres has no "add a value to a CHECK", so a closed set is extended by
-- DROP + re-CREATE — which means every extension re-writes the WHOLE list
-- from whatever the author's ancestor said. That is safe on one branch and
-- dangerous on several: four tickets cut from one parent each re-write the
-- list from their own ancestor, and whichever migration sorts last silently
-- wins. Nothing fails when it happens. The constraint simply stops accepting
-- a word the code still writes, and the first person to find out is a user
-- performing the act that word describes.
--
-- So the rule, machine-checked since …20260827100022 and now watched for this
-- constraint too (`packages/twin-runtime/src/migration-vocabulary.test.ts` —
-- the repo's one sweep over these constraints, and not only the seam's since
-- #71 put the aperture's fact types under it):
-- every value an earlier migration granted rides forward. WIDENING is safe
-- because a value nothing writes costs nothing — the column is a record of
-- how executions ended, and a word with no writer simply never appears.
-- NARROWING is not the mirror image of that: it turns a shipped behaviour
-- into a constraint violation at run time, in the one place the failure
-- cannot be recovered from, because the execution has already happened and
-- its audit entry is already on an append-only chain. A record that cannot
-- be written beside an entry that cannot be unwritten is the exact hole
-- ADR-0020's coverage check exists to find, arrived at from the store side.
--
-- THE THREE NEW WORDS. `drafted` (a draft accepted), `acted` (a reply
-- accepted AND an effect performed — the runtime's word, decided from the
-- tool results, never the model's claim) and `classified` (a kind accepted)
-- join the five of #128. NOTHING WRITES THEM YET, and they are here anyway:
-- the rep-side executions that assign them arrive with #172, and a
-- constraint Postgres can only extend by dropping and re-creating is worth
-- extending once rather than three times. The words are argued in ONE place,
-- `DISPOSITIONS` in `@dito/execution` (spec #171 decision 11 — "the set
-- stays argued in one place"), and the vocabulary test proves this list is
-- exactly that constant.
--
-- ═══ WHY THE LANE IS PERSISTED OWNER-SIDE ═══
--
-- The lane is a rep-side runtime fact: two lanes exist so drafting and the
-- twin thread stay off extraction's back (spec #171 decision 3), and the
-- owner web will only ever write `realtime`. A column that always holds one
-- value is a fair thing to question, and the answer is the one this table
-- already gave for `trigger_kind` — which was equally constant when it was
-- added, and whose own comment says why it was stored anyway: "so a reader
-- of this table can tell an owner question from whatever comes next without
-- joining the column that happens to be NOT NULL today".
--
-- The stronger reason is this table's founding claim. Its header says it is
-- "`ExecutionRecord` from `@dito/execution`, column for column", and #178
-- puts `lane` on that record. A field on the record with no column here
-- would quietly retire that claim, and the next reader diffing the type
-- against the table would find a gap with no argument attached to it. The
-- column is content-free — one of two words — so it costs a CHECK and a line
-- in FR-71a's pin (`OWNER_TABLE_COLUMNS`, which is what stops a column
-- nobody wrote down from becoming owner-readable through ownership).
--
-- BACKFILLED THROUGH A DEFAULT, AND THE DEFAULT STAYS. Existing rows are the
-- rig's owner turns and every one of them ran in the realtime lane, so the
-- backfill is exact rather than a guess.
--
-- THE DEFAULT WAS DROPPED IN THE FIRST CUT AND THAT WAS WRONG, on two
-- counts. It is not this repo's pattern: the two columns added this way
-- before — `extraction_runs.steering` (…20260830100020) and
-- `extraction_runs.unresolved_reference` (…20260830100090) — are both
-- `NOT NULL DEFAULT` and both keep it, and a third shape for the same
-- migration is the kind of divergence a reader has to stop and account for.
-- And dropping it makes the column a version-skew trap (Codex r3): a binary
-- that has not been redeployed still inserts the previous column list, which
-- violates NOT NULL the moment the default is gone — so an owner turn would
-- spend a model call and then fail at persistence, during exactly the window
-- a rollout or a rollback is open.
--
-- WHAT THE DEFAULT DOES NOT COST. The worry it was dropped over is an insert
-- that forgets the lane and silently takes one nobody chose. For the writers
-- that matter that is unreachable by TYPE rather than by constraint:
-- `ExecutionRecord.lane` is required in `@dito/execution`, so
-- `OwnerTwinStore.recordExecution` cannot omit it and neither can the
-- rep-side store #172 adds. What is left is hand-written SQL — a fixture, a
-- script — and for one of those `realtime` is the honest reading of a row
-- written as though lanes did not exist.
--
-- OWNERSHIP AND GRANTS ARE UNTOUCHED, deliberately and checkably. The table
-- stays owned by `dito_owner_state` (…20260902100090), its policies stay the
-- pinned company predicate, and `dito_owner` keeps SELECT and INSERT and
-- nothing else — the grant is TABLE-level, so the new column is covered by
-- the grant that already exists and no new GRANT is written here. FR-71a's
-- grant diff is what proves that, in both directions, on every push.

-- ── The disposition set: five words to eight ────────────────────────────────
ALTER TABLE owner.executions
    DROP CONSTRAINT owner_executions_disposition_check;

ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_disposition_check
        CHECK (disposition IN ('answered', 'wall-refused', 'schema-miss',
                               'no-action', 'failed', 'drafted', 'acted',
                               'classified'));

COMMENT ON COLUMN owner.executions.disposition IS
    'The closed set from @dito/execution: answered · wall-refused · schema-miss · no-action · failed · drafted · acted · classified (spec #171 decision 11). Widened at #178 and never narrowed. FR-48''s failed-query log is a count over this column; the owner side writes only the first five.';

-- ── The lane ───────────────────────────────────────────────────────────────
ALTER TABLE owner.executions
    ADD COLUMN lane text NOT NULL DEFAULT 'realtime';

ALTER TABLE owner.executions
    ADD CONSTRAINT owner_executions_lane_check
        CHECK (lane IN ('realtime', 'batch'));

COMMENT ON COLUMN owner.executions.lane IS
    'Which of the runtime''s two lanes ran it — realtime · batch (spec #171 decision 3). Declared by the automation and copied off the execution record; the owner side writes only realtime. DEFAULT ''realtime'' is kept deliberately: it backfilled the rows that predate lanes and it keeps this column safe against a writer that has not been redeployed. Content-free.';

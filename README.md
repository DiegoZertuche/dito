# Dito

Dito is a WhatsApp-native assistant ("twin") for sales reps at small businesses, with a separate, limited view for the business owner. This repository is a public snapshot of the backend of a side project I build solo. It is pre-pilot: it runs daily on one dogfood rig and has no customers yet.

## What it does

- **Drafts replies.** The twin reads a rep's customer chats and drafts answers in the rep's own voice. Nothing reaches a customer until the rep approves it.
- **Keeps the day's notes.** Each evening it extracts what was agreed (quotes, orders, deals) and shows the rep the list, with a window to correct or retract each line before it becomes firm.
- **Runs routines.** The rep asks in plain language ("every day at 4, list the customers who haven't answered"), and the twin writes and runs a small workflow for it.
- **Gives the owner a narrow view.** The owner sees only the facts that crossed from the rep's side, never the conversations.

## What is in this snapshot

- **The WhatsApp connection** (`plane/`, Go): the link to a rep's number, the capture guard that decides what is recorded, and the send executor. It talks to the rest only through Postgres (ADR-0005, ADR-0006).
- **The twin's runtime** (`packages/twin-runtime`): the agent on the Claude Agent SDK, its gated tools, drafting, the evening extraction, and routines as workflow definitions the twin writes.
- **The wall between rep and owner** (`packages/aperture`): the only writer of anything the owner can read. The two sides use separate database roles, and CI checks the grants (ADR-0002, ADR-0003).
- **Per-rep encryption** (`packages/crypto`, `packages/bundle`): each twin's memory is a SQLCipher bundle whose key is wrapped by its own KMS key. Erasing a rep is destroying that key (ADR-0007, ADR-0008, ADR-0009).
- **The audit chain** (`packages/audit`, `packages/execution`): every unit of agent work leaves exactly one entry in an HMAC hash chain (ADR-0020).
- **Tests on real infrastructure.** The integration lane runs against real Postgres and real KMS, never mocks. A scripted model server stands in for the LLM, so CI never calls a model (ADR-0028).
- **Decisions on record.** `docs/adr/` holds the architecture decisions with their amendments, and `CONTEXT.md` is the project's glossary.

## What is left out

- **The two web dashboards** and their design documents. Code and comments still refer to them (`apps/rep-web`, `apps/owner-web`, "the dashboard", "Inicio"), and `packages/copy` holds their strings.
- **Eight decision records:** ADR-0017, ADR-0022, ADR-0030, ADR-0031, ADR-0032, ADR-0036, ADR-0037 and ADR-0044. Other documents still cite them. Three more (ADR-0015, ADR-0016, ADR-0019) have a passage removed.
- **The development history, the issue tracker and the planning documents.** This is a single commit, so links to issues and pull requests (`Dito-Core/dito#…`) do not resolve here.
- **The scripts that launch the dogfood rig.**

Because the dashboards are missing, the workspace does not build end to end as published. CI is included as it runs privately and is set to manual here; it needs AWS credentials this repository does not have. No license is granted: the code is published for reading.

Much of the code was written with AI coding agents, working one ticket at a time under review. The design, the decisions and the reviewing are mine.

## Layout

- `packages/twin-runtime` — the compute-plane runtime for one twin (TS)
- `packages/aperture` — the single Ledger writer and the filter deciding what may cross the wall; the only holder of `ledger` write credentials (TS, ADR-0003)
- `packages/crypto` — envelope crypto: per-twin KMS key wraps the DEK (TS, ADR-0008)
- `packages/bundle` — the per-twin SQLCipher bundle: opens only under the twin's DEK, stamped + forward-only-migrated, plus the fixture generator (TS, ADR-0007/0029)
- `packages/seam` — contracts + integration tests for the Postgres seam (TS, ADR-0005)
- `packages/audit` — HMAC hash chain for the audit logs: the rep side's, and
  the owner side's one-per-company (TS, ADR-0020 as amended)
- `packages/execution` — the one runtime: a trigger, a digest-stamped definition with gated tools and a typed submission, a budget, exactly one audit entry (TS, ADR-0014 as amended; slice 4)
- `packages/scripted-model` — the scripted model for tests: a loopback Anthropic Messages server the real Agent SDK child is pointed at, turns from a script, never a live call in CI (TS, ADR-0028)
- `packages/owner-twin` — the owner twin as a library: three projection tools over the owner reads, the structural guard, the rendered turn, the owner-side store (TS, ADR-0013 as amended, ADR-0037)
- `packages/evals` — the live evals, run on demand by an agent when a contract changes, never in CI (ADR-0028 as amended)
- `packages/copy` — every rep-facing string of the dashboard, keyed es-MX: chrome, the versioned legal documents, notify's templates with typed slots (TS, ADR-0037 as amended; slice 6a)
- `packages/notify` — the rep-side service that owns the email rail: a closed catalog of message types over SES, recipients from seat state, every send recorded content-free (TS, ADR-0022, ADR-0013 class 4; slice 6a)
- `plane/` — the Go connection plane: whatsmeow, the send executor, the capture guard (ADR-0005, ADR-0006)
- `db/migrations/` — the seam schema AND the `ledger` schema, applied by Atlas v1.3.0 (pinned, ADR-0029). The Ledger is wall-relevant, so the library-owned-store exemption does not apply to it.

## Fresh clone

Prereqs: Node ≥ 24, pnpm ≥ 11, Go ≥ 1.25, Docker (integration lane),
AWS dev-account credentials (KMS integration tests).

```sh
pnpm install
pnpm build        # before typecheck AND lint: both read the rig scripts'
                  # `../dist/*.d.ts` (ADR-free detail, tickets #79/#84)
pnpm typecheck
pnpm lint

# unit lane (hermetic)
pnpm test

# integration lane (real Postgres, real KMS — ADR-0028: never mocked)
pnpm db:up                # dockerized Postgres 16 on localhost:5433
export DITO_TEST_DATABASE_URL="postgres://dito:dito@localhost:5433/dito_test?sslmode=disable"
pnpm test:integration     # files in parallel, each on its own clone (below)
cd plane && go test ./... && cd ..        # a database per package (below)
pnpm db:down
```

**The integration lane, run locally (ticket #390).** One variable,
`DITO_TEST_DATABASE_URL`, names the run's *base*; there is no default, and
the base itself need not hold anything. From its name the lane derives every
database it touches, on the same server:

- `<base>_template` — migrated once per run by `scripts/migrate.sh` (the
  pinned Atlas), then sealed (`IS_TEMPLATE`, no connections). Every other
  database below is a clone of it.
- `<base>_<file>` — one per test file, e.g. `dito_test_twin_runtime_thread`
  for `packages/twin-runtime/src/thread.int.test.ts`. A suite's
  `resetAndMigrate()` replaces it with a fresh clone (about 0.1 s); a reset
  while the suite's own client is still connected re-applies the migrations
  in place instead.

Roles are cluster-global, so suites running at once — and other lanes on
the same server — share them through the role lock and the record of
borrowed role passwords (`packages/seam/src/testing/role-lock.ts`,
`role-borrows.ts`), both on the server's `postgres` database.

When the run ends it drops every file's database except those in
`KEPT_FOR_CHECKS` (`packages/seam/src/testing/database-url.ts`), which the
check scripts in `scripts/` read through `DITO_DATABASE_URL` — CI points each
check at its suite's kept database, and so can you. The template stays for
inspection; the next run rebuilds it. `--maxWorkers=N` changes the parallelism
(default 4). Names must fit Postgres's 63 characters, so keep the base short.

The plane's suite reads the same variable: each Go test binary creates
`<base>_go_<package>` and migrates it with Atlas, so packages run at once;
each run drops and recreates its own. Neither lane may share a base with a
live database: every name it derives must say `test`, or the reset refuses
unless `DITO_ALLOW_DB_RESET=1`.

`pnpm lint` runs ESLint over every `.ts`, `.js`, `.mjs` and `.cjs` file in the
repo — the packages, both `scripts/` directories, and the root `.mjs`
invariant scripts. The ruleset is deliberately small and each rule carries the
argument for it in [`eslint.config.js`](eslint.config.js), which also records
what is **not** yet enforced (ticket #84).

`scripts/migrate.sh [url]` applies migrations by hand;
`scripts/migrations-sum.sh` recomputes `db/migrations/atlas.sum` after adding
one. The KMS tests reuse a single fixture key
(`alias/dito-dev/twin-test-fixture`) — nothing creates per-run keys.

## CI

Two lanes on every push (`.github/workflows/ci.yml`): **unit** (build,
typecheck, lint, TS + Go tests — hermetic) and **integration** (Postgres 16
service + real dev-account KMS).
Without repo secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
(optionally `AWS_REGION`), the KMS tests skip **loudly** — a workflow warning
and a job-summary banner — never a mock, never a silent pass (ADR-0028).

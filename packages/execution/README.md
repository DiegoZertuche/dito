# @dito/execution

The minimum execution runtime. A credential-free library both apps consume:
it holds no database connection, no key and no model credential of its own.

Every unit of agentic work is an **execution** — a trigger creates it with
its own instructions, tools and context, and the agent inside decides what
to do, including nothing ([ADR-0014](../../docs/adr/0014-runtime-harness-tool-runner.md)
as amended; `CONTEXT.md`, *Execution*).

Every execution is written as one **execution definition**: named
instruction parts, the tools it holds, the context it is shown and its
budget, digest-stamped. Where the definitions come from — Dito's shipped
ones, the runs engine's steps, the rutinas a rep's twin writes — is the
owning app's (on the rep side, `twin-runtime/src/runs/`); this package runs
one and records it. There is one kind of definition
([#364](https://github.com/Dito-Core/dito/issues/364)).

## How a turn ends

> **A turn ends when the model stops: on its words, or on the structured
> output its definition declares.**

A definition with an `outputFormat` ends on the SDK's structured output: the
CLI holds the model to the schema, and the definition's `parse` is the owning
app's rule over a value the schema admitted — a value it refuses goes back to
the model as that call's error, so it answers again inside the budget it
already has, and a turn that ends without one `parse` accepts settles
`schema-miss`. A definition without one ends on its **words**, which a
`wordsRule` may hold to a rule the same way. Its disposition is read off
what happened — the words, the effects its tools reported and the reads that
refused at their projection — never off a sentence about it.

## The nine things

1. **Tool definition** (`tool.ts`) — name, description, input schema,
   handler and a mandatory **gate**. Three shapes gate an effect —
   `approve-before` · `disclosed-and-undoable-after` · **`rep-evidenced`**
   — and a read owes a `projection` instead
   ([ADR-0013](../../docs/adr/0013-closed-effect-taxonomy.md), all three
   amendments; the third shape is the 2026-09-04 one). A tool without a
   gate does not compile, and `defineTool` refuses one built dynamically.

   A `projection` tool declares the pinned column set it returns; its
   parameters select rows and never columns, tables or company, checked at
   construction by word, not by whole string, at every depth its schema
   declares. A schema must close every object it declares with
   `additionalProperties: false`, and both that closure and its `required`
   list are enforced at the tool boundary at run time — the SDK validates
   nothing, so without that they would only inform the model.

   A **`rep-evidenced`** tool writes twin-side state on a rep's behalf, so
   it "works only when it can cite the rep's own message": its declaration
   names, in `evidence`, the input parameter carrying that message's id, and
   a declaration whose schema does not declare that parameter — or does not
   list it under `required`, where the model could omit it — cannot be
   constructed. That is a **schema-shape check and never a database read**:
   whether the id that arrives *is* this execution's trigger is verified by
   the owning app inside the handler, against the trigger and the seam row
   behind it, because this package holds neither.

   An **effect** tool's handler returns an `EffectOutcome` rather than a
   string — performed, with the word the owning app records the act by and,
   where code owns a rep-facing sentence for it, the receipt code renders
   from the result; or refused, with what the model is told. One value
   serves all three readers, which is what makes a receipt unfakeable and
   `acted` structural (item 8). The **receipt is optional on both arms**,
   and the reasons differ: a refusal may leave the model to relay it, and
   an effect that puts its whole result in front of the reader already —
   the twin thread's `create_draft` posts the draft itself — owes no
   separate line beside it. `act` is what is never optional on a
   performance: `acted` rests on something having happened, never on a
   sentence about it.
2. **Wakes, lanes and recipe shapes** (`automation.ts`) — the words a
   definition is written in beside it: a **wake** is a trigger (a mechanism —
   `seam_event` or `request` — an occasion, and a metadata-only predicate
   *description* for a seam event); a **lane** is `realtime` or `batch`; a
   context recipe is named with the *shape* of its occasion-bound parameters;
   and a budget declares its iterations, tokens and effort. What the clock
   fires is a row of the rep side's `schedules` store that starts a run, and
   a run's steps execute on the `run_step` occasion (ADR-0014 as amended
   2026-10-07).
3. **The registries** (`registry.ts`) — tools by name with their gate and a
   factory binding this execution's dependencies; context recipes by name
   with their parameter shape and a factory binding the same dependencies,
   which is how a part renders content the occasion holds without any of it
   travelling as a parameter. Every part a written definition can reference
   is a *string* resolved against code this repository wrote, so the worst a
   confused one can do is name something that does not exist. **A registry
   is a value passed in, never a module-level global**: the two apps hold
   different ones, and a shared mutable registry would put every rep-side
   tool within the owner twin's reach.
4. **Execution definition** (`definition.ts`) — instructions assembled from
   named parts and **digest-stamped**, the tool list, the structured output it
   ends on when it declares one, the context inputs, the recipes that rendered
   them, a lane, and a budget of model, max iterations, max tokens and effort.
   The tool list rides with the instructions: no tool reaches an execution
   except by being written into its definition, where the digest sees it.
   `maxTokens` defaults to **16,000** (`DEFAULT_MAX_TOKENS`) when a budget
   omits it; the **model never defaults**, because ADR-0015 routes per rung
   at the app boundary.
5. **The `now` recipe** (`now.ts`) — today and this hour in the seat's zone,
   as English bracketed metadata, rendered by code and handed to every
   automation so no definition rediscovers the date (spec #171 decision
   8(3)). `now_owner` is a **sibling** adding one line, the day the FR-69
   window closes — a sibling and not a flag because its parameter shape
   differs, because the digest covers the recipe name so the diff is legible,
   and because the rep side then never carries a parameter it must remember
   to leave out. `renderTurnInstant` and `renderTurnHeader` **live here**, not
   on the rep side: `packages/twin-runtime/src/rep-clock.ts` re-exports them,
   because [#139](https://github.com/Dito-Core/dito/issues/139)'s founding
   complaint was two renderings of one instant that could disagree about a
   date, and a test proving two copies agree today is not the same claim as
   there being one. `finalizedThrough` is the single computation of the FR-69
   boundary, shared with the reads that refuse against it, so the day the
   model is told about is the day it would be refused against.
6. **Trigger** (`trigger.ts`) — the typed origin record that creates an
   execution. It carries its **occasion** (what the run is about) and its
   **mechanism** (how it came to be), which vary independently. `OCCASIONS`
   is a closed set; every occasion that creates an execution has a record
   type — `owner_question`, `chat_turn` (#172), `twin_thread_message` (#173),
   `entity_kind` (#176), `dashboard_act` (#224), `arrival` (#266, #320),
   `twin_thread_event` (#319) and `run_step` (#323: a step of a workflow run,
   which is how everything the clock fires reaches an execution).
   `extraction` and `daily_disclosure` are the words a request names in
   `runtime_requests`; what such a request starts is a run. A wake accepts
   the one mechanism it declares (`wakeAccepts`).

`defineExecution` and the runner share one `assertDefinition`, and the
runner also re-stamps: `ExecutionDefinition` is a plain structural
interface, so a definition can be spread, changed and run with its old
digest, and the record and the audit chain would then attest to something
that did not run.
7. **Runner** (`runner.ts`) — one function taking trigger, definition and
   an injected **harness** (`harness.ts`), running one Claude Agent SDK
   `query()` per execution inside the caller's process
   ([#328](https://github.com/Dito-Core/dito/issues/328); ADR-0014 as amended
   2026-09-27), and returning how the turn ended, never free text alone. It
   fails loudly with `ExecutionError`, which carries the record. **A turn ends
   when the model stops** ([#357](https://github.com/Dito-Core/dito/issues/357)):
   on the SDK's structured output when it declares an `outputFormat` — the
   CLI's own `StructuredOutput` tool, validated by the CLI and then by the
   definition's `parse`, a give-up or a refusal settling `schema-miss` — and
   otherwise on its **words**, the text of the round the model stopped on,
   streamed to `onWords` piece by piece as it is written. Its disposition is
   the definition's reading of its words and its effects. An effect that
   leaves the turn waiting ends it with the SDK's `claude/endTurn` result
   meta. The SDK's permission model is off and its own tools are absent
   (`tools: []`); the definition's tools are served by one in-process MCP
   server, every tool listed eagerly with
   its declared JSON schema, and every call goes through one wrapper — the
   input checked against the schema, a read's rows returned, an effect's
   `EffectOutcome` recorded and its `told` handed to the model, a thrown
   handler recorded as a tool failure. A pre-tool hook denies any tool off
   the definition's list. No session is persisted.

   **The session** (`session.ts`, [#319](https://github.com/Dito-Core/dito/issues/319))
   is the second shape, the one the twin thread runs a day in: one
   streaming-input `query()` fed by an inbox, its session written to one
   file under the harness directory (`sessionFile`), the child kept up
   between turns. Each wake is still one execution through the same wrapper
   (`turn.ts`: served tools, ladder, disposition, record, one entry), its
   tools answered by the running turn's own handlers. Which wakes a result
   answered is the child's own `user_message_uuids`: the earliest owns the
   execution and the rest are folded into it. A failed turn closes the child
   before another can start, and the next child forks without it
   (`resumeSessionAt` + `resumeDropsTurn` + `forkSession`); a refused cut
   resumes plainly and reports the evidence. A resume with `fork` forks the
   session whole into a new id (a workflow run's child), reported by `moved`. A child that dies between turns
   is resumed under the same id. `maxTurns` is per turn in a streaming session
   (measured), so it holds each execution's budget.
   The budget is handed over whole: `maxIterations` is the turn cap,
   `maxTokens` reaches the child as its per-call output cap, an `effort` is
   sent when the budget names one and none at all when it does not, and what
   the execution actually spent — summed across every model call, read off
   the child's stream — is on the record. There is no cumulative token
   ceiling; nothing accepted asks for one.

   **The harness** (`harness.ts`) is data, not a client: the directory the
   child lives in (one twin's alone — the rep side derives it beside the
   bundle, where FR-73 reports it as the recorded gap), the model key, and,
   in tests, the scripted model's endpoint. The child's environment is built
   here and never inherited: telemetry, error reporting, the autoupdater,
   nonessential traffic and compaction are off, and its home and config
   directory are inside the harness directory.

   **A per-call trace** (`trace.ts`, [#177](https://github.com/Dito-Core/dito/issues/177)
   hotfix 1). `runExecution` takes an optional `trace` callback and reports
   every round: the message with its stop reason, prose and usage; every tool
   call with its input and what it answered (`returned` · `performed` ·
   `refused` · `rejected` · `recorded`), a call to a tool off the list
   included; and the ending. Where the events go and how much of each one is
   printed are the caller's, and the trace is never the audit chain (item 9)
   and is durable nowhere.

   **The turn cap ends the loop.** A turn the cap stops before the model
   stopped, or one that ends without the structured output it declares, lands
   `failed` naming its budget; nothing asks it again.

   **One response's tool calls run one at a time** (`tool-queue.ts`,
   [#205](https://github.com/Dito-Core/dito/issues/205)). A response may ask
   for several tools, and whether they run in sequence is the harness's
   choice, not a promise — two handlers of one response in flight at once
   would both reach the one connection their execution's transaction is open
   on, where savepoints are a stack no two writers can share. `oneAtATime()`
   hands back a queue of one, taken **per run and never per module**: two
   executions on two connections must not wait on each other, two tool calls
   of one response must. The queue is pure, which is what lets it live in the
   package that holds no driver — each side of the wall wraps its own
   savepoint around it over its own store (`tool-savepoints.ts` on the rep
   side, `owner-twin/src/registries.ts` on the owner's).
8. **Execution record** (`record.ts`) — trigger, instructions digest, tool
   names, started/ended, iterations, tokens, a lane, and a disposition from
   the closed set `answered · wall-refused · schema-miss · no-action ·
   failed · drafted · acted · classified · filed · nothing-to-file · posted ·
   asked`, argued in that one place. Persisted by the owning app through the
   `ExecutionStore` interface this package defines and does not implement —
   and BOTH executions tables' CHECK constraints are proven to hold exactly
   these words by the migration-vocabulary sweep.
9. **Audit** (`audit.ts`) — exactly one content-free entry per execution
   ([ADR-0020](../../docs/adr/0020-hash-chained-audit-log.md)), written by
   the runner through an injected chain, because `@dito/audit`'s writer
   takes a `pg` client and this package holds none. The append happens
   before the runner returns or throws, and fail-closed: if the chain
   throws, the caller never receives the record, so nothing is persisted
   with no entry behind it. **The owning app appends and persists in one
   transaction** — the rule `chainApertureAct` already states for the
   aperture: the act and its audit link commit together or not at all.

   **WHICH chain is the owning app's decision, never this package's** (the
   decision on [#157](https://github.com/Dito-Core/dito/issues/157), 2026-09-03;
   ADR-0020 as amended). There are two — the rep side's `public.audit_chain`
   and the owner side's per-company `owner.audit_chain`, each under its own
   HMAC key — and nothing here knows that: the injected `ExecutionAuditChain`
   is one `append`, so the owner web hands it one implementation and slice 5's
   rep-side executions will hand it another. This is also why the dependency
   wall keeps `@dito/audit` off this package's value imports: an execution
   runtime that could reach a writer directly would be an execution runtime
   that had to choose a chain, and choosing a chain means holding a key.

## Where each disposition is assigned

| Disposition | Assigned by | When |
| --- | --- | --- |
| `failed` | the runner, and only the runner | the model call failed; a tool handler threw (the model is told and the loop carries on, so the runtime records it); the provider truncated a response; the turn cap stopped the turn; the turn ended without its structured output, or on words its rule refuses; `dispositionOf` threw or returned a word outside the closed set |
| `asked` | the runner, for a definition that `suspends` | an effect left the turn waiting on the rep's answer (`EffectOutcome.waitsOn`) |
| `schema-miss` | the runner, for a definition with an `outputFormat` | the CLI gave up on an output that matched its schema, or `parse` refused every one |
| every other word | the owning app, through `dispositionOf` | read off what the turn did — its typed result, its words, the effects its tools reported (`drafted`, `filed`, `nothing-to-file`, `posted`, `classified` and `acted` are effect tools' own act words) and the reads that refused |

`dispositionOf` returns `ReadDisposition`, which excludes `failed`: only the
runner's failure ladder decides that a turn has no outcome, and a definition
that reached it past a cast and returned it lands `failed`.

The set is closed and **argued in one place** (`DISPOSITIONS` in
`record.ts`), because the failed-query log (FR-48) is a disposition rather
than a page: the only way to ask "what did the Ledger fail to answer" is to
count these words, and a ninth invented at a call site makes that question
unanswerable in the quietest possible way. A store's CHECK constraint over
them is **widened and never narrowed** — a narrowing re-cut refuses a
disposition *after* the execution ran and *after* its entry is on an
append-only chain — and `migration-vocabulary.test.ts` is what makes that a
machine-checked rule rather than a note in a migration header.

## Outside this package, by name

- Durable runs, checkpoints, pg-boss and step boundaries — [ADR-0012](../../docs/adr/0012-one-async-machine-per-app.md)'s
  machine. An execution here is single-shot and in-process.
- **The clock, the runs engine and the automations' rows** — the rep side's
  `twin-runtime/src/runs/`: the `automations` and `schedules` stores, the
  preconditions a cadence names, the runs and their steps.
- **The two lanes' runtime.** `realtime` and `batch` are *declared* here and
  land on the record; the process that runs them concurrently over one open
  bundle is #172's (spec #171 decision 3).
- Sessions, the attention set and guidance folding. Each turn is its own
  execution; earlier turns arrive as context inputs, fetched fresh by the
  owning app, so *context never spans two executions* holds by construction.
- The routing ladder ([ADR-0015](../../docs/adr/0015-one-model-provider-zdr-routed-ladder.md)).
  The model is a budget field with no default here; the rung is the call
  site's choice.

## Testing

Unit tests only, in the hermetic lane. The model is the one scripted
boundary: `@dito/scripted-model` serves the Messages wire from a loopback
server while the real Agent SDK and the real Claude Code child run, and CI
never makes a real model call
([ADR-0028](../../docs/adr/0028-testing-evals-local-development.md) as
amended). `src/testing/chain.ts` is an in-memory audit chain — a boundary
fake for the injected interface, source-only and never built.
`dependency-wall.test.ts` sweeps this package's own source for a value
import of `pg`, the seam, the aperture, twin-runtime or any crypto beyond
`createHash`.

## Known limits, recorded rather than closed

- **Not a JSON-Schema validator.** Two properties of a tool call are
  checked, both the ones the projection rests on: what arrives was declared
  (at every depth the schema declares an object), and what was declared
  required arrived. Types, formats, enums, numeric bounds and the contents
  of arrays of objects are told to the model and enforced nowhere here. A
  tool's own handler, or a structured output's `parse`, is where a shape that
  matters is enforced.
- **The projection's name fence cannot be complete.** It catches the name a
  person writes without thinking — `columns`, `cols`, `tableName`,
  `companySlug` — and no list closes `proyección`. What holds whatever it
  misses is ADR-0013's other two legs: the database role plus row-level
  security fix what a read CAN return, and the pinned `columns` fix what it
  does. Making it structural — every parameter declaring which row-selector
  role it plays — would change the tool declaration's shape for both apps
  and is a decision for a spec, recorded on #128.
- **An audit append that fails takes the record with it.** The runner has no
  retry and no durable state (ADR-0012's machine is outside this package),
  so a chain that rejects propagates its own error and the caller receives
  nothing to persist. That is fail-closed for coverage — a record with no
  entry is the defect the coverage check exists to find — and it is why the
  owning app appends and persists in one transaction.
- **A tool that fails does not stop the loop.** The failure is recorded and
  the execution lands `failed`, but the model is handed the failure as a
  tool result and may call the tool again. Every tool this slice
  runs is a read; an effect tool arrives with slice 5, and ADR-0013 already
  makes one safe to call twice by construction.

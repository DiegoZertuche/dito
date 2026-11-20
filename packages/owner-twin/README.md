# @dito/owner-twin

The owner twin, as a library — **the first execution this product has**
([ADR-0014](../../docs/adr/0014-runtime-harness-tool-runner.md) as amended;
spec [#126](https://github.com/Dito-Core/dito/issues/126) decisions 5–8 and
16–18; ticket [#130](https://github.com/Dito-Core/dito/issues/130)).

A trigger — the owner asked something — creates an execution with its own
instructions, its own three tools and its own context. The agent inside
answers from what those tools returned, refuses what the wall keeps out,
asks which record was meant, or says the Ledger holds nothing of that kind.
The runtime under it is [`@dito/execution`](../execution/README.md), which
this package consumes and does not reimplement.

Since [#363](https://github.com/Dito-Core/dito/issues/363) its definition is
**the execution package's own** — one agent turn built with
`defineExecution`, ending when the model stops on the SDK's structured output
(the typed answer), with no submission tool. Every rep-side conversation is a
one-step definition run through the twin runtime's engine; that engine is
rep-side and never crosses the wall
([ADR-0002](../../docs/adr/0002-wall-is-a-deployment-and-credential-boundary.md)),
so the owner twin builds its definition from the package directly.

It holds **no connection, no credential and no Ledger SQL**: the tools wrap
`@dito/aperture`'s five owner reads with a `pg.ClientBase` the app
authenticated as `dito_owner`. `apps/owner-web/src/owner-twin.ts` is the process that
holds the credentials.

## The pieces

| Module | What it is |
| --- | --- |
| `tools.ts` | The three projection tools: `resolve_entity`, `read_timeline`, `count_facts`. |
| `served.ts` | The served map — every row any tool returned this run, by reference. |
| `instructions.ts` | What the twin is told, in parts, digest-stamped by the runtime. |
| `answer.ts` | The typed answer: its schema, its `parse` (the guard runs inside it) and its disposition. |
| `guard.ts` | The structural guard — the deterministic half of FR-71b. |
| `prose.ts` | The two text rules the package shares: the slot grammar, and the fold. |
| `automation.ts` | The fixed halves: the wake, the lane, the iteration count and the `now_owner` recipe call. |
| `turn-tools.ts` | The three reads bound to one turn, each savepointed, all three sharing this turn's one-at-a-time queue. |
| `definition.ts` | This turn's definition, from `defineExecution`: the instructions, the bound reads, the typed answer bound to this run's served map, and the context. |
| `render.ts` | The rendered turn the room draws. |
| `store.ts` | The `owner` schema — the conversation, the record, and the owner chain — written as `dito_owner`. |
| `turn.ts` | One turn, end to end, in one transaction. |
| `history.ts` | The scroll: every stored answer, re-rendered from the Ledger (#131). |

## The decisions this package had to make

**A reference is two things, and they are not the same number.** The **wire
reference** the model cites is a run-scoped small integer: a model cites `3`
reliably and a UUID unreliably, and a run-scoped number cannot be forged
from a previous answer, since the owner's earlier turns are handed in as
context. The **persisted reference** in `owner.answers.refs` is the row's own
id, so a stored answer re-renders from the Ledger by id rather than from
stored markup. The served map is what translates one into the other, and the
refusal — "this run never served that" — is checked on the wire reference,
before any translation. #129's `OwnerFact.id` doc comment calls the fact's
own id "the stable reference … never an index into a result", and that stays
true of the layer it describes.

**A count is referenced like any other row.** `count_facts` returns
`[ref] a count of <type>: it found something` and *never the number*. The
model cites the reference where the number belongs and code renders it from
the served row — so ADR-0037's "the model never types a number" is true by
construction rather than by refusal, and the guard's digit rule is the
second fence rather than the only one. A count's receipt line carries its
window and the statement that the window is closed, because a count has no
single confidence (#134).

**The definition carries no model of its own and no output cap.** ADR-0015 routes the owner
twin to Sonnet 5 and that is the *deployment's* decision — a rung written
into a shipped constant would be a routing decision made in the one place
nobody looks — so `apps/owner-web` names it and `resolveBudget` binds it. The
cap is omitted for the opposite reason: 16,000 is the runtime's default
(`DEFAULT_MAX_TOKENS`), inherited rather than rediscovered here, which is
what user story 39 asks for. `OWNER_TWIN_MAX_ITERATIONS` stays, because six
is a statement about *this* execution's shape of work.

**The `now` part is the owner variant, and its lag is not a number here.**
`now_owner` renders the turn header plus the day the FR-69 window closes,
and the lag travels as a bound parameter from `OWNER_LAG_HOURS` — the same
constant `read_timeline` and `count_facts` refuse a recent window against.
One number, two readers: the day the twin is *told* the record is complete
through is the day a read would be *refused* against, and a sentence that
disagreed with the refusal would be worse than no sentence, because the model
would anchor where it was told it could and be refused with no way to see
why.

**A read's declared half is split from its handler.** `OWNER_TOOL_DECLARATIONS`
holds the four fields the model is told — name, gate, description, pinned
columns — and closes over nothing, so «your tools» can be rendered without a
turn, and the digest sees exactly what the model is handed.

**The disposition is read from what happened, never from the answer's
kind** (CONTEXT.md, *Disposition*). `wall-refused` is a read tool refusing a
call at its projection's fence (a parameter naming a column, a table or a
company); `asked` is a typed result that leaves the owner a choice to make
(an ask with its candidates); every other well-formed result is `answered`;
`schema-miss` is
the runtime's word for a typed result it could not accept, which leaves no
answer row; `failed` is a turn that broke or ran out. The kinds — `answer`,
`refusal`, `ask`, `unrecorded` — are what the owner reads, and FR-48's log is
the stored answers of kind `unrecorded`.

**A slot fills with the row's whole rendered line.** A fact reference in
prose renders as `renderOwnerFactLine`'s composition — the one rendering of
a payload this repo has, and the same one the model was shown in the tool
result, so an answer's words and its values describe the same thing. Picking
one field out of a payload would mean deciding here which of a quote's five
fields the sentence meant, which the answer does not carry. #131 may
want that finer grain for its violet-and-coral value spans; it is recorded
as owed rather than guessed at.

**The `owner` tables are under RLS, keyed to the connection's declared
company — and `dito_owner` does not own them.** A relation's owner may
`ALTER TABLE … DISABLE ROW LEVEL SECURITY`, and `FORCE` makes an owner
*subject* to its policies rather than unable to remove them, so a login that
owned the tables its own policies bind was one statement away from unbinding
them. `dito_owner_state` — NOLOGIN, NOBYPASSRLS — owns the schema and its
four tables; `dito_owner` holds USAGE on the schema and SELECT and INSERT
on the tables, which is the whole of what the app does with its own state.
The grants are TABLE-level, which is why #178's `lane` column needed no new
GRANT and FR-71a's `OWNER_TABLE_COLUMNS` pin needed the one line that stops a
column nobody wrote down from becoming owner-readable through ownership.
There is a `SELECT` and an `INSERT` policy and deliberately no `UPDATE` or
`DELETE` one, because the owner app appends its conversation and does not
edit it. Diego's ruling on #130, 2026-09-02.
FR-73's store count is unchanged: it enumerates rep-side stores and the
`owner` schema is owner-side (spec #126, Testing Decisions;
`fr73-shared-stores.ts` already says so).

**The execution's audit entry goes on the owner's OWN chain, under the
owner's own key** — `owner.audit_chain`, the fourth table above, one chain per
company by forced RLS, keyed by `DITO_OWNER_AUDIT_HMAC_KEY`
([ADR-0020](../../docs/adr/0020-hash-chained-audit-log.md) as amended
2026-09-03; the decision on
[#157](https://github.com/Dito-Core/dito/issues/157)). It appended to
`public.audit_chain` between #130 and #165, under the key every rep-side
process holds; that grant is revoked. The reason is what the grant let the
owner **read**, not what it let it write: the shared chain is a same-company
rep-activity record — every `customer_send` with its outcome and its
timestamp, every refusal, and the `twin:<id>` refs the seats view withholds —
which [ADR-0025](../../docs/adr/0025-telemetry-content-free-wall-respecting.md)
forbids deriving owner-side. `dito_owner` now holds **no privilege of any kind
on any `public` table**, and FR-71a goes red on any grant that would give it
one. `ownerExecutionChain` takes the declared company, so the advisory lock
and the tail read are both keyed to it; `@dito/execution` takes the chain as
an injected seam and never learns there are two — **which chain an execution
appends to is the owning app's decision, never the runtime's.**

**`unrecorded` is decided against `FACT_TYPES`**, the six the aperture
files, and not against the database's CHECK. The instructions name them, and
both tools that take a `fact_type` validate against the same list in their
handlers, since the SDK validates no enum.

**Earlier turns are context, never evidence.** They are fetched fresh each
turn and rendered by code with every slot replaced by a neutral marker: a
reference belonged to the run that served it, and citing `2` today would
resolve against *this* run's map — a citation that looks grounded and is
not. A turn that failed is shown as one, so a follow-up is readable.

**The seat resolution is a fifth owner read, and it lives in the
aperture.** Spec decision 16 gives the count tool a seat parameter and user
story 7 is the sentence behind it, but no owner-side read turned a rep's
name into a seat id. `resolveOwnerSeatByName` is that read, and it sits
beside the other four in `packages/aperture/src/owner-reads.ts` — because
the orchestrator's sequencing note on #130 says the owner's read SQL lives
there, and because two implementations of what the owner may read are two
things that can disagree. It was a sibling in this package while #130 was
stacked on #129's open branch; #129 merged, and it moved.

## What the structural guard refuses

Spec #126 decision 8 names four cases and each one is a test in
`guard.test.ts` and again over the wire in `turn.int.test.ts`. In full, the
guard refuses an answer that:

- cites a reference no tool served this run (in `references`, in a prose
  slot, in `candidates`, in `timeline_ref` or in `count_ref`);
- fills a slot whose reference the answer does not list;
- types a digit — a number, a year, a count, a formatted phone number;
- types a calendar day, derived from `Intl` rather than listed;
- types a provenance line — a fact-type tag, a source-type label, the
  confidence word, the not-recorded seat, all derived from
  `@dito/aperture`'s renderers;
- types a name the tools resolved, customer or seat, as rendered;
- names a chat address, which no owner-visible row carries at all;
- **answers having called no tool at all** — the realistic shape of
  inventing, since inventing means not reading, and the one case that
  produces no digit, no served name and no rendered token for any other
  rule to catch (`qa.ts`: "search_memory before answering, so the answer
  rests on the rep's real history");
- answers while citing nothing when the tools DID serve rows — it answered
  from something that was not in what it read. The one honest empty answer
  survives both: a turn that read and found nothing has nothing to cite;
- asks with fewer than two candidates, or with a candidate that is not a
  record (ADR-0039);
- points a refusal at a fact rather than at a timeline;
- names a `count_ref` that is not a count, or one the receipt would not
  carry.

**A violation is feedback; a turn with no accepted answer renders nothing.**
The guard runs inside the typed answer's `parse`, and `@dito/execution` reads
each answer through it as the model gives it: one it refuses goes back to the
model as that call's error, and the model answers again inside the same
budget (#133: with a real model the first answer typed the customer's name,
the guard refused it as ADR-0037 asks, and the corrected answer is the one
that renders). A turn whose answers the CLI gives up on settles `schema-miss`
with no answer row; one the turn cap stops first is `failed`. Either way the
last refusal is the failure the room is handed, and nothing refused ever
renders.

## What is outside this package

- **The room.** #131 draws the rendered turn: the receipt strip's labels,
  the pills' words, the day dividers, the value spans' colours. This package
  returns the structure under them and holds no es-MX string at all —
  `composed-language.test.ts` sweeps the whole of `src` with no allowlist.
  `history.ts` is in the package rather than in the app for that reason and
  one more: it rebuilds a stored answer row into the answer it was and hands
  it to `renderOwnerTurn`, so the scroll and the live turn are one rendering
  and cannot disagree.
- **The adversarial refusal corpus** (FR-71b's other half) — deferred to the
  pilot gate by ADR-0028 as amended.
- **A live model call.** CI never makes one; the model is the scripted
  loopback server, and the real Agent SDK and its Claude Code child run.

---
status: accepted
date: 2026-08-29
decided-via: the schema session (gate before the Ledger crossing; agenda on Dito-Core/dito#6)
satisfies: FR-35 (*"event payloads are minimal and additively evolvable; a versioning strategy is fixed before scale"*)
---

# Fact payloads are stamped and additive-only; the seam's refusal does not apply to them

Every fact row carries a `payload_version` integer. Since `fact_type` is already on the row and is a closed set, **`(fact_type, payload_version)` identifies the payload shape** — per-type evolution, so a change to `QuoteGiven` never forces churn on unrelated types. Evolution is **additive-only**: new fields are optional, old readers ignore what they do not know, and new readers treat an absent field as *not recorded then*, never as a default value — a missing currency on a 2026 quote is unknown, not USD, and conflating those is how a bi-temporal store starts lying. A change that additive evolution cannot express — a rename, or a field whose meaning shifts — requires a read-time **upcaster** and its own ADR; making it cost a decision is what keeps it from becoming routine.

**The seam's versioning is deliberately not copied.** The `wa_events` payload carries `v:1` and refuses on any mismatch — *"a newer plane means upgrading the runtime, never guessing at content"* — which is right there, because the seam is a transport contract between two processes deployed together and a mismatch means half the system shipped. A fact payload is not transport: it is stored data in an append-only, bi-temporal store, and it must stay readable forever. Refusing to read a fact filed three years ago is not a loud failure, it is data loss. The escape hatch the bundle relies on is also unavailable here — ADR-0029's forward-only migration at open cannot apply, because append-only forbids rewriting stored facts at all.

**Disclosure lines are stored as rendered text, not as a template reference,** and carry no version. A disclosure line is what a rep was told had crossed; re-rendering it later from a changed template would retroactively rewrite that statement, which defeats the purpose of disclosing.

Chosen so the Ledger can be read for as long as it is kept, without either mutating history or accumulating a migration debt it is structurally forbidden to pay.

---
status: accepted
date: 2026-08-26
source: AD-28, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
amended: 2026-09-02 — model-invoking evals run on demand, not in CI; the FR-71b adversarial suite arrives with the pilot gate (slice 4, Dito-Core/dito#112 · spec #126)
---

# Testing, evals, and local development

Vitest for all TS packages/apps; `go test` for the plane. Integration tests run against **real Postgres and real encrypted bundle fixtures** (a checked-in fixture generator produces DEK-encrypted bundles from seed transcripts). AWS dependencies in local dev: **real KMS/S3 in a dev account — no emulation of the crypto path; the erasure story is never mocked**; everything else local. The eval harness is a named component (`packages/evals`): golden corpora for the refusal suite (FR-71b), extraction-precision fixtures (labeled seed transcripts pre-pilot; the disclosure loop takes over at pilot), draft-quality/voice spot suites, and prompt-regression runs on any ladder or model change — release-blocking alongside the four wall audits. CI runs: unit + integration + invariant audits (FR-70–73) + evals.

Chosen so two epic teams can't invent incompatible test substrates in week one, and LLM behavior never ships unevaluated.

**Amendment 2026-09-02 (model-invoking evals run on demand; the FR-71b suite waits for the pilot gate).** Decided at the slice-4 grilling ([#112](https://github.com/Dito-Core/dito/issues/112), spec [#126](https://github.com/Dito-Core/dito/issues/126)), recording practice that had already diverged from the text above. **CI never makes a real model call**: the wire is scripted, the real SDK and Tool Runner run in-process. **Evals that call the model** (`eval:extraction`, `eval:probe`, and their successors) **run on demand**, by the agent working a ticket when the contract the eval measures changes — before and after, with both reports committed, as [#59](https://github.com/Dito-Core/dito/issues/59) did — and at slice boundaries; they are an instrument, not a test, and are not release-blocking in CI. **The FR-71b adversarial refusal suite is not built in slice 4**: its structural half ships in CI (a scripted model that types provenance, cites an unserved row or invents conversation content, and is refused by the surface), and the adversarial corpus with its live run is owed at gate 9, where FR-71b's own wording — "run before pilot and on every release" — places it. Recorded on [the horizon](https://github.com/Dito-Core/dito/issues/117) under Pilot readiness.

Why: at this stage of the product no manual test and no test that invokes a model gates a merge; the wall does not depend on model behaviour once a read owes a projection ([ADR-0013](0013-closed-effect-taxonomy.md) as amended), and what the live suite would catch — fabrication, folding to social engineering — is a trust failure to measure before real owners, not a leak.

---
status: accepted
date: 2026-08-26
source: AD-27, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Seat lifecycle and identity: one executor, one registry

Seat lifecycle has exactly one executor: a rep-side seat-lifecycle service — the **sole writer of `seat.status`**, owner of the pinned transition table (owner intent always enters via `closing`, never directly to `retired`), the ~72h clock, question-voiding triggers, and the **sole caller of `DisableKey`/`ScheduleKeyDeletion`** (ADR-0009). Owner-side writes intent rows only (`end_seat` requests); the plane emits signals only. **The global identity registry** is the one sanctioned non-company-scoped table (ADR-0002 exception): phone identity keyed by HMAC with a KMS-held pepper (compute-gated, not offline-enumerable) + tenure windows — serving the cross-company uniqueness check (FR-66) and re-link rules (FR-67); readable/writable only by this service, never granted to either app's general DB user.

Chosen so seat state has one writer, someone is always assigned to call DisableKey, and phone identity can't be enumerated offline.

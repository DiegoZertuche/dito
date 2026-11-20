---
status: accepted
date: 2026-08-26
source: AD-9, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
amended: 2026-08-26 — two-stage erasure confirmation (epics elicitation; snapshot Dito-Core/dito#13, Story 7.4)
---

# Erasure is KMS key destruction, executed by one service

Seat end → link severed, lease released, sessions end, the seat-state gate halts automations and runs. The twin key stays active through the ~72h closing window **solely** to honor residue guarantees and question/journal ciphertext — the closing-window dashboard is aperture-served only. Closing-window end → `DisableKey` → `ScheduleKeyDeletion` (7-day mandatory waiting period), called solely by the seat-lifecycle service (ADR-0027). Erasure confirmation is **two-stage**, because `ScheduleKeyDeletion` schedules — it does not destroy, and deletion remains cancelable until the waiting period ends. Stage one, at the ceremony: the CloudTrail-verified `DisableKey` event is the *access ended* timestamp — cryptographic unusability of everything under the twin's envelope from that moment — and the FR-54 record carries it together with the scheduled destruction date. Stage two, at the waiting period's end: the pipeline verifies completed destruction via the CloudTrail deletion event and the KMS API, and only then records *irreversibly destroyed (AWS-enforced)* as final closure — that claim is never made at scheduling time. No self-reported success at either stage; the FR-73 drill covers both stages. Survives erasure, **by name and nothing else**: the seat row (status history via the pinned view), the identity-registry entry, the content-free audit chain (its DEK-encrypted evidence blobs die with the key), the aperture's disclosure journal (already-crossed content only), and Ledger facts. FR-73's audit proves the bundle + DEK-encrypted blobs are the only rep-content stores.

Chosen because erasure as an unverifiable promise is worthless; disablement and destruction each behind their own CloudTrail-gated confirmation, plus a closed survivor list, make it provable — and the two-stage split keeps the ceremony honest about what AWS has actually done at that moment.

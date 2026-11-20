---
status: accepted
date: 2026-08-26
source: AD-26, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Wrongly-crossed facts: expungement with a tombstone

A rep-flagged *shouldn't-have-crossed* fact (sev-1) is **expunged**: content physically replaced by a tombstone, gone from all owner views and exports, audit-chained without the content. Expungement is the only exception to append-only, exists solely for aperture breaches, and is **never owner-invoked**. The closing window's final disclosure is the named last rep flagging opportunity; after departure, an operator-invoked expungement path remains (Dito- or departed-rep-initiated, audit-chained) so the remedy survives retirement. Residue ages out of PITR backups within the 35-day retention window — a bounded, stated tail.

Chosen because the alternative — a trust breach whose only remedy leaves the content owner-readable forever, precisely when the injured party has left — is unacceptable.

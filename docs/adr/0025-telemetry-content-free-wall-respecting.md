---
status: accepted
date: 2026-08-26
source: AD-25, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Telemetry and metering: content-free, wall-respecting

A rep-side product-telemetry store, content-free by construction (counts, rates, timings, per-seat token/cost metering), records activation metrics, COGS actuals, and SLO signals (CloudWatch alarms page per ADR-0005). **No owner-facing read path exists to it**, and no owner-visible usage signal may be derived from any rep activity — company-source reads included (ADR-0024). The failed-query log is owner-side data in the owner app. A metrics export for owners is a wall change, not a feature.

Chosen so the COGS falsifier has data without product analytics becoming rep-behavior analytics.

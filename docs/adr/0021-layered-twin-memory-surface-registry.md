---
status: accepted
date: 2026-08-26
source: AD-21, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Layered twin memory with a conflict ladder; versioned surface registry

Twin memory layers with explicit precedence — standing instructions > explicit rep statements > high-confidence learned > episodic — with dedupe/tombstoning and per-layer context budgets. The surface registry lives in the primitives library as versioned data (ADR-0012 versioning rules), consulted at proposal-render time to gate affordances per the UX matrix. **Session resume is one affordance projected per surface** (dashboard Resume card + La mesa; WA recap); each surface exposes exactly one unpinned input, routed by classification over the attention set only (open + recently-settled sessions — never history); settled sessions stay visible within a bounded recency horizon (~7d), then dissolve.

Chosen so contradictory memory resolves the same way everywhere, standing instructions never lose to learned behavior, and no surface offers an affordance it can't honor.

---
status: accepted
date: 2026-08-26
source: AD-29, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Schema evolution: stamped bundles, one migration tool

Every bundle carries a `schema_version`; bundle migrations run at bundle-open by the lease holder, before any read, forward-only; a replica restored mid-migration re-runs the migration (idempotent by construction); replication ships post-migration state. Shared Postgres migrates via one named tool — Atlas (a seed pick, version pinned at init) — with **RLS policies and view definitions versioned as migration artifacts**, so the FR-71(a) diff runs against migration output and a policy change is visible in review before it is live.

Chosen so N encrypted bundles can never diverge into schemas nobody can migrate, and RLS policies can't drift from the schema they guard.

**Amendment 2026-08-29 (library-owned stores).** "One named migration tool" governs the **application schema**. A third-party library that ships and versions its own tables may manage its own schema, provided all three hold: it lives in a **separate Postgres schema** the named tool never sees; it holds **no wall-relevant objects** — no RLS policies, no views, no twin or Ledger data, only that library's own operational state; and it is **reconstructible from scratch**, so losing it costs a rebuild rather than data. The governed surface is unchanged: the FR-71(a) diff still runs against the named tool's migration output, because everything it inspects lives in the application schema.

Raised at slice 1 (Dito-Core/dito#21): whatsmeow ships its own migrations for the WhatsApp session store — device identity, socket keys, retry buffers — which cannot be hand-managed without forking the library. It was placed in a dedicated `whatsmeow` schema with Atlas scoped to `public`. Adjudicated intent-not-letter at the slice-2 boundary, with live evidence: during the #36 rig session the entire `whatsmeow` schema was dropped and the plane rebuilt it on the next start, no application data involved — a store that can be deleted and self-restores is not what migration governance exists to protect.

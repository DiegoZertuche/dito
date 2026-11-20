---
status: accepted
date: 2026-08-26
source: AD-18, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
open-clause: replication mechanism → Dito-Core/dito#7
amended: 2026-09-27 — the unit of scale is the per-twin unit; migration is a suspend, a graft of the volume and a wake; encrypted snapshots to object storage under the twin's key carry durability; still recovery-only (agent architecture, Dito-Core/dito#293)
---

# Fleet scaling by lease; replication-gated pruning; recovery-only

The twin is the unit of scale. Bundles-of-record live on the owning box; migration = final sync + lease flip; failure = lease expiry + restore from replica. **`wa_events` rows are pruned only after bundle replication confirms the covering transaction.** Replication and migration are operator recovery machinery only: no user-facing twin-state export, snapshot, or import surface exists (portability dead by doctrine); owner exports are Ledger-fact-scoped through the ADR-0002 views. Verticalize before sharding; the Go plane scales on its own axis, sessions pinned by the same lease pattern.

Chosen so the first scale event is a rebalancing, not a re-architecture, and the recovery machinery can never quietly become a portability feature.

**Open clause** (split at triage): the replication *mechanism* — the spine proposes in-process snapshot + raw WAL-byte shipping by the lease holder (RPO ≤ 60s; Litestream ruled out, SQLCipher-incompatible), which is hand-rolled infrastructure with a silent failure mode. It is prototype-gated before any slice depends on it, tracked as [Bundle replication mechanism](https://github.com/Dito-Core/dito/issues/7). Held fixed regardless of outcome: ADR-0007/0008 storage and custody invariants — no key-holding replication sidecar.

**Amendment 2026-09-27 (scaling by unit).** *The twin is the unit of scale* is truer than written: a twin's compute is a unit of its own ([ADR-0001](0001-three-planes-twin-is-a-logical-entity.md) as amended), and a box holds units, not bundles-of-record. **Migration** is a suspend, a graft of the twin's volume onto another unit and a wake. **Failure** is a unit that does not wake, answered by a new unit over the last snapshot. Durability is not the volume's: the in-process replication above and **encrypted snapshots of the volume to object storage under the twin's key** carry it, and the FR-73 sweep catches any copy outside the key. The open clause stands, and [#7](https://github.com/Dito-Core/dito/issues/7) now asks its question of the volume: the mechanism that ships the bundle's bytes off the unit at RPO ≤ 60 s. Nothing here becomes portability: a snapshot is ciphertext under a key the rep cannot export, and no export surface exists.

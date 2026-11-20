---
status: accepted
date: 2026-08-26
source: AD-4, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
amended: 2026-09-02 — the filing seat joins owner-visible provenance; chat identity still never crosses (slice 4, Dito-Core/dito#112 · spec #126)
---

# Push-only crossing; the Ledger is addressed, never traversed

Facts cross at filing time, land provisional in the Ledger store outside per-twin encryption, and self-finalize after 24h — but the clock starts only once the fact's disclosure line is rep-reachable, and suspends while the seat is `enforcement-paused`. No provisional-existence signal crosses; recency questions get the standing by-design-delay statement. Ledger access is only via scoped query tools (entity-resolve → timeline read, grant-filtered projections, small result sets) — never bulk-loaded into model context. **Chat↔entity bindings are rep-side only** (the bundle's entity mirror); no shared binding table exists, and owner-visible provenance is timestamp + confidence + source type — never chat identity. A rep ask outside the grant set gets the boundary statement whether or not the entity exists.

Chosen because owner-side pull credentials would breach the wall, facts must not die with the twin key, and owner joins must never recover chat identity.

**Amendment 2026-09-02 (the filing seat joins owner-visible provenance).** Decided at the slice-4 grilling ([#112](https://github.com/Dito-Core/dito/issues/112), spec [#126](https://github.com/Dito-Core/dito/issues/126)). Owner-visible provenance is now **timestamp + confidence + source type + the seat the fact was filed under** — rendered as the rep's display name through the owner's seats view. The seat, not the twin: twins are erased at retirement, seats persist as retired, and attribution must outlive the key. *Never chat identity* is unchanged and is now stated in full: which chat, which number, which group, and what was said stay behind the wall, and no owner-granted object can join a fact to any of them. Correction and annotation authorship remain per-fact-on-request (FR-47) and are not owner-visible in bulk.

Why: FR-45 and UJ-4.4 name rep-attributed aggregations of business facts as answerable («¿cuántas cotizaciones dio Mauricio esta semana?»), and the slice-3 view had read "never chat identity" as "never rep identity", leaving the owner twin unable to answer the PRD's own example. Grants already tell the owner which rep works which cliente, so per-fact anonymity protected nothing; what the wall exists to keep out — conversation content and conversation-derived behaviour (FR-37, FR-45) — stays out. Adding an owner-visible column is a spine change under [ADR-0002](0002-wall-is-a-deployment-and-credential-boundary.md); this amendment is that change, and the column list is pinned in code and diffed by FR-71a.

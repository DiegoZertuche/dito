---
status: accepted
date: 2026-08-26
source: AD-24, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Company knowledge store: the inbound crossing, indexed rep-side

Company-shared knowledge (SOPs, price lists, catalogs) lives in a shared, company-owned, plaintext store (RLS by company): the owner app writes, rep twins read. Sources are versioned and line/chunk-anchored; citations pin (source, version, line). The chunk+embedding index is built and owned **rep-side** (async ingestion from the shared store); every vector row carries the embedding-model version; mixed-version query sets are illegal. Owner-twin retrieval over sources goes through the same rep-side indexer serving query-time embeddings as a content-free-credential service. **No owner-visible access or usage signal exists on company sources** — reads are direct RLS'd reads, unlogged owner-side (no-cop, ADR-0025).

Chosen so owner-side never needs a rep-side write path and two embedding stacks can't drift. **Named at triage as a sanctioned exception:** the owner-twin → rep-side-indexer call is the *one* owner-side dependency on a rep-side service across the wall — it carries no rep content and no rep-store credential, and its being named here is what keeps it from normalizing others.

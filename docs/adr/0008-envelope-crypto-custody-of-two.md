---
status: accepted
date: 2026-08-26
source: AD-8, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
---

# Envelope crypto: DEK at the socket, custody exactly two processes

One AWS KMS key per twin wraps that twin's DEK. Rep content is DEK-encrypted from the moment it passes the capture guard at the socket. Plaintext DEKs exist in exactly two processes: the twin's lease holder and the Go plane's live session — **this list never grows**; non-plane adapters obey the pull-on-wake rule (ADR-0012) instead of holding keys. Everything at rest is DEK-encrypted: bundle, artifact/media blobs, seam payloads, aperture question blobs, bundle replicas in S3.

Chosen so rep plaintext never rests in any shared store and no adapter can invent a third custody point.

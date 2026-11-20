---
status: accepted
date: 2026-08-26
source: AD-11, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
amended: 2026-09-27 — the workspace is a directory on the twin's volume worked with the harness's file tools; a version is a snapshot of the directory at a step boundary; citations pin (snapshot, path, anchor); decided, not built (agent architecture, Dito-Core/dito#293)
---

# Workspace artifacts: immutable versions, version-pinned citations

An artifact = bundle metadata + content-addressed DEK-encrypted blobs; versions are immutable rows; rollback is a new version pointing at old content. Every receipt-strip citation pins (source, version, anchor) — workspace artifacts, company sources, and chat quotes alike; forgotten chat sources degrade per ADR-0007. File attach records an explicit copy-vs-link choice. Workflow working documents ARE draft-status artifacts from their first write. Artifact tools expose filesystem-grade ergonomics — ranged/section reads and string-replace patches (the Anthropic text-editor command grammar) — with a step's patches compacted into one immutable version at the step boundary, so the model neither reloads nor re-emits whole documents to iterate.

Chosen so provenance can never silently change when a source updates, and no parallel scratch-file store emerges.

**Amendment 2026-09-27 (the workspace is a directory; the file tools are the artifact tools).** The artifact tools above — ranged reads, string-replace patches, a step's patches compacted into one immutable version at the step boundary — are the Agent SDK's own **Read, Glob, Grep, Write and Edit** ([ADR-0014](0014-runtime-harness-tool-runner.md) as amended), allowed inside the unit on one directory: **the twin's workspace on the encrypted volume** ([ADR-0007](0007-per-twin-encrypted-bundle.md) as amended). The rule does not change: **a version is a snapshot of the directory taken by the runtime at a step boundary**, immutable, with its row in the bundle; rollback is a new version pointing at an old snapshot; a citation pins (snapshot, path, anchor). Write and Edit carry the *disclosed-and-undoable-after* gate through that snapshot ([ADR-0013](0013-closed-effect-taxonomy.md) as amended), which is why a model may hold them. A `write_workspace` tool is not built; this replaces it. A workflow's working documents are draft-status items from their first write, as above. Decided, not built.

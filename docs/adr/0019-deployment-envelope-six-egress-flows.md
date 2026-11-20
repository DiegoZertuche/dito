---
status: accepted
date: 2026-08-26
source: AD-19, Architecture Spine (architecture-Dito-2026-08-25) — `_bmad-output/planning-artifacts/architecture/architecture-Dito-2026-08-25/ARCHITECTURE-SPINE.md`
adopted-via: AD triage (Dito-Core/dito#2)
amended: 2026-09-20 — a sixth egress flow: browser push services, content class the twin's post parts to the rep's own devices (slice 6b, Dito-Core/dito#215 · spec #258)
---

# Deployment envelope: AWS mx-central-1; six named egress flows, network-enforced

Everything runs in AWS mx-central-1: EC2 (planes), RDS Postgres (multi-AZ, PITR — Ledger RPO ≈ 5 min; cross-region DR deferred, residency tension named), S3, KMS, SES, Fargate (future). Components are portable OSS on AWS primitives; KMS is the one deliberate deep dependency. **Exactly five egress flows exist, each with a named content class**: (1) the WhatsApp linked-device rail — the product; (2) the Anthropic API — rep/owner content under ZDR; (3) user-connected MCP integrations — the user's own disclosure, per app; (4) email (SES) — magic links, grave events, departure records: Ledger-derived and status content, never conversation content; (5) Stripe — company billing data only. **Enforced at the network layer**: VPC egress allowlists pin the named destinations per credential domain; a new destination fails closed and is a spine change.

Chosen so data residency can't erode by convenience and "spine change required" is a mechanism, not a process.


**The filename is deliberately stale, and stays that way.** This file remains `0019-deployment-envelope-six-egress-flows.md` while the ADR itself names five flows. It is not renamed because issues, pull requests and sibling ADRs already link this path, and a moved file leaves no redirect behind — renaming would break every inbound reference to buy cosmetic agreement between a slug and a heading. **The ADR number is the identifier; the slug is not.** Read the heading for the current count, and expect the same treatment if a later amendment changes it again.

**Amendment 2026-09-20 (the sixth flow).** Six flows again ([#215](https://github.com/Dito-Core/dito/issues/215); spec [#258](https://github.com/Dito-Core/dito/issues/258) decision 7). **(6) Browser push services** — the endpoints Google, Apple and Mozilla run for web push — reached only by notify's push transport with its VAPID identity ([ADR-0022](0022-system-outbound-rails-closed-notify-catalog.md)). **Content class: the twin's post parts to the rep's own devices** — a knock or a nudge composed in an execution and carried from a sealed post row, plus the deep link into the dashboard — encrypted end to end to the browser's subscription per the web push standard, so the push service carries bytes it cannot read; never conversation content, never anything owner-side, never email's status content. Network-enforced like the other five: the VPC egress allowlist gains the push services' hosts for notify's credential domain and nothing else, and a new host fails closed. The heading's count and the slug agree again by accident; the rule stands — the number is the identifier, the slug is not.

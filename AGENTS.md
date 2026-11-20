# Dito — how agents work in this repository

Read `CONTEXT.md` first: its glossary is the ubiquitous language, and every
decision lives in `docs/adr/`. `README.md` maps the packages. Tickets and
specs are GitHub Issues on Dito-Core/dito; a comment cites them by number.

## Comments

This codebase argues in comments on purpose. A comment states, in the
present tense, WHY the code is the way it is, and points once to where the
decision lives (an ADR number, a ticket number). The git history and the
tickets hold how the code got there.

Keep, always: the why; the pointer; a warning about a non-obvious hazard
(an ordering that matters, a lock, a fail-closed path); the argued header
of an exported constant or a migration.

Write the present state. Where a sentence would begin "it used to",
"since #NN", "Codex round 2 found" or "this slice", write the one reason
that still holds and cite the ticket. A review fix explains itself in the
commit message; the comment beside it gains at most a pointer (`Codex r2`).

One home per explanation: the module header, or the constant's docblock.
A second site says one line and points there.

A forward pointer ("until 5b", "#NN's remainder") names a ticket that is
open and carries the obligation. Before closing a ticket, grep the tree for
its number and rewrite every comment that named it as future work.

When you change code, the comment beside it is yours: re-read it against
the new code and fix the words. If the code looks wrong, leave both and say
so in the PR under "code may be wrong".

Insert a new declaration above the next declaration's docblock, never
between a docblock and its declaration. A module header or section comment
sits above a blank line; a declaration's docblock sits directly on it.

Two scripts hold the rule mechanically, and CI runs both:

- `node scripts/docblock-check.mjs` fails on a docblock stacked on another.
- `node scripts/comment-hygiene.mjs` reports history phrases and
  closed-ticket placeholders in the comment lines a branch added. Run it
  before opening a PR and account in the PR body for what it lists.

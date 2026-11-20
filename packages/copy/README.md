# @dito/copy

Every rep-facing string of the dashboard, keyed. One locale, **es-MX**. No
framework, no runtime negotiation, no fallback chain — the product has one
language, and an i18n framework was rejected rather than deferred
(spec [#214](https://github.com/Dito-Core/dito/issues/214), *Rejected, not
horizon*).

The package exports **the entries, a renderer, and the words for when a
rutina runs** (`whenRutinaRuns`, which the runtime's proposal card and Rutinas
both say, so they are rendered in one place): no database connection, no key,
no clock, no policy. What to send and to whom is
[`@dito/notify`](../notify/README.md)'s; what to show is rep-web's.

## Three families

| Family | What it holds | Who owns the words |
| --- | --- | --- |
| `CHROME` | labels and page copy, keyed `surface.thing` | code — UI chrome, which [ADR-0037](../../docs/adr/0037-the-twin-talks-like-a-coworker.md)'s amendments exempt by name |
| `DOCUMENTS` | the contract summary, the contract text and the ban-risk disclosure, each **versioned** | Diego or counsel ([#16](https://github.com/Dito-Core/dito/issues/16)) — every text is a marked placeholder today |
| `TEMPLATES` | notify's two messages, each declaring its slots' types | code — chrome that labels, names and explains, and states nothing about the rep's record |

Nothing the **twin** says is here. The twin composes that, on the dashboard as
in the thread (ADR-0037); a sweep over the rep-side packages refuses a Spanish
literal outside its own pinned allowlist, and this package is a different
record with a different rule — see *The CI check* below.

## A published document version is immutable

An acknowledgment row names a seat, a document, a **version** and an instant,
so the version has to be a thing that exists and cannot move (user story 12:
"nobody can later claim I agreed to different words"). Two mechanisms hold it:

- every entry pins the **sha-256 of its own text**, and `documents.test.ts`
  recomputes it — editing a published text and leaving its digest behind is a
  red build;
- the entries and the array are **frozen at import**, so a page cannot rewrite
  the text it is about to record an acknowledgment of.

The digest alone is **half** the mechanism: an author who edits the text *and*
re-runs the digest publishes different words under an existing version number,
and nothing that reads only the working tree can tell that apart from a
version written correctly the first time. What distinguishes them is history,
so the other half is a git check:

```sh
node scripts/copy-versions-check.mjs --base <the branch's merge base>
```

It compares the published `(key, version, digest)` triples against the
baseline in both directions — a changed digest is a violation, so is a
version that has gone, and a **new** version is welcome. It runs in the unit
job on the same base sha the comment-hygiene step uses. The other half of that
claim is the `acknowledgments` row, which stores the digest the rep was shown
([#223](https://github.com/Dito-Core/dito/issues/223)) — so a text changed
under an unchanged version is detectable from the record a rep's consent lives
in, and not only from history.

`documentVersion(key, version)` refuses a version nobody published rather than
falling back to the nearest text.

## A template renders only from a complete, typed slot set

A slot is one of six bounded things — `text`, `name`, `url`, `code`, `count`,
`instant` — and never a value the caller describes. `renderTemplate` refuses a
missing slot, a slot nobody declared, and a value its type does not accept; it
parses the template into segments and joins them, so a value that looks like
`{another}` is text rather than a second hole.

`text` is the free-form type, bounded to one short line. It exists because a
page legitimately interpolates a short label — and it is named in
`FREE_FORM_SLOT_TYPES` so `@dito/notify` can refuse any template that
declares one. That refusal is where
[ADR-0022](../../docs/adr/0022-system-outbound-rails-closed-notify-catalog.md)'s
*no free-text parameter exists* is enforced.

An `instant` has **no default zone**: the same instant is a different sentence
in two zones, so the caller passes one and a template that declares an instant
without it is refused.

## The CI check

`node scripts/copy-check.mjs --require-app` sweeps **apps/rep-web** for
rep-facing string literals outside this package and fails on one (spec #214
decision 13; user story 47). It runs in the unit job with `--require-app`
since [#221](https://github.com/Dito-Core/dito/issues/221) landed the app: an
empty sweep is not a pass
([ADR-0028](../../docs/adr/0028-testing-evals-local-development.md)
doctrine), so a rep-web that failed to check out is a red build rather than a
green nobody can interpret. Its allowlist ships **empty**, and
`copy-check.test.ts` proves it bites on a planted file and passes when the
same page reads its words from here.

Three of its four rules decide by POSITION in JSX markup and therefore apply
to `.tsx` and `.jsx` only; a plain `.ts` module is held to both LANGUAGE rules
and to neither position rule. `repFacing` in the script argues why, and
`copy-check.test.ts` proves each half.

## What grows, and where

`CHROME` grows with each page ticket — a label with no page is a label nobody
reviewed. `DOCUMENTS` grows by version, never by edit. `TEMPLATES` grows only
when notify's catalog does, which is a decision on ADR-0022 rather than a copy
change: 6a sends two messages, and web push, the near-expiry nudges and the
daily digest are 6b's (spec #214 decision 10). owner-web moves onto this
package on the horizon ([#117](https://github.com/Dito-Core/dito/issues/117)).

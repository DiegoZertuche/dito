-- The aperture may read a company's mode (ticket #132; spec #126 decisions
-- 9 and 19; ADR-0016 as amended, ADR-0002, ADR-0003, ADR-0029).
--
-- NUMBERING: the …202609021000·0 range's SEVENTIES (…100070 through
-- …100079) belong to this ticket. Ticket #127 reserved …100010–…100050 and
-- said why: a parallel ticket cutting a migration on the same day must not
-- collide with it. #129 holds the sixties; this file and anything else the
-- shadow lift needs hold the seventies.
--
-- WHAT THIS EXISTS FOR. `companies.shadow_lifted_at` arrived with #127 and
-- was read by nobody. From this ticket on it is read on the crossing's
-- hottest path: the aperture stamps `shadow` at filing from the company's
-- mode — `true` while the timestamp is NULL, `false` once the lift act has
-- set it (ADR-0016 as amended: "the aperture stamps `shadow` at filing from
-- the company's mode … so facts filed after a lift land visible without
-- anyone touching them"). A read needs a privilege and, under row-level
-- security, a policy; `companies` had neither, because …100040 gave it RLS
-- with NO POLICY AT ALL and said, in as many words, that "the aperture
-- reading a company's mode at filing … arrives with its own ticket and owes
-- its own policy, written where the reader is". This is that file.
--
-- IT CHANGES NOTHING TODAY, AND THAT IS THE POINT. Every rep-side process
-- connects as the schema owner `dito`, a superuser, which bypasses both the
-- ACL and every policy — so the stamp works with or without this migration
-- on every database that exists. What it buys is the day the aperture
-- becomes its own connection (#115, "every process connects as its own
-- role"): the stamp keeps working, instead of silently filing NOT NULL
-- violations on the first crossing of the first company that has a registry
-- row. Writing the grant beside the reader, while the reader is being
-- written, is the only moment anyone will remember it is needed.
--
-- SELECT AND NOTHING ELSE, and the asymmetry is deliberate. The aperture
-- READS a company's mode; the LIFT ACT WRITES it, and that act runs as the
-- schema owner like every other break-glass verb in its family
-- (`rig-unmerge.ts`, `rig-entity-kind.ts`, `rig-seed-owner.ts`), so it asks
-- for nothing here. An UPDATE grant on `companies` would hand the single
-- Ledger writer the launch gate itself — the one switch that decides what
-- an owner can see — for a path that does not exist (ADR-0003's own
-- discipline about privileges nobody uses, which …100012 applied when it
-- refused the aperture table-wide UPDATE on `ledger`).
--
-- WHY THAT DISCIPLINE DOES NOT ALSO REFUSE THE SELECT, which is the obvious
-- next question and deserves an answer rather than a silence. "A privilege
-- nobody uses" describes a grant with no code behind it; this one has code
-- behind it in this very commit — `shadowAtFiling`, on the aperture's three
-- filing statements, running as the aperture in every deployment where
-- roles mean anything. What is deferred is not the READER but the
-- CONNECTION, and #115 is a re-plumbing rather than a new caller. The
-- UPDATE has no such code and would have none: the writer of this column is
-- a break-glass script that connects as the owner, by design.
-- `shadow-lift.int.test.ts` asserts BOTH halves as `dito_aperture`, so this
-- file's claim is exercised rather than merely argued.
--
-- THE POLICY IS `USING (true)`, matching the five `dito_aperture` policies
-- …100040 already wrote on the `ledger` tables, and for the same recorded
-- reason: the aperture derives its company from the seam row it files off,
-- never from a connection setting, so there is no per-connection company to
-- key a predicate to. It is also the honest shape of what the stamp asks —
-- "is THIS company lifted", for whichever company the seam row named — and
-- narrowing it to a declared company would be inventing a mechanism the
-- writer does not have. …100040's own note records this as debt against
-- #115; this policy joins that debt rather than adding a new kind of it.
--
-- WHAT FR-71a SEES. `auditRowLevelSecurity` requires RLS ENABLED and FORCED
-- on both registries (unchanged here) and `auditCompanyPolicies` constrains
-- only policies bound to `dito_ledger_views` — which must be SELECT and
-- must read the pinned company predicate — plus it refuses any policy bound
-- to PUBLIC. A policy bound to `dito_aperture` is neither, so the audit
-- passes it, exactly as it passes the five on `ledger`. `companies`
-- PRIVILEGES are outside FR-71a's diff altogether today (the annotation
-- sweep is fenced to `ledger`, and the write-grantee sweep looks at
-- INSERT/UPDATE/DELETE/TRUNCATE only), which is recorded on the ticket
-- rather than fixed here: `grants.ts` belongs to a parallel ticket this
-- wave.

GRANT SELECT ON companies TO dito_aperture;

CREATE POLICY companies_aperture_read ON companies
    FOR SELECT TO dito_aperture
    USING (true);

COMMENT ON POLICY companies_aperture_read ON companies IS
    'Ticket #132: the aperture reads a company''s mode at filing to stamp `shadow` (ADR-0016 as amended). UNRESTRICTED for the reason …100040''s ledger policies are: the aperture derives its company from the seam row it files off, not from a connection setting. SELECT only — the lift act writes this column as the schema owner.';

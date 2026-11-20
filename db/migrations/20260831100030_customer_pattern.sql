-- `CustomerPattern` JOINS THE LEDGER'S FACT TYPES (ticket #61; FR-30,
-- FR-32; ADR-0033, ADR-0034, ADR-0035, ADR-0038, ADR-0040).
--
-- The sixth type, and the one deferred for a whole slice — not because it
-- is hard, but because its false positives are aperture BREACHES rather
-- than noise. FR-30 defines it narrowly as observable customer regularities
-- and warns by name against "rep tactics, judgments, or selling approach";
-- a wrong `QuoteGiven` is a wrong number in a record the rep can correct, a
-- wrong `CustomerPattern` is the rep's employer reading a judgment about
-- the rep. The condition for adding it was a labelled corpus able to tell
-- one from the other, which ticket #56 built and #61 extends.
--
-- THIS MIGRATION STORES NOTHING NEW, exactly as `…100010`'s header
-- predicted: "adding it is a code change plus a CHECK". One value joins one
-- closed set. `payload_version` starts at 1 for the new type — a genuinely
-- fresh shape under a label nothing was ever stored under, so there is no
-- meaning shift, no burned number and no upcaster (ADR-0034). The payload
-- itself — one required `pattern` clause, with nothing verbatim from the
-- conversation in it — is the application's
-- (`packages/aperture/src/facts.ts`), like every other fact's.
--
-- THE CHECK IS EXTENDED, NEVER RE-CUT. Postgres has no "add a value to a
-- CHECK", so the constraint is dropped and re-created carrying every value
-- it already granted plus the new one. A hand-written re-cut from a stale
-- ancestor silently dropped values twice during slice 3;
-- `migration-vocabulary.test.ts` fails on any successive cut that is not a
-- superset of the one before, and reads the standing set against the
-- aperture's own `FACT_TYPES` so the code and the store cannot drift.
--
-- NOTHING EXISTING IS TOUCHED, and that is why there is no window
-- assertion here. Ticket #71's split had to refuse while any non-shadow
-- `OrderTaken` existed, because it REINTERPRETED standing rows; this
-- migration relabels nothing, rewrites nothing, and widens what may be
-- written without changing what any stored row means. It is safe against a
-- database with rows and against an empty one alike.
--
-- `…100010`'s header still says "FOUR fact types, not CONTEXT.md's five",
-- which was true when it was written and has been wrong since #71. Applied
-- migrations are not edited — the checksum in `atlas.sum` is the record
-- that they ran as written — so the correction lives here, where the
-- reader following the constraint's history arrives last: the closed set is
-- SIX, and CONTEXT.md's fact-type entry is true again.

ALTER TABLE ledger.facts
    DROP CONSTRAINT ledger_facts_fact_type_check;

ALTER TABLE ledger.facts
    ADD CONSTRAINT ledger_facts_fact_type_check
    CHECK (fact_type IN ('QuoteGiven', 'OrderRequested', 'OrderTaken',
                         'DatePromised', 'ContactEstablished',
                         'CustomerPattern'));

COMMENT ON CONSTRAINT ledger_facts_fact_type_check ON ledger.facts IS
    'ADR-0038: OrderRequested is the customer asking, OrderTaken is the customer asking AND the business agreeing. Two independent events — neither becomes the other, and nothing links them. Ticket #61: CustomerPattern is a standing preference or constraint the CUSTOMER stated about themselves, read in the customer''s own message (the authorship fence) and attached to exactly one entity like every other fact (FR-32, absolute — there is no non-entity slot).';

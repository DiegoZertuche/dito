-- THE ORDERREQUESTED / ORDERTAKEN SPLIT (ticket #71; ADR-0038, and
-- ADR-0034 is what makes it cost a migration at all).
--
-- `OrderTaken` used to mean "the customer placed an order, or confirmed
-- one" — a sentence with no rep in it. It now means the customer asked AND
-- the business agreed, and the old meaning moves to a new type,
-- `OrderRequested`. Same label, different meaning: the one change ADR-0034
-- says additive evolution cannot express.
--
-- Three statements, in this order, and each is a decision:
--
-- 1. THE WINDOW IS ASSERTED, not assumed. ADR-0038's whole argument is
--    that the shift is free because nothing NON-SHADOW exists to
--    reinterpret — the live rig Ledger holds three facts, all shadow, zero
--    non-shadow (ADR-0016: the shadow filter lives in the finalized views,
--    so a shadow row has never been part of anything an owner read). That
--    window closes the moment Test 4 flips the flag, and a migration that
--    ran afterwards would silently rewrite the record instead of an empty
--    one. So it refuses rather than proceeding, loudly, with the count.
--
-- 2. THE CHECK IS EXTENDED, NEVER RE-CUT. Postgres has no "add a value to
--    a CHECK", so the constraint is dropped and re-created carrying every
--    value it already granted plus the new one. A hand-written re-cut from
--    a stale ancestor silently dropped values twice during slice 3;
--    `migration-vocabulary.test.ts` now watches this constraint too, and
--    fails on any successive cut that is not a superset of the one before.
--
-- 3. THE STANDING ROWS ARE RELABELLED, and this is the part that replaces
--    an upcaster. Every existing `OrderTaken` row asserts "the customer
--    asked" — which is precisely what `OrderRequested` now spells — so the
--    relabel is MEANING-PRESERVING: the row says after it exactly what it
--    said before. `payload_version` is deliberately untouched, so a
--    pre-#70 row stays `(OrderRequested, 1)` = the commercial shape with no
--    `requestedFor` slot, and a #70 row stays `(OrderRequested, 2)` = the
--    shape with one. And the disclosure line the rep was told — «Te pidió
--    …» — is left exactly as it was stored, because it is still true
--    word-for-word of the relabelled row. That is why relabelling beats
--    deleting: deletion would either orphan a true statement the rep was
--    given or erase it, and ADR-0034 forbids rewriting a disclosure line
--    for the same reason it forbids re-rendering one.
--
-- What this migration does NOT do: it does not touch `payload`, it does
-- not backfill the `agreement` the new `OrderTaken` requires, and it does
-- not create a single `OrderTaken` row. After it runs, `OrderTaken` is an
-- EMPTY type with a new meaning, and its payload line restarts at 3 in the
-- application (`FACT_PAYLOAD_VERSIONS`) so that a stray `(OrderTaken, 1)`
-- or `(OrderTaken, 2)` row in any database this migration never reached
-- can never be mistaken for the new shape. Version numbers are never
-- recycled.

-- The lock comes FIRST, and it is what makes the assertion below an
-- assertion rather than a guess (Codex r3). `ALTER TABLE` would take
-- ACCESS EXCLUSIVE anyway, but only AFTER the count had been read — so a
-- concurrent transaction flipping the launch gate in between would commit
-- a non-shadow row that the count never saw and the relabel then rewrote.
-- Taking the lock up front serializes the check with the rewrite it
-- authorizes. Atlas applies each migration file in one transaction, so the
-- lock is held to the end.
LOCK TABLE ledger.facts IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
    live bigint;
BEGIN
    SELECT count(*) INTO live
      FROM ledger.facts
     WHERE fact_type = 'OrderTaken' AND shadow = false;
    IF live > 0 THEN
        RAISE EXCEPTION
            'ticket #71 / ADR-0038: % non-shadow OrderTaken row(s) exist — the split is free only while nothing non-shadow does, and relabelling here would reinterpret facts an owner has already read. A read-time upcaster is what this case needs (ADR-0034), and it is not this migration',
            live;
    END IF;
END;
$$;

ALTER TABLE ledger.facts
    DROP CONSTRAINT ledger_facts_fact_type_check;

ALTER TABLE ledger.facts
    ADD CONSTRAINT ledger_facts_fact_type_check
    CHECK (fact_type IN ('QuoteGiven', 'OrderRequested', 'OrderTaken',
                         'DatePromised', 'ContactEstablished'));

UPDATE ledger.facts
   SET fact_type = 'OrderRequested'
 WHERE fact_type = 'OrderTaken';

-- ...and the claim is checked rather than assumed. "After this migration
-- there are ZERO OrderTaken rows anywhere" is what lets `OrderTaken` start
-- a new shape at 3 with no upcaster, so it is worth one SELECT.
DO $$
DECLARE
    left_behind bigint;
BEGIN
    SELECT count(*) INTO left_behind
      FROM ledger.facts
     WHERE fact_type = 'OrderTaken';
    IF left_behind > 0 THEN
        RAISE EXCEPTION
            'ticket #71 / ADR-0038: % OrderTaken row(s) survived the relabel — the type must be empty for its new meaning to start at v3 without an upcaster',
            left_behind;
    END IF;
END;
$$;

COMMENT ON CONSTRAINT ledger_facts_fact_type_check ON ledger.facts IS
    'ADR-0038: OrderRequested is the customer asking, OrderTaken is the customer asking AND the business agreeing. Two independent events — neither becomes the other, and nothing links them.';

-- Ticket #363: the owner twin's answer kind for "the Ledger records no fact
-- of that kind" is `unrecorded` (FR-48; spec #126 decision 2).
--
-- ONE WORD, ONE MEANING (CONTEXT.md, *Disposition*). `schema-miss` is the
-- runtime's disposition for a typed result it could not accept, and the
-- owner's answer kind used the same word for content the model chose. The
-- disposition is now read from what happened and never from the kind, so the
-- kind takes a word of its own. FR-48's failed-query log is the stored
-- answers of this kind; a turn the runtime could not accept leaves no answer
-- row at all, so the two never meet in this table.
--
-- THE ROWS MOVE WITH THE CONSTRAINT, in one transaction, between dropping
-- the old CHECK (which refuses the new word) and adding the new one, so the
-- validated CHECK is true of every row: an answer row is the owner's own
-- conversation and the room re-renders it from its kind, so an old row keeps
-- rendering as what it was.

ALTER TABLE owner.answers DROP CONSTRAINT owner_answers_kind_check;

UPDATE owner.answers SET kind = 'unrecorded' WHERE kind = 'schema-miss';

ALTER TABLE owner.answers
    ADD CONSTRAINT owner_answers_kind_check
        CHECK (kind IN ('answer', 'refusal', 'ask', 'unrecorded'));

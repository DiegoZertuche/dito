-- Steering runs: a chat can be re-read within a day BY HAND, and the
-- production once-a-day rule is untouched (ticket #67; #57 finding 4).
--
-- THE RULE THAT STAYS. `extraction_runs_one_per_twin_chat_day` is what
-- …100027 called the guarantee — "this index rather than the pass's own
-- bookkeeping is what guarantees it" — and it still is. It is re-created
-- here as a PARTIAL unique index over exactly the rows the scheduled pass
-- writes, so for production it is the same rule on the same columns: one
-- run per (twin, chat, day), enforced by the database and not by code.
--
-- WHAT IS ADDED is a second kind of row that the rule deliberately does
-- not see. The hand trigger exists FOR steering sessions, and a steering
-- session sends traffic, checks the result, sends more and checks again —
-- but the day's second trigger found the chat already filed, reported
-- `0 read`, and everything sent after the first run was invisible until
-- the next day. Diego's framing at the session is the right one: "no point
-- in having steering if we have to wait 1 day to do it."
--
-- A SEPARATE ROW RATHER THAN AN OVERWRITTEN ONE. The alternative was to
-- re-claim the filed run and reset its counts, which is what a re-claim of
-- a non-filed run already does. It is wrong here for one reason: a filed
-- run's counts are the twin's record of how many facts crossed from that
-- chat that day — the numbers #57 quotes as its own evidence — and a
-- steering re-read would erase them. DELETE and TRUNCATE are refused on
-- this table for the same reason: a run that happened is a run that
-- happened.
--
-- IT IS RIG TOOLING, AND IT SAYS SO. `steering = true` means one thing
-- exactly: this run read a chat whose day was already settled, because a
-- person asked it to. Nothing on the scheduled path can set it — the
-- column defaults to false and the scheduled pass has no way to express
-- the override — so an operator reading this table can tell a day's real
-- passes from a session's hand-driven ones.
ALTER TABLE extraction_runs
    ADD COLUMN steering boolean NOT NULL DEFAULT false;

ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_one_per_twin_chat_day;

-- The same rule, on the same columns, over the production rows: the table
-- constraint becomes a partial unique index because Postgres has no
-- partial UNIQUE constraint. A second scheduled run for one (twin, chat,
-- day) is refused exactly as it was before this file.
CREATE UNIQUE INDEX extraction_runs_one_per_twin_chat_day
    ON extraction_runs (twin_id, chat_jid, extraction_day)
    WHERE NOT steering;

-- The candidate-question route is retired (ticket #218; spec #214 decisions
-- 1 and 3; FR-31, FR-32; ADR-0003 as amended, ADR-0034, ADR-0039).
--
-- THE TWIN STOPS ASKING THE REP TO FILL ITS OWN RECORD. A candidate below
-- the aperture's confidence gate became a question; it is DROPPED now, on
-- the same test that already dropped an unresolved reference (#76) — no
-- fact, no question, no disclosure line, and `extraction_runs.below_threshold`
-- counts the drops under the name it has always had. The question principle
-- spec #214 writes is why: a question is a service the twin offers when the
-- answer makes the rep's work smaller, never a way to fill a hole in the
-- record. #200's rig session showed what the ask cost — a «si» on a sentence
-- the twin was unsure of files the record with the REP's hand, at the one
-- moment they were told the twin was unsure.
--
-- SO THE STORES LOSE THEIR ONLY SOURCE, AND THIS DROPS THEM. Retired rather
-- than left dormant (spec #214 decision 3): anything that asks the rep again
-- is built on the post primitive, not on a table nothing writes.
--
-- FORWARD-ONLY, AND WHAT THAT COSTS. There is no down migration in this repo
-- and there is nothing here to preserve either: FR-32 gives an unanswered
-- question ~7 days and the rig's last question predates that window, the rig
-- store was measured EMPTY across three runs (#57's finding, recorded in
-- …20260830100080's own header), and pre-pilot rig rows are disposable. A
-- question that somehow still stood would end unanswered, which is the
-- ending FR-32 already gave it. One that was already handed to the OUTBOX is
-- a different matter, and section 1 settles it.
--
-- ═══ WHAT IS NOT TOUCHED, said out loud so its silence is not read as an
-- ═══ oversight
--
-- THE BINDING QUESTION. It is a NOTICE and never an aperture question, and it
-- survives on its own footing: the chat↔entity binding is one of the two acts
-- reserved to the rep (ADR-0037 as amended), not the twin filling a hole. Its
-- kind, its matcher, `decline_binding` and `notices_one_answer_per_event` are
-- all unchanged.
--
-- THE SEAM'S DISPOSITIONS. `question_answered`, `question_declined`'s
-- `declined`, and `question_answer_refused` ride forward in
-- `wa_event_processing_disposition_check`, untouched. Nothing writes them any
-- more, and that is not a reason to remove them: the vocabulary never
-- narrows (…20260829100022's rule), a rig corpus holds acts under them, and
-- audit coverage still watches the refusal (`question_answer_refused` in
-- `audit-coverage.ts`). A word removed from that CHECK would refuse a row a
-- corpus already carries.

-- ---------------------------------------------------------------------
-- 1. THE DELIVERIES STILL IN FLIGHT
-- ---------------------------------------------------------------------
-- A question already WRITTEN but not yet SENT is the one thing retired here
-- that can still reach a rep. The notice and its `system_send` command are
-- minted in one transaction (`insertNoticeWithSystemSend`), and the executor
-- claims `WHERE outcome IS NULL ORDER BY created_at, id` with no age cutoff
-- and without ever reading `notices.kind` — so a command left pending by a
-- plane that stopped between the disclosure's commit and the drain is
-- dispatched whenever that plane next comes up, retirement or no retirement.
-- The narrowed CHECK below cannot reach it: that binds INSERTs, and this row
-- is already written.
--
-- What the rep would get is an ask nothing can answer. `TwinPostKind` no
-- longer carries `aperture_question`, so a quoted reply to it resolves to no
-- kind and is read as ordinary rep prose, and the store the «si» would have
-- filed through is dropped a few statements below. That is the retirement
-- contradicting itself in the one place a rep can see it.
--
-- So the pending ones are FINALIZED here, and WHICH WORD depends on whether
-- one was ever attempted (Codex r2). The executor claims a command by
-- inserting its `send_attempts` row BEFORE the socket, so a pending command
-- with a claim is a process that died between the send and the finalization
-- and its delivery is UNKNOWABLE — which is the state this seam calls `held`,
-- and the state the executor itself assigns to a stale claim. One with no
-- claim was never attempted, and `failed` is the word for a recognised
-- not-sent. Recording an unknown delivery as `failed` would be this migration
-- asserting something nobody knows. Pending → finalized, with `outcome` and
-- `executed_at` written together, is the SOLE legal write on a validated
-- command (…20260827100011, …20260827100012); the rows are never deleted,
-- because the outbox is FR-70's evidence; and the reason lives in this
-- comment because `send_commands` has no reason column.
--
-- THE PLANE MUST NOT BE EXECUTING WHILE THIS APPLIES, and that is a real
-- requirement rather than a courtesy (Codex r2). `RunOnce` snapshots the
-- pending commands into memory and `executeOne` sends without re-reading
-- `outcome`, so a worker that had already read this row will still post the
-- ask; its `finalizeSent` then updates zero rows, which discards the
-- `send_executions` mapping in the same transaction and returns an error the
-- plane treats as fatal. The result is the one thing worse than a stale ask:
-- the ask delivered, its mapping lost, and the plane halted. Nothing in SQL
-- can prevent it — a process that has already read a row cannot be recalled —
-- and no migration in this repo may be applied under a running old runtime
-- anyway, because this one drops tables that runtime's extraction pass and
-- disclosure still call. Quiesce, migrate, start.
--
-- EVERY OTHER KIND'S PENDING DELIVERY IS LEFT ALONE, and so is every notice
-- row (ADR-0034): a `daily_disclosure` or a `binding_question` still in the
-- outbox is a post this runtime can still read and answer, and it goes out.
-- Nor does this re-open anything — the disclosure's still-owed join reads
-- `sent`-or-pending commands through `disclosure_posts`, which never held a
-- question notice.
--
-- This is ADR-0042's deploy-order rule read in the other direction. The
-- runtime speaks a kind before any plane emits one; a retirement drains the
-- kind out of the seam before the runtime stops speaking it.
UPDATE send_commands sc
   SET outcome = CASE
                   WHEN EXISTS (SELECT 1 FROM send_attempts a
                                 WHERE a.command_id = sc.id)
                   THEN 'held'
                   ELSE 'failed'
                 END,
       executed_at = now()
  FROM notices n
 WHERE sc.payload_ref = 'notice:' || n.id
   AND n.kind = 'aperture_question'
   AND sc.outcome IS NULL;

-- ---------------------------------------------------------------------
-- 2. THE STORES
-- ---------------------------------------------------------------------
-- `question_posts` first: its two foreign keys name `notices` and
-- `aperture_questions`, so it is the leaf and it goes before the table it
-- points at. Both are dropped with their own triggers, indexes, grants and
-- constraints, which is what `DROP TABLE` does — nothing here has to
-- enumerate them.
DROP TABLE question_posts;
DROP TABLE aperture_questions;

-- ...and the two trigger functions they were the only callers of. A function
-- with no trigger left to fire it is dead schema, and the `DROP TABLE` above
-- took the triggers without taking these.
DROP FUNCTION question_posts_immutable();
DROP FUNCTION aperture_questions_answer_is_terminal();

-- ---------------------------------------------------------------------
-- 3. THE NOTICE KIND
-- ---------------------------------------------------------------------
-- `aperture_question` leaves the closed set of notice kinds, and this is the
-- FIRST value this repo has ever taken OUT of a closed set. The standing rule
-- is that a re-cut never narrows, because a value the code still writes that
-- the store has stopped accepting is a constraint violation in front of a rep
-- after the model has been paid for. Nothing writes this one: the route is
-- retired end to end — no store, no renderer, no answer tool — so `NoticeKind`
-- does not carry it and no code path can reach this CHECK with it.
-- `migration-vocabulary.test.ts` records the exception per VALUE rather than
-- per constraint, so a second narrowing cannot ride in behind this one.
--
-- NOT VALID, AND THAT IS THE LOAD-BEARING WORD. `notices` is immutable by
-- trigger (…20260827100015) and ADR-0034 is why: a notice is the record of
-- what the twin told the rep, and a post the rep already read is not rewritten
-- or deleted to tidy a constraint. So the narrowed CHECK is enforced on every
-- new post and never re-checked against the old ones — which is exactly the
-- claim being made ("no new post may be an aperture question"), and the only
-- one this migration is entitled to make. On a fresh database the two readings
-- coincide; on a rig that ever posted one, this is the difference between a
-- migration that applies and one that cannot.
ALTER TABLE notices DROP CONSTRAINT notices_kind_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_kind_check
    CHECK (kind IN (
        'send_confirmation',
        'affirmation_refusal',
        'dismissal_ack',
        'binding_question',
        'binding_ack',
        'answer',
        'daily_disclosure',
        'correction_ack',
        'correction_refusal'
    )) NOT VALID;

-- ...and the shape rule that named the retired kind. It required an
-- `aperture_question` notice to carry the message its candidate was read in;
-- with the kind out of the set the predicate is vacuously true, and a
-- constraint naming a value the set does not hold is schema about a post
-- nobody can write.
ALTER TABLE notices DROP CONSTRAINT notices_aperture_question_about_event_check;

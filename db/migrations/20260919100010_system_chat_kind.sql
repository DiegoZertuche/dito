-- WhatsApp's own chat is not a person (ticket #255; boundary #225, F32;
-- ADR-0005, ADR-0023).
--
-- NUMBERING: …20260919100010, the first of 2026-09-19, after …20260909100020
-- (the fill's stop marker, #245). Forward-only: no migration in this repo is
-- ever edited once it has applied anywhere, because a migration is a statement
-- about what a database has already been through.
--
-- ═══ WHY A MIGRATION AND NOT ONLY A CODE CHANGE ═══
--
-- `plane/directory`'s `KindOf` now reads user `0` on the default server as
-- `other` — a reserved address in the rail's space, the way `status` is on the
-- broadcast server — so every row written from here on is right. But the KIND
-- IS A STORED COLUMN and the store replaces it only on an UPSERT, which is a
-- delivery or an app-state sync for that chat: WhatsApp's announcements arrive
-- a few times a year, so a row already kinded `dm` would sit on a rep's
-- scoping page as «Chat por conocer» until the next one landed. On the rig one
-- was marked, and its fill refused `no_lid`.
--
-- ═══ IDEMPOTENT, AND IT MOVES EXACTLY ONE ADDRESS ═══
--
-- The predicate names the address and the kind it is leaving, so a second run
-- updates nothing, an empty table updates nothing, and no other row is
-- readable by it at all. It is an address and not a heuristic: nothing here
-- reads a name, a message or a count (ADR-0005 — the plane judges nothing
-- beyond the address; this is the seam's copy of the same reading).
--
-- THE ALLOWLIST IS NOT TOUCHED, and that is the boundary this respects. A
-- `scope_allowlist` row is what a rep ASKED for, minted by a rep act with a
-- `dashboard_acts` row, a plane request and two chain entries behind it — so a
-- migration that deleted one would be a scope decision with no act and no
-- audit entry under it. A marked row whose chat is now `other` simply stops
-- being counted by Inicio's fill card (`readFillReach`), because a chat no page
-- can list is not one the card can name; taking the row itself off the rig is
-- an operator's by hand (rig data is disposable).
--
-- NO NEW VOCABULARY: `other` is one of `chat_directory_kind_check`'s four
-- words since …20260908100050, so `migration-vocabulary.test.ts` is untouched.

UPDATE chat_directory
   SET kind = 'other'
 WHERE chat_jid = '0@s.whatsapp.net'
   AND kind <> 'other';

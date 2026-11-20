-- The lean-in offer rides on the curation (ticket #322; spec #318 decision
-- 32; #279's ruling: after 2.5 s resting on a card, one chip carries the
-- twin's offer about it).
--
-- NUMBERING: …20261004100040, after …20261004100010. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- ONE COLUMN, SEALED. The thread's `spotlight` tool may attach to each card it
-- places one sentence of its own — what it would do for the rep about that
-- card — and the page shows it as the bar's chip when the rep rests on the
-- card. The sentence is the twin's words and may name the card's customer,
-- so it is sealed under the twin DEK (ADR-0008) exactly as a knock's sentence
-- is (`post_knocks.text_enc`): a JSON array of `{post_id, sentence}`, read by
-- the runtime alone. NULL on a curation that offers nothing, which is every
-- version written before this one. The table stays immutable by its own
-- triggers; the grant is unchanged (SELECT, INSERT).

ALTER TABLE canvas_curations
    ADD COLUMN IF NOT EXISTS offers_enc bytea;

COMMENT ON COLUMN canvas_curations.offers_enc IS
    'Ticket #322: the twin''s lean-in offers on the cards this curation placed, a JSON array of {post_id, sentence} sealed under the twin DEK (ADR-0008) — NULL when the curation offers nothing.';

COMMENT ON TABLE canvas_curations IS
    'Tickets #320, #322: the canvas''s curation as the twin thread''s spotlight tool wrote it — the spotlight and the order of the rest by post id, one version per write, with the twin''s lean-in offers sealed under the twin DEK; the newest is the current one the canvas read returns.';

-- The draft's twin-thread post (ticket #30; spec #29 grilling decision 4):
-- a draft now carries TWO contents, both DEK-encrypted (ADR-0008) and both
-- frozen by the drafts immutability trigger from birth —
--   content_enc — the customer-bound message body, exactly what a tap
--                 releases (the #25 content binding: «va» authorizes the
--                 body the rep saw in the guillemets);
--   post_enc    — the Mock A rendering the twin thread shows (✳️ frame,
--                 label, cliente line, guillemet body, «Porque:» line,
--                 instruction line), rendered at emission by the twin's one
--                 grammar point. The plane stays dumb (ADR-0005): the
--                 executor posts post_enc for a system_send draft ref and
--                 sends content_enc for a customer_send — it picks the
--                 column its class names, judging nothing.
-- Nullable for the slice-1 rows that predate the grammar: a legacy pending
-- post falls back to content_enc (unframed, honest); every #30 emission
-- writes both.
ALTER TABLE drafts
    ADD COLUMN post_enc bytea;

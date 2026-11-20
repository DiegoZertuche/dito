-- THE SPOTLIGHT (ticket #401; ruled by Diego 2026-10-13).
--
-- One card the twin holds up for the rep — lifted on Inicio, the others
-- stepping back, the twin's mark beside it — or none. It is state the twin writes
-- with its `spotlight` tool, one version per write, the newest the current
-- one; a version with no post is the twin ending it. It is never first place:
-- the card at the top is `canvas_curations`', whose `spotlight` column keeps
-- its stored name for the rows already written and means the top card.
--
-- A spotlight also ends when its card leaves the dashboard — sent,
-- discarded, lapsed, taken off. That end is read, never written: the runtime
-- holds a version only while its card still waits and no arrangement since it
-- took the card off (`canvas.ts`, `readSpotlight`). The rep moving the twin's mark
-- never ends it, so nothing the page does writes here.
--
-- Metadata only: post ids and an instant. Append-only, as the curations are.

CREATE TABLE IF NOT EXISTS canvas_spotlights (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    twin_id uuid NOT NULL,
    -- The card held up; NULL when the twin ended the spotlight.
    post_id uuid,
    execution_id uuid NOT NULL
        CONSTRAINT canvas_spotlights_execution_fkey REFERENCES executions (id)
        DEFERRABLE INITIALLY DEFERRED,
    written_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE canvas_spotlights IS
    'Ticket #401: the card the twin thread''s spotlight tool holds up for the rep, or none — one version per write; the newest is the current one while its card still waits and no arrangement since took it off. Metadata only.';

CREATE INDEX IF NOT EXISTS canvas_spotlights_current
    ON canvas_spotlights (twin_id, id DESC);

CREATE OR REPLACE FUNCTION canvas_spotlights_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'canvas_spotlights are immutable (ticket #401): % refused — every version is kept and the next write supersedes', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS canvas_spotlights_no_update_delete ON canvas_spotlights;
CREATE TRIGGER canvas_spotlights_no_update_delete
    BEFORE UPDATE OR DELETE ON canvas_spotlights
    FOR EACH ROW EXECUTE FUNCTION canvas_spotlights_immutable();

DROP TRIGGER IF EXISTS canvas_spotlights_no_truncate ON canvas_spotlights;
CREATE TRIGGER canvas_spotlights_no_truncate
    BEFORE TRUNCATE ON canvas_spotlights
    FOR EACH STATEMENT EXECUTE FUNCTION canvas_spotlights_immutable();

GRANT SELECT, INSERT ON canvas_spotlights TO dito_twin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON canvas_spotlights FROM dito_twin_runtime;

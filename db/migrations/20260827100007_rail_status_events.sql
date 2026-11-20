-- Rail status seam (ADR-0005, job 3; ticket #21): the plane records rail
-- lifecycle transitions here — qr issuance, linked, dropped, logged_out —
-- powering the connection state machines and surfacing the link QR to the
-- operator. Plane status metadata only, never rep content: the qr detail is
-- a transient pairing token the plane itself generated, not captured chat,
-- so it sits outside ADR-0008's DEK-encryption scope (which covers rep
-- content from the capture guard onward).
CREATE TABLE rail_status_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    twin_id uuid NOT NULL,
    -- Closed status set; a new rail state is a reviewable migration.
    status text NOT NULL CHECK (status IN ('qr', 'linked', 'dropped', 'logged_out')),
    detail text NOT NULL DEFAULT '',
    occurred_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Consumers read a twin's transitions in emission order.
CREATE INDEX rail_status_events_twin_id_id_idx ON rail_status_events (twin_id, id);

-- A weekly cadence holds a set of weekdays on one row (ticket #387; Diego's
-- ruling of 2026-10-11; CONTEXT.md *Schedule*; ADR-0014's Schedule wake).
--
-- NUMBERING: …20261011100020, after …20261011100010. Forward-only: no
-- migration in this repo is ever edited once it has applied anywhere.
--
-- «Entre semana a las 9» was five rutinas, or one daily that also fired on
-- Sunday; «lunes y jueves» was two. `weekday smallint` becomes `weekdays
-- smallint[]` on both the automation's row and its clock row: ISO weekdays,
-- 1 = Monday, every entry 1–7, at least one on a weekly cadence and none on a
-- daily one. The clock fires each weekday in the set at the hour.
--
-- EXPAND AND CONTRACT IN ONE MIGRATION: nothing but the runtime reads the old
-- column, and the runtime that reads the new one ships with this. The rows
-- that exist carry their one weekday into a set of one. Metadata only (FR-73).

-- ═══════════════════════════════════════════════════════════════════════
-- 1. THE AUTOMATION'S ROW
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE automations ADD COLUMN weekdays smallint[];
UPDATE automations SET weekdays = ARRAY[weekday] WHERE weekday IS NOT NULL;

ALTER TABLE automations DROP CONSTRAINT automations_schedule_check;
ALTER TABLE automations DROP CONSTRAINT automations_trigger_check;
ALTER TABLE automations DROP CONSTRAINT automations_weekday_check;
ALTER TABLE automations DROP COLUMN weekday;

ALTER TABLE automations
    ADD CONSTRAINT automations_weekdays_check
        CHECK (weekdays IS NULL
               OR (array_ndims(weekdays) = 1 AND cardinality(weekdays) >= 1
                   AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]));
ALTER TABLE automations
    ADD CONSTRAINT automations_schedule_check
        CHECK (wake <> 'schedule'
               OR (trigger_event IS NULL AND trigger_customer IS NULL
                   AND ((every IS NULL AND weekdays IS NULL AND at_hour IS NULL)
                        OR (every IS NOT NULL AND at_hour IS NOT NULL
                            AND (every = 'week') = (weekdays IS NOT NULL)))));
ALTER TABLE automations
    ADD CONSTRAINT automations_trigger_check
        CHECK (wake <> 'trigger'
               OR (trigger_event IS NOT NULL
                   AND every IS NULL AND weekdays IS NULL AND at_hour IS NULL));

COMMENT ON COLUMN automations.weekdays IS
    'Ticket #387: the ISO weekdays (1 = Monday) a weekly cadence fires on, at at_hour of the seat''s day — one or more; NULL on a daily cadence, a trigger, or one-shot rows only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. THE CLOCK ROW
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE schedules ADD COLUMN weekdays smallint[];
UPDATE schedules SET weekdays = ARRAY[weekday] WHERE weekday IS NOT NULL;

ALTER TABLE schedules DROP CONSTRAINT schedules_once_check;
ALTER TABLE schedules DROP CONSTRAINT schedules_cadence_check;
ALTER TABLE schedules DROP CONSTRAINT schedules_weekday_check;
ALTER TABLE schedules DROP COLUMN weekday;

ALTER TABLE schedules
    ADD CONSTRAINT schedules_weekdays_check
        CHECK (weekdays IS NULL
               OR (array_ndims(weekdays) = 1 AND cardinality(weekdays) >= 1
                   AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]));
ALTER TABLE schedules
    ADD CONSTRAINT schedules_once_check
        CHECK (kind <> 'once'
               OR (fire_at IS NOT NULL AND every IS NULL AND at_hour IS NULL
                   AND weekdays IS NULL AND last_fired_at IS NULL));
ALTER TABLE schedules
    ADD CONSTRAINT schedules_cadence_check
        CHECK (kind <> 'cadence'
               OR (fire_at IS NULL AND fired_at IS NULL AND every IS NOT NULL AND at_hour IS NOT NULL
                   AND (every = 'week') = (weekdays IS NOT NULL)));

COMMENT ON COLUMN schedules.weekdays IS
    'Ticket #387: the ISO weekdays (1 = Monday) a weekly cadence fires on — one or more; NULL on a daily cadence and on a one-shot row.';

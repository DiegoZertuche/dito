/**
 * THE RAIL'S OUTAGE, TOLD TO THE TWIN THREAD ONCE IT HAS LASTED (ticket #319;
 * spec #318 decision 11; boundary #327 finding F2, ruled 2026-10-09).
 *
 * The rail writes its own status rows (`rail_status_events`, the plane's), and
 * the loop already reads the newest one each pass beside the seat's link and
 * the grave-event announcement (`seat-state.ts`, `notify-tiers.ts`). This is
 * the same read, told to the day's session as a `rail` event — ONLY ONCE THE
 * LINK HAS BEEN DOWN LONGER THAN A BLIP, and once per outage. A link that
 * drops and heals within seconds is the plane's business: the rig's did so
 * every quarter hour, and every flap cost two turns nobody asked for. A link
 * that comes back tells the twin nothing — the canvas's rail card follows the
 * status rows on its own, and the twin has nothing to say about a repair.
 * The event only appends: the link's state never wakes a turn (ticket #401;
 * `thread/events.ts`), and the twin's next turn reads it in the day's session.
 *
 * MEMORY IS PER PROCESS: what a process remembers is the outage it told, by
 * the instant it began. A runtime that starts during a long outage tells it
 * once more when the threshold has passed — news to the twin that process
 * serves, never a turn about a flap.
 */
import type pg from "pg";
import type { ThreadEventSink } from "./thread/events.js";

/**
 * How long the link must have been down before the twin is told: longer than
 * any blip the plane heals on its own, shorter than a rep's patience.
 */
export const RAIL_OUTAGE_AFTER_MS = 3 * 60_000;

/** The watch, held by the loop for the life of the process. */
export interface RailWatch {
  tick(deps: {
    readonly db: pg.ClientBase;
    readonly twinId: string;
    readonly threadSessions?: ThreadEventSink;
    /** The instant to measure the outage against; the clock when absent. */
    readonly now?: Date;
  }): Promise<void>;
}

export function createRailWatch(options: { readonly outageAfterMs?: number } = {}): RailWatch {
  const outageAfterMs = options.outageAfterMs ?? RAIL_OUTAGE_AFTER_MS;
  let told: string | undefined;
  return {
    async tick(deps) {
      const sink = deps.threadSessions;
      if (sink === undefined) return;
      // THE CURRENT OUTAGE: the newest row says the state, the first row since
      // the last `linked` says when it began.
      const read = await deps.db.query<{ status: string; since: Date | null }>(
        `WITH last_link AS (
           SELECT COALESCE(MAX(id), 0) AS id FROM rail_status_events
            WHERE twin_id = $1 AND status = 'linked'
         )
         SELECT newest.status,
                (SELECT MIN(e.occurred_at) FROM rail_status_events AS e, last_link
                  WHERE e.twin_id = $1 AND e.id > last_link.id) AS since
           FROM rail_status_events AS newest
          WHERE newest.twin_id = $1
          ORDER BY newest.id DESC
          LIMIT 1`,
        [deps.twinId],
      );
      const row = read.rows[0];
      if (row === undefined || row.status === "linked" || row.since === null) {
        told = undefined;
        return;
      }
      const since = row.since.toISOString();
      if (told === since) return;
      const now = deps.now ?? new Date();
      if (now.getTime() - row.since.getTime() < outageAfterMs) return;
      sink.raise(deps.twinId, { kind: "rail", state: row.status, since });
      told = since;
    },
  };
}

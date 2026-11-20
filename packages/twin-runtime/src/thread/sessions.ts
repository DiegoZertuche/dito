/**
 * THE TWIN THREAD'S DAY, HELD (ticket #319; spec #318 decisions 1, 8 and 11;
 * design D3; ADR-0014 and ADR-0012 as amended 2026-09-27).
 *
 * The registry of open sessions in this runtime process: per twin, the
 * day's session (`@dito/execution`'s `Session`, which owns the SDK child, the
 * inbox, the fold and the dropped turn) and its row in the seam. Every wake and every event goes through
 * `enter`, which opens, resumes or cuts the day before handing the session
 * over.
 *
 * ONE SESSION PER TWIN AND DAY, by two locks: `enter` runs one at a time per
 * twin, so two wakes racing in one pass find the same session, and the seam's
 * `thread_sessions_one_open` index refuses a second open row from anywhere.
 *
 * THE ROW IS THE MEMORY ACROSS PROCESSES. Its id, its day, its last turn, the
 * last entry it keeps and the turn in flight are written as the session moves
 * (the session's hooks), so a runtime that restarts — a deploy, a crash —
 * resumes the same session by id, and one that died inside a turn
 * resumes without that turn. Nothing anybody said is in it.
 *
 * THE DAY IS CUT ONLY BETWEEN EXCHANGES (`day.ts`). When it is, the old
 * session is closed and its row stamped, and the new one opens with
 * yesterday's tail carried over as its first message (`tail.ts`).
 *
 * A CHILD STAYS UP WHILE ITS DAY IS OPEN — a parked child holds a few hundred
 * megabytes and does nothing; one twin runs on the rig, and the per-twin unit
 * (#115) suspends idle twins — and is closed at the cut and at shutdown,
 * so its file is flushed. There is no idle close: a child gone for any reason
 * is resumed by id on the next wake, so nothing is lost if one is added.
 */
import { randomUUID } from "node:crypto";
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import {
  openSession,
  type Harness,
  type Session,
  type SessionHooks,
  type SessionStart,
} from "@dito/execution";
import type pg from "pg";
import { cutsTheDay, seatDay } from "./day.js";
import type { ThreadTrigger } from "./deps.js";
import type { ThreadItemToIndex } from "./memory-tools.js";
import { daySessionShape } from "../runs/engine.js";
import { THREAD_DEFINITION } from "../runs/shipped-conversations.js";
import type { RaisedThreadEvent, ThreadEventSink } from "./events.js";
import { readTailMaterial } from "./reads.js";
import { CARRIED_TAIL_ITEMS, carriedTail, renderCarriedTail } from "./tail.js";

/**
 * What a wake hands back to the turn that answered it, so a folded line's
 * reply reaches its own door (`consumer.ts`).
 */
export interface ThreadTag {
  readonly trigger: ThreadTrigger;
  /** The seat a dashboard line streams to, when one is watching. */
  readonly seatId?: string;
  /**
   * What the wake said, as the thread's own store records it — so a line that
   * folded into another wake's turn is indexed by the turn that answered it
   * (ticket #320).
   */
  readonly said?: Omit<ThreadItemToIndex, "id">;
  /**
   * The row of `rep_asks` a pick, a selection or a summons woke the turn
   * from (ticket #358) — marked by whichever turn answered it, so an ask that
   * folded into another wake's turn is served once too.
   */
  readonly askId?: string;
}

/** What opening or resuming a twin's day needs. */
export interface ThreadDayDeps {
  readonly twinId: string;
  readonly harness: Harness;
  readonly bundle: Bundle;
  readonly dek: Dek;
  /**
   * WHERE THE ROW IS WRITTEN AND THE TAIL READ — a pool, never the pass's own
   * connection: `enter` runs inside lane tasks while the pass routes on its
   * connection, and a row written there could land inside a routing
   * transaction and roll back with it.
   */
  readonly pool: pg.Pool;
  readonly selfChatJid: string;
  readonly timeZone: string;
  readonly model: string;
}

/** The day's session, as a wake receives it. */
export interface DayLease {
  readonly session: Session<ThreadTag>;
  /** The seat-local day the session belongs to, `YYYY-MM-DD`. */
  readonly day: string;
}

/** One event as raised, with when the runtime learned it. */
export interface RaisedEvent {
  readonly event: RaisedThreadEvent;
  readonly at: Date;
}

/** The registry, held by the composition root or by one pass. */
export interface ThreadSessions extends ThreadEventSink {
  /** The twin's day at `now`: opened, resumed or cut, as the rules say. */
  enter(deps: ThreadDayDeps, now: Date): Promise<DayLease>;
  /** Every event raised for this twin since the last call, oldest first. */
  drain(twinId: string): readonly RaisedEvent[];
  /** Puts back, ahead of anything raised since, events a pass could not deliver. */
  requeue(twinId: string, events: readonly RaisedEvent[]): void;
  /** Closes every session — each child exits and its file is flushed. */
  close(): Promise<void>;
}

export function createThreadSessions(): ThreadSessions {
  return new DayRegistry();
}

/** One twin's open day in this process. */
interface OpenDay {
  readonly day: string;
  readonly session: Session<ThreadTag>;
  readonly track: Track;
}

/** What the session's hooks move as the day goes on. */
interface Track {
  /** The id the session is written under now — its row's key. */
  sessionId: string;
  /** When its last turn ended — what the ten-minute rule is measured from. */
  lastTurnAt: Date | undefined;
}

/** The session row as the registry reads it. */
interface SessionRow {
  readonly session_id: string;
  readonly day: string;
  readonly opened_at: Date;
  readonly last_turn_at: Date | null;
  readonly kept_through: string | null;
  readonly open_turn: string | null;
}

class DayRegistry implements ThreadSessions {
  readonly #days = new Map<string, OpenDay>();
  readonly #locks = new Map<string, Promise<unknown>>();
  /** The row writes, in order, per twin — a failed one is thrown at the next `enter`. */
  readonly #writes = new Map<string, Promise<void>>();
  readonly #events = new Map<string, RaisedEvent[]>();

  async enter(deps: ThreadDayDeps, now: Date): Promise<DayLease> {
    return await this.#locked(deps.twinId, async () => {
      await this.#written(deps.twinId);
      let open = this.#days.get(deps.twinId);
      if (open === undefined) {
        open = await this.#adopt(deps, now);
      } else if (
        cutsTheDay({
          openDay: open.day,
          lastTurnEndedAt: open.track.lastTurnAt,
          now,
          timeZone: deps.timeZone,
          busy: open.session.busy,
        })
      ) {
        await open.session.close();
        this.#write(deps, (db) =>
          db.query(
            "UPDATE thread_sessions SET closed_at = $2 WHERE session_id = $1 AND closed_at IS NULL",
            [open!.track.sessionId, now],
          ),
        );
        await this.#written(deps.twinId);
        open = await this.#openNew(deps, now, open.track.sessionId);
      }
      this.#days.set(deps.twinId, open);
      return { session: open.session, day: open.day };
    });
  }

  raise(twinId: string, event: RaisedThreadEvent): void {
    const queued = this.#events.get(twinId) ?? [];
    queued.push({ event, at: new Date() });
    this.#events.set(twinId, queued);
  }

  drain(twinId: string): readonly RaisedEvent[] {
    const queued = this.#events.get(twinId) ?? [];
    this.#events.delete(twinId);
    return queued;
  }

  requeue(twinId: string, events: readonly RaisedEvent[]): void {
    if (events.length === 0) return;
    this.#events.set(twinId, [...events, ...(this.#events.get(twinId) ?? [])]);
  }

  async close(): Promise<void> {
    const days = [...this.#days.values()];
    this.#days.clear();
    await Promise.all(days.map((open) => open.session.close()));
    // A ROW WRITE THAT FAILED IS SAID AT SHUTDOWN TOO (Codex r1): the row is
    // what the next start resumes from, so a stale one is reported rather
    // than swallowed — every write is still awaited first.
    const writes = await Promise.allSettled([...this.#writes.values()]);
    this.#writes.clear();
    const failed = writes.find((write) => write.status === "rejected");
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * THE FIRST WAKE THIS PROCESS SEES FOR A TWIN: the seam's open row, if there
   * is one, is the day's session — resumed under its id, without the
   * turn it was inside if the last process died there — unless the day has
   * turned since, in which case it is closed and a new day opens from it.
   */
  async #adopt(deps: ThreadDayDeps, now: Date): Promise<OpenDay> {
    const rows = await deps.pool.query<SessionRow>(
      `SELECT session_id, day::text AS day, opened_at, last_turn_at,
              kept_through, open_turn
         FROM thread_sessions
        WHERE twin_id = $1 AND closed_at IS NULL`,
      [deps.twinId],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      const last = await deps.pool.query<{ session_id: string }>(
        `SELECT session_id FROM thread_sessions
          WHERE twin_id = $1 ORDER BY opened_at DESC LIMIT 1`,
        [deps.twinId],
      );
      return await this.#openNew(deps, now, last.rows[0]?.session_id);
    }
    const lastTurnAt = row.last_turn_at ?? undefined;
    const cut = cutsTheDay({
      openDay: row.day,
      lastTurnEndedAt: lastTurnAt,
      now,
      timeZone: deps.timeZone,
      busy: false,
    });
    if (cut || (row.open_turn !== null && row.kept_through === null)) {
      // A CUT, OR A SESSION WHOSE ONLY ENTRY WAS A TURN THAT NEVER ENDED:
      // there is nothing of it worth resuming into, so it is closed and a new
      // one opens carrying the tail.
      await deps.pool.query(
        "UPDATE thread_sessions SET closed_at = $2 WHERE session_id = $1",
        [row.session_id, now],
      );
      return await this.#openNew(deps, now, row.session_id);
    }
    const start: SessionStart =
      row.open_turn !== null && row.kept_through !== null
        ? {
            kind: "resume",
            sessionId: row.session_id,
            truncate: { keptThrough: row.kept_through, dropsTurn: row.open_turn },
          }
        : { kind: "resume", sessionId: row.session_id };
    return this.#open(deps, row.day, start, { sessionId: row.session_id, lastTurnAt });
  }

  /**
   * A NEW DAY'S SESSION: its row first — the id is chosen here, so the
   * row exists before the child writes a byte — then the session, and
   * yesterday's tail as its first message when there is one to carry.
   */
  async #openNew(
    deps: ThreadDayDeps,
    now: Date,
    previous: string | undefined,
  ): Promise<OpenDay> {
    const sessionId = randomUUID();
    const day = seatDay(now, deps.timeZone);
    await deps.pool.query(
      `INSERT INTO thread_sessions (twin_id, day, session_id, previous_session_id, opened_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [deps.twinId, day, sessionId, previous ?? null, now],
    );
    const open = this.#open(
      deps,
      day,
      { kind: "new", sessionId },
      { sessionId, lastTurnAt: undefined },
    );
    const client = await deps.pool.connect();
    let carried: string | undefined;
    try {
      carried = renderCarriedTail(
        carriedTail(
          await readTailMaterial(
            {
              db: client,
              dek: deps.dek,
              twinId: deps.twinId,
              bundle: deps.bundle,
              selfChatJid: deps.selfChatJid,
            },
            CARRIED_TAIL_ITEMS,
          ),
        ),
        deps.timeZone,
      );
    } finally {
      client.release();
    }
    // PUSHED FIRST AND NOT AWAITED: the wake that opened the day follows it in
    // the same inbox, so the session holds the tail before the wake.
    if (carried !== undefined) void open.session.append(carried);
    return open;
  }

  /**
   * The session itself, told once what every turn of the day is told: the
   * thread's definition's own frame (ticket #363; `daySessionShape`).
   */
  #open(deps: ThreadDayDeps, day: string, start: SessionStart, track: Track): OpenDay {
    return {
      day,
      track,
      session: openSession<ThreadTag>({
        harness: deps.harness,
        shape: daySessionShape(THREAD_DEFINITION, deps.model),
        start,
        hooks: this.#hooks(deps, track),
      }),
    };
  }

  /** The session's hooks, each one a row write in order. */
  #hooks(deps: ThreadDayDeps, open: Track): SessionHooks {
    return {
      opened: (prompt) =>
        this.#write(deps, (db) =>
          db.query("UPDATE thread_sessions SET open_turn = $2 WHERE session_id = $1", [
            open.sessionId,
            prompt,
          ]),
        ),
      kept: (through, at, byTurn) => {
        if (byTurn) open.lastTurnAt = at;
        this.#write(deps, (db) =>
          db.query(
            `UPDATE thread_sessions
                SET kept_through = $2, open_turn = NULL,
                    last_turn_at = CASE WHEN $4 THEN $3 ELSE last_turn_at END
              WHERE session_id = $1`,
            [open.sessionId, through, at, byTurn],
          ),
        );
      },
      moved: (to, from) => {
        open.sessionId = to;
        // ONE ROW PER SESSION: the one a failed turn was dropped from closes,
        // and the fork opens its own, carrying from it and keeping what it
        // kept (`…20261003100010`).
        this.#write(deps, async (db) => {
          await db.query("BEGIN");
          try {
            await db.query(
              "UPDATE thread_sessions SET closed_at = clock_timestamp(), open_turn = NULL WHERE session_id = $1",
              [from],
            );
            await db.query(
              `INSERT INTO thread_sessions
                 (twin_id, day, session_id, previous_session_id, last_turn_at, kept_through)
               SELECT twin_id, day, $2, session_id, last_turn_at, kept_through
                 FROM thread_sessions WHERE session_id = $1`,
              [from, to],
            );
            await db.query("COMMIT");
          } catch (error) {
            await db.query("ROLLBACK");
            throw error;
          }
        });
      },
      refused: (evidence) =>
        this.#write(deps, (db) =>
          db.query(
            "UPDATE thread_sessions SET resume_refusal = $2, open_turn = NULL WHERE session_id = $1",
            [open.sessionId, evidence],
          ),
        ),
    };
  }

  /**
   * Queues one row write behind the twin's earlier ones. A write that fails is
   * thrown at the next `enter`: the row is what a restart resumes from, and a
   * runtime that cannot keep it is a broken one, said loudly.
   */
  #write(deps: ThreadDayDeps, write: (db: pg.PoolClient) => Promise<unknown>): void {
    const before = this.#writes.get(deps.twinId) ?? Promise.resolve();
    const next = before.then(async () => {
      const client = await deps.pool.connect();
      try {
        await write(client);
      } finally {
        client.release();
      }
    });
    this.#writes.set(deps.twinId, next);
  }

  async #written(twinId: string): Promise<void> {
    await (this.#writes.get(twinId) ?? Promise.resolve());
  }

  async #locked<T>(twinId: string, run: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(twinId) ?? Promise.resolve();
    const mine = before.catch(() => {}).then(run);
    this.#locks.set(twinId, mine);
    return await mine;
  }
}

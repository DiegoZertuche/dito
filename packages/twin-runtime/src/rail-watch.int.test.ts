/**
 * THE RAIL WAKES THE TWIN ONLY AFTER A REAL OUTAGE, NEVER ON RE-LINK (boundary
 * #327 finding F2, ruled 2026-10-09). The seam is the plane's own status rows
 * and the sink the watch raises into; the clock is the case's, handed to the
 * watch as `now`, so a three-minute outage costs no waiting.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createRailWatch, RAIL_OUTAGE_AFTER_MS } from "./rail-watch.js";
import { resetAndMigrate, withClient } from "./testing/db.js";
import type { RaisedThreadEvent, ThreadEventSink } from "./thread/events.js";

const T0 = new Date("2026-10-09T20:00:00.000Z");
const seconds = (n: number): Date => new Date(T0.getTime() + n * 1000);
const minutes = (n: number): Date => seconds(n * 60);

async function rail(client: pg.Client, twinId: string, status: string, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
     VALUES ($1, $2, '', $3)`,
    [twinId, status, at],
  );
}

function listening(): ThreadEventSink & { readonly raised: RaisedThreadEvent[] } {
  const raised: RaisedThreadEvent[] = [];
  return {
    raised,
    raise(_twinId, event) {
      raised.push(event);
    },
  };
}

describe("the rail wakes the twin only after a real outage (boundary #327, F2)", () => {
  beforeAll(async () => {
    await resetAndMigrate();
  });

  it("a drop that re-links within the threshold wakes nothing, however many times it happens", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const sink = listening();
      const watch = createRailWatch();
      await rail(client, twinId, "linked", T0);
      for (const flapAt of [1, 16, 31, 46]) {
        await rail(client, twinId, "dropped", minutes(flapAt));
        await watch.tick({ db: client, twinId, threadSessions: sink, now: seconds(flapAt * 60 + 1) });
        await rail(client, twinId, "linked", seconds(flapAt * 60 + 2));
        await watch.tick({ db: client, twinId, threadSessions: sink, now: seconds(flapAt * 60 + 3) });
        await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(flapAt + 10) });
      }
      expect(sink.raised).toEqual([]);
    });
  });

  it("an outage past the threshold wakes exactly once, saying when the link went down", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const sink = listening();
      const watch = createRailWatch();
      await rail(client, twinId, "linked", T0);
      await rail(client, twinId, "dropped", minutes(1));
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(2) });
      expect(sink.raised).toEqual([]);
      await watch.tick({ db: client, twinId, threadSessions: sink, now: new Date(minutes(1).getTime() + RAIL_OUTAGE_AFTER_MS) });
      expect(sink.raised).toEqual([{ kind: "rail", state: "dropped", since: minutes(1).toISOString() }]);
      // THE SAME OUTAGE, TOLD ONCE: the next passes raise nothing more.
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(30) });
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(120) });
      expect(sink.raised).toHaveLength(1);
    });
  });

  it("a re-link wakes nothing, and the next real outage is told again", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const sink = listening();
      const watch = createRailWatch();
      await rail(client, twinId, "linked", T0);
      await rail(client, twinId, "dropped", minutes(1));
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(5) });
      expect(sink.raised).toHaveLength(1);
      await rail(client, twinId, "linked", minutes(6));
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(6) });
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(20) });
      expect(sink.raised).toHaveLength(1);
      await rail(client, twinId, "dropped", minutes(30));
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(31) });
      expect(sink.raised).toHaveLength(1);
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(34) });
      expect(sink.raised).toEqual([
        { kind: "rail", state: "dropped", since: minutes(1).toISOString() },
        { kind: "rail", state: "dropped", since: minutes(30).toISOString() },
      ]);
    });
  });

  it("a link that needs pairing again counts as down from the first row since the last link, and the newest state is the one told", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const sink = listening();
      const watch = createRailWatch();
      await rail(client, twinId, "linked", T0);
      await rail(client, twinId, "dropped", minutes(1));
      await rail(client, twinId, "logged_out", minutes(2));
      await rail(client, twinId, "qr", minutes(3));
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(3) });
      expect(sink.raised).toEqual([]);
      await watch.tick({ db: client, twinId, threadSessions: sink, now: minutes(4) });
      expect(sink.raised).toEqual([{ kind: "rail", state: "qr", since: minutes(1).toISOString() }]);
    });
  });

  it("a process that starts with the rail already down tells the outage once the threshold has passed, and a process that starts with it up tells nothing", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      await rail(client, twinId, "linked", T0);
      await rail(client, twinId, "dropped", minutes(1));
      const down = listening();
      await createRailWatch().tick({ db: client, twinId, threadSessions: down, now: minutes(10) });
      expect(down.raised).toHaveLength(1);
      await rail(client, twinId, "linked", minutes(11));
      const up = listening();
      await createRailWatch().tick({ db: client, twinId, threadSessions: up, now: minutes(40) });
      expect(up.raised).toEqual([]);
    });
  });

  it("a shorter threshold is the caller's to set", async () => {
    await withClient(async (client) => {
      const twinId = randomUUID();
      const sink = listening();
      const watch = createRailWatch({ outageAfterMs: 10_000 });
      await rail(client, twinId, "dropped", T0);
      await watch.tick({ db: client, twinId, threadSessions: sink, now: seconds(9) });
      expect(sink.raised).toEqual([]);
      await watch.tick({ db: client, twinId, threadSessions: sink, now: seconds(10) });
      expect(sink.raised).toHaveLength(1);
    });
  });
});

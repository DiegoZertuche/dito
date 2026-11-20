/**
 * THE SEAT'S ONE TRANSITION, AT THE POSTGRES SEAM (ticket #223 AC 4; ADR-0032,
 * FR-63).
 *
 * "The link page … switches to «linked» when the rail does; THE SEAT STATE
 * MOVES TO `linked`." The page's half is proven where the page is; this is the
 * store's half, and every claim is a row in and a row out.
 *
 * THE SEAM IS THE RIGHT PLACE because the whole of it is a predicate: which
 * seat moves, on which rail row, and — the two that matter more — which seats
 * do NOT.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { linkSeatWhenRailLinked } from "./seat-state.js";
import { resetAndMigrate, withClient } from "./testing/db.js";
import type pg from "pg";

/** One company, one seat in a given state, and the twin it owns. */
async function seat(
  client: pg.Client,
  state: string,
): Promise<{ seatId: string; twinId: string }> {
  const companyId = randomUUID();
  const seatId = randomUUID();
  const twinId = randomUUID();
  await client.query(
    "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
    [companyId, `Ferretería ${companyId.slice(0, 4)}`],
  );
  await client.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, $5)`,
    [seatId, companyId, twinId, "Mauricio Cantú", state],
  );
  return { seatId, twinId };
}

async function rail(
  client: pg.Client,
  twinId: string,
  ...statuses: readonly string[]
): Promise<void> {
  for (const status of statuses) {
    await client.query(
      `INSERT INTO rail_status_events (twin_id, status, detail, occurred_at)
       VALUES ($1, $2, '', clock_timestamp())`,
      [twinId, status],
    );
  }
}

async function stateOf(client: pg.Client, seatId: string): Promise<string> {
  const rows = await client.query<{ state: string }>(
    "SELECT state FROM seats WHERE id = $1",
    [seatId],
  );
  return rows.rows[0]!.state;
}

describe("the seat moves when the rail links (ticket #223 AC 4)", () => {
  it("moves an invited seat whose latest rail row says linked", async () => {
    await resetAndMigrate();
    await withClient(async (client) => {
      const mauricio = await seat(client, "invited");
      await rail(client, mauricio.twinId, "qr", "linked");
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: mauricio.twinId }),
      ).toBe(true);
      expect(await stateOf(client, mauricio.seatId)).toBe("linked");
    });
  });

  it("leaves it alone while the latest row is anything else", async () => {
    await withClient(async (client) => {
      // THE LATEST ROW AND NOT ANY ROW, which is the failure the ordering
      // exists to refuse: a rep who linked on Monday and dropped on Tuesday
      // has a `linked` row in their history, and a seat that moved on it would
      // be moving on the past.
      const dropped = await seat(client, "invited");
      await rail(client, dropped.twinId, "linked", "dropped");
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: dropped.twinId }),
      ).toBe(false);
      expect(await stateOf(client, dropped.seatId)).toBe("invited");

      const waiting = await seat(client, "invited");
      await rail(client, waiting.twinId, "qr", "pairing_code");
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: waiting.twinId }),
      ).toBe(false);
      expect(await stateOf(client, waiting.seatId)).toBe("invited");
    });
  });

  it("does nothing for a twin whose plane has never run", async () => {
    await withClient(async (client) => {
      const never = await seat(client, "invited");
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: never.twinId }),
      ).toBe(false);
      expect(await stateOf(client, never.seatId)).toBe("invited");
    });
  });

  it("is idempotent: a second pass changes nothing", async () => {
    await withClient(async (client) => {
      const mauricio = await seat(client, "invited");
      await rail(client, mauricio.twinId, "linked");
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: mauricio.twinId }),
      ).toBe(true);
      // ONE INDEXED PROBE AND NO WRITE, which is what makes it affordable on
      // every poll pass.
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: mauricio.twinId }),
      ).toBe(false);
      expect(await stateOf(client, mauricio.seatId)).toBe("linked");
    });
  });

  it("never resurrects a retired seat", async () => {
    await withClient(async (client) => {
      // ADR-0009 DESTROYED ITS KEY. A rail row for a retired seat's twin is a
      // plane somebody left running, and a seat that moved back to `linked` on
      // it would be a former employee's dashboard reachable again — which the
      // session read refuses anyway, and this refuses one layer earlier.
      const gone = await seat(client, "retired");
      await rail(client, gone.twinId, "linked");
      expect(
        await linkSeatWhenRailLinked({ db: client, twinId: gone.twinId }),
      ).toBe(false);
      expect(await stateOf(client, gone.seatId)).toBe("retired");
    });
  });

  it("moves only its own twin's seat", async () => {
    await withClient(async (client) => {
      const mine = await seat(client, "invited");
      const theirs = await seat(client, "invited");
      await rail(client, mine.twinId, "linked");
      await rail(client, theirs.twinId, "linked");
      await linkSeatWhenRailLinked({ db: client, twinId: mine.twinId });
      expect(await stateOf(client, mine.seatId)).toBe("linked");
      expect(await stateOf(client, theirs.seatId)).toBe("invited");
    });
  });

  it("chains nothing, and leaves the seat's own row as the record", async () => {
    await withClient(async (client) => {
      // #78's RULE, and `seat-state.ts` argues it at length: a chained act is
      // a rep act with evidence and an execution behind it, and nobody pressed
      // anything here — the runtime NOTICED a row the plane wrote. What a
      // reader joins is the seat's state and the rail row that caused it.
      const mauricio = await seat(client, "invited");
      await rail(client, mauricio.twinId, "linked");
      const before = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_chain",
      );
      await linkSeatWhenRailLinked({ db: client, twinId: mauricio.twinId });
      const after = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_chain",
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      // ...and no execution either: this is not a unit of agentic work, it is
      // a poll pass reading one row.
      const runs = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM executions WHERE twin_id = $1",
        [mauricio.twinId],
      );
      expect(runs.rows[0]!.n).toBe(0);
    });
  });
});

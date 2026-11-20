/**
 * DITO'S OWN AUTOMATIONS ARE ROWS, AND THE ONE CLOCK FIRES THEM (ticket #364;
 * ADR-0014 as amended 2026-10-06/07; CONTEXT.md *Automation*, *Precondition*,
 * *Rutinas*).
 *
 * The direct-seed seam the rutinas suite uses: Dito's rows written through
 * `ensureShippedAutomations`, a switch flipped through its store, and the
 * clock a pass at a chosen instant — so what is under test is which rows
 * exist, which runs the clock starts and when it stamps an instant. Real
 * Postgres, real envelope crypto, real SQLCipher; no model is asked anything.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openBatchWork } from "./lanes.js";
import { readRutinas } from "./routines.js";
import type { RunDeps } from "./runs/engine.js";
import { automationPaused } from "./runs/gate.js";
import { setAutomationPaused } from "./runs/pauses.js";
import { activateRutina, discardRutina, insertRutina, type RutinaWake } from "./runs/rutinas.js";
import { ensureShippedAutomations } from "./runs/shipped-automations.js";
import { fireDueCadences } from "./runs/wakes.js";
import { driveRuns } from "./testing/drive-runs.js";
import { resetAndMigrate, TEST_AUDIT_HMAC_KEY, withClient } from "./testing/db.js";
import { seatAtTheDoor } from "./testing/door.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { closeScriptedModels, scriptedModel } from "./testing/scripted-model.js";
import { insertWaEvent } from "./testing/seam-fixtures.js";
import { removeTmpDir } from "./testing/tmp.js";

afterAll(closeScriptedModels);

const executionPool = newExecutionPool();
const SELF_CHAT = "5215550000@s.whatsapp.net";
/** The rep's zone: UTC−6 all year. */
const ZONE = "America/Monterrey";
/** The seat's disclosure hour: eight in the evening. */
const HOUR = 20;

/** Thursday 8 October 2026 on the rep's clock. */
const WRITTEN = new Date("2026-10-08T14:00:00.000Z"); // 08:00
const AFTERNOON = new Date("2026-10-08T21:00:00.000Z"); // 15:00
const AT_2005 = new Date("2026-10-09T02:05:00.000Z"); // 20:05
const AT_2010 = new Date("2026-10-09T02:10:00.000Z"); // 20:10
const AT_2030 = new Date("2026-10-09T02:30:00.000Z"); // 20:30
/** The instant the day's cadence is due for: 20:00 on the 8th. */
const DUE = new Date("2026-10-09T02:00:00.000Z");

let tmp: string;
let chatCounter = 0;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-shipped-int-"));
});

afterAll(() => {
  removeTmpDir(tmp);
});

interface Twin {
  readonly client: pg.Client;
  readonly twinId: string;
  readonly companyId: string;
  readonly seatId: string;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly deps: RunDeps;
  readonly chat: string;
}

async function withTwin(run: (twin: Twin) => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    const twinId = randomUUID();
    const dek = createDekFromMaterial(randomBytes(32));
    const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
    const seat = await seatAtTheDoor(client, twinId);
    const { harness } = scriptedModel(() => [{ text: "done" }]);
    chatCounter += 1;
    try {
      await run({
        client,
        twinId,
        companyId: seat.companyId,
        seatId: seat.seatId,
        bundle,
        dek,
        chat: `52155${String(300000 + chatCounter)}@s.whatsapp.net`,
        deps: {
          db: client,
          executionPool,
          harness,
          bundle,
          dek,
          twinId,
          selfChatJid: SELF_CHAT,
          hmacKey: TEST_AUDIT_HMAC_KEY,
          embedder: fakeEmbedder(),
          drafting: { model: "claude-sonnet-5" },
          timeZone: ZONE,
          disclosureHour: HOUR,
        },
      });
    } finally {
      bundle.close();
    }
  });
}

async function ensure(twin: Twin): Promise<void> {
  await ensureShippedAutomations(twin.client, { twinId: twin.twinId, seatId: twin.seatId, disclosureHour: HOUR }, WRITTEN);
}

/** Dito's row of one name, for this twin. */
async function rowOf(twin: Twin, shipped: string): Promise<string> {
  const res = await twin.client.query<{ id: string }>(
    "SELECT id FROM automations WHERE twin_id = $1 AND shipped = $2",
    [twin.twinId, shipped],
  );
  return res.rows[0]!.id;
}

/** A customer message in an in-scope chat, in the afternoon of the day under test, or at `at`. */
async function traffic(twin: Twin, chat = twin.chat, at = AFTERNOON): Promise<void> {
  await twin.client.query("INSERT INTO scope_allowlist (twin_id, chat_jid) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    twin.twinId,
    chat,
  ]);
  await insertWaEvent(twin.client, twin.dek, {
    twinId: twin.twinId,
    companyId: twin.companyId,
    seatId: twin.seatId,
    chatJid: chat,
    senderJid: chat,
    fromMe: false,
    messageId: `msg-${randomUUID()}`,
    text: "¿Me mandas el precio del cemento?",
    occurredAt: at,
  });
}

async function runsOf(twin: Twin): Promise<{ automation: string; automation_id: string; created_by: string; woken_by: string }[]> {
  return (
    await twin.client.query(
      "SELECT automation, automation_id, created_by, woken_by FROM runs WHERE twin_id = $1 AND parent_run_id IS NULL ORDER BY created_at",
      [twin.twinId],
    )
  ).rows;
}

async function lastFiredOf(twin: Twin, automationId: string): Promise<Date | null> {
  const res = await twin.client.query<{ last_fired_at: Date | null }>(
    "SELECT last_fired_at FROM schedules WHERE automation_id = $1 AND kind = 'cadence'",
    [automationId],
  );
  return res.rows[0]!.last_fired_at;
}

describe("Dito's automations are rows of the seat, with the rep's switch (ticket #364)", () => {
  it("writes the five rows and the three cadences once, however often it is asked", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await ensure(twin);
      const rows = await twin.client.query(
        `SELECT shipped, origin, state, wake, every, at_hour, trigger_event
           FROM automations WHERE twin_id = $1 ORDER BY shipped`,
        [twin.twinId],
      );
      expect(rows.rows).toEqual([
        { shipped: "daily_disclosure", origin: "dito", state: "active", wake: "schedule", every: "day", at_hour: HOUR, trigger_event: null },
        { shipped: "drafting", origin: "dito", state: "active", wake: "trigger", every: null, at_hour: null, trigger_event: "customer_message" },
        { shipped: "extraction", origin: "dito", state: "active", wake: "schedule", every: "day", at_hour: HOUR, trigger_event: null },
        { shipped: "overnight_requests", origin: "dito", state: "active", wake: "schedule", every: "day", at_hour: 8, trigger_event: null },
        { shipped: "reminders", origin: "dito", state: "active", wake: "schedule", every: null, at_hour: null, trigger_event: null },
      ]);
      const cadences = await twin.client.query(
        `SELECT a.shipped, s.at_hour, s.precondition
           FROM schedules s JOIN automations a ON a.id = s.automation_id
          WHERE s.twin_id = $1 AND s.kind = 'cadence' ORDER BY a.shipped`,
        [twin.twinId],
      );
      expect(cadences.rows).toEqual([
        { shipped: "daily_disclosure", at_hour: HOUR, precondition: "runs_settled_and_disclosure_owed_and_day_unposted" },
        { shipped: "extraction", at_hour: HOUR, precondition: "seam_settled_and_chat_day_unsettled" },
        { shipped: "overnight_requests", at_hour: 8, precondition: "customer_chat_traffic_overnight" },
      ]);
    });
  });

  it("each switch is a pause row on its own automation's row, read by the gate and by Rutinas", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      const extraction = await rowOf(twin, "extraction");
      expect(
        await setAutomationPaused(twin.client, { twinId: twin.twinId, seatId: twin.seatId, automationId: extraction, paused: true }),
      ).toBe(true);
      expect(await automationPaused(twin.client, twin.seatId, extraction)).toBe(true);
      expect(await automationPaused(twin.client, twin.seatId, await rowOf(twin, "daily_disclosure"))).toBe(false);
      const read = await readRutinas({ db: twin.client, twinId: twin.twinId, timeZone: ZONE }, AT_2005);
      expect(read.automations.map((card) => ("shipped" in card ? [card.shipped, card.paused] : []))).toEqual([
        ["drafting", false],
        ["extraction", true],
        ["daily_disclosure", false],
        ["reminders", false],
        ["overnight_requests", false],
      ]);
    });
  });

  it("gives each cadence its next instant in the seat's zone — Dito's three and an active rutina — and a held switch none (ticket #387)", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      const pause = async (automationId: string) =>
        expect(await setAutomationPaused(twin.client, { twinId: twin.twinId, seatId: twin.seatId, automationId, paused: true })).toBe(true);
      await pause(await rowOf(twin, "extraction"));
      const rutina = async (wake: RutinaWake): Promise<string> => {
        const id = randomUUID();
        await insertRutina(twin.client, twin.bundle, {
          id,
          twinId: twin.twinId,
          seatId: twin.seatId,
          origin: "rep",
          wake,
          definition: { name: `Rutina ${id}`, budget: { iterations: 6, tokens: 120_000 }, steps: [{ kind: "post", name: "report", text: "hola" }] },
          sentence: "Lunes y jueves a las 9 te mando la lista.",
          executionId: randomUUID(),
          evidenceRef: randomUUID(),
          writtenAt: WRITTEN,
        });
        expect(await activateRutina(twin.client, { twinId: twin.twinId, id })).toEqual({ retired: [] });
        return id;
      };
      const mondaysAndThursdays = await rutina({ kind: "schedule", every: "week", weekdays: [1, 4], atHour: 9 });
      const held = await rutina({ kind: "schedule", every: "day", atHour: 9 });
      await pause(held);
      const onAMessage = await rutina({ kind: "trigger", event: "customer_message" });

      // THURSDAY 8 OCTOBER AT 20:05 ON THE REP'S CLOCK.
      const read = await readRutinas({ db: twin.client, twinId: twin.twinId, timeZone: ZONE, bundle: twin.bundle, selfChatJid: SELF_CHAT }, AT_2005);
      const next = Object.fromEntries(
        read.automations.map((card) => [card.origin === "dito" ? card.shipped : card.id, [card.paused, card.nextFiring]]),
      );
      expect(next).toEqual({
        drafting: [false, undefined],
        extraction: [true, undefined],
        // TODAY'S 20:00 HAS PASSED: tomorrow's.
        daily_disclosure: [false, { at: "2026-10-10T02:00:00.000Z", day: "2026-10-09" }],
        reminders: [false, undefined],
        overnight_requests: [false, { at: "2026-10-09T14:00:00.000Z", day: "2026-10-09" }],
        // THURSDAY'S NINE HAS PASSED: Monday's.
        [mondaysAndThursdays]: [false, { at: "2026-10-12T15:00:00.000Z", day: "2026-10-12" }],
        [held]: [true, undefined],
        [onAMessage]: [false, undefined],
      });
    });
  });

  it("Descartar never ends one of Dito's: its row stays live", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      const extraction = await rowOf(twin, "extraction");
      expect(await discardRutina(twin.client, { twinId: twin.twinId, id: extraction })).toBeUndefined();
      const row = await twin.client.query("SELECT ended_at FROM automations WHERE id = $1", [extraction]);
      expect(row.rows).toEqual([{ ended_at: null }]);
    });
  });
});

describe("the clock asks a cadence's precondition before it fires (ticket #364; CONTEXT.md *Precondition*)", () => {
  it("leaves the instant unfired while the day has nothing to read, and fires once when it has", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      const extraction = await rowOf(twin, "extraction");
      // NOTHING TO READ: the precondition is false, and the instant is not stamped.
      expect(await fireDueCadences(twin.deps, AT_2005, openBatchWork())).toBe(0);
      expect(await lastFiredOf(twin, extraction)).toBeNull();
      // A CHAT-DAY UNSETTLED: the next pass fires the day's extraction, once.
      await traffic(twin);
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(1);
      expect(await lastFiredOf(twin, extraction)).toEqual(DUE);
      expect(await runsOf(twin)).toEqual([
        { automation: "extraction", automation_id: extraction, created_by: "clock", woken_by: `clock:${String(DUE.getTime())}` },
      ]);
      expect(await fireDueCadences(twin.deps, AT_2030, openBatchWork())).toBe(0);
    });
  });

  it("the day's read fires again once its run has ended, while a chat-day is still left to read", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await traffic(twin);
      const extraction = await rowOf(twin, "extraction");
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(1);
      // THE RUN READS THE CHAT-DAY IT CLAIMED (the scripted model files
      // nothing, so the claim settles `failed` — settled for the day).
      await driveRuns(twin.deps, AT_2010);
      // NOTHING LEFT TO READ: the instant is fired and the precondition false.
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(0);
      // A SECOND CHAT WRITES: the day has a chat-day no run claimed, so the
      // next pass fires the read again, woken by the pass's own instant.
      await traffic(twin, `52155${String(400000 + chatCounter)}@s.whatsapp.net`, new Date(AT_2010.getTime() + 300_000));
      expect(await fireDueCadences(twin.deps, AT_2030, openBatchWork())).toBe(1);
      expect((await runsOf(twin)).map((run) => run.woken_by)).toEqual([
        `clock:${String(DUE.getTime())}`,
        `clock:${String(AT_2030.getTime())}`,
      ]);
      expect(await lastFiredOf(twin, extraction)).toEqual(DUE);
      // ...AND WHILE THAT RUN IS GOING, NOT AGAIN.
      expect(await fireDueCadences(twin.deps, new Date(AT_2030.getTime() + 60_000), openBatchWork())).toBe(0);
    });
  });

  it("rows first written after the hour still read that day, and never yesterday's (Codex r3)", async () => {
    await withTwin(async (twin) => {
      await ensureShippedAutomations(
        twin.client,
        { twinId: twin.twinId, seatId: twin.seatId, disclosureHour: HOUR, timeZone: ZONE },
        AT_2005,
      );
      await traffic(twin);
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(1);
      expect((await runsOf(twin)).map((run) => run.woken_by)).toEqual([`clock:${String(DUE.getTime())}`]);
    });
  });

  it("a paused automation starts no run, and its instant passes stamped", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await traffic(twin);
      const extraction = await rowOf(twin, "extraction");
      await setAutomationPaused(twin.client, { twinId: twin.twinId, seatId: twin.seatId, automationId: extraction, paused: true });
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(0);
      expect(await runsOf(twin)).toEqual([]);
      expect(await lastFiredOf(twin, extraction)).toEqual(DUE);
    });
  });

  it("a seat that cannot act holds the clock: no run", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await traffic(twin);
      await twin.client.query("UPDATE seats SET state = 'invited' WHERE id = $1", [twin.seatId]);
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(0);
      expect(await runsOf(twin)).toEqual([]);
    });
  });

  it("the day's disclosure waits for the day's extraction run to end", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await traffic(twin);
      // The extraction fires; its run is going, so the disclosure's
      // precondition is false and its instant stays unfired.
      expect(await fireDueCadences(twin.deps, AT_2010, openBatchWork())).toBe(1);
      const disclosure = await rowOf(twin, "daily_disclosure");
      expect(await lastFiredOf(twin, disclosure)).toBeNull();
      expect((await runsOf(twin)).map((run) => run.automation)).toEqual(["extraction"]);
    });
  });
});

describe("the overnight requests fire in the morning, when a customer wrote in the night (ticket #364, for #326)", () => {
  /** Friday 9 October 2026, 08:05 on the rep's clock. */
  const MORNING_AFTER = new Date("2026-10-09T14:05:00.000Z");
  /** The morning's instant: 08:00 on the 9th. */
  const MORNING_DUE = new Date("2026-10-09T14:00:00.000Z");

  async function overnightRuns(twin: Twin): Promise<string[]> {
    return (await runsOf(twin)).filter((run) => run.automation === "overnight_requests").map((run) => run.woken_by);
  }

  it("leaves the morning's instant unfired after a quiet night", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await traffic(twin); // the afternoon before: not the night
      expect(await fireDueCadences(twin.deps, MORNING_AFTER, openBatchWork())).toBeGreaterThanOrEqual(0);
      expect(await overnightRuns(twin)).toEqual([]);
    });
  });

  it("fires once at eight when a customer chat moved after ten the night before", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      // 23:30 on the 8th, on the rep's clock.
      await traffic(twin, twin.chat, new Date("2026-10-09T05:30:00.000Z"));
      await fireDueCadences(twin.deps, MORNING_AFTER, openBatchWork());
      expect(await overnightRuns(twin)).toEqual([`clock:${String(MORNING_DUE.getTime())}`]);
      await fireDueCadences(twin.deps, new Date(MORNING_AFTER.getTime() + 600_000), openBatchWork());
      expect(await overnightRuns(twin)).toHaveLength(1);
    });
  });

  it("does not catch up a morning a runtime reaches only the next day", async () => {
    await withTwin(async (twin) => {
      await ensure(twin);
      await traffic(twin, twin.chat, new Date("2026-10-09T05:30:00.000Z"));
      // 07:00 on the 10th: the 9th's instant is the latest reached, and its day is over.
      await fireDueCadences(twin.deps, new Date("2026-10-10T13:00:00.000Z"), openBatchWork());
      expect(await overnightRuns(twin)).toEqual([]);
    });
  });
});


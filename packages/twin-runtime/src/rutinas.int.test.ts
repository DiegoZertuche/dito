/**
 * RUTINAS ON THE CLOCK AND ON THE SEAM'S EVENTS (ticket #325; spec #318
 * decisions 26 and 28–30).
 *
 * The engine's direct-seed seam (`audit-coverage.int.test.ts`'s pattern): a
 * rutina is written through its store and activated through the store's own
 * act, and the clock is a pass at a chosen instant — so what is under test is
 * which runs the firing starts, under which gate, and how often. Real
 * Postgres, real envelope crypto, real SQLCipher, a real SDK child opening
 * each run's session; no model is asked anything.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TwinRuntimeDeps } from "./consumer.js";
import { readRunContent } from "./runs/content.js";
import type { RunDefinition } from "./runs/definition.js";
import { advanceRuns, createRunEngine, type RunEngine } from "./runs/engine.js";
import { openBatchWork } from "./lanes.js";
import { gateFactsOf, runGate } from "./runs/gate.js";
import { setAutomationPaused } from "./runs/pauses.js";
import { activateRutina, discardRutina, insertRutina, sweepRutinaContent, type RutinaWake } from "./runs/rutinas.js";
import { beginStep, readRun } from "./runs/store.js";
import { fireDueCadences, fireOnEvent } from "./runs/wakes.js";
import { firstFiringAtOrAfter } from "./runs/next-firing.js";
import { resetAndMigrate, TEST_AUDIT_HMAC_KEY, TEST_DATABASE_URL, withClient } from "./testing/db.js";
import { seatAtTheDoor } from "./testing/door.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { closeScriptedModels, scriptedModel } from "./testing/scripted-model.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";

afterAll(closeScriptedModels);

const executionPool = newExecutionPool();
const SELF_CHAT = "5215550000@s.whatsapp.net";
const SERGIO = "5215550101@s.whatsapp.net";
const LAURA = "5215550102@s.whatsapp.net";
/** The rep's zone: UTC−6 all year, so nine in the morning is 15:00Z. */
const ZONE = "America/Monterrey";

/** Thursday 8 and Friday 9 October 2026, at the hours a test reads. */
const THU_10 = new Date("2026-10-08T16:00:00.000Z");
const FRI_0859 = new Date("2026-10-09T14:59:00.000Z");
const FRI_0900 = new Date("2026-10-09T15:00:00.000Z");
const FRI_0901 = new Date("2026-10-09T15:01:00.000Z");
const FRI_0930 = new Date("2026-10-09T15:30:00.000Z");
const NEXT_FRI_0905 = new Date("2026-10-16T15:05:00.000Z");
/** When the rep pressed Activar: the Monday before the first Friday any test reads. */
const ACTIVATED = new Date("2026-10-05T18:00:00.000Z");

const LIST: RunDefinition = {
  name: "Clientes sin contacto de la semana",
  budget: { iterations: 6, tokens: 120_000 },
  steps: [
    {
      kind: "agent",
      name: "find",
      instructions: "List the customers the rep has not written to this week.",
      tools: ["search_memory"],
      output: { list: "string" },
    },
    { kind: "post", name: "report", text: "find.list" },
  ],
};

const FRIDAYS_AT_NINE: RutinaWake = { kind: "schedule", every: "week", weekdays: [5], atHour: 9 };
/** «Lunes y jueves a las 9»: one row, two weekdays (ticket #387). */
const MONDAYS_AND_THURSDAYS: RutinaWake = { kind: "schedule", every: "week", weekdays: [1, 4], atHour: 9 };

/** A weekday at the rep's 09:01 and 09:00, `days` after Thursday 8 October 2026. */
const at0901 = (days: number): Date => new Date(Date.UTC(2026, 9, 8 + days, 15, 1));
const at0900 = (days: number): Date => new Date(Date.UTC(2026, 9, 8 + days, 15, 0));

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-rutinas-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

interface Day {
  readonly client: pg.Client;
  readonly twinId: string;
  readonly seatId: string;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly deps: TwinRuntimeDeps & { readonly runs: RunEngine };
}

async function withTwin(run: (day: Day) => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    const twinId = randomUUID();
    const dek = createDekFromMaterial(randomBytes(32));
    const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
    const seat = await seatAtTheDoor(client, twinId);
    const { harness } = scriptedModel(() => [{ text: "done" }]);
    const deps = {
      db: client,
      harness,
      bundle,
      dek,
      twinId,
      selfChatJid: SELF_CHAT,
      ...SETTLE_IMMEDIATELY,
      drafting: { model: "claude-sonnet-5" },
      embedder: fakeEmbedder(),
      executionPool,
      sendLock: createSendLockWriter({ pool, hmacKey: TEST_AUDIT_HMAC_KEY }),
      hmacKey: TEST_AUDIT_HMAC_KEY,
      timeZone: ZONE,
      runs: createRunEngine(),
    };
    try {
      await run({ client, twinId, seatId: seat.seatId, bundle, dek, deps });
    } finally {
      bundle.close();
    }
  });
}

/** A rutina as `create_automation` leaves it: pending, both halves written. */
async function writeRutina(day: Day, wake: RutinaWake): Promise<string> {
  const id = randomUUID();
  await insertRutina(day.client, day.bundle, {
    id,
    twinId: day.twinId,
    seatId: day.seatId,
    origin: "rep",
    wake,
    definition: LIST,
    sentence: "Cada viernes a las 9 te mando la lista de los clientes sin contacto de la semana.",
    executionId: randomUUID(),
    evidenceRef: randomUUID(),
    writtenAt: ACTIVATED,
  });
  return id;
}

/** ...and Activar on it, pressed at `ACTIVATED`. */
async function activate(day: Day, id: string): Promise<void> {
  expect(await activateRutina(day.client, { twinId: day.twinId, id })).toEqual({ retired: [] });
  await day.client.query("UPDATE automations SET activated_at = $2 WHERE id = $1", [id, ACTIVATED]);
}

interface FiredRun {
  readonly id: string;
  readonly automation: string;
  readonly automation_id: string | null;
  readonly created_by: string;
  readonly woken_by: string | null;
  readonly state: string;
}

async function runsOf(day: Day): Promise<FiredRun[]> {
  const res = await day.client.query<FiredRun>(
    `SELECT id, automation, automation_id, created_by, woken_by, state
       FROM runs WHERE twin_id = $1 ORDER BY created_at, id`,
    [day.twinId],
  );
  return res.rows;
}

async function lastFiredOf(day: Day, id: string): Promise<Date | null> {
  const res = await day.client.query<{ last_fired_at: Date | null }>(
    "SELECT last_fired_at FROM schedules WHERE automation_id = $1",
    [id],
  );
  return res.rows[0]!.last_fired_at;
}

describe("the clock fires an active rutina's cadence from the schedules store (ticket #325 AC 2)", () => {
  it("never fires a pending rutina, whatever the clock says", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, NEXT_FRI_0905, openBatchWork())).toBe(0);
      expect(await runsOf(day)).toEqual([]);
      expect(await lastFiredOf(day, id)).toBeNull();
    });
  });

  it("once active, fires exactly one run past its instant, with the clock as its creator and the rutina's identity, and none again until the next instant", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, id);

      expect(await fireDueCadences(day.deps, FRI_0859, openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(1);
      const [run] = await runsOf(day);
      expect(run).toMatchObject({
        automation: "rutina",
        automation_id: id,
        created_by: "clock",
        woken_by: `clock:${String(FRI_0900.getTime())}`,
        state: "ready",
      });
      expect(await lastFiredOf(day, id)).toEqual(FRI_0900);
      // THE RUN IS A RUN LIKE ANY OTHER: its row reads back under the twin.
      expect((await readRun(day.client, day.twinId, run!.id))?.automation_id).toBe(id);

      expect(await fireDueCadences(day.deps, FRI_0930, openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, NEXT_FRI_0905, openBatchWork())).toBe(1);
      expect(await runsOf(day)).toHaveLength(2);
    });
  });

  it("a weekly cadence fires on its weekday only, and an instant before Activar never fires", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      expect(await activateRutina(day.client, { twinId: day.twinId, id })).toEqual({ retired: [] });
      // ACTIVATED ON FRIDAY AT 9:30: this Friday's nine has passed already.
      await day.client.query("UPDATE automations SET activated_at = $2 WHERE id = $1", [id, FRI_0930]);
      expect(await fireDueCadences(day.deps, new Date(FRI_0930.getTime() + 60_000), openBatchWork())).toBe(0);
      // THURSDAY IS NOT ITS DAY.
      expect(await fireDueCadences(day.deps, new Date(THU_10.getTime() + 7 * 86_400_000), openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, NEXT_FRI_0905, openBatchWork())).toBe(1);
    });
  });

  it("a daily cadence fires once each day at its hour", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, { kind: "schedule", every: "day", atHour: 9 });
      await activate(day, id);
      expect(await fireDueCadences(day.deps, THU_10, openBatchWork())).toBe(1);
      expect(await fireDueCadences(day.deps, new Date(THU_10.getTime() + 3_600_000), openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(1);
    });
  });
});

describe("a set of weekdays on one row (ticket #387)", () => {
  it("«lunes y jueves a las 9» is one row that fires on both days at nine and on no other, once each", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, MONDAYS_AND_THURSDAYS);
      await activate(day, id);
      const rows = await day.client.query("SELECT 1 FROM automations WHERE twin_id = $1 AND origin <> 'dito'", [day.twinId]);
      expect(rows.rowCount).toBe(1);
      const fired: Date[] = [];
      // THURSDAY 8 TO WEDNESDAY 21: a pass at 08:59, 09:01 and 10:00 every day.
      for (let days = 0; days < 14; days += 1) {
        for (const pass of [new Date(at0900(days).getTime() - 60_000), at0901(days), new Date(at0900(days).getTime() + 3_600_000)]) {
          const count = await fireDueCadences(day.deps, pass, openBatchWork());
          for (let i = 0; i < count; i += 1) fired.push(pass);
        }
      }
      // THURSDAY 8, MONDAY 12, THURSDAY 15, MONDAY 19 — at 09:01, once each.
      expect(fired).toEqual([at0901(0), at0901(4), at0901(7), at0901(11)]);
      expect((await runsOf(day)).map((run) => run.woken_by)).toEqual(
        [0, 4, 7, 11].map((days) => `clock:${String(at0900(days).getTime())}`),
      );
    });
  });

  it("a runtime down across a Monday and a Thursday fires the latest instant once", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, MONDAYS_AND_THURSDAYS);
      await activate(day, id);
      // DOWN FROM MONDAY 5 UNTIL FRIDAY 16: Thursday 8, Monday 12 and Thursday 15 passed unfired.
      const back = at0901(8);
      expect(await fireDueCadences(day.deps, back, openBatchWork())).toBe(1);
      expect(await fireDueCadences(day.deps, new Date(back.getTime() + 3_600_000), openBatchWork())).toBe(0);
      expect((await runsOf(day)).map((run) => run.woken_by)).toEqual([`clock:${String(at0900(7).getTime())}`]);
      expect(await lastFiredOf(day, id)).toEqual(at0900(7));
      expect(await fireDueCadences(day.deps, at0901(11), openBatchWork())).toBe(1);
    });
  });

  it("on the night the clocks go back, a Sunday 01:00 cadence fires at its instant and not the hour before, and the read says that instant (Codex r1)", async () => {
    // TIJUANA FALLS BACK ON SUNDAY 1 NOVEMBER 2026: 01:30 is read twice, and
    // the seam resolves the hour's 01:00 to 09:00Z, the second reading.
    const TIJUANA = "America/Tijuana";
    await withTwin(async (day) => {
      const sundays: RutinaWake = { kind: "schedule", every: "week", weekdays: [7], atHour: 1 };
      const id = await writeRutina(day, sundays);
      await activate(day, id);
      // ACTIVATED ON SATURDAY 31 OCTOBER: no earlier Sunday is owed.
      await day.client.query("UPDATE automations SET activated_at = $2 WHERE id = $1", [id, new Date("2026-10-31T18:00:00.000Z")]);
      const inTijuana = { ...day.deps, timeZone: TIJUANA };
      const firstReading = new Date("2026-11-01T08:30:00.000Z");
      const instant = new Date("2026-11-01T09:00:00.000Z");
      expect(await firstFiringAtOrAfter(day.client, sundays, firstReading, TIJUANA)).toEqual(instant);
      expect(await fireDueCadences(inTijuana, firstReading, openBatchWork())).toBe(0);
      expect(await fireDueCadences(inTijuana, new Date(instant.getTime() + 60_000), openBatchWork())).toBe(1);
      expect(await lastFiredOf(day, id)).toEqual(instant);
    });
  });

  it("a cadence row holds no weekday outside one to seven, and a weekly one holds at least one", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, MONDAYS_AND_THURSDAYS);
      for (const weekdays of ["{}", "{0}", "{8}", "{1,NULL}"]) {
        await expect(
          day.client.query("UPDATE schedules SET weekdays = $2::smallint[] WHERE automation_id = $1", [id, weekdays]),
        ).rejects.toThrow(/schedules_weekdays_check|schedules_cadence_check/u);
        await expect(
          day.client.query("UPDATE automations SET weekdays = $2::smallint[] WHERE id = $1", [id, weekdays]),
        ).rejects.toThrow(/automations_weekdays_check|automations_schedule_check/u);
      }
      await expect(
        day.client.query("UPDATE schedules SET weekdays = NULL WHERE automation_id = $1", [id]),
      ).rejects.toThrow(/schedules_cadence_check/u);
    });
  });
});

describe("the pause switch and the seat hold every wake (ticket #325 AC 4; ADR-0012)", () => {
  it("a paused rutina creates no run while its instant passes, and turned back on fires the next one", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, id);
      const pause = (paused: boolean) =>
        setAutomationPaused(day.client, {
          twinId: day.twinId,
          seatId: day.seatId,
          automationId: id,
          paused,
        });
      expect(await pause(true)).toBe(true);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(0);
      expect(await runsOf(day)).toEqual([]);
      // THE INSTANT PASSED WHILE PAUSED: back on, it waits for the next one.
      expect(await pause(false)).toBe(true);
      expect(await fireDueCadences(day.deps, FRI_0930, openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, NEXT_FRI_0905, openBatchWork())).toBe(1);
    });
  });

  it("a seat that is not linked fires nothing", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, id);
      await day.client.query("UPDATE seats SET state = 'invited' WHERE id = $1", [day.seatId]);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(0);
      expect(await runsOf(day)).toEqual([]);
    });
  });

  it("the switch is a fact of the gate function and of the gate's SQL: a run of a rutina paused between the read and the write does not begin its step", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, id);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(1);
      const [fired] = await runsOf(day);
      const row = (await readRun(day.client, day.twinId, fired!.id))!;

      // THE READ: unpaused, the gate says advance.
      expect(runGate(await gateFactsOf(day.client, row))).toBe("advance");
      // THE SWITCH TURNS OFF BETWEEN THE READ AND THE WRITE...
      await setAutomationPaused(day.client, {
        twinId: day.twinId,
        seatId: day.seatId,
        automationId: id,
        paused: true,
      });
      // ...AND THE WRITE REFUSES: the step does not begin.
      expect(await beginStep(day.client, { runId: row.id, step: 0, kind: "agent" })).toBe(false);
      expect(runGate(await gateFactsOf(day.client, row))).toBe("hold");
      // BACK ON, it begins.
      await setAutomationPaused(day.client, {
        twinId: day.twinId,
        seatId: day.seatId,
        automationId: id,
        paused: false,
      });
      expect(await beginStep(day.client, { runId: row.id, step: 0, kind: "agent" })).toBe(true);
    });
  });
});

describe("a trigger rutina fires on a matching seam event (ticket #325)", () => {
  it("fires one run per matching event, with the event's id and the customer's reference as inputs, and none for another event or another customer", async () => {
    await withTwin(async (day) => {
      const sergio = day.bundle.referenceForChat(SERGIO);
      const onSergio = await writeRutina(day, { kind: "trigger", event: "customer_message", customer: sergio });
      await activate(day, onSergio);
      // A PENDING TRIGGER RUTINA NEVER FIRES.
      await writeRutina(day, { kind: "trigger", event: "card_settled" });
      expect(await fireOnEvent(day.deps, { kind: "card_settled", postId: randomUUID(), outcome: "sent" }, FRI_0901)).toBe(0);

      const event = "1001";
      expect(await fireOnEvent(day.deps, { kind: "customer_message", eventId: event, chatJid: SERGIO }, FRI_0901)).toBe(1);
      // THE SAME EVENT HANDED OVER AGAIN FIRES NOTHING.
      expect(await fireOnEvent(day.deps, { kind: "customer_message", eventId: event, chatJid: SERGIO }, FRI_0901)).toBe(0);
      // ANOTHER CUSTOMER FIRES NOTHING.
      expect(await fireOnEvent(day.deps, { kind: "customer_message", eventId: "1002", chatJid: LAURA }, FRI_0901)).toBe(0);

      const runs = await runsOf(day);
      expect(runs).toEqual([
        expect.objectContaining({
          automation: "rutina",
          automation_id: onSergio,
          created_by: "trigger",
          woken_by: `event:customer_message:${event}`,
        }),
      ]);
      const content = readRunContent(
        day.deps.harness.directory,
        day.dek,
        runs[0]!.id,
        (await readRun(day.client, day.twinId, runs[0]!.id))!.definition_digest,
      );
      expect(content.inputs).toEqual({ event, customer: `c${String(sergio)}` });
    });
  });

  it("a card_settled rutina fires when a card settles for good, and never on a send the rail is still holding", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, { kind: "trigger", event: "card_settled" });
      await activate(day, id);
      const card = randomUUID();
      expect(await fireOnEvent(day.deps, { kind: "card_settled", postId: card, outcome: "queued" }, FRI_0901)).toBe(0);
      expect(await fireOnEvent(day.deps, { kind: "card_settled", postId: card, outcome: "sent" }, FRI_0901)).toBe(1);
      expect((await runsOf(day)).map((run) => run.woken_by)).toEqual([`event:card_settled:${card}`]);
    });
  });

  it("a paused trigger rutina fires nothing on its event", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, { kind: "trigger", event: "card_settled" });
      await activate(day, id);
      await setAutomationPaused(day.client, {
        twinId: day.twinId,
        seatId: day.seatId,
        automationId: id,
        paused: true,
      });
      expect(await fireOnEvent(day.deps, { kind: "card_settled", postId: randomUUID(), outcome: "dismissed" }, FRI_0901)).toBe(0);
      expect(await runsOf(day)).toEqual([]);
    });
  });
});

describe("a rutina's two halves stay one (ticket #325)", () => {
  it("activating a replacement ends the version it replaces, row and cadence, and names it for its content", async () => {
    await withTwin(async (day) => {
      const old = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, old);
      const next = randomUUID();
      await insertRutina(day.client, day.bundle, {
        id: next,
        twinId: day.twinId,
        seatId: day.seatId,
        origin: "rep",
        wake: { kind: "schedule", every: "day", atHour: 8 },
        definition: LIST,
        sentence: "Cada día a las 8 te mando la lista de los clientes sin contacto.",
        replacesId: old,
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
        writtenAt: ACTIVATED,
      });
      expect(await activateRutina(day.client, { twinId: day.twinId, id: next })).toEqual({ retired: [old] });
      const left = await day.client.query(
        "SELECT id FROM automations WHERE twin_id = $1 AND ended_at IS NULL",
        [day.twinId],
      );
      expect(left.rows).toEqual([{ id: next }]);
      expect(await liveCadenceRowsOf(day, old)).toEqual([]);
    });
  });

  it("two proposals to change one rutina never both end up active: activating one retires the other with the original", async () => {
    await withTwin(async (day) => {
      const old = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, old);
      const change = async (atHour: number): Promise<string> => {
        const id = randomUUID();
        await insertRutina(day.client, day.bundle, {
          id,
          twinId: day.twinId,
          seatId: day.seatId,
          origin: "rep",
          wake: { kind: "schedule", every: "day", atHour },
          definition: LIST,
          sentence: "Cada día te mando la lista de los clientes sin contacto.",
          replacesId: old,
          executionId: randomUUID(),
          evidenceRef: randomUUID(),
          writtenAt: ACTIVATED,
        });
        return id;
      };
      const first = await change(8);
      const second = await change(10);
      expect(await activateRutina(day.client, { twinId: day.twinId, id: first })).toEqual({ retired: [old, second] });
      expect(await activateRutina(day.client, { twinId: day.twinId, id: second })).toBeUndefined();
      const left = await day.client.query(
        "SELECT id, state FROM automations WHERE twin_id = $1 AND ended_at IS NULL",
        [day.twinId],
      );
      expect(left.rows).toEqual([{ id: first, state: "active" }]);
    });
  });

  it("Descartar on an active rutina ends its row, leaves its cadence row marked ended with its last firing, and cancels the runs it still has going, which end with their report at the next pass (#364)", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      await activate(day, id);
      expect(await fireDueCadences(day.deps, FRI_0901, openBatchWork())).toBe(1);
      const [fired] = await runsOf(day);
      expect(await discardRutina(day.client, { twinId: day.twinId, id })).toEqual([id]);
      const row = (await readRun(day.client, day.twinId, fired!.id))!;
      expect(row).toMatchObject({ cancelled: true, ended_at: null });
      // THE CLOCK STORE KEEPS ITS ROW (ADR-0010): marked ended, the instant it
      // last fired for still readable — and the clock fires it no more.
      const cadence = await day.client.query<{ ended_at: Date | null; last_fired_at: Date | null }>(
        "SELECT ended_at, last_fired_at FROM schedules WHERE automation_id = $1",
        [id],
      );
      expect(cadence.rows).toHaveLength(1);
      expect(cadence.rows[0]!.ended_at).not.toBeNull();
      expect(cadence.rows[0]!.last_fired_at).toEqual(FRI_0900);
      expect(await fireDueCadences(day.deps, NEXT_FRI_0905, openBatchWork())).toBe(0);
      // THE ENGINE ENDS IT AS A cancel_run's: failed, cancelled, with its report.
      const batch = openBatchWork();
      await advanceRuns(day.deps, FRI_0930, batch);
      await batch.lane.settle();
      expect(await readRun(day.client, day.twinId, fired!.id)).toMatchObject({ state: "failed", cancelled: true });
      expect(await discardRutina(day.client, { twinId: day.twinId, id })).toBeUndefined();
    });
  });

  it("the pass deletes content no row names — a write whose turn rolled back, a deletion whose bundle half never ran — and keeps the rest", async () => {
    await withTwin(async (day) => {
      const kept = await writeRutina(day, FRIDAYS_AT_NINE);
      const orphan = randomUUID();
      day.bundle.writeAutomation({
        id: orphan,
        definition: JSON.stringify(LIST),
        sentence: "Una rutina cuyo turno no llegó a quedar.",
        writtenAt: ACTIVATED.toISOString(),
        executionId: randomUUID(),
        evidenceRef: randomUUID(),
      });
      expect(await sweepRutinaContent(day.client, day.bundle, day.twinId)).toBe(1);
      expect(day.bundle.readAutomation(orphan)).toBeUndefined();
      expect(day.bundle.readAutomation(kept)).toBeDefined();
      expect(await sweepRutinaContent(day.client, day.bundle, day.twinId)).toBe(0);
    });
  });
});

async function liveCadenceRowsOf(day: Day, id: string): Promise<unknown[]> {
  return (await day.client.query("SELECT 1 FROM schedules WHERE automation_id = $1 AND ended_at IS NULL", [id])).rows;
}

describe("the first instant a cadence fires, said forward (ticket #386)", () => {
  it("is the clock's own instant: the day's hour or the weekday's, at or after the given one, in the seat's zone", async () => {
    await withTwin(async (day) => {
      const daily = { every: "day", atHour: 9 } as const;
      const fridays = { every: "week", weekdays: [5], atHour: 9 } as const;
      const first = (cadence: typeof daily | typeof fridays, from: Date) =>
        firstFiringAtOrAfter(day.client, cadence, from, ZONE);
      expect(await first(daily, THU_10)).toEqual(FRI_0900);
      expect(await first(daily, FRI_0859)).toEqual(FRI_0900);
      // AN ASK ON THE INSTANT ITSELF FIRES THAT INSTANT, as the clock does.
      expect(await first(daily, FRI_0900)).toEqual(FRI_0900);
      expect(await first(daily, FRI_0930)).toEqual(new Date("2026-10-10T15:00:00.000Z"));
      expect(await first(fridays, ACTIVATED)).toEqual(FRI_0900);
      expect(await first(fridays, FRI_0930)).toEqual(new Date("2026-10-16T15:00:00.000Z"));
    });
  });

  it("takes a set: the nearest weekday in it at or after the instant, across a week's end and past the hour on a set day (ticket #387)", async () => {
    await withTwin(async (day) => {
      const set = { every: "week", weekdays: [1, 4], atHour: 9 } as const;
      const first = (from: Date) => firstFiringAtOrAfter(day.client, set, from, ZONE);
      // THURSDAY 8 BEFORE NINE: that Thursday.
      expect(await first(new Date(at0900(0).getTime() - 3_600_000))).toEqual(at0900(0));
      // THURSDAY 8 PAST NINE, a set day: the Monday after.
      expect(await first(at0901(0))).toEqual(at0900(4));
      // FRIDAY 9 AND SUNDAY 11, across the week's end: Monday 12.
      expect(await first(FRI_0930)).toEqual(at0900(4));
      expect(await first(at0901(3))).toEqual(at0900(4));
      // MONDAY 12 PAST NINE: Thursday 15.
      expect(await first(at0901(4))).toEqual(at0900(7));
      // A SET OF ALL SEVEN IS EVERY DAY.
      expect(await firstFiringAtOrAfter(day.client, { every: "week", weekdays: [1, 2, 3, 4, 5, 6, 7], atHour: 9 }, at0901(0), ZONE)).toEqual(at0900(1));
    });
  });

  it("agrees with the clock: a rutina activated at the instant it returns fires there and not before", async () => {
    await withTwin(async (day) => {
      const id = await writeRutina(day, FRIDAYS_AT_NINE);
      expect(await activateRutina(day.client, { twinId: day.twinId, id })).toEqual({ retired: [] });
      await day.client.query("UPDATE automations SET activated_at = $2 WHERE id = $1", [id, FRI_0930]);
      const at = await firstFiringAtOrAfter(day.client, { every: "week", weekdays: [5], atHour: 9 }, FRI_0930, ZONE);
      expect(await fireDueCadences(day.deps, new Date(at.getTime() - 60_000), openBatchWork())).toBe(0);
      expect(await fireDueCadences(day.deps, new Date(at.getTime() + 60_000), openBatchWork())).toBe(1);
    });
  });
});

/**
 * THE TWIN'S WORKSPACE, VERSIONED AT EVERY STEP BOUNDARY (ticket #326; spec
 * #318 decision 35; ADR-0011 as amended).
 *
 * A run whose agent steps write and edit a document with the SDK's own file
 * tools, driven by the engine over the scripted model: real Postgres, real
 * envelope crypto, real SQLCipher, the real SDK child running the CLI's own
 * `Write` and `Edit` on the workspace directory. What is asserted is what the
 * bundle holds after each boundary, what recall finds, and what the run's
 * report carries.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial, type Dek } from "@dito/crypto";
import { workspaceOf } from "@dito/execution";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TwinRuntimeDeps } from "./consumer.js";
import { embedOne } from "./embedder.js";
import { openBatchWork } from "./lanes.js";
import { openSealedParts, type PostPart } from "./posts.js";
import type { RunDefinition } from "./runs/definition.js";
import { advanceRuns, createRunEngine, type RunEngine } from "./runs/engine.js";
import { startRun } from "./runs/start.js";
import { beginStep, readRun } from "./runs/store.js";
import { createSendLockWriter } from "./send-lock/writer.js";
import { resetAndMigrate, TEST_AUDIT_HMAC_KEY, TEST_DATABASE_URL, withClient } from "./testing/db.js";
import { seatAtTheDoor } from "./testing/door.js";
import { newExecutionPool } from "./testing/execution-pool.js";
import { fakeEmbedder } from "./testing/fake-embedder.js";
import { closeScriptedModels, scriptedModel, type ScriptedModel, type ScriptedTurn } from "./testing/scripted-model.js";
import { SETTLE_IMMEDIATELY } from "./testing/settle.js";
import { removeTmpDir } from "./testing/tmp.js";

// EVERY AGENT STEP SPAWNS A CLAUDE CODE CHILD on the run's session.
vi.setConfig({ testTimeout: 120_000 });

const executionPool = newExecutionPool();
const SELF_CHAT = "5215550000@s.whatsapp.net";
const ZONE = "America/Monterrey";
const NOW = new Date("2026-10-07T17:00:00.000Z");

let tmp: string;
let pool: pg.Pool;

beforeAll(async () => {
  await resetAndMigrate();
  tmp = mkdtempSync(join(tmpdir(), "dito-workspace-int-"));
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
});

afterAll(async () => {
  await pool.end();
  removeTmpDir(tmp);
});

afterEach(closeScriptedModels);

/** A document written in one step and edited in the next, then reported. */
const DRAFTED_THEN_REVISED: RunDefinition = {
  name: "Hoteles en Madrid",
  budget: { iterations: 12, tokens: 200_000 },
  steps: [
    {
      kind: "agent",
      name: "write",
      instructions: "Write the document into your workspace and say where it is.",
      tools: ["Write"],
      output: { path: "string" },
    },
    {
      kind: "agent",
      name: "revise",
      instructions: "Add the prices to the document and say in one line what it holds.",
      tools: ["Read", "Edit"],
      output: { path: "string", line: "string" },
    },
    { kind: "post", name: "report", text: "revise.line", document: "revise.path" },
  ],
};

const FIRST = "# Hoteles en Madrid\n\n1. Hotel Prado, junto al museo.\n";
const SECOND = "# Hoteles en Madrid\n\n1. Hotel Prado, junto al museo, desde 120 euros la noche.\n";

interface Day {
  readonly client: pg.Client;
  readonly twinId: string;
  readonly seatId: string;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly model: ScriptedModel;
  readonly deps: TwinRuntimeDeps & { readonly runs: RunEngine };
}

async function withTwin(script: (workspace: () => string) => (prompt: string) => readonly ScriptedTurn[], run: (day: Day) => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    const twinId = randomUUID();
    const dek = createDekFromMaterial(randomBytes(32));
    const bundle = createBundle(join(tmp, `${twinId}.bundle`), dek);
    const seat = await seatAtTheDoor(client, twinId);
    const model: ScriptedModel = scriptedModel(script(() => workspaceOf(model.harness)));
    const deps = {
      db: client,
      harness: model.harness,
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
      await run({ client, twinId, seatId: seat.seatId, bundle, dek, model, deps });
    } finally {
      bundle.close();
    }
  });
}

/** The model of the run above: each step's turn, read off the step's heading. */
function writesThenRevises(workspace: () => string): (prompt: string) => readonly ScriptedTurn[] {
  return (prompt) => {
    const path = join(workspace(), "hoteles.md");
    if (prompt.includes(": write]")) {
      return [{ toolCall: { name: "Write", input: { file_path: path, content: FIRST } } }, { structured: { path: "hoteles.md" } }];
    }
    if (prompt.includes(": revise]")) {
      return [
        { toolCall: { name: "Read", input: { file_path: path } } },
        { toolCall: { name: "Edit", input: { file_path: path, old_string: "junto al museo.", new_string: "junto al museo, desde 120 euros la noche." } } },
        { structured: { path, line: "Te dejé los hoteles con sus precios." } },
      ];
    }
    return [{ text: "" }];
  };
}

/** Starts the run and drives it to its end, as the pass does. */
async function runToTheEnd(day: Day, definition: RunDefinition): Promise<string> {
  const { runId } = await startRun(
    { db: day.client, twinId: day.twinId, seatId: day.seatId, dek: day.dek, harness: day.deps.harness, model: "claude-sonnet-5", timeZone: ZONE },
    { definition, inputs: { topic: "hoteles en Madrid" }, automation: "inline", creator: "thread", now: NOW },
  );
  const batch = openBatchWork();
  await advanceRuns(day.deps, NOW, batch);
  await batch.lane.settle();
  return runId;
}

/** The run's report: its sealed parts, and what the self-chat was sent. */
async function reportOf(day: Day, runId: string): Promise<{ readonly parts: readonly PostPart[]; readonly sent: string }> {
  const res = await day.client.query<{ parts_enc: Buffer; content_enc: Buffer }>(
    `SELECT p.parts_enc, n.content_enc
       FROM run_steps s JOIN posts p ON p.execution_id = s.execution_id JOIN notices n ON n.id = p.notice_id
      WHERE s.run_id = $1 AND s.kind = 'post'`,
    [runId],
  );
  const row = res.rows[0]!;
  return {
    parts: openSealedParts(day.dek, row.parts_enc),
    sent: Buffer.from(day.dek.decrypt(row.content_enc)).toString("utf8"),
  };
}

describe("the step boundary versions the workspace (ticket #326 AC 1)", () => {
  it("writes version 1 where a step wrote the document and version 2 where the next edited it, both readable by version", async () => {
    await withTwin(writesThenRevises, async (day) => {
      const runId = await runToTheEnd(day, DRAFTED_THEN_REVISED);

      expect(await readRun(day.client, day.twinId, runId)).toMatchObject({ state: "succeeded" });
      const versions = day.bundle.listWorkspaceVersions("hoteles.md");
      expect(versions.map((one) => [one.version, one.content, one.title, one.runId])).toEqual([
        [1, FIRST, "Hoteles en Madrid", runId],
        [2, SECOND, "Hoteles en Madrid", runId],
      ]);
      expect(versions[0]!.executionId).not.toBe(versions[1]!.executionId);
      expect(day.bundle.readWorkspaceVersion(versions[0]!.id)?.content).toBe(FIRST);
      // A BOUNDARY THAT CHANGED NOTHING WRITES NOTHING: the report's own
      // boundary found the document as the revision left it.
      expect(day.bundle.latestVersionOf("hoteles.md")?.version).toBe(2);
      const steps = await day.client.query<{ disposition: string }>(
        `SELECT e.disposition FROM run_steps s JOIN executions e ON e.id = s.execution_id
          WHERE s.run_id = $1 ORDER BY s.step_index`,
        [runId],
      );
      // A STEP THAT WROTE INTO THE WORKSPACE PERFORMED AN EFFECT (ADR-0013).
      expect(steps.rows.map((row) => row.disposition)).toEqual(["acted", "acted", "posted"]);
    });
  });

  it("indexes each version for recall, so the twin finds the document by what it says", async () => {
    await withTwin(writesThenRevises, async (day) => {
      await runToTheEnd(day, DRAFTED_THEN_REVISED);

      const sentence = "hoteles cerca del museo con precio por noche";
      const found = day.bundle.searchThreadItems({
        words: [],
        embedding: await embedOne(fakeEmbedder(), sentence),
        limit: 8,
      });
      expect(found.filter((item) => item.role === "workspace").map((item) => item.text)).toEqual(
        expect.arrayContaining([expect.stringContaining("desde 120 euros la noche")]),
      );
      const byWords = day.bundle.searchThreadItems({ words: ["120", "euros"], limit: 8 });
      expect(byWords.map((item) => item.text)).toEqual([expect.stringContaining("hoteles.md, version 2")]);
    });
  });
});

describe("a run's report hands the rep its document (ticket #326 AC 2)", () => {
  it("carries the document at the version the boundary took, and the phone reads its title and a line — never its text", async () => {
    await withTwin(writesThenRevises, async (day) => {
      const runId = await runToTheEnd(day, DRAFTED_THEN_REVISED);

      const second = day.bundle.latestVersionOf("hoteles.md")!;
      const report = await reportOf(day, runId);
      expect(report.parts).toEqual([
        { kind: "prose", text: "Te dejé los hoteles con sus precios." },
        { kind: "document", versionId: second.id, title: "Hoteles en Madrid", version: 2 },
      ]);
      expect(report.sent).toContain("«Hoteles en Madrid», versión 2");
      expect(report.sent).not.toContain("120 euros");
      expect(report.sent).not.toContain("hoteles.md");
    });
  });

  it("fails the report's step when the path names no document the workspace holds", async () => {
    await withTwin(
      (workspace) => (prompt) =>
        prompt.includes(": write]")
          ? [{ toolCall: { name: "Write", input: { file_path: join(workspace(), "hoteles.md"), content: FIRST } } }, { structured: { path: "hoteles.md" } }]
          : prompt.includes(": revise]")
            ? [{ structured: { path: "otro.md", line: "Te dejé los hoteles." } }]
            : [{ text: "" }],
      async (day) => {
        const runId = await runToTheEnd(day, DRAFTED_THEN_REVISED);
        expect(await readRun(day.client, day.twinId, runId)).toMatchObject({ state: "failed" });
      },
    );
  });
});

describe("a step that dies mid-way still leaves its writes versioned (ticket #326; Codex r1)", () => {
  it("versions what a step wrote before its process died, as the next process closes the run", async () => {
    await withTwin(
      () => () => [{ text: "" }],
      async (day) => {
        const { runId } = await startRun(
          { db: day.client, twinId: day.twinId, seatId: day.seatId, dek: day.dek, harness: day.deps.harness, model: "claude-sonnet-5", timeZone: ZONE },
          { definition: DRAFTED_THEN_REVISED, inputs: {}, automation: "inline", creator: "thread", now: NOW },
        );
        // THE STEP BEGAN, WROTE, AND ITS PROCESS DIED before the boundary.
        expect(await beginStep(day.client, { runId, step: 0, kind: "agent" })).toBe(true);
        mkdirSync(workspaceOf(day.model.harness), { recursive: true });
        writeFileSync(join(workspaceOf(day.model.harness), "hoteles.md"), FIRST);

        const batch = openBatchWork();
        await advanceRuns({ ...day.deps, runs: createRunEngine() }, NOW, batch);
        await batch.lane.settle();

        expect(await readRun(day.client, day.twinId, runId)).toMatchObject({ state: "failed" });
        expect(day.bundle.latestVersionOf("hoteles.md")).toMatchObject({ version: 1, content: FIRST, runId });
      },
    );
  });
});

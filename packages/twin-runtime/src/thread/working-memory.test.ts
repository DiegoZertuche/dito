/**
 * THE TWIN WRITES ITS OWN NOTES — the tool's input, its refusals and how a
 * matter's reference becomes a stable id (ticket #322; spec #318 decisions 2
 * and 32).
 *
 * REAL SQLCIPHER (ADR-0028): the claims are about what the store holds after
 * a call. A matter named by a post id reads Postgres, which is the
 * integration suite's; every subject here is a customer's reference (#321) or
 * an entity id, so no row of the seam is touched.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createBundle, WORKING_MEMORY_CAP, type Bundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import type { EffectOutcome, TwinThreadEventTrigger } from "@dito/execution";
import { describe, expect, it } from "vitest";
import { RECEIPTS } from "../grammar.js";
import { FIXTURE_SELF_CHAT, FIXTURE_TWIN_ID, threadDeps } from "../testing/thread-deps.js";
import { useTmpDirs } from "../testing/tmp.js";
import { ActSlot } from "./acts.js";
import type { ThreadDeps } from "./deps.js";
import { customersOf } from "./references.js";
import { ServedHits } from "./served.js";
import {
  WORKING_MEMORY_ACT,
  WRITE_WORKING_MEMORY_DECLARATION,
  writeWorkingMemoryTool,
} from "./working-memory.js";

const tmpDir = useTmpDirs("dito-thread-working-memory-");

const TORRES_CHAT = "5215550001@s.whatsapp.net";
const TORRES = "0e2c7a52-0000-4000-8000-0000000000aa";
const STRANGER_CHAT = "5215550009@s.whatsapp.net";
const CARD = "0e2c7a52-0000-4000-8000-0000000000bb";

/** Torres confirmed (reference 1) and a stranger nobody confirmed (reference 2). */
function bundle(): Bundle {
  const made = createBundle(join(tmpDir(), "twin.bundle"), createDekFromMaterial(randomBytes(32)));
  made.confirmChatBinding({
    chatJid: TORRES_CHAT,
    entityId: TORRES,
    displayName: "Torres",
    confirmedAt: "2026-10-01T17:00:00.000Z",
  });
  made.referenceForChat(STRANGER_CHAT);
  return made;
}

/** A turn over that bundle, its customers named by their references. */
function turn(overrides: Partial<ThreadDeps> = {}): ThreadDeps {
  const twin = overrides.bundle ?? bundle();
  return threadDeps({
    bundle: twin,
    served: new ServedHits(customersOf(twin, FIXTURE_SELF_CHAT)),
    acts: new ActSlot(),
    ...overrides,
  });
}

async function write(deps: ThreadDeps, input: unknown): Promise<EffectOutcome> {
  return await writeWorkingMemoryTool(deps).run(input);
}

describe("write_working_memory (ticket #322)", () => {
  it("is declared disclosed-and-undoable-after and takes no evidence", () => {
    expect(WRITE_WORKING_MEMORY_DECLARATION.gate).toBe("disclosed-and-undoable-after");
    expect(Object.keys(WRITE_WORKING_MEMORY_DECLARATION.inputSchema.properties ?? {})).toEqual([
      "text",
      "matters",
      "based_on",
      "rep_asked",
    ]);
  });

  it("writes the whole prose and list as a version, each matter about the entity behind its reference", async () => {
    const deps = turn();
    const outcome = await write(deps, {
      text: "[c1] espera saber cuándo sale su pedido.",
      based_on: 0,
      matters: [
        { label: "[c1], el pedido", about: "[c1]" },
        { label: "lo que preguntó", about: "c1" },
        { label: "su cuenta", about: TORRES },
      ],
    });
    expect(outcome).toEqual({
      performed: true,
      act: WORKING_MEMORY_ACT,
      told: JSON.stringify({ outcome: "written", version: 1, chars: 40, matters: 3 }),
    });
    // THE PROSE KEEPS THE REFERENCE, which is the customer's for good, and
    // each matter stores the entity id behind it — never the number.
    expect(deps.bundle.readWorkingMemory()).toMatchObject({
      version: 1,
      text: "[c1] espera saber cuándo sale su pedido.",
      matters: [
        { label: "[c1], el pedido", about: { kind: "entity", id: TORRES } },
        { label: "lo que preguntó", about: { kind: "entity", id: TORRES } },
        { label: "su cuenta", about: { kind: "entity", id: TORRES } },
      ],
    });
  });

  it("claims no act slot, so a turn that acted can still note it", async () => {
    const deps = turn();
    deps.acts.claim("dismiss_draft");
    expect((await write(deps, { text: "Descartó el borrador.", based_on: 0, matters: [] })).performed).toBe(true);
  });

  it("refuses a reference that names nothing, or a conversation nobody confirmed, and writes nothing", async () => {
    const deps = turn();
    // c9 names nobody; c2 is a chat nobody confirmed; a bare number and a name
    // are not references.
    for (const about of ["c9", "[c2]", "1", "Torres"]) {
      const outcome = await write(deps, { text: "x", based_on: 0, matters: [{ label: "algo", about }] });
      expect(outcome.performed, about).toBe(false);
      expect(outcome.told, about).toMatch(/^refused: .* is not a customer the rep confirmed or a post of yours/u);
    }
    expect(deps.bundle.readWorkingMemory()).toBeUndefined();
  });

  it("refuses a reference that names no customer", async () => {
    const outcome = await write(turn(), { text: "[c9] espera", based_on: 0, matters: [] });
    expect(outcome).toEqual({
      performed: false,
      told: "refused: [c9] names no customer — use a customer's reference as you were given it, or leave the name out.",
    });
  });

  it("refuses an input of the wrong shape with what the shape is", async () => {
    expect((await write(turn(), { text: 3, based_on: 0, matters: [] })).told).toMatch(/^refused: `text`/u);
    expect((await write(turn(), { text: "x", based_on: 0, matters: [{ label: "y" }] })).told).toMatch(
      /^refused: `matters`/u,
    );
  });

  it("refuses a write over the cap with the notes that stand, and appends nothing", async () => {
    const deps = turn();
    await write(deps, { text: "Torres espera.", based_on: 0, matters: [{ label: "Torres", about: "c1" }] });
    const outcome = await write(deps, { text: "a".repeat(WORKING_MEMORY_CAP + 1), based_on: 1, matters: [] });
    expect(outcome.performed).toBe(false);
    expect(JSON.parse(outcome.told)).toMatchObject({
      outcome: "over_cap",
      cap: 2000,
      chars_attempted: 2001,
      current_version: 1,
      current_text: "Torres espera.",
      current_matters: [{ label: "Torres", about: TORRES }],
    });
    expect(deps.bundle.readWorkingMemory()?.version).toBe(1);
  });

  it("refuses a rewrite of a version the store has moved past, with the notes that stand (Codex r1)", async () => {
    const deps = turn();
    await write(deps, { text: "Torres espera.", based_on: 0, matters: [{ label: "Torres", about: "c1" }] });
    // A WAKE THAT WAS SHOWN VERSION 0 rewrites from it, after version 1 landed.
    const outcome = await write(deps, { text: "Garza espera.", based_on: 0, matters: [] });
    expect(outcome.performed).toBe(false);
    expect(JSON.parse(outcome.told)).toMatchObject({
      outcome: "stale",
      current_version: 1,
      current_text: "Torres espera.",
      current_matters: [{ label: "Torres", about: TORRES }],
    });
    expect(deps.bundle.readWorkingMemory()?.version).toBe(1);
  });

  it("owes the rep a receipt only when the model says their line asked for it", async () => {
    expect((await write(turn(), { text: "x", based_on: 0, matters: [] })).receipt).toBeUndefined();
    expect((await write(turn(), { text: "x", based_on: 0, matters: [], rep_asked: true })).receipt).toBe(
      RECEIPTS.workingMemoryWritten,
    );
  });

  it("writes on a turn an event woke — no rep line, no evidence, and no receipt to fold", async () => {
    const event: TwinThreadEventTrigger = {
      kind: "twin_thread_event",
      mechanism: "seam_event",
      twinId: FIXTURE_TWIN_ID,
      event: "post.settled",
      postId: CARD,
    };
    const deps = turn({ trigger: event });
    const outcome = await write(deps, {
      text: "Torres ya recibió su pedido.",
      based_on: 0,
      matters: [],
      rep_asked: true,
    });
    expect(outcome).toMatchObject({ performed: true, act: WORKING_MEMORY_ACT });
    expect(outcome.receipt).toBeUndefined();
    expect(deps.bundle.readWorkingMemory()?.text).toBe("Torres ya recibió su pedido.");
  });
});

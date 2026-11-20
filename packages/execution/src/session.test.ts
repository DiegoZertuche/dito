/**
 * The session shape, over the scripted model server (ticket #319; spec #318
 * decisions 8 and 14; ADR-0028 as amended — "CI never makes a real model
 * call").
 *
 * Every case drives the REAL Claude Agent SDK in streaming-input mode and the
 * REAL Claude Code child it keeps up between turns; only the model is
 * scripted. What is asserted is what the session's caller sees — each wake's
 * settlement, its record and its one audit entry — and what the session
 * file and the fake's requests say the model read.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  closeScriptedModels,
  scriptedModel,
  toolNamesOf,
  transcriptOf,
  type ScriptedTurn,
} from "@dito/scripted-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineExecution, type ExecutionDefinition } from "./definition.js";
import { sessionFile, workspaceOf, type Harness } from "./harness.js";
import {
  openSession,
  sessionShapeOf,
  type Session,
  type SessionHooks,
  type SessionStart,
} from "./session.js";
import { recordingChain } from "./testing/chain.js";
import { defineTool } from "./tool.js";
import type { Trigger } from "./trigger.js";

// A SESSION SPAWNS A CLAUDE CODE CHILD and keeps it up; a resume or a fork
// spawns another. Several seconds on a cold machine.
vi.setConfig({ testTimeout: 90_000 });

const open: Session<string>[] = [];

afterEach(async () => {
  // NO CHILD OUTLIVES A CASE: every session a case opened is closed here,
  // whatever the case asserted.
  await Promise.all(open.splice(0).map((session) => session.close()));
  closeScriptedModels();
});

const TRIGGER: Trigger = {
  kind: "owner_question",
  mechanism: "request",
  companyId: "11111111-1111-4111-8111-111111111111",
  ownerQuestionId: "22222222-2222-4222-8222-222222222222",
};

/** A turn here ends on its words, so its typed result is nothing. */
type Answer = undefined;

/**
 * A tool the case can hold open: its call waits on a promise the case
 * resolves, which is how a line is pushed WHILE a turn runs. The fake serves
 * turns and never sleeps; the hold is the case's own.
 */
class Hold {
  readonly #open: boolean;
  #release: (() => void) | undefined;
  #entered: (() => void) | undefined;
  readonly entered = new Promise<void>((resolve) => {
    this.#entered = resolve;
  });
  readonly tool = defineTool({
    name: "hold",
    description: "Waits until the case lets it go.",
    gate: "projection",
    columns: ["held"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      this.#entered?.();
      if (!this.#open) {
        await new Promise<void>((resolve) => {
          this.#release = resolve;
        });
      }
      return '{"held":true}';
    },
  });

  /** An open hold returns at once: a tool call that costs a round and nothing else. */
  constructor(open = false) {
    this.#open = open;
  }

  release(): void {
    this.#release?.();
  }
}

const NOTHING_HELD = new Hold(true);

/**
 * One wake's definition: the session's standing shape, and the wake's line as
 * its context. A turn ends on its words; `fails` makes the definition unable
 * to read how its turn ended, which settles the turn `failed`.
 */
function definition(
  wake: string,
  options: { readonly hold?: Hold; readonly maxIterations?: number; readonly fails?: true } = {},
): ExecutionDefinition<Answer> {
  return defineExecution<Answer>({
    instructions: [{ name: "who you are", text: "You answer the rep." }],
    tools: [(options.hold ?? NOTHING_HELD).tool],
    context: [{ name: "wake", text: wake }],
    recipes: [],
    budget: {
      model: "claude-sonnet-5",
      maxIterations: options.maxIterations ?? 4,
      maxTokens: 1024,
    },
    lane: "realtime",
    wake: { kind: "trigger", mechanism: "request", occasion: "owner_question" },
    dispositionOf: () => {
      if (options.fails === true) throw new Error("this turn cannot be read");
      return "answered";
    },
  });
}

/** A wake's message as the model reads it: the definition's one context part, rendered. */
function said(wake: string): string {
  return `## wake\n\n${wake}`;
}

/** One turn that answers: the model's words, which end it. */
function answering(prose: string): ScriptedTurn[] {
  return [{ text: prose }];
}

function session(
  harness: Harness,
  start: SessionStart,
  hooks: SessionHooks = {},
): Session<string> {
  const opened = openSession<string>({
    harness,
    shape: sessionShapeOf(definition("")),
    start,
    hooks,
  });
  open.push(opened);
  return opened;
}

/** The conversation file's entries, as the child wrote them. */
function entriesOf(
  harness: Harness,
  sessionId: string,
): { type: string; uuid?: string; message?: { content?: unknown } }[] {
  return readFileSync(sessionFile(harness.directory, sessionId), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
}

/** Every user prompt the file holds, as text. */
function promptsIn(harness: Harness, sessionId: string): string[] {
  return entriesOf(harness, sessionId)
    .filter((entry) => entry.type === "user")
    .map((entry) => entry.message?.content)
    .filter((content): content is string => typeof content === "string");
}

describe("one conversation, one execution per turn", () => {
  it("answers each wake as its own execution, and the second turn reads the first natively", async () => {
    const model = scriptedModel([...answering("uno"), ...answering("dos")]);
    const id = randomUUID();
    const day = session(model.harness, { kind: "new", sessionId: id });
    const chain = recordingChain();

    const first = await day.wake({
      trigger: TRIGGER,
      definition: definition("line one"),
      chain: chain.chain,
      tag: "first",
    });
    const second = await day.wake({
      trigger: TRIGGER,
      definition: definition("line two"),
      chain: chain.chain,
      tag: "second",
    });

    expect(first.kind).toBe("ran");
    expect(second.kind).toBe("ran");
    if (first.kind !== "ran" || second.kind !== "ran") return;
    expect(first.outcome.words).toBe("uno");
    expect(second.outcome.words).toBe("dos");
    // TWO EXECUTIONS, TWO ENTRIES, each turn's own spend.
    expect(chain.entries).toHaveLength(2);
    expect(first.outcome.record.iterations).toBe(1);
    expect(second.outcome.record.iterations).toBe(1);
    // ONE FILE, ONE ID, both lines in it.
    expect(day.sessionId).toBe(id);
    expect(existsSync(sessionFile(model.harness.directory, id))).toBe(true);
    expect(promptsIn(model.harness, id)).toEqual([said("line one"), said("line two")]);
    // The second turn's first request carries the first exchange as messages.
    const secondTurn = model.requests[1];
    expect(transcriptOf(secondTurn).slice(0, 3)).toEqual([
      { role: "user", text: said("line one") },
      { role: "assistant", text: "uno" },
      { role: "user", text: said("line two") },
    ]);
  });

  it("appends without a turn: no model call, and the next turn reads it", async () => {
    const model = scriptedModel(answering("visto"));
    const day = session(model.harness, { kind: "new", sessionId: randomUUID() });

    await day.append("event post.seen");
    expect(model.requests).toHaveLength(0);

    const settled = await day.wake({
      trigger: TRIGGER,
      definition: definition("line"),
      chain: recordingChain().chain,
      tag: "line",
    });

    expect(settled.kind).toBe("ran");
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(transcriptOf(model.requests[0]))).toContain("event post.seen");
  });

  it("holds a turn's budget per turn: the cap counts one turn's calls and starts again with the next", async () => {
    // Two calls in the first turn under a cap of two, and the model never
    // stops: it hits the cap and fails. The second turn's two calls are its own
    // budget, not what was left of the day.
    const model = scriptedModel([
      { toolCall: { name: "hold", input: {} } },
      { toolCall: { name: "hold", input: {} } },
      ...answering("después"),
    ]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("", { maxIterations: 2 })),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);

    const capped = await day.wake({
      trigger: TRIGGER,
      definition: definition("spend it all", { maxIterations: 2 }),
      chain: recordingChain().chain,
      tag: "capped",
    });
    const after = await day.wake({
      trigger: TRIGGER,
      definition: definition("and again", { maxIterations: 2 }),
      chain: recordingChain().chain,
      tag: "after",
    });

    expect(capped.kind).toBe("failed");
    if (capped.kind === "failed") {
      expect(capped.error.record.iterations).toBe(2);
      expect(capped.error.message).toContain("within a budget of 2 iterations");
    }
    expect(after.kind).toBe("ran");
  });

  it("refuses a wake whose definition is not the shape the session opened with", async () => {
    const model = scriptedModel([]);
    const day = session(model.harness, { kind: "new", sessionId: randomUUID() });
    const other = defineExecution<Answer>({
      ...definition("x"),
      instructions: [{ name: "who you are", text: "Someone else." }],
    });

    await expect(
      day.wake({
        trigger: TRIGGER,
        definition: other,
        chain: recordingChain().chain,
        tag: "x",
      }),
    ).rejects.toThrow(/this turn's instructions is not the session's/);
  });
});

describe("the fold: a line pushed while a turn runs", () => {
  it("lands at the next tool boundary, and the turn's one result settles both wakes — one record", async () => {
    const hold = new Hold();
    const model = scriptedModel([
      { toolCall: { name: "hold", input: {} } },
      ...answering("las dos"),
    ]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("", { hold })),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);
    const chain = recordingChain();

    const first = day.wake({
      trigger: TRIGGER,
      definition: definition("first line", { hold }),
      chain: chain.chain,
      tag: "first",
    });
    await hold.entered;
    const second = day.wake({
      trigger: TRIGGER,
      definition: definition("second line", { hold }),
      chain: chain.chain,
      tag: "second",
    });
    // Give the child the line before the tool returns.
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();

    const [owner, folded] = await Promise.all([first, second]);
    expect(owner.kind).toBe("ran");
    if (owner.kind === "ran") expect(owner.folded).toEqual(["second"]);
    expect(folded).toEqual({ kind: "folded", into: "first", failed: false });
    expect(chain.entries).toHaveLength(1);
    // The model was shown the second line inside the first turn.
    expect(JSON.stringify(model.requests[1])).toContain("second line");
  });

  it("gives a `later` wake a turn of its own after the running one", async () => {
    const hold = new Hold();
    const model = scriptedModel([
      { toolCall: { name: "hold", input: {} } },
      ...answering("primero"),
      ...answering("el evento"),
    ]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("", { hold })),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);

    const first = day.wake({
      trigger: TRIGGER,
      definition: definition("first line", { hold }),
      chain: recordingChain().chain,
      tag: "first",
    });
    await hold.entered;
    const event = day.wake({
      trigger: TRIGGER,
      definition: definition("event post.landed", { hold }),
      chain: recordingChain().chain,
      tag: "event",
      priority: "later",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();

    const [ran, own] = await Promise.all([first, event]);
    expect(ran.kind === "ran" && ran.folded).toEqual([]);
    expect(own.kind).toBe("ran");
    if (own.kind === "ran") expect(own.outcome.words).toBe("el evento");
  });
});

describe("a turn's record says when it began on the session (ticket #358)", () => {
  it("a line begins at hand-over on an idle session, before its model call; a `later` wake behind it begins after that turn ended", async () => {
    const hold = new Hold();
    const seen: Date[] = [];
    const model = scriptedModel(
      [
        { toolCall: { name: "hold", input: {} } },
        ...answering("primero"),
        ...answering("el evento"),
      ],
      {
        // The model is slow to answer: a stamp taken at its first frame would
        // land after this wait, a stamp taken at the grant lands before it.
        onRequest: async () => {
          seen.push(new Date());
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
    );
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("", { hold })),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);

    const first = day.wake({
      trigger: TRIGGER,
      definition: definition("first line", { hold }),
      chain: recordingChain().chain,
      tag: "first",
    });
    await hold.entered;
    const event = day.wake({
      trigger: TRIGGER,
      definition: definition("event post.landed", { hold }),
      chain: recordingChain().chain,
      tag: "event",
      priority: "later",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();

    const [ran, own] = await Promise.all([first, event]);
    if (ran.kind !== "ran" || own.kind !== "ran") throw new Error("both turns were expected to run");
    // THE FIRST FOUND THE SESSION IDLE: it began when handed over, before the
    // model saw its first request.
    expect(ran.outcome.record.startedAt.getTime()).toBeLessThanOrEqual(seen[0]!.getTime());
    // THE EVENT WAITED BEHIND IT: handed over 300 ms before the first turn
    // ended, its record says it began after that turn ended — at its own
    // first frame, since a `later` wake is granted only when the child shows
    // it running (a line pushed beside it would have run first).
    expect(own.outcome.record.startedAt.getTime()).toBeGreaterThanOrEqual(
      ran.outcome.record.endedAt.getTime(),
    );
    expect(own.outcome.record.startedAt.getTime()).toBeGreaterThanOrEqual(seen[2]!.getTime());
  });

  it("two wakes handed to an idle session in one tick — an event, then a line — record in the order the child ran them", async () => {
    const model = scriptedModel([...answering("primero"), ...answering("segundo")]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("")),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);

    // THE EVENT IS HANDED OVER FIRST, the line right behind it, before the
    // child has shown either running — the shape of the thread-day flake
    // («queues a pick made while the rep's own line is answered»): whichever
    // the child runs first, the two records must say so.
    const event = day.wake({
      trigger: TRIGGER,
      definition: definition("event matter.picked"),
      chain: recordingChain().chain,
      tag: "event",
      priority: "later",
    });
    const line = day.wake({
      trigger: TRIGGER,
      definition: definition("a line of the rep's"),
      chain: recordingChain().chain,
      tag: "line",
    });
    const [ev, ln] = await Promise.all([event, line]);
    if (ev.kind !== "ran" || ln.kind !== "ran") throw new Error("both turns were expected to run");
    const byEnd = [ev.outcome.record, ln.outcome.record].sort(
      (a, b) => a.endedAt.getTime() - b.endedAt.getTime(),
    );
    const first = byEnd[0]!;
    const second = byEnd[1]!;
    expect(second.startedAt.getTime()).toBeGreaterThanOrEqual(first.endedAt.getTime());
    expect(first.startedAt.getTime()).toBeLessThanOrEqual(second.startedAt.getTime());
  });
});

describe("a line never folds into a turn an event began", () => {
  it("waits behind the event's turn for one of its own", async () => {
    const hold = new Hold();
    const model = scriptedModel([
      { toolCall: { name: "hold", input: {} } },
      ...answering("el evento"),
      ...answering("la línea"),
    ]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("", { hold })),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);
    const event = day.wake({
      trigger: TRIGGER,
      definition: definition("event post.landed", { hold }),
      chain: recordingChain().chain,
      tag: "event",
      priority: "later",
    });
    await hold.entered;
    const line = day.wake({
      trigger: TRIGGER,
      definition: definition("a rep line", { hold }),
      chain: recordingChain().chain,
      tag: "line",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();

    const [byEvent, byLine] = await Promise.all([event, line]);
    expect(byEvent.kind === "ran" && byEvent.folded).toEqual([]);
    expect(byLine.kind).toBe("ran");
    if (byLine.kind === "ran") expect(byLine.outcome.words).toBe("la línea");
  });
});

describe("a failed turn is not kept", () => {
  it("keeps an event the failed turn had taken in, and leaves nothing waiting (Codex r3)", async () => {
    const hold = new Hold();
    const model = scriptedModel([
      ...answering("bien"),
      { toolCall: { name: "hold", input: {} } },
      { text: "a turn its definition cannot read" },
    ]);
    const refusals: string[] = [];
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(definition("", { hold })),
      start: { kind: "new", sessionId: randomUUID() },
      hooks: { refused: (evidence) => refusals.push(evidence) },
    });
    open.push(day);
    await day.wake({
      trigger: TRIGGER,
      definition: definition("good line", { hold }),
      chain: recordingChain().chain,
      tag: "good",
    });
    const failing = day.wake({
      trigger: TRIGGER,
      definition: definition("failing line", { hold, fails: true }),
      chain: recordingChain().chain,
      tag: "bad",
    });
    await hold.entered;
    const appended = day.append("event during the failing turn");
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold.release();

    expect((await failing).kind).toBe("failed");
    // THE APPEND RESOLVES — the pass awaiting it is not left waiting.
    await appended;
    // THE EVENT IS NOT LOST. The failed turn had folded it in, so the cut
    // would discard more than the turn and the CLI refuses it — the SDK's
    // documented case — and the plain resume keeps the event where it is.
    expect(refusals).toHaveLength(1);
    expect(readFileSync(sessionFile(model.harness.directory, day.sessionId), "utf8")).toContain(
      "event during the failing turn",
    );
  });

  it("forks the conversation without it into a new id, and the next turn reads only what was kept", async () => {
    const model = scriptedModel([
      ...answering("bien"),
      // The second turn's definition cannot read how it ended: a failed execution.
      { text: "a turn its definition cannot read" },
      ...answering("de nuevo"),
    ]);
    const id = randomUUID();
    const moved: [string, string][] = [];
    const day = session(
      model.harness,
      { kind: "new", sessionId: id },
      { moved: (to, from) => moved.push([to, from]) },
    );

    const good = await day.wake({
      trigger: TRIGGER,
      definition: definition("good line"),
      chain: recordingChain().chain,
      tag: "good",
    });
    const bad = await day.wake({
      trigger: TRIGGER,
      definition: definition("failing line", { fails: true }),
      chain: recordingChain().chain,
      tag: "bad",
    });
    const again = await day.wake({
      trigger: TRIGGER,
      definition: definition("line after"),
      chain: recordingChain().chain,
      tag: "again",
    });

    expect(good.kind).toBe("ran");
    expect(bad.kind).toBe("failed");
    expect(again.kind).toBe("ran");
    expect(moved).toEqual([[day.sessionId, id]]);
    expect(day.sessionId).not.toBe(id);
    // The forked file holds the kept turn and the next one, and nothing of the failed one.
    expect(promptsIn(model.harness, day.sessionId)).toEqual([said("good line"), said("line after")]);
    expect(JSON.stringify(model.requests.at(-1))).not.toContain("failing line");
  });

  it("resumes plainly when the CLI refuses the cut, keeping the evidence — never retrying the fork", async () => {
    const model = scriptedModel([...answering("uno"), ...answering("dos")]);
    const id = randomUUID();
    const kept: string[] = [];
    const first = session(
      model.harness,
      { kind: "new", sessionId: id },
      { kept: (through) => kept.push(through) },
    );
    await first.wake({
      trigger: TRIGGER,
      definition: definition("line one"),
      chain: recordingChain().chain,
      tag: "one",
    });
    await first.append("event appended after it");
    await first.close();
    const [afterTurn, afterAppend] = kept;
    expect(afterAppend).toBeDefined();

    // A cut before the append, declaring a turn that is not there: the
    // discarded range holds the append, which the CLI refuses to drop.
    const refusals: string[] = [];
    const resumed = session(
      model.harness,
      {
        kind: "resume",
        sessionId: id,
        truncate: { keptThrough: afterTurn!, dropsTurn: randomUUID() },
      },
      { refused: (evidence) => refusals.push(evidence) },
    );
    const settled = await resumed.wake({
      trigger: TRIGGER,
      definition: definition("line two"),
      chain: recordingChain().chain,
      tag: "two",
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^Resume rejected by --resume-drops-turn:/);
    expect(settled.kind).toBe("ran");
    expect(resumed.sessionId).toBe(id);
    expect(promptsIn(model.harness, id)).toEqual([
      said("line one"),
      "event appended after it",
      said("line two"),
    ]);
  });
});

describe("a conversation that is not on disk", () => {
  it("is started anew under a new id, which the owner is told, rather than resumed for ever", async () => {
    const model = scriptedModel(answering("de nuevo"));
    const missing = randomUUID();
    const moved: [string, string][] = [];
    const day = session(
      model.harness,
      { kind: "resume", sessionId: missing },
      { moved: (to, from) => moved.push([to, from]) },
    );

    const settled = await day.wake({
      trigger: TRIGGER,
      definition: definition("a line"),
      chain: recordingChain().chain,
      tag: "line",
    });

    expect(settled.kind).toBe("ran");
    expect(moved).toEqual([[day.sessionId, missing]]);
    expect(promptsIn(model.harness, day.sessionId)).toEqual([said("a line")]);
  });
});

describe("a harness that cannot start a child", () => {
  it("breaks an append's promise rather than leaving it waiting for ever (Codex r1)", async () => {
    const model = scriptedModel([]);
    const day = session(
      { ...model.harness, executable: "/usr/bin/false" },
      { kind: "new", sessionId: randomUUID() },
    );

    await expect(day.append("event post.seen")).rejects.toThrow(/could not start/u);
    expect(day.busy).toBe(false);
  });
});

describe("a child that dies between turns", () => {
  /** The Claude Code binary the SDK ships for this platform. */
  function bundledClaude(): string {
    const sdk = realpathSync(
      createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
    );
    return join(
      dirname(dirname(sdk)),
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
  }

  it("is resumed under the same id, with every earlier item intact", async () => {
    const model = scriptedModel([...answering("antes"), ...answering("después")]);
    // THE CHILD WRITES ITS OWN PID, so the case kills exactly the process the
    // session holds and no other.
    const recorder = join(model.harness.directory, "record-pid.sh");
    writeFileSync(
      recorder,
      `#!/bin/sh\necho $$ >> "$HOME/child.pids"\nexec "${bundledClaude()}" "$@"\n`,
    );
    chmodSync(recorder, 0o755);
    const harness = { ...model.harness, executable: recorder };
    const id = randomUUID();
    const day = session(harness, { kind: "new", sessionId: id });

    await day.wake({
      trigger: TRIGGER,
      definition: definition("before the kill"),
      chain: recordingChain().chain,
      tag: "before",
    });
    const before = entriesOf(harness, id).filter((entry) => entry.uuid !== undefined);
    const pid = Number(
      readFileSync(join(harness.directory, "child.pids"), "utf8").trim().split("\n")[0],
    );
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await day.wake({
      trigger: TRIGGER,
      definition: definition("after the kill"),
      chain: recordingChain().chain,
      tag: "after",
    });

    expect(after.kind).toBe("ran");
    // ...a turn of its own, its rounds read off the resumed child's stream.
    expect(after.kind === "ran" && after.outcome.record.iterations).toBe(1);
    expect(day.sessionId).toBe(id);
    const pids = readFileSync(join(harness.directory, "child.pids"), "utf8").trim().split("\n");
    expect(pids).toHaveLength(2);
    const now = entriesOf(harness, id).filter((entry) => entry.uuid !== undefined);
    expect(now.slice(0, before.length).map((entry) => entry.uuid)).toEqual(
      before.map((entry) => entry.uuid),
    );
    expect(promptsIn(harness, id)).toEqual([said("before the kill"), said("after the kill")]);
  });
});

/**
 * A SESSION'S TURN ON THE SDK'S OWN TOOLS AND ITS TYPED RESULT (ticket
 * #326): the child lists the SDK tools its shape names, holds
 * the file tools to the workspace whichever turn runs, and hands a typed
 * result the turn's rule refuses back to the model to answer again.
 */
describe("a session's turn on the workspace, ending on a typed result", () => {
  interface Located {
    readonly path: string;
  }

  function locating(wake: string): ExecutionDefinition<Located> {
    return defineExecution<Located>({
      instructions: [{ name: "the step", text: "Write the document and say where it is." }],
      tools: [],
      sdkTools: ["Read", "Write", "Edit"],
      outputFormat: {
        schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        parse: (output) => {
          const path = (output as Partial<Located> | null)?.path;
          return typeof path === "string" && path.endsWith(".md")
            ? { ok: true, submission: { path } }
            : { ok: false, reason: "`path` names the Markdown file you wrote" };
        },
      },
      context: [{ name: "wake", text: wake }],
      recipes: [],
      budget: { model: "claude-sonnet-5", maxIterations: 6, maxTokens: 1024 },
      lane: "batch",
      wake: { kind: "trigger", mechanism: "request", occasion: "owner_question" },
      dispositionOf: (_output, _handled, ending) => (ending.effects.some((effect) => effect.performed) ? "acted" : "answered"),
    });
  }

  it("denies a write outside the workspace, lands one inside, and asks again for a result its rule refuses", async () => {
    const model = scriptedModel((): ScriptedTurn[] => [
      { toolCall: { name: "Write", input: { file_path: "/tmp/fuera-del-espacio.md", content: "x" } } },
      { toolCall: { name: "Write", input: { file_path: join(workspaceOf(model.harness), "notas.md"), content: "# Notas\n" } } },
      { structured: { path: "notas" } },
      { structured: { path: "notas.md" } },
    ]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(locating("")),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);
    const calls: string[] = [];

    const settled = await day.wake({
      trigger: TRIGGER,
      definition: locating("ármame las notas"),
      chain: recordingChain().chain,
      tag: "turn",
      trace: (event) => {
        if (event.kind === "tool_call") calls.push(`${event.tool} ${event.outcome}`);
      },
    });

    expect(settled.kind).toBe("ran");
    if (settled.kind !== "ran") return;
    expect(settled.outcome.submission).toEqual({ path: "notas.md" });
    expect(settled.outcome.record.disposition).toBe("acted");
    expect(settled.outcome.record.toolNames).toEqual(["Read", "Write", "Edit"]);
    expect(calls).toEqual(["Write rejected", "Write performed", "StructuredOutput rejected", "StructuredOutput recorded"]);
    expect(existsSync("/tmp/fuera-del-espacio.md")).toBe(false);
    expect(readFileSync(join(workspaceOf(model.harness), "notas.md"), "utf8")).toBe("# Notas\n");
    for (const request of model.requests) {
      expect(toolNamesOf(request).sort()).toEqual(["Edit", "Read", "StructuredOutput", "Write"]);
    }
  });

  it("denies a turn an SDK tool the child lists and the turn was not given (Codex r1)", async () => {
    const model = scriptedModel((): ScriptedTurn[] => [
      { toolCall: { name: "Write", input: { file_path: join(workspaceOf(model.harness), "notas.md"), content: "# Notas\n" } } },
      { structured: { path: "notas.md" } },
    ]);
    const day = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(locating("")),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(day);
    const calls: string[] = [];
    const reading = defineExecution<Located>({ ...locating("léeme las notas"), sdkTools: ["Read"] });

    const settled = await day.wake({
      trigger: TRIGGER,
      definition: reading,
      chain: recordingChain().chain,
      tag: "turn",
      trace: (event) => {
        if (event.kind === "tool_call") calls.push(`${event.tool} ${event.outcome}`);
      },
    });

    expect(settled.kind).toBe("ran");
    expect(calls).toEqual(["Write rejected", "StructuredOutput recorded"]);
    expect(existsSync(join(workspaceOf(model.harness), "notas.md"))).toBe(false);
    expect(settled.kind === "ran" && settled.outcome.record.toolNames).toEqual(["Read"]);
  });
});

describe("a tool that ends the turn (ticket #401)", () => {
  /** The SDK's own prompt after a turn that ended with no words, as 0.3.288 words it. */
  const NUDGE = "no visible output";

  /** An effect that ends the turn once it performs — and refuses when `refuses` says so. */
  function quiet(refuses: () => boolean) {
    return defineTool({
      name: "say_here",
      description: "Says one sentence where the rep is, and ends the turn.",
      gate: "disclosed-and-undoable-after",
      endsTurn: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => (refuses() ? { performed: false, told: "refused: not here" } : { performed: true, act: "said", told: "said" }),
    });
  }

  /** A projection that ends the turn: nothing to say. */
  const NOTHING = defineTool({
    name: "nothing_to_say",
    description: "Ends the turn with nothing posted.",
    gate: "projection",
    columns: ["ended"],
    endsTurn: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => '{"ended":true}',
  });

  function ending(wake: string, refuses: () => boolean = () => false): ExecutionDefinition<Answer> {
    return defineExecution<Answer>({
      ...definition(wake),
      tools: [quiet(refuses), NOTHING, NOTHING_HELD.tool],
    });
  }

  function day(model: { readonly harness: Harness }): Session<string> {
    const opened = openSession<string>({
      harness: model.harness,
      shape: sessionShapeOf(ending("")),
      start: { kind: "new", sessionId: randomUUID() },
    });
    open.push(opened);
    return opened;
  }

  it("stops right after an effect that performed: one model call, no words, no prompt for a visible response — and the next turn runs", async () => {
    const model = scriptedModel([
      { toolCall: { name: "say_here", input: {} } },
      // A TURN THE HOOK DID NOT STOP would be asked again here and end on
      // these words; a stopped one leaves them to the next turn.
      { text: "Aquí sigo." },
    ]);
    const session = day(model);

    const settled = await session.wake({ trigger: TRIGGER, definition: ending("summons"), chain: recordingChain().chain, tag: "said" });

    expect(settled.kind).toBe("ran");
    if (settled.kind !== "ran") return;
    expect(settled.outcome.words).toBe("");
    expect(settled.outcome.effects).toEqual([{ performed: true, act: "said", told: "said" }]);
    expect(settled.outcome.record.iterations).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests)).not.toContain(NUDGE);

    // THE CONVERSATION GOES ON: the next wake is answered by the turns left.
    const next = await session.wake({ trigger: TRIGGER, definition: ending("line"), chain: recordingChain().chain, tag: "next" });
    expect(next.kind === "ran" && next.outcome.words).toBe("Aquí sigo.");
    expect(model.requests).toHaveLength(2);
  });

  it("stops right after a projection that ends the turn: nothing to say is no words", async () => {
    const model = scriptedModel([{ toolCall: { name: "nothing_to_say", input: {} } }, { text: "nota sobre el turno" }]);
    const session = day(model);

    const settled = await session.wake({ trigger: TRIGGER, definition: ending("event"), chain: recordingChain().chain, tag: "quiet" });

    expect(settled.kind === "ran" && settled.outcome.words).toBe("");
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests)).not.toContain(NUDGE);
  });

  it("goes on after a refused call: the model answers the refusal", async () => {
    const model = scriptedModel([{ toolCall: { name: "say_here", input: {} } }, { text: "Te lo digo aquí." }]);
    const session = day(model);

    const settled = await session.wake({
      trigger: TRIGGER,
      definition: ending("line", () => true),
      chain: recordingChain().chain,
      tag: "refused",
    });

    expect(settled.kind === "ran" && settled.outcome.words).toBe("Te lo digo aquí.");
    expect(model.requests).toHaveLength(2);
  });

  it("still nudges a turn that ends with no words on a tool that does not end it — the mechanism is the tool's", async () => {
    const model = scriptedModel([
      { toolCall: { name: "hold", input: {} } },
      { text: "" },
      { text: "" },
    ]);
    const session = day(model);

    await session.wake({ trigger: TRIGGER, definition: ending("line"), chain: recordingChain().chain, tag: "held" });

    expect(model.requests).toHaveLength(3);
    expect(JSON.stringify(model.requests[2])).toContain(NUDGE);
  });
});

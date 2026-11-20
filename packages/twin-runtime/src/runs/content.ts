/**
 * A RUN'S CONTENT, SEALED BESIDE ITS SESSION (ticket #323; spec #318
 * decisions 3 and 22; ADR-0012: coordination rows are opaque, run content
 * lives twin-side).
 *
 * What the engine has to read back to advance a run — the definition it
 * pinned, the typed inputs it was started with, and every finished step's
 * typed output — is the run's content, and none of it may sit on a seam row.
 * The agent steps' turns, their tool calls and the rep's guidance are in the
 * run's SDK session file; this file holds the typed half code reads, one per
 * run, in the twin's harness directory beside the session.
 *
 * SEALED UNDER THE TWIN'S KEY, where the session file beside it is in the
 * clear: the harness directory is FR-73's recorded gap until the per-twin
 * volume (decision 3), and a file this runtime writes itself need not widen
 * it. The rep's words in an inline run's instructions and an agent step's
 * output reach the disk only as ciphertext here.
 *
 * WRITTEN WHOLE, BY RENAME, so a reader never finds half a file: a step's
 * output is in it before the transaction that ends the step commits, and a
 * process that dies between the two leaves a run the engine ends as stranded
 * (`engine.ts`) — never one that runs a step twice.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dek } from "@dito/crypto";
import { runDigest, type RunDefinition, type RunValue } from "./definition.js";

export interface RunContent {
  readonly definition: RunDefinition;
  readonly inputs: Readonly<Record<string, RunValue>>;
  /** Each finished step's typed output, by the step's name. */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, RunValue>>>>;
  /**
   * THE REP'S TYPED ANSWER TO THE CARD A STEP WAITS ON, by the step's name
   * (ticket #324): written by the one answer path (`ask.ts`) while the step is
   * still parked, and read by the engine when it resumes the step — an `ask`
   * step's output, or the message an `agent` step that asked is woken with.
   */
  readonly answers?: Readonly<Record<string, Readonly<Record<string, RunValue>>>>;
}

/** Where one run's content lies inside its twin's harness directory. */
export function runContentFile(directory: string, runId: string): string {
  return join(directory, "runs", `${runId}.run`);
}

export function writeRunContent(
  directory: string,
  dek: Dek,
  runId: string,
  content: RunContent,
): void {
  const file = runContentFile(directory, runId);
  mkdirSync(join(directory, "runs"), { recursive: true });
  const sealed = dek.encrypt(Buffer.from(JSON.stringify(content), "utf8"));
  const temporary = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, sealed);
  renameSync(temporary, file);
}

/**
 * The run's content, opened — and refused when its definition is not the one
 * the row pinned: a run never advances under a definition that changed.
 */
export function readRunContent(
  directory: string,
  dek: Dek,
  runId: string,
  pinned: string,
): RunContent {
  const file = runContentFile(directory, runId);
  if (!existsSync(file)) {
    throw new RunContentError(`run ${runId} has no content file in its twin's harness directory`);
  }
  const content = JSON.parse(
    Buffer.from(dek.decrypt(readFileSync(file))).toString("utf8"),
  ) as RunContent;
  if (runDigest(content.definition) !== pinned) {
    throw new RunContentError(
      `run ${runId}'s content holds a definition whose digest is not the one its row pinned — a run never advances under a definition that changed`,
    );
  }
  return content;
}

/** The content cannot be read as the run's: the run ends rather than guess. */
export class RunContentError extends Error {
  override readonly name = "RunContentError";
}

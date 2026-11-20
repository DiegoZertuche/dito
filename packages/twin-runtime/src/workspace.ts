/**
 * THE TWIN'S WORKSPACE, SNAPSHOTTED AT EVERY STEP BOUNDARY (ticket #326; spec
 * #318 decision 35; ADR-0011 as amended 2026-09-27).
 *
 * The workspace is a directory — `workspaceOf(harness)`, the SDK child's own
 * working directory — that the twin works in with the SDK's file tools. A
 * version is a snapshot of it taken by the runtime at a step boundary: every
 * file whose content differs from its last version gets a new one, immutable,
 * with its row in the bundle. A run's step takes one as it settles; the
 * thread's turn takes one as it ends. So `Write` and `Edit` are undone the way
 * ADR-0013 says a disclosed-and-undoable-after effect is — the version before
 * is always there to go back to — and a document a card names by its version
 * is the text it named.
 *
 * WHAT IT WRITES, AND IN WHICH ORDER: the versions first, in one synchronous
 * pass over the directory and the bundle, so two steps settling at once —
 * the children of one `each` — never number the same file twice; then recall's
 * item for each version, embedded beside the thread's own items, so the twin
 * finds a document again by what it says (`search_messages`).
 *
 * THE TITLE IS CODE'S: the file's first Markdown heading, else its name. The
 * model writes a document; it never types a title into a form.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { Bundle, WorkspaceVersion } from "@dito/bundle";
import { workspaceOf, type Harness } from "@dito/execution";
import type { Embedder } from "./embedder.js";
import { seatDay } from "./thread/day.js";
import { indexThreadItems } from "./thread/memory-tools.js";

/** What a snapshot reads and writes: the workspace, the bundle and recall's embedder. */
export interface WorkspaceDeps {
  readonly harness: Pick<Harness, "directory">;
  readonly bundle: Bundle;
  readonly embedder: Embedder;
  readonly timeZone?: string;
}

/** Whose boundary a snapshot is taken at. */
export interface SnapshotAt {
  /** The execution that ended there — a run's step, or the thread's turn. */
  readonly executionId: string;
  /** The run whose step it was, absent for the thread's own turn. */
  readonly runId?: string;
  /** The session the work was in, which recall's item belongs to. */
  readonly sessionId: string;
  readonly now: Date;
}

/**
 * Takes the snapshot: a version for every workspace file whose content
 * changed since its last version, and recall's item for each — the versions
 * written, in path order.
 */
export async function snapshotWorkspace(deps: WorkspaceDeps, at: SnapshotAt): Promise<readonly WorkspaceVersion[]> {
  const written = writeVersions(deps, at);
  if (written.length === 0) return written;
  // THE VERSIONS STAND WHATEVER BECOMES OF THEIR RECALL (Codex r3): a store
  // that fails here costs the meaning and word search of these versions, and
  // never the versions a caller hands the rep.
  try {
    await indexThreadItems(
      deps,
      { sessionId: at.sessionId, day: seatDay(at.now, deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) },
      written.map((version) => ({ id: version.id, role: "workspace" as const, at: at.now, text: recalled(version) })),
    );
  } catch {
    // Recall misses these versions; the bundle holds them whole.
  }
  return written;
}

/**
 * THE SYNCHRONOUS HALF: nothing awaits between reading a file's last version
 * and writing its next, so no other snapshot in this process can take the
 * same number in between.
 */
function writeVersions(deps: WorkspaceDeps, at: SnapshotAt): readonly WorkspaceVersion[] {
  const workspace = workspaceOf(deps.harness);
  const written: WorkspaceVersion[] = [];
  for (const path of filesIn(workspace)) {
    const content = readFileSync(join(workspace, path), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const last = deps.bundle.latestVersionOf(path);
    if (last?.sha256 === sha256) continue;
    const version: WorkspaceVersion = {
      id: randomUUID(),
      path,
      version: (last?.version ?? 0) + 1,
      sha256,
      title: titleOf(content, path),
      content,
      writtenAt: at.now.toISOString(),
      executionId: at.executionId,
      ...(at.runId === undefined ? {} : { runId: at.runId }),
    };
    deps.bundle.writeWorkspaceVersion(version);
    written.push(version);
  }
  return written;
}

/**
 * Every regular file under the workspace, relative to it, in path order. A
 * link is never followed — the file tools' hook keeps the twin from making one
 * that leads out, and the snapshot reads nothing a link names either way.
 */
function filesIn(workspace: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(workspace, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(workspace, join(entry.parentPath, entry.name)))
    .sort();
}

/** A document's title: its first Markdown heading, else its file name. */
export function titleOf(content: string, path: string): string {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/mu.exec(content)?.[1]?.trim();
  return heading === undefined || heading === "" ? basename(path) : heading;
}

/** What recall holds of a version: which document it is, then its text. */
function recalled(version: WorkspaceVersion): string {
  return `[your workspace document ${version.path}, version ${String(version.version)}: ${version.title}]\n\n${version.content}`;
}

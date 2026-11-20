/**
 * Test-only temp-dir scaffold shared by this package's suites. Excluded
 * from the package build output; never part of the public surface.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Registers per-test cleanup and returns a factory for fresh temp dirs.
 * Call at module scope in a test file.
 */
export function useTmpDirs(prefix: string): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}

/**
 * Removes a suite-scoped temp dir, tolerating one that was never created.
 *
 * THE CASE THIS EXISTS FOR (ticket #88): a suite makes its dir in
 * `beforeAll` and removes it in `afterAll`. When `beforeAll` throws — a
 * database that would not migrate, a tool that would not download — the
 * assignment never happened, so the bare `rmSync(tmp, …)` threw a second,
 * unrelated `TypeError` about the path argument. `force: true` does not
 * help: an undefined path is a type error, not a missing file.
 *
 * A run that fails once should say so once. The second error buries the
 * first, which is the one worth reading.
 */
export function removeTmpDir(dir: string | undefined): void {
  if (dir === undefined) return;
  rmSync(dir, { recursive: true, force: true });
}

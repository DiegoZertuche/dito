/**
 * THE INTEGRATION LANE'S PER-FILE SETUP (ticket #390): runs in each test
 * file's own worker before the file is imported.
 *
 * It names the running file in `DITO_TEST_FILE`, which is what makes
 * `TEST_DATABASE_URL` the file's own database (`database-url.ts`): every
 * helper reads it when the file imports them, after this has run. And it
 * creates that database as a fresh clone of the run's template before the
 * file is imported, so a suite that connects before its first reset — or
 * never resets at all — finds a migrated database of its own.
 *
 * And it holds the role lock's USE EXCLUSIVE for the whole of a file that
 * changes a cluster-global role on purpose (`role-lock.ts`), so no other
 * file borrows, resets in place, or relies on the role while it does.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vitest";
import { holdRoles } from "./role-lock.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/**
 * The files that write a role outside a borrow. The invariants suite sets
 * `BYPASSRLS` and `LOGIN` on application roles for one assertion apiece and
 * creates roles of its own; the borrow helper's own suite moves the owner
 * role's password around raw, because it is the thing that proves the
 * borrow. Either one beside a borrower would break that borrower's login or
 * its row-level security mid-test.
 */
const ROLE_WRITING_FILES: ReadonlySet<string> = new Set([
  "packages/aperture/src/invariants.int.test.ts",
  "packages/seam/src/testing/owner-password.int.test.ts",
]);

const testPath = expect.getState().testPath;
if (testPath === undefined) {
  throw new Error("integration-file setup ran outside a test file");
}
const file = path.relative(REPO_ROOT, testPath).split(path.sep).join("/");
process.env["DITO_TEST_FILE"] = file;
// Imported only now: `db.ts` derives `TEST_DATABASE_URL` from the variable
// above when it loads.
const { resetAndMigrate } = await import("./db.js");
await resetAndMigrate();

if (ROLE_WRITING_FILES.has(file)) {
  let release: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    release = await holdRoles("exclusive");
  });
  afterAll(async () => {
    await release?.();
  });
}

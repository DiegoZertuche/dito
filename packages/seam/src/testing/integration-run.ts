/**
 * THE INTEGRATION LANE'S GLOBAL SETUP: ONE TEMPLATE, AND NOTHING LEFT
 * BEHIND BUT WHAT CI READS (ticket #390).
 *
 * Before any worker starts it migrates the run's template with the pinned
 * Atlas (`buildTemplate`, ADR-0029) — the run's one full migration.
 * `DITO_TEST_RUN=1` tells every worker the template is fresh, so a reset
 * clones it, and that the role lock is in force (`role-lock.ts`).
 *
 * When the run ends it drops every file's database except the ones in
 * `KEPT_FOR_CHECKS`, which CI's check scripts read in place of a second run
 * of their suite. A run that starts drops the previous run's kept databases
 * first, so a check never reads a corpus another run left.
 *
 * A BORROW NOBODY HOLDS IS GIVEN BACK AT BOTH ENDS: a worker, or a whole
 * run, that died mid-borrow leaves its record behind (`role-borrows.ts`),
 * and the role it borrowed would otherwise keep the suites' password.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { buildTemplate, dropDatabase, withMaintenance } from "./admin.js";
import {
  baseDatabaseUrl,
  databaseNameOf,
  fileDatabaseName,
  KEPT_FOR_CHECKS,
} from "./database-url.js";
import { recoverBorrows } from "./role-borrows.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const base = baseDatabaseUrl(process.env);
  const baseName = databaseNameOf(base);

  await recoverBorrows(base);
  await withMaintenance(base, async (admin) => {
    for (const file of KEPT_FOR_CHECKS) {
      await dropDatabase(admin, fileDatabaseName(baseName, file));
    }
  });
  await buildTemplate(base);
  process.env["DITO_TEST_RUN"] = "1";

  return async () => {
    await recoverBorrows(base);
    const { testFiles } = await project.globTestFiles();
    const kept = new Set(KEPT_FOR_CHECKS);
    await withMaintenance(base, async (admin) => {
      for (const absolute of testFiles) {
        const file = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
        if (!kept.has(file)) await dropDatabase(admin, fileDatabaseName(baseName, file));
      }
    });
  };
}

/**
 * Temp-dir scaffold for this package's suites, from @dito/bundle's source.
 * Test plumbing is source-only by convention (every package's
 * `src/testing` is excluded from its build), so this re-export reaches
 * the bundle package's source directly — one scaffold, no copy to drift.
 */
export { removeTmpDir, useTmpDirs } from "../../../bundle/src/testing/tmp.js";

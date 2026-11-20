import { defineConfig } from "vitest/config";
import { SizeBalancedSequencer } from "./packages/seam/src/testing/sequencer";

// Integration lane (ADR-0028): real Postgres (docker, `pnpm db:up`) and real
// dev-account KMS. The crypto path is never mocked.
//
// FILES IN PARALLEL, EACH ON ITS OWN DATABASE (ticket #390). The global setup
// migrates one template with the pinned Atlas; the per-file setup names the
// running file, and a suite's reset clones the template into that file's
// database (`packages/seam/src/testing/database-url.ts` names them all). Roles
// are the one thing suites still share — they are cluster-global — and the
// role lock in `role-lock.ts` is what lets them share it.
//
// `packages/**` rather than `packages/*/src/**` for the reason spelled out in
// `vitest.config.ts` (#84): an integration test outside a package's `src/` was
// silently never collected, and this lane is the one that guards the wall.
export default defineConfig({
  // THE APPS' OWN JSX TRANSFORM, `vitest.config.ts`' reason: the rendered-page
  // suite draws one component to its bytes (rep-web's in-card note, #340).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/*.int.test.ts", "apps/**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["packages/seam/src/testing/integration-run.ts"],
    setupFiles: ["packages/seam/src/testing/integration-file.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: true,
    // THE WORKER COUNT (ticket #390). A file's time is mostly waiting — on
    // the SDK child each execution spawns, and on Postgres — so workers past
    // the core count still help; the curve measured on CI's runner is in
    // the PR. `--maxWorkers` on the command line overrides it.
    maxWorkers: 4,
    minWorkers: 1,
    // CI runs the lane in three shards; this split balances them
    // (`sequencer.ts` argues it).
    sequence: { sequencer: SizeBalancedSequencer },
  },
});

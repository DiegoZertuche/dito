// THE MINIMAL RULESET, AND WHY IT IS A LIST RATHER THAN A PRESET (#84).
//
// This repo had no linter at all until this file. Adopting `eslint:recommended`
// or `recommended-type-checked` would have turned ~90 rules on in one commit —
// a diff nobody reviews and a green nobody trusts. So every rule below is
// written out, and each one carries the sentence that argues for it. Rules get
// added later, individually, against real findings.
//
// WHAT IT IS NOT ENFORCING IS RECORDED, NOT FORGOTTEN. Measured on the tree
// this file landed against, `recommended-type-checked` would have reported 306
// findings; the numbers and the reasoning are on ticket #84 so the next rule is
// argued from evidence rather than from taste. The three biggest — the
// `no-unsafe-*` family (187, the `any` that JSON parsing lets in),
// `no-base-to-string` (8, all in the twin's fact rendering) and `no-console`
// (3 in `src`, 77 in the `scripts/` dirs where logging is the point) — each
// want their own ticket.
//
// EVERY RULE HERE IS `error`, and `pnpm lint` passes `--max-warnings=0`. A
// warning exits 0, which is the silent green this repo's whole invariant
// discipline exists to refuse.

import tseslint from "typescript-eslint";

/**
 * Rules that need no type information, so they apply to every file this config
 * reaches — including the two root vitest configs that no tsconfig describes.
 */
const SYNTACTIC_RULES = {
  // `tsc` does not flag a committed `debugger`. Node honours it under
  // `--inspect`, so one left in a rig script stops a session in front of a
  // phone — the most expensive place in this project to find anything.
  "no-debugger": "error",
  // `noFallthroughCasesInSwitch` is OFF in `tsconfig.base.json`, and the twin
  // switches on fact type in a dozen places (`grammar.ts` alone has three). A
  // missing `break` there renders the wrong sentence to a rep, silently.
  "no-fallthrough": "error",
};

/**
 * ONE opt-out, not three, and the difference matters (Codex r1).
 *
 * `noUnusedLocals` and `noUnusedParameters` are both OFF in
 * `tsconfig.base.json`, so nothing in this repo has ever flagged a dead
 * binding; four dead imports were sitting in the tree when this landed.
 *
 * `argsIgnorePattern` stays because a leading `_` on a PARAMETER is a real
 * statement: the signature requires the slot and the body does not use it,
 * and there is no other way to say so. `varsIgnorePattern` and
 * `caughtErrorsIgnorePattern` are deliberately absent — those would let a
 * dead local, a dead import or a swallowed error be silenced by RENAMING it,
 * with nothing in the diff a reviewer could see. A caught error nobody wants
 * has an honest form already: `catch { … }` with no binding. Nothing in the
 * tree used either escape, so dropping them cost nothing and closed a
 * suppression path.
 *
 * `args: "all"` for the same reason (Codex r2). The rule's default is
 * `"after-used"`, which reports only parameters AFTER the last one the body
 * uses — so `function f(unused, used) { return used; }` passes with no
 * underscore and no diagnostic, and the sentence above ("the underscore is
 * the opt-out") would have been false as written. Zero violations in the tree
 * under `"all"`, so this too cost nothing.
 */
const UNUSED_VARS_OPTIONS = { args: "all", argsIgnorePattern: "^_" };

/**
 * The same, for TypeScript files: `@typescript-eslint/no-unused-vars`
 * understands type-only imports and generics, which the core rule does not.
 */
const TS_SYNTACTIC_RULES = {
  ...SYNTACTIC_RULES,
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": ["error", UNUSED_VARS_OPTIONS],
};

/**
 * Rules that read the type checker. All three are the same failure — work that
 * silently does not happen — which is the failure this codebase can least
 * afford: almost every seam, bundle and KMS call is a promise.
 */
const TYPE_AWARE_RULES = {
  // An unawaited write is a lost write AND an unhandled rejection that kills
  // the process later, somewhere else. Zero violations on the tree this
  // landed against, so it costs nothing and pins the property.
  "@typescript-eslint/no-floating-promises": "error",
  // The other half of the same hole: an `async` callback handed to something
  // that expects `void` (`array.forEach`, an event handler) is never awaited
  // by anyone, so its failure is swallowed and its work races.
  "@typescript-eslint/no-misused-promises": "error",
  // `await` on a non-promise is almost always a forgotten call — `await
  // client.query` rather than `await client.query(...)` — and resolves
  // instantly to the function itself instead of failing.
  "@typescript-eslint/await-thenable": "error",
};

/** The same three, switched off — flat config merges `rules`, it does not
 * replace them, so a block that must not run a type-aware rule has to say so.
 * Derived from the map above rather than retyped, so the two cannot drift. */
const TYPE_AWARE_RULES_OFF = Object.fromEntries(
  Object.keys(TYPE_AWARE_RULES).map((rule) => [rule, "off"]),
);

export default tseslint.config(
  {
    // Generated and vendored trees only — every one of them a directory
    // `.gitignore` also carries. NOTHING ELSE IS IGNORED, deliberately: an
    // allowlist of linted directories is how a check stops covering what it
    // looks like it covers, which is the hole this ticket exists to close
    // (#78, #79, #84).
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      ".tools/**",
      "rig-data/**",
      // Next's build output (#129). Generated, gitignored, and — the reason
      // it must be named here rather than left alone — full of `.ts` and
      // `.tsx` files that no tsconfig describes, which under
      // `projectService` is a parse error rather than a skip.
      "**/.next/**",
    ],
  },

  // EVERY TypeScript FILE IN THE REPO, and the pattern is `**/*` rather than a
  // list of directories on purpose. `projectService` hands each file to the
  // NEAREST `tsconfig.json`, so a file is type-checked under the config that
  // describes ITS execution mode, not under one flattened program:
  //
  //   - `packages/twin-runtime/src/**` → the package config. Compiled by
  //     `tsc` into `dist/` and run as JavaScript.
  //   - `packages/twin-runtime/scripts/**` → `scripts/tsconfig.json`, which
  //     #79 gave that directory precisely because it runs under `node
  //     --experimental-strip-types` and is NOT the built package's mode:
  //     `allowImportingTsExtensions` (its four `./rig-env.ts` specifiers are
  //     correct as written) and `erasableSyntaxOnly`. Linting those files
  //     under `src/`'s assumptions would resolve their imports to nothing,
  //     type every imported value as `any`, and quietly turn the type-aware
  //     rules above into no-ops there — a check that runs over a directory it
  //     cannot see.
  //   - `packages/evals/**` → that package's config, which carries both flags
  //     package-wide because it has no build at all.
  //
  // A file that NO tsconfig describes is a parse error here rather than a
  // skip, so adding one is loud.
  //
  // ALL FOUR TypeScript EXTENSIONS, not just `.ts` (Codex r2), for exactly the
  // reason #79 listed `scripts` in five packages that have none: the first one
  // added is checked the day it lands rather than the day somebody notices.
  // Every TypeScript file here is `.ts` today, so `**/*.ts` looked complete
  // and passed while `.mts`, `.cts` and `.tsx` probes drew "no matching
  // configuration" and left `eslint .` green. `tseslint.parser` turns JSX on
  // for `.tsx` by itself, so covering it is a glob and not a framework
  // decision.
  {
    files: ["**/*.{ts,mts,cts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { ...TS_SYNTACTIC_RULES, ...TYPE_AWARE_RULES },
  },

  // THE TWO ROOT VITEST CONFIGS, which no tsconfig describes — `pnpm
  // typecheck` does not cover them either, and this file does not pretend to.
  // Type-aware rules need a program, and the only way to give these one is to
  // invent compiler options for them; #79's rule is that a config which lints
  // files under assumptions they do not run with is worse than one that skips
  // them honestly. So they get the syntactic rules, and the gap is written
  // down instead of papered over.
  //
  // NAMED, NOT `*.ts` (Codex r1). A wildcard here would have quietly enrolled
  // every future root-level TypeScript file in the same exemption, which is
  // the block above's promise — "a `.ts` file that NO tsconfig describes is a
  // parse error" — broken by the very block that documents it. Two files are
  // exempt; the third one anybody adds fails loudly, as it should.
  {
    files: ["vitest.config.ts", "vitest.integration.config.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: false, project: false },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { ...TS_SYNTACTIC_RULES, ...TYPE_AWARE_RULES_OFF },
  },

  // THE JAVASCRIPT: the `.mjs` scripts in `scripts/`, and this
  // config. `pnpm typecheck` covers none of them — they are `.mjs` by design
  // (#79) — so lint is the only automated check they have ever had.
  //
  // ALL FOUR EXTENSIONS, not just `.mjs` (Codex r1/r2). Every JavaScript file
  // in the tree today is `.mjs`, so an earlier `**/*.mjs` pattern looked
  // complete and passed; a probe proved that `scripts/probe.js` and
  // `scripts/probe.cjs` holding a `debugger` and a dead binding both linted
  // clean. A helper arriving under either extension would have entered CI
  // entirely unchecked with `pnpm lint` still green — the run-versus-cover
  // defect this ticket exists to close, reintroduced by the file closing it.
  // `.jsx` is here for the same reason `.tsx` is above, and the one line of
  // parser options it needs is the price of not having to remember later.
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      ...SYNTACTIC_RULES,
      "no-unused-vars": ["error", UNUSED_VARS_OPTIONS],
    },
  },
);

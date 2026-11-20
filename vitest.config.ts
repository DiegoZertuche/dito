import { defineConfig } from "vitest/config";

// Unit lane: fast, hermetic tests. Integration tests (real Postgres, real KMS —
// ADR-0028: the crypto path is never mocked) live in *.int.test.ts and run via
// vitest.integration.config.ts.
//
// Include all package and app directories, not just `src/`: omitted tests
// produce a false green with no skip notice (#84, #129; the run-versus-cover
// failure also recorded in #78 and #79).
//
// `.test.tsx` IS INCLUDED for the same reason, one extension further out: a
// card renderer is JSX, so its test has to be `.tsx`, and a pattern matching
// only `.test.ts` collects such a file as nothing at all. That is the same
// false green with no skip notice, arriving through the extension rather than
// through the directory.
//
// Limits: no test outside `packages/` and `apps/` (including the root, which
// has no tsconfig), and no `.test.mjs`. CI runs the eight invariant scripts in
// `scripts/` directly rather than through unit tests.
//
// Collection does not guarantee typechecking. A test outside its tsconfig
// still runs but fails typed lint loudly — intended, so #79's hole cannot
// reopen quietly. Include its directory in the package tsconfig or give it
// its own, as twin-runtime's `scripts/` has.
export default defineConfig({
  // THE AUTOMATIC JSX RUNTIME, because a `.test.tsx` needs one (#224). Vitest
  // transforms with esbuild and does not read a package's tsconfig, so its
  // default is the CLASSIC transform — which compiles `<Card />` to
  // `React.createElement` and throws «React is not defined» in a file that
  // imports only what it renders. Every app in this repo is on `react-jsx`
  // already; this is that setting where the unit lane can see it.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
    ],
    exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/dist/**"],
  },
});

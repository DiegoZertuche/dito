#!/usr/bin/env node
/**
 * THE SECOND CLIENT INVARIANT: no model call leaves the browser, and no key
 * rides in a client bundle (ticket #263; spec #258 decision 5, which keeps it
 * as a test; ADR-0002, ADR-0008, ADR-0037).
 *
 * A SWEEP OVER WHAT THE BROWSER IS SENT, not over the sources: every `.js`
 * file under rep-web's built `.next/static`, which is exactly the JavaScript
 * any page can load, and under `public/`, where the service worker is served
 * from as written (ticket #269). Sources would miss what a bundler pulls in
 * from a package; the build and the served files are what ships.
 *
 *   pnpm build && node scripts/client-bundle-check.mjs --require-bundle
 *
 * IT FAILS ON FOUR KINDS OF THING, each enumerated below where it is argued:
 * a model endpoint or the SDK that calls one, a `DITO_` environment name or
 * another credential's, the runtime's own wire (the seat header), and a
 * literal shaped like a key. Each is a statement about the browser: a page
 * that names the provider's host is a page that can call it, and a page that
 * names the bearer's variable is a bundle something server-side leaked into.
 *
 * AN EMPTY SWEEP IS NOT A PASS (ADR-0028 doctrine, #84): `--require-bundle`
 * fails a run that found no JavaScript at all, which is what a missing build
 * looks like. Its bite is proven by `apps/rep-web/src/client-bundle-check
 * .test.ts`, which plants a bundle holding each kind and drives this file.
 *
 * NO DEPENDENCIES, `copy-check.mjs`'s reason: it runs in the unit job after
 * the build and needs nothing but the files it reads.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * WHAT A BROWSER MAY NOT NAME, each with the reason it is refused.
 *
 * THE MODEL, from where the runtime reaches it: `@dito/execution` calls the
 * provider through `@anthropic-ai/sdk`, whose host is `api.anthropic.com`, on
 * `/v1/messages`, with an `anthropic-version` header; the embedder loads its
 * model through `@huggingface/transformers` from `huggingface.co`. A model id
 * (`claude-…`) is the other half of a call. Any of these in a client bundle
 * is either a call the browser could make or a runtime module that was
 * bundled for it.
 *
 * THE CREDENTIALS, by name: every `DITO_` variable (the bearer
 * `DITO_TWIN_API_BEARER`, both chain keys, every database URL — the whole
 * family is server-side by construction, since only `NEXT_PUBLIC_` is ever
 * inlined), and the provider's and the cloud's own key variables.
 *
 * THE RUNTIME'S WIRE: `x-dito-seat` is the header rep-web fills from a
 * session; a bundle carrying it is a browser that could be asked to fill it.
 *
 * KEY-SHAPED LITERALS: a PEM block, a provider key's prefix, an AWS access
 * key id, and 32 random bytes written as hex or base64 — the shapes a DEK, a
 * chain key or a bearer takes when somebody pastes one.
 */
const REFUSED = [
  { rule: "model endpoint", pattern: /api\.anthropic\.com/u },
  { rule: "model endpoint", pattern: /\/v1\/messages/u },
  { rule: "model endpoint", pattern: /anthropic-version/u },
  { rule: "model endpoint", pattern: /huggingface\.co/u },
  { rule: "model SDK", pattern: /@anthropic-ai\/sdk/u },
  { rule: "model SDK", pattern: /@huggingface\/transformers/u },
  { rule: "model id", pattern: /\bclaude-[a-z0-9]/u },
  { rule: "environment name", pattern: /\bDITO_[A-Z0-9_]+/u },
  { rule: "environment name", pattern: /\bANTHROPIC_API_KEY\b/u },
  { rule: "environment name", pattern: /\bAWS_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID|SESSION_TOKEN)\b/u },
  { rule: "runtime wire", pattern: /x-dito-seat/u },
  { rule: "key-shaped literal", pattern: /-----BEGIN [A-Z ]*KEY-----/u },
  { rule: "key-shaped literal", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/u },
  { rule: "key-shaped literal", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { rule: "key-shaped literal", pattern: /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/u },
  { rule: "key-shaped literal", pattern: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=/u },
];

/** The value of `--<name>=<value>`, or `undefined` when it was not passed. */
function argument(name) {
  const given = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return given === undefined ? undefined : given.slice(name.length + 3);
}

/**
 * THE TWO PLACES A BROWSER IS SENT JAVASCRIPT FROM, or the one `--dir` names
 * (the check's own test plants a tree there). `public/` is served byte for
 * byte, so a file in it reaches a browser without passing through the build.
 */
const given = argument("dir");
const dirs = (
  given === undefined
    ? ["apps/rep-web/.next/static", "apps/rep-web/public"]
    : [given]
).map((dir) => path.resolve(REPO, dir));
const requireBundle = process.argv.includes("--require-bundle");

/** Every `.js` file under a directory, depth first. */
function* scripts(at) {
  for (const entry of readdirSync(at)) {
    const full = path.join(at, entry);
    if (statSync(full).isDirectory()) yield* scripts(full);
    else if (entry.endsWith(".js")) yield full;
  }
}

const swept = dirs.map((dir) => (existsSync(dir) ? [...scripts(dir)] : []));
const files = swept.flat();
const offenders = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const { rule, pattern } of REFUSED) {
    const found = pattern.exec(source);
    if (found !== null) {
      offenders.push({ file: path.relative(REPO, file), rule, found: found[0] });
    }
  }
}

console.log(
  `Client bundle check over ${dirs.map((dir) => path.relative(REPO, dir) || ".").join(", ")}: ${files.length} script(s), ${offenders.length} offender(s)`,
);
for (const offender of offenders) {
  // THE MATCH IS PRINTED ONLY UP TO ITS FIRST EIGHT CHARACTERS: a real key
  // found in a bundle must not be copied whole into a CI log on the way out.
  const shown =
    offender.rule === "key-shaped literal"
      ? `${offender.found.slice(0, 8)}…`
      : offender.found;
  console.error(`  OFFENDER ${offender.file}: ${offender.rule} (${shown})`);
}

if (offenders.length > 0) {
  console.error(
    "CLIENT BUNDLE RED: a page's JavaScript names a model endpoint, a credential or the runtime's wire, or carries a key-shaped literal. rep-web holds no key and no model call leaves the browser (spec #258 decision 5).",
  );
  process.exit(1);
}

// THE BUILD IS WHAT MUST BE THERE: the service worker under `public/` is in
// the tree whether or not anybody built, so it cannot stand in for a bundle.
if (swept[0].length === 0) {
  console.log(
    "Client bundle check swept nothing: no built JavaScript was found, so it proves nothing about what a browser is sent.",
  );
  if (requireBundle) {
    console.error("CLIENT BUNDLE CHECK INCONCLUSIVE: --require-bundle and no bundle — build rep-web first.");
    process.exit(1);
  }
  process.exit(0);
}

console.log(
  "Client bundle green: no model endpoint, no credential name, no runtime wire and no key-shaped literal in anything a browser is sent.",
);

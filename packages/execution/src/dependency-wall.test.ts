/**
 * The dependency wall (ticket #128 AC 7: "The package has no dependency on
 * `pg`, on any seam or aperture package, or on any crypto").
 *
 * WHY A SOURCE SCAN RATHER THAN A LINT RULE: `eslint.config.js` is
 * deliberately a short list of argued rules and carries no import-boundary
 * rule, so the repo's idiom for "this package imports no X" is a scan over
 * file text with the rule factored out as a pure function, shown to bite
 * against a synthetic offender in the same suite —
 * `packages/aperture/src/sole-writer.test.ts` and its siblings
 * (`binding-wall.test.ts`, `twin-posts.test.ts`).
 *
 * WHY IT MATTERS HERE. The whole claim of this package is that both apps
 * can consume it: the owner app, which connects as `dito_owner` and holds
 * no twin key, and the rep runtime, which holds both. A single value import
 * of `pg`, of the seam, of the aperture or of anything holding custody
 * would make the credential-free library a lie that nothing else in the
 * repo would notice — the packages all install cleanly, the types all
 * resolve, and the wall would be gone.
 *
 * TWO HALVES, because either alone is satisfiable while the claim is
 * false: the manifest (what the package declares it depends on) and the
 * source (what the code actually reaches for, including the relative paths
 * a manifest cannot see).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");

/**
 * What a value import from this package's source may never name.
 *
 * `@dito/audit` IS ON THIS LIST even though the package uses its types: it
 * depends on `pg`, so a value import would pull the driver in behind a name
 * that looks harmless. `audit.ts` takes `AuditEntry` through `import type`,
 * which `verbatimModuleSyntax` erases entirely, and this line is what keeps
 * that true.
 *
 * `node:crypto` is handled separately below — the digest hashes, and
 * hashing is not custody.
 */
const FORBIDDEN_MODULES = [
  "pg",
  // `@dito/notify` (ticket #219) is class 4 of ADR-0013 — "only via the
  // notify service; notify is never present on any model tool surface in
  // either app". This package is where tool surfaces are ASSEMBLED, so a
  // value import of it here would put the email rail one registration away
  // from every execution. The wider claim — no module that constructs a
  // registry can reach notify, in any package, transitively — is the second
  // suite in this file.
  "@dito/notify",
  "@dito/audit",
  "@dito/aperture",
  "@dito/seam",
  "@dito/bundle",
  "@dito/crypto",
  "@dito/twin-runtime",
  "@aws-sdk/client-kms",
  "better-sqlite3-multiple-ciphers",
];

/**
 * The only `node:crypto` bindings this package may hold as a value.
 *
 * SAID EXPLICITLY BECAUSE THE DISTINCTION IS THE WHOLE POINT: the
 * instructions digest HASHES, and a hash holds nothing — no key, no DEK, no
 * envelope, nothing that could be destroyed to erase a twin (ADR-0009).
 * `randomUUID` names a session's messages and conversations (ticket #319):
 * an identifier the child writes in plaintext beside them, never secret
 * material. `createHmac`, `randomBytes`, `createCipheriv` and the rest are
 * custody or secret material, and a credential-free library has no business
 * with any of them. The chain's HMAC is `@dito/audit`'s, behind the injected
 * interface, in the owning app's process.
 */
const PERMITTED_CRYPTO_BINDINGS = ["createHash", "randomUUID"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * `import …/export … from "x"` and the side-effect `import "x"`.
 *
 * ANCHORED AT THE START OF A LINE, and that is not cosmetic. This file's own
 * doc comments say the words «import type», and an unanchored pattern read
 * one of them as a value import of the package the sentence was explaining.
 * The anchor is also what lets this suite plant offenders in its own source
 * and still be swept with no exemption: a statement begins a line, and a
 * planted one sits indented inside a quote.
 *
 * THE `import("x")` FORM IS COVERED TOO (Codex r3), and it cannot be
 * anchored, because a dynamic import is an expression and may sit anywhere.
 * It was left out at first for exactly that reason — a planted one would
 * have been found in this file's own text — and left out it was a real hole:
 * `@dito/audit` is already a devDependency and itself depends on `pg`, so a
 * dynamic import of it would compile into the emitted JavaScript with both
 * this sweep and the manifest assertion still green. The planted case below
 * is built by interpolation instead, so no forbidden specifier appears as a
 * quoted literal in this file and the sweep can still read every line of
 * it — this comment included.
 *
 * The `type` prefix is captured because it is what decides whether a
 * statement survives compilation. Only a leading `import type` /
 * `export type` is erased — `import { type A } from "m"` still emits a
 * runtime import of `m` under `verbatimModuleSyntax`, so a per-binding
 * `type` keyword must NOT count as erasure here.
 *
 * The binding clause is spelled out character by character rather than as
 * "anything up to `from`", because `export function offendingImports(file:
 * …)` also starts a line with `export` — and a permissive body ran from
 * there to the next `from "…"` several dozen lines below, reporting this
 * file as importing a package it only names in a string.
 */
const STATIC_IMPORT =
  /^[ \t]*(?<kind>import|export)\s+(?<typeOnly>type\s+)?(?<bindings>[A-Za-z0-9_$*{},\s]*?)\s+from\s*["'](?<module>[^"']+)["']/gm;
const BARE_IMPORT = /^[ \t]*import\s*["'](?<module>[^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["'](?<module>[^"']+)["']\s*\)/g;

interface Offence {
  readonly file: string;
  readonly module: string;
  readonly reason: string;
}

/** One value import, as the rule sees it. */
interface ValueImport {
  readonly module: string;
  readonly bindings: string;
}

function valueImports(source: string): ValueImport[] {
  const found: ValueImport[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const { typeOnly, bindings, module } = match.groups!;
    if (typeOnly !== undefined) continue;
    found.push({ module: module!, bindings: bindings! });
  }
  for (const pattern of [BARE_IMPORT, DYNAMIC_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      found.push({ module: match.groups!["module"]!, bindings: "" });
    }
  }
  return found;
}

/**
 * The rule itself, over one file's text — a pure function, so it can be
 * shown to bite.
 *
 * `file` is the path relative to this package, and it is needed rather than
 * decorative: a relative specifier's reach depends on where the file sits,
 * and reaching into another package's source by relative path is the same
 * dependency spelled differently (`packages/audit/src/testing/db.ts`
 * reaches the seam's source exactly that way).
 */
export function offendingImports(file: string, source: string): Offence[] {
  const found: Offence[] = [];
  for (const { module, bindings } of valueImports(source)) {
    if (FORBIDDEN_MODULES.includes(module)) {
      found.push({
        file,
        module,
        reason: "a value import of a package this one may not depend on",
      });
      continue;
    }
    if (module === "node:crypto" || module === "crypto") {
      const held = [...bindings.matchAll(/[A-Za-z_$][\w$]*/g)]
        .map((m) => m[0])
        .filter((name) => name !== "type");
      for (const binding of held) {
        if (!PERMITTED_CRYPTO_BINDINGS.includes(binding)) {
          found.push({
            file,
            module,
            reason: `holds \`${binding}\`, and only ${PERMITTED_CRYPTO_BINDINGS.join(", ")} are permitted`,
          });
        }
      }
      continue;
    }
    if (module.startsWith(".")) {
      const target = resolve(dirname(join(PACKAGE_ROOT, file)), module);
      if (!target.startsWith(SOURCE_ROOT + sep)) {
        found.push({
          file,
          module,
          reason: "a relative import reaching outside this package's source",
        });
      }
    }
  }
  return found;
}

function scan(): Offence[] {
  const found: Offence[] = [];
  walk(SOURCE_ROOT, (absolute) => {
    if (!absolute.endsWith(".ts")) return;
    const rel = relative(PACKAGE_ROOT, absolute);
    found.push(...offendingImports(rel, readFileSync(absolute, "utf8")));
  });
  return found;
}

function walk(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) walk(absolute, visit);
    else if (stats.isFile()) visit(absolute);
  }
}

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const MANIFEST = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
) as Manifest;

describe("the execution runtime is credential-free (ticket #128 AC 7)", () => {
  it("declares no runtime dependency on the database, the seam, the aperture or any crypto", () => {
    // The manifest half. `@dito/audit` and `@dito/scripted-model` are
    // devDependencies — types and test plumbing — and neither reaches the
    // emitted JavaScript. (`dist/audit.d.ts` still names `@dito/audit`'s
    // entry type, as a declaration must; the source half below is what
    // proves no VALUE of it is held.)
    //
    // THREE, AND WHY EACH (ticket #328). The Claude Agent SDK is the harness
    // (ADR-0014 as amended 2026-09-27), pinned exact because the Claude Code
    // binary it ships is part of what an execution is. The MCP SDK builds the
    // in-process server every tool is served from. The Anthropic SDK is the
    // Agent SDK's own peer and the source of the stream-event types the
    // runner reads; nothing here calls it. None of the three holds a key,
    // a connection or custody: the model key reaches the child through the
    // harness the caller passes.
    expect(Object.keys(MANIFEST.dependencies ?? {})).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/sdk",
      "@modelcontextprotocol/sdk",
    ]);
    expect(MANIFEST.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it("imports none of them anywhere in its source", () => {
    expect(
      scan().map((o) => `${o.file} imports ${o.module}: ${o.reason}`),
    ).toEqual([]);
  });

  it("catches every shape of the reach, and lets the honest ones through", () => {
    // The planted violations: proof the greens above are a result, not a
    // regex that matches nothing.
    const offenders = [
      'import { appendAuditEntry } from "@dito/audit";',
      'import type { Client } from "pg";\nimport { Pool } from "pg";',
      'import { type AuditEntry, appendEntry } from "@dito/audit";',
      'import { createHmac } from "node:crypto";',
      'import { scriptedModel } from "../../twin-runtime/src/testing/scripted-model.js";',
      'import "@dito/seam";',
      // Built by interpolation, not written as a literal: a quoted
      // specifier inside a dynamic import would be found by the sweep that
      // reads this very file. The rule still sees the finished string.
      `const audit = await import(${JSON.stringify("@dito/audit")});`,
    ].join("\n");
    expect(
      offendingImports("src/offender.ts", offenders).map((o) => o.module),
    ).toEqual([
      "@dito/audit",
      "pg",
      "@dito/audit",
      "node:crypto",
      "../../twin-runtime/src/testing/scripted-model.js",
      "@dito/seam",
      "@dito/audit",
    ]);

    const honest = [
      'import type { AuditEntry } from "@dito/audit";',
      'import { createHash } from "node:crypto";',
      'import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";',
      'import { query } from "@anthropic-ai/claude-agent-sdk";',
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { triggerRef } from "./trigger.js";',
      'import type { ExecutionAuditChain } from "../audit.js";',
    ].join("\n");
    expect(offendingImports("src/testing/honest.ts", honest)).toEqual([]);
  });

  it("scans something — an empty sweep is not a pass", () => {
    // A misresolved package root or a swallowed walk error would otherwise
    // report zero offences over zero files (ADR-0028 doctrine).
    let files = 0;
    walk(SOURCE_ROOT, (absolute) => {
      if (absolute.endsWith(".ts")) files += 1;
    });
    expect(files).toBeGreaterThan(5);
  });
});

/**
 * NOTIFY IS NEVER ON A TOOL SURFACE (ticket #219 AC 4; ADR-0013 class 4:
 * "system notifications — only via the notify service (ADR-0022); notify is
 * never present on any model tool surface in either app").
 *
 * WHY THE CLAIM IS ABOUT REGISTRIES AND NOT ABOUT PACKAGES. The safety does
 * not live on a tool LIST (ADR-0013 as amended 2026-08-29): it lives on the
 * tools themselves, and `registry.ts` is where a name becomes something
 * runnable — "every part a spec can reference is a STRING resolved here
 * against code this repository wrote". So the thing that must not be able to
 * reach the email rail is a REGISTRY MODULE, and a rule stated over packages
 * would be both too weak (a package may legitimately hold a registry and an
 * operator script) and too strong (rep-web will send the invitation and
 * holds no registry at all).
 *
 * TRANSITIVELY, WHICH IS THE ONLY VERSION WORTH ASSERTING. A registry that
 * imported notify directly is the case nobody writes; the case somebody
 * writes is a helper two modules down that grew a send. So the walk follows
 * every value import out of every registry module — relative specifiers
 * within a package and `@dito/…` into another package's entry point — and
 * fails if any path arrives at `@dito/notify`.
 *
 * A `.test.ts` IS NOT A MODULE A REGISTRY CAN REACH, and is therefore not in
 * the graph: nothing shipped imports a test. That is what lets
 * `migration-vocabulary.test.ts` hold notify's closed vocabularies against
 * the package's own constants without standing in front of this wall — a
 * vocabulary test is not a tool surface, and the manifest half below is
 * about RUNTIME dependencies for the same reason.
 */
describe("no automation registry can reach notify (ticket #219 AC 4)", () => {
  const PACKAGES = resolve(PACKAGE_ROOT, "..");
  const REPO = resolve(PACKAGES, "..");

  it("finds the registry modules by what they are, not by a hand list", () => {
    // The sweep's own coverage, asserted: a rule over "every automation
    // registry" that silently found none would be the run-versus-cover
    // defect #84 named, and it would report zero offences for ever.
    const modules = registryModules();
    expect(modules.length).toBeGreaterThan(3);
    for (const named of [
      "packages/execution/src/registry.ts",
      "packages/twin-runtime/src/drafting/registries.ts",
      "packages/twin-runtime/src/thread/registries.ts",
      "packages/owner-twin/src/definition.ts",
    ]) {
      expect(modules, `the sweep never reached ${named}`).toContain(named);
    }
  });

  it("reaches no path from any registry module to the email rail", () => {
    expect(
      notifyReaches(reachableFrom(workspaceSources(), registryModules())),
      "an automation registry can reach @dito/notify — class 4 of ADR-0013 says the email rail is never on a tool surface. Whatever needs to send belongs in the app that calls notify, not in a module a registry imports",
    ).toEqual([]);
  });

  it("catches a reach two modules deep, so the green above is a result", () => {
    // THE PLANTED CHAIN. A registry that imported notify directly is the
    // case nobody writes; this is the one somebody writes — a helper that
    // grew a send, two hops from the registry that names the tool.
    const planted = new Map([
      [
        "packages/example/src/registries.ts",
        'import { toolFactory } from "./tools.js";\nexport const TOOLS = { send: toolFactory };\n',
      ],
      [
        "packages/example/src/tools.ts",
        'import { notifier } from "./deps.js";\nexport const toolFactory = notifier;\n',
      ],
      [
        "packages/example/src/deps.js".replace(".js", ".ts"),
        `import { createNotify } from ${JSON.stringify("@dito/notify")};\nexport const notifier = createNotify;\n`,
      ],
    ]);
    expect(
      notifyReaches(
        reachableFrom(planted, ["packages/example/src/registries.ts"]),
      ),
    ).toContain("@dito/notify");
  });

  it("catches a reach by relative path too, where a specifier would not appear", () => {
    // THE HOLE THE PACKAGE-NAME RULE HAD ON ITS OWN. Reaching into another
    // package's source by relative path is the same dependency spelled
    // differently — `packages/audit/src/testing/db.ts` reaches the seam
    // exactly that way — and no `@dito/notify` specifier appears anywhere
    // in it, so a rule that only collected specifiers would have walked
    // right into the file and reported nothing.
    const planted = new Map([
      [
        "packages/example/src/registries.ts",
        'import { createNotify } from "../../notify/src/notify.js";\nexport const TOOLS = { createNotify };\n',
      ],
      ["packages/notify/src/notify.ts", "export const createNotify = 1;\n"],
    ]);
    expect(
      notifyReaches(
        reachableFrom(planted, ["packages/example/src/registries.ts"]),
      ),
    ).toContain("packages/notify/src/notify.ts");
  });

  it("follows a compiled helper to the source that built it (Codex r2)", () => {
    // THE HOLE A RECORDED PATH LEAVES OPEN ON ITS OWN.
    // `../../seam/dist/notify-helper.js` is not notify, so the path rule
    // has nothing to report — and the SOURCE it was built from imports the
    // rail. One hop of indirection through a `dist` is all it takes.
    const planted = new Map([
      [
        "packages/example/src/registries.ts",
        'import { helper } from "../../seam/dist/notify-helper.js";\nexport const TOOLS = { helper };\n',
      ],
      [
        "packages/seam/src/notify-helper.ts",
        `import { createLiveNotify } from ${JSON.stringify("@dito/notify")};\nexport const helper = createLiveNotify;\n`,
      ],
    ]);
    expect(
      notifyReaches(
        reachableFrom(planted, ["packages/example/src/registries.ts"]),
      ),
    ).toContain("@dito/notify");
  });

  it("follows a workspace SUBPATH to the source behind it (Codex r3)", () => {
    // `@dito/seam/dist/notify-helper.js` resolves at runtime — no package
    // but notify pins its `exports` — and it is not a relative path, so the
    // `dist` rule above never sees it. Following only the bare `@dito/x`
    // form leaves a compiled helper one hop from a registry.
    const planted = new Map([
      [
        "packages/example/src/registries.ts",
        `import { helper } from ${JSON.stringify("@dito/seam/dist/notify-helper.js")};\nexport const TOOLS = { helper };\n`,
      ],
      [
        "packages/seam/src/notify-helper.ts",
        `import { createLiveNotify } from ${JSON.stringify("@dito/notify")};\nexport const helper = createLiveNotify;\n`,
      ],
    ]);
    expect(
      notifyReaches(
        reachableFrom(planted, ["packages/example/src/registries.ts"]),
      ),
    ).toContain("@dito/notify");
  });

  it("catches a reach into the BUILT package, which no source map holds (Codex r1)", () => {
    // `../../notify/dist/ses.js` typechecks against `ses.d.ts` and runs
    // against the emitted JavaScript. It is not in this walk's source map,
    // so the resolution found nothing and the reach was silently dropped —
    // two hops from a registry, with the wall still green.
    const planted = new Map([
      [
        "packages/example/src/registries.ts",
        'import { toolFactory } from "./tools.js";\nexport const TOOLS = { toolFactory };\n',
      ],
      [
        "packages/example/src/tools.ts",
        'import { sesTransport } from "../../notify/dist/ses.js";\nexport const toolFactory = sesTransport;\n',
      ],
    ]);
    // `toContain` rather than `toEqual`: the walk reports the `dist` path it
    // was given AND the source that path was built from, and which of the
    // two a reader sees first is not the claim.
    expect(
      notifyReaches(
        reachableFrom(planted, ["packages/example/src/registries.ts"]),
      ),
    ).toContain("packages/notify/dist/ses.ts");
  });

  it("lets an honest neighbour through, so the rule is about notify", () => {
    const honest = new Map([
      [
        "packages/example/src/registries.ts",
        'import { readAutomation } from "@dito/execution";\nexport const TOOLS = { readAutomation };\n',
      ],
    ]);
    const reach = reachableFrom(honest, ["packages/example/src/registries.ts"]);
    expect([...reach.modules]).toContain("@dito/execution");
    expect(notifyReaches(reach)).toEqual([]);
  });

  it("declares no runtime dependency on it from any package holding a registry", () => {
    // The manifest half. RUNTIME dependencies, because that is what a tool
    // surface can reach: a devDependency reaches tests and scripts, neither
    // of which is a registry, and `migration-vocabulary.test.ts` holds
    // notify's closed vocabularies through exactly one.
    for (const pkg of new Set(
      registryModules().map((module) => module.split("/")[1]!),
    )) {
      const manifest = JSON.parse(
        readFileSync(join(PACKAGES, pkg, "package.json"), "utf8"),
      ) as Manifest;
      expect(
        Object.keys(manifest.dependencies ?? {}),
        `@dito/${pkg} depends on the email rail at runtime`,
      ).not.toContain("@dito/notify");
    }
  });

  /** Every non-test source in the workspace's packages, repo-relative. */
  function workspaceSources(): Map<string, string> {
    const sources = new Map<string, string>();
    for (const pkg of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, pkg, "src");
      if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
      walk(src, (absolute) => {
        if (!/\.tsx?$/.test(absolute) || /\.test\.tsx?$/.test(absolute)) return;
        sources.set(
          relative(REPO, absolute).split(sep).join("/"),
          readFileSync(absolute, "utf8"),
        );
      });
    }
    return sources;
  }

  /**
   * Every module where a name becomes a runnable tool: one that constructs
   * an automation registry, or one that builds a definition straight from
   * `defineExecution` with the tools it hands the model (the owner twin's).
   *
   * FOUND BY THE NAMES IT USES, because those are what such a module IS: a
   * tool registry, a recipe registry, a submission contract, the
   * `Registries` value an app hands `constructDefinition`, or
   * `defineExecution` itself. A module that grows one tomorrow joins this
   * sweep the day it is written, which a hand list could not promise.
   */
  function registryModules(): string[] {
    const names =
      /\b(?:ToolRegistry|ToolRegistration|RecipeRegistry|SubmissionRegistry|Registries)\b|\bdefineExecution\b/;
    return [...workspaceSources()]
      .filter(([, source]) => names.test(source))
      .map(([file]) => file)
      .sort();
  }
});

/**
 * Every way one reach names the email rail: the package specifier, and the
 * source file a relative path arrived at.
 *
 * BOTH HALVES, because either alone leaves a hole. A specifier is how a
 * package is normally imported; a RELATIVE path into another package's
 * source is the same dependency spelled differently, and it puts no
 * `@dito/notify` anywhere in the importing file — so a rule that collected
 * only specifiers would walk into `packages/notify/src/notify.ts` and
 * report nothing.
 *
 * `packages/notify/` AND NOT `packages/notify/src/` (Codex r1). A relative
 * path into the BUILT package — `../../notify/dist/ses.js` — typechecks
 * against `ses.d.ts` and runs against the emitted JavaScript, and it is not
 * in the source map this walk carries, so a rule that asked for `/src/` saw
 * neither the specifier nor the file. It is the whole package that is out of
 * reach, however a path spells its way in.
 */
function notifyReaches(reach: {
  paths: Set<string>;
  modules: Set<string>;
}): string[] {
  return [
    ...[...reach.modules].filter((module) => module.startsWith("@dito/notify")),
    ...[...reach.paths].filter((path) => path.startsWith("packages/notify/")),
  ];
}

/**
 * Every module and package specifier reachable from `starts` by a value
 * import, over sources handed in rather than read.
 *
 * A PARAMETER SO THE PROOF CAN DRIVE IT, which is the shape
 * `composed-language.test.ts` settled on for the same reason: a rule
 * exercised only against the tree that already obeys it proves the tree is
 * clean and proves nothing about the rule.
 *
 * `@dito/x` RESOLVES TO `packages/x/src/index.ts`, which is every workspace
 * package's entry point. A specifier that resolves to no source in the map
 * is still RECORDED — that is how `@dito/notify` is seen at all, and it is
 * why an external package cannot hide a reach: nothing outside this
 * workspace can depend on a private, unpublished package.
 */
function reachableFrom(
  sources: ReadonlyMap<string, string>,
  starts: readonly string[],
): { paths: Set<string>; modules: Set<string> } {
  /** Every repo-relative path a relative import named, resolvable or not. */
  const paths = new Set<string>();
  const modules = new Set<string>();
  const walked = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (walked.has(file)) continue;
    walked.add(file);
    paths.add(file);
    const source = sources.get(file);
    if (source === undefined) continue;
    for (const { module } of valueImports(source)) {
      if (module.startsWith(".")) {
        const target = resolveRelative(file, module);
        // RECORDED WHETHER OR NOT IT RESOLVES: an import of another
        // package's `dist` names a real file this walk has no source for,
        // and dropping it silently is how a reach hides (Codex r1).
        paths.add(target[0]!);
        const resolved = target.find((candidate) => sources.has(candidate));
        if (resolved !== undefined) {
          queue.push(resolved);
          continue;
        }
        // ...AND FOLLOWED THROUGH `dist` TO THE SOURCE THAT BUILT IT (Codex
        // r2). Recording the path alone reports a DIRECT reach into notify
        // and stops there, which leaves another package's compiled helper —
        // `../../seam/dist/notify-helper.js`, whose source imports the rail
        // — hiding a transitive one. The walk continues at the source.
        const built = /^(packages\/[^/]+)\/dist\/(.+)$/u.exec(target[0]!);
        if (built !== null) {
          const source = `${built[1]!}/src/${built[2]!}`;
          if (sources.has(source)) {
            queue.push(source);
            continue;
          }
          paths.add(source);
        }
        continue;
      }
      modules.add(module);
      // A WORKSPACE SPECIFIER, WITH OR WITHOUT A SUBPATH (Codex r3).
      // `@dito/seam/dist/notify-helper.js` resolves — no package but notify
      // pins its `exports` — and following only the bare form left a helper
      // one hop from a registry with the wall green. The entry point is
      // `src/index.ts`; a subpath is that package's own source, with a
      // `dist/` prefix and a built extension mapped back.
      const workspace = /^@dito\/(?<pkg>[a-z-]+)(?:\/(?<sub>.+))?$/u.exec(module);
      if (workspace !== null) {
        const { pkg, sub } = workspace.groups!;
        if (sub === undefined) {
          queue.push(`packages/${pkg!}/src/index.ts`);
        } else {
          const inSource = sub.replace(/^dist\//u, "").replace(/\.jsx?$/u, ".ts");
          const target = `packages/${pkg!}/src/${inSource}`;
          paths.add(target);
          if (sources.has(target)) queue.push(target);
        }
      }
    }
  }
  return { paths, modules };
}

/**
 * The repo-relative paths a relative specifier could mean, best first. The
 * first is what is RECORDED as reached even when nothing resolves — see
 * `reachableFrom`.
 */
function resolveRelative(from: string, specifier: string): string[] {
  const base = join(dirname(from), specifier).split(sep).join("/");
  const asTs = base.replace(/\.jsx?$/, ".ts");
  return [asTs, asTs.replace(/\.ts$/, ".tsx"), `${base}/index.ts`, base];
}

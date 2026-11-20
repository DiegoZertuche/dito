/**
 * THE HARNESS LIVES IN ONE PACKAGE (ticket #176 AC 2; spec #171 decision 1
 * and user story 44; ticket #328).
 *
 * `@dito/execution`'s `runner.ts` is the only loop: every automation is a
 * definition it runs, and user story 44 says why the hand-written harnesses
 * were DELETED rather than wrapped: "so that the runtime is the only loop and
 * there is nothing to migrate twice". This sweep is what keeps that true,
 * because nothing else would notice a second call site appearing.
 *
 * TWO LISTS, AND THEY ARE NOT THE SAME RULE.
 *
 *  - THE HARNESS'S REACH may appear under `packages/execution/src` and
 *    nowhere else: the Agent SDK's module (whatever `query` is renamed to on
 *    the way in, reaching it means importing this path — and `query(` itself
 *    is not a token a sweep can own, since every database call writes it),
 *    its `createSdkMcpServer(`, and the MCP SDK a tool server is built from.
 *    A tool served to a model from anywhere else would be a tool outside the
 *    runner's gates and input validation.
 *  - THE RETIRED LOOP may appear nowhere at all, this package included: the
 *    Anthropic SDK's `toolRunner(` and `betaTool(`, the property walk, and
 *    the helper module `betaTool` comes from. Codex round 1 on #176 is why
 *    the last two are here — `import { betaTool as makeTool }` and
 *    `const run = anthropic.beta.messages.toolRunner` evaded the first two.
 *
 * WHAT IT STILL CANNOT SEE, recorded rather than left to be found: a call
 * assembled at run time out of computed property names, or a re-export
 * through a local module that renames the symbol AND hides the import path.
 * Closing that means a TypeScript program with symbol resolution, which is a
 * different kind of test from a sweep; it is recorded on #176 as remainder.
 *
 * WHERE IT LIVES, and it is worth saying because the obvious home is
 * `@dito/execution` itself. The exclusion below has to live in the ONE pinned
 * allowlist file (`composed-language-allowlist.ts`) — one file is the record
 * of every standing exemption, whatever rule granted it — and that file is in
 * `twin-runtime`, where the language it records lives. `@dito/execution` may
 * not import `@dito/twin-runtime`: the dependency wall runs the other way.
 * So the sweep sits beside the record it reads. Its REACH is not narrowed by
 * its home — it walks every package's `src`, and the test below asserts
 * which ones it reached.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_BOUNDARY_EXCLUSIONS } from "./composed-language-allowlist.js";

/** `packages/` — this file is `packages/twin-runtime/src/`. */
const PACKAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPO = path.resolve(PACKAGES, "..");

/** The package the runner belongs to, and the only one allowed to reach the harness. */
const RUNTIME_PACKAGE = "packages/execution/src";

/** What only the runner may reach: the Agent SDK and the tool server (see the header). */
const HARNESS_REACH = [
  "@anthropic-ai/claude-agent-sdk",
  "createSdkMcpServer(",
  "@modelcontextprotocol/sdk",
];

/** The Anthropic SDK's own agentic loop, which nothing may call any more. */
const RETIRED_LOOP = [
  "toolRunner(",
  "betaTool(",
  ".messages.toolRunner",
  "@anthropic-ai/sdk/helpers",
];

/** Every non-test source under every package's `src`, repo-relative. */
function sources(): string[] {
  const found: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, "src");
    if (!existsAsDirectory(src)) continue;
    for (const file of walk(src)) {
      if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
      found.push(path.relative(REPO, file).split(path.sep).join("/"));
    }
  }
  return found;
}

/** Every source outside `@dito/execution` that reaches the harness. */
function callers(): string[] {
  return sources()
    .filter((file) => !file.startsWith(RUNTIME_PACKAGE))
    .filter((file) => {
      const source = readFileSync(path.join(REPO, file), "utf8");
      return HARNESS_REACH.some((call) => source.includes(call));
    });
}

/** Every source, `@dito/execution` included, that still calls the retired loop. */
function retiredCallers(): string[] {
  return sources().filter((file) => {
    const source = readFileSync(path.join(REPO, file), "utf8");
    return RETIRED_LOOP.some((call) => source.includes(call));
  });
}

describe("the harness is reached from `packages/execution` alone (ticket #176 AC 2; #328)", () => {
  it("finds none but the recorded exclusions", () => {
    const excluded = new Set(RUNNER_BOUNDARY_EXCLUSIONS.map((one) => one.file));
    expect(
      callers().filter((file) => !excluded.has(file)),
      "these sources reach the Agent SDK or build a tool server directly. The runtime is the only loop (spec #171 user story 44): make it an automation, or record the exclusion with its expiry in `composed-language-allowlist.ts`",
    ).toEqual([]);
  });

  it("finds the retired Tool Runner nowhere, the runner included (#328)", () => {
    expect(
      retiredCallers(),
      "these sources call the Anthropic SDK's Tool Runner, which no execution runs on any more (ADR-0014 as amended 2026-09-27)",
    ).toEqual([]);
  });

  it("keeps NO exclusion at all (ticket #194)", () => {
    // Every rep-side model loop is an automation now (#172, #173, #176,
    // #194), so the escape hatch has nothing in it. It is pinned at zero
    // rather than merely unused, so a fifth harness is a decision somebody
    // has to make in a diff.
    expect(RUNNER_BOUNDARY_EXCLUSIONS).toEqual([]);
  });

  it("holds no exclusion for a source that no longer calls the runner", () => {
    // Checked in both directions, like the language allowlist beside it: an
    // exclusion outliving its call site is a standing exemption for code
    // that is gone, and it would hide the next one.
    const calling = new Set(callers());
    expect(
      RUNNER_BOUNDARY_EXCLUSIONS.map((one) => one.file).filter(
        (file) => !calling.has(file),
      ),
      "these exclusions name a source that no longer calls the SDK's runner — remove them",
    ).toEqual([]);
  });

  it("really did read the packages where a harness would be", () => {
    // The sweep's own coverage: a rule over "the rep side" that walked one
    // directory would be #84's run-versus-cover defect, and this rule's
    // green is otherwise indistinguishable from a rule that read nothing.
    const swept = sources();
    expect(swept.length).toBeGreaterThan(100);
    for (const named of [
      "packages/twin-runtime/src/consumer.ts",
      "packages/twin-runtime/src/extraction-pass.ts",
      "packages/twin-runtime/src/extraction/definition.ts",
      "packages/twin-runtime/src/entity-kind/automation.ts",
      "packages/owner-twin/src/turn.ts",
      "packages/execution/src/runner.ts",
    ]) {
      expect(swept, `the sweep never reached ${named}`).toContain(named);
    }
    // ...and the one package that MAY reach the harness really does, so the
    // rule is not passing because nothing anywhere reaches it at all: both of
    // its shapes drive the SDK (#319), and the wrapper they share serves the
    // tools over MCP.
    const read = (file: string): string =>
      readFileSync(path.join(REPO, "packages/execution/src", file), "utf8");
    expect(read("runner.ts")).toContain("@anthropic-ai/claude-agent-sdk");
    expect(read("session.ts")).toContain("@anthropic-ai/claude-agent-sdk");
    expect(read("turn.ts")).toContain("@modelcontextprotocol/sdk");
  });

  it("catches a planted call, an alias and a property walk (Codex r1)", () => {
    // Each shape a harness could be written in, each caught by a token of
    // the list it belongs to.
    const retired = [
      "const message = await anthropic.beta.messages.toolRunner({ model });",
      'const tool = betaTool({ name: "submit", inputSchema: {} });',
      'import { betaTool as makeTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";',
      "const run = anthropic.beta.messages.toolRunner; await run({ model });",
    ];
    for (const shape of retired) {
      expect(RETIRED_LOOP.some((call) => shape.includes(call)), shape).toBe(true);
    }
    const reach = [
      'import { query as ask } from "@anthropic-ai/claude-agent-sdk";',
      'const server = createSdkMcpServer({ name: "mine", tools });',
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    ];
    for (const shape of reach) {
      expect(HARNESS_REACH.some((call) => shape.includes(call)), shape).toBe(true);
    }
  });
});

function existsAsDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Every file under a directory, depth first. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("one kind of definition: the older one and its submission are gone (ticket #364)", () => {
  it("leaves the execution package exporting no spec, no constructor and no submission contract", async () => {
    const execution: Record<string, unknown> = await import("@dito/execution");
    for (const name of ["constructDefinition", "parseAutomation", "readAutomation", "serializeAutomation", "AUTOMATION_SCHEMA_VERSION", "ENUMERATORS", "PRECONDITIONS"]) {
      expect(execution, name).not.toHaveProperty(name);
    }
    // THE TYPES LEAVE NOTHING AT RUNTIME, so their names are read off the
    // package's own index: a type re-exported there is a type someone may use.
    const index = readFileSync(path.join(PACKAGES, "execution", "src", "index.ts"), "utf8");
    for (const name of ["AutomationSpec", "DefinitionSpec", "SubmissionContract", "SubmittedDisposition", "Registries", "SubmissionRegistry", "ScheduleWake", "Cadence"]) {
      expect(index, name).not.toMatch(new RegExp(`\\b${name}\\b`, "u"));
    }
  });
});

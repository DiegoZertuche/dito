import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertResettable,
  fileDatabaseName,
  KEPT_FOR_CHECKS,
  templateDatabaseName,
  testDatabaseUrl,
} from "./database-url.js";

describe("the test database a suite may reset (ticket #305)", () => {
  it("refuses to choose one when the variable is unset, naming the variable", () => {
    expect(() => testDatabaseUrl({})).toThrow(/DITO_TEST_DATABASE_URL/u);
  });

  it("refuses an empty value the same way", () => {
    expect(() => testDatabaseUrl({ DITO_TEST_DATABASE_URL: "" })).toThrow(
      /DITO_TEST_DATABASE_URL/u,
    );
  });

  it("answers the value it was given", () => {
    expect(
      testDatabaseUrl({
        DITO_TEST_DATABASE_URL: "postgres://dito:dito@localhost:5433/dito_9_test?sslmode=disable",
      }),
    ).toBe("postgres://dito:dito@localhost:5433/dito_9_test?sslmode=disable");
  });
});

describe("the database each file of a parallel run owns (ticket #390)", () => {
  const BASE = "postgres://dito:dito@localhost:5433/dito_9_test?sslmode=disable";

  it("is the file's own when the lane names the file, on the same server and credentials", () => {
    expect(
      testDatabaseUrl({
        DITO_TEST_DATABASE_URL: BASE,
        DITO_TEST_FILE: "packages/twin-runtime/src/send-lock/writer.int.test.ts",
      }),
    ).toBe(
      "postgres://dito:dito@localhost:5433/dito_9_test_twin_runtime_send_lock_writer?sslmode=disable",
    );
  });

  it("still refuses with no base named, file or no file", () => {
    expect(() =>
      testDatabaseUrl({ DITO_TEST_FILE: "packages/seam/src/schema.int.test.ts" }),
    ).toThrow(/DITO_TEST_DATABASE_URL/u);
  });

  it("refuses a name Postgres would cut short, rather than folding two files onto one database", () => {
    expect(() =>
      fileDatabaseName("d".repeat(40) + "_test", "packages/twin-runtime/src/shipped-automations.int.test.ts"),
    ).toThrow(/63/u);
  });

  it("gives every integration file in the repo a distinct name that fits, under CI's base", () => {
    const files = integrationFiles();
    expect(files.length).toBeGreaterThan(70);
    const names = files.map((file) => fileDatabaseName("dito_test", file));
    expect(new Set(names).size).toBe(files.length);
    expect(names).not.toContain(templateDatabaseName("dito_test"));
  });

  it("keeps only files that exist, so a renamed suite cannot leave a check reading nothing", () => {
    const files = new Set(integrationFiles());
    for (const kept of KEPT_FOR_CHECKS) expect(files).toContain(kept);
  });

  it("points every check in the workflow at a database the run keeps, under the job's own base", () => {
    const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const kept = new Set(KEPT_FOR_CHECKS.map((file) => fileDatabaseName("dito_test", file)));
    const read = [...workflow.matchAll(/DITO_DATABASE_URL: postgres:\/\/[^/]+\/([a-z0-9_]+)\?/gu)].map(
      (match) => match[1]!,
    );
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) expect(kept).toContain(name);
    for (const name of kept) expect(read).toContain(name);
  });

  it("makes the job that adds up the runners' kept databases expect every one of them", () => {
    const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const job = workflow.slice(workflow.indexOf("\n  integration-checks:"));
    const listed = [...job.matchAll(/^\s+(dito_test_[a-z0-9_]+)(?: \\|; do)$/gmu)].map((match) => match[1]!);
    const kept = KEPT_FOR_CHECKS.map((file) => fileDatabaseName("dito_test", file));
    expect([...listed].sort()).toEqual([...kept].sort());
  });
});

describe("the guard on every drop (ticket #305, kept by #390)", () => {
  it("refuses a database whose name does not say test", () => {
    expect(() => assertResettable("dito_rig", {})).toThrow(/refusing to reset non-test database "dito_rig"/u);
  });

  it("allows a test database, and a named override", () => {
    expect(() => assertResettable("dito_test_twin_runtime_thread", {})).not.toThrow();
    expect(() => assertResettable("dito_rig", { DITO_ALLOW_DB_RESET: "1" })).not.toThrow();
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Every package's and app's `src/testing/db.ts`, found rather than listed, so
 * a new helper is swept without anyone listing it.
 */
function helperModules(): string[] {
  return ["packages", "apps"].flatMap((tree) =>
    readdirSync(path.join(REPO_ROOT, tree))
      .map((name) => path.join(tree, name, "src/testing/db.ts"))
      .filter((relative) => existsSync(path.join(REPO_ROOT, relative))),
  );
}

/** Every integration file the lane collects, repo-relative. */
function integrationFiles(): string[] {
  return ["packages/**/*.int.test.ts", "apps/**/*.int.test.ts"]
    .flatMap((pattern) => globSync(pattern, { cwd: REPO_ROOT }))
    .filter((file) => !file.includes("node_modules") && !file.includes("/dist/"))
    .map((file) => file.split(path.sep).join("/"));
}

describe("every test helper, imported with no test database named (ticket #305)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("finds the helpers it sweeps", () => {
    expect(helperModules()).toContain("packages/seam/src/testing/db.ts");
    expect(helperModules()).toContain("apps/rep-web/src/testing/db.ts");
  });

  it.each(helperModules())("%s refuses to load, naming the variable", async (relative) => {
    vi.stubEnv("DITO_TEST_DATABASE_URL", undefined);
    vi.resetModules();
    await expect(import(pathToFileURL(path.join(REPO_ROOT, relative)).href)).rejects.toThrow(
      /DITO_TEST_DATABASE_URL/u,
    );
  });
});

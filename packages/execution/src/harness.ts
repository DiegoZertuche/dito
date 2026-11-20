/**
 * The harness: what one execution's Claude Agent SDK child needs that the
 * definition does not carry (ADR-0014 as amended 2026-09-27; spec #318
 * decisions 7 and 36; ticket #328).
 *
 * A HARNESS IS DATA, NOT A CLIENT. The child is a process the SDK spawns, so
 * there is no object this package could be handed that makes model calls on
 * its behalf; what the caller decides is where the child lives, which
 * credential it presents and which endpoint it talks to. Everything else
 * about the child's environment is decided here, once, for every execution.
 *
 * THE CHILD'S ENVIRONMENT IS BUILT, NEVER INHERITED. The SDK's `env` option
 * replaces the child's environment outright, so what is listed below is all
 * the child has: nothing of the parent process reaches it but its `PATH`
 * (spec #318 decision 36: the child needs the parent's executables, and an
 * empty environment hangs it, SDK#255), and telemetry,
 * error reporting, the autoupdater, nonessential traffic and compaction are
 * off by construction (design D14) — no caller can build a harness that
 * forgets one, because no caller builds the environment.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Budget } from "./definition.js";

/**
 * Where one execution's SDK child lives and what it presents.
 *
 * `directory` IS ONE TWIN'S ALONE (spec #318 decision 3, the recorded gap
 * until the per-twin volume): the child's config directory, its working
 * directory and its home all sit inside it, so nothing the child writes
 * lands under the operator's home or beside another twin's files. The rep
 * side derives it beside the twin's bundle, where FR-73 reports it; the
 * owner side names a sibling of its own working directory.
 */
export interface Harness {
  readonly directory: string;
  /** The model credential the child presents (`ANTHROPIC_API_KEY`). */
  readonly apiKey: string;
  /**
   * The Messages endpoint, when it is not Anthropic's own: the scripted
   * model's loopback server in tests. The CLI posts `/v1/messages` under
   * it and, with a non-default value, skips its remote settings fetch.
   */
  readonly baseUrl?: string;
  /** The Claude Code executable, when not the one the SDK ships. */
  readonly executable?: string;
}

/**
 * The variables every child carries whatever its harness says (design D14;
 * spike #290 fact 7 and its compaction finding).
 *
 * `DISABLE_COMPACT` turns off manual compaction as well as automatic, which
 * a single-message execution never needs. `NO_PROXY` keeps a loopback
 * endpoint out of any proxy the machine has configured.
 */
const FIXED_CHILD_ENV: Readonly<Record<string, string>> = {
  DISABLE_TELEMETRY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_COMPACT: "1",
  NO_PROXY: "127.0.0.1,localhost",
};

/** What the runner hands `query()` for one execution: its working directory and environment. */
export interface ChildPlacement {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The harness directory made ready, and the child's environment for one
 * budget.
 *
 * THE ONBOARDING FILE IS WRITTEN ONCE, when absent: a config directory whose
 * `.claude.json` says onboarding is complete is one the CLI does not spend a
 * key-validation call on (claude-code#26935). The CLI keeps that file
 * afterwards, so it is never overwritten here.
 *
 * THE OUTPUT CAP AND THE EFFORT ARE THE BUDGET'S. The CLI reads its
 * per-call `max_tokens` from `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; an absent
 * effort is `CLAUDE_CODE_EFFORT_LEVEL=unset`, which is the CLI's word for
 * «send no effort at all» — without it the CLI sends a default of its own,
 * and an unset budget must mean the model's own default (`Budget.effort`).
 * A present effort travels as the SDK's `effort` option (`runner.ts`,
 * `session.ts`).
 *
 * `run` SAYS WHICH SHAPE THE CHILD SERVES: a `session` child also names its
 * session folder (`SESSION_CHILD_ENV`), so its file is found by one rule.
 */
export function placeChild(
  harness: Harness,
  budget: Budget,
  run: "single" | "session" = "single",
): ChildPlacement {
  const config = join(harness.directory, "config");
  const cwd = workspaceOf(harness);
  mkdirSync(config, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const onboarding = join(config, ".claude.json");
  if (!existsSync(onboarding)) {
    writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true }));
  }
  return {
    cwd,
    env: {
      ...FIXED_CHILD_ENV,
      ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
      HOME: harness.directory,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_API_KEY: harness.apiKey,
      ...(harness.baseUrl === undefined
        ? {}
        : { ANTHROPIC_BASE_URL: harness.baseUrl }),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(budget.maxTokens),
      ...(budget.effort === undefined ? { CLAUDE_CODE_EFFORT_LEVEL: "unset" } : {}),
      ...(run === "session" ? SESSION_CHILD_ENV : {}),
    },
  };
}

/**
 * THE TWIN'S WORKSPACE: the directory every child of this harness works in
 * — its `cwd`, and the one directory the SDK's file tools may touch
 * (ticket #326; spec #318 decision 35; ADR-0011 as amended). It sits inside
 * the harness directory beside the CLI's own config, so it is the twin's
 * alone and inside FR-73's recorded gap with everything else there.
 */
export function workspaceOf(harness: Pick<Harness, "directory">): string {
  return join(harness.directory, "work");
}

/**
 * What a session's child carries beyond every child's variables
 * (`session.ts`; ticket #319).
 *
 * `CLAUDE_CODE_PROJECT_DIR_NAME` names the folder the conversation file is
 * written in, so its path is one rule (`sessionFile`) rather than the CLI's
 * sanitising of a working directory whose spelling differs by platform
 * (spike #290 fact 2).
 */
const SESSION_CHILD_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_PROJECT_DIR_NAME: "twin",
};

/**
 * Where a session's conversation file lies inside its harness directory:
 * `config/projects/twin/<id>.jsonl`, plaintext JSONL written by the child
 * (spike #290 fact 2) — the file FR-73 reports under the harness directory's
 * recorded gap.
 */
export function sessionFile(directory: string, sessionId: string): string {
  return join(directory, "config", "projects", SESSION_CHILD_ENV["CLAUDE_CODE_PROJECT_DIR_NAME"]!, `${sessionId}.jsonl`);
}

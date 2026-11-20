/**
 * THE SDK'S OWN TOOLS, ALLOWED BY NAME, AND THE WORKSPACE THEY WORK IN
 * (ticket #326; spec #318 decisions 9 and 35; ADR-0011, ADR-0013 and
 * ADR-0014 as amended 2026-09-27).
 *
 * The CLI the SDK spawns carries tools of its own. Six are allowed, each where
 * a definition names it and nowhere else: `Read`, `Glob`, `Grep`, `Write` and
 * `Edit` on the twin's workspace, and `WebSearch`. `Bash` and `WebFetch` stay
 * off until the unit's egress is enforced at the network, so no definition may
 * name them (`assertDefinition`), and `DISALLOWED_SDK_TOOLS` names them to the
 * CLI besides.
 *
 * THE GATE IS THE TOOL'S, AS EVERY TOOL'S IS (ADR-0013 as amended): the reads
 * and the search are projections — the files are the twin's own, inside the
 * unit — and `Write` and `Edit` are disclosed-and-undoable-after, through the
 * version the runtime snapshots at the step boundary (ADR-0011). The owning
 * app reads these gates when it lets a definition name the tools, so a
 * definition names an SDK tool exactly as it names one of ours.
 *
 * THE WORKSPACE IS THE CHILD'S OWN WORKING DIRECTORY (`workspaceOf`), and a
 * `PreToolUse` hook holds every file tool to it: each path a call carries is
 * resolved through the links on disk and refused when it lands outside, with a
 * reason the model can act on. The SDK has no option that confines its file
 * tools to a directory; its hooks are where a call is stopped before it runs.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { Gate } from "./tool.js";

/** The SDK tools a definition may name, in the order the ADR lists them. */
export const SDK_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "WebSearch"] as const;
export type SdkTool = (typeof SDK_TOOLS)[number];

/** Whether a name is one of the SDK tools a definition may name. */
export function isSdkTool(name: string): name is SdkTool {
  return (SDK_TOOLS as readonly string[]).includes(name);
}

/**
 * Each SDK tool's gate (ADR-0013 as amended 2026-09-27: «the harness's own
 * tools are mapped, not exempted»).
 */
export const SDK_TOOL_GATES: Readonly<Record<SdkTool, Gate>> = Object.freeze({
  Read: "projection",
  Glob: "projection",
  Grep: "projection",
  Write: "disclosed-and-undoable-after",
  Edit: "disclosed-and-undoable-after",
  WebSearch: "projection",
});

/** The SDK tools that work on the workspace: every one but the search. */
export const WORKSPACE_FILE_TOOLS: readonly SdkTool[] = ["Read", "Glob", "Grep", "Write", "Edit"];

/**
 * THE ACT WORD A WRITE INTO THE WORKSPACE RECORDS (ticket #326): the effect
 * a `Write` or an `Edit` performed, read off the call the CLI ran — so a turn
 * that wrote a file and said nothing is `acted`, as any turn whose effect
 * performed is.
 */
export const WROTE_ACT = "wrote";

/** The SDK tools whose call is an effect: the two that write. */
const WRITING_TOOLS: ReadonlySet<string> = new Set<SdkTool>(["Write", "Edit"]);

/** Whether an SDK tool's call writes into the workspace. */
export function writesTheWorkspace(tool: string): boolean {
  return WRITING_TOOLS.has(tool);
}

/**
 * Why a call of an SDK tool reaches outside the workspace, or nothing.
 *
 * EVERY PATH THE CALL CARRIES IS READ: a file tool's `file_path`, a search's
 * `path`, and a pattern's own directory — an absolute pattern, or one that
 * climbs with `..`, names a place of its own. Each is resolved against the
 * workspace and then through every link on disk, so a link inside the
 * workspace that points out of it is outside, and a link that points nowhere
 * is refused rather than written through.
 */
export function workspaceViolation(workspace: string, tool: string, input: unknown): string | undefined {
  if (!(WORKSPACE_FILE_TOOLS as readonly string[]).includes(tool)) return undefined;
  const given = (input ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  const named = (field: string): string | undefined => {
    const value = given[field];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  if (tool === "Read" || tool === "Write" || tool === "Edit") {
    const path = named("file_path");
    if (path === undefined) return "`file_path` names the file, inside your workspace";
    paths.push(path);
  } else {
    const base = named("path") ?? workspace;
    paths.push(base);
    for (const field of ["pattern", "glob"]) {
      const pattern = tool === "Grep" && field === "pattern" ? undefined : named(field);
      if (pattern === undefined) continue;
      if (pattern.split(/[\\/]/u).includes("..")) return `\`${field}\` climbs out of the folder it searches`;
      if (isAbsolute(pattern)) paths.push(staticPrefix(pattern));
    }
  }
  const home = realOf(workspace);
  if (home === undefined) return "your workspace is not there to work in";
  for (const path of paths) {
    const real = realOf(resolve(workspace, path));
    if (real === undefined || (real !== home && !real.startsWith(`${home}${sep}`))) {
      return `${path} is outside your workspace`;
    }
  }
  return undefined;
}

/** A glob's directory before its first wildcard: where it starts looking. */
function staticPrefix(pattern: string): string {
  const parts = pattern.split("/");
  const fixed = parts.findIndex((part) => /[*?[\]{}]/u.test(part));
  return fixed === -1 ? pattern : parts.slice(0, fixed).join("/") || "/";
}

/**
 * Where a path really is: its nearest existing ancestor resolved through every
 * link, with the rest of the path after it — or nothing, when a link on the way
 * points nowhere.
 */
function realOf(path: string): string | undefined {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    let exists = true;
    try {
      lstatSync(current);
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        return join(realpathSync(current), ...rest.reverse());
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    rest.push(basename(current));
    current = parent;
  }
}

/**
 * A path as the record names it: relative to the workspace, both resolved
 * through the links on disk — the CLI may hand the model the workspace by
 * either spelling of a linked directory (`/var` and `/private/var`).
 */
export function workspacePath(workspace: string, path: string): string {
  const home = realOf(workspace) ?? workspace;
  return relative(home, realOf(resolve(workspace, path)) ?? resolve(workspace, path));
}

/**
 * THE `PreToolUse` HOOK THAT HOLDS THE FILE TOOLS TO THE WORKSPACE: a call
 * whose path lands outside is denied before the CLI runs it, the reason handed
 * to the model as that call's error, and `denied` told so the turn's trace
 * can say so. Every other call passes to the next hook.
 */
export function confineToWorkspace(
  workspace: string,
  denied?: (tool: string, input: unknown, reason: string) => void,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const violation = workspaceViolation(workspace, input.tool_name, input.tool_input);
    if (violation === undefined) return {};
    const reason = `${input.tool_name} works only inside your workspace (${workspace}): ${violation}. Use a path inside it.`;
    denied?.(input.tool_name, input.tool_input, reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
}

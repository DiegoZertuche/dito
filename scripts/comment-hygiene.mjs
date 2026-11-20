#!/usr/bin/env node
/**
 * Comment hygiene report (AGENTS.md, "Comments"): the phrases that mark a
 * comment as narrating history, or as naming landed work as future. PRs
 * #189 and #190 pruned both kinds by hand across twenty files; this lists
 * them at entry. It REPORTS and never fails, because some hits are
 * legitimate pointers, so the PR body accounts for what is listed.
 *
 *   node scripts/comment-hygiene.mjs                 # comment lines added since the merge-base with origin/main
 *   node scripts/comment-hygiene.mjs --base <ref>    # ... since <ref>; a missing ref is fetched at depth 1
 *   node scripts/comment-hygiene.mjs --all           # every comment line in the tree (a slice-boundary sweep)
 *
 * Flags:
 *   --issues       resolve each #NN in a placeholder through `gh issue view`
 *                  and mark a CLOSED ticket as rot (needs gh and a token).
 *   --fail-on-rot  exit 1 when a placeholder names a CLOSED ticket; for the
 *                  boundary sweep, never for CI.
 *
 * Writes the same report to $GITHUB_STEP_SUMMARY when set. Comment lines
 * are recognised by prefix, which is enough for a report: this tree writes
 * block comments with a leading `*` on every line.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HISTORY = [
  /\bused to\b/i,
  /\b(Codex )?(round|r) ?\d\b.*\b(found|asked|caught|fixed|moved|changed)\b/i,
  /\bthis slice\b/i,
  /\bsince (ticket )?#\d+/i,
  /\buntil this ticket\b/i,
  /\bmoved here\b/i,
  /\bthe first cut\b/i,
  /\bno longer\b/i,
];
/** Group 1, where present, is the ticket the placeholder waits on. */
const PLACEHOLDER = [
  /\barrives? with #(\d+)/i,
  /#(\d+)'s (?:to |own |work|remainder|sweep)/i,
  /\bis #(\d+)'s\b/i,
  /\buntil #(\d+)/i,
  /\buntil (?:5b|the crossing)\b/i,
  /\bnext to go\b/i,
  /\blater in (?:the|this) slice\b/i,
  /\bthe day .{0,40}\b(?:lands|arrives|exists)\b/i,
  /\bwhen #(\d+) (?:lands|arrives|ships)/i,
  /\bwill (?:be|move|become|arrive|land)\b/i,
  /\b(?:pending|deferred) (?:to|until) #(\d+)/i,
];
const SKIP = new Set(["node_modules", "dist", ".next", ".git", ".tools", "rig-data"]);
const COMMENT_PREFIX = {
  ts: /^\s*(\/\/|\/\*|\*)/,
  go: /^\s*(\/\/|\/\*|\*)/,
  sql: /^\s*--/,
  sh: /^\s*#/,
};
const KIND = { ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "ts", ".mjs": "ts", ".cjs": "ts", ".go": "go", ".sql": "sql", ".sh": "sh" };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// A BRANCH'S WHOLE DIFF CAN RUN TO MEGABYTES — a deleted suite is all of it —
// and the default 1 MB buffer would stop the report on the branches that
// most need one.
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

function git(...argv) {
  return execFileSync("git", argv, { encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT });
}
function commitExists(ref) {
  return spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

/** [file, line, text] for every comment line in scope. */
function addedCommentLines(base) {
  const diff = git("diff", "-U0", "--no-color", base);
  const lines = [];
  let file;
  let kind;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : undefined;
      kind = file === undefined ? undefined : KIND[path.extname(file)];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const text = raw.slice(1);
      if (kind && COMMENT_PREFIX[kind].test(text)) lines.push([file, next, text]);
      next += 1;
    }
  }
  return lines;
}
function allCommentLines(dir) {
  const lines = [];
  const visit = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      const kind = KIND[path.extname(entry.name)];
      if (!kind) continue;
      fs.readFileSync(child, "utf8")
        .split("\n")
        .forEach((text, i) => {
          if (COMMENT_PREFIX[kind].test(text)) lines.push([path.relative(dir, child), i + 1, text]);
        });
    }
  };
  visit(dir);
  return lines;
}

const states = new Map();
function issueState(number) {
  if (!flag("--issues")) return undefined;
  if (states.has(number)) return states.get(number);
  let state = "unknown";
  try {
    const remote = git("remote", "get-url", "origin").trim();
    const repo = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote)?.[1];
    if (repo) {
      const out = spawnSync("gh", ["issue", "view", number, "--repo", repo, "--json", "state", "-q", ".state"], { encoding: "utf8" });
      if (out.status === 0) state = out.stdout.trim();
    }
  } catch {
    state = "unknown";
  }
  states.set(number, state);
  return state;
}

let scope;
let lines;
if (flag("--all")) {
  scope = "every comment line in the tree";
  lines = allCommentLines(process.cwd());
} else {
  let base = option("--base");
  if (base === undefined || /^0+$/.test(base)) {
    base = commitExists("origin/main") ? git("merge-base", "origin/main", "HEAD").trim() : "HEAD~1";
  }
  if (!commitExists(base)) {
    spawnSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "ignore" });
  }
  if (!commitExists(base)) {
    console.log(`comment-hygiene: base ${base} is not available; nothing to report`);
    process.exit(0);
  }
  scope = `comment lines added since ${base.slice(0, 12)}`;
  lines = addedCommentLines(base);
}

const hits = [];
let rot = 0;
for (const [file, line, text] of lines) {
  const trimmed = text.trim();
  if (HISTORY.some((re) => re.test(trimmed))) hits.push([file, line, "history", trimmed]);
  const placeholders = PLACEHOLDER.map((re) => re.exec(trimmed)).filter((m) => m !== null);
  if (placeholders.length > 0) {
    const tickets = [...new Set(placeholders.map((m) => m[1]).filter((n) => n !== undefined))];
    const closed = tickets.filter((n) => issueState(n) === "CLOSED");
    if (closed.length > 0) rot += 1;
    const label = closed.length > 0 ? `placeholder, #${closed.join(" #")} CLOSED` : "placeholder";
    hits.push([file, line, label, trimmed]);
  }
}

const report = [`comment-hygiene: ${scope} — ${lines.length} comment line(s), ${hits.length} hit(s), ${rot} naming a closed ticket`];
for (const [file, line, label, text] of hits) report.push(`  ${file}:${line}  [${label}]  ${text.length > 110 ? `${text.slice(0, 110)}…` : text}`);
console.log(report.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Comment hygiene\n\n\`\`\`text\n${report.join("\n")}\n\`\`\`\n`);
}
if (flag("--fail-on-rot") && rot > 0) process.exit(1);

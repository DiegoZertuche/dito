#!/usr/bin/env node
/**
 * A PUBLISHED DOCUMENT VERSION NEVER CHANGES (ticket #219 AC 1; spec #214
 * decision 6 and user story 12; ADR-0011's immutable versions).
 *
 * "I want every acknowledgment to record exactly which version of the text I
 * read, so that nobody can later claim I agreed to different words." An
 * acknowledgment row stores a key and a number, so those two have to name
 * the same words for ever.
 *
 *   node scripts/copy-versions-check.mjs --base <ref-or-sha>
 *   node scripts/copy-versions-check.mjs --against <a baseline file>
 *
 * WHY A GIT CHECK AND NOT A TEST (Codex r1, r2). `documents.test.ts`
 * recomputes each entry's digest from the text beside it, which catches an
 * edit that forgot to re-run the digest and nothing else: an author who
 * edits both publishes different words under an existing version and every
 * assertion passes. No check that reads only the working tree can tell that
 * apart from a version written correctly the first time — the two look
 * identical. What distinguishes them is HISTORY, so the baseline is the
 * merge base, and the only tool that holds it is git.
 *
 * IT IS `comment-hygiene.mjs`'s SHAPE, and resolves its base the same way,
 * for the same reason: CI hands a base sha that is all zeros on a branch's
 * first push, clones at depth 1 so the base commit may not be in the object
 * store, and can hand a ref a fetch will not find. `resolveBase` handles all
 * three — and where that script REPORTS, this one is a GATE, so a base it
 * cannot see is inconclusive and non-zero rather than a quiet pass.
 *
 * THE RULE, in both directions:
 *
 *   - a (key, version) pair the base published must still exist, and its
 *     digest must be the same byte for byte;
 *   - a NEW version is welcome — that is what "a new text is a new version"
 *     means — and a version the base did not have is not compared;
 *   - a pair the base published and the tree no longer has is a REMOVAL,
 *     which is the same failure wearing different clothes: an
 *     acknowledgment naming it would name nothing.
 *
 * WHAT IT STILL CANNOT SEE is a text edited and re-published in the SAME
 * commit series that introduced it, because the base never held it. That is
 * a version nobody has acknowledged yet, so nothing is being rewritten out
 * from under a rep.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCUMENTS = "packages/copy/src/documents.ts";

const flag = (name) => {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(`--${name}=`.length);
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const base = flag("base");
/**
 * A baseline read from a FILE rather than from git.
 *
 * THE TEST SEAM, and the same one `copy-check.mjs`'s `--app` is: the rule
 * this script holds is about two revisions of one file, and a suite cannot
 * conjure a second revision into git. So it plants one, exactly as the copy
 * check's suite plants a rep-web, and CI still uses `--base`.
 */
const against = flag("against");

/**
 * Every `(key, version, digest)` this source publishes.
 *
 * A REGEX OVER THE SOURCE, because the baseline's version of this file
 * cannot be imported — it is a blob in git, not a module, and building it
 * would mean compiling an arbitrary past revision. The three fields are
 * matched as one block in the order the entries are written, so a reordered
 * or renamed field is a parse miss rather than a wrong answer, and a parse
 * that finds nothing where the file exists is reported as a failure.
 */
function published(source) {
  const found = [];
  const entry =
    /key:\s*"(?<key>[a-z_]+)",\s*version:\s*(?<version>\d+),[\s\S]*?digest:\s*\n?\s*"(?<digest>[0-9a-f]{64})"/gu;
  for (const match of source.matchAll(entry)) {
    const { key, version, digest } = match.groups;
    found.push({ key, version: Number(version), digest });
  }
  return found;
}

/** Whether a ref names a commit this clone actually holds. */
function commitExists(ref) {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: REPO,
    }).status === 0
  );
}

/**
 * The base this run compares against, resolved the way
 * `comment-hygiene.mjs` resolves its own.
 *
 * THREE THINGS CI DOES THAT A LAPTOP DOES NOT, and every one of them would
 * otherwise turn this gate into a silent pass:
 *
 *   - `github.event.before` is ALL ZEROS on a branch's first push, which is
 *     not a commit at all;
 *   - `actions/checkout@v4` clones at depth 1, so the base commit — and
 *     `origin/main` — may not be in the object store;
 *   - a fetch can still come back empty on a fork or a force-push.
 *
 * So a zero base falls back to the merge base with `origin/main` (or the
 * previous commit when even that is absent), a missing commit is fetched at
 * depth 1, and a base this clone genuinely cannot see is INCONCLUSIVE and
 * exits non-zero. A gate that cannot see history has proved nothing, and
 * "proved nothing" is not green (ADR-0028 doctrine).
 */
function resolveBase(asked) {
  let ref = asked;
  if (ref === undefined || ref === "" || /^0+$/u.test(ref)) {
    ref = commitExists("origin/main")
      ? execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
          cwd: REPO,
          encoding: "utf8",
        }).trim()
      : "HEAD~1";
  }
  if (!commitExists(ref)) {
    spawnSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ref], {
      cwd: REPO,
      stdio: "ignore",
    });
  }
  return commitExists(ref) ? ref : undefined;
}

/** The file as the base published it, or undefined when the base had none. */
function atBase(ref) {
  try {
    return execFileSync("git", ["show", `${ref}:${DOCUMENTS}`], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

if (against === undefined && (base === undefined || base === "")) {
  console.error(
    "COPY VERSIONS INCONCLUSIVE: no --base <ref>. This check compares the published (document, version, digest) triples against a baseline, and without one it can prove nothing — pass the branch's merge base.",
  );
  process.exit(1);
}

const now = published(readFileSync(path.join(REPO, DOCUMENTS), "utf8"));
if (now.length === 0) {
  console.error(
    `COPY VERSIONS RED: parsed no published version out of ${DOCUMENTS}. Either the file holds none — which nothing else in this repo expects — or its shape moved and this script's parse went stale.`,
  );
  process.exit(1);
}

let resolved;
if (against === undefined) {
  resolved = resolveBase(base);
  if (resolved === undefined) {
    console.error(
      `COPY VERSIONS INCONCLUSIVE: this clone cannot see ${base}, even after a depth-1 fetch — so nothing was compared. A gate that cannot see history has proved nothing (ADR-0028 doctrine).`,
    );
    process.exit(1);
  }
}
const before =
  against === undefined
    ? atBase(resolved)
    : readFileSync(path.resolve(against), "utf8");
const baseline = against === undefined ? resolved : against;
if (before === undefined) {
  console.log(
    `Copy versions: ${now.length} published version(s); ${baseline} has no ${DOCUMENTS}, so nothing was published before this branch and there is nothing to compare.`,
  );
  process.exit(0);
}

const violations = [];
for (const was of published(before)) {
  const is = now.find(
    (entry) => entry.key === was.key && entry.version === was.version,
  );
  if (is === undefined) {
    violations.push(
      `${was.key} v${was.version} was published at ${baseline} and is gone — an acknowledgment naming it would name nothing`,
    );
    continue;
  }
  if (is.digest !== was.digest) {
    violations.push(
      `${was.key} v${was.version} holds different words than it did at ${baseline} (${was.digest.slice(0, 12)}… → ${is.digest.slice(0, 12)}…)`,
    );
  }
}

console.log(
  `Copy versions: ${now.length} published version(s) against ${baseline}'s ${published(before).length}, ${violations.length} violation(s)`,
);
for (const violation of violations) console.error(`  VIOLATION ${violation}`);

if (violations.length > 0) {
  console.error(
    "COPY VERSIONS RED: a published document version is immutable (spec #214 decision 6; user story 12). A rep's acknowledgment names a key and a number, so those two must name the same words for ever — append a NEW version instead.",
  );
  process.exit(1);
}
console.log(
  "Copy versions green: every version the baseline published still holds the same words.",
);

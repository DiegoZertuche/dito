#!/usr/bin/env node
/**
 * Stacked-docblock check (AGENTS.md, "Comments"): a JSDoc block whose next
 * non-blank line opens another JSDoc block is a docblock that lost its
 * declaration. PR #189 re-homed four, and every one was a declaration
 * inserted between a docblock and the function it described. Two docblocks
 * on one declaration is always a defect, so this fails.
 *
 *   node scripts/docblock-check.mjs             # the whole tree
 *   node scripts/docblock-check.mjs <paths...>  # files or directories
 *
 * A module header or a section comment above a BLANK line is not stacked:
 * the blank line is what separates it from the next declaration's own
 * docblock, and the tree carries a dozen of those on purpose. TypeScript
 * and JavaScript only: Go binds a doc comment to its declaration by
 * position and gofmt keeps them attached.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SKIP = new Set(["node_modules", "dist", ".next", ".git", ".tools", "rig-data"]);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SOURCE.test(target)) yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (SOURCE.test(entry.name)) yield child;
  }
}

/** The stacked pairs in one file: [line of the orphan, line of the declaration's docblock]. */
function stackedIn(file) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const seen = new Set();
  const found = [];
  const visit = (node) => {
    if (!seen.has(node.pos)) {
      seen.add(node.pos);
      const docblocks = (ts.getLeadingCommentRanges(text, node.pos) ?? []).filter(
        (range) =>
          range.kind === ts.SyntaxKind.MultiLineCommentTrivia && text.startsWith("/**", range.pos),
      );
      for (let i = 1; i < docblocks.length; i += 1) {
        const between = text.slice(docblocks[i - 1].end, docblocks[i].pos);
        if (!/\n[ \t]*\n/.test(between)) {
          found.push([
            source.getLineAndCharacterOfPosition(docblocks[i - 1].pos).line + 1,
            source.getLineAndCharacterOfPosition(docblocks[i].pos).line + 1,
          ]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const targets = process.argv.slice(2);
const root = process.cwd();
let files = 0;
const violations = [];
for (const target of targets.length > 0 ? targets : ["."]) {
  for (const file of walk(target)) {
    files += 1;
    for (const [orphan, docblock] of stackedIn(file)) {
      violations.push(`${path.relative(root, file)}:${orphan}: docblock stacked on the one at line ${docblock}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`docblock-check: ${violations.length} stacked docblock(s) in ${files} file(s)`);
  for (const line of violations) console.error(`  ${line}`);
  console.error(
    "A docblock stacked on another lost its declaration. Move the declaration it describes back under it, or delete it if nothing remains to say (AGENTS.md, Comments).",
  );
  process.exit(1);
}
console.log(`docblock-check: ${files} file(s), no stacked docblocks`);

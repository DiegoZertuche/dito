#!/usr/bin/env node
/**
 * THE COPY CHECK — no rep-facing string in rep-web is a literal (ticket
 * #219 AC 2; spec #214 decision 13 and user story 47; ADR-0037 as amended).
 *
 * Every rep-facing string of the dashboard lives in `@dito/copy`, keyed. A
 * rule like that is a memory unless CI holds it, so this sweeps rep-web's
 * sources for a literal that reads as rep-facing copy and fails on one.
 *
 *   node scripts/copy-check.mjs [--app=<dir>] [--require-app]
 *
 * IT IS THE COMPOSED-LANGUAGE SWEEP'S SHAPE, and carries that sweep's two
 * rules unchanged (`packages/twin-runtime/src/composed-language.test.ts`):
 * the es-MX ORTHOGRAPHY character class, and the function-word DENSITY rule
 * that catches a sentence written without its accents. Both have been argued
 * three times already — by the owner twin's sweep, by the rep side's, and by
 * two rounds of Codex against each — so neither is re-invented here. The
 * scanner is the same hand-written one, for the same reason: a comment
 * quoting «Esperan tu visto bueno» and a constant that IS one differ only in
 * their surrounding syntax.
 *
 * AND IT ADDS TWO RULES THOSE TWO CANNOT REACH, because what is being swept
 * is different. The sweep next door is about SENTENCES A TWIN SAYS, and its
 * blind spot — a one- or two-word fragment carrying no accent — is held by
 * the shape of the rep-side packages, where the twin's words are rendered in
 * one module. A PAGE has no such shape, and its copy is mostly exactly that
 * fragment: «Enviar», «Esperan tu visto bueno». So POSITION decides, not
 * language: any text an element WRAPS is an offender (`JSX_TEXT`), so is any
 * text a rendering ATTRIBUTE carries (`TEXT_ATTRIBUTE`), and so is every
 * literal a page RENDERS out of an expression container in child position
 * (`childExpressionLiterals`: `<button>{"Enviar"}</button>` is the same
 * button with the same word in it, and so is one whose label depends on
 * state). A KEY is none of those, and the same walk is what tells them
 * apart.
 * The rule over rep-web is therefore stronger than the rule over the
 * packages, which is what "every rep-facing string of the dashboard is a key"
 * actually means.
 *
 * WHY A SCRIPT RATHER THAN A TEST IN THE APP. The check has to run when the
 * app does not exist, which is today: rep-web is #221's. A vitest suite
 * inside `apps/rep-web` could not be collected from a directory that is not
 * there, and one outside it would be a test about a path — so the rule is a
 * script CI calls, in `ledger-grants-check.mjs`'s shape, and its bite is
 * proven by `packages/copy/src/copy-check.test.ts`, which plants a rep-web
 * and drives this file.
 *
 * IT CARRIES NO DEPENDENCIES, on purpose. `ledger-grants-check.mjs` imports
 * a package's `dist` and therefore needs `pnpm build` first; this one runs
 * before anything is built, in the unit job beside the docblock check, so
 * everything it needs is in this file.
 *
 * AN EMPTY SWEEP IS NOT A PASS (ADR-0028 doctrine, #84). With no rep-web the
 * report says it scanned nothing and proves nothing, in as many words, and
 * `--require-app` turns that into a failure — which is the flag the CI step
 * gains the day the app lands.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE ALLOWLIST — what rep-web is still allowed to hold, and why.
 *
 * IT IS EMPTY, and that is the state ADR-0037's amendment asks for rather
 * than a coincidence: rep-web holds no rep-facing string at all, because
 * every one of them is a key into `@dito/copy`. The shape stays so that an
 * exemption is a reviewable line with a reason and an expiry rather than a
 * condition somebody widens — the argument the composed-language allowlist
 * makes at length, one package over.
 *
 * An entry is `{ file, literal, reason, expiry }`: the repo-relative path,
 * the literal exactly as the scanner reads it, one English sentence for why
 * code still owns it, and what retires it. It is checked in BOTH directions
 * — an entry whose literal its file no longer holds fails the sweep too, so
 * a retired sentence cannot leave a standing exemption behind.
 *
 * @type {readonly {file: string, literal: string, reason: string, expiry: string}[]}
 */
const ALLOWLIST = [];

/**
 * Spanish orthography: the two inverted marks, the angle quotes the product
 * writes speech in, the five accented vowels and the eñe. The rep-side
 * sweep's character class, character for character.
 */
const ES_MX = /[¿¡«»áéíóúüñÁÉÍÓÚÜÑ]/u;

/**
 * ...AND SPANISH WITHOUT ITS ORTHOGRAPHY: two or more DISTINCT function
 * words, and at least a third of the literal's words. Function words are
 * what a SENTENCE is made of and what a key, a class list and an English
 * string are not, and the PROPORTION is what stops a long English sentence
 * that happens to contain `a` and `no` reading as Spanish. The rep-side
 * sweep's list, word for word.
 */
const ES_MX_FUNCTION_WORDS = [
  "a", "al", "algo", "asi", "como", "con", "de", "del", "donde", "el", "ella",
  "ellos", "en", "es", "esa", "ese", "eso", "esta", "este", "hay", "la", "las",
  "le", "les", "lo", "los", "mas", "me", "mi", "muy", "nada", "ni", "no", "nos",
  "o", "para", "pero", "por", "puedo", "que", "se", "si", "sin", "sobre", "solo",
  "son", "soy", "su", "sus", "te", "tengo", "ti", "tu", "un", "una", "uno", "y",
  "ya", "yo",
];

/** Whether a literal reads as a Spanish sentence rather than as a name. */
function readsAsSpanish(literal) {
  const words = literal
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word !== "");
  const found = new Set(
    words.filter((word) => ES_MX_FUNCTION_WORDS.includes(word)),
  );
  return found.size >= 2 && found.size / words.length >= 1 / 3;
}

/** Either rule: the orthography, or the shape of a sentence. */
function isRepFacing(literal) {
  return ES_MX.test(literal) || readsAsSpanish(literal);
}

/**
 * The separator that joins a file to a literal in a lookup key.
 *
 * A NUL, WRITTEN AS AN ESCAPE AND NEVER AS THE BYTE: a raw NUL in a source
 * makes git treat the whole file as binary — no diff, no blame, no grep —
 * which is exactly the "a diff nobody reviews" failure this repo's
 * conventions exist to prevent. It is a NUL rather than a punctuation mark
 * because a literal may legitimately contain any of those.
 */
const AT = "\u0000";

/** Every file under a directory, depth first, skipping generated trees. */
const SKIP = new Set(["node_modules", "dist", ".next", ".git", "coverage"]);
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * One source, scanned: every string and template literal in it, and the
 * source with every comment and literal blanked out.
 *
 * A HAND-WRITTEN SCANNER RATHER THAN A REGEX: the two things this has to
 * tell apart — a comment that quotes a Spanish phrase and a constant that
 * IS one — differ only in their surrounding syntax. It is a scanner and not
 * a parser: it tracks which state each character is in and nothing else.
 * The rep-side sweep's, so a rule that has to hold on both sides of the
 * dashboard is the same rule on both. Comments, regular expressions and
 * interpolated expressions are excluded, escapes are decoded, and each
 * `${…}` is rendered as `{}`.
 *
 * THE BLANKED SOURCE IS WHAT MAKES JSX TEXT READABLE (see `repFacing`).
 * Every span this scanner consumed as a comment or a literal becomes
 * spaces, so what is left is code and JSX markup — and a `>…<` run in it is
 * text a page renders rather than a comment that happens to sit between two
 * angle brackets.
 *
 * NOT EXPORTED, and neither is `repFacing`. This module runs the sweep and
 * exits when it loads, so an import would kill the importer — `ledger-
 * grants-check.mjs`'s shape, where the rule is a script and its proof drives
 * the script (`packages/copy/src/copy-check.test.ts` spawns it).
 */
function scanSource(source) {
  const found = [];
  /** The spans consumed as a comment or a literal, in increasing order. */
  const blanks = [];
  /** The comment spans alone — what `code` blanks and `stripped` also does. */
  const comments = [];
  let at = 0;
  /** The last significant character, which is how a regex is told from a division. */
  let previous = "";

  while (at < source.length) {
    const here = source[at];
    const next = source[at + 1];
    if (here === "/" && next === "/") {
      const start = at;
      while (at < source.length && source[at] !== "\n") at += 1;
      blanks.push([start, at]);
      comments.push([start, at]);
      continue;
    }
    if (here === "/" && next === "*") {
      const start = at;
      at += 2;
      while (at < source.length && !(source[at] === "*" && source[at + 1] === "/")) {
        at += 1;
      }
      at += 2;
      blanks.push([start, Math.min(at, source.length)]);
      comments.push([start, Math.min(at, source.length)]);
      continue;
    }
    if (here === "/" && opensARegex(previous, at)) {
      const start = at;
      at = pastRegex(at);
      blanks.push([start, at]);
      previous = "/";
      continue;
    }
    if (here === '"' || here === "'") {
      const quote = here;
      const start = at;
      at += 1;
      let literal = "";
      while (at < source.length && source[at] !== quote) {
        if (source[at] === "\\") {
          const decoded = unescape(source, at + 1);
          literal += decoded.text;
          at += 1 + decoded.length;
          continue;
        }
        literal += source[at];
        at += 1;
      }
      at += 1;
      found.push(literal);
      blanks.push([start, Math.min(at, source.length)]);
      previous = quote;
      continue;
    }
    if (here === "`") {
      const start = at;
      const read = template(at);
      found.push(read.literal);
      at = read.at;
      blanks.push([start, Math.min(at, source.length)]);
      previous = "`";
      continue;
    }
    if (!/\s/u.test(here)) previous = here;
    at += 1;
  }

  /** One template literal, with every `${…}` rendered as a hole. */
  function template(start) {
    let at = start + 1;
    let literal = "";
    while (at < source.length && source[at] !== "`") {
      if (source[at] === "\\") {
        const decoded = unescape(source, at + 1);
        literal += decoded.text;
        at += 1 + decoded.length;
        continue;
      }
      if (source[at] === "$" && source[at + 1] === "{") {
        literal += "{}";
        at = pastExpression(at + 2);
        continue;
      }
      literal += source[at];
      at += 1;
    }
    return { literal, at: at + 1 };
  }

  /**
   * Past one `${…}`, balanced. An interpolation is CODE — but a string or a
   * template inside it is still a literal in its own right, so it is
   * collected rather than skipped.
   */
  function pastExpression(from) {
    let at = from;
    let depth = 1;
    while (at < source.length && depth > 0) {
      const here = source[at];
      if (here === "{") {
        depth += 1;
        at += 1;
        continue;
      }
      if (here === "}") {
        depth -= 1;
        at += 1;
        continue;
      }
      if (here === '"' || here === "'") {
        const quote = here;
        at += 1;
        let literal = "";
        while (at < source.length && source[at] !== quote) {
          if (source[at] === "\\") {
            const decoded = unescape(source, at + 1);
            literal += decoded.text;
            at += 1 + decoded.length;
            continue;
          }
          literal += source[at];
          at += 1;
        }
        at += 1;
        found.push(literal);
        continue;
      }
      if (here === "`") {
        const read = template(at);
        found.push(read.literal);
        at = read.at;
        continue;
      }
      if (here === "/" && source[at + 1] === "/") {
        while (at < source.length && source[at] !== "\n") at += 1;
        continue;
      }
      if (here === "/" && source[at + 1] === "*") {
        at += 2;
        while (at < source.length && !(source[at] === "*" && source[at + 1] === "/")) {
          at += 1;
        }
        at += 2;
        continue;
      }
      at += 1;
    }
    return at;
  }

  /**
   * Whether a `/` here starts a regular expression rather than a division,
   * decided by the previous significant token — how every hand-written
   * JavaScript scanner draws this line.
   *
   * `<` AND `>` ARE NOT OPENERS HERE, and that is the one place this
   * scanner differs from the rep-side sweep's. This one reads TSX, where `<`
   * opens a TAG: with `<` in the class, the `/` of `</h2>` reads as a
   * regular expression, the closing tag reaches the blanked source as
   * `< h2>`, and the JSX-text rule below goes blind to the very element it
   * is about. A `/` after a comparison is a division either way, so nothing
   * is lost.
   */
  function opensARegex(previous, at) {
    if (previous === "" || /[({[,;:=!&|?+\-*%~^]/u.test(previous)) return true;
    const before = source.slice(Math.max(0, at - 12), at).trimEnd();
    return [
      "return", "typeof", "instanceof", "case", "in", "of", "new", "delete",
      "void", "do", "else", "yield", "await",
    ].some((word) => before.endsWith(word));
  }

  /** Past one regular expression, character class and flags included. */
  function pastRegex(from) {
    let at = from + 1;
    let inClass = false;
    while (at < source.length) {
      const here = source[at];
      if (here === "\\") {
        at += 2;
        continue;
      }
      // A regex never spans a line, so an unterminated one was a division
      // after all and nothing was consumed.
      if (here === "\n") return from + 1;
      if (inClass) {
        if (here === "]") inClass = false;
        at += 1;
        continue;
      }
      if (here === "[") {
        inClass = true;
        at += 1;
        continue;
      }
      if (here === "/") {
        at += 1;
        while (at < source.length && /[a-z]/u.test(source[at])) at += 1;
        return at;
      }
      at += 1;
    }
    return from + 1;
  }

  const blank = (spans) => {
    let out = "";
    let cursor = 0;
    for (const [start, end] of spans) {
      out += source.slice(cursor, start) + " ".repeat(end - start);
      cursor = end;
    }
    return out + source.slice(cursor);
  };
  return {
    literals: found,
    stripped: blank(blanks),
    code: blank(comments),
  };
}

/**
 * `<tag …>text</` — the text a page puts inside an element.
 *
 * THE CASE THIS EXISTS FOR IS THE COMMON ONE, and the reason the two
 * Spanish rules alone are not enough here. A dashboard's copy is far more
 * often JSX text — `<h2>Esperan tu visto bueno</h2>` — than a string
 * literal, and most of it carries no accent, no eñe and no inverted mark
 * and is two or three words long, so neither the orthography rule nor the
 * density rule can see it. The rep-side sweep records that blind spot and
 * lives with it because the twin's words are rendered in ONE module; a page
 * has no such shape, so the rule here is stronger: **any text an element
 * wraps is an offender**, whatever language it reads as.
 *
 * Braces are excluded from the run, so `<h2>{CHROME["feed.waiting"]}</h2>`
 * is not text at all — an interpolated expression is code, which is exactly
 * the shape the rule wants pages to use.
 *
 * A RUN MAY ALSO START AFTER A `}` (Codex r1), which is the ordinary shape
 * `<p>{count} cajas pendientes</p>`: the text a reader sees sits between an
 * expression and the next tag, with no opening tag in front of it. Without
 * that alternative the rule saw only the FIRST child of an element and
 * anything after an interpolation was invisible.
 *
 * ...AND IT MAY END AT ONE, AND A FRAGMENT IS A TAG (Codex r2). `<p>Hola
 * {name}</p>` puts the words BEFORE the expression, so the run ends at `{`
 * rather than at a tag; `<>Enviar</>` is a fragment, whose opener carries no
 * name. Both are ordinary page shapes and both were invisible — the second
 * especially, since a fragment is what a component returns when it wraps
 * nothing.
 *
 * FOUR FENCES AGAINST READING CODE AS TEXT, because `>` and `<` are also
 * operators and TypeScript's generics: the run must be preceded by an
 * opening TAG or a closing brace, must be followed by a tag or an
 * expression (as a lookahead, so nested inline elements are each seen),
 * must hold a LETTER, and must hold none of `= ; [ ]` — which code has and
 * rendered text does not. A run with a brace on BOTH sides is held to a
 * wider set still (`CODE_SHAPED`), because that is the one shape a type
 * annotation also has. What is left over-reports rather than under-reports,
 * and that is the safe direction — the same disposition the rep-side sweep
 * took for Spanish inside an embedded SQL comment.
 */
const JSX_RUN =
  /(?:(?<tag><[A-Za-z][A-Za-z0-9.]*[^<>]*>|<>)|(?<brace>\}))(?<text>[^<>{}]+)(?=(?<closer><\/?[A-Za-z>]|\{))/gu;

/** Characters rendered text does not carry and code does. */
const CODE_ONLY = /[=;[\]]/u;

/**
 * ...and one SHAPE, for the run every early return in a component produces.
 *
 * A COMPONENT THAT REFUSES FIRST WRITES `}` THEN `return (` THEN A TAG, and
 * that middle run carries none of the four characters above — so it read as
 * "text an element wraps" (#221's `[attempt]/[code]` page drew it). The tell
 * is the tail: a run ending in an opening parenthesis is a call or a
 * parenthesised expression beginning, and rendered copy does not end that way.
 * One character rather than a keyword list, so nothing about JavaScript's
 * vocabulary is being tracked here.
 */
const CODE_TAIL = /\($/u;

/**
 * ...and the wider set, for the one run shape with JSX on NEITHER side.
 *
 * A run between a `}` and a `{` is the middle child of an element with two
 * expressions in it — `<p>{a} y también {b}</p>` — and it is also every
 * `({ x }: { y: string })` in the file, whose `: ` and `)` sit between
 * exactly those two braces. So that shape alone is held to a stricter
 * filter: no parenthesis, no colon, on top of the four characters above.
 * The cost is a middle run of real copy that carries one of those, which is
 * recorded in `copy-check.test.ts` rather than pretended away.
 */
const CODE_SHAPED = /[=;[\]():]/u;

/** A run with no letter in it is punctuation, not copy. */
const HAS_LETTER = /\p{L}/u;

/**
 * The JSX attributes that render text to a person.
 *
 * A LABEL IN AN ATTRIBUTE IS COPY LIKE ANY OTHER, and it is the one place
 * the JSX-text rule cannot reach: `placeholder="Buscar"` renders a word to
 * the rep from inside a tag, with no accent for the orthography rule to
 * catch. Scanned over the source with only its COMMENTS blanked, so a
 * comment quoting an attribute is not an offender and a real attribute is.
 */
const TEXT_ATTRIBUTE =
  /\b(?:title|placeholder|alt|label|aria-label|aria-description)\s*=\s*\{?\s*(["'])([^"']*)\1\s*\}?/gu;

/**
 * Every literal a page RENDERS out of an expression container in child
 * position: `<button>{"Enviar"}</button>`, `{ok ? "Enviar" : "Cancelar"}`,
 * `{ok && "Enviar"}`, `` {`Enviar`} `` (Codex r1, r2, r3).
 *
 * THE SPANISH RULES CANNOT HELP HERE, and that is why this exists at all. A
 * literal inside a JSX expression reaches the two language rules like any
 * other string — and «Enviar» is one accent-free word, which neither rule
 * can see. Its POSITION says everything they cannot: a literal a page
 * renders as an element's child is text a rep reads, in any language.
 *
 * ONE WALK RATHER THAN A PATTERN PER SHAPE. A ternary, a `&&`, a bare
 * literal and a template literal are four spellings of "this expression
 * evaluates to the words on the page", and a regex per spelling both misses
 * the fifth and starts flagging things that are not copy at all — a KEY
 * (`CHROME["feed.waiting"]`, and worse `CHROME[ok ? "draft.send" :
 * "draft.dismiss"]`, which is exactly the pattern this rule exists to make
 * possible) and a call's arguments (`{formatDate(at, "long")}`). So the
 * container is walked once and a literal counts only at BRACKET AND PAREN
 * DEPTH ZERO: inside `[…]` it is a key, inside `(…)` it is an argument, and
 * the rendered value is neither.
 *
 * A NESTED ELEMENT ENDS THE WALK, because its own text is `JSX_RUN`'s and
 * counting it twice would report one offender as two.
 */
function childExpressionLiterals(code) {
  const found = [];
  for (const match of code.matchAll(/(?:>|\})\s*\{/gu)) {
    let at = match.index + match[0].length;
    let braces = 1;
    let brackets = 0;
    let parens = 0;
    while (at < code.length && braces > 0) {
      const here = code[at];
      if (here === "<") break;
      if (here === "{") braces += 1;
      else if (here === "}") braces -= 1;
      else if (here === "[") brackets += 1;
      else if (here === "]") brackets -= 1;
      else if (here === "(") parens += 1;
      else if (here === ")") parens -= 1;
      else if (here === '"' || here === "'" || here === "`") {
        const quote = here;
        at += 1;
        let literal = "";
        while (at < code.length && code[at] !== quote) {
          if (code[at] === "\\") {
            literal += code[at + 1] ?? "";
            at += 2;
            continue;
          }
          literal += code[at];
          at += 1;
        }
        at += 1;
        if (brackets === 0 && parens === 0) found.push(literal);
        continue;
      }
      at += 1;
    }
  }
  return found;
}

/**
 * Every rep-facing string in one source: the literals that read as Spanish,
 * and — IN A FILE THAT CAN HOLD JSX — the text an element wraps, the text a
 * rendering attribute carries, and every literal a page renders out of an
 * expression container.
 *
 * THE THREE POSITION RULES ARE `.tsx`-ONLY, and that gating is not a
 * concession (ticket #221). Every one of them decides by POSITION in JSX
 * markup, and this scanner reads `<` as a tag opener — so in a plain `.ts`
 * module `Promise<RepSession | undefined>` is a tag and whatever follows it is
 * "text an element wraps". #221 landed the first non-JSX modules under
 * `apps/rep-web` and drew sixteen such findings, every one of them TypeScript
 * syntax: an allowlist of type annotations would have been a record of nothing
 * and would have swallowed a real offender in the same file.
 *
 * WHAT THAT LEAVES UNCOVERED, recorded rather than discovered: a one- or
 * two-word accent-free Spanish label sitting in a `.ts` module and rendered by
 * a `.tsx` one. That is precisely the rep-side sweep's own blind spot, and it
 * is held by the same thing that holds it there — the words live in
 * `@dito/copy` and nowhere else, so a constant that is not a key has no reason
 * to exist. A Spanish SENTENCE in a `.ts` module is still caught, by both
 * language rules.
 */
function repFacing(source, jsx) {
  const { literals, stripped, code } = scanSource(source);
  const found = [];
  for (const literal of literals) {
    if (isRepFacing(literal)) found.push(literal);
  }
  if (!jsx) return found;
  for (const match of stripped.matchAll(JSX_RUN)) {
    const { brace, text, closer } = match.groups;
    const run = text.trim();
    if (run === "" || !HAS_LETTER.test(run)) continue;
    const noJsxEitherSide = brace !== undefined && closer.startsWith("{");
    if ((noJsxEitherSide ? CODE_SHAPED : CODE_ONLY).test(run)) continue;
    if (CODE_TAIL.test(run)) continue;
    found.push(run);
  }
  for (const match of code.matchAll(TEXT_ATTRIBUTE)) {
    const text = match[2].trim();
    if (text !== "") found.push(text);
  }
  for (const literal of childExpressionLiterals(code)) {
    const text = literal.trim();
    if (text !== "") found.push(text);
  }
  return found;
}

const ESCAPES = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/**
 * One escape sequence, decoded, with how many characters it took. `\uXXXX`,
 * `\u{…}` and `\xXX` included, because the orthography rule IS a character
 * class and «sí» spelled as a code point would otherwise read as `su00ed`.
 */
function unescape(source, at) {
  const character = source[at];
  if (character === undefined) return { text: "", length: 0 };
  if (character === "u" && source[at + 1] === "{") {
    const close = source.indexOf("}", at + 2);
    if (close !== -1) {
      const point = Number.parseInt(source.slice(at + 2, close), 16);
      if (Number.isFinite(point)) {
        return { text: String.fromCodePoint(point), length: close - at + 1 };
      }
    }
  }
  if (character === "u" || character === "x") {
    const digits = character === "u" ? 4 : 2;
    const code = Number.parseInt(source.slice(at + 1, at + 1 + digits), 16);
    if (Number.isFinite(code) && !Number.isNaN(code)) {
      return { text: String.fromCharCode(code), length: digits + 1 };
    }
  }
  return { text: ESCAPES[character] ?? character, length: 1 };
}

// ── The sweep ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const requireApp = args.includes("--require-app");
const appArg = args.find((arg) => arg.startsWith("--app="));
const app = appArg === undefined
  ? path.join(REPO, "apps/rep-web")
  : path.resolve(appArg.slice("--app=".length));
const where = app.startsWith(REPO + path.sep) ? path.relative(REPO, app) : app;

const allowed = new Set(
  ALLOWLIST.map((entry) => `${entry.file}${AT}${entry.literal}`),
);

/** Every source the sweep reads, app-relative. */
const sources = existsSync(app)
  ? [...walk(app)]
      .filter((file) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(file))
      .filter((file) => !/\.test\.(?:ts|tsx|js|jsx|mjs)$/.test(file))
  : [];

/** Whether this source can hold JSX at all — see `repFacing`. */
const JSX_FILE = /\.(?:tsx|jsx)$/;

const offenders = [];
for (const file of sources) {
  const name = path.relative(app, file).split(path.sep).join("/");
  for (const literal of repFacing(
    readFileSync(file, "utf8"),
    JSX_FILE.test(file),
  )) {
    if (allowed.has(`${name}${AT}${literal}`)) continue;
    offenders.push({ file: name, literal });
  }
}

// A DEAD ENTRY IS A STANDING EXEMPTION FOR A SENTENCE THAT LEFT, which is
// how a record stops being one. Checked per FILE, not per tree: an entry
// says where the sentence lives, and one that moved is a change the record
// has to see.
const dead = [];
for (const entry of ALLOWLIST) {
  const file = path.join(app, entry.file);
  const held = existsSync(file)
    ? repFacing(readFileSync(file, "utf8"), JSX_FILE.test(file)).includes(
        entry.literal,
      )
    : false;
  if (!held) dead.push(`${entry.file}: ${JSON.stringify(entry.literal)}`);
}

console.log(
  `Copy check over ${where}: ${sources.length} file(s), ` +
    `allowlist: ${ALLOWLIST.length} entry(ies), ${offenders.length} offender(s)`,
);
for (const offender of offenders) {
  console.error(
    `  OFFENDER ${offender.file}: ${JSON.stringify(offender.literal)}`,
  );
}
for (const entry of dead) console.error(`  DEAD ENTRY ${entry}`);

if (offenders.length > 0) {
  console.error(
    "COPY CHECK RED: every rep-facing string of the dashboard is a key into @dito/copy (spec #214 decision 13; ADR-0037 as amended). Move the words into the package and render them by key, or — if code really owns this one — name it in this script's ALLOWLIST with a reason and an expiry.",
  );
  process.exit(1);
}
if (dead.length > 0) {
  console.error(
    "COPY CHECK RED: these allowlist entries exempt a literal their file no longer holds — remove them, or the record is about code that is gone.",
  );
  process.exit(1);
}
if (sources.length === 0) {
  if (requireApp) {
    console.error(
      `COPY CHECK INCONCLUSIVE: nothing to sweep under ${where} — refusing to pass on a rule nobody was standing behind (--require-app).`,
    );
    process.exit(1);
  }
  console.log(
    `Copy check scanned 0 file(s) under ${where}: rep-web is Dito-Core/dito#221's, so this run proves nothing yet. Pass --require-app once the app exists.`,
  );
  process.exit(0);
}
console.log(
  "Copy check green: rep-web holds no rep-facing literal — every string of the dashboard is a key into @dito/copy.",
);

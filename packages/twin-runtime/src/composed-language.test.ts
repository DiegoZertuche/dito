/**
 * NO REP-FACING STRING IS A CONSTANT, EXCEPT WHAT ONE FILE SAYS IS (ticket
 * #176 AC 3; spec #171 decision 27 and user story 43; ADR-0037 as amended
 * 2026-09-04).
 *
 * The owner twin has had this sweep since #130 and makes the strongest form
 * of the claim: no allowlist at all. The rep side cannot, and ADR-0037's
 * 2026-09-04 amendment is where that was decided rather than discovered —
 * "the rep side has chrome too, and naming it is what lets *no rep-facing
 * string is a constant* be a CI test rather than a memory". So this sweep is
 * the owner's two rules over five more packages, with ONE pinned allowlist
 * file (`composed-language-allowlist.ts`) that *is* the record of what is
 * chrome.
 *
 * TWO RULES, COPIED EXACTLY, because they are the part that has been argued
 * twice already: the ES-MX orthography character class, and the function-word
 * DENSITY rule that catches a sentence written without its accents. Both are
 * reproduced here rather than imported — a list of Spanish words in `src`
 * would be the first offender this sweep found, so the rule and the thing it
 * forbids stay on opposite sides of the fence, which is what the drafting and
 * thread definition suites already do one file down.
 *
 * THE SCANNER NEEDED THREE FIXES THE OWNER'S DID NOT, and they are not
 * cosmetic — the first is a real blind spot, found by running the owner's
 * scanner over this package:
 *
 *  1. **Regular expressions.** `thread/guard.ts` holds `.replace(/[*_~`]/gu,
 *     "")`. The owner's scanner reads that backtick as opening a template
 *     literal and runs to the NEXT backtick — nineteen lines later, inside a
 *     comment — so from there it was reading comments as constants and
 *     constants as code. It reported five offenders that were comment text
 *     and would have missed a real one in the same file. A `/` that opens a
 *     regex is now skipped, decided by the previous significant token, which
 *     is how every hand-written JS scanner tells a regex from a division.
 *  2. **Nested templates and `${…}`.** An interpolation is CODE, not text:
 *     including it made every rendered sentence unreadable in the record and
 *     made an entry go stale on a rename that changed no rep-facing byte. It
 *     is rendered as `{}` — the sentence with its holes — and a template
 *     inside the expression is scanned as its own literal.
 *  3. **Escapes are decoded**, so `\n` is a newline rather than the letter
 *     `n`. Without it a two-line frame reads as `…?nn` in the record, and the
 *     record is the point.
 *
 * TWO MORE CAME BACK FROM CODEX ROUND 2, and both are closed: a string
 * inside a `${…}` interpolation is COLLECTED rather than skipped — an
 * interpolation is code, but a literal inside it is still a literal — and
 * `\uXXXX`, `\u{…}` and `\xXX` are decoded, because the orthography rule IS
 * a character class and «sí» spelled as a code point would otherwise read as
 * `su00ed`. The walk takes `.tsx` too, though no swept package has one.
 *
 * WHAT THE SWEEP CANNOT SEE is recorded as a test of its own below rather
 * than left to be found: a one-word fragment, and a sentence concatenated out
 * of constants. Closing those means constant-folding a TypeScript program
 * rather than scanning it — a different kind of test, recorded on #176 as
 * remainder — and what holds them meanwhile is the shape of these packages:
 * the twin's words are rendered in ONE module, whose every literal is either
 * on the list or a new line in a diff. The owner's suite records the same
 * limit.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AFFIRMATIONS } from "./affirmation.js";
import {
  ALLOWLIST_CATEGORIES,
  COMPOSED_LANGUAGE_ALLOWLIST,
  SWEPT_PACKAGES,
  type AllowlistEntry,
} from "./composed-language-allowlist.js";

/** `packages/` — this file is `packages/twin-runtime/src/`. */
const PACKAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
/** The repository root, which every allowlist path is relative to. */
const REPO = path.resolve(PACKAGES, "..");

/**
 * Spanish orthography: the two inverted marks, the angle quotes the product
 * writes speech in, the five accented vowels and the eñe. The owner twin's,
 * character for character.
 */
const ES_MX = /[¿¡«»áéíóúüñÁÉÍÓÚÜÑ]/u;

/**
 * ...AND SPANISH WITHOUT ITS ORTHOGRAPHY. Two or more DISTINCT function
 * words, and at least a third of the literal's words: function words are what
 * a SENTENCE is made of and what an identifier, a SQL fragment and an English
 * string are not, and the PROPORTION is what stops a long English sentence
 * that happens to contain `a` and `no` reading as Spanish. The owner twin's
 * list, word for word.
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
function readsAsSpanish(literal: string): boolean {
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
function isTwinSpoken(literal: string): boolean {
  return ES_MX.test(literal) || readsAsSpanish(literal);
}

/**
 * The separator that joins a file to a literal in a lookup key.
 *
 * WRITTEN AS AN ESCAPE, NEVER AS THE BYTE. A raw NUL in a `.ts` source makes
 * git treat the whole file as binary — no diff, no blame, no grep — which
 * is exactly the "a diff nobody reviews" failure this repo's conventions
 * exist to prevent, and it is how the first cut of this file shipped (the
 * two-axis review's Standards axis). It is a NUL rather than a punctuation
 * mark because a literal may legitimately contain any of those.
 */
const AT = "\u0000";

/** One literal, and the file it was found in. */
interface Found {
  readonly file: string;
  readonly literal: string;
}

const EXCLUDED_FILES = new Set(
  COMPOSED_LANGUAGE_ALLOWLIST.filter(
    (entry) => entry.literal === undefined,
  ).map((entry) => entry.file),
);

/**
 * Every non-test source the sweep walks, repo-relative.
 *
 * TEST FILES AND `src/testing/` ARE OUT. A test file is where the rule lives,
 * so sweeping it would refuse this file's own word list; `src/testing/` is
 * fixture helpers, and #174's `testing/thread-deps.ts` holds Spanish MESSAGES
 * a fixture puts in a rep's mouth — test data, not a twin-spoken constant.
 * Neither is shipped: every package's `src/testing` is excluded from its
 * build.
 *
 * THE ALLOWLIST ITSELF IS OUT, and it has to be: it is the record, so it
 * holds every literal it exempts. Excluding it is what stops the record being
 * its own violation — and the reverse check below is what stops the exclusion
 * hiding a stale entry.
 */
function sweptSources(): string[] {
  const found: string[] = [];
  for (const pkg of SWEPT_PACKAGES) {
    for (const file of walk(path.join(PACKAGES, pkg, "src"))) {
      if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
      if (file.split(path.sep).includes("testing")) continue;
      const relative = path.relative(REPO, file).split(path.sep).join("/");
      if (relative === ALLOWLIST_FILE) continue;
      if (EXCLUDED_FILES.has(relative)) continue;
      found.push(relative);
    }
  }
  return found;
}

const ALLOWLIST_FILE =
  "packages/twin-runtime/src/composed-language-allowlist.ts";
const GRAMMAR = "packages/twin-runtime/src/grammar.ts";
const MICROCOPY = "packages/twin-runtime/src/microcopy.ts";

/**
 * The whole rule, over sources handed in rather than read.
 *
 * A PARAMETER SO THE PROOF CAN DRIVE IT (the two-axis review's Spec axis).
 * The planted-literal tests used to exercise the DETECTOR alone —
 * `stringLiterals(planted).filter(isTwinSpoken)` — which proves the two
 * rules bite and proves nothing about the allowed-set lookup, the key it is
 * built from, or the file scoping. A near-miss in any of those would have
 * passed silently, which is the run-versus-cover defect one level up from
 * the one #84 named. So the rule takes its inputs, and the proof plants one.
 */
function offendersIn(sources: readonly Found[]): Found[] {
  const allowed = new Set(
    COMPOSED_LANGUAGE_ALLOWLIST.filter(
      (entry): entry is AllowlistEntry & { literal: string } =>
        entry.literal !== undefined,
    ).map((entry) => `${entry.file}${AT}${entry.literal}`),
  );
  const found: Found[] = [];
  for (const { file, literal: source } of sources) {
    for (const literal of stringLiterals(source)) {
      if (!isTwinSpoken(literal)) continue;
      if (allowed.has(`${file}${AT}${literal}`)) continue;
      found.push({ file, literal });
    }
  }
  return found;
}

/** Every twin-spoken literal in the swept sources, with where it was found. */
function offenders(): Found[] {
  return offendersIn(
    sweptSources().map((file) => ({
      file,
      literal: readFileSync(path.join(REPO, file), "utf8"),
    })),
  );
}

describe("no es-MX string outside the pinned allowlist (ticket #176 AC 3)", () => {
  it("finds none across the rep-side packages", () => {
    expect(
      offenders().map(
        (found) => `${found.file}: ${JSON.stringify(found.literal)}`,
      ),
      "these literals hold Spanish nothing exempted — the twin composes what it says (ADR-0037 as amended). If one is chrome, a receipt, or a disclosure line code renders at filing, name it in `composed-language-allowlist.ts` with its reason; otherwise it leaves the code",
    ).toEqual([]);
  });

  it("reads whole packages rather than a hand-listed set of files", () => {
    // The sweep's own coverage, asserted: a rule over "the rep-side
    // packages" that silently walked one directory would be the
    // run-versus-cover defect #84 named.
    const swept = sweptSources();
    expect(swept.length).toBeGreaterThan(100);
    // ...and it really reached each package, named rather than counted.
    for (const named of [
      "packages/twin-runtime/src/grammar.ts",
      "packages/twin-runtime/src/microcopy.ts",
      "packages/twin-runtime/src/thread/recipes.ts",
      "packages/twin-runtime/src/entity-kind/instructions.ts",
      "packages/execution/src/runner.ts",
      "packages/aperture/src/owner-render.ts",
      "packages/bundle/src/migrations.ts",
      "packages/seam/src/wa-payload.ts",
      "packages/scripted-model/src/index.ts",
      // #219's email rail, whose every word is a template in `@dito/copy`.
      "packages/notify/src/catalog.ts",
    ]) {
      expect(swept, `the sweep never reached ${named}`).toContain(named);
    }
  });

  it("catches a planted literal that no entry names — through the whole rule", () => {
    // THE PROOF THE GREEN ABOVE MEANS SOMETHING, and it goes through
    // `offendersIn` rather than the detector, so the allowed-set lookup and
    // its key are exercised too. Three shapes: a refusal sentence, a label,
    // a question the twin would ask — planted in the ONE file whose every
    // Spanish literal is already exempted, so a lookup that matched loosely
    // would swallow them.
    const planted = [
      'const REFUSAL = "De eso no te puedo decir nada.";',
      "const LABEL = 'sucedió';",
      "const ASK = `¿cuál de los dos?`;",
    ].join("\n");
    expect(
      offendersIn([{ file: GRAMMAR, literal: planted }]).map(
        (found) => found.literal,
      ),
    ).toEqual([
      "De eso no te puedo decir nada.",
      "sucedió",
      "¿cuál de los dos?",
    ]);
  });

  it("scopes an entry to the file it names, so a moved sentence is a new offender", () => {
    // The key is `file + literal`, and this is why: an exemption is granted
    // to a sentence IN A PLACE. The same receipt appearing in a second
    // module would be a second renderer of a line code owns, which is
    // exactly what `grammar.ts` being "the ONE rendering point for every
    // twin-authored post" forbids.
    // The binding decline's receipt, which `grammar.ts` owns. The aperture
    // question's «Listo, no lo agrego.» is off the allowlist with its route
    // (ticket #218), so that literal is an offender in EVERY file and cannot
    // carry this claim.
    const receipt = 'const R = "Entendido, este chat sigue sin confirmar.";';
    expect(offendersIn([{ file: GRAMMAR, literal: receipt }])).toEqual([]);
    expect(
      offendersIn([{ file: MICROCOPY, literal: receipt }]).map(
        (found) => found.file,
      ),
    ).toEqual([MICROCOPY]);
  });

  it("passes an exempted literal through unchanged, so the list is really consulted", () => {
    // The other direction of the same claim: the sweep is green because the
    // entries match, not because nothing was scanned.
    expect(
      offendersIn([
        { file: MICROCOPY, literal: 'const M = "ya se envió";' },
      ]),
    ).toEqual([]);
  });

  it("catches Spanish written without its orthography", () => {
    const planted = 'const REFUSAL = "No puedo decirte eso, no lo tengo yo.";';
    expect(stringLiterals(planted).filter(isTwinSpoken)).toHaveLength(1);
  });

  it("does not read an identifier, a column list or English as a sentence", () => {
    const safe = [
      '"resolve_entity"',
      '"ledger.finalized_facts.filed_by_seat_id"',
      '"SELECT seat_id, display_name, state FROM public.seats_status"',
      '"an answer cites the rows it rests on, and this one cites none"',
      '"claude-sonnet-5"',
      '"America/Monterrey"',
    ].join("\n");
    expect(stringLiterals(safe).filter(isTwinSpoken)).toEqual([]);
  });

  it("never mistakes a comment quoting Spanish for a constant", () => {
    // These packages' comments quote «Descartado», «no va» and «N no» to
    // explain what is rendered and what is refused, and a sweep that could
    // not tell a comment from a constant would push that reasoning out of
    // the code.
    const source = [
      "// «Descartado» is the receipt code renders after a dismissal.",
      "/* The rep's «no va» reaches the execution as ordinary prose. */",
      'const NAME = "resolve_entity";',
    ].join("\n");
    expect(stringLiterals(source).filter(isTwinSpoken)).toEqual([]);
  });

  it("never mistakes a regular expression for a literal (the owner scanner's blind spot)", () => {
    // `thread/guard.ts`'s own line. With the owner's scanner the backtick
    // inside the character class opened a template literal and the scan
    // desynced for the rest of the file — reading comments as constants and
    // missing anything real after it.
    const source = [
      'const folded = text.replace(/[*_~`]/gu, "");',
      "// A comment holding «Fuentes:» and an apostrophe: the rep's own.",
      'const LABEL = "Fuentes:";',
    ].join("\n");
    expect(stringLiterals(source)).toEqual(["", "Fuentes:"]);
  });

  it("renders an interpolation as a hole rather than as code", () => {
    // What makes the record readable — and what keeps an entry from going
    // stale on a rename that changed no rep-facing byte.
    expect(
      stringLiterals("const X = `Listo, guardé este chat como *${name}*.`;"),
    ).toEqual(["Listo, guardé este chat como *{}*."]);
  });

  it("collects a string inside an interpolation, where a sentence would hide (Codex r2)", () => {
    // `${count === 1 ? "dato" : "datos"}` is real code in `grammar.ts`, and
    // the first cut of this scanner walked past both words. An interpolation
    // is CODE; a string inside it is still a literal the twin could speak.
    expect(
      stringLiterals('const X = `agregué ${n === 1 ? "dato" : "datos"} hoy`;'),
    ).toEqual(["dato", "datos", "agregué {} hoy"]);
    // ...and one that reads as Spanish is an offender like any other.
    expect(
      offendersIn([
        {
          file: GRAMMAR,
          literal: 'const X = `${ok ? "no se pudo enviar" : ""}`;',
        },
      ]).map((found) => found.literal),
    ).toEqual(["no se pudo enviar"]);
  });

  it("decodes a unicode escape, so «sí» spelled as a code point is still «sí» (Codex r2)", () => {
    // The character class is the whole of the orthography rule, and a
    // scanner that only knew `\n` would read `s\u00ed` as `su00ed`.
    for (const spelling of ['"s\\u00ed"', '"s\\u{ed}"', '"s\\xed"']) {
      expect(
        stringLiterals(`const X = ${spelling};`).filter(isTwinSpoken),
        spelling,
      ).toEqual(["sí"]);
    }
  });

  it("decodes escapes, so a two-line frame reads as two lines", () => {
    expect(stringLiterals('const X = "uno\\ndos";')).toEqual(["uno\ndos"]);
  });

  it("reads an SQL comment inside a template literal as text, and that is a false POSITIVE", () => {
    // RECORDED RATHER THAN CLOSED (the two-axis review's Spec axis). The
    // scanner excludes `//` and `/* */` — JavaScript's comments — and a
    // template literal holding SQL carries `--` commentary that is TEXT as
    // far as any JavaScript scanner is concerned. So Spanish inside an
    // embedded SQL comment is flagged.
    //
    // IT IS LEFT THAT WAY ON PURPOSE, because the error is in the safe
    // direction: the sweep over-reports, and the answer is to write the SQL
    // commentary in English (which `wall.ts` and `self-chat-exclusion.ts`
    // now do) rather than to teach the scanner a second comment syntax it
    // would then have to be right about.
    const sql = [
      "const Q = `SELECT 1",
      "  -- una nota sobre lo que hace la consulta",
      "`;",
    ].join("\n");
    expect(stringLiterals(sql).filter(isTwinSpoken)).toHaveLength(1);
  });

  it("still names what neither rule can reach", () => {
    // A one-word fragment is under any threshold that does not also read
    // English, and a sentence split across concatenated constants is
    // invisible to a per-literal rule. What holds those is the shape of
    // these packages — the twin's words are rendered in ONE module
    // (`grammar.ts`), whose every literal is either on the list or a new
    // line in a diff. Recorded rather than left to be discovered.
    expect(stringLiterals('const X = "pendiente";').filter(isTwinSpoken)).toEqual(
      [],
    );
    // ...and the concatenation, demonstrated rather than asserted about: two
    // halves neither rule can see, and the sentence they make.
    const halves = ["no ", "lo registro"];
    expect(halves.filter(isTwinSpoken)).toEqual([]);
    expect(isTwinSpoken(halves.join(""))).toBe(true);
  });
});

describe("the allowlist is a registry, checked in both directions", () => {
  it("holds no entry whose literal is no longer in the file it names", () => {
    // A DEAD ENTRY IS A STANDING EXEMPTION FOR A SENTENCE THAT LEFT, which
    // is how a record stops being one (`fr73-shared-stores.ts`'s
    // convention). The check is per FILE, not per tree: an entry says where
    // the sentence lives, and a sentence that moved is a change the record
    // has to see.
    const dead: string[] = [];
    for (const entry of COMPOSED_LANGUAGE_ALLOWLIST) {
      if (entry.literal === undefined) continue;
      const source = readFileSync(path.join(REPO, entry.file), "utf8");
      if (!stringLiterals(source).includes(entry.literal)) {
        dead.push(`${entry.file}: ${JSON.stringify(entry.literal)}`);
      }
    }
    expect(
      dead,
      "these entries exempt a literal their file no longer holds — remove them, or the record is about code that is gone",
    ).toEqual([]);
  });

  it("names a file that exists for every whole-source exclusion", () => {
    for (const entry of COMPOSED_LANGUAGE_ALLOWLIST) {
      if (entry.literal !== undefined) continue;
      expect(
        statSync(path.join(REPO, entry.file)).isFile(),
        `${entry.file} is excluded and does not exist`,
      ).toBe(true);
    }
  });

  it("gives every whole-source exclusion an expiry, so none is permanent", () => {
    // A WHOLE-FILE EXEMPTION IS THE ONE ENTRY THE REVERSE CHECK CANNOT KEEP
    // HONEST (Codex round 1): it grants cover to every string added to that
    // file afterwards, and "the file still exists" is all a dead-entry check
    // can ask of it. So it must expire. The two sources that were one are
    // literal entries now for exactly this reason: `reactions.ts`'s three
    // gesture beats (#176) and the extraction contract's thirty-three
    // `model-example` phrases (#194), with the rest of both files swept.
    for (const entry of COMPOSED_LANGUAGE_ALLOWLIST) {
      if (entry.literal !== undefined) continue;
      expect(entry.expiry?.trim() ?? "", entry.file).not.toBe("");
    }
  });

  it("excludes a whole source only under `excluded-file`", () => {
    // The one category allowed to name a source rather than a sentence. A
    // whole-file exemption under any other word would be a file's worth of
    // twin-spoken sentences called chrome.
    for (const entry of COMPOSED_LANGUAGE_ALLOWLIST) {
      if (entry.literal === undefined) {
        expect(entry.category, entry.file).toBe("excluded-file");
      }
    }
  });

  it("gives every interim entry an expiry, and every entry a reason", () => {
    // NEVER A SILENT EXEMPTION. An `interim:` entry is a sentence nobody
    // calls chrome, so it owes the reader what retires it.
    for (const entry of COMPOSED_LANGUAGE_ALLOWLIST) {
      const what = `${entry.file}: ${JSON.stringify(entry.literal ?? "(whole file)")}`;
      expect(ALLOWLIST_CATEGORIES, what).toContain(entry.category);
      expect(entry.reason.trim(), what).not.toBe("");
      if (entry.category.startsWith("interim:")) {
        expect(entry.expiry?.trim() ?? "", what).not.toBe("");
      }
    }
  });

  it("names every accepted keyword, not only the one the rules flag", () => {
    // THE SIBLING RULE, MACHINE-CHECKED WHERE IT CAN BE (Codex round 3). The
    // orthography rule sees «sí» and neither rule sees «si» or «va», so the
    // record named one of three and read as a decision about the other two.
    // This is the one family whose members are a shipped CONSTANT rather than
    // a scatter of literals, so it is the one the record can be held to: a
    // word added to the accepted set is a product change, and it now has to
    // be a line in this file too.
    const listed = new Set(
      COMPOSED_LANGUAGE_ALLOWLIST.filter(
        (entry) => entry.file === "packages/twin-runtime/src/affirmation.ts",
      ).map((entry) => entry.literal),
    );
    // Over the WHOLE record rather than the two grammars named by hand: a
    // third grammar class gaining a word must join this file too.
    for (const word of Object.values(AFFIRMATIONS).flat()) {
      expect(listed, `the accepted keyword "${word}" is on no entry`).toContain(
        word,
      );
    }
  });

  it("holds no duplicate entry", () => {
    const keys = COMPOSED_LANGUAGE_ALLOWLIST.map(
      (entry) => `${entry.file}${AT}${entry.literal ?? ""}`,
    );
    expect(keys).toEqual([...new Set(keys)]);
  });

  it("writes its own reasons in English", () => {
    // The record about Spanish constants is not itself one. The rule that
    // sweeps `src` cannot see this file — it is excluded, because it holds
    // every literal it exempts — so the reasons are checked here instead.
    for (const entry of COMPOSED_LANGUAGE_ALLOWLIST) {
      expect(readsAsSpanish(entry.reason), entry.reason).toBe(false);
    }
  });
});

/** Every file under a directory, depth first. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Every string and template literal in one TypeScript source — comments,
 * regular expressions and interpolated expressions excluded, escapes
 * decoded, and each `${…}` rendered as `{}`.
 *
 * A HAND-WRITTEN SCANNER RATHER THAN A REGEX, because the two things this
 * has to tell apart — a comment that quotes a Spanish phrase and a constant
 * that IS one — differ only in their surrounding syntax. It is a scanner and
 * not a parser: it tracks which state each character is in and nothing else,
 * which is all the rule needs.
 */
export function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let at = 0;
  /** The last significant character, which is how a regex is told from a division. */
  let previous = "";

  while (at < source.length) {
    const here = source[at]!;
    const next = source[at + 1];
    if (here === "/" && next === "/") {
      while (at < source.length && source[at] !== "\n") at += 1;
      continue;
    }
    if (here === "/" && next === "*") {
      at += 2;
      while (at < source.length && !(source[at] === "*" && source[at + 1] === "/")) {
        at += 1;
      }
      at += 2;
      continue;
    }
    if (here === "/" && opensARegex(previous, at)) {
      at = pastRegex(at);
      previous = "/";
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
      previous = quote;
      continue;
    }
    if (here === "`") {
      const read = template(at);
      found.push(read.literal);
      at = read.at;
      previous = "`";
      continue;
    }
    if (!/\s/u.test(here)) previous = here;
    at += 1;
  }

  /** One template literal, with every `${…}` rendered as a hole. */
  function template(start: number): { literal: string; at: number } {
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
   * Past one `${…}`, balanced. A string inside it is code and not text, so
   * it is skipped — but a TEMPLATE inside it is a literal in its own right
   * and is collected, which is how `«${words.map((w) => `«${w}»`)}»` is not
   * quietly lost.
   */
  function pastExpression(from: number): number {
    let at = from;
    let depth = 1;
    while (at < source.length && depth > 0) {
      const here = source[at]!;
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
        // COLLECTED, NOT SKIPPED (Codex round 2). An interpolation is code,
        // and a STRING inside it is still a literal the twin could speak:
        // `${count === 1 ? "dato" : "datos"}` is exactly the shape a Spanish
        // sentence would hide in, and the first cut of this scanner walked
        // past it.
        const quote = here;
        at += 1;
        let literal = "";
        while (at < source.length && source[at] !== quote) {
          if (source[at] === "\\") {
            literal += unescape(source, at + 1).text;
            at += 1 + unescape(source, at + 1).length;
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
   * Whether a `/` here starts a regular expression rather than a division.
   *
   * DECIDED BY THE PREVIOUS SIGNIFICANT TOKEN, which is how every
   * hand-written JavaScript scanner draws this line: a regex may only appear
   * where a VALUE may, so an opening bracket, an operator, a comma or a
   * keyword before it means a regex, and an identifier, a literal or a
   * closing bracket means a division.
   */
  function opensARegex(previous: string, at: number): boolean {
    if (previous === "" || /[({[,;:=!&|?+\-*%~^<>]/u.test(previous)) return true;
    const before = source.slice(Math.max(0, at - 12), at).trimEnd();
    return [
      "return", "typeof", "instanceof", "case", "in", "of", "new", "delete",
      "void", "do", "else", "yield", "await",
    ].some((word) => before.endsWith(word));
  }

  /** Past one regular expression, character class and flags included. */
  function pastRegex(from: number): number {
    let at = from + 1;
    let inClass = false;
    while (at < source.length) {
      const here = source[at]!;
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
        while (at < source.length && /[a-z]/u.test(source[at]!)) at += 1;
        return at;
      }
      at += 1;
    }
    return from + 1;
  }

  return found;
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

/**
 * One escape sequence, decoded, with how many characters it took.
 *
 * `\uXXXX`, `\u{…}` AND `\xXX` ARE DECODED (Codex round 2), because the
 * character class is the whole of the orthography rule: `"s\u00ed"` is «sí»
 * to every reader but a scanner that only knew `\n`. Nothing else needs a
 * case — an unknown escape is its own character, which is what JavaScript
 * does with it too.
 */
function unescape(
  source: string,
  at: number,
): { text: string; length: number } {
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

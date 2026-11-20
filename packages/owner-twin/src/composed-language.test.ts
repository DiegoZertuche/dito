/**
 * NO TWIN-SPOKEN STRING IS A CONSTANT (ticket #130 AC 9; ADR-0037 as
 * amended; spec #126 decision 7 and 18).
 *
 * The ADR's rule: "Fixed structure is permitted and expected — what a post
 * must contain, and in what order. Fixed sentences are not: no rep-facing
 * string is a constant in the code", widened by the 2026-09-02 amendment to
 * "every surface where a twin speaks", which is what the owner twin is.
 *
 * THE CHECK IS A LANGUAGE SWEEP, and that is the honest mechanization of a
 * rule about sentences. The owner twin answers in the owner's language, and
 * this rig's owner reads Mexican Spanish — so a string literal in this
 * package carrying Spanish orthography is either a sentence the twin would
 * say or a label somebody meant a page to render, and the second belongs to
 * the owner web's chrome (which ADR-0037 exempts by name) rather than here.
 * The shape is `twin-posts.test.ts`'s AST-style sweep and
 * `binding-wall.test.ts`'s forbidden-token regex: walk, list the offenders,
 * and prove the sweep can catch its own violation.
 *
 * THERE IS NO ALLOWLIST, and that is the strongest form of this claim
 * available. The instructions module — the one place a prompt could
 * plausibly hold a phrase — is written in English about a twin that answers
 * in the owner's language, so it needs no exemption; the guard derives every
 * Spanish token it refuses from `@dito/aperture`'s renderers and from
 * `Intl` rather than writing any down; and the renderer returns structure
 * for the room to label. A file that needed an exemption would be a file
 * putting words in the twin's mouth, and adding one here is the review
 * decision that says so.
 *
 * COMMENTS ARE NOT SWEPT, and they must not be: this package's comments
 * quote «Cotización dada» and «Recibo al pie» to explain what is refused
 * and what is rendered, and a sweep that could not tell a comment from a
 * constant would push that reasoning out of the code.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spanish orthography: the two inverted marks, the angle quotes the product
 * writes speech in, the five accented vowels and the eñe. A sentence the
 * twin would say to this rig's owner has one of these far more often than
 * not, and the ones that do not are caught by the reviewer this test exists
 * to put in front of the diff rather than by the regex.
 */
const ES_MX = /[¿¡«»áéíóúüñÁÉÍÓÚÜÑ]/u;

/**
 * ...AND SPANISH WITHOUT ITS ORTHOGRAPHY (Codex r1). «No puedo decirte
 * eso.» is a sentence the twin would say and carries no accent, no eñe and
 * no inverted mark — the character class above cannot see it, and this test
 * used to say so and stop there. Naming a limit is not the same as living
 * with it when closing it is cheap.
 *
 * SO THE SECOND RULE IS SPANISH FUNCTION WORDS, two or more DISTINCT ones
 * in a single literal. Function words are what a SENTENCE is made of and
 * what an identifier, a SQL fragment and an English string are not: `de`,
 * `que`, `no`, `te`, `lo` do not turn up in pairs in `resolve_entity` or in
 * `ledger.finalized_facts`.
 *
 * ...AND DENSITY, WHICH IS WHAT MAKES A LOW COUNT USABLE (Codex r2). A
 * bare count of three left «no lo registro» — the unrecorded phrase the
 * spec names by hand — under the threshold; a bare count of two started
 * reading ENGLISH as Spanish, because `a` and `no` are both languages'
 * words and a long English sentence eventually contains both. What tells
 * them apart is the PROPORTION: a Spanish sentence is mostly function
 * words, and an English sentence that happens to contain two is not. Two
 * distinct hits and at least a third of the words is measured rather than
 * guessed — it clears this package's whole shipped source, including the
 * English instruction parts, and catches a three-word Spanish phrase.
 *
 * THE LIST LIVES IN THIS FILE, which is the only place it can: it is a list
 * of Spanish words, and a list of Spanish words in `src` would be the first
 * offender the sweep found. Test files are excluded from the sweep, so the
 * rule and the thing it forbids stay on opposite sides of the fence.
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

describe("no es-MX string the twin could say is a constant (ticket #130 AC 9)", () => {
  it("finds none in this package's shipped source", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
        if (isTwinSpoken(literal)) {
          offenders.push(`${path.relative(SRC, file)}: ${literal}`);
        }
      }
    }
    expect(
      offenders,
      "these string literals hold Spanish the twin would say — the execution is told a structure and never handed a sentence (ADR-0037 as amended); a label a page renders belongs to the owner web's chrome",
    ).toEqual([]);
  });

  it("catches its own violation, so the green above means something", () => {
    // Every shape the rule is about: a refusal sentence, a receipt label, a
    // question the twin would ask.
    const planted = [
      'const REFUSAL = "De eso no te puedo decir nada: no cruzó el muro.";',
      "const LABEL = 'sucedió';",
      "const ASK = `¿cuál de los dos?`;",
    ].join("\n");
    const found = stringLiterals(planted).filter(isTwinSpoken);
    expect(found).toHaveLength(3);
  });

  it("catches Spanish written without its orthography too (Codex r1)", () => {
    // The case this test used to RECORD as uncatchable. No accent, no eñe,
    // no inverted mark — and five function words, which is what a sentence
    // is made of and an identifier is not.
    const planted = 'const REFUSAL = "No puedo decirte eso, no lo tengo yo.";';
    expect(stringLiterals(planted).filter(isTwinSpoken)).toHaveLength(1);
  });

  it("does not read an identifier, a column list or English as a sentence", () => {
    // The other direction, which is what makes the rule usable: three
    // function words is a threshold two coincidences cannot reach.
    const safe = [
      '"resolve_entity"',
      '"no rep of this company has a seat under that name"',
      '"a name matched more than one record. unrecorded: the Ledger records no fact of that kind."',
      '"ledger.finalized_facts.filed_by_seat_id"',
      '"an answer cites the rows it rests on, and this one cites none"',
      '"claude-sonnet-5"',
      '"SELECT seat_id, display_name, state FROM public.seats_status"',
      '"America/Monterrey"',
    ].join("\n");
    expect(stringLiterals(safe).filter(isTwinSpoken)).toEqual([]);
  });

  it("catches the unrecorded phrase the spec names by hand (Codex r2)", () => {
    // «no lo registro» is two function words and was under the old
    // threshold — a poor place for a rule about twin-spoken constants to
    // stop, since the spec names that phrase itself.
    expect(
      stringLiterals('const X = "no lo registro";').filter(isTwinSpoken),
    ).toHaveLength(1);
  });

  it("still names what neither rule can reach", () => {
    // A ONE-WORD fragment — «pendiente», «listo» — is under any threshold
    // that does not also read English, and a sentence split across
    // concatenated constants is invisible to a per-literal rule. What holds
    // those is the shape of this package rather than this sweep: the
    // instructions are English (`definition.test.ts` asserts that part by
    // part), the guard derives its Spanish from the aperture's renderers,
    // and the renderer returns structure for the room to label — so a
    // twin-spoken constant would be a NEW string in a package that has
    // none, visible in a diff. Recorded on the ticket rather than left to
    // be discovered.
    expect(stringLiterals('const X = "pendiente";').filter(isTwinSpoken)).toEqual([]);
  });

  it("does not mistake a comment quoting Spanish for a constant", () => {
    const source = [
      "// «Cotización dada» is the tag code renders at the head of a fact.",
      "/* The receipt strip reads sucedió · registrado · confianza. */",
      'const NAME = "resolve_entity";',
    ].join("\n");
    expect(stringLiterals(source).filter((l) => ES_MX.test(l))).toEqual([]);
  });

  it("reads a whole package rather than a hand-listed set of files", () => {
    // The sweep's own coverage, asserted: a rule over "this package" that
    // silently walked one directory would be the run-versus-cover defect
    // #84 named, one package over.
    const swept = [...walk(SRC)].filter(
      (file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file),
    );
    expect(swept.length).toBeGreaterThan(8);
    expect(swept.map((file) => path.basename(file))).toContain(
      "instructions.ts",
    );
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
 * Every string and template literal in one TypeScript source, comments and
 * regular expressions excluded.
 *
 * A HAND-WRITTEN SCANNER RATHER THAN A REGEX, because the two things this
 * has to tell apart — a comment that quotes a Spanish phrase and a constant
 * that IS one — differ only in their surrounding syntax, and a regex over
 * quotes finds the phrase inside the comment as readily as inside the
 * constant. It is a scanner and not a parser: it tracks which of five
 * states each character is in and nothing else, which is all the rule needs.
 */
export function stringLiterals(source: string): string[] {
  const found: string[] = [];
  let at = 0;
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
    if (here === '"' || here === "'" || here === "`") {
      const quote = here;
      at += 1;
      let literal = "";
      while (at < source.length && source[at] !== quote) {
        if (source[at] === "\\") {
          literal += source[at + 1] ?? "";
          at += 2;
          continue;
        }
        literal += source[at];
        at += 1;
      }
      at += 1;
      found.push(literal);
      continue;
    }
    at += 1;
  }
  return found;
}

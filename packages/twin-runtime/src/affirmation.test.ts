import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptsAffirmation, AFFIRMATIONS } from "./affirmation.js";
import { THREAD_MAX_ITERATIONS } from "./thread/automation.js";
import { threadInstructions } from "./thread/instructions.js";
import { THREAD_TOOL_DECLARATIONS } from "./thread/tools.js";

/**
 * THE TWO ACCEPTED SETS, and only the two (ticket #25 slice AC 6; ticket
 * #30; ticket #49; spec #48 grilling decision 3; CONTRACTED at #174).
 *
 * The set is a function of WHAT WAS QUOTED, and anything the rep might mean
 * differently — questions, other words of assent, replies with content —
 * matches nothing. What changed at #174 is what "matches nothing" now
 * MEANS: it used to end in silence on a draft, and every one of these
 * inputs now reaches the thread execution as prose (`matcher.int.test.ts`).
 * So these cases are still exactly the claim that the KEYWORD did not fire.
 */
describe("a proposal's YES — a draft takes «va» and nothing else", () => {
  it.each(["va", "VA", "Va", " va ", "va.", "va!", "va!!", "¡va!", "va…", "\tva\n"])(
    "accepts %j",
    (text) => {
      expect(acceptsAffirmation("proposal", text)).toBe(true);
    },
  );

  it.each([
    "¿va?", // a question is not an affirmation
    "va?",
    "vale", // a different word, even if it means yes
    "ok",
    "va va",
    "va mañana", // an affirmation with content is a revision, not a tap
    "no va",
    "avanza",
    "",
    "   ",
    "¡!",
  ])("rejects %j — mints nothing, the draft stays waiting", (text) => {
    expect(acceptsAffirmation("proposal", text)).toBe(false);
  });
});

/**
 * THE DISMISS VERB IS GONE (ticket #174; spec #171 decision 18).
 *
 * «no va» was a keyword, cloned from the affirmation's rules, and it was
 * the clearest case ADR-0037's ruling covers: dismissing a draft can be
 * taken back — by asking for another — so a rep should not have to learn a
 * phrase for it. What is asserted here is the DELETION, in the only form a
 * unit test can assert it: none of the words the dismissal ever accepted
 * affirms anything, so no path through this file can reach a keyword act
 * with them. That the same words now DISMISS through the tool is a claim
 * about the execution and is proven at the seam.
 */
describe("a proposal's NO is prose now, matched by nothing here", () => {
  it.each([
    "no va",
    "NO VA",
    "¡no va!",
    "no",
    "NO",
    "¡no!",
    "así no",
    "mejor no le contestes",
  ])("%j affirms nothing on either class", (text) => {
    expect(acceptsAffirmation("proposal", text)).toBe(false);
    expect(acceptsAffirmation("question", text)).toBe(false);
  });
});

/**
 * A question's verbs (ticket #49; spec #48 grilling decision 3). «va»
 * reads oddly as the answer to «¿Este chat es de X?» (#36 finding 1), so
 * the yes-words belong: «si» is the taught word, unaccented; «sí» is
 * accepted because the es-MX keyboard produces the accent unprompted and
 * refusing it would leave the rep typing the right word and seeing nothing
 * happen; «va» keeps working because it is the word two slices have taught
 * and "go ahead" is never WRONG on a proposal, only less natural.
 */
describe("a question's YES — «si», «sí» and «va»", () => {
  it.each([
    "si",
    "SI",
    "Si",
    " si ",
    "si.",
    "¡si!",
    "si…",
    "s\u00ed",
    "S\u00cd",
    "S\u00ed",
    " s\u00ed ",
    "s\u00ed.",
    "\u00a1s\u00ed!",
    "va",
    "VA",
    "¡va!",
  ])("accepts %j", (text) => {
    expect(acceptsAffirmation("question", text)).toBe(true);
  });

  it("accepts a DECOMPOSED «sí» — the keyboard's accent may arrive either way", () => {
    // NFD: "si" + COMBINING ACUTE ACCENT (U+0301) — byte-different from the
    // composed form the source literals carry, the same word to the rep.
    // Refusing it would leave the rep typing the right word and seeing
    // nothing happen.
    const decomposed = "si\u0301";
    expect(decomposed).not.toBe("s\u00ed");
    expect(acceptsAffirmation("question", decomposed)).toBe(true);
    expect(acceptsAffirmation("question", "SI\u0301")).toBe(true);
  });

  it.each([
    "¿si?", // a question is not an answer
    "si?",
    "¿sí?",
    "sí?",
    "sii",
    "si si",
    "si es ella", // an answer with content is a follow-up, not a verb
    "sí, es ella",
    "claro",
    "simon",
    "no",
    "no va",
    "",
    "   ",
  ])("rejects %j — mints nothing, the question keeps waiting", (text) => {
    expect(acceptsAffirmation("question", text)).toBe(false);
  });
});

describe("a question's NO is prose now (ticket #174)", () => {
  // It was a keyword on both kinds of question until #174. A declined
  // BINDING wrote nothing at all — "the chat staying provisional, which is
  // what an unanswered question already means" — and an aperture question's
  // no closed a question the correction window keeps open either way, so
  // neither is an act a wrong yes could ruin.
  it.each(["no", "NO", "¡no!", "no va", "ya no", "no, ese no es Torres"])(
    "%j affirms nothing",
    (text) => {
      expect(acceptsAffirmation("question", text)).toBe(false);
    },
  );
});

/**
 * THE FAIL-SAFE DIRECTION, at the verb table, adversarially and both ways
 * (ticket #49 AC 2). A tap releases a message to a customer, so a
 * question's yes-words must never reach a draft — a rep answering «si» to
 * something is not a rep releasing a message they have not re-read.
 */
describe("a word outside a class's set is inert there", () => {
  it.each(["si", "s\u00ed", "si\u0301", "S\u00cd", "\u00a1si!", "si."])(
    "%j never affirms a draft — «si» quoted on a draft mints nothing",
    (text) => {
      expect(acceptsAffirmation("proposal", text)).toBe(false);
    },
  );
});

/**
 * THE TABLE IS THE CONTRACT (ticket #174; spec #171 decision 18: "the
 * router shrinks to the two keywords").
 *
 * Asserted over the DATA rather than over the functions, because the table
 * is what three readers share — the matcher, the two rendered labels and
 * the `keyword_set` part — so a third class or a third set added here would
 * change all three at once, and this is the one place that would go red.
 */
describe("two classes, two sets, and nothing else", () => {
  it("holds exactly the proposal's and the question's accepted words", () => {
    expect(AFFIRMATIONS).toEqual({
      proposal: ["va"],
      question: ["si", "sí", "va"],
    });
  });

  it("is frozen, so no caller can retach the rep at run time", () => {
    expect(Object.isFrozen(AFFIRMATIONS)).toBe(true);
  });
});

/**
 * THE CORRECTION VERB IS GONE (ticket #174; spec #171 decision 18).
 *
 * «N no» on the daily disclosure was the registry's only INDEXED verb, and
 * it carried the highest stake of the three that left: it named ONE line of
 * the rep's own account of what crossed, and a reply mapped to the wrong
 * number retracted a fact they never meant. That risk did not go away — it
 * moved into `retract_disclosure_line`, which resolves the number the rep
 * NAMED against the numbering recorded when the post was rendered, exactly
 * as the verb did, and reads the number back in its receipt so the rep can
 * see which line the twin picked.
 *
 * What is asserted here is that the grammar has no numbered form left: «1
 * no» is prose to this file, on every class.
 */
describe("«N no» is prose now, matched by nothing here", () => {
  it.each(["1 no", "1 no va", "3 no", "el 3 está mal", "no fueron 50, fueron 15"])(
    "%j affirms nothing on either class",
    (text) => {
      expect(acceptsAffirmation("proposal", text)).toBe(false);
      expect(acceptsAffirmation("question", text)).toBe(false);
    },
  );
});

/**
 * THE WORD THAT WAS NAMED AND NEVER BUILT (ticket #260 AC 5; ADR-0033 as
 * amended; spec #258 — "the «recuerda:» placeholder retires unbuilt").
 *
 * THE PIN THIS REPLACES asserted that one particular word was no class's
 * verb, which was the right claim while the notepad was unbuilt and a
 * narrower one than the ticket now needs: the notepad is written from the
 * rep's PROSE, so the claim is that there is no keyword for it ANYWHERE —
 * not in the matcher's tables, and not in what the twin is told either,
 * where a phrase the model taught the rep would be a verb the matcher has
 * never heard of (`recipes.ts`'s own rule for `keyword_set`).
 *
 * THE CANDIDATES LIVE IN A TEST FILE, which is the same fence
 * `definition.test.ts` puts around its list of Spanish words: the rule and
 * the thing it forbids belong on opposite sides, so a sweep over `src` that
 * read itself would be green by construction.
 */
const NOTEPAD_VERB_CANDIDATES = ["recuerda", "recuérdame", "apunta", "anota:"];

/** Every shipped source of this package — its tests are the fence, not the field. */
function shippedSources(): { file: string; text: string }[] {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const found: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "testing") walk(at);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        found.push({ file: at.slice(root.length), text: readFileSync(at, "utf8") });
      }
    }
  };
  walk(root);
  return found;
}

describe("the notepad write has no keyword, anywhere (ticket #260)", () => {
  it("neither accepted class would take one", () => {
    for (const verb of NOTEPAD_VERB_CANDIDATES) {
      for (const grammar of ["proposal", "question"] as const) {
        expect(acceptsAffirmation(grammar, verb)).toBe(false);
        expect(
          acceptsAffirmation(grammar, `${verb} con Fuentes siempre de usted`),
        ).toBe(false);
      }
    }
  });

  it("no shipped source of this package holds one", () => {
    // The sweep the placeholder's own pin turned into: the word is not a
    // verb because no code anywhere knows it — not the matcher, not the
    // router, and not a prompt.
    const sources = shippedSources();
    expect(sources.length).toBeGreaterThan(50);
    for (const { file, text } of sources) {
      const read = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
      for (const verb of NOTEPAD_VERB_CANDIDATES) {
        const folded = verb.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
        expect(read, `${file} names "${verb}"`).not.toContain(folded);
      }
    }
  });

  it("what the twin is told about the notepad teaches no phrase to type", () => {
    // The tool is called from prose and the rep learns nothing: the two
    // words the instructions may teach are the matcher's own
    // (`recipes.ts`'s `keyword_set`), and the notepad is not one of them.
    const told = threadInstructions(THREAD_TOOL_DECLARATIONS, THREAD_MAX_ITERATIONS)
      .map((part) => `${part.name}\n${part.text}`)
      .join("\n");
    expect(told).toContain("write_notepad");
    for (const word of [...AFFIRMATIONS.proposal, ...AFFIRMATIONS.question]) {
      expect(told).not.toContain(`«${word}»`);
    }
    expect(told).not.toMatch(/«[^»]+»/u);
  });
});

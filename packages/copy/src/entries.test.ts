/**
 * THE TWO KEYED FAMILIES — chrome and notify's templates (ticket #219 AC 1;
 * spec #214 decisions 9 and 13; ADR-0037 as amended, ADR-0022).
 *
 * The renderer's own rules are `template.test.ts`'s, over a fixture. This
 * suite is about the SHIPPED entries: that every template is well formed at
 * import, that no key is a duplicate, that a rendered message carries the
 * occasion's values and no hole, and — over every string both families hold —
 * that each one says what IS the case (boundary #225's F16, ticket #244).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHROME,
  DOCUMENTS,
  DOCUMENT_KEYS,
  documentVersions,
  renderTemplate,
  SLOT_TYPES,
  TEMPLATES,
  checkTemplate,
} from "./index.js";

/**
 * The words a negation arrives as in es-MX, WITHOUT their accents, because
 * that is how they are compared (`negationsIn`).
 *
 * THE RULING'S OWN LIST, plus the two ways «not yet» is written. Boundary
 * #225's F16 names eleven words — no, nada, nunca, ni, sin, tampoco, jamás,
 * ningún, ninguna, ninguno, nadie — every form of them, since a word list
 * that held the singular and let «ningunos» through would be a list with a
 * hole in the middle of its own vocabulary. «todavía» and «aún» are here
 * because the state written as an absence is the shape the rule exists for
 * and those are the words it arrives in. Crude on purpose: the rule is about
 * the SHAPE of a sentence, and a checker that tried to parse Spanish would be
 * a mechanism justified by nothing — a report-only negation checker over the
 * whole app was declined at that boundary.
 */
const NEGATIONS = [
  "no",
  "nada",
  "nunca",
  "ni",
  "sin",
  "tampoco",
  "jamas",
  "ningun",
  "ninguna",
  "ninguno",
  "ningunas",
  "ningunos",
  "nadie",
  "todavia",
  "aun",
];

/**
 * A WHOLE WORD AND NEVER A SYLLABLE. Every word above is a syllable of some
 * ordinary one — «Inicio» carries `ni`, «número» carries `no`, «sincronizar»
 * carries `sin` — so a sweep on substrings would report a third of the
 * package and be turned off within the week.
 */
const NEGATION = new RegExp(
  String.raw`(?<!\p{L})(?:${NEGATIONS.join("|")})(?!\p{L})`,
  "giu",
);

/**
 * The negation words one string carries, compared without accents so that
 * «jamás» and «jamas» are one word to this check — `copy-check.mjs`'s own
 * normalisation, for the reason it gives: a sentence typed without its
 * orthography is the same sentence.
 */
function negationsIn(text: string): readonly string[] {
  const plain = text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return [...plain.matchAll(NEGATION)].map((match) => match[0].toLowerCase());
}

/**
 * THE EXCEPTIONS — a string where a listed word is not a negation, one
 * reviewable line each.
 *
 * IT IS EMPTY, which is the state the rule is worth having in: every string
 * of both families says what is the case, so nothing needs exempting. The
 * shape stays for `copy-check.mjs`'s ALLOWLIST reason — an exemption belongs
 * in a line with an argument rather than in a word quietly dropped from the
 * list above, which is the one way a rule like this dies. An entry is
 * `{ key, word, reason }` — a chrome key, or a template's `key.subject` or
 * `key.body` — and one whose word its string has stopped carrying fails the
 * sweep too, so an exemption cannot outlive its sentence.
 */
const EXCEPTIONS: readonly {
  readonly key: string;
  readonly word: string;
  readonly reason: string;
}[] = [];

describe("the chrome family (spec #214 decision 9)", () => {
  it("keys the labels the spec names by hand", () => {
    // The sentences the product definition writes down, which are the ones
    // a page may not paraphrase: the scoping promise (user story 17), the
    // two draft buttons (user story 28), «Cerrar sesiones» (user story 7) and
    // the canvas's expander (spec #258 decision 12).
    expect(CHROME["scoping.promise"]).toBe(
      "Dito lee los últimos 90 días de los chats que marques",
    );
    expect(CHROME["canvas.more"]).toBe("Todo lo que espera");
    expect(CHROME["draft.send"]).toBe("Enviar");
    expect(CHROME["draft.dismiss"]).toBe("Descartar");
    expect(CHROME["settings.closeSessions"]).toBe("Cerrar sesiones");
  });

  it("names the six surfaces that exist, Mi libreta, Rutinas and the bell among them (spec #258 decision 17)", () => {
    // "The nav shows only what exists": *Mi libreta* is a surface (#264), the
    // bell's page is one (#265), Rutinas is one (#267), and *Habla con Dito*
    // names none, because the dashboard's door is the bar. Trabajos en curso
    // is reached by the switch that heads Rutinas, never from the nav.
    expect(
      Object.keys(CHROME).filter((key) => key.startsWith("nav.")),
    ).toEqual([
      "nav.inicio",
      "nav.conexiones",
      "nav.libreta",
      "nav.rutinas",
      "nav.ajustes",
      "nav.avisos",
    ]);
    expect(CHROME["nav.libreta"]).toBe("Mi libreta");
    expect(Object.values(CHROME)).not.toContain("Habla con Dito");
  });

  it("holds no empty entry, and none with an untended hole", () => {
    for (const [key, value] of Object.entries(CHROME)) {
      expect(value.trim(), key).not.toBe("");
      // Chrome is a finished label. A `{…}` here would be a template that
      // lost its way into the wrong family, and no renderer would fill it.
      expect(value, key).not.toMatch(/[{}]/u);
    }
  });
});

describe("the template family (ticket #219 AC 1)", () => {
  it("holds every message Dito sends, keyed by its catalog name", () => {
    // THE TWO FAMILIES, IN ONE RECORD AND TOLD APART BY THEIR KEYS: what
    // leaves by SES, and what a browser shows on a lock screen (ticket #262).
    expect(Object.keys(TEMPLATES)).toEqual([
      "notify.invitation",
      "notify.loginCode",
      "notify.railDropped",
      "notify.railLoggedOut",
      "notify.push.draftReady",
      "notify.push.questionAsked",
      "notify.push.reminder",
      "notify.push.railDropped",
      "notify.push.railLoggedOut",
    ]);
  });

  it("renders a grave event in the character-silent register (#262)", () => {
    // WHAT IS THE CASE AND WHAT THE REP CAN DO NEXT, and no twin voice at all
    // (ADR-0037): the sweep at the end of this file holds the affirmative half
    // over every string, and this holds the occasion's own values.
    const rendered = renderTemplate(TEMPLATES["notify.railDropped"], {
      name: "Mauricio Torres",
      url: "https://dito.test/conexiones",
    });
    expect(rendered.subject).toBe("Vuelve a conectar tu WhatsApp con Dito");
    expect(rendered.body).toContain("Mauricio Torres");
    expect(rendered.body).toContain("https://dito.test/conexiones");
    expect(rendered.body).not.toMatch(/[{}]/u);
  });

  it("renders a push as a title and the twin's own sentence (#262)", () => {
    // THE BODY IS THE POST'S OWN WORDS AND THE TITLE IS THE PRODUCT'S. A
    // title that re-stated the occasion would be the form the knock exists to
    // replace (ADR-0031 as amended).
    const rendered = renderTemplate(TEMPLATES["notify.push.draftReady"], {
      body: "Te dejé listo lo de Garza.",
    });
    expect(rendered.subject).toBe("Dito");
    expect(rendered.body).toBe("Te dejé listo lo de Garza.");
  });

  it("is well formed at import: every entry passes its own check", () => {
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(template.key, key).toBe(key);
      expect(() => checkTemplate(template)).not.toThrow();
      for (const type of Object.values(template.slots)) {
        expect(SLOT_TYPES, `${key} declares \`${type}\``).toContain(type);
      }
    }
  });

  it("renders the invitation with the rep's name and the link, and no hole", () => {
    const rendered = renderTemplate(TEMPLATES["notify.invitation"], {
      name: "Mauricio Torres",
      url: "https://dito.test/entrar/8f2c",
    });
    expect(rendered.subject).toBe("Tu tablero de Dito está listo");
    expect(rendered.body).toContain("Mauricio Torres");
    expect(rendered.body).toContain("https://dito.test/entrar/8f2c");
    expect(rendered.body).not.toMatch(/[{}]/u);
  });

  it("renders the login code with its code, its link and its minutes", () => {
    const rendered = renderTemplate(TEMPLATES["notify.loginCode"], {
      name: "Mauricio Torres",
      code: "402913",
      url: "https://dito.test/entrar/8f2c",
      minutes: 10,
    });
    expect(rendered.subject).toBe("Tu código para entrar a Dito");
    expect(rendered.body).toContain("402913");
    expect(rendered.body).toContain("10");
    expect(rendered.body).not.toMatch(/[{}]/u);
  });

  it("is frozen, so a catalog's approval cannot be outlived (Codex r1)", () => {
    // The construction-time check is only a guarantee while what it checked
    // cannot change: a slot map that gained a `text` slot after
    // `@dito/notify` approved the template would carry a caller's prose
    // through a message type ADR-0022 says has no free text.
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(Object.isFrozen(template), key).toBe(true);
      expect(Object.isFrozen(template.slots), key).toBe(true);
      expect(() => {
        // @ts-expect-error — the point of the test is the runtime refusal.
        template.slots["mensaje"] = "text";
      }).toThrow(TypeError);
    }
  });

  it("states nothing about the rep's record (ADR-0037 as amended)", () => {
    // A template may label, name or explain. What it may never do is say
    // something about what the twin read, drafted or filed — the whole
    // reason a fixed sentence is permitted here is that it carries no claim
    // about the record. The mechanical half of that is the slot set: the
    // occasion binds a link, a code and a count, and there is no slot a
    // sentence about a customer could arrive through.
    //
    // A `composed` SLOT IS THE ONE EXCEPTION AND IT IS NOT ONE (ticket #262):
    // it carries a sentence the TWIN wrote and code read back out of a sealed
    // post, it exists only on a push type, and `@dito/notify`'s catalog is
    // what refuses it anywhere else. So the rule here is asserted over the
    // templates that leave by SES.
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(Object.values(template.slots), key).not.toContain("text");
      if (key.startsWith("notify.push.")) continue;
      expect(Object.values(template.slots), key).not.toContain("composed");
    }
  });
});

describe("every rep-facing string says what IS the case (#244; boundary #225's F16)", () => {
  /**
   * Both families as one list: a name for the string, and the string. The
   * documents are absent on purpose — that text is Diego's own to edit and is
   * exempt until his review (ticket #244), and `copy-versions-check.mjs` is
   * what proves nobody moved a byte of it.
   */
  const swept: readonly { readonly key: string; readonly text: string }[] = [
    ...Object.entries(CHROME).map(([key, text]) => ({ key, text })),
    ...Object.values(TEMPLATES).flatMap((template) => [
      { key: `${template.key}.subject`, text: template.subject },
      { key: `${template.key}.body`, text: template.body },
    ]),
  ];

  it("carries no negation word, in the chrome or in a template", () => {
    // THE RULE, VERBATIM: affirmative sentences only — say what is the case and
    // what the rep can do next, never what is not the case or what will happen
    // to them (boundary #225, F16). It is checked HERE, in one place, over
    // BOTH keyed families: a rule enforced family by family is a rule that
    // misses the family nobody remembered to list.
    //
    // SUSPENSE FRAMING IS NOT HERE, and cannot be: a sentence that names what
    // will happen to the rep («un borrador puede esperarte sin que lo sepas»)
    // is caught by reading it, and the pull request that changes a string is
    // where that reading happens. This half is the half a machine can hold.
    //
    // ...AND AN EXEMPTION IS SPENT OR IT IS A FINDING. A dead entry is a
    // standing exemption for a sentence that left, which is how a record stops
    // being one — `copy-check.mjs`'s ALLOWLIST is checked in both directions
    // for that reason, and doing it inside the sweep keeps the two directions
    // one pass over one list.
    const spent = new Set<string>();
    const exempt = new Set(
      EXCEPTIONS.map((entry) => `${entry.key} ${entry.word}`),
    );
    for (const { key, text } of swept) {
      const carried = negationsIn(text).filter((word) => {
        if (!exempt.has(`${key} ${word}`)) return true;
        spent.add(`${key} ${word}`);
        return false;
      });
      expect(`${key}: ${carried.join(", ")}`).toBe(`${key}: `);
    }
    for (const entry of EXCEPTIONS) {
      const at = `${entry.key} ${entry.word}`;
      const held = spent.has(at) ? at : `${at} (a word its string has stopped carrying)`;
      expect(held, entry.reason).toBe(at);
    }
  });

  it("...over a sentence it has seen fail, and over both ends of each family", () => {
    // REFUSING TO PASS ON NOTHING (ADR-0028 doctrine): a sweep whose words
    // match nothing reports green over any copy at all, so it is shown catching
    // the shape it exists for — a state written as an absence — and pinned to
    // both ends of both families rather than to its own arithmetic. A count
    // recomputed the way `swept` is built would pass by construction.
    const anAbsence = "Dito no está leyendo ningún chat.";
    expect(negationsIn(anAbsence)).toEqual(["no", "ningun"]);
    const keys = swept.map(({ key }) => key);
    expect(keys).toContain("nav.inicio");
    expect(keys).toContain("conexiones.relink");
    expect(keys).toContain("notify.invitation.subject");
    expect(keys).toContain("notify.loginCode.body");
    expect(swept.length).toBeGreaterThan(180);
  });

  it("sweeps every family the package publishes (the two-axis review's Spec axis)", async () => {
    // THE HOLE THE SWEEP ABOVE CANNOT SEE IS A FAMILY THAT DOES NOT EXIST YET.
    // `swept` names CHROME and TEMPLATES, so a third record of rep-facing
    // strings exported from `index.js` would join no rule at all — which is the
    // failure this whole check was grown to end, one level up. So the package's
    // exported VALUES are pinned: a new one goes red here, and whoever adds it
    // decides in this file whether the rule covers it. The documents are on the
    // list and out of the sweep, which is the ruling (they are Diego's own to
    // edit, and `copy-versions-check.mjs` guards their bytes). The bar's
    // playback pace is on the list and out of the sweep too: it holds numbers,
    // no word the rep reads (ticket #375). `whenRutinaRuns` is on the list and
    // out of the sweep as well: it joins swept CHROME keys around an hour and
    // the calendar's weekday names, and holds no word of its own (ticket #387).
    const published = await import("./index.js");
    expect(Object.values(published.BAR_PLAYBACK).every((value) => typeof value === "number")).toBe(true);
    expect(Object.keys(published).sort()).toEqual([
      "BAR_PLAYBACK",
      "CHROME",
      "CopyError",
      "DOCUMENTS",
      "DOCUMENT_KEYS",
      "FREE_FORM_SLOT_TYPES",
      "SLOT_TYPES",
      "TEMPLATES",
      "checkTemplate",
      "documentVersion",
      "documentVersions",
      "latestDocumentVersion",
      "renderTemplate",
      "whenRutinaRuns",
    ]);
  });
});

describe("the scoping form's own keys (#243; boundary #225's F16 and F24)", () => {
  it("names the press, and what a rep does after one that stopped early", () => {
    expect(CHROME["scoping.save"]).toBe("Guardar");
    // WHY THE NOTICE IS A KEY AND NOT A PAGE'S SENTENCE: the press applies one
    // act per changed chat in order, so a refusal partway leaves the allowlist
    // between the two lists — and the honest thing to say is that the list the
    // rep is looking at is the one that holds, plus the press that finishes it.
    expect(CHROME["scoping.savedPart"]).toContain("Guardar");
    // TWO SENTENCES AND NOT ONE, because the two renders differ (Codex r1): a
    // press that stopped part way lands on a page that HAS the list, and one
    // whose directory read failed may land on a page that says it could not
    // read it — so only the first may say «esta lista».
    expect(CHROME["scoping.unsaved"]).toContain("Guardar");
    expect(CHROME["scoping.unsaved"]).not.toContain("lista");
    // ...AND A THIRD, for a press that landed part way on a page with no list
    // to point at (Codex r2). It may say which changes landed and where the
    // list is; what it may NOT do is claim to be showing the scope.
    expect(CHROME["scoping.savedSome"]).toContain("Guardar");
    expect(CHROME["scoping.savedSome"]).not.toContain("Esta lista");
    // ...AND THE NOTE ABOUT UNMARKING NAMES THE PRESS (Codex r3). A mark is a
    // mark until «Guardar» applies it, so a note that said unticking stopped
    // Dito reading a chat «en ese momento» would send a rep away believing a
    // private chat was already out of scope.
    expect(CHROME["scoping.scopeOutNote"]).toContain("Guardar");
    expect(CHROME["scoping.scopeOutNote"]).not.toContain("en ese momento");
  });
});

describe("the canvas's retirements (ticket #266; spec #258 decision 12)", () => {
  it("holds none of the keys the queue and the record column were drawn with", () => {
    // THE DESK POSTURE RETIRES THEM (ADR-0037 as amended): no queue label, no
    // second column, no byline, no «Para»/«Porque:» labels, no «Listo para
    // enviar» marker, no note under every draft, no labelled binding block.
    for (const key of [
      "feed.today",
      "feed.waiting",
      "draft.waiting",
      "draft.toLabel",
      "draft.becauseLabel",
      "feed.postAuthor",
      "draft.note",
      "binding.label",
    ]) {
      expect(Object.keys(CHROME), key).not.toContain(key);
    }
  });

  it("leaves no reference to one of them anywhere under apps/", () => {
    // A KEY THE PACKAGE DROPPED AND A PAGE STILL NAMES is a type error in a
    // `.tsx` file and a silent `undefined` in anything else — so the sweep is
    // over every source file an app holds, whatever its extension.
    const apps = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps");
    const retired = [
      "feed.today",
      "feed.waiting",
      "draft.waiting",
      "draft.toLabel",
      "draft.becauseLabel",
      "feed.postAuthor",
      "draft.note",
      "binding.label",
    ];
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".next", "dist"].includes(entry.name)) continue;
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(at);
          continue;
        }
        if (!/\.(ts|tsx|mjs|js)$/u.test(entry.name)) continue;
        const text = readFileSync(at, "utf8");
        for (const key of retired) {
          if (text.includes(`"${key}"`)) found.push(`${path.relative(apps, at)}: ${key}`);
        }
      }
    };
    walk(apps);
    expect(found).toEqual([]);
  });

  it("says where a sent card's record went, in the words the ruling wrote", () => {
    // RULING 6 ON #279: «Salió a Laura; queda en Trabajos en curso.» — the
    // name is code's, between the two pieces.
    expect(
      `${CHROME["canvas.wentSentBefore"]}Laura${CHROME["canvas.wentSentAfter"]}`,
    ).toBe("Salió a Laura; queda en Trabajos en curso.");
  });
});

describe("Rutinas and Trabajos en curso (ticket #267; spec #258 decision 16)", () => {
  it("gives each shipped automation a name and a first-person sentence that names no number", () => {
    // THE HOUR IS THE DECLARATION'S, rendered into «Cada día a las» by code —
    // a figure typed into a sentence would be a second home for it. The twin
    // thread is not listed: it is the twin itself (ticket #325).
    for (const automation of ["drafting", "extraction", "disclosure", "reminders", "overnight"]) {
      const says = CHROME[`rutinas.${automation}Says` as keyof typeof CHROME];
      expect(CHROME[`rutinas.${automation}Name` as keyof typeof CHROME], automation).toBeTruthy();
      expect(says, automation).not.toMatch(/\d/u);
    }
  });

  it("opens each line of the acts log with its act word", () => {
    // The words CONTEXT.md's *Acts log* names, and the two the log adds.
    expect([
      CHROME["trabajos.actSent"],
      CHROME["trabajos.actDismissed"],
      CHROME["trabajos.actConfirmed"],
      CHROME["trabajos.actRetracted"],
    ]).toEqual(["Enviado", "Descartado", "Ligado", "Retirado"]);
    expect(`${CHROME["trabajos.actSent"]}${CHROME["trabajos.actJoin"]}Laura Garza`).toBe(
      "Enviado · Laura Garza",
    );
  });

  it("names today and yesterday on the day step, as the bar's history does", () => {
    expect([CHROME["trabajos.today"], CHROME["trabajos.yesterday"]]).toEqual([
      CHROME["bar.today"],
      CHROME["bar.yesterday"],
    ]);
  });
});

describe("the versioned documents (spec #214 decision 6; user story 12)", () => {
  it("pins each published version's digest to its own words", () => {
    // EVERY VERSION AND NOT ONLY THE LATEST, which is the hole this closes.
    // A rep's acknowledgment row carries the DIGEST this file publishes, so
    // the digest is what says which words they agreed to — and an author who
    // edits a text WITHOUT re-running its digest publishes different words
    // under a digest that still describes the old ones. `copy-versions-check`
    // cannot see it (the digest did not change) and a check over the latest
    // version cannot either (the edit was to an older one). This can: it
    // hashes what is shipped and compares it with what is declared.
    for (const entry of DOCUMENTS) {
      const digest = createHash("sha256")
        .update(entry.text, "utf8")
        .digest("hex");
      expect(`${entry.key} v${String(entry.version)}: ${digest}`).toBe(
        `${entry.key} v${String(entry.version)}: ${entry.digest}`,
      );
    }
  });

  it("numbers every key's versions from one, without a gap", () => {
    // A rep's row names a NUMBER, so the numbers have to be the package's own
    // sequence rather than whatever an author typed: a version 3 beside a
    // version 1 would make «version 2» a row nobody can resolve.
    for (const key of DOCUMENT_KEYS) {
      const versions = documentVersions(key).map((entry) => entry.version);
      expect(versions, key).toEqual(
        Array.from({ length: versions.length }, (_, at) => at + 1),
      );
    }
  });
});

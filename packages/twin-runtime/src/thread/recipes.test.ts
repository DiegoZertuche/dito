/**
 * WHAT THE THREAD'S PARTS RENDER (tickets #173, #319; spec #171 decision 19).
 *
 * The pre-agreed unit boundary for the two parts the seam suite can only
 * check one case of each: `quoted_post`'s four kinds and the verbless post
 * beside them, and `keyword_set`'s rendering FROM the matcher's own tables.
 * The seam proves a quoted draft and a quoted disclosure really reach the
 * model; this proves the other three shapes exist and say something
 * different.
 */
import { describe, expect, it } from "vitest";
import { renderParts, type NamedPart } from "@dito/execution";
import { AFFIRMATIONS } from "../affirmation.js";
import { notepadBundle } from "../testing/notepad-bundle.js";
import {
  FIXTURE_EVENT_ID,
  FIXTURE_SELF_CHAT,
  threadDeps,
} from "../testing/thread-deps.js";
import type { QuotedPost, ThreadDeps } from "./deps.js";
import { NOTEPAD_RECIPE } from "../rep-notepad.js";
import { WORKING_MEMORY_RECIPE } from "../working-memory.js";
import {
  KEYWORD_SET_RECIPE,
  QUOTED_POST_RECIPE,
  THE_MESSAGE_RECIPE,
  THREAD_RECIPES,
} from "./recipes.js";

function deps(overrides: Partial<ThreadDeps> = {}): ThreadDeps {
  return threadDeps({ message: "¿qué me pidió?", ...overrides });
}

/** One recipe's part, rendered over these deps. */
function part(recipe: string, over: Partial<ThreadDeps> = {}): NamedPart {
  const registration = THREAD_RECIPES[recipe];
  if (registration === undefined) throw new Error(`no recipe named ${recipe}`);
  return registration.create(deps(over))({});
}

describe("`quoted_post` says the kind and shows the content (decision 19)", () => {
  it("says plainly when the rep pointed at nothing", () => {
    // The part never vanishes: a model shown no `quoted_post` could not tell
    // "they wrote to me directly" from "nobody resolved the quote".
    expect(part(QUOTED_POST_RECIPE).text).toContain("did not point at anything");
    expect(part(QUOTED_POST_RECIPE).text).not.toContain("<quoted_post>");
  });

  it("shows a draft's body AND where it stands", () => {
    const quoted: QuotedPost = {
      kind: "draft",
      text: "✳️ *Borrador — para Sra. Garza*\n\n«claro, se las aparto»",
      draftState: "live",
    };
    const text = part(QUOTED_POST_RECIPE, { quotedPost: quoted }).text;
    expect(text).toContain("a draft reply you wrote");
    expect(text).toContain("still waiting");
    expect(text).toContain("«claro, se las aparto»");
  });

  it("says a dismissed draft is final, and a tapped one is gone", () => {
    // Dismissal is TERMINAL (ADR-0037; CONTEXT.md *Dismiss*), so «¿ya se
    // fue?» has three different true answers and the state is what decides
    // which. A twin shown only the body would guess.
    const draft: QuotedPost = { kind: "draft", text: "✳️ *Borrador*", draftState: "dismissed" };
    expect(part(QUOTED_POST_RECIPE, { quotedPost: draft }).text).toContain("final");
    expect(
      part(QUOTED_POST_RECIPE, {
        quotedPost: { ...draft, draftState: "tapped" },
      }).text,
    ).toContain("already sent it");
  });

  it("shows a disclosure's numbered lines as its content", () => {
    const quoted: QuotedPost = {
      kind: "daily_disclosure",
      text: "✳️ *Hoy agregué 2 datos al registro.*\n\n1. Lo di de alta como cliente.\n2. Pidió 40 cajas.",
    };
    const text = part(QUOTED_POST_RECIPE, { quotedPost: quoted }).text;
    expect(text).toContain("one numbered line per item");
    expect(text).toContain("2. Pidió 40 cajas.");
    // A statement carries no draft state, so none is claimed.
    expect(text).not.toContain("still waiting");
  });

  it("names the binding question for what it asks", () => {
    // THE BINDING IS THE ONLY QUESTION A REP CAN QUOTE (ticket #218): the
    // aperture's own ask was the other, and its kind is retired with the
    // route. The registry names this one rather than calling it a verbless
    // post.
    expect(
      part(QUOTED_POST_RECIPE, {
        quotedPost: { kind: "binding_question", text: "✳️ ¿Este chat es de Sra. Garza?" },
      }).text,
    ).toContain("whether a chat belongs to a name the phone offered");
  });

  it("calls a verbless post what it is, and invents no kind for it", () => {
    // A send confirmation, a refusal, an ack, an earlier answer: the registry
    // claims none of them and none is a thing the rep can act on.
    const text = part(QUOTED_POST_RECIPE, {
      quotedPost: { text: "✳️ Enviado a Sra. Garza ✓" },
    }).text;
    expect(text).toContain("something you said earlier in this thread");
    expect(text).toContain("Enviado a Sra. Garza ✓");
  });
});

describe("`keyword_set` renders FROM the matcher's own tables (user story 37)", () => {
  const text = part(KEYWORD_SET_RECIPE).text;

  it("teaches every word the matcher accepts, per grammar class", () => {
    // THE MECHANISM, not a coincidence: the words come from
    // `affirmation.ts`, so a word added or retaught there changes what the
    // twin may teach with no edit in this package — and a word that is not
    // in the table is one the twin has no way to learn.
    for (const word of AFFIRMATIONS.proposal) expect(text).toContain(`«${word}»`);
    for (const word of AFFIRMATIONS.question) expect(text).toContain(`«${word}»`);
  });

  it("teaches no word the matcher does not accept", () => {
    // The negative half, which is the half that matters: every quoted word
    // in the part is a member of one of the TWO accepted sets. It was four
    // sets until #174 and the two decline sets are gone with the matchers
    // that read them, so a part still naming «no va» would be teaching a
    // word nothing accepts (spec #171 decision 18).
    const accepted = new Set([
      ...AFFIRMATIONS.proposal,
      ...AFFIRMATIONS.question,
    ]);
    const quotedWords = [...text.matchAll(/«([^»]+)»/gu)].map(
      (match) => match[1]!,
    );
    expect(quotedWords.length).toBeGreaterThan(0);
    for (const word of quotedWords) expect(accepted, word).toContain(word);
  });

  it("says out loud that saying no to either act is prose", () => {
    // #173's recorded remainder 3, closed the way it has to be: the part
    // teaches two words, and the thing a model would otherwise invent is a
    // third. So the part states the absence rather than leaving it — and
    // the assertion is about the CLAIM rather than the sentence, because
    // the sentence is chrome.
    expect(text).toContain("EVERYTHING ELSE THEY SAY IS PROSE YOU READ");
    expect(text.toLowerCase()).toContain("never tell them a word to type");
  });

  it("says which class each set belongs to, and that quoting is what counts", () => {
    // «si» on a draft mints nothing (`affirmation.ts`'s own asymmetry), so a
    // twin that taught it as a way to send would teach the rep to watch
    // nothing happen.
    expect(text).toContain("on a draft you wrote");
    expect(text).toContain("on your question about who a chat belongs to");
    expect(text).toContain("quoting it");
    expect(text).toContain("on their own");
  });
});

describe("`the_message` carries the rep's own words, fenced", () => {
  it("shows them verbatim and says they are the rep's", () => {
    const text = part(THE_MESSAGE_RECIPE, { message: "ya no le contestes" }).text;
    expect(text).toContain("<rep_message>\nya no le contestes\n</rep_message>");
    expect(text).toContain("Read what they mean");
  });

  it("carries the message's own id, because every act takes it as evidence (#174)", () => {
    // WITHOUT THIS NO ACT COULD HAPPEN AT ALL. Every rep-act tool refuses
    // any id but this execution's trigger, so a model that had never been
    // shown the one id that passes would have every act refused in
    // production while every scripted test went green — a script can inject
    // what a model would have to read.
    const text = part(THE_MESSAGE_RECIPE).text;
    expect(text).toContain(FIXTURE_EVENT_ID);
    expect(text).toContain("takes as its evidence");
  });

  it("renders the id as English bracketed metadata, and nothing else about it", () => {
    // The #143 ruling for metadata, and an OPAQUE id: a `wa_events` row's
    // uuid, with no chat, no rail stanza id and not a syllable of anything
    // anybody said. So the only Spanish left in the part is the rep's own
    // sentence.
    const text = part(THE_MESSAGE_RECIPE, { message: "ya no" }).text;
    const metadata = text
      .split("\n")
      .filter((line) => line.startsWith("["))
      .join("");
    expect(metadata).toContain(FIXTURE_EVENT_ID);
    expect(metadata).not.toMatch(ES_MX);
    expect(text).not.toContain(FIXTURE_SELF_CHAT);
  });
});

/** The orthography of the language this rig reads (the owner side's rule). */
const ES_MX = /[¿¡«»áéíóúüñÁÉÍÓÚÜÑ]/u;

describe("the recipes bind nothing — content is not a parameter", () => {
  it("declares an empty shape for every one of them", () => {
    for (const [name, registration] of Object.entries(THREAD_RECIPES)) {
      expect(registration.parameters, name).toEqual({});
    }
  });

  it("holds no execution's data, so two concurrent turns share only code", () => {
    // From this ticket two executions really do run at once (`lanes.ts`), so
    // the registry being a frozen constant of FACTORIES is load-bearing
    // rather than tidy.
    expect(Object.isFrozen(THREAD_RECIPES)).toBe(true);
    const first = renderParts([part(THE_MESSAGE_RECIPE, { message: "uno" })]);
    const second = renderParts([part(THE_MESSAGE_RECIPE, { message: "dos" })]);
    expect(first).toContain("uno");
    expect(second).toContain("dos");
    expect(first).not.toContain("dos");
  });
});

describe("`notepad` renders the default line first, then what the rep taught (#260)", () => {
  it("is the default line and the version alone when the rep has taught nothing", () => {
    // THE VERSION IS THE ONE THING A NOTEBOOK NOBODY HAS WRITTEN STILL SAYS
    // (Codex round 2): `write_notepad` refuses a rewrite that names any other
    // number, so the first rule the rep ever teaches needs this zero.
    expect(part(NOTEPAD_RECIPE).text).toBe(
      [
        "[The rep's language and register: Mexican Spanish, informal WhatsApp.]",
        "[Their notebook is at version 0; a write of it says which version it replaces.]",
      ].join("\n"),
    );
  });

  it("is the default line alone after the rep clears their notebook", () => {
    // THE DELETE IS AN EMPTY VERSION (#264's save of an empty text, and the
    // tool's own empty write): the store still holds the row, and the model
    // reads exactly what it reads for a rep who never taught anything —
    // because those two reps want the same drafts.
    // ...and the version is the CLEARED one, not zero: a rewrite of an empty
    // notebook still replaces the version that emptied it.
    for (const cleared of ["", "   \n  "]) {
      expect(part(NOTEPAD_RECIPE, { bundle: notepadBundle(cleared) }).text).toBe(
        [
          "[The rep's language and register: Mexican Spanish, informal WhatsApp.]",
          "[Their notebook is at version 1; a write of it says which version it replaces.]",
        ].join("\n"),
      );
    }
  });

  it("fences the rep's words and says whose they are", () => {
    const text = part(NOTEPAD_RECIPE, {
      bundle: notepadBundle("con Fuentes siempre de usted\nfirmo «saludos»"),
    }).text;
    // THE DEFAULT LINE COMES FIRST (spec #258), and the rep's own words sit
    // under a heading that says they are theirs — the fence is how the model
    // tells a standing rule from the framing around it.
    expect(text.indexOf("[The rep's language and register")).toBe(0);
    expect(text).toContain("They wrote it, you did not");
    expect(text).toContain(
      "<rep_notepad>\ncon Fuentes siempre de usted\nfirmo «saludos»\n</rep_notepad>",
    );
  });

  it("is data and never an instruction to the model (ADR-0033 as amended)", () => {
    // Where it goes is the automation's — every wake's message, before the
    // twin's own notes (`definition.test.ts` pins the slot) — and this is the
    // claim about what it SAYS: it reports
    // what the rep told the twin, and asks the model for nothing.
    const text = part(NOTEPAD_RECIPE, {
      bundle: notepadBundle("con Fuentes siempre de usted"),
    }).text;
    expect(text).not.toContain("You must");
    expect(text).not.toContain("Follow");
  });
});

describe("`working_memory` renders the twin's own notes, marked as notes and never as rules (#322)", () => {
  const TORRES = { kind: "entity", id: "0e2c7a52-0000-4000-8000-0000000000aa" } as const;
  const CARD = { kind: "post", id: "0e2c7a52-0000-4000-8000-0000000000bb" } as const;

  it("says so when the twin has written nothing", () => {
    expect(part(WORKING_MEMORY_RECIPE).text).toBe(
      "[Your own working notes about this rep are empty, at version 0: you have nothing written down about what is live with them.]",
    );
  });

  it("frames the prose and the open matters as the twin's, inside a tag of their own", () => {
    const text = part(WORKING_MEMORY_RECIPE, {
      bundle: notepadBundle("con Fuentes de usted", {
        text: "Torres espera saber cuándo sale su pedido.",
        matters: [
          { label: "Torres, el pedido", about: TORRES },
          { label: "el borrador de la mañana", about: CARD },
        ],
      }),
    }).text;
    expect(text).toBe(
      [
        "[Your own working notes, at version 1: what you are keeping track of with this rep. You wrote these; they are not the rep's instructions and bind nothing. Rewrite them whenever they stop being true:]",
        "<working_memory>",
        "Torres espera saber cuándo sale su pedido.",
        "Open matters:",
        "- Torres, el pedido [customer 0e2c7a52-0000-4000-8000-0000000000aa]",
        "- el borrador de la mañana [post 0e2c7a52-0000-4000-8000-0000000000bb]",
        "</working_memory>",
      ].join("\n"),
    );
    // NEVER INSIDE THE NOTEPAD'S FENCE, and never framed as what the rep said.
    expect(text).not.toContain("rep_notepad");
    expect(text).not.toContain("What the rep has told you");
  });
});

/**
 * THE CATALOG IS CLOSED, AND IT FAILS AT CONSTRUCTION (ticket #219 AC 3;
 * ADR-0022: "a closed catalog of named message types, each bound to a fixed
 * template with schema-validated parameters — no free-text parameter exists
 * (CI-checked)").
 *
 * This file is the CI check that sentence asks for. Two halves: the shipped
 * catalog is held to the rule, and `defineCatalog` is shown to refuse every
 * way of breaking it — because a rule proven only against the code that
 * already obeys it is a rule nobody has tested.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FREE_FORM_SLOT_TYPES, TEMPLATES, type CopyTemplate } from "@dito/copy";
import {
  callerSlots,
  defineCatalog,
  NOTIFY_CATALOG,
  NOTIFY_MESSAGE_TYPES,
  NotifyError,
  type CatalogEntry,
  type SeatSlotSource,
} from "./index.js";

/** A template with a free-form slot — the thing ADR-0022 forbids sending. */
const FREE_TEXT: CopyTemplate = {
  key: "test.freeText",
  subject: "Aviso",
  body: "{message}",
  slots: { message: "text" },
};

/** ...and one without, so the refusals below are about the slot and not the fixture. */
const BOUNDED: CopyTemplate = {
  key: "test.bounded",
  subject: "Aviso",
  body: "Entra en {url}.",
  slots: { url: "url" },
};

/** ...and one carrying the twin's own sentence, which only a push may (#262). */
const COMPOSED: CopyTemplate = {
  key: "test.composed",
  subject: "Dito",
  body: "{body}",
  slots: { body: "composed" },
};

const FIXTURES = {
  "test.freeText": FREE_TEXT,
  "test.bounded": BOUNDED,
  "test.composed": COMPOSED,
};

/**
 * One entry over a FIXTURE template.
 *
 * THE CAST IS THE POINT AND NOT A SHORTCUT: `CatalogEntry.template` is the
 * union of the shipped template keys, which is what stops a typo reaching
 * the catalog — so a rule about templates can only be exercised with a
 * template written for the test by stepping outside that union once, here.
 */
function entry(
  type: string,
  template: string,
  seatSlots: Readonly<Record<string, SeatSlotSource>> = {},
): CatalogEntry {
  return { type, template, seatSlots } as unknown as CatalogEntry;
}

/** ...and one bound to a PUSH template, for the seventh refusal (#262). */
function pushEntry(
  type: string,
  template: string,
  link: "card" | "connections" = "card",
): CatalogEntry {
  return { type, push: { template, link }, seatSlots: {} } as unknown as CatalogEntry;
}

/**
 * The entries a COMPLETE catalog needs, over the fixture templates.
 *
 * ALL SEVEN, because the sixth refusal is completeness: a catalog missing one
 * type throws whatever else is wrong with it, so a fixture short of the set
 * would make every refusal below pass for the wrong reason. The overrides land
 * on the first entry, which is the one each case is about.
 */
function complete(overrides: Partial<CatalogEntry> = {}): CatalogEntry[] {
  return [
    { ...entry("invitation", "test.bounded"), ...overrides },
    entry("login_code", "test.bounded"),
    pushEntry("draft_ready", "test.composed"),
    pushEntry("question_asked", "test.composed"),
    pushEntry("reminder", "test.composed"),
    pushEntry("rail_dropped", "test.composed", "connections"),
    pushEntry("rail_logged_out", "test.composed", "connections"),
  ];
}

describe("the shipped catalog (ticket #219 AC 3)", () => {
  it("holds exactly the seven message types Dito sends", () => {
    // TWO BY EMAIL, THREE BY PUSH, TWO BOTH WAYS (ticket #262; spec #258
    // decision 7). The vocabulary was cut once, at #262, because widening
    // `notify_sends_message_type_check` is a DROP-and-re-CREATE; #268 gave
    // the reminder type the caller it was declared ahead of.
    const seven = [
      "invitation",
      "login_code",
      "draft_ready",
      "question_asked",
      "reminder",
      "rail_dropped",
      "rail_logged_out",
    ];
    expect(Object.keys(NOTIFY_CATALOG)).toEqual(seven);
    expect([...NOTIFY_MESSAGE_TYPES]).toEqual(seven);
    // ...AND NO DIGEST, which is a decision rather than a gap (spec #258).
    expect(NOTIFY_MESSAGE_TYPES as readonly string[]).not.toContain("digest");
  });

  it("admits the composed slot on a push and on nothing else (#262)", () => {
    // ADR-0022's amendment, over the SHIPPED entries: the twin's voice reaches
    // a lock screen and never an inbox, and the import check below is what
    // makes that a build failure rather than a convention.
    for (const catalogued of Object.values(NOTIFY_CATALOG)) {
      if (catalogued.template !== undefined) {
        expect(
          Object.values(TEMPLATES[catalogued.template].slots),
          catalogued.type,
        ).not.toContain("composed");
      }
    }
    const push = Object.values(NOTIFY_CATALOG)
      .filter((catalogued) => catalogued.push !== undefined)
      .map((catalogued) => catalogued.type);
    expect(push).toEqual([
      "draft_ready",
      "question_asked",
      "reminder",
      "rail_dropped",
      "rail_logged_out",
    ]);
  });

  it("gives the reminder no email path at all (ticket #268)", () => {
    // NO REMINDER EVER GOES BY EMAIL (spec #258 decision 7: email is for grave
    // events only). The case above says the twin's composed voice cannot ride
    // an email TEMPLATE; this says the reminder type has no email template to
    // ride — which is what `sendOn` reads to decide whether SES is touched at
    // all (`mailable`), so the type cannot reach the transport however a
    // caller asks. The seat-side proof is in `notify.int.test.ts`.
    const reminder = NOTIFY_CATALOG["reminder"]!;
    expect(reminder.template).toBeUndefined();
    expect(reminder.push).toBeDefined();
    expect(reminder.seatSlots).toEqual({});
  });

  it("decides each push's deep link in the catalog, never at a caller (#262)", () => {
    // WHERE A TAP LANDS IS A PROPERTY OF THE OCCASION: an announcement lands
    // on the card it is about, and a grave event lands where a rep re-links.
    expect(
      Object.values(NOTIFY_CATALOG)
        .filter((catalogued) => catalogued.push !== undefined)
        .map((catalogued) => `${catalogued.type}:${catalogued.push!.link}`),
    ).toEqual([
      "draft_ready:card",
      "question_asked:card",
      "reminder:card",
      "rail_dropped:connections",
      "rail_logged_out:connections",
    ]);
  });

  it("carries no free-text parameter on any message type (ADR-0022)", () => {
    // The claim in its own words, over the templates the shipped entries
    // actually name. `defineCatalog` refuses a free-form slot at import, so
    // this could not be red without that refusal being wrong — which is
    // exactly why the refusals themselves are exercised below against
    // fixtures rather than against the code that already obeys them.
    for (const catalogued of Object.values(NOTIFY_CATALOG)) {
      for (const key of [catalogued.template, catalogued.push?.template]) {
        if (key === undefined) continue;
        for (const [slot, type] of Object.entries(TEMPLATES[key].slots)) {
          expect(FREE_FORM_SLOT_TYPES, `${catalogued.type}.${slot}`).not.toContain(type);
        }
      }
    }
    expect(
      Object.values(NOTIFY_CATALOG)
        .map((catalogued) => catalogued.template)
        .filter((key) => key !== undefined),
    ).toEqual([
      "notify.invitation",
      "notify.loginCode",
      "notify.railDropped",
      "notify.railLoggedOut",
    ]);
  });

  it("leaves the caller exactly the occasion's own slots", () => {
    // The name is the seat's, so it is not on either list: a caller chooses
    // the occasion and never the text (ADR-0022).
    expect(callerSlots(NOTIFY_CATALOG["invitation"])).toEqual(["url"]);
    expect(callerSlots(NOTIFY_CATALOG["login_code"])).toEqual([
      "code",
      "minutes",
      "url",
    ]);
  });

  it("is frozen entry by entry, seat slots included (Codex r2)", () => {
    // Freezing the outer record alone left `seatSlots` writable, and
    // emptying it makes the renderer take a caller-supplied `name` — for
    // every send afterwards, because the catalog is shared.
    expect(Object.isFrozen(NOTIFY_CATALOG)).toBe(true);
    for (const entry of Object.values(NOTIFY_CATALOG)) {
      expect(Object.isFrozen(entry), entry.type).toBe(true);
      expect(Object.isFrozen(entry.seatSlots), entry.type).toBe(true);
    }
    expect(() => Object.assign(NOTIFY_CATALOG["invitation"], { seatSlots: {} })).toThrow(
      TypeError,
    );
    // ...and the published entry is a COPY, so the array a caller still
    // holds is not a handle on what the catalog serves.
    const entries = complete({
      ...entry("invitation", "test.bounded", { url: "rep_display_name" }),
    });
    const built = defineCatalog(entries, FIXTURES);
    (entries[0] as { seatSlots: Record<string, string> }).seatSlots = {};
    expect(Object.keys(built["invitation"].seatSlots)).toEqual(["url"]);
  });
});

describe("the public surface (Codex r1)", () => {
  it("offers no way to send that does not start from a seat id", async () => {
    // THE HOLE THIS CLOSES. `sesTransport`'s `send({ to, subject, body })`
    // is a caller naming an arbitrary address and arbitrary text with every
    // guard in this package bypassed — no seat read, no catalog entry, no
    // row. It and its command builder are internal now, and the only door
    // into SES from outside is `createLiveNotify`.
    const surface = await import("./index.js");
    for (const name of [
      "sesTransport",
      "liveSesTransport",
      "sendEmailInput",
      // ...and `createNotify` with it: it takes a transport, so a caller
      // could hand it one of its own and see the address notify resolved.
      "createNotify",
    ]) {
      expect(Object.keys(surface), name).not.toContain(name);
    }
    // ...and what IS on it: a service whose one verb takes a seat.
    expect(Object.keys(surface)).toContain("createLiveNotify");
  });

  it("cannot be reached around, either, by a subpath into the built package", () => {
    // THE STRUCTURAL HALF (Codex r1). Leaving `exports` off the manifest let
    // any workspace file import `@dito/notify/dist/ses.js` and hold the raw
    // transport — the same reach the dependency wall now refuses, closed one
    // layer lower by Node's own resolver. `@dito/aperture` pins its entry
    // the same way.
    const manifest = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
        "utf8",
      ),
    ) as { exports?: Readonly<Record<string, unknown>> };
    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);
  });
});

describe("defineCatalog refuses every way of breaking the rule", () => {
  it("refuses a message type outside the closed set", () => {
    expect(() =>
      defineCatalog(
        [...complete(), entry("password_reset", "test.bounded")],
        FIXTURES,
      ),
    ).toThrow(NotifyError);
  });

  it("refuses a template whose slot is free-form (ADR-0022's own sentence)", () => {
    expect(() =>
      defineCatalog(
        complete({ template: entry("invitation", "test.freeText").template }),
        FIXTURES,
      ),
    ).toThrow(/free-text parameter/u);
  });

  it("refuses a template @dito/copy does not hold", () => {
    expect(() =>
      defineCatalog(
        complete({ template: entry("invitation", "notify.nothing").template }),
        FIXTURES,
      ),
    ).toThrow(NotifyError);
  });

  it("refuses a seat-filled slot the template never declares", () => {
    // A value nobody renders, which is how a message quietly stops
    // carrying the thing its caller believes it carries.
    expect(() =>
      defineCatalog(
        complete({ seatSlots: { nombre: "rep_display_name" } }),
        FIXTURES,
      ),
    ).toThrow(NotifyError);
  });

  it("refuses two entries for one type, where the second would silently win", () => {
    expect(() =>
      defineCatalog(
        [...complete(), entry("invitation", "test.bounded")],
        FIXTURES,
      ),
    ).toThrow(NotifyError);
  });

  it("refuses a composed slot on an email type — the seventh check (#262)", () => {
    // ADR-0022's amendment, shown biting: a template carrying the twin's own
    // sentence is admissible on a push and on nothing else, so binding one to
    // the EMAIL half of a type is a red build rather than a paragraph in an
    // inbox.
    expect(() =>
      defineCatalog(
        complete({ template: entry("invitation", "test.composed").template }),
        FIXTURES,
      ),
    ).toThrow(/never an inbox/u);
    // ...and the same template on a push type imports, which is what makes
    // the refusal above about the TRANSPORT rather than about the slot.
    expect(() => defineCatalog(complete(), FIXTURES)).not.toThrow();
  });

  it("refuses an entry that names no template on either transport (#262)", () => {
    expect(() =>
      defineCatalog(
        complete({ template: undefined, push: undefined }),
        FIXTURES,
      ),
    ).toThrow(/names no template on either transport/u);
  });

  it("refuses a free-form slot on a PUSH template too (#262)", () => {
    // The fourth check reaches both transports: a composed slot is the twin's
    // own sentence read out of a sealed row, and a `text` slot is a hole a
    // CALLER puts words in — which is refused wherever it is declared.
    const entries = complete();
    entries[2] = pushEntry("draft_ready", "test.freeText");
    expect(() => defineCatalog(entries, FIXTURES)).toThrow(
      /free-text parameter/u,
    );
  });

  it("refuses a catalog that is closed but incomplete", () => {
    // A named message with no template is a caller waiting for a send that
    // can never happen — so the set and the entries are one thing.
    expect(() =>
      defineCatalog(complete().slice(0, -1), FIXTURES),
    ).toThrow(/holds no entry/u);
  });

  it("accepts the honest one, so the refusals above are about the rule", () => {
    expect(Object.keys(defineCatalog(complete(), FIXTURES))).toEqual([
      ...NOTIFY_MESSAGE_TYPES,
    ]);
  });
});

/**
 * ONE STABLE REFERENCE PER CUSTOMER — THE GRAMMAR, THE NAMES CODE RENDERS,
 * THE TAIL (ticket #321; spec #318 decision 18; D15;
 * CONTEXT.md *Reference*).
 *
 * The customers are read from a real bundle (ADR-0028): what a reference
 * names is the bundle's answer, and a hand-written lookup would be this suite
 * agreeing with itself about what a customer is.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import { useTmpDirs } from "../testing/tmp.js";
import {
  annotateNames,
  customersOf,
  keepMarksOn,
  marksIn,
  mentionsIn,
  parseReference,
  referencesIn,
  renderNames,
  tailsOf,
  unmarked,
  withoutReferences,
  writeReference,
} from "./references.js";

const tmpDir = useTmpDirs("dito-thread-references-");
const SELF = "5215550000@s.whatsapp.net";
const GARZA = "5215550001@s.whatsapp.net";
const DIEGO_8416 = "5218110008416@s.whatsapp.net";
const DIEGO_0537 = "5218110000537@s.whatsapp.net";
const LAURA = "5215550003@s.whatsapp.net";

/** Garza on one chat, Diego on two, and Laura, whom nobody has confirmed. */
function fixture(): Bundle {
  const bundle = createBundle(join(tmpDir(), "twin.bundle"), createDekFromMaterial(randomBytes(32)));
  bundle.confirmChatBinding({
    chatJid: GARZA,
    entityId: "E-GARZA",
    displayName: "Sra. Garza",
    confirmedAt: "2026-09-01T10:00:00.000Z",
  });
  for (const [chatJid, at] of [
    [DIEGO_8416, "2026-09-02T10:00:00.000Z"],
    [DIEGO_0537, "2026-09-03T10:00:00.000Z"],
  ] as const) {
    bundle.confirmChatBinding({
      chatJid,
      entityId: "E-DIEGO",
      displayName: "Diego Zertuche",
      confirmedAt: at,
    });
  }
  bundle.ingestMessage({
    chatJid: LAURA,
    messageId: "L-1",
    senderJid: LAURA,
    fromMe: false,
    occurredAt: "2026-09-04T10:00:00.000Z",
    content: "¿me cotizas?",
    pushName: "Laura",
  });
  bundle.referenceForChat(LAURA);
  return bundle;
}

describe("the grammar", () => {
  it("writes a reference as a letter and its number, bracketed in prose", () => {
    expect(writeReference(7)).toBe("[c7]");
    expect(referencesIn("[c7] y [c12], otra vez [c7].")).toEqual([7, 12]);
    expect(withoutReferences("[c7] pidió 40 cajas")).toBe("  pidió 40 cajas");
  });

  it("is never the per-turn number of a citation, nor a quantity in a sentence", () => {
    expect(referencesIn("[[3]] pidió [3] cajas, ref 7")).toEqual([]);
  });

  it("reads a reference out of a tool argument, bare or bracketed, and nothing else", () => {
    for (const given of ["c7", "[c7]", " C7 ", "[ c7 ]"]) expect(parseReference(given), given).toBe(7);
    for (const given of [7, "7", "Torres", "c", "[c7", "c7x", null]) {
      expect(parseReference(given), JSON.stringify(given)).toBeUndefined();
    }
  });
});

describe("a mark: words of the twin's that mean one of its cards (ticket #401)", () => {
  const CARD = "6f0c3a52-0000-4000-8000-000000000001";
  const GONE = "6f0c3a52-0000-4000-8000-000000000002";
  const GARZA = [{ reference: "c7", name: "Sra. Garza" }];

  it("holds a name or any words; read, typed and named as its words alone", () => {
    expect(marksIn(`[[c7]](${CARD}) y [el segundo intento](${GONE})`)).toEqual([CARD, GONE]);
    expect(referencesIn(`[[c7]](${CARD}) y [c12]`)).toEqual([7, 12]);
    expect(unmarked(`[el segundo intento](${CARD}) va`)).toBe("el segundo intento va");
    expect(withoutReferences(`[[c7]](${CARD}) pidió 40 cajas`)).toBe("  pidió 40 cajas");
    // THE PHONE READS THE WORDS AND THE NAME, NEVER THE CARD.
    expect(renderNames(`[la de [c7]](${CARD}) pidió`, GARZA)).toBe("la de Sra. Garza pidió");
    // THE TWIN READS BACK WHAT IT WROTE, marks and all.
    expect(annotateNames(`[[c7]](${CARD}) pidió`, GARZA)).toBe(`[[c7] Sra. Garza](${CARD}) pidió`);
  });

  it("parses a card written with brackets or spaces, so the phone and the dashboard never show the syntax (Codex r4)", () => {
    expect(renderNames("Ya va [el pedido de [c7]](<post id>).", GARZA)).toBe("Ya va el pedido de Sra. Garza.");
    expect(keepMarksOn("[el pedido](<post id>)", new Set([CARD]))).toBe("el pedido");
    expect(withoutReferences("[el pedido](<post id>) 40")).toBe("el pedido 40");
  });

  it("stays while its card is on the canvas, and drops to its words when it is not", () => {
    const onCanvas = new Set([CARD]);
    expect(keepMarksOn(`[[c7]](${CARD}) y [lo de ayer](${GONE}) y [c9].`, onCanvas)).toBe(`[[c7]](${CARD}) y lo de ayer y [c9].`);
    expect(keepMarksOn(`[[c7]](${CARD})`, new Set())).toBe("[c7]");
  });
});

describe("what a reference names, read from the bundle", () => {
  it("names a confirmed customer by the name the rep confirmed, with every chat in confirmation order", () => {
    const bundle = fixture();
    const customers = customersOf(bundle, SELF);
    expect(customers(1)).toMatchObject({ entityId: "E-GARZA", name: "Sra. Garza", shown: "Sra. Garza" });
    expect(customers(2)?.chats).toEqual([
      { chatJid: DIEGO_8416, tail: "8416" },
      { chatJid: DIEGO_0537, tail: "0537" },
    ]);
    bundle.close();
  });

  it("names a chat nobody confirmed by the push-name the other side wrote under, marked", () => {
    const bundle = fixture();
    expect(customersOf(bundle, SELF)(3)).toMatchObject({
      name: "Laura",
      shown: "Laura (sin confirmar)",
      anchors: ["L-1"],
    });
    expect(customersOf(bundle, SELF)(3)?.entityId).toBeUndefined();
    bundle.close();
  });

  it("names nobody for a number no row holds", () => {
    const bundle = fixture();
    expect(customersOf(bundle, SELF)(99)).toBeUndefined();
    bundle.close();
  });
});

describe("the tail rule: the number's tail only where a customer has more than one chat", () => {
  it("gives a two-chat customer every tail, and a one-chat customer none", () => {
    const bundle = fixture();
    const customers = customersOf(bundle, SELF);
    expect(tailsOf(customers(2)!)).toEqual(["8416", "0537"]);
    expect(tailsOf(customers(1)!)).toEqual([]);
    expect(tailsOf(customers(3)!)).toEqual([]);
    bundle.close();
  });
});

describe("mentions: what a post seals, and what each surface renders from it", () => {
  it("seals each customer once, with the tails where they apply and the entity where confirmed", () => {
    const bundle = fixture();
    const mentions = mentionsIn("[c2] y [c1]; luego [c2] otra vez, y [c3].", customersOf(bundle, SELF));
    expect(mentions).toEqual([
      { reference: "c2", name: "Diego Zertuche", tails: ["8416", "0537"], entityId: "E-DIEGO" },
      { reference: "c1", name: "Sra. Garza", entityId: "E-GARZA" },
      { reference: "c3", name: "Laura (sin confirmar)" },
    ]);
    // THE PHONE READS NAMES; THE TWIN READS ITS REFERENCES BACK WITH THEM.
    expect(renderNames("[c2] y [c1] escribieron.", mentions)).toBe(
      "Diego Zertuche (…8416, …0537) y Sra. Garza escribieron.",
    );
    expect(annotateNames("[c1] escribió.", mentions)).toBe("[c1] Sra. Garza escribió.");
    bundle.close();
  });

  it("refuses to render a reference its mentions do not hold — the guard and the renderer disagreeing", () => {
    expect(() => renderNames("[c9] escribió.", [])).toThrow(/names no customer/u);
  });
});

describe("nothing reads the retired focus, the served chat map or the hint keys", () => {
  it("sweeps the runtime's sources for their readers, outside the disclosure's own slot code", () => {
    // AC 3 OF TICKET #321, AS A SWEEP: the focus store and the per-run name
    // map are gone, and a reader of either left anywhere would be code
    // reaching for a value nothing holds. The daily disclosure and
    // extraction keep their own single-message served maps and slots
    // (`disclosure/slots.ts`, `extraction/served.ts`), which are not these.
    const root = fileURLToPath(new URL("../", import.meta.url));
    const retired = /\b(readFocus|writeFocus|FOCUS_RECIPE|hintKeys|nameOfRef|focusAfter|reserveFocus|ServedChat)\b/u;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "extraction") walk(path);
        } else if (path.endsWith(".ts") && !path.endsWith("references.test.ts")) {
          if (retired.test(readFileSync(path, "utf8"))) offenders.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

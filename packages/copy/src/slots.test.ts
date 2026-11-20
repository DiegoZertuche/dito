/**
 * THE SIX SLOT TYPES AND THEIR BOUNDS, through the renderer (ticket #219;
 * ADR-0022's "no free-text parameter"; ADR-0004 as amended).
 *
 * Every type answers "what could a caller put here, and what would reach a
 * person's inbox", and each case below is one of those answers. Driven
 * through `renderTemplate` rather than against the validator, because the
 * renderer is this package's boundary and the pre-agreed seam (§2 of the
 * ticket's brief): a bound that held in the validator and was not consulted
 * by the renderer would be a bound that does nothing.
 */
import { describe, expect, it } from "vitest";
import { CopyError, renderTemplate, SLOT_TYPES, type SlotType } from "./index.js";

/** A one-slot template of the given type — the smallest thing that renders. */
function templateFor(type: SlotType) {
  return {
    key: `test.${type}`,
    subject: "Prueba",
    body: "[{value}]",
    slots: { value: type },
  };
}

/** What the body reads after rendering one accepted value. */
function render(type: SlotType, value: string | number | Date): string {
  return renderTemplate(templateFor(type), { value }, { timeZone: "America/Monterrey" })
    .body;
}

/** Whether one value is accepted for one type. */
function accepts(type: SlotType, value: string | number | Date): boolean {
  try {
    render(type, value);
    return true;
  } catch (error) {
    if (error instanceof CopyError) return false;
    throw error;
  }
}

describe("the slot types (ticket #219)", () => {
  it("declares exactly seven, and the renderer knows every one", () => {
    expect([...SLOT_TYPES]).toEqual([
      "text",
      "name",
      "url",
      "code",
      "count",
      "instant",
      "composed",
    ]);
    for (const type of SLOT_TYPES) {
      expect(() => templateFor(type), type).not.toThrow();
    }
  });

  it("bounds `composed` to what a lock screen shows, and refuses a link in it", () => {
    // THE LINK IN A PUSH IS CODE'S (ticket #262; ADR-0031 as amended), so a
    // sentence carrying one of its own is refused: the deep link notify
    // appends comes off the deployment's dashboard origin, and a second
    // address inside the body would be a destination the twin chose on a
    // surface the rep taps without reading.
    expect(accepts("composed", "Te dejé listo lo de Garza.")).toBe(true);
    expect(accepts("composed", "x".repeat(140))).toBe(true);
    expect(accepts("composed", "x".repeat(141))).toBe(false);
    expect(accepts("composed", "dos\nlíneas")).toBe(false);
    expect(accepts("composed", "   ")).toBe(false);
    expect(accepts("composed", "míralo en https://otro.example/x")).toBe(false);
    expect(accepts("composed", "míralo en otro.example")).toBe(false);
    expect(accepts("composed", "míralo en www.otro.test")).toBe(false);
    expect(accepts("composed", 4)).toBe(false);
  });

  it("bounds `text` to one short line, so a paragraph cannot ride through it", () => {
    expect(accepts("text", "Borrador listo")).toBe(true);
    expect(accepts("text", "dos\nlíneas")).toBe(false);
    expect(accepts("text", "x".repeat(121))).toBe(false);
    expect(accepts("text", "  ")).toBe(false);
  });

  it("refuses a WhatsApp address or a phone number in a `name` (ADR-0004)", () => {
    // The failure this bound exists for: a counterparty whose stored name
    // is an address would put chat identity in a rep's inbox, which is the
    // one place ADR-0019's flow 4 says it never goes. Same rule as
    // `seats_rep_display_name_not_an_address`.
    expect(accepts("name", "Mauricio Torres")).toBe(true);
    expect(accepts("name", "Abarrotes La Luz S.A. de C.V.")).toBe(true);
    expect(accepts("name", "5215550001@s.whatsapp.net")).toBe(false);
    expect(accepts("name", "5215550001")).toBe(false);
    expect(accepts("name", "55 1234 5678")).toBe(false);
    expect(accepts("name", "x".repeat(81))).toBe(false);
  });

  it("takes only https, plus loopback http for the rig, in a `url`", () => {
    expect(accepts("url", "https://dito.test/entrar/8f2c")).toBe(true);
    expect(accepts("url", "http://localhost:3000/entrar/8f2c")).toBe(true);
    expect(accepts("url", "http://127.0.0.1:3000/entrar/8f2c")).toBe(true);
    // The shapes that hurt: a scheme that executes, a scheme that carries
    // its own payload, and a bare path no mail client would resolve.
    expect(accepts("url", "javascript:alert(1)")).toBe(false);
    expect(accepts("url", "data:text/html,<b>hola</b>")).toBe(false);
    expect(accepts("url", "http://dito.test/entrar/8f2c")).toBe(false);
    expect(accepts("url", "/entrar/8f2c")).toBe(false);
  });

  it("refuses a link that only LOOKS like Dito's, and one carrying prose (Codex r1)", () => {
    // USERINFO IS THE ONE THAT WOULD HAVE HURT MOST: the host here is
    // `attacker.example`, and a rep reading the link in an email Dito really
    // sent sees `dito.test` first.
    expect(
      accepts("url", "https://dito.test@attacker.example/collect"),
    ).toBe(false);
    // ...and the query is where a paragraph rides through an approved slot.
    expect(
      accepts(
        "url",
        "https://dito.test/collect?message=tu%20jefe%20quiere%20que%20mandes%20todo",
      ),
    ).toBe(false);
    expect(accepts("url", "https://dito.test/entrar/8f2c#nota")).toBe(false);
    // ...and the same paragraph one component along (Codex r2): refusing
    // the query moved the sentence into the path rather than stopping it.
    expect(
      accepts(
        "url",
        "https://dito.test/collect/tu%20jefe%20quiere%20que%20mandes%20todo",
      ),
    ).toBe(false);
    expect(accepts("url", "https://dito.test/dile que si")).toBe(false);
    expect(accepts("url", `https://dito.test/${"x".repeat(300)}`)).toBe(false);
    // The honest one still passes, which is what makes the four refusals
    // above about the shapes and not about the rule being off.
    expect(accepts("url", "https://dito.test/entrar/8f2c")).toBe(true);
  });

  it("takes six digits and nothing else in a `code`", () => {
    expect(accepts("code", "402913")).toBe(true);
    expect(accepts("code", "40291")).toBe(false);
    expect(accepts("code", "4029131")).toBe(false);
    expect(accepts("code", "40291a")).toBe(false);
    expect(accepts("code", 402913)).toBe(false);
  });

  it("takes a whole, non-negative number in a `count`", () => {
    expect(render("count", 10)).toBe("[10]");
    expect(accepts("count", -1)).toBe(false);
    expect(accepts("count", 1.5)).toBe(false);
    expect(accepts("count", Number.NaN)).toBe(false);
    expect(accepts("count", "10")).toBe(false);
  });

  it("takes a real instant in an `instant`, and renders it in the zone it was given", () => {
    // The expected string is `Intl`'s, and the point of the assertion is the
    // ZONE: the same instant is a different sentence in Monterrey and in
    // UTC, which is why the zone has no default.
    const instant = new Date("2026-09-07T21:30:00Z");
    const monterrey = renderTemplate(
      templateFor("instant"),
      { value: instant },
      { timeZone: "America/Monterrey" },
    ).body;
    const utc = renderTemplate(
      templateFor("instant"),
      { value: instant },
      { timeZone: "UTC" },
    ).body;
    expect(monterrey).not.toBe(utc);
    expect(monterrey).toContain("2026");
    expect(accepts("instant", new Date("not a date"))).toBe(false);
    expect(accepts("instant", "2026-09-07T21:30:00Z")).toBe(false);
  });

  it("refuses an instant with no zone rather than guessing one", () => {
    expect(() =>
      renderTemplate(templateFor("instant"), { value: new Date() }),
    ).toThrow(CopyError);
  });

  it("never reads a rendered value as a second hole", () => {
    // A caller who controls one slot must not be able to reach another. The
    // renderer parses the TEMPLATE into segments and joins them, so a value
    // that looks like a hole is text — the reason it is not a `replace`.
    const rendered = renderTemplate(
      {
        key: "test.injection",
        subject: "Prueba",
        body: "uno {a} dos {b}",
        slots: { a: "text", b: "text" },
      },
      { a: "{b}", b: "seguro" },
    );
    expect(rendered.body).toBe("uno {b} dos seguro");
  });
});

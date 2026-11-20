/**
 * The renderer's contract: a template renders only from a complete, typed
 * slot set (ticket #219 AC 1; spec #214 decision 13; ADR-0022).
 */
import { describe, expect, it } from "vitest";
import { CopyError, renderTemplate, type CopyTemplate } from "./index.js";

/**
 * A fixture template, not a shipped one.
 *
 * The shipped templates are notify's two, and their own suite reads them
 * from the registry. A rule about slots needs shapes no product message
 * has — a `count`, an `instant`, a missing hole — and inventing them here
 * keeps the catalog honest about what Dito actually sends.
 */
const GREETING: CopyTemplate = {
  key: "test.greeting",
  subject: "Hola {name}",
  body: "Entra en {url}.",
  slots: { name: "name", url: "url" },
};

describe("renderTemplate (ticket #219 AC 1)", () => {
  it("renders a complete, typed slot set into subject and body", () => {
    expect(
      renderTemplate(GREETING, {
        name: "Mauricio Torres",
        url: "https://dito.test/invitacion/abc",
      }),
    ).toEqual({
      subject: "Hola Mauricio Torres",
      body: "Entra en https://dito.test/invitacion/abc.",
    });
  });

  it("refuses a slot set missing a declared slot", () => {
    expect(() => renderTemplate(GREETING, { name: "Mauricio Torres" })).toThrow(
      CopyError,
    );
  });

  it("refuses a value the slot's type does not accept", () => {
    expect(() =>
      renderTemplate(GREETING, {
        name: "Mauricio Torres",
        url: "javascript:alert(1)",
      }),
    ).toThrow(CopyError);
  });

  it("refuses a slot nobody declared, rather than ignoring it", () => {
    // A caller passing a value the template has no hole for is a caller
    // whose message is not the one it thinks it is sending.
    expect(() =>
      renderTemplate(GREETING, {
        name: "Mauricio Torres",
        url: "https://dito.test/invitacion/abc",
        code: "123456",
      }),
    ).toThrow(CopyError);
  });
});

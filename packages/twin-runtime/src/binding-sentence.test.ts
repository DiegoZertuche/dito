/**
 * THE BINDING QUESTION'S SENTENCE (tickets #34, #172, #363): the one rule
 * drafting's `create_draft` and the thread's `propose_binding` hold the
 * twin's sentence to.
 */
import { describe, expect, it } from "vitest";
import { bindingSentenceViolation } from "./binding-sentence.js";

describe("the binding question's sentence", () => {
  it("accepts one sentence carrying the name as a slot exactly once", () => {
    expect(bindingSentenceViolation("¿Este chat es de {name}?", "Ferretería Garza")).toBeUndefined();
  });

  it("refuses the name typed, with or without its accents", () => {
    expect(bindingSentenceViolation("¿Este chat es de {name}, Ferreteria Garza?", "Ferretería Garza")).toContain(
      "types the name",
    );
  });

  it("refuses a sentence with no slot, or with two", () => {
    expect(bindingSentenceViolation("¿Este chat es de ella?", "Ferretería Garza")).toContain("0 time(s)");
    expect(bindingSentenceViolation("¿{name} o {name}?", "Ferretería Garza")).toContain("2 time(s)");
  });

  it("refuses a second sentence beside the question", () => {
    expect(bindingSentenceViolation("Pidió 40 cajas. ¿Es de {name}?", "Ferretería Garza")).toContain("one sentence");
  });

  it("refuses an empty sentence", () => {
    expect(bindingSentenceViolation("  ", "Ferretería Garza")).toContain("in words");
  });
});

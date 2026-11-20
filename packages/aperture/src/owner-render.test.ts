/**
 * How a fact reads on an owner surface (ticket #129).
 *
 * Every expectation below is a LITERAL sentence, never a recomputation of
 * what the renderer does — the point of these tests is that a change to a
 * rendered sentence is a change somebody has to look at. The `Intl` output
 * is pinned for the same reason a deparsed view definition is: a locale
 * data change that moves «sábado 29 de agosto de 2026» is a change to what
 * an owner reads, and it should be loud.
 *
 * The rows are hand-built here rather than seeded, because the seam these
 * cover is the renderer's own — the Postgres seam's version of the same
 * claims is `owner-reads.int.test.ts`, where the payloads come from the
 * real aperture.
 */
import { describe, expect, it } from "vitest";
import type { OwnerFact } from "./owner-reads.js";
import {
  renderOwnerConfidence,
  renderOwnerEntityKind,
  renderOwnerEntityName,
  renderOwnerFact,
  renderOwnerFactLine,
  renderOwnerFactTypeLabel,
  renderOwnerInstant,
  renderOwnerSeat,
  renderOwnerSourceType,
} from "./owner-render.js";

const OCCURRED = new Date("2026-09-01T23:30:00Z");
const FILED = new Date("2026-09-02T00:10:00Z");
const ZONE = "America/Monterrey";

function fact(
  factType: string,
  payload: Record<string, unknown>,
  overrides: Partial<OwnerFact> = {},
): OwnerFact {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    entityId: "22222222-2222-4222-8222-222222222222",
    factType,
    payloadVersion: 1,
    payload,
    occurredAt: OCCURRED,
    filedAt: FILED,
    confidence: 0.95,
    sourceType: "extraction",
    filedBySeatId: "33333333-3333-4333-8333-333333333333",
    filedBySeatName: "Mauricio Cantú",
    ...overrides,
  };
}

describe("the fact line", () => {
  it("renders a quote with its price and states the two fields nobody recorded", () => {
    expect(
      renderOwnerFactLine(
        fact("QuoteGiven", { item: "cajas", amount: 4500, currency: "MXN" }),
      ),
    ).toBe("Cotización dada: cajas · sin cantidad · 4,500 MXN · sin fecha");
  });

  it("renders a counted order with its unit", () => {
    expect(
      renderOwnerFactLine(
        fact("OrderRequested", {
          item: "mortero",
          quantity: 40,
          unit: "bultos",
        }),
      ),
    ).toBe("Pedido solicitado: 40 bultos de mortero · sin precio · sin fecha");
  });

  it("never renders a currency as a symbol", () => {
    // The aperture stores ISO 4217 and refuses an amount without one; «$»
    // means a different thing in half the countries that use it.
    const line = renderOwnerFactLine(
      fact("QuoteGiven", { item: "cajas", amount: 4500, currency: "USD" }),
    );
    expect(line).toContain("4,500 USD");
    expect(line).not.toContain("$");
  });

  it("states a missing currency rather than dropping the number it denominates", () => {
    // ADR-0034's own example: «a missing currency on a 2026 quote is
    // unknown, not USD». The aperture refuses the pair at filing, so this
    // is a shape the renderer cannot lie about rather than one it expects.
    expect(
      renderOwnerFactLine(fact("QuoteGiven", { item: "cajas", amount: 4500 })),
    ).toBe("Cotización dada: cajas · sin cantidad · 4,500 sin moneda · sin fecha");
  });

  it("shows an OrderTaken's agreement, quoted", () => {
    expect(
      renderOwnerFactLine(
        fact("OrderTaken", {
          item: "cajas",
          quantity: 100,
          amount: 52800,
          currency: "MXN",
          agreement: "va, se los mando el lunes",
        }),
      ),
    ).toBe(
      "Pedido tomado: 100 cajas · 52,800 MXN · sin fecha — acuerdo: «va, se los mando el lunes»",
    );
  });

  it("shows the gesture beside the words it was placed on", () => {
    expect(
      renderOwnerFactLine(
        fact("OrderTaken", {
          item: "bultos",
          quantity: 20,
          agreement: "¿me mandas 20 bultos?",
          agreementGesture: "👍",
        }),
      ),
    ).toBe(
      "Pedido tomado: 20 bultos · sin precio · sin fecha — acuerdo: «¿me mandas 20 bultos?» 👍",
    );
  });

  it("renders a retired OrderTaken stamp without its agreement rather than crashing", () => {
    // `OrderTaken:1` and `:2` are retired and rows carrying them may still
    // exist. ADR-0034: the Ledger must stay readable for as long as it is
    // kept, so an old row renders what it has.
    expect(
      renderOwnerFactLine(
        fact(
          "OrderTaken",
          { item: "cajas", quantity: 100 },
          { payloadVersion: 2 },
        ),
      ),
    ).toBe("Pedido tomado: 100 cajas · sin precio · sin fecha");
  });

  it("renders a promised date as a calendar day", () => {
    expect(
      renderOwnerFactLine(
        fact("DatePromised", {
          commitment: "entrega de cajas",
          dueOn: "2026-08-29",
        }),
      ),
    ).toBe("Fecha prometida: entrega de cajas · sábado 29 de agosto de 2026");
  });

  it("states a promise with no day rather than inventing one", () => {
    expect(
      renderOwnerFactLine(
        fact("DatePromised", { commitment: "entrega de cajas" }),
      ),
    ).toBe("Fecha prometida: entrega de cajas · sin fecha");
  });

  it("says a contact's email and tax id, and never the number", () => {
    // ADR-0004 names a chat, a NUMBER, a group and what was said. An email
    // and an RFC are none of those and are what #129 means by "rendered
    // from their payloads"; the phone is the one value that stays a kind.
    const line = renderOwnerFactLine(
      fact("ContactEstablished", {
        identifiers: {
          phones: ["+528180001111"],
          emails: ["ana@ferreteria.mx"],
          rfcs: [],
        },
      }),
    );
    expect(line).toBe("Contacto registrado: teléfono · correo: ana@ferreteria.mx");
    expect(line).not.toContain("528180001111");
  });

  it("redacts a value that is itself a WhatsApp address", () => {
    const line = renderOwnerFactLine(
      fact("ContactEstablished", {
        identifiers: { phones: [], emails: ["5215550001@s.whatsapp.net"], rfcs: [] },
      }),
    );
    expect(line).toBe("Contacto registrado: correo: (dirección omitida)");
  });

  it("carries the contact's own name and role, which are business fields", () => {
    expect(
      renderOwnerFactLine(
        fact("ContactEstablished", {
          contactName: "Ana",
          role: "compras",
          identifiers: { phones: [], emails: [], rfcs: ["FUE930101AB1"] },
        }),
      ),
    ).toBe("Contacto registrado: Ana, compras · RFC: FUE930101AB1");
  });

  it("keeps a recorded unit that has no quantity to modify", () => {
    expect(
      renderOwnerFactLine(
        fact("OrderRequested", { item: "mortero", unit: "bultos" }),
      ),
    ).toBe(
      "Pedido solicitado: mortero · unidad: bultos · sin cantidad · sin precio · sin fecha",
    );
  });

  it("redacts a third party's number from a fact's own words", () => {
    // ADR-0038 says an `OrderTaken` carries the rep's whole message; ADR-0004
    // says a number never reaches an owner surface. The aperture refuses the
    // counterparty's OWN number and cannot refuse a third party's, so the
    // sentence crosses and the number in it does not.
    expect(
      renderOwnerFactLine(
        fact("OrderTaken", {
          item: "cajas",
          quantity: 20,
          agreement: "va, coordina con Juan al 81 1234 5678",
        }),
      ),
    ).toBe(
      "Pedido tomado: 20 cajas · sin precio · sin fecha — acuerdo: «va, coordina con Juan al (número omitido)»",
    );
  });

  it("refuses a customer name written in digits no `\\D` can see (Codex r3)", () => {
    // A customer sets their own push name, which is where this column's
    // value comes from — and `\D` is ASCII-only, so a name in full-width or
    // Arabic-Indic digits had zero digits by the old rule and came back
    // verbatim, into a tool result and a rendered turn.
    for (const written of ["５２１５５５００００１", "٥٢١٥٥٥٠٠٠٠١"]) {
      expect(renderOwnerEntityName(written), written).toBe(
        "Cliente sin nombre legible",
      );
    }
    // ...and a name that merely contains a few digits is still a name.
    expect(renderOwnerEntityName("Aceros 3000")).toBe("Aceros 3000");
  });

  it("redacts a number however a person punctuated it (ticket #130, Codex r1)", () => {
    // THE SEPARATOR SET WAS A HAND-LISTED FOUR — whitespace, dot,
    // parenthesis, hyphen — and a slash is how half the world writes a
    // phone number. Any Unicode separator, punctuation or symbol counts
    // now, because there was no reason to enumerate the other half.
    for (const written of [
      "81/1234/5678",
      "81·1234·5678",
      "81_1234_5678",
      "+52 55 1234 5678",
    ]) {
      expect(
        renderOwnerFactLine(
          fact("OrderTaken", {
            item: "cajas",
            quantity: 20,
            agreement: `va, coordina con Juan al ${written}`,
          }),
        ),
        written,
      ).toContain("(número omitido)");
    }
  });

  it("leaves arithmetic alone: a sentence full of numbers is not a phone number", () => {
    expect(
      renderOwnerFactLine(
        fact("CustomerPattern", {
          pattern: "pide 100 cajas a 52,800 el 29 de agosto de 2026",
        }),
      ),
    ).toBe(
      "Patrón del cliente: pide 100 cajas a 52,800 el 29 de agosto de 2026",
    );
  });

  it("renders a CustomerPattern's composed clause and nothing else", () => {
    // ADR-0040: nothing verbatim from the conversation is in the payload,
    // so the clause IS the fact.
    expect(
      renderOwnerFactLine(
        fact("CustomerPattern", {
          pattern: "solo recibe material antes de las 2 de la tarde",
        }),
      ),
    ).toBe(
      "Patrón del cliente: solo recibe material antes de las 2 de la tarde",
    );
  });

  it("renders a recorded zero as a zero, never as an absence", () => {
    // ADR-0034's two states a bi-temporal store must not conflate. The
    // aperture's shaper refuses a non-positive quantity at filing, so this
    // cannot arrive today — and the renderer's job is what a stored value
    // READS as, not what the writer would have accepted.
    expect(
      renderOwnerFactLine(
        fact("OrderRequested", { item: "cajas", quantity: 0 }),
      ),
    ).toBe("Pedido solicitado: 0 cajas · sin precio · sin fecha");
  });

  it("names a fact type it does not know rather than failing on it", () => {
    expect(renderOwnerFactLine(fact("SomethingLater", {}))).toBe(
      "SomethingLater: sin detalle",
    );
  });

  it("refuses to say a customer name that is a number or a WhatsApp address", () => {
    // ADR-0004. `ledger.entities.display_name` has no write-time fence —
    // `seats.rep_display_name` has exactly this CHECK and this column does
    // not — and production proposes the name off a push name the customer
    // sets. The surface is what stops it being said.
    for (const poisoned of [
      "5215550001",
      "5215550001@s.whatsapp.net",
      "120363000000000000@g.us",
      "Ana 5215550001",
    ]) {
      expect(renderOwnerEntityName(poisoned)).toBe("Cliente sin nombre legible");
    }
  });

  it("refuses a formatted number, which has no ten-digit run in it", () => {
    // The shape the first guard missed (Codex r2): «+52 (55) 1234-5678» is
    // a phone number and carries no run of ten digits. The rule is
    // `seats.rep_display_name`'s CHECK — ten digits once every non-digit is
    // stripped — so the two free-text values an owner reads refuse the same
    // shapes.
    for (const poisoned of [
      "+52 (55) 1234-5678",
      "81 1234 5678",
      "52.55.1234.5678",
      "Ferretería +52 55 1234 5678",
    ]) {
      expect(renderOwnerEntityName(poisoned)).toBe("Cliente sin nombre legible");
    }
  });

  it("says an ordinary name with digits in it, because a name is not a number", () => {
    for (const fine of ["Aceros 3000", "Ferretería Fuentes", "Torres Hnos."]) {
      expect(renderOwnerEntityName(fine)).toBe(fine);
    }
  });

  it("labels the two entity kinds, and names an unknown one", () => {
    expect(["person", "business", "cooperativa"].map(renderOwnerEntityKind)).toEqual([
      "Persona",
      "Negocio",
      "cooperativa",
    ]);
  });

  it("labels the six types", () => {
    expect(
      [
        "QuoteGiven",
        "OrderRequested",
        "OrderTaken",
        "DatePromised",
        "ContactEstablished",
        "CustomerPattern",
      ].map(renderOwnerFactTypeLabel),
    ).toEqual([
      "Cotización dada",
      "Pedido solicitado",
      "Pedido tomado",
      "Fecha prometida",
      "Contacto registrado",
      "Patrón del cliente",
    ]);
  });
});

describe("provenance", () => {
  it("shows the stored confidence as a number, never as a band", () => {
    // No alta/media/baja exists anywhere in this system; a boundary drawn
    // at render time would read as a measurement nobody made.
    expect(renderOwnerConfidence(0.95)).toBe("confianza 95%");
    expect(renderOwnerConfidence(0.955)).toBe("confianza 95.5%");
    expect(renderOwnerConfidence(1)).toBe("confianza 100%");
  });

  it("says so when no confidence was recorded", () => {
    expect(renderOwnerConfidence(null)).toBe("confianza no registrada");
  });

  it("names the source in words rather than in the column's enum", () => {
    expect(renderOwnerSourceType("extraction")).toBe("Conversación");
    expect(renderOwnerSourceType("rep_act")).toBe("Acto del rep");
  });

  it("names the seat, and says so when a fact was filed under none", () => {
    expect(renderOwnerSeat("Mauricio Cantú")).toBe("Mauricio Cantú");
    expect(renderOwnerSeat(null)).toBe("asiento no registrado");
  });

  it("renders an instant in the zone it was given", () => {
    expect(renderOwnerInstant(OCCURRED, ZONE)).toBe(
      "1 de septiembre de 2026 a las 5:30 p.m.",
    );
    // The same instant, two zones, two days — which is why the zone is a
    // parameter and not a constant.
    expect(renderOwnerInstant(OCCURRED, "UTC")).toBe(
      "1 de septiembre de 2026 a las 11:30 p.m.",
    );
  });

  it("puts the five elements together in ADR-0004's order", () => {
    const rendered = renderOwnerFact(
      fact("QuoteGiven", { item: "cajas", amount: 4500, currency: "MXN" }),
      ZONE,
    );
    expect(rendered).toEqual({
      typeLabel: "Cotización dada",
      line: "Cotización dada: cajas · sin cantidad · 4,500 MXN · sin fecha",
      provenance: {
        occurred: "1 de septiembre de 2026 a las 5:30 p.m.",
        filed: "1 de septiembre de 2026 a las 6:10 p.m.",
        confidence: "confianza 95%",
        sourceType: "Conversación",
        seat: "Mauricio Cantú",
      },
    });
  });
});

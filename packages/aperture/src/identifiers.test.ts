/**
 * The merge match keys, normalized at the aperture (ticket #52; spec #48
 * grilling decision 6; ADR-0034, ADR-0035).
 *
 * These are the values ADR-0035's merge ladder compares, and ADR-0034
 * forbids restructuring what is already stored — so the shape and the
 * normalization have to be right in the first row ever written. That is
 * what this suite pins.
 */
import { describe, expect, it } from "vitest";
import {
  containsChatOwnNumber,
  isChatOwnNumber,
  normalizeEmail,
  normalizeIdentifiers,
  normalizePhone,
  normalizeRfc,
} from "./identifiers.js";

describe("normalized merge keys (ADR-0035)", () => {
  describe("phones — E.164, or nothing", () => {
    it("normalizes a Mexican national number written the way a person types it", () => {
      expect(normalizePhone("55 1234 5678")).toBe("+525512345678");
      expect(normalizePhone("(55) 1234-5678")).toBe("+525512345678");
      expect(normalizePhone("5512345678")).toBe("+525512345678");
    });

    it("keeps an already-international number as it stands", () => {
      expect(normalizePhone("+52 55 1234 5678")).toBe("+525512345678");
      expect(normalizePhone("+1 415 555 0123")).toBe("+14155550123");
      expect(normalizePhone("0052 55 1234 5678")).toBe("+525512345678");
    });

    it("collapses Mexico's historical mobile 1, so one phone is one merge key", () => {
      // «+52 1 55 …» and «+52 55 …» are the same subscriber; the 1 is a
      // legacy mobile prefix WhatsApp's addressing still carries. Two
      // spellings would be two IMMUTABLE keys, and ADR-0035's ladder would
      // simply miss the merge (Codex r3).
      expect(normalizePhone("+52 1 55 1234 5678")).toBe("+525512345678");
      expect(normalizePhone("5215512345678")).toBe("+525512345678");
      // ...and the 1 means something else outside Mexico: untouched.
      expect(normalizePhone("+1 415 555 0123")).toBe("+14155550123");
    });

    it("refuses anything it cannot place, rather than storing a guess", () => {
      // Precision over recall (FR-31): a half-dialled number stored as a
      // match key merges two customers who are not one.
      expect(normalizePhone("1234")).toBeUndefined();
      expect(normalizePhone("")).toBeUndefined();
      expect(normalizePhone("ext. 204")).toBeUndefined();
      expect(normalizePhone("+")).toBeUndefined();
      expect(normalizePhone("+9999999999999999999")).toBeUndefined();
    });

    it("refuses a number of ten identical digits — the placeholder class the generic RFC belongs to", () => {
      // These normalize perfectly and identify nobody. `0000000000` is what
      // a form gets when there is no number to give; `55 5555 5555` is the
      // dummy every price list in this market prints. ADR-0035's ladder
      // would merge every customer carrying one, and ADR-0034 forbids
      // restructuring the payloads that recorded it (ticket #55, Codex r1).
      expect(normalizePhone("0000000000")).toBeUndefined();
      expect(normalizePhone("55 5555 5555")).toBeUndefined();
      expect(normalizePhone("+52 555 555 5555")).toBeUndefined();
      expect(normalizePhone("1111111111")).toBeUndefined();
      // ...and a real number that merely repeats a digit is untouched.
      expect(normalizePhone("55 5555 1234")).toBe("+525555551234");
    });
  });

  describe("emails — lowercased", () => {
    it("lowercases and trims", () => {
      expect(normalizeEmail("  Ana.Fuentes@Ferreteria.MX ")).toBe(
        "ana.fuentes@ferreteria.mx",
      );
    });

    it("refuses anything that is not an address", () => {
      expect(normalizeEmail("ana at ferreteria")).toBeUndefined();
      expect(normalizeEmail("@ferreteria.mx")).toBeUndefined();
      expect(normalizeEmail("ana@ferreteria")).toBeUndefined();
      expect(normalizeEmail("")).toBeUndefined();
    });

    it("refuses the domains the IETF reserved so no real address is in them", () => {
      // `unknown@example.com` is what a model produces from «no tengo su
      // correo», and RFC 2606/6761 guarantee nobody's real mailbox is
      // there — so any number of unrelated customers can carry it, which is
      // the generic RFC's failure in another arm (ticket #55, Codex r1).
      expect(normalizeEmail("unknown@example.com")).toBeUndefined();
      expect(normalizeEmail("Ventas@Example.ORG")).toBeUndefined();
      expect(normalizeEmail("ana@ferreteria.invalid")).toBeUndefined();
      expect(normalizeEmail("ana@correo.test")).toBeUndefined();
      // ...and a real domain that merely starts the same way is untouched.
      expect(normalizeEmail("ana@example-ferreteria.mx")).toBe(
        "ana@example-ferreteria.mx",
      );
    });
  });

  describe("RFCs — uppercased", () => {
    it("uppercases and strips the separators people write", () => {
      expect(normalizeRfc("fue930101-ab1")).toBe("FUE930101AB1");
      expect(normalizeRfc("gsa 850101 mn4")).toBe("GSA850101MN4");
    });

    it("refuses the SAT's generic placeholders — a value thousands of customers share is the worst possible merge key", () => {
      // ADR-0035 merges two entities on a shared RFC, deterministically and
      // without asking anyone. XAXX010101000 is what an invoice carries
      // when the customer has no RFC; XEXX010101000 is its foreign
      // equivalent. Storing either would fuse unrelated customers, and
      // ADR-0034 forbids restructuring the payload that did it.
      expect(normalizeRfc("XAXX010101000")).toBeUndefined();
      expect(normalizeRfc("xexx 010101 000")).toBeUndefined();
    });

    it("refuses anything that is not RFC-shaped", () => {
      expect(normalizeRfc("930101")).toBeUndefined();
      expect(normalizeRfc("FUENTES")).toBeUndefined();
      expect(normalizeRfc("")).toBeUndefined();
    });
  });

  describe("the identifier block a ContactEstablished payload carries", () => {
    it("is structured, multi-valued and de-duplicated, with every arm present", () => {
      expect(
        normalizeIdentifiers({
          phones: ["55 1234 5678", "+525512345678", "no sé"],
          emails: ["Ana@Ferreteria.MX", "ana@ferreteria.mx"],
          rfcs: ["fue930101ab1"],
        }),
      ).toEqual({
        phones: ["+525512345678"],
        emails: ["ana@ferreteria.mx"],
        rfcs: ["FUE930101AB1"],
      });
    });

    it("keeps every arm present and empty rather than absent — an absent field means NOT RECORDED (ADR-0034)", () => {
      expect(normalizeIdentifiers({})).toEqual({
        phones: [],
        emails: [],
        rfcs: [],
      });
    });
  });

  describe("the chat's own number is chat identity, not a business fact (ADR-0004)", () => {
    it("recognizes the counterparty's own WhatsApp address, however it is written", () => {
      expect(
        isChatOwnNumber("+525512345678", "5215512345678@s.whatsapp.net"),
      ).toBe(true);
      expect(
        isChatOwnNumber("+525512345678", "525512345678@s.whatsapp.net"),
      ).toBe(true);
    });

    it("leaves a genuinely different number alone", () => {
      expect(
        isChatOwnNumber("+525599990000", "5215512345678@s.whatsapp.net"),
      ).toBe(false);
    });

    it("finds the number inside prose, wherever it sits — a suffix test walks past an extension", () => {
      const chat = "5215512345678@s.whatsapp.net";
      expect(
        containsChatOwnNumber("que entregas al 55 1234 5678 ext. 204", chat),
      ).toBe(true);
      expect(
        containsChatOwnNumber("(55) 1234-5678 el 30 de agosto", chat),
      ).toBe(true);
      expect(containsChatOwnNumber("que entregas el sábado", chat)).toBe(false);
      expect(
        containsChatOwnNumber("al 55 9999 0000 ext. 204", chat),
      ).toBe(false);
    });
  });
});

/**
 * THE THREAD'S GUARD (tickets #173, #321; spec #171 decision 21; spec #318
 * decision 18).
 *
 * "The guard is the owner twin's mechanism at the rep side's strictness":
 * digits are *not* refused — the rep side has no wall to protect and a draft
 * body legitimately carries quantities. A customer is
 * named by their stable reference, and the one check left on a reference is
 * that it names a row (ticket #321): nothing here matches the twin's words
 * against what tells two chats apart.
 *
 * A PURE FUNCTION OVER LITERALS, which is the whole reason this suite is a
 * unit test: every rule below is a property of the SHAPE of the twin's line —
 * its final words (ticket #363) — against what a run served and the
 * customers its references name, so it can be shown to bite against a
 * synthetic offender with no model, no database and no execution.
 */
import { describe, expect, it } from "vitest";
import { RECEIPTS, RUN_REPORTS } from "../grammar.js";
import { threadWordsRule, wordsViolations, type TurnFacts } from "./guard.js";
import { threadDeps } from "../testing/thread-deps.js";
import { ActSlot } from "./acts.js";
import { ServedHits } from "./served.js";
import type { Customer, Customers } from "./references.js";
import type {
  ServedAnswerState,
  ServedHit,
  ServedUnconfirmedChat,
} from "./served.js";

function hit(
  ref: number,
  counterparty = "Sra. Garza",
  chatJid = "5215550001@s.whatsapp.net",
  customer?: number,
): ServedHit {
  return {
    ref,
    chatJid,
    messageId: `M-${String(ref)}`,
    counterparty,
    ...(customer === undefined ? {} : { customer }),
    fromMe: false,
    occurredAt: "2026-09-04T18:00:00.000Z",
    content: "necesito 40 cajas para el jueves",
  };
}

/** A customer the rep confirmed, with their chats' tails. */
function confirmed(reference: number, name: string, tails: readonly string[] = ["0001"]): Customer {
  return {
    reference,
    entityId: `E-${String(reference)}`,
    name,
    shown: name,
    chats: tails.map((tail) => ({ chatJid: `521555${tail}@s.whatsapp.net`, tail })),
    anchors: [],
  };
}

/** A chat nobody has confirmed, named by the push-name the phone offered. */
function provisional(
  reference: number,
  pushName: string,
  chatJid = `52155500${String(reference).padStart(2, "0")}@s.whatsapp.net`,
): Customer {
  return {
    reference,
    name: pushName,
    shown: `${pushName} (sin confirmar)`,
    chats: [{ chatJid }],
    anchors: [`M-${String(reference)}`],
  };
}

function served(
  options: {
    readonly hits?: readonly ServedHit[];
    readonly customers?: readonly Customer[];
    readonly unconfirmed?: readonly ServedUnconfirmedChat[];
  } = {},
): ServedAnswerState {
  const hits = options.hits ?? [];
  const byReference = new Map(
    (options.customers ?? []).map((customer) => [customer.reference, customer] as const),
  );
  const customers: Customers = (reference) => byReference.get(reference);
  return {
    hits: new Map(hits.map((h) => [h.ref, h])),
    unconfirmed: new Map((options.unconfirmed ?? []).map((c) => [c.reference, c])),
    customers,
    grounds: [],
  };
}

/** A line the rep asked about «la Sra. Garza», with this suite's default turn: somebody wrote it. */
function guarded(
  words: string,
  served: ServedAnswerState,
  turn: Partial<TurnFacts> = {},
): readonly string[] {
  return wordsViolations(words, served, { unasked: false, ...turn });
}

const GARZA = confirmed(7, "Sra. Garza");
const TORRES = confirmed(8, "Torres", ["8416", "0537"]);

describe("a silence is never refused (spec #171 decision 25)", () => {
  it("passes whatever the run searched: the twin wrote nothing", () => {
    for (const nothing of ["", "   ", "\n\n"]) {
      expect(guarded(nothing, served()), JSON.stringify(nothing)).toEqual([]);
      expect(guarded(nothing, served({ hits: [hit(1)] }))).toEqual([]);
    }
  });

  it("refuses a line that is nothing but references", () => {
    expect(guarded("[c7]", served({ hits: [hit(1)], customers: [GARZA] }))).toHaveLength(1);
  });
});

describe("a customer is named by a reference that names a row — the one check left (ticket #321)", () => {
  it("accepts references to customers the bundle holds", () => {
    expect(guarded("[c7] y [c8] te pidieron lo mismo.", served({ hits: [hit(1)], customers: [GARZA, TORRES] }))).toEqual([]);
  });

  it("sends back a reference that names no customer, saying what to do", () => {
    expect(guarded("[c12] te pidió 40 cajas.", served({ hits: [hit(1)], customers: [GARZA] }))).toEqual([
      expect.stringContaining("carries [c12], which names no customer"),
    ]);
  });

  it("reads every reference, not just the first", () => {
    expect(guarded("[c7] y [c9] preguntaron lo mismo.", served({ hits: [hit(1)], customers: [GARZA] }))).toEqual([
      expect.stringContaining("[c9]"),
    ]);
  });

  it("checks nothing about WHICH customer a reference picked: two of one name are two references", () => {
    const juan = confirmed(9, "Torres");
    expect(guarded("Le escribo a [c9], el de la ferretería.", served({ hits: [hit(1)], customers: [TORRES, juan] }))).toEqual([]);
  });
});

describe("what a line rests on is the twin's (Diego, 2026-11-18, #404)", () => {
  it("accepts an answer from a turn that looked nothing up", () => {
    expect(guarded("De nada, aquí ando.", served())).toEqual([]);
    expect(guarded("No encontré nada de eso.", served())).toEqual([]);
  });

  it("accepts a choice between customers with no lookup behind it", () => {
    expect(guarded("¿[c8] o [c9]?", served({ customers: [TORRES, confirmed(9, "Juan Torres")] }))).toEqual([]);
  });

  it("is the same through the rule the model is handed: a turn with nothing served ends on its words", () => {
    const deps = threadDeps({ served: new ServedHits(() => undefined), acts: new ActSlot() });
    expect(threadWordsRule(deps)("Con gusto, cuando quieras.")).toBeUndefined();
  });

  it("asks nothing of a turn nobody wrote either (ticket #320)", () => {
    expect(guarded("Te dejé el borrador de [c7].", served({ customers: [GARZA] }), { unasked: true })).toEqual([]);
  });
});

/**
 * A RECEIPT IS CODE'S SENTENCE, AND PROSE MAY NOT WEAR IT (ticket #174,
 * Codex round 1; ADR-0037 as amended).
 *
 * The rep reads BYTES. «Descartado» typed into a line renders exactly what a real
 * dismissal's receipt renders, so a rep would believe their draft was
 * discarded while it sat there waiting.
 */
describe("prose may not wear a receipt code owns", () => {
  const STATE = served({ hits: [hit(1)] });

  it("refuses every sentence code posts as a receipt — including the refusals", () => {
    // EXHAUSTIVE OVER THE RENDERER'S OWN SET (Codex round 2), and past any
    // bound a list could have had.
    for (const phrase of [...RECEIPTS.every.fixed, RECEIPTS.retracted(3), RECEIPTS.retracted(201), RECEIPTS.retracted(99999)]) {
      expect(guarded(phrase, STATE), phrase).toHaveLength(1);
    }
  });

  it("refuses a run's four endings for any run, as code renders them (#358)", () => {
    for (const ending of [
      RUN_REPORTS.failed("Seguir a Sergio", 2, 3),
      RUN_REPORTS.budgetSpent("Hoteles en Madrid"),
      RUN_REPORTS.cancelled("Revisar lo de Sergio"),
      RUN_REPORTS.finished(""),
      RUN_REPORTS.failed("Revisar «Acme» hoy", 1, 2),
      RUN_REPORTS.budgetSpent("Revisar «Acme» hoy"),
      "Ya quedó: terminé «Hoteles en Madrid»",
    ]) {
      expect(guarded(ending, STATE), ending).toHaveLength(1);
    }
    // ...and leaves prose that only talks about a run.
    expect(guarded("Terminé de revisar lo de Sergio, todo bien.", STATE)).toEqual([]);
  });

  it("refuses one hidden inside a sentence, and one wearing WhatsApp formatting", () => {
    for (const forged of ["Ya está: Descartado.", "*Descartado*", "Des​cartado", "DESCARTADO"]) {
      expect(guarded(forged, STATE), forged).toHaveLength(1);
    }
  });

  it("refuses a receipt wearing different punctuation, or none (#276)", () => {
    for (const forged of [
      "Listo, lo anoté",
      "¡Listo, lo anoté!",
      "Listo, lo anoté…",
      "listo, lo anote",
      "Entendido, este chat sigue sin confirmar",
      "Listo, marqué el dato 3 como incorrecto",
    ]) {
      expect(guarded(forged, STATE), forged).toHaveLength(1);
    }
  });

  it("says nothing about prose that merely ends where a receipt begins (#276)", () => {
    expect(guarded("Listo, ya quedó con ella.", STATE)).toEqual([]);
  });

  it("refuses it whatever the turn did", () => {
    // Deliberate: code folds the real one in beside the line, so the model
    // loses nothing by not writing it.
    expect(guarded("Descartado", served())).toHaveLength(1);
  });

  it("says nothing about prose that merely talks about an act", () => {
    expect(guarded("Ya no le escribo, entonces.", STATE)).toEqual([]);
    expect(guarded("Le marqué el pedido como pendiente.", STATE)).toEqual([]);
  });

  it("covers the total refusal record, so a reason added far away joins by typecheck", () => {
    for (const reason of ["unknown_line", "not_a_fact", "window_closed"] as const) {
      expect(RECEIPTS.every.fixed).toContain(RECEIPTS.correctionRefused(reason));
    }
  });

  it("reads the phrases off the renderer, so the rule cannot drift from it", () => {
    const owned = RECEIPTS.every.fixed[0]!;
    const [only] = guarded(owned, STATE);
    expect(only).toContain(owned);
  });
});

describe("the rep side's strictness is NOT the owner side's (spec #171 decision 21)", () => {
  it("allows digits — a quantity in the rep's own thread is not a wall leak", () => {
    expect(guarded("Le pidió 40 cajas, y 15 el jueves.", served({ hits: [hit(1)] }))).toEqual([]);
  });

  it("allows calendar words — «el jueves» is what the rep asked about", () => {
    expect(guarded("Fue el jueves 4 de septiembre.", served({ hits: [hit(1)] }))).toEqual([]);
  });

  it("allows a name with no reference behind it — the twin echoing the rep is its own words", () => {
    expect(guarded("Don Beto le pidió 40 cajas.", served({ hits: [hit(1)], customers: [GARZA] }))).toEqual([]);
  });
});

describe("a name the reference already gives is never typed beside it (ADR-0037 as amended; ticket #321)", () => {
  const STATE = served({ hits: [hit(1)], customers: [GARZA, TORRES, provisional(5, "Laura")] });

  it("refuses the name of a reference the line carries, and says to write only the reference", () => {
    expect(guarded("[c7] Sra. Garza le pidió 40 cajas.", STATE)).toEqual([
      expect.stringContaining('types the name "Sra. Garza" beside the reference'),
    ]);
  });

  it("refuses it anywhere in the line, folding case, accents and punctuation as a person types", () => {
    for (const typed of [
      "[c7] te escribió. sra garza quiere 40 cajas.",
      "[c7] te escribió; SRA. GARZA quiere 40.",
      "[c7] te escribió, *Sra. Garza* quiere 40.",
    ]) {
      expect(guarded(typed, STATE), typed).toHaveLength(1);
    }
  });

  it("refuses the bare name of a chat nobody confirmed — typed, it would read as confirmed", () => {
    expect(guarded("[c5] escribió; Laura quiere cajas.", STATE)).toEqual([expect.stringContaining('"Laura"')]);
  });

  it("says nothing about a name the line carries no reference for", () => {
    expect(guarded("[c7] y Torres pidieron lo mismo.", STATE)).toEqual([]);
  });

  it("does not fire on a word that merely contains a referenced name", () => {
    expect(guarded("[c8] mandó las torreras.", STATE)).toEqual([]);
  });
});

describe("every refusal is a sentence, and they accumulate", () => {
  it("names each thing wrong rather than stopping at the first", () => {
    const violations = guarded("Descartado [c9]", served());
    expect(violations.length).toBeGreaterThan(1);
    for (const violation of violations) {
      expect(violation.trim()).not.toBe("");
    }
  });

  it("is one refusal the model is handed, every sentence in it, and nothing for words it accepts (ticket #363)", () => {
    const deps = threadDeps({ served: new ServedHits(() => undefined), acts: new ActSlot() });
    const rule = threadWordsRule(deps);
    expect(rule("")).toBeUndefined();
    expect(rule("Descartado [c9]")?.split("; ").length).toBeGreaterThan(1);
  });
});

describe("a choice the rep can settle is the twin's words, its customers references (ADR-0039 as amended; ticket #363)", () => {
  const JUAN = confirmed(9, "Juan Torres");
  const STATE = served({ customers: [TORRES, JUAN, provisional(5, "Laura")] });

  it("accepts a question naming two confirmed customers", () => {
    expect(guarded("¿[c8] o [c9]?", STATE)).toEqual([]);
  });

  it("reads no question in the words, whoever it names: a sentence is never the binding question (Codex r1)", () => {
    // «¿[c8] o [c5]?» offers a conversation nobody confirmed, and «¿Le
    // escribo a [c5]?» asks something a «sí» answers — neither hands the rep
    // the binding question, which only `propose_binding` does.
    expect(guarded("¿[c8] o [c5]?", STATE)).toEqual([]);
    expect(guarded("¿Le escribo a [c5]?", STATE)).toEqual([]);
  });

  it("refuses a typed name and a forged receipt in an ask, like any line the rep reads", () => {
    expect(guarded("¿[c8] Torres o [c9]?", STATE)).toEqual([expect.stringContaining('types the name "Torres"')]);
    expect(guarded("Descartado. ¿[c8] o [c9]?", STATE)).toHaveLength(1);
  });
});


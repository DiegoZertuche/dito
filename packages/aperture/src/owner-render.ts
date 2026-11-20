/**
 * How a finalized fact reads on an owner surface (ticket #129; spec #126
 * decisions 7, 11 and 15; ADR-0034, ADR-0037 as amended, ADR-0038,
 * ADR-0040).
 *
 * NOTHING HERE IS A TWIN SPEAKING, which is what makes fixed strings
 * allowed. ADR-0037 as amended exempts the owner WEB — "nav, labels and the
 * lag statement are UI chrome" — and every sentence below is chrome in that
 * sense: a page rendering a stored row, not a colleague composing a
 * sentence. The room (#131) is the other case, and there the model composes
 * the prose while code renders the values; these functions are the code half
 * of that too, which is why they live beside `owner-reads.ts` rather than
 * inside one page.
 *
 * THE VOICE IS THIRD-PERSON AND IT IS NOT `renderFactDisclosureLine`'s.
 * The twin's disclosure line addresses the rep — «Le cotizaste…», «Te
 * pidió…» — and reads false on a page the rep never sees. The owner reads
 * about a company's record, so nothing here has a second person in it. The
 * package boundary says the same thing from the other side: `@dito/aperture`
 * cannot import `@dito/twin-runtime`, which depends on it, and an owner
 * surface must not carry the twin runtime's dependencies into its process
 * anyway (ADR-0002). Two small formatters are therefore restated here rather
 * than shared — an `Intl` number format and a calendar-date format — each
 * marked where it stands.
 *
 * ABSENT IS ABSENT (ADR-0034). A field the writer did not record renders as
 * a STATEMENT that it was not recorded — «sin precio» — and never as a
 * default. The three words are the aperture's own (`unstatedFields` on the
 * rep side), because a quote with no currency must not read as a quote in
 * pesos on either side of the wall.
 *
 * NO NUMBER, NO CHAT AND NO GROUP EVER REACHES A SENTENCE HERE. The one
 * payload that carries phone numbers is `ContactEstablished`, and this
 * module renders the identifier KINDS it holds and never a value —
 * «teléfono, correo y RFC» — because ADR-0004 puts which number a customer
 * gave on the wrong side of the wall. That is a deliberate omission of
 * stored data and the only one in this file.
 */
import type { OwnerFact } from "./owner-reads.js";

/**
 * The type tag at the head of a timeline entry, in the words
 * `key-owner-home.html` and the owner-room mock already use for the four
 * types they render; the two the mocks predate follow the same shape.
 */
export const OWNER_FACT_TYPE_LABELS: Readonly<Record<string, string>> = {
  QuoteGiven: "Cotización dada",
  OrderRequested: "Pedido solicitado",
  OrderTaken: "Pedido tomado",
  DatePromised: "Fecha prometida",
  ContactEstablished: "Contacto registrado",
  CustomerPattern: "Patrón del cliente",
};

/**
 * Where the content came from, in words rather than in the column's enum.
 *
 * `extraction` is «Conversación» — the word `key-owner-home.html` uses, and
 * the honest one: the twin read it in a customer conversation. It says the
 * KIND of source and never the source, which is the whole of what crosses
 * (ADR-0004). `rep_act` is «Acto del rep», the rep's own confirmation or
 * correction rather than something a model read.
 *
 * NOTHING WRITES `rep_act` TO `ledger.facts` TODAY, which is worth saying
 * out loud rather than discovering later: the column's CHECK allows it, the
 * answered-question path deliberately keeps its rows `extraction`
 * (`questions.ts`), and every class-2 rep act writes a table other than
 * `ledger.facts`. So the second label is unexercised by real data and is
 * here because the projection carries the column.
 */
export const OWNER_SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  extraction: "Conversación",
  rep_act: "Acto del rep",
};

/**
 * The two entity kinds, in the surface's words. `kind` exists for display
 * and for merge safety and changes no behaviour anywhere else (ADR-0035),
 * so the whole of what it is FOR on this side is this map.
 */
export const OWNER_ENTITY_KIND_LABELS: Readonly<Record<string, string>> = {
  person: "Persona",
  business: "Negocio",
};

/**
 * The identifier arms a `ContactEstablished` may carry, and whether their
 * VALUES may be said (Codex r2).
 *
 * A phone number is the one thing ADR-0004 names that a payload actually
 * holds, so `phones` renders as a kind and never as a value. An email and a
 * tax id are neither a chat, a number, a group nor what was said — they are
 * ordinary business facts about a customer the company owns the
 * relationship with — and #129 asks for six fact types "rendered from their
 * payloads". Hiding them was this module over-reading the wall; showing the
 * phone would be under-reading it.
 */
const IDENTIFIER_ARMS: readonly {
  readonly arm: string;
  readonly label: string;
  readonly showValues: boolean;
}[] = [
  { arm: "phones", label: "teléfono", showValues: false },
  { arm: "emails", label: "correo", showValues: true },
  { arm: "rfcs", label: "RFC", showValues: true },
];

/** One fact, ready for a timeline entry: nothing below is computed in JSX. */
export interface OwnerRenderedFact {
  readonly typeLabel: string;
  /** The fact itself, composed from its payload by code. */
  readonly line: string;
  /**
   * ADR-0004's five, in the order the spec fixes: when it happened · when
   * it was filed · confidence · source type · seat.
   */
  readonly provenance: {
    readonly occurred: string;
    readonly filed: string;
    readonly confidence: string;
    readonly sourceType: string;
    readonly seat: string;
  };
}

/** One fact and its provenance, in one call, so a page decides nothing. */
export function renderOwnerFact(
  fact: OwnerFact,
  timeZone: string,
): OwnerRenderedFact {
  return {
    typeLabel: renderOwnerFactTypeLabel(fact.factType),
    line: renderOwnerFactLine(fact),
    provenance: {
      occurred: renderOwnerInstant(fact.occurredAt, timeZone),
      filed: renderOwnerInstant(fact.filedAt, timeZone),
      confidence: renderOwnerConfidence(fact.confidence),
      sourceType: renderOwnerSourceType(fact.sourceType),
      seat: renderOwnerSeat(fact.filedBySeatName),
    },
  };
}

/**
 * The type tag. An unknown value renders as itself rather than throwing:
 * the fact type set is closed today, and a page that dies on a row it does
 * not recognise is a worse answer than a page that names it.
 */
export function renderOwnerFactTypeLabel(factType: string): string {
  return OWNER_FACT_TYPE_LABELS[factType] ?? factType;
}

/**
 * One line per fact, composed from the payload by code.
 *
 * A RETIRED PAYLOAD STAMP RENDERS, IT DOES NOT CRASH. `OrderTaken:1` and
 * `:2` are retired and rows carrying them may still exist; a fact filed
 * under one simply has no `agreement`, and every reader below treats a
 * field that is not there as not recorded. That is ADR-0034's rule and it
 * is also why this function never asserts a shape — the Ledger must stay
 * readable for as long as it is kept.
 */
export function renderOwnerFactLine(fact: OwnerFact): string {
  const label = renderOwnerFactTypeLabel(fact.factType);
  const payload = fact.payload;
  switch (fact.factType) {
    case "QuoteGiven":
    case "OrderRequested":
      return `${label}: ${commercialClause(payload)}`;
    case "OrderTaken":
      return `${label}: ${commercialClause(payload)}${agreementClause(payload)}`;
    case "DatePromised": {
      const commitment = textField(payload["commitment"]);
      const due = calendarDate(payload["dueOn"]);
      return dotted([
        `${label}: ${commitment ?? "sin detalle"}`,
        due ?? "sin fecha",
      ]);
    }
    case "ContactEstablished":
      return `${label}: ${contactClause(payload)}`;
    case "CustomerPattern":
      return `${label}: ${textField(payload["pattern"]) ?? "sin detalle"}`;
    default:
      return `${label}: sin detalle`;
  }
}

/**
 * A CUSTOMER'S NAME THAT IS NOT A WHATSAPP ADDRESS OR A PHONE NUMBER
 * (ADR-0004; Codex r1).
 *
 * `ledger.entities.display_name` is the one free-text value on the owner's
 * side that a person types, and its only store constraint is that it is not
 * blank. Production takes the name from what the rep confirmed at the
 * binding ceremony, proposed off the chat's PUSH NAME — a string a customer
 * sets, and can set to their own number or to a WhatsApp address. Nothing
 * refuses it at filing (`seats.rep_display_name` has exactly that CHECK;
 * this column does not), the finalized view passes it through unchanged, and
 * the page would render it. The Ledger wall sweep catches such a row in CI,
 * AFTER it crossed and after an owner could have read it.
 *
 * So the surface refuses to say it. Not a substitute for the fence at the
 * write path — that belongs where the filing path is owned, and it is
 * recorded on #129 — but a page that renders a number is the failure the
 * wall exists to prevent, and it is this module's to not commit.
 *
 * The rule is `seats.rep_display_name`'s, so the two sides of the seat/
 * customer pair refuse the same shapes: a WhatsApp address suffix, or a run
 * of ten or more digits. «Aceros 3000» is a name; «5215550001» is a number.
 */
export function renderOwnerEntityName(displayName: string): string {
  return isWallShapedName(displayName) ? "Cliente sin nombre legible" : displayName;
}

/**
 * An entity's kind, in words. An unknown value renders as itself for the
 * reason a fact type does: a page that dies on a row it does not recognise
 * is a worse answer than a page that names it.
 */
export function renderOwnerEntityKind(kind: string): string {
  return OWNER_ENTITY_KIND_LABELS[kind] ?? kind;
}

/**
 * `extraction` and `rep_act`, in words. An unknown value renders as itself
 * for the reason a type tag does, and never as the raw enum by accident.
 */
export function renderOwnerSourceType(sourceType: string): string {
  return OWNER_SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}

/**
 * The twin's confidence, as the stored number and not as a word.
 *
 * NO BUCKETING, DELIBERATELY. `key-owner-home.html` shows «confianza alta»
 * and «confianza media», and no such buckets exist anywhere in this system:
 * there is no threshold in code that separates them, and #66 measured the
 * distribution as bimodal, so any boundary drawn here would be invented at
 * render time and would read as a measurement. The stored value is shown
 * instead, as a percentage in tabular digits, and «alta / media / baja» is
 * recorded as a product call rather than guessed at.
 */
export function renderOwnerConfidence(confidence: number | null): string {
  if (confidence === null) return "confianza no registrada";
  return `confianza ${PERCENT.format(confidence)}`;
}

/**
 * The rep's display name, from `seats_status` (ADR-0004 as amended: the
 * seat, never the twin). Null is a fact filed by a twin with no seat row —
 * every fact filed before the registry existed is one — and it says so
 * rather than disappearing.
 */
export function renderOwnerSeat(displayName: string | null): string {
  return displayName ?? "asiento no registrado";
}

/**
 * An instant in the zone the surface was told to render in.
 *
 * THE ZONE IS THE CALLER'S BECAUSE THERE IS NO COMPANY ZONE. `companies`
 * carries id, display name and `shadow_lifted_at` and nothing else, so
 * nothing in the database can answer "what day was that for this owner".
 * The owner app takes it from its environment; the gap is recorded on the
 * ticket rather than papered over with a constant.
 */
export function renderOwnerInstant(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(at);
}

/**
 * The goods, the money and the wanted day of the three commercial types,
 * with a statement for each of the three that is not there.
 *
 * The absent-field words are `unstatedFields`' on the rep side and the same
 * three fields: quantity, price, day. `unit` is deliberately not among them
 * for the reason it is not there either — it modifies a quantity and says
 * nothing on its own.
 */
function commercialClause(payload: Readonly<Record<string, unknown>>): string {
  const item = textField(payload["item"]);
  const quantity = numberField(payload["quantity"]);
  const unit = textField(payload["unit"]);
  const amount = numberField(payload["amount"]);
  const currency = textField(payload["currency"]);
  const wanted = calendarDate(payload["requestedFor"]);

  // «40 bultos de mortero» when a unit modifies the count, «100 cajas» when
  // the item IS the unit. The `de` is what keeps the second reading from
  // producing «40 bultos mortero».
  const counted =
    quantity === undefined
      ? undefined
      : unit === undefined
        ? `${NUMBER.format(quantity)} ${item ?? ""}`.trim()
        : `${NUMBER.format(quantity)} ${unit} de ${item ?? "sin detalle"}`;
  const goods = counted ?? item ?? "sin detalle";
  // A RECORDED UNIT IS NEVER DROPPED (Codex r2). It modifies a quantity, so
  // with one it is inside the goods above; with none it has nowhere to sit
  // and used to vanish, which is a stored field the page did not show. It
  // gets its own slot instead. Its ABSENCE is still not stated, for the
  // reason `unstatedFields` leaves it out rep-side: a unit says nothing on
  // its own, so «sin unidad» would be a statement about nothing.
  const orphanUnit =
    quantity === undefined && unit !== undefined ? `unidad: ${unit}` : undefined;

  // ONE SLOT PER FIELD, filled with the value or with the statement that
  // there is none. Two slots for one field is how a line ends up rendering
  // no price and claiming none is missing — an amount with no currency
  // would have vanished silently, which is the exact case ADR-0034 names
  // («a missing currency on a 2026 quote is unknown, not USD»). The
  // aperture refuses that pair at filing, so this is a shape the renderer
  // cannot produce a lie about rather than a case it expects.
  return dotted([
    goods,
    orphanUnit,
    quantity === undefined ? "sin cantidad" : undefined,
    // The ISO code and never a symbol: the aperture stores ISO 4217, and a
    // symbol table would be a second source of truth for what «$» means in
    // a country that is not the only one using it.
    amount === undefined
      ? "sin precio"
      : `${NUMBER.format(amount)} ${currency ?? "sin moneda"}`,
    wanted === undefined ? "sin fecha" : `para el ${wanted}`,
  ]);
}

/**
 * The agreement an `OrderTaken` crossed with (ADR-0038).
 *
 * IT IS THE EVIDENCE, QUOTED, and the reason the type exists: an order the
 * business agreed to is a commitment somebody made, and the owner reads the
 * words it was made in rather than a claim that it was. The aperture
 * composes the field off the seam row — the rep's own message, or the
 * message a reaction was placed on — so the wording here names the
 * agreement and not a speaker: a gesture's evidence is the message that was
 * reacted TO, which is not always the same person as the seat below it.
 */
function agreementClause(payload: Readonly<Record<string, unknown>>): string {
  const agreement = textField(payload["agreement"]);
  if (agreement === undefined) return "";
  const gesture = textField(payload["agreementGesture"]);
  const quoted = ` — acuerdo: «${agreement}»`;
  return gesture === undefined ? quoted : `${quoted} ${gesture}`;
}

/**
 * WHAT KIND OF IDENTIFIER WAS RECORDED, NEVER WHICH ONE. A
 * `ContactEstablished` holds normalized phone numbers, and a number is the
 * one thing ADR-0004 names that a payload can actually carry — so the
 * values stay behind the wall and the owner is told that contact details
 * exist and of what kinds. `contactName` and `role` are ordinary business
 * fields and do cross: the aperture already refuses any payload string
 * containing a WhatsApp address or the counterparty's own number, so they
 * are swept before they are ever stored.
 */
function contactClause(payload: Readonly<Record<string, unknown>>): string {
  const identifiers = payload["identifiers"];
  const arms =
    typeof identifiers === "object" &&
    identifiers !== null &&
    !Array.isArray(identifiers)
      ? (identifiers as Record<string, unknown>)
      : {};
  const said = IDENTIFIER_ARMS.map(({ arm, label, showValues }) => {
    const values = Array.isArray(arms[arm])
      ? (arms[arm] as unknown[]).map(textField).filter(present)
      : [];
    if (values.length === 0) return undefined;
    // The values came through `textField`, so an email somebody typed as a
    // WhatsApp address arrives already redacted — the fence is one place
    // and this is not a second copy of it.
    return showValues ? `${label}: ${listInSpanish(values)}` : label;
  }).filter(present);

  const who = [textField(payload["contactName"]), textField(payload["role"])]
    .filter(present)
    .join(", ");

  return dotted([
    who === "" ? undefined : who,
    said.length === 0 ? "sin datos" : said.join(" · "),
  ]);
}

/** «teléfono, correo y RFC» — the Spanish list, not a comma-joined one. */
function listInSpanish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]!}`;
}

/**
 * A stored `YYYY-MM-DD`, in words.
 *
 * FORMATTED IN UTC, deliberately, which is the same decision
 * `renderCalendarDate` documents on the rep side: a calendar date has no
 * time of day, so rendering it in a zone west of Greenwich would move it a
 * day earlier. This is a restatement of that function rather than an import
 * — see the module header for why the arrow cannot run that way — and it
 * must stay in step with it.
 */
function calendarDate(value: unknown): string | undefined {
  const day = textField(value);
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return undefined;
  return CALENDAR.format(at).replace(",", "");
}

/**
 * EVERY STRING THAT LEAVES THIS MODULE GOES THROUGH HERE, and that is why
 * the redaction lives in it rather than at each call site (Codex r2).
 *
 * The aperture's own payload sweep refuses a WhatsApp address and the
 * COUNTERPARTY'S OWN number in any payload string. What it cannot refuse is
 * a THIRD party's number — «va, coordina con Juan al 81 1234 5678» is the
 * rep's own message, it is what ADR-0038 says an `OrderTaken` must carry
 * verbatim, and it crosses. ADR-0004 is absolute the other way: a number
 * never reaches an owner surface. Both cannot be honoured at the value, so
 * the sentence crosses and the number in it does not.
 *
 * The real fence belongs at the aperture, where a crossing can be refused
 * rather than a rendering trimmed — that is a spine question between
 * ADR-0038 and ADR-0004, recorded on #129 and not settled here.
 *
 * A CONTIGUOUS RUN, not the seat rule's global digit strip. A name is a
 * short label and stripping every non-digit from it is safe; a sentence is
 * prose, and «100 cajas, 52,800 pesos, el 29 de agosto de 2026» has
 * fourteen digits in it and not one phone number.
 */
function textField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = redactWallShapedText(value.trim());
  return trimmed === "" ? undefined : trimmed;
}

/** A whole WhatsApp address, wherever it sits in a string. */
const JID_SHAPED = /\S*@(?:s\.whatsapp\.net|g\.us|lid|broadcast)/gi;
/**
 * Ten digits in a row, single separators allowed between them.
 *
 * ANY RUN OF NON-ALPHANUMERIC SEPARATORS, not a hand-listed four and not
 * one character (ticket #130, Codex r1 and r2). The set was whitespace,
 * dot, parenthesis and hyphen, and it allowed exactly ONE between digits —
 * so «81/1234/5678» walked through on the character class and «+52 (55)
 * 1234-5678» walked through on the count, because `) ` is two. A slash is
 * how half the world writes a number and a closing bracket followed by a
 * space is how the other half does; there is no reason to enumerate either.
 *
 * `\p{Z}\p{P}\p{S}` covers every Unicode separator, punctuation mark and
 * symbol, `*` allows a run of them, and `\p{Nd}` counts a full-width digit
 * as a digit. A digit followed by a LETTER is still not a separator, so the
 * run ends there — which is what keeps «40 bultos de mortero 4500 MXN» and
 * «100 cajas a 52,800 el 29 de agosto de 2026» untouched.
 */
const PHONE_RUN = /\p{Nd}(?:[\p{Z}\p{P}\p{S}]*\p{Nd}){9,}/gu;

function redactWallShapedText(text: string): string {
  return text
    .replace(JID_SHAPED, "(dirección omitida)")
    .replace(PHONE_RUN, "(número omitido)");
}

/**
 * A NAME IS REFUSED WHOLE, not redacted: a customer name that is a phone
 * number is not a name with a number in it. The rule is
 * `seats.rep_display_name`'s CHECK, character for character — a WhatsApp
 * address, or ten digits once every non-digit is stripped — so the two free
 * text values an owner reads refuse the same shapes and there is no third
 * normalization to keep in step. «Aceros 3000» is a name; «+52 (55)
 * 1234-5678» is not.
 *
 * DIGITS COUNTED AS UNICODE DECIMALS (ticket #130, Codex r3). `\D` is
 * ASCII-only, so a display name written in full-width or Arabic-Indic
 * digits had ZERO digits by this rule and came back verbatim — into a page,
 * into the owner twin's tool result and into a rendered turn. This column's
 * value is proposed off a push name the CUSTOMER sets, so it is a name
 * somebody chooses; `\P{Nd}` counts what a reader would count.
 */
function isWallShapedName(name: string): boolean {
  return (
    /@(?:s\.whatsapp\.net|g\.us|lid|broadcast)/i.test(name) ||
    name.replace(/\P{Nd}/gu, "").length >= 10
  );
}

/**
 * A STORED NUMBER, NOT A POSITIVE ONE (ADR-0034). The aperture decides what
 * may be stored — its shaper takes only `> 0` — and this decides what a
 * stored value reads as. Folding the writer's rule in here would make a
 * recorded `0` render «sin cantidad», which states that nothing was
 * recorded about a field that was: not-recorded and recorded-as-zero are
 * exactly the two things a bi-temporal store must not conflate.
 */
function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function present(part: string | undefined): part is string {
  return part !== undefined && part !== "";
}

/**
 * The parts of one line, empties dropped, separated by the product's middle
 * dot. Named for what it produces rather than for the array method it uses:
 * an absent part is not an empty segment, it is no segment.
 */
function dotted(parts: readonly (string | undefined)[]): string {
  return parts.filter(present).join(" · ");
}

/**
 * `maximumFractionDigits: 20` for the reason the rep side's formatter
 * carries it: a two-digit cap silently rounded a stored `0.125 toneladas`
 * to `0.13`, which is the store lying about what it holds.
 */
const NUMBER = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 20 });

/** One decimal at most: `confidence` is `numeric(4,3)`, so 0.955 is 95.5%. */
const PERCENT = new Intl.NumberFormat("es-MX", {
  style: "percent",
  maximumFractionDigits: 1,
});

const CALENDAR = new Intl.DateTimeFormat("es-MX", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

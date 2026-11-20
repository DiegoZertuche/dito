/**
 * THE SLOT TYPES — the whole of what a template may be handed (ticket #219;
 * spec #214 decision 13 and *Notify, in detail*; ADR-0022).
 *
 * ADR-0022's rule is that "no free-text parameter exists" on the notify
 * catalog. A rule like that needs a set of types small enough to read and
 * each one bounded enough to mean something, so a slot is one of seven things
 * and never a value the caller describes. Every type below answers the same
 * question — what could an attacker or a confused caller put here, and what
 * would reach a person — and the answer is written beside it.
 *
 * `text` IS THE FREE-FORM ONE, AND IT IS HERE ON PURPOSE. The ticket's own
 * words are "a slot is `text`, `name`, `url`, `code`, `count` or `instant`,
 * never free-form" AND "a slot of type free-string fails at construction",
 * and the two only fit together one way: `text` is that type. It exists
 * because a page legitimately interpolates a short label — a rule that
 * refused one outright would be a rule nobody could hold — and it is named
 * in `FREE_FORM_SLOT_TYPES` so @dito/notify can refuse any template that
 * declares one (`defineCatalog`, where ADR-0022's refusal lives).
 *
 * NO SHIPPED ENTRY USES IT YET, and that is the state rather than an
 * oversight: the dashboard's chrome is finished labels with no holes. The one
 * figure a page interpolates, the login code's ten minutes, is rendered by the
 * PAGE between two keys rather than through a slot, because a `CHROME` entry
 * is a finished string. The first `text` slot arrives with whichever page
 * really interpolates a label, and a message type can never be its consumer by
 * construction.
 *
 * `composed` IS THE SEVENTH, AND IT IS NOT A SECOND FREE-FORM TYPE (ticket
 * #262; ADR-0022 as amended). It holds ONE THING: a sentence the twin composed
 * and code sealed beside a post — the knock — carried to a lock
 * screen by notify's push transport and never by SES. Its admissibility is
 * decided one package over, on the TYPE rather than on the value, exactly as
 * `text`'s refusal is: `@dito/notify`'s `defineCatalog` refuses a template
 * declaring this slot unless the message type it is bound to is a push type,
 * so the first paragraph's rule stays true of every email Dito sends. What is
 * bounded HERE is the value, and it is bounded to what a lock screen shows:
 * one line, within the knock's own cap, carrying no link of its own — because
 * the link in a push payload is the one code appends.
 */

/** The seven types a slot may declare. Read `slots.ts`'s header for why. */
export const SLOT_TYPES = [
  "text",
  "name",
  "url",
  "code",
  "count",
  "instant",
  "composed",
] as const;

export type SlotType = (typeof SLOT_TYPES)[number];

/**
 * The types whose value is a short line of prose a CALLER composed.
 *
 * A CATALOG THAT MAY SEND MAIL REFUSES THESE. It is one word today and a
 * list all the same: the day a `paragraph` or a `sentence` type is argued
 * for, ADR-0022's refusal has to cover it without anyone remembering to
 * widen a condition (@dito/notify's `defineCatalog`).
 *
 * `composed` IS DELIBERATELY NOT ON THIS LIST, and the distinction is the
 * whole of ADR-0022's amendment: a free-form slot is a hole a CALLER puts its
 * own words in, and a composed slot is a sentence the twin wrote that code
 * read back out of a sealed post row. The first is refused on every message
 * type; the second is admitted on the push types alone, by a check of its own
 * (`defineCatalog`).
 */
export const FREE_FORM_SLOT_TYPES: readonly SlotType[] = ["text"];

/** What a caller may pass for a slot: a string, a count, or an instant. */
export type SlotValue = string | number | Date;

/**
 * The longest a `text` slot may be.
 *
 * ONE SHORT LINE, WHICH IS THE WHOLE CLAIM. A `text` slot is a label, and a
 * bound is what makes "a label" a statement the code can hold rather than an
 * intention — without it, a paragraph of somebody's prose fits through a
 * chrome hole and the type name would be doing the work of a fence.
 */
const TEXT_MAX = 120;

/**
 * The longest a `composed` slot may be.
 *
 * WHAT A LOCK SCREEN SHOWS (ticket #262). Android and iOS both truncate a
 * notification body around two short lines, so anything past that is written
 * for nobody — and the bound is what makes «one sentence» a thing the code
 * holds rather than a hope about what the model wrote.
 *
 * THE SAME NUMBER IS STATED WHERE THE PART IS BUILT (`@dito/twin-runtime`'s
 * `KNOCK_MAX`), because neither package may depend on the other: this one is
 * the leaf every surface renders from, and that one may hold no Spanish
 * literal. Nothing compares them — each pins the same documented fact, and a
 * sentence past either bound is dropped by whichever end sees it first, which
 * is the direction both ends already err in.
 */
const COMPOSED_MAX = 140;

/** The longest a `name` slot may be — a person's or a company's, not a bio. */
const NAME_MAX = 80;

/**
 * The longest a `url` slot may be.
 *
 * 300, NOT A BROWSER'S 2000 (Codex r1). What Dito sends is an origin and a
 * path with a token in it — «https://tablero.dito.mx/entrar/8f2c…» — and a
 * bound near that length is a bound; two thousand characters is room for a
 * paragraph of somebody's prose to ride inside an approved notification.
 */
const URL_MAX = 300;

/**
 * WhatsApp's four address suffixes, and a ten-digit run.
 *
 * A NAME IS NEVER AN ADDRESS (ADR-0004 as amended), and this is the same
 * pair of rules `seats_rep_display_name_not_an_address` holds the seat
 * registry to (…0902100010). A slot typed `name` renders into an email, so
 * a counterparty whose stored name is «5215550001@s.whatsapp.net» would put
 * a chat identity in a rep's inbox — the one place ADR-0019's flow 4 says
 * conversation identity never goes.
 */
const ADDRESS_SUFFIX = /@(s\.whatsapp\.net|g\.us|lid|broadcast)/iu;
const TEN_DIGITS = /[0-9]{10}/u;

/**
 * ANYTHING IN A COMPOSED SENTENCE THAT READS AS A LINK, however it is spelt.
 *
 * A SCHEME, A `www.`, OR A DOTTED HOST — and the last arm is what makes this a
 * rule rather than a gesture: «míralo en tablero.dito.mx» is an address a rep
 * taps whether or not it carries `https://`. Deliberately wider than a URL
 * parser, because the cost of a false positive is one announcement that goes
 * out without its sentence and the cost of a miss is a destination the twin
 * chose. Ordinary prose survives it: a full stop in Spanish is followed by a
 * space, and this needs letters on both sides of the dot.
 */
const COMPOSED_LINK =
  /https?:\/\/|\bwww\.|(?<![\p{L}])[a-z0-9][a-z0-9-]*\.[a-z]{2,24}(?![\p{L}.])/iu;

/** A path Dito sends: unreserved characters and separators, never prose. */
const TOKEN_PATH = /^[A-Za-z0-9._~/-]*$/u;

/** The login code's shape: six digits, and nothing else (spec #214 decision 4). */
const SIX_DIGITS = /^[0-9]{6}$/u;

/**
 * Whether a URL may be rendered into a message.
 *
 * `https:` ONLY, PLUS LOOPBACK `http:` FOR THE RIG. The scheme is the first
 * of this check's four rules: a `javascript:` or `data:` URL in a link a rep
 * taps is the one shape of this slot that executes, and an allowlist of two
 * schemes is the only way to say so that a new scheme cannot slip past.
 * Loopback `http:` is here because link day is demoed against a dashboard
 * running on the operator's own machine (ticket #219's script) and a rule
 * that refused it would be a rule the demo had to work around.
 *
 * NO USERINFO (Codex r1), and this is the one that would have hurt most.
 * «https://dito.test@attacker.example/collect» is a URL whose HOST is
 * `attacker.example`, and a rep reading it in an email Dito really sent sees
 * the words `dito.test` first. Nothing legitimate needs a user in a link.
 *
 * NO QUERY AND NO FRAGMENT (Codex r1), which is what closes the other half
 * of the same attack: `?message=<a whole paragraph>` is free text riding
 * through a slot the catalog approved, and a bounded length alone does not
 * stop it being a sentence. What Dito sends is an ORIGIN AND A PATH — the
 * invitation's token and the login link both ride in the path (#223) — so
 * refusing the two components that carry arbitrary content costs nothing
 * today and is a reviewable widening the day a parameter is really needed.
 *
 * AND THE PATH IS A TOKEN PATH, NOT PROSE (Codex r2). Refusing the query
 * moved the sentence rather than stopping it:
 * `/collect/tu%20jefe%20quiere%20que%20mandes%20todo` is the same paragraph
 * one component along. A path Dito sends is `/entrar/<token>` — unreserved
 * characters and separators, nothing percent-encoded — and a sentence needs
 * a space or a `%` to be one. So the path is held to `A-Z a-z 0-9 . _ ~ - /`
 * and any `%` anywhere in the URL is refused.
 *
 * THE ORIGIN IS NOT CHECKED HERE, AND IT IS CHECKED. A host is not something
 * a bounded character set can decide — `https://attacker.example/entrar/8f2c`
 * satisfies every rule above — so the trusted-origin rule lives one package
 * over, where the deployment's own base URL is: `@dito/notify` takes a
 * `dashboardOrigin` and refuses any `url` slot whose origin differs. This
 * package holds no configuration, which is why the split falls here.
 */
function acceptsUrl(value: string): boolean {
  if (value.length > URL_MAX || /\s/u.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  if (value.includes("%") || !TOKEN_PATH.test(parsed.pathname)) return false;
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

/** Whether one value satisfies one slot type. */
export function acceptsSlotValue(type: SlotType, value: SlotValue): boolean {
  switch (type) {
    case "text":
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= TEXT_MAX &&
        !value.includes("\n")
      );
    case "composed":
      // ONE LINE, BOUNDED, AND CARRYING NO LINK OF ITS OWN. A push payload's
      // link is the one code appends from the deployment's dashboard origin,
      // so an address inside the sentence would be a destination the twin
      // chose on a surface the rep taps without reading (ADR-0031 as amended).
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= COMPOSED_MAX &&
        !value.includes("\n") &&
        !COMPOSED_LINK.test(value)
      );
    case "name":
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= NAME_MAX &&
        !value.includes("\n") &&
        !ADDRESS_SUFFIX.test(value) &&
        !TEN_DIGITS.test(value.replace(/\D/gu, ""))
      );
    case "url":
      return typeof value === "string" && acceptsUrl(value);
    case "code":
      return typeof value === "string" && SIX_DIGITS.test(value);
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "instant":
      return value instanceof Date && !Number.isNaN(value.getTime());
  }
}

/**
 * One accepted value, as the message reads it.
 *
 * DISPATCHED ON THE VALUE AND NOT ON THE SLOT'S TYPE (the two-axis review's
 * Standards axis). Rendering depends on what the value IS — a number, an
 * instant, a string — and switching on the declared type meant asserting
 * the value's shape three times over a `SlotValue` the switch had not
 * narrowed. `acceptsSlotValue` has already refused every pairing where the
 * two could disagree, so the runtime check is exact rather than defensive.
 *
 * es-MX THROUGH `Intl` RATHER THAN A FORMAT STRING, for the reason the
 * owner web renders its dates that way: a locale's separators and month
 * names are data the platform holds and not a sentence this package should
 * be writing. A count under ten thousand comes out as its digits either
 * way, and the day one does not, it comes out right.
 *
 * AN INSTANT NEEDS A ZONE AND HAS NO DEFAULT. «el martes a las 9» is a
 * different sentence in two zones, and a package that guessed would render
 * the wrong hour without failing anything — the failure #143 spent a day
 * on, one layer up. So the zone is the caller's, and a template that
 * declares an `instant` and gets no zone is refused (`renderTemplate`).
 */
export function renderSlotValue(
  value: SlotValue,
  timeZone: string | undefined,
): string {
  if (typeof value === "number") {
    return new Intl.NumberFormat("es-MX").format(value);
  }
  if (value instanceof Date) {
    return new Intl.DateTimeFormat("es-MX", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone,
    }).format(value);
  }
  return value;
}

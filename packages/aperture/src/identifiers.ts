/**
 * The merge match keys, normalized on the way in (ticket #52; spec #48
 * grilling decision 6; ADR-0034, ADR-0035).
 *
 * `ContactEstablished` carries STRUCTURED, MULTI-VALUED, NORMALIZED
 * identifiers — E.164 phone, lowercased email, uppercased RFC — never free
 * text. ADR-0035's merge ladder compares exactly these values, and ADR-0034
 * says fields may be added later but what is already stored cannot be
 * restructured. So the first row ever written has to be right: there is no
 * later pass that re-normalizes an append-only store.
 *
 * Normalization happens HERE, at the aperture, on the way in — not at the
 * model boundary and not at read time. The model produces text a person
 * typed; the aperture is the one component that decides what may cross, and
 * a match key is the most consequential thing it writes.
 *
 * REFUSAL IS THE DEFAULT. Anything this module cannot place with certainty
 * comes back `undefined` and is simply not stored (FR-31, precision over
 * recall). A half-dialled number stored as a match key does not degrade
 * gracefully — it merges two customers who are not one, silently, on a
 * ladder that asks nobody (ADR-0035).
 */

/**
 * The calling code a bare national number is read under. The rig is one
 * Mexican seat and es-MX is the traffic (spec #48), so this is the market's
 * own code rather than a neutral default that would refuse every number a
 * rep actually reads.
 *
 * RECORDED, not hidden: a fleet spanning markets needs this per seat rather
 * than per build. It is a parameter here so that change is a composition
 * change, and it is deliberately NOT read from an environment variable —
 * a match key whose meaning depends on a process's environment is a merge
 * waiting to happen.
 */
export const DEFAULT_CALLING_CODE = "52";

/** The E.164 ceiling: a country code plus at most 15 digits in total. */
const E164_MAX_DIGITS = 15;
/** Below this nothing is a dialable international number. */
const E164_MIN_DIGITS = 8;
/** A national subscriber number's length in the markets this rig serves. */
const NATIONAL_DIGITS = 10;

/**
 * One number in E.164, or nothing.
 *
 * Three shapes are accepted, and they are the three a person writes:
 * an international number (`+52 55 …`), an IDD-prefixed one (`0052 55 …`),
 * and a bare national number, which is read under `callingCode`.
 */
export function normalizePhone(
  raw: string,
  callingCode: string = DEFAULT_CALLING_CODE,
): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  // Letters mean prose, not a number: «ext. 204» and «marcar al 55…» are
  // both things a model will hand over, and neither is a match key.
  if (/[a-zA-Z]/u.test(trimmed)) return undefined;
  const international = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/gu, "");
  if (digits === "") return undefined;

  if (!international) {
    if (digits.startsWith("00")) {
      // The IDD prefix: «0052 55 …» is the same number as «+52 55 …».
      digits = digits.slice(2);
    } else if (digits.length === NATIONAL_DIGITS) {
      digits = `${callingCode}${digits}`;
    } else if (!digits.startsWith(callingCode)) {
      // Not international, not national-length, and not already carrying
      // the market's code: unplaceable. Refused rather than padded.
      return undefined;
    }
  }
  if (digits.length < E164_MIN_DIGITS || digits.length > E164_MAX_DIGITS) {
    return undefined;
  }
  if (digits.startsWith("0")) return undefined;
  const e164 = canonical(digits, callingCode);
  if (isPlaceholderNumber(e164)) return undefined;
  return `+${e164}`;
}

/**
 * A number that identifies nobody, refused for the same reason as the SAT's
 * generic RFC (ticket #55, Codex r1).
 *
 * `0000000000` and `5555555555` are what a form gets when someone has no
 * number to give, and the second is the dummy every price list and every
 * training deck in this market prints. A bare national number of ten
 * identical digits is not a subscriber anywhere — but it normalizes cleanly,
 * stores as a perfectly ordinary E.164 string, and then ADR-0035's ladder
 * merges every customer that carries it. ADR-0034 forbids restructuring the
 * payloads afterwards, so the only place to catch it is here.
 *
 * The last ten digits, so it holds whatever calling code prefixes them. A
 * refusal costs one merge that might have been right; storing it fuses
 * customers who are not one, silently and permanently.
 */
function isPlaceholderNumber(digits: string): boolean {
  const subscriber = digits.slice(-NATIONAL_DIGITS);
  return /^(\d)\1+$/u.test(subscriber);
}

/**
 * Mexico's historical mobile `1`, removed (Codex r3).
 *
 * `+52 1 55 1234 5678` and `+52 55 1234 5678` are the SAME subscriber —
 * the `1` is a legacy mobile prefix that WhatsApp's own addressing still
 * carries and that the dialable number does not. Left alone, the two
 * spellings become two IMMUTABLE merge keys for one phone, and ADR-0035's
 * ladder simply misses the merge while ADR-0034 forbids restructuring the
 * payloads that recorded them. This module already relies on the same fact
 * to recognize a chat's own address; it has to hold on the way in too.
 *
 * Scoped to the Mexican calling code by construction: `1` means something
 * else everywhere else.
 */
function canonical(digits: string, callingCode: string): string {
  const legacy = `${callingCode}1`;
  if (
    callingCode === MEXICO_CALLING_CODE &&
    digits.startsWith(legacy) &&
    digits.length === legacy.length + NATIONAL_DIGITS
  ) {
    return `${callingCode}${digits.slice(legacy.length)}`;
  }
  return digits;
}

/** The one market whose legacy mobile prefix this module knows about. */
const MEXICO_CALLING_CODE = "52";

/**
 * One address, lowercased, or nothing.
 *
 * The whole address is lowercased, local part included. RFC 5321 makes the
 * local part case-SENSITIVE in principle; in practice no mail provider a
 * customer uses treats it that way, and ADR-0035 asks for "a normalized
 * email" as a match key rather than for a routable address. Two spellings
 * of one mailbox failing to merge is the failure this avoids.
 */
export function normalizeEmail(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  // One @, something either side, and a dot in the domain: the shape that
  // is certainly an address. Anything more permissive stores prose.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u.test(value)) return undefined;
  if (isReservedDomain(value.slice(value.lastIndexOf("@") + 1))) return undefined;
  return value;
}

/**
 * The domains the IETF reserved so that nobody's real address is in them —
 * RFC 2606's `example.com/.net/.org` and its `.test`, `.example`, `.invalid`
 * and `.localhost` TLDs, plus RFC 6761's re-statement of the same set.
 *
 * They are refused as merge keys for the SAT generic RFC's reason (ticket
 * #55, Codex r1): `unknown@example.com` is what a model produces from «no
 * tengo su correo», any number of unrelated customers carry it, and
 * ADR-0035's ladder would fuse every one of them without asking anyone.
 * Standards-backed rather than a guessed blocklist, so the rule is
 * explainable and does not grow by opinion.
 */
function isReservedDomain(domain: string): boolean {
  return (
    RESERVED_DOMAINS.has(domain) ||
    RESERVED_TLDS.some((tld) => domain.endsWith(`.${tld}`))
  );
}

const RESERVED_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
]);
const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];

/**
 * The SAT's GENERIC RFCs, which are placeholders rather than identities
 * (Codex r2): `XAXX010101000` is what an invoice carries when the customer
 * has no RFC to give, and `XEXX010101000` is its equivalent for
 * unregistered foreign residents. Any number of unrelated customers
 * legitimately carry them.
 *
 * They are refused because ADR-0035's ladder merges two entities on a
 * SHARED RFC, deterministically and without asking anyone — so storing a
 * value that thousands of customers share would fuse unrelated customers
 * automatically, and ADR-0034 then forbids restructuring the payloads that
 * did it. A match key has to identify one customer or be no key at all.
 */
const GENERIC_RFCS = new Set(["XAXX010101000", "XEXX010101000"]);

/**
 * One RFC (the Mexican tax ID), uppercased, or nothing.
 *
 * Persona física carries four leading letters, persona moral three; both
 * then carry six date digits and a three-character homoclave. Separators
 * people write (spaces, hyphens) come off. The check digit is NOT verified:
 * a rejected-but-real RFC costs a merge that should have fired, and the
 * shape alone is already specific enough that prose does not pass it.
 *
 * The generic placeholders above are refused outright — they pass the shape
 * and would be the worst possible merge key.
 */
export function normalizeRfc(raw: string): string | undefined {
  const value = raw.trim().toUpperCase().replace(/[\s-]/gu, "");
  if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/u.test(value)) return undefined;
  if (GENERIC_RFCS.has(value)) return undefined;
  return value;
}

/**
 * The identifier block a `ContactEstablished` payload carries.
 *
 * Every arm is always present, even when empty. Under ADR-0034 an absent
 * field means NOT RECORDED THEN rather than "none" — so a payload that
 * omitted `emails` would be indistinguishable, three years from now, from
 * one written before emails were extracted at all. Present-and-empty says
 * the thing that is true.
 */
export interface NormalizedIdentifiers {
  /** E.164, de-duplicated, in the order first seen. */
  readonly phones: readonly string[];
  /** Lowercased, de-duplicated. */
  readonly emails: readonly string[];
  /** Uppercased, de-duplicated. */
  readonly rfcs: readonly string[];
}

/** Normalizes one candidate's raw identifier arms, dropping what will not place. */
export function normalizeIdentifiers(
  raw: {
    readonly phones?: readonly string[];
    readonly emails?: readonly string[];
    readonly rfcs?: readonly string[];
  },
  callingCode: string = DEFAULT_CALLING_CODE,
): NormalizedIdentifiers {
  return {
    phones: normalizeArm(raw.phones, (v) => normalizePhone(v, callingCode)),
    emails: normalizeArm(raw.emails, normalizeEmail),
    rfcs: normalizeArm(raw.rfcs, normalizeRfc),
  };
}

function normalizeArm(
  values: readonly string[] | undefined,
  normalize: (value: string) => string | undefined,
): string[] {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = typeof value === "string" ? normalize(value) : undefined;
    if (normalized !== undefined) seen.add(normalized);
  }
  return [...seen];
}

/**
 * Whether an E.164 number IS the address of the chat it was read in —
 * which makes it chat identity, not a business fact (ADR-0004).
 *
 * This is the laundering path the wall would otherwise miss. A
 * `ContactEstablished` carrying the counterparty's own WhatsApp number
 * hands an owner the chat one comparison away from `scope_allowlist`, and
 * lets them message the rep's customer directly — which is precisely what
 * "owner joins must never recover chat identity" forbids. The wall sweep
 * looks for JID SUFFIXES and would not see a bare `+52…`.
 *
 * Compared on the last ten digits, because WhatsApp's Mexican addressing
 * carries a historical `1` after the country code (`521…`) that the same
 * subscriber's dialable number does not.
 */
export function isChatOwnNumber(e164: string, chatJid: string): boolean {
  const subscriber = chatSubscriberDigits(chatJid);
  const phoneDigits = e164.replace(/\D/gu, "");
  if (subscriber === undefined || phoneDigits.length < NATIONAL_DIGITS) {
    return false;
  }
  return phoneDigits.slice(-NATIONAL_DIGITS) === subscriber;
}

/**
 * Whether the chat's subscriber digits appear ANYWHERE inside a piece of
 * text — the prose form of the same rule (Codex r2).
 *
 * `isChatOwnNumber` compares the END of a value, which is right when the
 * whole value is a number. It is wrong for prose: «entregas al 55 1234 5678
 * ext. 204» ends in the extension, so a suffix comparison walks past the
 * customer's own address sitting in the middle of the sentence. Separators
 * come off first, so the way a person writes a number cannot hide it.
 *
 * A false positive is a refusal, which is the fail-safe direction: a fact
 * refused costs recall, a fact filed with chat identity costs the wall.
 */
export function containsChatOwnNumber(text: string, chatJid: string): boolean {
  const subscriber = chatSubscriberDigits(chatJid);
  if (subscriber === undefined) return false;
  return text.replace(/\D/gu, "").includes(subscriber);
}

/**
 * A chat address's subscriber digits — its last ten, because WhatsApp's
 * Mexican addressing carries a historical `1` after the country code that
 * the same subscriber's dialable number does not. Undefined when the
 * address carries too few digits to identify anyone.
 */
function chatSubscriberDigits(chatJid: string): string | undefined {
  const digits = (chatJid.split("@")[0] ?? "").replace(/\D/gu, "");
  return digits.length < NATIONAL_DIGITS
    ? undefined
    : digits.slice(-NATIONAL_DIGITS);
}

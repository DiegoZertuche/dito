/**
 * THE INVITATION TOKEN — minted by one process, presented to another (ticket
 * #223; spec #214 *Link day, in detail*; ADR-0032).
 *
 * ONE MODULE BECAUSE TWO PROCESSES SHARE THE ARITHMETIC, which is the same
 * reason `readRailState` lives beside it: the operator's script MINTS the token
 * and writes its digest, and rep-web DIGESTS a token a browser presented and
 * looks the row up by it. Two copies of «sha-256 of the utf-8 bytes» would be
 * two chances for one of them to be right and the other to be a rep who cannot
 * get in through a link Dito really sent.
 *
 * `sessions.ts` KEEPS ITS OWN DIGEST FUNCTION AND SHOULD, which is worth one
 * line because the shapes look identical. A session id is minted and consumed
 * by ONE process — rep-web hands the browser the bytes and reads them back — so
 * the function has no second caller and belongs private to that module. This
 * one has two callers on two sides of a rig, and that is the whole difference.
 *
 * THE BYTES EXIST IN THREE PLACES AND NO STORE IS ONE OF THEM: in the minting
 * process, in the line the operator forwards, and in the URL the rep opens.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * How long an invitation lasts, in days.
 *
 * SEVEN, AND THE NUMBER IS ABOUT HOW AN INVITATION REACHES A REP rather than
 * about how long a credential should live. A login code is ten minutes because
 * the rep is looking at the screen that asked for it; an invitation is sent to
 * an address, or forwarded by an owner over WhatsApp, and read whenever the rep
 * next opens their mail — which for a field rep is plausibly Monday morning
 * after a Friday invite. Anything under a couple of days would make «the link
 * expired» the ordinary case and a re-issue part of link day.
 *
 * AND IT IS BOUNDED, which is what stops it being «no expiry with extra
 * steps». The token opens a SESSION for a seat with no second factor at all,
 * so a link sitting in a forwarded WhatsApp thread is a credential for as long
 * as it is valid; a week is short enough that an invitation nobody used is dead
 * before it is forgotten, and the operator re-issues in one command.
 *
 * IT LIVES HERE rather than in the script, because the owner's own Seats
 * surface will issue invitations too (spec #214's horizon) — and two issuers
 * with two expiries would be two products.
 */
export const INVITATION_LIFETIME_DAYS = 7;

/**
 * How many random bytes a token carries.
 *
 * 32, WHICH IS 256 BITS FROM A CSPRNG — the session id's own arithmetic, for
 * the same reason: this closes "a token somebody guessed" by counting rather
 * than by rate limiting, which an invitation cannot have (there is no attempt
 * to key a limit on, and a wrong guess writes nothing to count).
 */
const TOKEN_BYTES = 32;

/**
 * The shape a presented token must have before anything is read.
 *
 * base64url OF 32 BYTES IS 43 CHARACTERS, unpadded — and checking that first
 * means a mangled link is refused without a query, exactly as #221's
 * same-device link refuses a path that is not a uuid and six digits. It is also
 * what makes the token fit `@dito/copy`'s `url` slot at all: that slot allows
 * `A-Za-z0-9._~/-` in a path and refuses any `%`, and base64url's alphabet is
 * inside it.
 */
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/** A fresh token. Returned once, never read back out of any store. */
export function mintInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The digest the row holds.
 *
 * sha-256 AND NOT A PASSWORD HASH, for `sessions.ts`' reason: the input is 256
 * bits from a CSPRNG, so there is nothing to walk and a slow hash would only
 * make the one read on the invitation's path slower.
 */
export function invitationTokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

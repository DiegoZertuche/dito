/**
 * WHAT ONE OF THIS REPO'S OWN IDS LOOKS LIKE (ticket #224).
 *
 * ONE PREDICATE FOR EVERY SIDE OF EVERY DOOR. The check was written six times
 * across this ticket — the send lock, the local API's body reader, the
 * aperture's dashboard arm, the card-state read, the act result a redirect
 * carries — and six copies of one regular expression are six chances to
 * disagree about what an id is.
 *
 * IT IS A GUARD AND NOT A VALIDATION. Every caller uses it for the same
 * reason: a value that is not an id has to land as a REFUSAL rather than as a
 * Postgres cast error, because the values reaching these doors come from a
 * request body, a form field or an address bar. What makes an id THIS TWIN'S
 * is always a predicate on a query, never this.
 *
 * ITS OWN MODULE, so `send-lock.ts` can use it without importing the package's
 * index — which re-exports `send-lock.ts` and would make the two circular.
 */

/** Whether a string is a uuid in Postgres's own text form. */
export function isOwnId(value: string): boolean {
  return OWN_ID.test(value);
}

const OWN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

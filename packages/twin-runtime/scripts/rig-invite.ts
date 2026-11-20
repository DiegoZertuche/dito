/**
 * THE OPERATOR ISSUES AN INVITATION (ticket #223; spec #214 user story 2 and
 * *Link day, in detail*; ADR-0032, ADR-0022, ADR-0028).
 *
 * "As an operator on the rig, I want a script that issues an invitation for a
 * seat, so that link day can be proven before the owner's Seats surface
 * exists" (user story 2). This is that script, and it is the ONLY thing in this
 * repo that mints an invitation token: rep-web holds no INSERT on
 * `invitations` (`grants.ts` pins it), because a login surface that could mint
 * one could invite itself.
 *
 * Usage — source .env.rig (or use ./rig.sh), then:
 *
 *   node --experimental-strip-types packages/twin-runtime/scripts/rig-invite.ts \
 *     <seatId> [--days N] [--dry-run]
 *
 * (build first: `pnpm build`.)
 *
 * ═══ THE TOKEN IS PRINTED ONCE AND EXISTS NOWHERE ELSE
 *
 * The row holds its sha-256 (`@dito/seam/invitations`, the same function
 * rep-web digests a presented token with, so the two cannot disagree). The
 * bytes exist in this process, in the line this script prints, and — when the
 * mail rail is configured — in the message. NOT in a log line, NOT in
 * `notify_sends` (which is content-free by design: a seat id, a type, two
 * instants and a closed word), and NOT recoverable from the store. An operator
 * who loses the line issues another invitation.
 *
 * ═══ A SEAT THAT IS NOT `invited` IS REFUSED BY NAME
 *
 * `rig-notify.ts` renders for any seat, because a message is a message. An
 * invitation is a CREDENTIAL for a seat's first login, so the state is checked
 * and the refusal says which state it found:
 *
 *   `linked` — the rep is in. They re-link and re-scope from Conexiones, which
 *   is what those surfaces are for, and a fresh invitation would open a second
 *   session for a rep who has one.
 *
 *   `retired` — ADR-0009 destroyed the twin's key. There is nothing to invite
 *   anybody to.
 *
 * ═══ AND THE MAIL RAIL IS `rig-notify.ts`' OWN GATE
 *
 * `DITO_SES_FROM` and `DITO_DASHBOARD_ORIGIN` both set (and no `--dry-run`)
 * sends notify's `invitation` to the seat's own address and records it;
 * otherwise the SAME rendering goes to stdout with the lane's loud skip and
 * NOTHING is recorded — because nothing was sent, and a row claiming otherwise
 * would be the one lie that table cannot afford (ADR-0028: never emulated,
 * never silently green).
 *
 * THE ORIGIN IS REQUIRED EITHER WAY, and that is the one place this differs
 * from `rig-notify.ts`: that script takes the URL as an argument, and this one
 * MINTS it — so without an origin there is no link to print at all, and
 * printing a bare token would be handing an operator a credential with no door.
 *
 * ═══ WHAT THE EXIT CODE MEANS
 *
 * Zero when the invitation exists and the operator can act on it: mailed, or
 * refused `no_email` because the seat has no address, which is the ordinary
 * case for a link carried by hand. Non-zero when something needs attention —
 * a seat that may not be invited, a mail rail that broke, any other refusal
 * (boundary #225, F6; the send-outcome branch argues it).
 */
import pg from "pg";
import {
  createLiveNotify,
  NotifyError,
  renderNotification,
} from "@dito/notify";
import {
  INVITATION_LIFETIME_DAYS,
  invitationTokenDigest,
  mintInvitationToken,
} from "@dito/seam/invitations";

const USAGE = [
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-invite.ts \\",
  "         <seatId> [--days N] [--dry-run]",
  "",
  "  --days N    how long the invitation lasts (default " +
    String(INVITATION_LIFETIME_DAYS) +
    ")",
  "  --dry-run   issue the row and print the link without sending mail",
].join("\n");

const dbUrl = process.env["DITO_DATABASE_URL"];
const dashboardOrigin = process.env["DITO_DASHBOARD_ORIGIN"];
const seatId = process.argv[2];
if (dbUrl === undefined || seatId === undefined) {
  console.error(USAGE);
  process.exit(1);
}
if (dashboardOrigin === undefined || dashboardOrigin === "") {
  console.error(
    "DITO_DASHBOARD_ORIGIN is required: an invitation IS a link, so without the dashboard's own origin there is no link to print (ticket #223)",
  );
  process.exit(1);
}

/** One `--flag value` pair off the argument list (`rig-notify.ts`' shape). */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const dryRun = process.argv.includes("--dry-run");
const days = Number.parseInt(flag("days") ?? String(INVITATION_LIFETIME_DAYS), 10);
if (!Number.isSafeInteger(days) || days < 1) {
  console.error("--days takes a whole number of days, at least one");
  process.exit(1);
}

const from = process.env["DITO_SES_FROM"];
// A POOL, because notify checks out its own session per send: the record has to
// be committed before SES is called (`NotifySessions`).
const db = new pg.Pool({ connectionString: dbUrl, max: 2 });
try {
  const seat = await db.query<{
    company_id: string;
    rep_display_name: string;
    state: string;
    has_email: boolean;
  }>(
    `SELECT company_id, rep_display_name, state, email IS NOT NULL AS has_email
       FROM seats WHERE id = $1`,
    [seatId],
  );
  const row = seat.rows[0];
  if (row === undefined) {
    console.error(`no seat ${seatId} — seed one with rig-seed-owner.ts`);
    process.exit(1);
  }
  if (row.state !== "invited") {
    console.error(
      `seat ${seatId} is \`${row.state}\` and an invitation is a seat's FIRST login: a linked rep re-links and re-scopes from Conexiones, and a retired seat's twin key is destroyed (ADR-0009). Nothing was issued.`,
    );
    process.exit(1);
  }

  const token = mintInvitationToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO invitations (company_id, seat_id, token_sha256, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [row.company_id, seatId, invitationTokenDigest(token), expiresAt],
  );
  const url = `${dashboardOrigin}/invitacion/${token}`;
  console.log(
    `seat ${seatId} (${row.rep_display_name}) — address on file: ${row.has_email ? "yes" : "no"}`,
  );
  console.log(`invitation issued, valid ${String(days)} day(s), until ${expiresAt.toISOString()}`);
  // THE ONE PLACE THE TOKEN IS EVER IN THE CLEAR (the module header argues it).
  console.log("");
  console.log(url);
  console.log("");

  const configured = from !== undefined && from !== "";
  if (!configured || dryRun) {
    // THE SAME RENDERING THAT WOULD HAVE GONE OUT. `renderNotification` is the
    // function `notify.send` itself calls, so what an operator forwards by hand
    // is the message and not an approximation of it.
    const message = renderNotification(
      "invitation",
      { repDisplayName: row.rep_display_name },
      { url },
    );
    console.log(`subject: ${message.subject}`);
    console.log("");
    console.log(message.body);
    console.log("");
    console.log(
      dryRun
        ? "SES LANE SKIPPED (--dry-run): the invitation row is written and nothing was sent or recorded. Forward the link above."
        : "SES LANE SKIPPED: DITO_SES_FROM must be set, so nothing was sent and nothing was recorded. The invitation row IS written — forward the link above, or set the sender to a verified identity (and have AWS credentials in the environment) to mail it.",
    );
    process.exit(0);
  }

  const notify = createLiveNotify({
    db,
    from,
    now: () => new Date(),
    dashboardOrigin,
  });
  // ONE ASK IS ONE ATTEMPT PER DESTINATION (ticket #276), and an invitation
  // has exactly one: it leaves by email or it is refused for want of an
  // address. The record is read out of the list rather than assumed, so a
  // second destination would print rather than being silently dropped.
  const records = await notify.send({
    // A SEAT ID AND NEVER AN ADDRESS (ADR-0022). notify resolves the recipient
    // from `seats.email` itself, and refuses `no_email` when there is none —
    // which is the ordinary case for a forwarded invitation, and why the link
    // is printed above whatever the mail rail then says.
    type: "invitation",
    seatId,
    slots: { url },
  });
  for (const record of records) {
    console.log(
      `${record.type} for seat ${record.seatId} by ${record.channel} → ${record.outcome}${record.reason === null ? "" : ` (${record.reason})`} (${record.providerMessageId ?? "no provider id"})`,
    );
  }
  // A SEAT WITH NO ADDRESS IS NOT A FAILED INVITATION (boundary #225, F6). The
  // row is written, the token is printed above, and `no_email` is what notify
  // REFUSES BY DESIGN when `seats.email` is null — the ordinary case for an
  // invitation carried by hand, which this script already supports and the
  // block above already prints for. Exiting 1 for it made a working invitation
  // read as a broken one, and made this script unusable in anything running
  // under `set -e`.
  //
  // EVERY OTHER NON-`sent` OUTCOME KEEPS ITS NON-ZERO EXIT. `transport_failed`
  // is SES saying no and `failed` is the send breaking, and a refusal reason
  // added later is by definition one nobody has weighed here — each is
  // something an operator has to act on, and a green exit would hide it.
  const mail = records.find((one) => one.channel === "email");
  if (mail !== undefined && mail.outcome !== "sent") {
    if (mail.reason !== "no_email") process.exit(1);
    console.log(
      "the seat has no address on file — forward the link above; the refusal is recorded",
    );
  }
} catch (err) {
  if (err instanceof NotifyError) {
    console.error(`refused: ${err.message}`);
    process.exit(1);
  }
  throw err;
} finally {
  await db.end();
}

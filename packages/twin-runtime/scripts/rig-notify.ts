/**
 * THE OPERATOR'S SEND — one message, for one seat, by hand (ticket #219;
 * spec #214 user story 2 and *Link day, in detail*; ADR-0022, ADR-0028).
 *
 * "As an operator on the rig, I want a script that issues an invitation for
 * a seat, so that link day can be proven before the owner's Seats surface
 * exists" (user story 2). This is that script, and it is the whole of 6a's
 * demo path: a seat id and an occasion in, an email out.
 *
 * Usage — source .env.rig (or use ./rig.sh), then:
 *
 *   node --experimental-strip-types packages/twin-runtime/scripts/rig-notify.ts \
 *     <seatId> invitation --url <url>
 *   node --experimental-strip-types packages/twin-runtime/scripts/rig-notify.ts \
 *     <seatId> login_code --code <six digits> --url <url> [--minutes 10]
 *
 * (build first: `pnpm build`.)
 *
 * THE URL IS AN ARGUMENT, and that is a boundary rather than a shortcut:
 * this script RENDERS a message and nothing else, so the operator supplies
 * the link and the digits. Nothing here mints a credential — an invitation
 * token is `rig-invite.ts`', which mints one and sends the same template
 * itself, and a login code is the dashboard's own login.
 *
 * WITHOUT SES IT RENDERS AND PRINTS, and prints why. `DITO_SES_FROM` and
 * `DITO_DASHBOARD_ORIGIN` are the gate: with both, the message really goes
 * to the seat's own address and the send is recorded; without either, the
 * SAME rendering is written to stdout with the lane's loud skip, and NOTHING
 * is recorded — because nothing was sent, and a row claiming otherwise would
 * be the one lie this table cannot afford (ADR-0028: never emulated, never
 * silently green). `--dry-run` takes that path deliberately even when the
 * rail is configured.
 *
 * THE ORIGIN IS A SEPARATE VARIABLE ON PURPOSE. Notify refuses a link that
 * does not point at the dashboard, and deriving the origin from the `--url`
 * the operator just typed would make that refusal agree with itself for ever
 * (see `@dito/notify`'s `DashboardOrigin`).
 *
 * IT NEVER PRINTS THE SEAT'S ADDRESS. What goes to stdout is the message as
 * the rep would read it — every value in it the operator's own argument —
 * plus whether the seat has an address at all, the outcome, and the
 * provider's opaque id. ADR-0019's flow 4 keeps an address out of the store;
 * keeping it out of the terminal is the same rule, one step earlier, and the
 * operator can read the row's seat id if they need to look it up.
 */
import pg from "pg";
import {
  createLiveNotify,
  NOTIFY_MESSAGE_TYPES,
  NotifyError,
  renderNotification,
  type NotifyMessageType,
} from "@dito/notify";

const USAGE = [
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-notify.ts \\",
  "         <seatId> invitation --url <url>",
  "       source .env.rig && node --experimental-strip-types scripts/rig-notify.ts \\",
  "         <seatId> login_code --code <six digits> --url <url> [--minutes 10]",
  "",
  "  --dry-run   render and print without sending, even with DITO_SES_FROM set",
].join("\n");

const dbUrl = process.env["DITO_DATABASE_URL"];
const seatId = process.argv[2];
const type = process.argv[3];
if (dbUrl === undefined || seatId === undefined || type === undefined) {
  console.error(USAGE);
  process.exit(1);
}
if (!(NOTIFY_MESSAGE_TYPES as readonly string[]).includes(type)) {
  console.error(
    `\`${type}\` is not a message type Dito sends (${NOTIFY_MESSAGE_TYPES.join(", ")})`,
  );
  process.exit(1);
}

/** One `--flag value` pair off the argument list. */
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const dryRun = process.argv.includes("--dry-run");
const url = flag("url");
const code = flag("code");
/**
 * How long the code lasts, in minutes. Ten is spec #214 decision 4's number,
 * owned by the dashboard's login flow; this script is a stand-in caller and
 * passes it (why it is a slot at all: `@dito/copy`'s `templates.ts`).
 */
const minutes = Number.parseInt(flag("minutes") ?? "10", 10);

const slots: Record<string, string | number> = {};
if (url !== undefined) slots["url"] = url;
if (type === "login_code") {
  if (code === undefined) {
    console.error("login_code needs --code <six digits>");
    process.exit(1);
  }
  slots["code"] = code;
  slots["minutes"] = minutes;
}

const from = process.env["DITO_SES_FROM"];
const dashboardOrigin = process.env["DITO_DASHBOARD_ORIGIN"];
// A POOL, because notify checks out its own session per send: the record
// has to be committed before SES is called (`NotifySessions`).
const db = new pg.Pool({ connectionString: dbUrl, max: 2 });
try {
  const seat = await db.query<{ rep_display_name: string; has_email: boolean }>(
    "SELECT rep_display_name, email IS NOT NULL AS has_email FROM seats WHERE id = $1",
    [seatId],
  );
  const row = seat.rows[0];
  if (row === undefined) {
    console.error(`no seat ${seatId} — seed one with rig-seed-owner.ts`);
    process.exit(1);
  }
  console.log(
    `seat ${seatId} (${row.rep_display_name}) — address on file: ${row.has_email ? "yes" : "no"}`,
  );

  const configured =
    from !== undefined &&
    from !== "" &&
    dashboardOrigin !== undefined &&
    dashboardOrigin !== "";
  if (!configured || dryRun) {
    // THE SAME RENDERING THAT WOULD HAVE GONE OUT. `renderNotification` is
    // the function `notify.send` itself calls, so what an operator reads
    // here is the message and not an approximation of it.
    const message = renderNotification(
      type as NotifyMessageType,
      { repDisplayName: row.rep_display_name },
      slots,
    );
    console.log("");
    console.log(`subject: ${message.subject}`);
    console.log("");
    console.log(message.body);
    console.log("");
    console.log(
      dryRun
        ? "SES LANE SKIPPED (--dry-run): nothing was sent and nothing was recorded."
        : "SES LANE SKIPPED: DITO_SES_FROM and DITO_DASHBOARD_ORIGIN must both be set, so nothing was sent and nothing was recorded. Set the sender to a verified identity and the origin to the dashboard's own (and have AWS credentials in the environment) to send this for real.",
    );
    process.exit(0);
  }

  const notify = createLiveNotify({
    db,
    from: from!,
    now: () => new Date(),
    dashboardOrigin: dashboardOrigin!,
  });
  // ONE LINE PER DESTINATION (ticket #276): a grave event leaves by two
  // transports and a seat may have several browsers, so an ask is a list of
  // attempts and each one printed is one an operator can act on.
  const records = await notify.send({
    type: type as NotifyMessageType,
    seatId,
    slots,
  });
  // Content-free, and the same line the gated lane prints: what was sent,
  // for which seat, how it ended, and the provider's opaque id.
  for (const record of records) {
    console.log(
      `${record.type} for seat ${record.seatId} by ${record.channel} → ${record.outcome}${record.reason === null ? "" : ` (${record.reason})`} (${record.providerMessageId ?? "no provider id"})`,
    );
  }
  if (records.length === 0) {
    console.log("nothing was owed: every destination already has a record");
  }
  if (records.some((record) => record.outcome !== "sent")) process.exit(1);
} catch (err) {
  if (err instanceof NotifyError) {
    console.error(`refused: ${err.message}`);
    process.exit(1);
  }
  throw err;
} finally {
  await db.end();
}

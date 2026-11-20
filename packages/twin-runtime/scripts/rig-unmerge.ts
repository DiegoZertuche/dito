/**
 * The rig's hand trigger for taking a merge back (ticket #62; ADR-0035,
 * ADR-0036, ADR-0016, ADR-0020).
 *
 * ADR-0036 lets the merge skip the human because it can be undone. The undo
 * is `fileUnmerge`, and THIS IS WHO INVOKES IT: the operator, by hand, at
 * the rig — the same actor and the same shape as the other hand triggers
 * beside this file. Not the rep, who is structurally prevented from seeing
 * a cross-rep duplicate; not the owner, who has no entity surface until
 * slice 4 and whom ADR-0036 refuses to conscript; not the machine, because
 * nothing detects a wrong merge and inventing a detector is not an undo.
 *
 * ALWAYS STAMPED `human`, and the stamp is not a flag. A hand trigger IS a
 * human — offering `machine` here would let the one operator path file a
 * claim about automation that no automation made, and the stamp exists so
 * that claim is provable in the data (ADR-0035). The `machine` value stays
 * on the store for the day a detector arrives with an authenticated path of
 * its own.
 *
 * WHO the operator was is not recorded here, deliberately: there is no
 * operator identity in the Ledger, and inventing one for a break-glass verb
 * would be the wrong place to start. Reaching production at all is an
 * audited session (ADR-0016) feeding the same chain this appends to, and
 * that session is the answer to "who".
 *
 * NO BUNDLE, NO TWIN KEY — like `rig-finalize.ts`, and for a stricter
 * reason than convenience: an unmerge decides what two of the company's
 * records mean, and may not open an envelope to do it (ADR-0004). What it
 * needs is the Ledger and the chain key.
 *
 * IDEMPOTENT ON RETRY. A second run against the same merge reports that it
 * is already reversed and exits clean, because an operator who lost the
 * output of the first one should not have to tell a refusal from a failure.
 *
 * THE LISTING IS OPAQUE BY DEFAULT (ADR-0020: application logs carry
 * opaque ids only). An audited session's stdout is retained, so the two
 * records' names are behind `--names` — an operator who has to map «you
 * merged Ferretería Fuentes with somebody else» onto an edge asks for
 * them, and the asking is itself visible in the session transcript. The
 * value that MATCHED is never printed at all: it is a customer's phone,
 * email or tax ID, and it decides nothing here.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-unmerge.ts <companyId> [--names]
 *   node --experimental-strip-types scripts/rig-unmerge.ts <companyId> <mergeId>
 * The first form lists the company's merges so the wrong one can be found;
 * the second takes that one back. (build first: pnpm build)
 */
import {
  fileUnmerge,
  MergeAlreadyReversedError,
  MergeUnknownEdgeError,
  readEntityMerges,
} from "@dito/aperture";
import { hmacKeyFromEnv } from "@dito/audit";
import pg from "pg";

const USAGE =
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-unmerge.ts <companyId> [mergeId] [--names]";

/**
 * Both arguments are UUIDs, checked HERE rather than left to a Postgres
 * cast (Codex r3; the same rule `readSeamSource` applies to a seam row id).
 * A mistyped merge id is the likeliest operator error there is, and it must
 * land as this file's own refusal — `invalid input syntax for type uuid` on
 * a break-glass verb tells an operator nothing about what they did wrong.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const args = process.argv.slice(2);
// A MISTYPED FLAG STOPS THE RUN rather than being ignored, as `rig-extract`
// does: `--name` silently printing nothing is the confusion to avoid.
const flags = args.filter((arg) => arg.startsWith("--"));
const unknownFlags = flags.filter((flag) => flag !== "--names");
const [companyId, mergeId, ...rest] = args.filter(
  (arg) => !arg.startsWith("--"),
);
const withNames = flags.includes("--names");
const dbUrl = process.env["DITO_DATABASE_URL"];
if (
  companyId === undefined ||
  rest.length > 0 ||
  unknownFlags.length > 0 ||
  dbUrl === undefined
) {
  console.error(USAGE);
  process.exit(1);
}
for (const [label, value] of [
  ["company id", companyId],
  ["merge id", mergeId],
] as const) {
  if (value !== undefined && !UUID.test(value)) {
    console.error(`${label} ${JSON.stringify(value)} is not a UUID`);
    console.error(USAGE);
    process.exit(1);
  }
}

// Read before connecting: the chain key is fail-closed with no fallback
// (ADR-0020), and an operator who forgot to source `.env.rig` should find
// out before anything opens.
const hmacKey = hmacKeyFromEnv();

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  if (mergeId === undefined) {
    await list();
  } else {
    await reverse(mergeId);
  }
} finally {
  await db.end();
}

/**
 * What this company's merges are, so the operator can name the wrong one.
 *
 * OPAQUE BY DEFAULT, NAMED ON REQUEST — see the note at the top of this
 * file. `--names` is the one thing here that puts Ledger content on a
 * retained surface, so it is asked for rather than assumed; without it the
 * listing is ids, instants, status, rung and whether the edge still stands,
 * which is enough to reverse an edge whose id is already known.
 *
 * The names come off the edge's own effect set, which recorded them at
 * merge time — so this shows who the records WERE when they were joined,
 * which is the question, and adds no query.
 */
async function list(): Promise<void> {
  const edges = await readEntityMerges({ db }, companyId!);
  if (edges.length === 0) {
    console.log(`no merges recorded for company ${companyId}`);
    return;
  }
  console.log(`${edges.length} merge(s) for company ${companyId}:`);
  for (const edge of edges) {
    const when = edge.mergedAt.toISOString();
    const how = `${edge.performedBy}/${edge.matchedOn ?? "judgement"}`;
    const state =
      edge.reversal === null
        ? "STANDS"
        : `reversed ${edge.reversal.unmergedAt.toISOString()} (${edge.reversal.performedBy})`;
    console.log(`  ${edge.id}  ${when}  ${edge.status}  ${how}  ${state}`);
    console.log(`      ${named(edge.effectSet?.loser)}${edge.loserEntityId}`);
    console.log(`   -> ${named(edge.effectSet?.winner)}${edge.winnerEntityId}`);
  }
  if (!withNames) {
    console.log("(ids only — pass --names to print the two records' names)");
  }
}

/** A side's name as the merge recorded it, when the operator asked for it. */
function named(side: { readonly displayName?: string } | undefined): string {
  if (!withNames) return "";
  const name = side?.displayName;
  return name === undefined || name === "" ? "(unnamed) " : `«${name}» `;
}

/** Takes one merge back, and says what changed. */
async function reverse(id: string): Promise<void> {
  try {
    const edge = await fileUnmerge(
      { db, hmacKey },
      // The stamp is not a flag — see the note at the top of this file.
      { companyId: companyId!, mergeId: id, performedBy: "human" },
    );
    console.log(
      `reversed merge ${edge.id}: ${edge.loserEntityId} no longer resolves to ${edge.winnerEntityId}`,
    );
    console.log(
      "no fact moved, no grant changed, and the edge still records the merge that happened",
    );
    console.log(
      "the matcher will not redo this pair — a human took it apart (ADR-0035 as amended)",
    );
  } catch (err) {
    if (err instanceof MergeAlreadyReversedError) {
      // Not a failure: the operator asked for a state the store is already
      // in. Idempotent, like every other hand trigger beside this one.
      console.log(`merge ${id} was already reversed — nothing to do`);
      return;
    }
    if (err instanceof MergeUnknownEdgeError) {
      console.error(
        `no merge ${id} is recorded for company ${companyId} — run without a merge id to list them`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

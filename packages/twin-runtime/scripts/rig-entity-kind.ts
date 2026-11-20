/**
 * The rig's hand trigger for entity kinds (ticket #60; ADR-0035, ADR-0036,
 * ADR-0016, ADR-0020).
 *
 * `kind` decides whether ADR-0035's phone rung may fuse two records that
 * share a switchboard number, and from this ticket on every value in that
 * column is a MODEL DETERMINATION rather than a default nobody chose. Which
 * means some of them are wrong. This is the answer to "who corrects a wrong
 * one, and how would they notice" — the same actor and the same shape as
 * `rig-unmerge.ts` beside it: the operator, by hand, audit-chained.
 *
 * - **Not the rep.** ADR-0036 refuses to bill the rep for work that exists
 *   only because of how Dito is built, and the ceremony's «va» settles
 *   WHICH customer this chat is, not what kind of thing they are. Adding a
 *   second question to the one ceremony a rep must answer is precisely the
 *   architecture tax that ADR is about.
 * - **Not the owner.** No owner entity surface until slice 4.
 * - **Not the machine, on its own.** The model determines; nothing detects
 *   that a determination was WRONG, so the correction has a human in it.
 *
 * HOW A WRONG ONE IS NOTICED, which is the other half of the question. The
 * listing puts each entity's kind beside the name the rep confirmed, and
 * «Ferretería Fuentes» filed as a `person` is wrong at a glance. That listing
 * is the whole of what a session has: the ladder's own skip taxonomy — the
 * `kind_mismatch` count ADR-0035's phone rung turns on — has NO READER,
 * because extraction runs inside the runtime and `rig-extract.ts` asks for it
 * rather than running it (ticket #197), so `DailyExtractionResult.merges`
 * reaches no terminal and no store. A request that finds nothing to read still
 * climbs the ladder, which is the path back from a label this trigger has just
 * corrected.
 *
 * WHAT A CORRECTION DOES NOT DO. Reversing a merge is pair-scoped and
 * permanent (ticket #62): a `kind` fix that makes a merge correct after an
 * unmerge does NOT re-merge anything — the ladder never redoes a pair a
 * human took apart, and joining them again is a deliberate `fileMerge`. A
 * fix that unblocks a merge nobody ever made is different: the next daily
 * pass will simply climb the ladder and find it.
 *
 * THE LISTING IS OPAQUE BY DEFAULT (ADR-0020: an audited session's stdout
 * is a retained surface), so the names are behind `--names` — exactly as
 * `rig-unmerge.ts` does it, for the same reason and with the same tell in
 * the transcript.
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-entity-kind.ts <companyId> [--names]
 *   node --experimental-strip-types scripts/rig-entity-kind.ts <companyId> <entityId> person|business
 *   node --experimental-strip-types scripts/rig-entity-kind.ts <companyId> --backfill
 * The first form lists; the second corrects one, stamped `human`; the third
 * re-infers, stamped `model`. The third NEVER overrules the second: an
 * entity a human determined is left as they left it, so re-running the
 * sweep cannot silently un-fix a kind somebody went and corrected.
 *
 * `--backfill` OPENS TWIN MEMORY and calls the model, so the runtime must
 * NOT be up while it runs (one bundle, one holder) — stop `rig-run.ts`,
 * trigger, restart. The other two forms touch neither. (build first: pnpm build)
 */
import { KMSClient } from "@aws-sdk/client-kms";
import {
  EntityKindUnknownEntityError,
  ENTITY_KINDS,
  fileEntityKind,
  listFiledEntities,
  type EntityKind,
} from "@dito/aperture";
import { hmacKeyFromEnv } from "@dito/audit";
import pg from "pg";
import {
  backfillEntityKinds,
  entityKindModelConfig,
  harnessDirectoryBeside,
  openTwinMemory,
} from "../dist/index.js";

const USAGE =
  "usage: source .env.rig && node --experimental-strip-types scripts/rig-entity-kind.ts <companyId> [entityId person|business] [--names] [--backfill]";

/**
 * Both ids are UUIDs, checked HERE rather than left to a Postgres cast —
 * the rule `rig-unmerge.ts` adopted for the same reason: a mistyped id must
 * land as this file's own refusal, not as `invalid input syntax for type
 * uuid`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const args = process.argv.slice(2);
// A MISTYPED FLAG STOPS THE RUN rather than being ignored, as the other
// triggers do: `--backfil` silently listing is the confusion to avoid.
const flags = args.filter((arg) => arg.startsWith("--"));
const unknownFlags = flags.filter(
  (flag) => flag !== "--names" && flag !== "--backfill",
);
const [companyId, entityId, kind, ...rest] = args.filter(
  (arg) => !arg.startsWith("--"),
);
const withNames = flags.includes("--names");
const backfill = flags.includes("--backfill");
const dbUrl = process.env["DITO_DATABASE_URL"];
if (
  companyId === undefined ||
  rest.length > 0 ||
  unknownFlags.length > 0 ||
  dbUrl === undefined ||
  // A correction names both an entity and the kind it should carry.
  (entityId === undefined) !== (kind === undefined) ||
  (kind !== undefined && !ENTITY_KINDS.includes(kind as EntityKind)) ||
  (backfill && entityId !== undefined)
) {
  console.error(USAGE);
  process.exit(1);
}
for (const [label, value] of [
  ["company id", companyId],
  ["entity id", entityId],
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
  if (backfill) {
    await reinferAll();
  } else if (entityId === undefined) {
    await list();
  } else {
    await correct(entityId, kind as EntityKind);
  }
} finally {
  await db.end();
}

/** What this company's entities are, and what each one is labelled. */
async function list(): Promise<void> {
  const entities = await listFiledEntities({ db }, companyId!);
  if (entities.length === 0) {
    console.log(`no entities filed for company ${companyId}`);
    return;
  }
  console.log(`${entities.length} entity(ies) for company ${companyId}:`);
  for (const entity of entities) {
    const name = withNames ? ` «${entity.displayName}»` : "";
    console.log(
      `  ${entity.entityId}  ${entity.kind.padEnd(8)}  ${entity.createdAt.toISOString()}${name}`,
    );
  }
  if (!withNames) {
    console.log(
      "(ids only — pass --names to print each customer's name, which is what makes a wrong kind visible)",
    );
  }
}

/**
 * Sets one entity's kind by hand, stamped `human`.
 *
 * THE IDS ARE CANONICALIZED BEFORE THEY REACH THE APERTURE (Codex round 2 on
 * #176), and it is the one place they can be. `entityKindRef` renders the
 * ids as it is given them and `hasHumanDetermination` matches that reference
 * as EXACT TEXT — so a human determination recorded under an id an operator
 * typed or pasted in upper case would be invisible to the backfill, which
 * reads its ids back from Postgres in the canonical lower case. The model
 * would then file its own kind over a person's decision, which is the one
 * thing ADR-0035 says it may never do. Postgres does the canonicalizing,
 * because Postgres is what decides that two spellings are one uuid; the cast
 * also refuses a value that is not one at all, before anything is chained.
 */
async function correct(entity: string, to: EntityKind): Promise<void> {
  try {
    const canonical = await db.query<{ company: string; entity: string }>(
      "SELECT $1::uuid::text AS company, $2::uuid::text AS entity",
      [companyId!, entity],
    );
    const outcome = await fileEntityKind(
      { db, hmacKey },
      // The stamp is not a flag: a hand trigger IS a human, and the stamp
      // exists so «which of these did anybody actually look at?» is
      // answerable from the chain (ticket #60, ADR-0035).
      {
        companyId: canonical.rows[0]!.company,
        entityId: canonical.rows[0]!.entity,
        kind: to,
        determinedBy: "human",
      },
    );
    if (!outcome.changed) {
      console.log(`entity ${entity} is already ${to} — nothing to do`);
      return;
    }
    console.log(
      `entity ${entity}: ${outcome.previousKind} -> ${outcome.kind} (stamped human)`,
    );
    console.log(
      "request an extraction (rig-extract.ts) to climb the ladder now — a merge this label was blocking can then happen",
    );
    console.log(
      "(the SCHEDULED pass only reconciles a day it actually read a chat in, so a quiet company waits for a request — #55's remainder 1)",
    );
    console.log(
      "...but a pair a human UNMERGED stays apart forever: correcting a kind never re-merges (ticket #62)",
    );
  } catch (err) {
    if (err instanceof EntityKindUnknownEntityError) {
      console.error(
        `no entity ${entity} is filed for company ${companyId} — run without an entity id to list them`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/**
 * Re-infers every entity this twin bound, except the ones a human has
 * already ruled on — the backfill for records filed before anything
 * determined what they were.
 *
 * One model call per entity, which is why it is a hand trigger rather than
 * a startup pass: nothing in the store says "this one has been determined"
 * (the chain records every determination, but a chain is a record and not
 * an index), so a boot-time sweep would re-spend the call on every restart.
 */
async function reinferAll(): Promise<void> {
  const twinId = process.env["DITO_TWIN_ID"];
  if (twinId === undefined) {
    console.error("--backfill needs DITO_TWIN_ID (source .env.rig)");
    process.exit(1);
  }
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined) {
    console.error("--backfill needs ANTHROPIC_API_KEY (source .env.rig)");
    process.exit(1);
  }
  const bundlePath = new URL(
    `../../../rig-data/twin-${twinId}.bundle`,
    import.meta.url,
  ).pathname;
  const { bundle, dek } = await openTwinMemory({
    kms: new KMSClient({}),
    db,
    twinId,
    bundlePath,
  });
  try {
    const result = await backfillEntityKinds({
      db,
      bundle,
      dek,
      twinId,
      // The company the operator NAMED, checked against this twin's own
      // grants inside the sweep — a stale DITO_TWIN_ID must not quietly
      // send it at a different tenant (Codex r3).
      companyId: companyId!,
      harness: { directory: harnessDirectoryBeside(bundlePath), apiKey },
      // ITS OWN RUNG, AND ITS OWN VARIABLE (tickets #148 and #154). This
      // read `DITO_EXTRACTION_MODEL` until the extraction rung moved to
      // Sonnet 5 and took this harness — 256 max tokens, a counted second
      // submission — with it. #154 fixed the harness and moved this rung
      // too, so a backfill sweep runs on Sonnet 5 by default; the variable
      // that changes it names THIS rung, not the one next to it.
      kindModel: entityKindModelConfig({
        model: process.env["DITO_ENTITY_KIND_MODEL"],
      }),
      hmacKey,
    });
    const changed = result.determined.filter((d) => d.changed);
    console.log(
      `re-inferred ${result.determined.length} entity(ies): ${changed.length} changed, ` +
        `${result.handCorrected.length} left as a human set them, ` +
        `${result.skipped.length} left to another rep's twin`,
    );
    for (const one of result.determined) {
      const name = withNames ? ` «${one.displayName}»` : "";
      const move = one.changed
        ? `${one.previousKind} -> ${one.kind}`
        : `${one.kind} (unchanged)`;
      console.log(`  ${one.entityId}  ${move}${name}`);
    }
    if (!withNames && result.determined.length > 0) {
      console.log("(ids only — pass --names to check the determinations)");
    }
  } finally {
    bundle.close();
  }
}

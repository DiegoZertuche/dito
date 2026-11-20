/**
 * THE RUTINA STORE: AN AUTOMATION THE TWIN AUTHORED, AS TWO HALVES (ticket
 * #325; spec #318 decisions 28 and 29 as amended 2026-10-06; ADR-0014 as
 * amended: content in the bundle, an opaque coordination row in the seam;
 * FR-75; CONTEXT.md *Automation*, *Rutina*, *Schedule*, *Trigger*).
 *
 * A rutina is one wake plus one workflow definition — the `RunDefinition`
 * the thread writes for `start_workflow`, never a second kind. Its CONTENT —
 * the definition, with the rep's words inside its instructions, and the
 * twin's first-person sentence about it — is the bundle's
 * (`automation_definitions`, v13). Its ROW in the seam
 * (`…20261006100040_rutinas.sql`) is metadata: who asked, the
 * FR-75 state, the definition's digest, the wake as closed words and small
 * numbers. A cadence's wake is also one row of the clock store, written with
 * the rutina, so the pass that fires it reads the one `schedules` store.
 *
 * THE DIGEST JOINS THE HALVES: the row pins it when the twin writes, and the
 * content is read back only when its definition still digests to it — so a
 * run a rutina fires starts from exactly what the rep activated.
 *
 * WHO ASKED DECIDES WHEN IT GOES LIVE, ON THE TWIN'S WORD (Diego's ruling of
 * 2026-10-11, ticket #386): a rutina the rep asked for is active at the ask —
 * written and activated in one transaction, so the clock fires the first
 * instant at or after it — and one the twin proposed is `pending` until the
 * rep accepts its proposal card. Nothing here reads who asked: the caller
 * passes the twin's own `asked_by` through.
 *
 * A CHANGE TO AN ACTIVE RUTINA NEVER EDITS IT (FR-75's versions): the twin
 * writes a new rutina naming the one it replaces, and activating the new one
 * — at the ask, or on the card — ends the old in the same transaction. Runs
 * the old one fired keep running under their own pin.
 *
 * DESCARTAR ENDS THE ROW, DELETES THE CONTENT, AND ENDS WHAT IT HAS GOING: on
 * a proposal or an active rutina alike, the act's transaction marks the row
 * and its cadence row ended — never deleted, because the clock store keeps
 * every row it held, with its last firing readable (ADR-0010, 2026-10-06), and
 * the row is what that cadence row and the rutina's runs name — and cancels
 * every run of it still going, which the engine ends with its report at the
 * next pass, as a `cancel_run` does: nothing of a removed rutina keeps
 * running. And the act deletes its content once that has committed
 * (`deleteRutinaContent`). The seam row is the truth the two stores share no
 * transaction over, so a rolled-back act leaves both halves standing (Codex
 * r1); and the pass deletes any content no live row names
 * (`sweepRutinaContent`), which is the recovery for a process that died
 * between the two and for content a rolled-back turn wrote.
 *
 * DITO'S OWN AUTOMATIONS ARE ROWS OF THE SAME TABLE (`shipped-automations.ts`),
 * so every read here that serves the rep's rutinas asks for `origin <> 'dito'`
 * — their definitions are code's, never the bundle's.
 */
import type { Bundle } from "@dito/bundle";
import type { RutinaOrigin, RutinaState, RutinaTriggerEvent } from "@dito/seam";
import type pg from "pg";
import { runDigest, type RunDefinition } from "./definition.js";

/** A rutina's wake as code handles it. */
export type RutinaWake =
  | {
      readonly kind: "schedule";
      readonly every: "day" | "week";
      /** ISO weekdays, 1 = Monday, in ISO order; present exactly on a weekly cadence, one or more. */
      readonly weekdays?: readonly number[];
      readonly atHour: number;
    }
  | {
      readonly kind: "trigger";
      readonly event: RutinaTriggerEvent;
      /** The customer's reference number in the bundle, when it is about one. */
      readonly customer?: number;
    };

/** A rutina's seam row, as the reads and the clock take it. */
export interface RutinaRow {
  readonly id: string;
  readonly twinId: string;
  readonly seatId: string;
  readonly origin: RutinaOrigin;
  readonly state: RutinaState;
  readonly digest: string;
  readonly wake: RutinaWake;
  readonly replacesId: string | null;
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
}

interface RowShape {
  id: string;
  twin_id: string;
  seat_id: string;
  origin: RutinaOrigin;
  state: RutinaState;
  definition_digest: string;
  wake: "schedule" | "trigger";
  every: "day" | "week" | null;
  weekdays: number[] | null;
  at_hour: number | null;
  trigger_event: RutinaTriggerEvent | null;
  trigger_customer: number | null;
  replaces_id: string | null;
  created_at: Date;
  activated_at: Date | null;
}

const COLUMNS = `id, twin_id, seat_id, origin, state, definition_digest, wake, every, weekdays,
  at_hour, trigger_event, trigger_customer, replaces_id, created_at, activated_at`;

/** The rep's rutinas still standing: never Dito's own, never one Descartar or a replacement ended. */
const LIVE_RUTINA = "origin <> 'dito' AND ended_at IS NULL";

function rowOf(row: RowShape): RutinaRow {
  return {
    id: row.id,
    twinId: row.twin_id,
    seatId: row.seat_id,
    origin: row.origin,
    state: row.state,
    digest: row.definition_digest,
    wake:
      row.wake === "schedule"
        ? {
            kind: "schedule",
            every: row.every!,
            atHour: row.at_hour!,
            ...(row.weekdays === null ? {} : { weekdays: row.weekdays }),
          }
        : {
            kind: "trigger",
            event: row.trigger_event!,
            ...(row.trigger_customer === null ? {} : { customer: row.trigger_customer }),
          },
    replacesId: row.replaces_id,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

/** One rutina to write: both halves, and who wrote it. */
export interface NewRutina {
  readonly id: string;
  readonly twinId: string;
  readonly seatId: string;
  readonly origin: RutinaOrigin;
  readonly wake: RutinaWake;
  readonly definition: RunDefinition;
  readonly sentence: string;
  readonly replacesId?: string;
  readonly executionId: string;
  /** The line the turn that wrote it answered: the rep's message, or the turn itself when an event woke it. */
  readonly evidenceRef: string;
  readonly writtenAt: Date;
}

/**
 * Writes a rutina, `pending`: its content to the bundle, its row and — for a
 * cadence — its clock row to the seam, on the caller's connection. The caller
 * activates one the rep asked for in the same transaction (`activateRutina`).
 *
 * THE BUNDLE FIRST, the notepad's order: the two stores share no transaction,
 * and a seam row must never stand without content to read. A caller that
 * rolls back after this leaves content no row names, which nothing reads and
 * the pass sweeps.
 */
export async function insertRutina(db: pg.ClientBase, bundle: Bundle, rutina: NewRutina): Promise<void> {
  bundle.writeAutomation({
    id: rutina.id,
    definition: JSON.stringify(rutina.definition),
    sentence: rutina.sentence,
    writtenAt: rutina.writtenAt.toISOString(),
    executionId: rutina.executionId,
    evidenceRef: rutina.evidenceRef,
  });
  const { wake } = rutina;
  await db.query(
    `INSERT INTO automations (id, twin_id, seat_id, origin, state, definition_digest, wake,
                              every, weekdays, at_hour, trigger_event, trigger_customer,
                              replaces_id, created_by_execution_id)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      rutina.id,
      rutina.twinId,
      rutina.seatId,
      rutina.origin,
      runDigest(rutina.definition),
      wake.kind,
      wake.kind === "schedule" ? wake.every : null,
      wake.kind === "schedule" ? (wake.weekdays ?? null) : null,
      wake.kind === "schedule" ? wake.atHour : null,
      wake.kind === "trigger" ? wake.event : null,
      wake.kind === "trigger" ? (wake.customer ?? null) : null,
      rutina.replacesId ?? null,
      rutina.executionId,
    ],
  );
  if (wake.kind === "schedule") {
    await db.query(
      `INSERT INTO schedules (twin_id, kind, every, weekdays, at_hour, automation_id)
       VALUES ($1, 'cadence', $2, $3, $4, $5)`,
      [rutina.twinId, wake.every, wake.weekdays ?? null, wake.atHour, rutina.id],
    );
  }
}

/** One of this twin's rutinas, or `undefined` — the fence every act goes through. */
export async function readRutina(
  db: pg.ClientBase,
  twinId: string,
  id: string,
): Promise<RutinaRow | undefined> {
  const rows = await db.query<RowShape>(
    `SELECT ${COLUMNS} FROM automations WHERE twin_id = $1 AND id = $2 AND ${LIVE_RUTINA}`,
    [twinId, id],
  );
  const row = rows.rows[0];
  return row === undefined ? undefined : rowOf(row);
}

/** This twin's active rutinas, newest first — what Rutinas lists (ticket #386). */
export async function listActiveRutinas(db: pg.ClientBase, twinId: string): Promise<readonly RutinaRow[]> {
  const rows = await db.query<RowShape>(
    `SELECT ${COLUMNS} FROM automations WHERE twin_id = $1 AND ${LIVE_RUTINA} AND state = 'active'
      ORDER BY created_at DESC, id`,
    [twinId],
  );
  return rows.rows.map(rowOf);
}

/** A rutina's content, read back and held to the row's pin. */
export interface RutinaContent {
  readonly definition: RunDefinition;
  readonly sentence: string;
}

/**
 * The content the row pins — or `undefined` when the bundle holds none for it,
 * or holds a definition that is not the one the row pinned: a rutina never
 * fires, and is never shown, under a definition the rep did not see.
 */
export function rutinaContent(bundle: Bundle, row: RutinaRow): RutinaContent | undefined {
  const content = bundle.readAutomation(row.id);
  if (content === undefined) return undefined;
  const definition = JSON.parse(content.definition) as RunDefinition;
  if (runDigest(definition) !== row.digest) return undefined;
  return { definition, sentence: content.sentence };
}

/**
 * ACTIVAR: a `pending` rutina goes `active`, and the version it replaces —
 * when it names one of this twin's — is ended, in the caller's transaction,
 * with every other proposal to replace it, which is stale (Codex r3: two
 * changes to one rutina both active); `retired` names the rows ended, whose
 * content the caller deletes once it has committed. `undefined` when it was
 * not pending.
 */
export async function activateRutina(
  db: pg.ClientBase,
  args: { readonly twinId: string; readonly id: string },
): Promise<{ readonly retired: readonly string[] } | undefined> {
  // THE LINK IS CUT AS IT GOES ACTIVE, and read in the same statement: the
  // version it replaced is about to end, with every proposal still naming it,
  // and never this one.
  const activated = await db.query<{ replaces_id: string | null }>(
    `UPDATE automations a SET state = 'active', activated_at = clock_timestamp(), replaces_id = NULL
       FROM (SELECT id, replaces_id FROM automations
              WHERE twin_id = $1 AND id = $2 AND ${LIVE_RUTINA} FOR UPDATE) prior
      WHERE a.id = prior.id AND a.state = 'pending'
      RETURNING prior.replaces_id`,
    [args.twinId, args.id],
  );
  const row = activated.rows[0];
  if (row === undefined) return undefined;
  if (row.replaces_id === null) return { retired: [] };
  return { retired: await endRutina(db, { twinId: args.twinId, id: row.replaces_id }) };
}

/**
 * DESCARTAR, in the caller's transaction: the row and every proposal to
 * replace it ended, and its runs still going cancelled (the module header
 * argues it); the content is the caller's to delete once the transaction has
 * committed. The ids ended, or nothing when no such rutina is this twin's —
 * Dito's own are never discarded, only switched.
 */
export async function discardRutina(
  db: pg.ClientBase,
  args: { readonly twinId: string; readonly id: string },
): Promise<readonly string[] | undefined> {
  const ended = await endRutina(db, args);
  if (ended.length === 0) return undefined;
  await db.query(
    `UPDATE runs SET cancelled = true, last_change_at = clock_timestamp()
      WHERE twin_id = $1 AND automation_id = $2 AND ended_at IS NULL AND NOT cancelled`,
    [args.twinId, args.id],
  );
  return ended;
}

/**
 * The row ended, with every proposal still naming it as the version it would
 * replace, and the cadence row of each marked ended beside its last firing.
 * The ids ended — none when the rutina is not a live one of this twin's.
 */
async function endRutina(
  db: pg.ClientBase,
  args: { readonly twinId: string; readonly id: string },
): Promise<readonly string[]> {
  const target = await db.query(
    `SELECT 1 FROM automations WHERE twin_id = $1 AND id = $2 AND ${LIVE_RUTINA} FOR UPDATE`,
    [args.twinId, args.id],
  );
  if (target.rows.length === 0) return [];
  const ended = await db.query<{ id: string }>(
    `UPDATE automations SET ended_at = clock_timestamp()
      WHERE twin_id = $1 AND ${LIVE_RUTINA}
        AND (id = $2 OR (replaces_id = $2 AND state = 'pending'))
      RETURNING id`,
    [args.twinId, args.id],
  );
  const ids = ended.rows.map((row) => row.id);
  await db.query(
    `UPDATE schedules SET ended_at = clock_timestamp()
      WHERE twin_id = $1 AND automation_id = ANY($2::uuid[]) AND ended_at IS NULL`,
    [args.twinId, ids],
  );
  return ids;
}

/**
 * The bundle's half of a deletion whose seam half has committed: the content
 * of each rutina named. Never throws for a rutina's sake — the act it follows
 * has committed, and the pass's sweep deletes whatever this could not.
 */
export function deleteRutinaContent(bundle: Bundle, ids: readonly string[]): void {
  for (const id of ids) {
    try {
      bundle.deleteAutomation(id);
    } catch {
      // Left to `sweepRutinaContent`, the next pass.
    }
  }
}

/**
 * THE CONTENT NO LIVE ROW NAMES, DELETED — once a pass, after every turn of it has
 * committed, so no rutina a turn is still writing is ever taken for one that
 * was discarded: the thread's turns run inside the consumer's step and are
 * settled before the pass reaches here, and no other execution can write a
 * rutina (`create_automation` is the thread's own, never a run step's:
 * `catalog.ts`). It is also how the content of a version a rep-asked change
 * ended at the ask goes. How many it deleted.
 */
export async function sweepRutinaContent(
  db: pg.ClientBase,
  bundle: Bundle,
  twinId: string,
): Promise<number> {
  const held = bundle.listAutomationIds();
  if (held.length === 0) return 0;
  const named = await db.query<{ id: string }>(
    `SELECT id FROM automations WHERE twin_id = $1 AND id = ANY($2::uuid[]) AND ${LIVE_RUTINA}`,
    [twinId, held],
  );
  const standing = new Set(named.rows.map((row) => row.id));
  let swept = 0;
  for (const id of held) {
    if (!standing.has(id) && bundle.deleteAutomation(id)) swept += 1;
  }
  return swept;
}

/**
 * THE PROPOSAL CARD A TWIN-PROPOSED RUTINA WAITS ON (ticket #386), named on its
 * row in the caller's transaction once the post is written — the post carries
 * the rutina's id and the row the post's, so the canvas reads whether the card
 * still waits off the rutina's own state.
 */
export async function nameProposalPost(
  db: pg.ClientBase,
  args: { readonly twinId: string; readonly id: string; readonly postId: string },
): Promise<void> {
  await db.query("UPDATE automations SET proposal_post_id = $3 WHERE twin_id = $1 AND id = $2", [
    args.twinId,
    args.id,
    args.postId,
  ]);
}

/** The proposal card a rutina waits on, or nothing for one the rep asked for. */
export async function proposalPostOf(db: pg.ClientBase, twinId: string, id: string): Promise<string | undefined> {
  const rows = await db.query<{ proposal_post_id: string | null }>(
    "SELECT proposal_post_id FROM automations WHERE twin_id = $1 AND id = $2",
    [twinId, id],
  );
  return rows.rows[0]?.proposal_post_id ?? undefined;
}

/** The rutina a proposal card names, read off the card's own post, live or not — or nothing. */
export async function rutinaOfProposalPost(
  db: pg.ClientBase,
  twinId: string,
  postId: string,
): Promise<{ readonly id: string; readonly state: RutinaState; readonly ended: boolean } | undefined> {
  const rows = await db.query<{ id: string; state: RutinaState; ended: boolean }>(
    `SELECT id, state, ended_at IS NOT NULL AS ended FROM automations
      WHERE twin_id = $1 AND proposal_post_id = $2 AND origin <> 'dito'`,
    [twinId, postId],
  );
  return rows.rows[0];
}

/** Whether an id names one of Dito's own rows for this twin — the switch's target, never Descartar's. */
export async function isShippedRow(db: pg.ClientBase, twinId: string, id: string): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM automations WHERE twin_id = $1 AND id = $2 AND origin = 'dito' AND ended_at IS NULL",
    [twinId, id],
  );
  return rows.rows.length > 0;
}

/**
 * The crossing backlog (ticket #50), in the shape of the embedding
 * backlog (#32): bindings the rep confirmed BEFORE this build existed.
 *
 * The steering install is carried across slices, not rebuilt per slice —
 * so the bundle this runtime wakes up with already holds rep-confirmed
 * bindings whose `binding_confirmed` events are long since marked
 * processed. The consumer only crosses while processing a NEW
 * confirmation, so without this pass those entities never reach the
 * Ledger at all: the bundle names a customer the Ledger has never heard
 * of, and the first fact filed against that mirrored id fails its entity
 * foreign key. No seam event will ever re-deliver the confirmation.
 *
 * The rep act is not invented to make this work. Each binding's original
 * confirmation is still on the seam, and it is resolved the way the
 * matcher resolved it in the first place — deterministically, with no
 * model anywhere:
 *
 *   binding_question notice → its system_send → the executor's posted
 *   WhatsApp message id → the rep's own event that QUOTED that id and was
 *   dispositioned `binding_confirmed` → the question's own source event,
 *   whose payload names the chat.
 *
 * A binding whose confirmation cannot be resolved that way is LEFT ALONE
 * and reported, never filed on invented evidence: an unprovable crossing
 * is not one to make (ADR-0003).
 *
 * Restart-safe and idempotent by construction: the selection is "bindings
 * whose entity is not filed", and the aperture's own create is idempotent
 * on the client-minted id, so a killed run re-selects exactly what it
 * never wrote.
 *
 * EVERY KIND IS AN EXECUTION SINCE #176, and this sweep runs them
 * SEQUENTIALLY rather than opening a lane — a decision this ticket asked to
 * be recorded. A lane is a scheduler with a cap and a settle, and both are
 * answers to concurrency: `openLanes()` opens a pair PER PASS inside
 * `processPendingWaEvents` precisely so a lane cannot outlive the pass that
 * opened it (`lanes.ts`). This sweep runs once, before the poll loop starts,
 * with nothing else in flight — there is no pass to belong to and nothing to
 * interleave with, so a lane here would be a scheduler with one submitter,
 * a settle that awaits what the loop already awaits, and a second connection
 * borrowed for no reason. One binding at a time on this sweep's own
 * connection is what the code already did, and it is what the transaction
 * shape below assumes.
 *
 * A REFUSED CLASSIFICATION NOW LEAVES A TRACE, which is the one observable
 * change #176 makes here. The harness threw and this sweep counted the
 * binding as `undetermined` and moved on, leaving nothing behind; a refused
 * execution leaves a `failed` record and one chain entry, committed with
 * nothing else, and the binding is still reported and still skipped. The
 * next start asks again — the selection is unchanged.
 */
import type { Harness } from "@dito/execution";
import { randomUUID } from "node:crypto";
import {
  fileEntityCreate,
  readFiledEntity,
  type RepActEvidence,
} from "@dito/aperture";
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import { decodeWaMessagePayload } from "@dito/seam";
import type pg from "pg";
import { withDbTransaction } from "./db-tx.js";
import { classified, classifyBinding } from "./entity-kind/classify.js";
import { renderEntityCreateDisclosureLine } from "./grammar.js";
import type { ModelCallConfig } from "./model-config.js";

export interface CrossingBacklogDeps {
  readonly db: pg.Client;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly twinId: string;
  /**
   * The model, and the rung it is called on (ticket #60). A binding that
   * predates this build still mints an entity, and every entity's kind is
   * a determination something made rather than a default nobody chose —
   * so this sweep asks the same question of the same inputs the live
   * confirmation does.
   */
  readonly harness: Harness;
  readonly kindModel: ModelCallConfig;
  /**
   * The seat's IANA zone, for the classification's own «now» part. Unset
   * means the host clock, which is what the runtime's own deps mean by it
   * and what the rig runs on without `DITO_TIME_ZONE`.
   */
  readonly timeZone?: string;
  /**
   * The audit chain's HMAC key (ticket #54; ADR-0020). An entity create is
   * a class-2 rep act wherever it is filed from, so a backlog sweep chains
   * exactly as the live path does — a crossing this build files years after
   * the rep confirmed it is still a crossing somebody must be able to
   * audit.
   *
   * WHAT THIS SWEEP DOES NOT DO, recorded (Codex r1): it chains the creates
   * it FILES, and it skips the ones already standing. So a database carried
   * across from before chaining existed — which is exactly what the rig is,
   * and exactly why this sweep exists — keeps entity creates with no chain
   * entry, and `audit-verify` stays green because it checks the chain's
   * integrity rather than its coverage. Closing it is a decision, not a
   * patch: either the chain gets retroactive entries (which must then say
   * they were written at upgrade time, not at the act), or a completeness
   * audit goes red on any carried-across install until somebody rules on
   * it. Both belong to the closing steering session.
   */
  readonly hmacKey: Uint8Array;
}

export interface CrossingBacklogResult {
  /** Bindings whose entity this run filed. */
  readonly filed: number;
  /**
   * Chats whose confirmation could not be resolved on the seam, so nothing
   * was filed for them. Reported, never guessed at — and never fatal: an
   * unprovable binding must not stop the runtime from serving the rest.
   */
  readonly unresolved: readonly string[];
  /**
   * Chats whose kind the model would not determine, so nothing was filed
   * for them either (ticket #60). Held to the SAME rule as `unresolved`,
   * and for the same reason: this sweep runs before the loop starts, so one
   * binding the model chokes on must not cost the rep every other one. The
   * next start asks again — the selection is still "bindings whose entity
   * is not filed".
   *
   * The LIVE confirmation path is deliberately the opposite: a rep who just
   * said «va» is owed a loud failure rather than a silently skipped
   * crossing, and the runtime is fail-stop there.
   */
  readonly undetermined: readonly string[];
}

/** Files every rep-confirmed binding the Ledger has not yet heard about. */
export async function crossPendingBindings(
  deps: CrossingBacklogDeps,
): Promise<CrossingBacklogResult> {
  const bindings = deps.bundle.listChatBindings();
  if (bindings.length === 0) {
    return { filed: 0, unresolved: [], undetermined: [] };
  }

  const ctx = { db: deps.db, dek: deps.dek, hmacKey: deps.hmacKey };
  const confirmations = await resolveConfirmations(deps);
  let filed = 0;
  const unresolved: string[] = [];
  const undetermined: string[] = [];

  for (const binding of bindings) {
    const act = confirmations.get(binding.chatJid);
    if (act === undefined) {
      unresolved.push(binding.chatJid);
      continue;
    }
    // "Already filed?" is asked under the company the aperture WOULD file
    // it under — the one stamped on this very rep act — rather than under
    // whatever companies the twin's rows happen to mention. Asking under
    // the wrong one would answer "no" and file a second row.
    const standing = await readFiledEntity(ctx, {
      companyId: act.companyId,
      entityId: binding.entityId,
    });
    if (standing !== undefined) continue;

    // ONE EXECUTION PER BINDING, in one transaction with the create it
    // decides (ticket #176), through the same helper the live confirmation
    // and the hand-run backfill call.
    const outcome = await withDbTransaction(deps.db, async () => {
      const classification = await classifyBinding(
        {
          harness: deps.harness,
          db: deps.db,
          bundle: deps.bundle,
          twinId: deps.twinId,
          hmacKey: deps.hmacKey,
          executionId: randomUUID(),
          model: deps.kindModel.model,
          ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
        },
        binding,
      );
      // ONE UNJUDGEABLE CUSTOMER MUST NOT COST THE REP EVERY OTHER ONE: this
      // sweep runs before the loop starts, so it reports and carries on.
      //
      // WHAT CHANGED WITH #176: the harness left nothing behind when it
      // refused, so a binding this sweep skipped was visible only in the
      // report it returned. A refused classification now leaves a `failed`
      // record and one chain entry, committed here, and the binding is
      // reported and skipped exactly as before. A broken store, a broken
      // bundle or a broken key still stops the sweep — those are not "this
      // one customer could not be judged" — and `classifyBinding` rethrows
      // them rather than returning a refusal.
      if (!classified(classification)) return { undetermined: true };
      await fileEntityCreate(ctx, {
        twinId: deps.twinId,
        entityId: binding.entityId,
        kind: classification.kind,
        displayName: binding.displayName,
        evidence: act.evidence,
        disclosureText: renderEntityCreateDisclosureLine(),
      });
      return { undetermined: false };
    });
    if (outcome.undetermined) {
      undetermined.push(binding.chatJid);
      continue;
    }
    filed += 1;
  }
  return { filed, unresolved, undetermined };
}

interface ResolvedConfirmation {
  /**
   * The rep act that confirmed it, on whichever surface (#224). A thread
   * confirmation is the seam row and its message id; a dashboard one is the
   * `dashboard_acts` row the local API wrote for the button press.
   */
  readonly evidence: RepActEvidence;
  /** The company stamped on that act — the scope the create lands under. */
  readonly companyId: string;
}

/**
 * Chat JID → the rep act that confirmed its binding, resolved from the
 * seam alone. Deterministic end to end: a posted question's WhatsApp
 * message id, the rep event that quoted it, and the chat named inside the
 * question's own source payload.
 */
async function resolveConfirmations(
  deps: CrossingBacklogDeps,
): Promise<Map<string, ResolvedConfirmation>> {
  // Every binding question this twin actually POSTED, with the chat it
  // asked about — the chat lives in the question's source-event payload,
  // under the twin DEK (chat naming never leaves the envelope, #34).
  const asked = await deps.db.query<{
    wa_message_id: string;
    source_payload_enc: Buffer;
  }>(
    `SELECT x.wa_message_id, asked.payload_enc AS source_payload_enc
       FROM notices n
       JOIN send_commands sc ON sc.payload_ref = 'notice:' || n.id
       JOIN send_executions x ON x.command_id = sc.id
       JOIN wa_events asked ON asked.id = n.about_event_id
      WHERE n.twin_id = $1 AND n.kind = 'binding_question'`,
    [deps.twinId],
  );
  const chatByPostedId = new Map<string, string>();
  for (const row of asked.rows) {
    chatByPostedId.set(
      row.wa_message_id,
      decodeWaMessagePayload(deps.dek, row.source_payload_enc).chatJid,
    );
  }

  // Every confirmation the matcher already accepted, oldest first: the
  // FIRST «va» is the one that confirmed, exactly as the live path treats
  // a repeat.
  const confirmed = await deps.db.query<{
    id: string;
    company_id: string;
    payload_enc: Buffer;
  }>(
    `SELECT e.id, e.company_id, e.payload_enc
       FROM wa_event_processing p
       JOIN wa_events e ON e.id = p.event_id
      WHERE p.twin_id = $1 AND p.disposition = 'binding_confirmed'
      ORDER BY e.id`,
    [deps.twinId],
  );

  const byChat = new Map<string, ResolvedConfirmation>();
  for (const row of confirmed.rows) {
    const confirm = decodeWaMessagePayload(deps.dek, row.payload_enc);
    if (confirm.quotedMessageId === undefined) continue;
    const chatJid = chatByPostedId.get(confirm.quotedMessageId);
    if (chatJid === undefined || byChat.has(chatJid)) continue;
    byChat.set(chatJid, {
      evidence: {
        surface: "twin_thread",
        sourceEventId: row.id,
        waMessageId: confirm.messageId,
      },
      companyId: row.company_id,
    });
  }
  // ...AND THE CONFIRMATIONS THE REP MADE ON A CARD (#224). Added AFTER the
  // thread's, so `byChat.has` leaves the FIRST confirmation standing whichever
  // surface it came from — which is the rule the live path already follows for
  // a repeat yes, and the reason both loops read oldest-first.
  await addDashboardConfirmations(deps, byChat);
  return byChat;
}

/**
 * Every binding this twin's rep confirmed by pressing a card's button, with
 * the chat each one was about (#224).
 *
 * THE WALK IS THE THREAD'S, ONE JOIN SHORTER. A thread confirmation is found
 * by matching the rep's quoted message id against a POSTED question, because
 * the rail is what carries a quote; a dashboard act names the POST directly
 * (`dashboard_acts.post_id`), so the question's notice and its
 * `about_event_id` are two joins away and the chat is inside that event's
 * sealed payload exactly as before — chat naming never leaves the envelope
 * (#34).
 *
 * ONLY THE PRESSES THAT FOUND A BINDING, WHICH IS TWO WORDS AND NOT ONE
 * (Codex r1, a reachable failure). «Performed» is the obvious one. «Already»
 * has to be here too, because the bundle write is not inside this
 * transaction: a confirmation that wrote the binding and then failed before
 * its Postgres transaction committed leaves the binding standing and NO act
 * row at all — and the rep's next press then reads the bundle, answers
 * «already», and would be the only trace of a binding that never crossed. A
 * refused press is excluded: `unreadable` found nothing and `already_bound`
 * cannot occur here, since a bound chat is what «already» means.
 *
 * WHAT IS STILL NOT REPAIRED, said plainly: if the rep never presses again,
 * that binding stays out of the Ledger. The window is a failure between the
 * bundle write and the commit beside it, the two-store hazard both surfaces
 * carry — the thread survives it only because the rail re-delivers the
 * message. Recorded on #117.
 *
 * A CONFIRMATION WHOSE POST IS NOT A BINDING QUESTION IS NOT ONE, which the
 * join says rather than a filter: the API only ever writes `confirm_binding`
 * against a card carrying a question part, so a row that fails this join means
 * the store disagrees with itself and the honest answer is to find nothing.
 */
async function addDashboardConfirmations(
  deps: CrossingBacklogDeps,
  byChat: Map<string, ResolvedConfirmation>,
): Promise<void> {
  const confirmed = await deps.db.query<{
    id: string;
    company_id: string;
    payload_enc: Buffer;
  }>(
    `SELECT a.id, a.company_id, asked.payload_enc
       FROM dashboard_acts a
       JOIN posts p ON p.id = a.post_id AND p.twin_id = a.twin_id
       JOIN notices n
         ON n.id = p.notice_id AND n.kind = 'binding_question'
       JOIN wa_events asked ON asked.id = n.about_event_id
      WHERE a.twin_id = $1 AND a.verb = 'confirm_binding'
        AND a.outcome IN ('performed', 'already')
      ORDER BY a.acted_at, a.id`,
    [deps.twinId],
  );
  for (const row of confirmed.rows) {
    const chatJid = decodeWaMessagePayload(deps.dek, row.payload_enc).chatJid;
    if (byChat.has(chatJid)) continue;
    byChat.set(chatJid, {
      evidence: { surface: "dashboard", dashboardActId: row.id },
      companyId: row.company_id,
    });
  }
}

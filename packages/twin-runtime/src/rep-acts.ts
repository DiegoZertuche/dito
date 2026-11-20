/**
 * THE FOUR REP ACTS, ONCE, FOR BOTH SURFACES (ticket #224; spec #214
 * decision 2 and user story 35; ADR-0003, ADR-0013, ADR-0037 as amended).
 *
 * "As a rep, I want a wrong acknowledgment on the dashboard to be exactly as
 * safe as on the phone, so that a dashboard act and a thread act are one act."
 * That sentence is only true if there is ONE act, and this module is it: the
 * store logic of discarding a draft, retracting a line, and confirming or
 * declining a binding, with no opinion about how the rep asked.
 *
 * ═══ WHAT IS HERE, AND WHAT IS NOT
 *
 * The thread reaches these through TOOLS (`thread/acts.ts`): a model reads
 * what the rep meant, claims the one-act slot, cites the rep's own message as
 * evidence, and resolves the target from the post they QUOTED. The dashboard
 * reaches them through the local API: no model at all, the target is the post
 * whose card carried the button, and the evidence is the act row the API just
 * wrote.
 *
 * Everything in that paragraph stayed where it was. What moved is only what
 * both surfaces do IDENTICALLY — read the rows, decide, write, and say what
 * happened — because a second copy of «may this draft still be discarded» is a
 * second answer to it, and the two would drift on the first change to either.
 *
 * ═══ THE TARGET IS ALWAYS RESOLVED, NEVER PASSED
 *
 * Every function here takes an id the CALLER resolved from what the rep
 * pointed at — the quoted post, or the card's post — and never a target a
 * model or a request body named. That is `acts.ts`' rule TWO, and it is why
 * these take a draft id and a notice id rather than a request: by the time one
 * is called, "which thing" has already been decided by code walking from
 * something the rep can see.
 *
 * ═══ NONE OF THEM THROWS
 *
 * They run inside the caller's open transaction — the execution's record, its
 * chain entry, the receipt post and the marker all commit with the act — so an
 * exception would abort the transaction the account of the act has to commit
 * in. Every failure is a refusal in the return value, exactly as it is for the
 * tools (`thread/acts.ts`' header states the rule; this is where it is kept).
 */
import { randomUUID } from "node:crypto";
import {
  retractDisclosedFact,
  type RepActEvidence,
  type RetractionRefusal,
} from "@dito/aperture";
import type { Bundle, ChatBinding } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import { lockTwinForSend } from "@dito/seam";
import type pg from "pg";
import { decodeWaMessagePayload } from "./payload.js";

/** What an act needs of the world: one connection, two keys, the twin, the bundle. */
export interface RepActDeps {
  /**
   * THE CONNECTION THE CALLER'S TRANSACTION IS OPEN ON — borrowed, never the
   * runtime loop's own. `ThreadDeps.db` argues it in full: an act and its
   * account of itself are one commit or neither.
   */
  readonly db: pg.ClientBase;
  /** The twin's key — the aperture opens the rep's own seam row under it. */
  readonly dek: Dek;
  readonly twinId: string;
  /** The rep chain's key, for the acts that chain their own refusals. */
  readonly hmacKey: Uint8Array;
  /** The entity mirror (ADR-0004) — the only place a confirmed binding lands. */
  readonly bundle: Bundle;
}

/**
 * WHAT AN ACT DID, in the terms both surfaces need.
 *
 *   `performed` — it happened, first time.
 *   `already`   — it had already happened and still has. Idempotent, and the
 *                 rep is told so rather than told nothing: a repeat «no va»
 *                 and a second press of Descartar are the same event.
 *   `refused`   — the target is not in a state this act applies to, with the
 *                 REASON as a word rather than a sentence, so each surface
 *                 says it in its own voice (a receipt in the thread, chrome on
 *                 a card).
 *
 * THE REASON IS EACH ACT'S OWN, which is why this is generic rather than one
 * union of every word four acts can say (the two-axis review's Standards
 * axis). A caller that had to widen its handling to five reasons it cannot
 * reach would need a cast to narrow again — and a cast is exactly the thing a
 * closed set is for. So `dismissDraft` says `already_sent`, `written_again` or nothing,
 * `retractLine` hands the aperture's own `RetractionRefusal` straight out, and
 * the two binding acts say `already_bound` or `unreadable`.
 */
export type RepActOutcome<Refusal extends string> =
  | { readonly outcome: "performed" }
  | { readonly outcome: "already" }
  | { readonly outcome: "refused"; readonly reason: Refusal };

/**
 * The two ways a dismissal refuses: the draft was released by a tap — the
 * message went, or is in flight, and a receipt saying «discarded» would lie
 * (the rule #30 set) — or a fill wrote it again (ticket #342): the draft that
 * took its place is the one that waits, and a «discarded» about this one
 * would tell the rep their card went while its replacement stands.
 */
export type DismissRefusal = "already_sent" | "written_again";

/**
 * ...and the two ways a binding act does.
 *
 *   `already_bound` — a «no» arriving after the rep confirmed. It leaves the
 *                     binding standing: inferring an unbind from a decline
 *                     would let a stale question undo a confirmation (#49).
 *   `unreadable`    — the question's own record could not be read, so there is
 *                     nothing to answer. A broken store rather than something
 *                     the rep did.
 */
export type BindingRefusal = "already_bound" | "unreadable";

/**
 * THE TERMINAL DISMISSAL (ticket #30's act, shared at #224; ADR-0037 —
 * "dismissal is terminal").
 *
 * The row is the anti-tap lock and it is what makes the act terminal: the send
 * lock refuses a later «va» — and a later **Enviar** — off exactly this table,
 * so nothing about either tap path had to be taught about either surface.
 * `ON CONFLICT DO NOTHING` keeps a repeat idempotent, which is the behaviour
 * the keyword had.
 *
 * THE STATE IS RE-READ HERE RATHER THAN TRUSTED FROM A CALLER. On the thread's
 * path the draft's state was rendered into the prompt at construction and a
 * tap can land between then and now; on the dashboard's it was rendered into a
 * card the rep may have been looking at for a minute. Two executions run at
 * once (`lanes.ts`) and the rep's own «va» goes through the matcher on the
 * runtime's connection. So the rows decide, every time, whoever asked.
 *
 * ...AND THE ROWS ARE READ UNDER THE SEND WRITER'S OWN LOCK (Codex r1, a
 * reachable failure). Re-reading is not enough on its own, because the two
 * acts decide on each other's ABSENCE: this one refuses when the draft
 * carries a tap and the writer refuses when it carries a dismissal, in
 * different tables that no constraint spans. So an **Enviar** and a
 * **Descartar** arriving together would both read an untouched draft and both
 * commit — the customer gets the message and the rep is told it was
 * discarded. Taking `lockTwinForSend` first makes the two serial, and the
 * loser then reads what the winner wrote. It matters from this ticket on:
 * before it, every tap and every dismissal was decided by the lease holder
 * inside one pass.
 */
export async function dismissDraft(
  deps: RepActDeps,
  target: { readonly draftId: string; readonly evidence: RepActEvidence },
): Promise<RepActOutcome<DismissRefusal>> {
  await lockTwinForSend(deps.db, deps.twinId);
  const rows = await deps.db.query<{ tapped: boolean; dismissed: boolean; filled: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM taps WHERE draft_id = $1) AS tapped,
            EXISTS (SELECT 1 FROM draft_dismissals WHERE draft_id = $1) AS dismissed,
            EXISTS (SELECT 1 FROM draft_fills WHERE draft_id = $1) AS filled`,
    [target.draftId],
  );
  const state = rows.rows[0]!;
  if (state.tapped) {
    // TERMINAL THE OTHER WAY, and the keyword's own rule (#30): a draft
    // already released by a tap cannot be discarded.
    return { outcome: "refused", reason: "already_sent" };
  }
  // A DRAFT A FILL TOOK THE PLACE OF (ticket #342; Codex r1): a card left open
  // on the page still offers Descartar on it, and the replacement is what
  // waits. The fill takes this same lock, so the two are serial.
  if (state.filled) return { outcome: "refused", reason: "written_again" };
  if (state.dismissed) return { outcome: "already" };
  const evidence = evidenceColumns(target.evidence);
  await deps.db.query(
    `INSERT INTO draft_dismissals (draft_id, source_event_id, dashboard_act_id)
     VALUES ($1, $2, $3) ON CONFLICT (draft_id) DO NOTHING`,
    [target.draftId, evidence.sourceEventId, evidence.dashboardActId],
  );
  return { outcome: "performed" };
}

/**
 * THE RETRACTION (ticket #54's act, shared at #224).
 *
 * The aperture does the whole of it — it re-reads its own store to find the
 * fact, annotates it, writes its rep-side evidence row and chains the act or
 * its refusal — so what is here is the translation of its outcome into the one
 * both surfaces speak. The line id was resolved by the caller from a numbering
 * the rep was SHOWN (`disclosure_post_lines`, ADR-0034), which is the half of
 * the gate that is never model-produced.
 */
export async function retractLine(
  deps: RepActDeps,
  target: {
    readonly disclosureLineId: string;
    readonly evidence: RepActEvidence;
  },
): Promise<RepActOutcome<RetractionRefusal>> {
  const outcome = await retractDisclosedFact(
    { db: deps.db, dek: deps.dek, hmacKey: deps.hmacKey },
    {
      twinId: deps.twinId,
      disclosureLineId: target.disclosureLineId,
      evidence: target.evidence,
    },
  );
  if (!outcome.retracted) {
    return { outcome: "refused", reason: outcome.reason };
  }
  return outcome.alreadyRetracted
    ? { outcome: "already" }
    : { outcome: "performed" };
}

/**
 * THE DECLINED BINDING (ticket #49's verb, shared at #224).
 *
 * IT WRITES NOTHING, AND THAT IS THE ACT rather than a gap. "An unconfirmed
 * binding is the chat staying provisional, which is what an unanswered
 * question already means" — the keyword's own note, still true — and unbinding
 * a chat the rep already confirmed is a different act with no verb, which is
 * why a decline arriving late refuses instead of undoing anything.
 *
 * SO WHERE IS IT RECORDED? On the thread, in the event's processing marker and
 * the receipt post beside it; on the dashboard, in the `dashboard_acts` row and
 * the receipt post beside it. Both surfaces leave one more record than the
 * keyword did, which wrote the marker and said nothing at all.
 */
export async function declineBinding(
  deps: RepActDeps,
  target: { readonly aboutEventId: string },
): Promise<RepActOutcome<BindingRefusal>> {
  const asked = await askedQuestion(deps, target.aboutEventId);
  if (asked === undefined) return { outcome: "refused", reason: "unreadable" };
  const chatJid = asked.chatJid;
  if (deps.bundle.readChatBinding(chatJid) !== undefined) {
    return { outcome: "refused", reason: "already_bound" };
  }
  return { outcome: "performed" };
}

/**
 * THE CONFIRMED BINDING (ticket #34's ceremony, shared at #224; ADR-0004,
 * ADR-0035).
 *
 * The chat and the display name re-derive from the question's OWN source event
 * under the twin DEK — the values the rep was actually shown, never anything a
 * model or a request carried — and the binding lands only in the bundle's
 * entity mirror. An already-bound chat is left exactly as first confirmed: a
 * repeat yes, from either surface, reads back the binding that stands.
 *
 * THE LEDGER CROSSING IS NOT HERE, and that is where the two surfaces
 * genuinely differ rather than a step this one skips. Filing the entity needs
 * its KIND, and a kind is a model call — its own execution, its own occasion
 * (`entity_kind`), on both paths. The thread's router submits that execution
 * to the realtime lane the moment it has the binding; the dashboard's act is
 * deterministic by construction (a button is not a sentence, so there is
 * nothing to read), so it commits the binding and the runtime's own sweep
 * crosses it on its next pass — `crossDashboardConfirmations`, which exists
 * for exactly this and argues the latency it costs.
 *
 * Returns the binding that STANDS, so the receipt names what was stored rather
 * than what the question proposed — the two differ on the replay and repeat-yes
 * paths above.
 */
export async function confirmBinding(
  deps: RepActDeps,
  target: {
    /**
     * The customer-chat event the question was ABOUT — the anchor the binding
     * ceremony uses (#34), whose sealed payload names both the chat
     * and the push-name the question proposed.
     */
    readonly aboutEventId: string;
    /** When the rep confirmed — the binding's valid time, off the act's own row. */
    readonly confirmedAt: Date;
  },
): Promise<
  | {
      readonly outcome: "performed" | "already";
      /**
       * THE BINDING THAT STANDS after this call, not the one the question
       * proposed — the two differ on exactly the replay and repeat-yes paths
       * above, and both callers need it: the receipt names its display name and
       * the Ledger crossing carries its entity id across unchanged (ADR-0035).
       */
      readonly binding: ChatBinding;
    }
  | { readonly outcome: "refused"; readonly reason: BindingRefusal }
> {
  const asked = await askedQuestion(deps, target.aboutEventId);
  if (asked === undefined) return { outcome: "refused", reason: "unreadable" };
  const standing = deps.bundle.readChatBinding(asked.chatJid);
  if (standing !== undefined) return { outcome: "already", binding: standing };
  if (asked.pushName === undefined) {
    // Unrepresentable by construction: a question only ever mints FROM a
    // push-name (#34). A questionless name here is a corrupted ceremony, and
    // a refusal is the answer a transaction can commit.
    return { outcome: "refused", reason: "unreadable" };
  }
  const binding: ChatBinding = {
    chatJid: asked.chatJid,
    // Rep-side mints identity (ADR-0035): this uuid is the Ledger's entity id,
    // carried across unchanged when the crossing files it.
    entityId: randomUUID(),
    displayName: asked.pushName,
    confirmedAt: target.confirmedAt.toISOString(),
  };
  deps.bundle.confirmChatBinding(binding);
  return { outcome: "performed", binding };
}

/**
 * The chat one binding question asked about, and the name it proposed,
 * re-derived from the question's own source event under the twin DEK.
 *
 * THE ANCHOR IS THE CUSTOMER-CHAT EVENT and not the notice, because that is
 * what #34 anchored the once-ever rule, the confirmation and the decline on —
 * so every one of them reads the same column rather than a second answer to
 * "which chat". The chat and the push-name live inside that event's encrypted
 * payload and nowhere a model or a request body can reach.
 */
async function askedQuestion(
  deps: RepActDeps,
  aboutEventId: string,
): Promise<{ chatJid: string; pushName?: string } | undefined> {
  const res = await deps.db.query<{ payload_enc: Buffer }>(
    "SELECT payload_enc FROM wa_events WHERE id = $1 AND twin_id = $2",
    [aboutEventId, deps.twinId],
  );
  const payloadEnc = res.rows[0]?.payload_enc;
  if (payloadEnc === undefined) return undefined;
  const payload = decodeWaMessagePayload(deps.dek, payloadEnc);
  return {
    chatJid: payload.chatJid,
    ...(payload.pushName === undefined ? {} : { pushName: payload.pushName }),
  };
}

/**
 * WHICH EVENT A POSTED BINDING QUESTION WAS ABOUT, for the two callers that
 * hold the notice rather than the event.
 *
 * The thread's decline resolves a notice from the post the rep quoted, and the
 * dashboard's two acts resolve one from the post the card is; the router holds
 * the event directly, because the matcher gave it. One walk, so all three
 * agree about what a binding question is: a `binding_question` notice of this
 * twin, and the customer-chat event it names.
 */
export async function aboutEventOfQuestion(
  deps: Pick<RepActDeps, "db" | "twinId">,
  noticeId: string,
): Promise<string | undefined> {
  const res = await deps.db.query<{ about_event_id: string }>(
    `SELECT about_event_id::text AS about_event_id
       FROM notices
      WHERE id = $1 AND twin_id = $2 AND kind = 'binding_question'
        AND about_event_id IS NOT NULL`,
    [noticeId, deps.twinId],
  );
  return res.rows[0]?.about_event_id;
}

/**
 * The two nullable evidence columns, from whichever surface authorized the act.
 *
 * DECLARED HERE RATHER THAN IMPORTED FROM THE APERTURE, because these are the
 * columns of a store the aperture does not own: `draft_dismissals` is the twin
 * runtime's own table, and the aperture's `repActEvidenceColumns` is about the
 * three tables it writes. The rule is the same and stated in both places
 * because the tables are — including the refusal: a dismissal authorized by a
 * DOOR MESSAGE has no column here either, and for the reason the aperture's
 * own version states (ticket #261). A dismissal acts on the draft the rep
 * QUOTED, and the dashboard's composer has nothing to quote with, so no such
 * call is reachable; it throws rather than writing a null, so the column
 * arrives with the first act that has both a door and a target.
 */
function evidenceColumns(evidence: RepActEvidence): {
  readonly sourceEventId: string | null;
  readonly dashboardActId: string | null;
} {
  switch (evidence.surface) {
    case "twin_thread":
      return { sourceEventId: evidence.sourceEventId, dashboardActId: null };
    case "dashboard":
      return { sourceEventId: null, dashboardActId: evidence.dashboardActId };
    case "dashboard_message":
      throw new Error(
        `refusing to dismiss a draft evidenced by dashboard message ${evidence.dashboardMessageId}: draft_dismissals names a seam event or a dashboard act, and a door message is neither — a dismissal acts on the draft the rep quoted, and the door carries no quote (ticket #261)`,
      );
  }
}

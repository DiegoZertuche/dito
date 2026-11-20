/**
 * A REP ACT PERFORMED ON THE DASHBOARD, AS AN EXECUTION (tickets #224 and
 * #223; spec #214 decisions 2, 5 and 7, *The feed, in detail* and *Link day,
 * in detail*; ADR-0013, ADR-0014 as amended, ADR-0020, ADR-0037 as amended).
 *
 * The rep presses **Descartar**, **Retirar**, «Sí, es este cliente» or «No es
 * este cliente» on Inicio, flips a chat's switch on the scoping page, or
 * presses «Guardar» on *Mi libreta*; rep-web asks the runtime's local API; and
 * this is what happens. Seven acts, one shape, and every part of the shape is
 * something an act already owed on the other surface:
 *
 *   the ACT ROW — `dashboard_acts`, one per request, written first, because it
 *   is this run's class-2 evidence (ADR-0003) and the aperture re-reads it;
 *
 *   the GATE — `checkRepEvidence`, the same function the thread's tools go
 *   through (`thread/evidence.ts` argues why it is checked here at all when
 *   nothing can currently fail it), on the four card acts and the notebook
 *   edit — each writes twin-side state a model's tool also writes — and on
 *   neither scope switch (`runPostAct` argues the exemption);
 *
 *   the ACT — `rep-acts.ts` for the four, `scoping.ts` for the two, the
 *   bundle's own `writeNotepad` for the edit, in every case the same store
 *   logic the other caller of it uses;
 *
 *   the RECEIPT — a post, with the receipt part `composeReceiptPost` builds
 *   and the sentence `grammar.ts` owns, delivered to the twin thread by the
 *   same `system_send` a thread receipt takes. So the rep sees what happened
 *   on the card AND in their thread, in the thread's own grammar, which is
 *   «one act, two surfaces» seen from the output side. A SCOPE SWITCH AND THE
 *   NOTEBOOK EDIT POST NONE, and `runScopeAct` and `performNotepadEdit` argue
 *   why;
 *
 *   and the EXECUTION — one record and one content-free chain entry (ADR-0014
 *   as amended: "every unit of agentic work is an execution"; ADR-0020's pair).
 *
 * ═══ EVERY UNIT OF AGENTIC WORK IS AN EXECUTION, INCLUDING ONE WITH NO MODEL
 *
 * ADR-0014's amendment says every unit is an execution, and it says nothing
 * about a model being in it — the shape is "something happens, a trigger fires,
 * and that creates a workflow". A button press is something happening, and
 * what it creates is a workflow of exactly one deterministic step. Recording
 * it as an execution is what puts a rep's dashboard act in the same ledger as
 * their thread act: `audit-coverage.ts`' `rep_execution` class is stated as the
 * complement of the owner's, so it covers this occasion with no edit at all.
 *
 * WHAT THE RECORD SAYS ABOUT A RUN WITH NO MODEL IN IT. `iterations` is 0 and
 * both token counts are 0, because none were spent; `toolNames` is empty,
 * because no tool list was handed to anybody; and the instructions digest is
 * the constant below rather than a hash of nothing, which the store's own
 * `executions_digest_check` would refuse anyway. A boundary session reading
 * this table can therefore tell a deterministic act from a model turn by
 * looking at it.
 *
 * ═══ ONE TRANSACTION, AND THE ORDER INSIDE IT
 *
 * The act row, the act's own write, the execution's chain entry, its record,
 * the receipt post and that post's `system_send` all commit together or none
 * of them does — in that order. The chain entry precedes the record because
 * the append is fail-closed (a run whose reference cannot be rendered leaves
 * neither), and both precede the post because
 * `notices_execution_id_fkey` is deferrable and NOT deferred, so a post may
 * not name a record that is not there yet. That is ADR-0020's rule for the pair and `ThreadDeps.db`'s reason for
 * borrowing a connection: an act and its account of itself are one commit. It
 * also means a refused act leaves the act ROW behind — which is right, because
 * the rep really did press the button, and the record of a refusal is exactly
 * the thing a rep would later dispute. The notebook edit is the one act whose
 * write is not a Postgres row, so it cannot share this commit —
 * `performNotepadEdit` argues its two.
 *
 * ═══ NO MODEL, AND THEREFORE NO LEDGER CROSSING HERE
 *
 * `confirmBinding` writes the binding to the bundle's entity mirror and stops.
 * Filing the Ledger entity needs its KIND, and a kind is a model call with an
 * occasion of its own — so the crossing is a separate execution on both
 * surfaces. The thread's router hands it to the realtime lane; this one is
 * fired by the poll loop, which asks one indexed question per pass
 * (`hasUncrossedDashboardConfirmation` in `runtime.ts`) and runs
 * `crossPendingBindings` when the answer is yes.
 */
import { randomUUID } from "node:crypto";
import { appendAuditEntry } from "@dito/audit";
import { NOTEPAD_CAP, notepadLength } from "@dito/bundle";
import {
  executionAuditEntry,
  type DashboardActTrigger,
  type Disposition,
} from "@dito/execution";
import {
  DASHBOARD_ACT_VERB_OF_ROUTE,
  isOwnId,
  type DashboardAutomationActRoute,
  type DashboardAutomationActVerb,
  type DashboardPostActRoute,
  type DashboardPostActVerb,
  type DashboardRunActRoute,
  type DashboardRunActVerb,
  type DashboardScopeActRoute,
  type DashboardScopeActVerb,
  type TwinApiActOutcome,
  type TwinApiNotepadActResult,
} from "@dito/seam";
import { withDbTransaction } from "./db-tx.js";
import { chatOfDirectoryRow } from "./directory.js";
import { resolveDisclosureLineOfPost } from "./disclosure.js";
import { TwinExecutionStore, twinExecutionChain } from "./execution-store.js";
import { bindingAckReceipt, RECEIPTS } from "./grammar.js";
import { postReceipt, type NoticeKind } from "./notices.js";
import { clearable, openSealedParts } from "./posts.js";
import {
  aboutEventOfQuestion,
  confirmBinding,
  declineBinding,
  dismissDraft,
  retractLine,
  type RepActDeps,
} from "./rep-acts.js";
import { scopeChatIn, scopeChatOut, type ScopeChat } from "./scoping.js";
import { checkRepEvidence } from "./thread/evidence.js";
import { setAutomationPaused } from "./runs/pauses.js";
import {
  activateRutina,
  deleteRutinaContent,
  discardRutina,
  isShippedRow,
  proposalPostOf,
  readRutina,
  type RutinaRow,
} from "./runs/rutinas.js";
import { answerAsk } from "./runs/ask.js";
import { readRun, setFlag } from "./runs/store.js";
import type { SeatEvents } from "./seat-events.js";
import type { RaisedThreadEvent, ThreadEventSink } from "./thread/events.js";

/**
 * WHAT A RUN WITH NO INSTRUCTIONS STAMPS.
 *
 * `executions.instructions_digest` is 32 opaque hex characters for every run a
 * model was paid for — the stamp of what it was TOLD — and a deterministic act
 * was told nothing. A hash of the empty string would be a digest of
 * instructions that do not exist, and the empty string itself is refused by
 * `executions_digest_check`. So the column says the honest thing in a word a
 * reader of the table can act on.
 */
export const DETERMINISTIC_INSTRUCTIONS = "deterministic";

/** What performing a dashboard act needs: the acts' world, plus the thread. */
export interface DashboardActDeps extends RepActDeps {
  /** Where the receipt is posted — the rep's own thread (ADR-0006). */
  readonly selfChatJid: string;
  /**
   * THE TWIN'S HARNESS DIRECTORY (ticket #324), where each run's sealed
   * content lies — the answer to a question card is written there. Absent, a
   * card cannot be answered.
   */
  readonly harnessDirectory?: string;
  /**
   * WHO HEARS WHAT AN ACT ON A RUTINA DID, once it has committed (ticket
   * #386): the seat's open pages, when it settled a proposal card, and the
   * twin's day — the card settling, or what the rep did to an active rutina.
   */
  readonly events?: SeatEvents;
  readonly thread?: ThreadEventSink;
}

/** Which seat asked, and the twin the registry says it owns. */
export interface DashboardActScope {
  readonly companyId: string;
  readonly seatId: string;
}

/**
 * What the rep pressed, and on WHAT (ticket #223).
 *
 * A UNION RATHER THAN THREE INDEPENDENT OPTIONALS, which is `AskedFor`'s own
 * argument one module over: `postId`, `lineIndex` and `chatDirectoryId` are
 * set in two combinations and in no other, so three `undefined`s would be a
 * type saying «one of these is set» without saying which — and every reader
 * would assert two of them non-null to reach either.
 *
 * `target` IS DERIVED AND NEVER CHOSEN. The API reads it off
 * `DASHBOARD_ACT_TARGET_OF_ROUTE`, the record both sides share and the store's
 * own `dashboard_acts_target_by_verb_check` mirrors — so a route cannot arrive
 * here paired with the wrong shape, and adding a verb without an arm in that
 * CHECK is a red build rather than a constraint violation on a rep's tap.
 */
export type DashboardActRequest =
  | {
      readonly target: "post";
      readonly route: DashboardPostActRoute;
      /** The card the rep acted on, as the rep side identifies it. */
      readonly postId: string;
      /** The line number the rep's button named — `retractLine` only. */
      readonly lineIndex?: number;
      /** The rep's typed answer, by field — `answerAsk` only (ticket #324). */
      readonly answers?: unknown;
    }
  | {
      readonly target: "chat";
      readonly route: DashboardScopeActRoute;
      /** The directory row whose switch the rep flipped, never a chat JID. */
      readonly chatDirectoryId: string;
    }
  | {
      readonly target: "run";
      readonly route: DashboardRunActRoute;
      /** The workflow run the rep paused, took up again or cancelled on Trabajos (ticket #323). */
      readonly runId: string;
    }
  | {
      readonly target: "automation";
      readonly route: DashboardAutomationActRoute;
      /** A shipped automation's registry word or a rutina's id, as Rutinas served it (ticket #325). */
      readonly automation: string;
      /** The proposal card the button was pressed on, when it was (ticket #386). */
      readonly proposal?: string;
    };

/**
 * Performs one act and answers what happened, in the API's own four words.
 *
 * IT OPENS THE TRANSACTION rather than taking one open, because it is the unit
 * of work: nothing above it in the request has anything to commit, and
 * `appendAuditEntry` refuses autocommit outright.
 */
export async function performDashboardAct(
  deps: DashboardActDeps,
  scope: DashboardActScope,
  request: DashboardActRequest,
): Promise<TwinApiActOutcome> {
  const verb = DASHBOARD_ACT_VERB_OF_ROUTE[request.route];
  const executionId = randomUUID();
  const startedAt = new Date();
  // WHAT THE ACT OWES THE BUNDLE ONCE ITS ROWS HAVE COMMITTED (ticket #325,
  // Codex r1 and r2): the content of a rutina whose row this act deleted.
  // Never inside the transaction, which the bundle cannot roll back with it.
  let afterCommit: (() => void) | undefined;
  const outcome = await withDbTransaction(deps.db, async () => {
    // THE TARGET FIRST, UNDER THIS TWIN. A card is a post and a switch is a
    // directory row, and resolving either here is what makes the target the
    // rep's own: an id naming another twin's row answers nothing, so the act
    // is refused before anything is written. The predicate is the fence — the
    // same one `readFeed` uses on the read that drew the card, and the same
    // one the directory read uses on the list the switch came from.
    const resolved = await resolveAct(deps, request);
    if (resolved === undefined) {
      return await recordDashboardAct(deps, {
        executionId,
        startedAt,
        trigger: undefined,
        disposition: "no-action",
        outcome: "refused",
      });
    }
    // THE ACT ROW, WRITTEN BEFORE THE ACT. It is this run's evidence
    // (ADR-0003) and the aperture re-reads it under this twin, so it has to
    // exist — and it has to exist even when the act is then refused, because
    // the rep really did press the button.
    //
    // EXACTLY ONE OF THE TWO TARGET COLUMNS, which is what the store's
    // `dashboard_acts_one_target_check` refuses to let be otherwise: a post
    // act names a post and a scope act names a directory row, and neither
    // names both.
    const acted = await deps.db.query<{ id: string; acted_at: Date }>(
      `INSERT INTO dashboard_acts
         (company_id, seat_id, twin_id, post_id, chat_directory_id, run_id, automation, verb)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, acted_at`,
      [
        scope.companyId,
        scope.seatId,
        deps.twinId,
        resolved.kind === "post" ? resolved.target.postId : null,
        resolved.kind === "chat" ? resolved.target.directoryId : null,
        resolved.kind === "run" ? resolved.runId : null,
        resolved.kind === "automation" ? resolved.key : null,
        verb,
      ],
    );
    const act = acted.rows[0]!;
    const trigger: DashboardActTrigger = {
      kind: "dashboard_act",
      mechanism: "request",
      twinId: deps.twinId,
      dashboardActId: act.id,
      ...(resolved.kind === "post"
        ? { postId: resolved.target.postId }
        : resolved.kind === "chat"
          ? { chatDirectoryId: resolved.target.directoryId }
          : resolved.kind === "run"
            ? { runId: resolved.runId }
            : { automation: resolved.key }),
    };
    // THE TWO KINDS OF ACT RUN DIFFERENT CODE OVER DIFFERENT STORES, and the
    // branch is here rather than inside one switch so that each side's switch
    // is EXHAUSTIVE over exactly its own verbs (`DashboardPostActVerb` and
    // `DashboardScopeActVerb`, derived from the shared record) — no `default`
    // arm, which is the shape this repo refuses to write.
    const performed =
      resolved.kind === "automation"
        ? await runAutomationAct(deps, scope, resolved)
        : resolved.kind === "run"
        ? await runRunAct(deps, resolved)
        : resolved.kind === "chat"
        ? await runScopeAct(deps, {
            verb: resolved.verb,
            target: resolved.target,
            actId: act.id,
          })
        : await runPostAct(deps, {
            verb: resolved.verb,
            target: resolved.target,
            act,
            ...(resolved.lineIndex === undefined
              ? {}
              : { lineIndex: resolved.lineIndex }),
            ...(resolved.answers === undefined ? {} : { answers: resolved.answers }),
          });
    // THE EXECUTION'S PAIR IS WRITTEN BEFORE THE POST THAT NAMES IT, and the
    // order is the store's rather than a preference: `notices_execution_id_fkey`
    // is DEFERRABLE but not INITIALLY DEFERRED, so a notice naming a record
    // that does not exist yet is refused at the INSERT. The disclosure posts
    // from inside its own run and defers the constraint; this path has no such
    // constraint on it — the act is finished by now, so its disposition is
    // known and the record can go first.
    const recorded = await recordDashboardAct(deps, {
      executionId,
      startedAt,
      trigger,
      disposition: performed.disposition,
      outcome: performed.outcome,
    });
    // ...AND THE ACT ROW LEARNS WHAT IT ANSWERED, once, in this same
    // transaction. This is the dashboard's `wa_event_processing.disposition`:
    // audit coverage enumerates the acts that owe the chain an entry, and
    // «already» and «refused» owe different ones while leaving the same
    // absence of rows behind them — a repeat Retirar writes no retraction and
    // neither does a refused one. Without the word, the class that demands a
    // refusal entry would demand one from an act that correctly wrote none.
    await deps.db.query(
      "UPDATE dashboard_acts SET outcome = $1 WHERE id = $2",
      [performed.outcome, act.id],
    );
    // NOT ON A REPEAT PRESS (the two-axis review's Spec axis). A receipt is a
    // `system_send` — a real WhatsApp message into the rep's own thread — and
    // an `already` outcome changed nothing, so a second one would be the twin
    // telling them again about an act it did not perform. Every press still
    // leaves its act row and its execution, because the rep really did press
    // the button; what it does not leave is a message.
    //
    // A REFUSAL THE REP CAN ACT ON STILL GETS ONE, which is why the guard is
    // «not already» rather than «only performed»: a retraction after the
    // window is refused with the same reason the thread gives, and the rep
    // learns that from the receipt (the AC asks for it by name).
    //
    // THE THREAD IS THE OTHER WAY ROUND ON THE REPEAT, and the asymmetry is
    // the surfaces' rather than an inconsistency: a repeat «no va» is a NEW
    // REP MESSAGE, and a message the twin answered with silence would look
    // broken. A second button press is not a message.
    if (performed.outcome !== "already" && performed.receipt !== undefined) {
      // THE RECEIPT IS A POST, exactly as a thread act's is (#220): the
      // sentence is code's (ADR-0037's receipts rule), the part is a
      // `receipt`, and the `system_send` beside it puts it in the rep's own
      // thread in the thread's own grammar. So the thread renders the same act
      // the card did, which is the whole of «one act, two surfaces».
      await postReceipt(deps.db, {
        twinId: deps.twinId,
        selfChatJid: deps.selfChatJid,
        dek: deps.dek,
        kind: performed.receipt.kind,
        receipt: performed.receipt.text,
        executionId,
        // THE POST NAMES THE ACT IT ACKNOWLEDGES, which is what the thread's
        // own acks do with the rep's message id — `notices`' per-kind
        // constraints require an origin, so an acknowledgement nobody could
        // trace to a rep act is unrepresentable either way.
        about: { dashboardActId: act.id },
      });
    }
    afterCommit = performed.afterCommit;
    return recorded;
  });
  afterCommit?.();
  return outcome;
}

/**
 * «GUARDAR» ON *MI LIBRETA*: one act row, one new version of the notebook
 * (ticket #264; ADR-0033 as amended 2026-09-20 and 2026-09-25; ADR-0013 as
 * amended 2026-09-09).
 *
 * THE WHOLE NOTEBOOK IS THE UNIT, as it is for `write_notepad`: the rep's
 * text replaces the current version by appending a new one, the latest is
 * current, and an EMPTY text is the delete — a version with nothing in it,
 * after which the recipe renders the default line alone (`rep-notepad.ts`).
 * And like `write_notepad` it says which version it rewrites: a text composed
 * against a notebook the thread has since written is refused as `stale`, so a
 * rule the rep taught on the phone is never dropped by a save on the laptop.
 *
 * THE CAP IS CHECKED BEFORE ANYTHING IS WRITTEN, act row included. A text past
 * it is a parameter this act cannot take rather than an act the rep performed
 * and the store declined, so it answers with the store's own two numbers and
 * leaves no trace (`TwinApiNotepadOverCap` argues the missing text). The
 * store's CHECK is still what makes the bound a property of the bundle.
 *
 * THE ACT ROW IS THE EVIDENCE AND THE GATE READS IT BACK, exactly as a card's
 * act does: the notebook is twin-side state that `write_notepad` also writes,
 * so the version's `evidence_ref` is a `dashboard_acts` id the aperture has
 * verified as this twin's, and nothing a caller supplied.
 *
 * NO RECEIPT, NO POST, NO NOTICE, by ADR-0033's rule for this surface: the
 * edit is about the control the rep touched — the page re-reads the notebook
 * and «Guardado» is its answer — and a message in the thread about it would be
 * the twin reviewing the rep's own notes back to them.
 *
 * ═══ TWO STORES, AND THE EVIDENCE COMMITS FIRST (Codex r1)
 *
 * The act row is Postgres and the version is the bundle's SQLCipher file, and
 * the two share no transaction — so the order decides what a failure can
 * leave. The act row COMMITS before the version is written: a version can
 * therefore never stand without the evidence it names, whatever fails after
 * it. The version is then appended inside a second transaction that holds
 * the act row's lock and commits the account with it — the outcome stamp, the
 * execution's record and its chain entry — `performed` if the version landed,
 * `refused` if it did not.
 *
 * AND AN ACT WHOSE ACCOUNT NEVER LANDS IS SETTLED FROM THE BUNDLE (Codex r2).
 * A failure between the two commits — a crash, a lost connection, a refused
 * append — leaves an unstamped act row, with or without its version. The act
 * row is therefore the save's durable staging record: the runtime's pass
 * settles every unstamped notebook act past `NOTEPAD_EDIT_SETTLE_AFTER_MS`
 * (`settleUnaccountedNotepadEdits`), reading the bundle for the version that
 * act wrote. Both take the act row's lock before they touch the bundle
 * (`accountNotepadEdit`), so the account lands exactly once and never
 * contradicts the bundle, whichever of the two writes it.
 */
export async function performNotepadEdit(
  deps: RepActDeps,
  scope: DashboardActScope,
  edit: { readonly text: string; readonly basedOn: number },
): Promise<TwinApiNotepadActResult> {
  const chars = notepadLength(edit.text);
  if (chars > NOTEPAD_CAP) {
    return { outcome: "over_cap", cap: NOTEPAD_CAP, charsAttempted: chars };
  }
  const executionId = randomUUID();
  const startedAt = new Date();
  // NEITHER TARGET COLUMN: the notebook is the seat's own and has no id, so
  // the row is the verb and the scope (`dashboard_acts_notepad_target_check`).
  const act = await withDbTransaction(deps.db, async () => {
    const acted = await deps.db.query<{ id: string; acted_at: Date }>(
      `INSERT INTO dashboard_acts (company_id, seat_id, twin_id, verb)
       VALUES ($1, $2, $3, $4) RETURNING id, acted_at`,
      [
        scope.companyId,
        scope.seatId,
        deps.twinId,
        DASHBOARD_ACT_VERB_OF_ROUTE.editNotepad,
      ],
    );
    return acted.rows[0]!;
  });
  const checked = await checkedEvidence(deps, act.id);
  if (checked === undefined) {
    await accountNotepadEdit(deps, act, () => ({
      outcome: "refused",
      executionId,
      startedAt,
      answer: { outcome: "refused" },
    }));
    return { outcome: "refused" };
  }
  try {
    // THE VERSION IS APPENDED UNDER THE ACT ROW'S LOCK, inside its account's
    // transaction (Codex r3): the recovery pass takes the same lock before it
    // reads the bundle, so an act it has settled is never written to after,
    // and a version this request appended is never settled as refused.
    const answered = await accountNotepadEdit(deps, act, () => {
      const landed = appendVersion(deps, edit, {
        writtenAt: act.acted_at,
        executionId,
        evidenceRef: checked.dashboardActId,
      });
      return {
        outcome: landed.outcome === "performed" ? "performed" : "refused",
        executionId,
        startedAt,
        answer: landed,
      };
    });
    // SETTLED BEFORE THIS REQUEST REACHED THE LOCK, by the recovery pass —
    // which found no version, because none had been written. Nothing was.
    return answered ?? { outcome: "refused" };
  } catch (error) {
    // THE BUNDLE OR THE ACCOUNT FAILED, and the version may or may not have
    // landed before the transaction rolled back. The bundle is asked, under
    // the lock, exactly as the recovery pass asks it; if Postgres is gone
    // too, that pass settles the act later. The failure still reaches the
    // caller either way.
    await settleNotepadAct(deps, act).catch(() => undefined);
    throw error;
  }
}

/**
 * How long an unstamped notebook act is left to the request that wrote it.
 *
 * A save's two commits are milliseconds apart and rep-web gives up on the
 * request after ten seconds (`TWIN_API_ACT_TIMEOUT_MS`), so a minute is far
 * past any request still running — and the act row's lock makes a longer one
 * harmless anyway: whichever account takes it second writes nothing.
 */
export const NOTEPAD_EDIT_SETTLE_AFTER_MS = 60_000;

/**
 * A notebook act's account, decided under the act row's own lock — the stamp,
 * the execution's record and its chain entry in one transaction — or nothing,
 * when the act is already stamped (Codex r2, r3).
 *
 * THE LOCK IS THE WHOLE COORDINATION. The request that performed the act and
 * the pass that settles it both come through here, and `FOR UPDATE` puts
 * them in a line: whichever holds the row decides — `decide` runs inside the
 * transaction, so the request's version is appended there and the pass's
 * bundle read happens there — and whichever comes second finds the row
 * stamped, writes nothing and answers `undefined`. `decide` is synchronous,
 * which is what keeps the bundle read or write inside the lock.
 */
async function accountNotepadEdit(
  deps: RepActDeps,
  act: { readonly id: string },
  decide: () => {
    readonly outcome: TwinApiActOutcome;
    readonly executionId: string;
    readonly startedAt: Date;
    readonly answer: TwinApiNotepadActResult;
  },
): Promise<TwinApiNotepadActResult | undefined> {
  return await withDbTransaction(deps.db, async () => {
    const locked = await deps.db.query<{ outcome: string | null }>(
      "SELECT outcome FROM dashboard_acts WHERE id = $1 FOR UPDATE",
      [act.id],
    );
    if (locked.rows[0]?.outcome !== null) return undefined;
    const decided = decide();
    await deps.db.query("UPDATE dashboard_acts SET outcome = $1 WHERE id = $2", [
      decided.outcome,
      act.id,
    ]);
    await recordDashboardAct(deps, {
      executionId: decided.executionId,
      startedAt: decided.startedAt,
      trigger: {
        kind: "dashboard_act",
        mechanism: "request",
        twinId: deps.twinId,
        dashboardActId: act.id,
      },
      disposition: decided.outcome === "performed" ? "acted" : "no-action",
      outcome: decided.outcome,
    });
    return decided.answer;
  });
}

/**
 * One unaccounted notebook act, settled from what the bundle holds: its
 * version, under the execution id that version already carries, means it
 * performed; no version means it wrote nothing. Read under the act's lock.
 */
async function settleNotepadAct(
  deps: RepActDeps,
  act: { readonly id: string; readonly acted_at: Date },
): Promise<boolean> {
  const settled = await accountNotepadEdit(deps, act, () => {
    const version = deps.bundle.readNotepadByEvidence(act.id);
    return version === undefined
      ? {
          outcome: "refused",
          executionId: randomUUID(),
          startedAt: act.acted_at,
          answer: { outcome: "refused" },
        }
      : {
          outcome: "performed",
          executionId: version.executionId,
          startedAt: act.acted_at,
          answer: { outcome: "performed" },
        };
  });
  return settled !== undefined;
}

/**
 * Settles every notebook act whose account never landed (ticket #264, Codex
 * r2) — and answers how many it settled.
 *
 * `before` keeps a save that is still running out of the ordinary path
 * (`NOTEPAD_EDIT_SETTLE_AFTER_MS`); the lock in `accountNotepadEdit` is what
 * makes it safe when one runs longer than that.
 *
 * ONE INDEXED READ WHEN THERE IS NOTHING OWED, which is every pass but the one
 * after a failure — `dashboard_acts_by_twin` holds the twin and the instant.
 */
export async function settleUnaccountedNotepadEdits(
  deps: RepActDeps,
  before: Date,
): Promise<number> {
  const owed = await deps.db.query<{ id: string; acted_at: Date }>(
    `SELECT id, acted_at FROM dashboard_acts
      WHERE twin_id = $1 AND verb = $2 AND outcome IS NULL AND acted_at < $3
      ORDER BY acted_at`,
    [deps.twinId, DASHBOARD_ACT_VERB_OF_ROUTE.editNotepad, before],
  );
  let settled = 0;
  for (const act of owed.rows) {
    if (await settleNotepadAct(deps, act)) settled += 1;
  }
  return settled;
}

/**
 * The version, compared and appended — or the reason it was not.
 *
 * SYNCHRONOUS, AND THAT IS THE LOCK: the bundle is one synchronous connection
 * shared by every lane (`lanes.ts`), so with no await from the read to the
 * insert no thread write can land between the version compared and the one
 * appended — `write_notepad`'s own argument.
 */
function appendVersion(
  deps: RepActDeps,
  edit: { readonly text: string; readonly basedOn: number },
  provenance: {
    readonly writtenAt: Date;
    readonly executionId: string;
    readonly evidenceRef: string;
  },
): TwinApiNotepadActResult {
  const standing = deps.bundle.readNotepad()?.version ?? 0;
  if (standing !== edit.basedOn) return { outcome: "stale", version: standing };
  const written = deps.bundle.writeNotepad({
    text: edit.text,
    // VALID TIME IS THE ACT ROW'S, the instant the rep pressed Guardar.
    writtenAt: provenance.writtenAt.toISOString(),
    executionId: provenance.executionId,
    evidenceRef: provenance.evidenceRef,
  });
  // THE CAP WAS COMPARED BEFORE THE ACT ROW against the same string by the
  // same count, so this arm means the two disagree — a refusal, not a write.
  return written.outcome === "written"
    ? { outcome: "performed" }
    : { outcome: "refused" };
}

/** One act's result: what to tell the caller, what to post, what to record. */
interface PerformedAct {
  readonly outcome: TwinApiActOutcome;
  readonly disposition: Disposition;
  /** The line the rep reads in their thread, where code owns one. */
  readonly receipt?: { readonly kind: NoticeKind; readonly text: string };
  /** What the act does in the bundle once its rows have committed. */
  readonly afterCommit?: () => void;
}

/**
 * Runs the act the verb names, through the gate and then through
 * `rep-acts.ts`.
 *
 * THE GATE IS THE SAME ONE THE THREAD'S TOOLS GO THROUGH, and it is asked with
 * the act row's own id as both the wake and the citation — because on this
 * surface the API is the citer and it minted that row one statement ago
 * (`checkRepEvidence` argues why the comparison is still made). What the gate
 * really buys here is its SECOND check: the aperture re-reads the row under
 * this twin, so an act row of another twin — or none at all — is refused before
 * a store is touched.
 *
 * ...AND THE TWO SCOPE ACTS DO NOT GO THROUGH IT, which is a decision and not
 * an omission (ticket #223). The rep-evidenced gate is ADR-0013's fence on a
 * TOOL: it asks whether the thing about to be written cites a rep act, because
 * a model chose the call. A scope switch has no model in it and cites nothing —
 * the target is a row the lease holder itself listed, the fence is the twin
 * predicate on that row, and the evidence is the act row this function was
 * handed. Running the gate would compare the act row's id against itself and
 * then hand `rep-acts.ts` a value `scopeChatIn` does not take, which is a check
 * whose only effect would be to look like one.
 */
async function runPostAct(
  deps: DashboardActDeps,
  args: {
    readonly verb: DashboardPostActVerb;
    readonly target: PostTarget;
    readonly act: { readonly id: string; readonly acted_at: Date };
    readonly lineIndex?: number;
    readonly answers?: unknown;
  },
): Promise<PerformedAct> {
  const post = args.target;
  const checked = await checkedEvidence(deps, args.act.id);
  if (checked === undefined) {
    return { outcome: "refused", disposition: "no-action" };
  }
  switch (args.verb) {
    case "dismiss_draft": {
      if (post.draftId === null) return refusedAct();
      const outcome = await dismissDraft(deps, {
        draftId: post.draftId,
        evidence: checked,
      });
      return outcome.outcome === "refused"
        ? refusedAct()
        : {
            outcome: outcome.outcome,
            disposition: "acted",
            receipt: { kind: "dismissal_ack", text: RECEIPTS.dismissed },
          };
    }
    case "retract_line": {
      // THE LINE IS RESOLVED AGAINST THE NUMBERING THE POST PRINTED, by the
      // same walk the thread's «N no» makes (ADR-0034): a number that post
      // never showed resolves to nothing, so the card cannot name a line the
      // rep was not shown.
      if (post.noticeId === null || args.lineIndex === undefined) {
        // A DEFINITE ACT REFUSED CHAINS (Diego's standing rule, quoted in
        // `audit-coverage.ts`): the rep pressed a button that names a line, so
        // this is not a verb that never resolved. It is chained HERE because
        // the aperture never sees it, exactly as the thread's tool chains its
        // own `unknown_line`.
        await chainRetractRefusal(deps, args, "no_record_lines");
        return refusedAct();
      }
      const line = await resolveDisclosureLineOfPost(deps, {
        noticeId: post.noticeId,
        lineIndex: args.lineIndex,
      });
      if (line === undefined) {
        await chainRetractRefusal(deps, args, "unknown_line");
        return refusedAct();
      }
      const outcome = await retractLine(deps, {
        disclosureLineId: line.disclosureLineId,
        evidence: checked,
      });
      if (outcome.outcome === "refused") {
        // `window_closed` IS THE ONE REFUSAL WITH ITS OWN WORD ON THE WIRE,
        // because the rep can read it: the window shut, and the record is firm.
        // The receipt is the thread's own microcopy for the same refusal, so
        // both surfaces say the same thing (the AC's «the same reason the
        // thread gives»).
        const reason =
          outcome.reason === "window_closed" ? "window_closed" : "not_a_fact";
        return {
          outcome: reason === "window_closed" ? "window_closed" : "refused",
          // `no-action` AND NOT `acted`, because nothing was retracted. The
          // run posted a receipt saying why, which is what the rep reads —
          // but a disposition is what the run DID, and a refused correction
          // did nothing to the record. The thread's own refusal is the same
          // shape: `performed: false` with a seam word beside it.
          disposition: "no-action",
          receipt: {
            kind: "correction_refusal",
            text: RECEIPTS.correctionRefused(reason),
          },
        };
      }
      return {
        outcome: outcome.outcome,
        disposition: "acted",
        receipt: {
          kind: "correction_ack",
          text: RECEIPTS.retracted(args.lineIndex),
        },
      };
    }
    case "confirm_binding": {
      if (post.noticeId === null) return refusedAct();
      const aboutEventId = await aboutEventOfQuestion(deps, post.noticeId);
      if (aboutEventId === undefined) return refusedAct();
      const outcome = await confirmBinding(deps, {
        aboutEventId,
        // VALID TIME IS THE ACT ROW'S OWN INSTANT, never this pass's clock:
        // the binding records when the rep confirmed (`dashboard_acts.acted_at`).
        confirmedAt: args.act.acted_at,
      });
      if (outcome.outcome === "refused") return refusedAct();
      return {
        outcome: outcome.outcome,
        disposition: "acted",
        receipt: {
          kind: "binding_ack",
          // THE NAME THAT WAS STORED, not the one the question proposed: a
          // repeat yes reads back the binding that stands (#49's rule).
          text: bindingAckReceipt(outcome.binding.displayName),
        },
      };
    }
    case "decline_binding": {
      if (post.noticeId === null) return refusedAct();
      const aboutEventId = await aboutEventOfQuestion(deps, post.noticeId);
      if (aboutEventId === undefined) return refusedAct();
      const outcome = await declineBinding(deps, { aboutEventId });
      if (outcome.outcome === "refused") return refusedAct();
      return {
        outcome: outcome.outcome,
        disposition: "acted",
        receipt: { kind: "binding_ack", text: RECEIPTS.bindingDeclined },
      };
    }
    case "answer_ask": {
      // THE ONE ANSWER PATH (ticket #324; `runs/ask.ts`), the thread's
      // `answer_ask` being its other door. NO RECEIPT: the card shows it is
      // answered, and the run that takes the answer up lands what it does
      // next — runs land cards, the thread speaks (decision 25).
      const answered = await answerAsk(
        {
          db: deps.db,
          dek: deps.dek,
          twinId: deps.twinId,
          ...(deps.harnessDirectory === undefined ? {} : { harnessDirectory: deps.harnessDirectory }),
        },
        { postId: post.postId, answers: args.answers },
      );
      return answered.answered ? { outcome: "performed", disposition: "acted" } : refusedAct();
    }
    case "clear_card":
      return await clearCard(deps, post, args.act.id);
  }
}

/**
 * «LISTO» (ticket #368; ruled 2026-10-08): the rep takes a card that has no
 * act of its own — a report, a document, a list — off the canvas. The act row
 * this run already wrote is the whole of the effect: the canvas's candidate
 * query and the feed both read the performed row, so nothing else is written
 * and no receipt is posted — the card leaving is what the rep sees, and the
 * acts log keeps the act.
 *
 * REFUSED ON A CARD WITH ACTS OF ITS OWN (`clearable`): a draft, a question or
 * the day's notes is settled by its own buttons, never put away unanswered.
 * A SECOND «LISTO» ON ONE CARD is `already`, as a second press of any act is
 * — and two at once take turns under a lock on the card.
 */
async function clearCard(
  deps: DashboardActDeps,
  post: PostTarget,
  actId: string,
): Promise<PerformedAct> {
  const row = await deps.db.query<{ parts_enc: Buffer | null }>(
    "SELECT parts_enc FROM posts WHERE id = $1 AND twin_id = $2",
    [post.postId, deps.twinId],
  );
  const sealed = row.rows[0]?.parts_enc ?? null;
  if (sealed === null || !clearable(openSealedParts(deps.dek, sealed))) return refusedAct();
  // TWO PRESSES TAKE TURNS (Codex r2): each act runs on its own connection,
  // so without a lock both would read no earlier «Listo» and both perform.
  // The second waits for the first to commit, then reads it and is `already`.
  await deps.db.query("SELECT pg_advisory_xact_lock(hashtextextended('dito:clear_card:' || $1, 0))", [post.postId]);
  const earlier = await deps.db.query(
    `SELECT 1 FROM dashboard_acts
      WHERE twin_id = $1 AND post_id = $2 AND verb = 'clear_card' AND outcome = 'performed' AND id <> $3
      LIMIT 1`,
    [deps.twinId, post.postId, actId],
  );
  if ((earlier.rowCount ?? 0) > 0) return { outcome: "already", disposition: "no-action" };
  return { outcome: "performed", disposition: "acted" };
}

/** A refusal, with the disposition that goes with an act that did nothing. */
function refusedAct(): PerformedAct {
  return { outcome: "refused", disposition: "no-action" };
}

/**
 * WHO THE CHAIN NAMES FOR A REFUSAL THE APERTURE NEVER SAW.
 *
 * The aperture chains the two it decides itself (`not_a_fact`,
 * `window_closed`) under its own name, whichever surface asked. The two a
 * dashboard act refuses BEFORE the aperture — a card carrying no record, and a
 * line number that post never printed — are this module's, so the entry says
 * so: "the identity a reader wants is the component that performed or refused
 * the act" (`thread/acts.ts`' own note, one surface over).
 */
const DASHBOARD_ACT_CALLER = "dashboard_act";

/**
 * The chain entry for a retraction refused before the aperture saw it.
 *
 * OPAQUE IDS ONLY (ADR-0020): the act row, the twin, and the number the rep's
 * button named — which is a position in a post, not content. Never the line's
 * text, which this path never read.
 */
async function chainRetractRefusal(
  deps: DashboardActDeps,
  args: {
    readonly act: { readonly id: string };
    readonly lineIndex?: number;
  },
  reason: string,
): Promise<void> {
  await appendAuditEntry(deps.db, deps.hmacKey, {
    caller: DASHBOARD_ACT_CALLER,
    action: "fact_retraction",
    ref: `twin:${deps.twinId} index:${String(args.lineIndex ?? "none")} act:${args.act.id}`,
    outcome: `refused:${reason}`,
  });
}

/**
 * The gate, or nothing.
 *
 * `undefined` RATHER THAN THE REFUSAL SENTENCE, because that sentence is
 * written for a MODEL to relay (`checkRepEvidence`'s own note) and there is no
 * model on this surface. What the rep reads is chrome on the card, off a
 * closed set of words — so the reason stays inside the runtime, where the
 * chain entry's disposition records that an act was refused.
 */
async function checkedEvidence(
  deps: RepActDeps,
  dashboardActId: string,
): Promise<
  { readonly surface: "dashboard"; readonly dashboardActId: string } | undefined
> {
  const checked = await checkRepEvidence(
    { db: deps.db, dek: deps.dek, twinId: deps.twinId },
    { surface: "dashboard", dashboardActId },
    dashboardActId,
  );
  if (!checked.ok) return undefined;
  // The gate answers with the aperture's own evidence value, whose dashboard
  // arm is exactly this pair.
  return checked.evidence.surface === "dashboard" ? checked.evidence : undefined;
}

/** A card, resolved under this twin: the post and the two deliveries it may be. */
interface PostTarget {
  readonly postId: string;
  readonly noticeId: string | null;
  readonly draftId: string | null;
}

/** A chat, resolved under this twin, as the scoping page's own row. */
interface ChatTarget {
  readonly directoryId: string;
  /**
   * BOTH SPELLINGS OF THE CHAT the row names, neither of which leaves this
   * process (ADR-0004). A scope-out has to name both or it leaves half a chat
   * allowed (`scopeChatOut` argues it).
   */
  readonly chat: ScopeChat;
}

/**
 * WHAT THE REP ACTED ON AND WHAT THEY DID TO IT, resolved under this twin.
 *
 * ONE UNION SO THE ACT ROW AND THE TRIGGER CAN BOTH READ IT. Both need to know
 * which column to fill and which id to name, and a shape with two nullable
 * fields would make «exactly one of them» a thing every reader checks rather
 * than a thing the type says.
 *
 * AND THE VERB TRAVELS WITH THE TARGET, which is what makes the two runners
 * below need no guard at all: `dashboard_acts_target_by_verb_check` says in
 * the store that a scope verb names a directory row and a post verb names a
 * post, and this says the same thing in the type — so narrowing on `kind`
 * hands each runner exactly the target its verbs can act on. A pair that
 * disagreed would not compile, which is a better fence than a branch that
 * returns a refusal no request can reach.
 */
type ResolvedAct =
  | {
      readonly kind: "post";
      readonly verb: DashboardPostActVerb;
      readonly target: PostTarget;
      /** The line number the rep's button named — `retractLine` only. */
      readonly lineIndex?: number;
      /** The rep's typed answer — `answerAsk` only. */
      readonly answers?: unknown;
    }
  | {
      readonly kind: "chat";
      readonly verb: DashboardScopeActVerb;
      readonly target: ChatTarget;
    }
  | {
      readonly kind: "run";
      readonly verb: DashboardRunActVerb;
      readonly runId: string;
      /** Whether the run has ended — no flag lands on a run that is over. */
      readonly ended: boolean;
      readonly paused: boolean;
      readonly cancelled: boolean;
    }
  | {
      readonly kind: "automation";
      readonly verb: DashboardAutomationActVerb;
      /** What the act row names: the automation's row id. */
      readonly key: string;
      /** The rutina's row, for a rep's rutina — absent for one of Dito's. */
      readonly rutina?: RutinaRow;
      /** The proposal card the button was pressed on, when it was (ticket #386). */
      readonly proposal?: string;
    };

/**
 * ...and the read that resolves it, by what the route acts on.
 *
 * THE ID IS SHAPE-CHECKED BEFORE A QUERY RUNS, on both arms, so a value that is
 * not an id never reaches a `uuid` cast — and the TWIN is in the predicate
 * either way, which is the whole fence: an id naming another twin's row answers
 * nothing at all, so the act is refused with no act row behind it.
 *
 * THE VERB COMES OFF THE ROUTE HERE, in the one place the route is still in
 * hand, so what the caller holds afterwards is a target and a verb that agree
 * by construction (`ResolvedAct` argues why that matters).
 */
async function resolveAct(
  deps: DashboardActDeps,
  request: DashboardActRequest,
): Promise<ResolvedAct | undefined> {
  if (request.target === "automation") {
    const verb = DASHBOARD_ACT_VERB_OF_ROUTE[request.route];
    if (!isOwnId(request.automation)) return undefined;
    // EVERY CARD ON RUTINAS IS A ROW, Dito's and the rep's alike (ticket
    // #364): a rutina's carries its content, one of Dito's carries its switch.
    const rutina = await readRutina(deps.db, deps.twinId, request.automation);
    if (rutina !== undefined) {
      return {
        kind: "automation",
        verb,
        key: rutina.id,
        rutina,
        ...(request.proposal === undefined ? {} : { proposal: request.proposal }),
      };
    }
    const shipped = await isShippedRow(deps.db, deps.twinId, request.automation);
    return shipped ? { kind: "automation", verb, key: request.automation } : undefined;
  }
  if (request.target === "run") {
    if (!isOwnId(request.runId)) return undefined;
    const run = await readRun(deps.db, deps.twinId, request.runId);
    return run === undefined
      ? undefined
      : {
          kind: "run",
          verb: DASHBOARD_ACT_VERB_OF_ROUTE[request.route],
          runId: run.id,
          ended: run.ended_at !== null,
          paused: run.paused,
          cancelled: run.cancelled,
        };
  }
  if (request.target === "chat") {
    if (!isOwnId(request.chatDirectoryId)) return undefined;
    const chat = await chatOfDirectoryRow(deps, request.chatDirectoryId);
    return chat === undefined
      ? undefined
      : {
          kind: "chat",
          verb: DASHBOARD_ACT_VERB_OF_ROUTE[request.route],
          target: {
            directoryId: chat.id,
            chat: { chatJid: chat.chatJid, lidJid: chat.lidJid },
          },
        };
  }
  if (!isOwnId(request.postId)) return undefined;
  const res = await deps.db.query<{
    notice_id: string | null;
    draft_id: string | null;
  }>("SELECT notice_id, draft_id FROM posts WHERE id = $1 AND twin_id = $2", [
    request.postId,
    deps.twinId,
  ]);
  const row = res.rows[0];
  return row === undefined
    ? undefined
    : {
        kind: "post",
        verb: DASHBOARD_ACT_VERB_OF_ROUTE[request.route],
        target: {
          postId: request.postId,
          noticeId: row.notice_id,
          draftId: row.draft_id,
        },
        ...(request.lineIndex === undefined
          ? {}
          : { lineIndex: request.lineIndex }),
        ...(request.answers === undefined ? {} : { answers: request.answers }),
      };
}

/**
 * PAUSAR, REANUDAR OR CANCELAR ON A RUN (ticket #323; ADR-0013 as amended:
 * the run tools are disclosed-and-undoable-after through Trabajos en curso).
 *
 * A FLAG AND NOTHING ELSE (ADR-0012: pause and cancel are flags). The engine
 * reads them at the pass and at every step boundary: a paused run fires
 * nothing until it is taken up again, and a cancelled one is ended there with
 * its report — the run's own post, so this act posts no receipt of its own.
 *
 * `already` FOR A FLAG THAT ALREADY STOOD, and `refused` for a run that has
 * ended: a flag never lands on a run that is over.
 */
async function runRunAct(
  deps: DashboardActDeps,
  run: Extract<ResolvedAct, { kind: "run" }>,
): Promise<PerformedAct> {
  if (run.ended) return { outcome: "refused", disposition: "no-action" };
  // A CANCELLED RUN AWAITS ITS END AT THE NEXT PASS: a second Cancelar changed
  // nothing, and a pause on it has nothing left to pause.
  if (run.cancelled) {
    return run.verb === "cancel_run"
      ? { outcome: "already", disposition: "no-action" }
      : { outcome: "refused", disposition: "no-action" };
  }
  const flag = run.verb === "cancel_run" ? "cancelled" : "paused";
  const value = run.verb !== "resume_run";
  if ((flag === "paused" ? run.paused : run.cancelled) === value) {
    return { outcome: "already", disposition: "no-action" };
  }
  const set = await setFlag(deps.db, { twinId: deps.twinId, runId: run.runId, flag, value });
  return set ? { outcome: "performed", disposition: "acted" } : { outcome: "refused", disposition: "no-action" };
}

/**
 * ACTIVAR, DESCARTAR AND THE SWITCH (tickets #325, #386; spec #318 decisions
 * 29 and 30 as amended 2026-10-11; ADR-0013: the card's Activar is the gate on
 * a rutina the twin proposed).
 *
 * THE PRESS IS THE EVIDENCE: the act row this function's caller wrote one
 * statement ago is the rep's own decision, and what it authorizes is a write
 * on twin-side state with nothing a model chose — so, like the scope switch,
 * it records itself as its execution and goes through no tool's gate.
 *
 *   Activar    — on a proposal card: the rutina goes `active`, and the version
 *                it replaces ends with it; only then does the clock fire it.
 *                `already` on one already active — accepted in the thread, or
 *                pressed twice — and `refused` on one of Dito's.
 *   Descartar  — on a proposal card or an active rutina on Rutinas: its row
 *                ends, with every run of it still going cancelled in the same
 *                transaction, and its content deleted once that has committed
 *                (`rutinas.ts`). `refused` on one of Dito's.
 *   the switch — «En pausa» or back to «Activa», for this seat, on one of
 *                Dito's or an active rutina, by its row; `already` where it
 *                stood.
 *
 * NO RECEIPT, the scope switch's reason: the card or the page shows the new
 * state, and a message in the thread about a control the rep just touched
 * would tell them what they are looking at.
 *
 * BUT THE TWIN IS TOLD (Diego's ruling of 2026-10-11): Activar and Descartar
 * on a proposal card settle that card, `confirmed` or `declined`, as the rep's
 * own act on it — the seat's pages and the day's thread hear it as they hear
 * any card settle — and the switch or Descartar on an active rutina reaches
 * the day's thread as what the rep did to it (`thread/events.ts`). Once the
 * act has committed, never before.
 */
async function runAutomationAct(
  deps: DashboardActDeps,
  scope: DashboardActScope,
  act: Extract<ResolvedAct, { kind: "automation" }>,
): Promise<PerformedAct> {
  const refused: PerformedAct = { outcome: "refused", disposition: "no-action" };
  const already: PerformedAct = { outcome: "already", disposition: "no-action" };
  // WHAT THE ACT OWES ONCE IT HAS COMMITTED: the content of every row it
  // ended deleted — the pass's sweep is the recovery for a process that dies
  // in between (`sweepRutinaContent`) — and the news told.
  const done = (gone: readonly string[], news: RutinaNews | undefined): PerformedAct => ({
    outcome: "performed",
    disposition: "acted",
    afterCommit: () => {
      deleteRutinaContent(deps.bundle, gone);
      if (news !== undefined) tellRutinaNews(deps, scope.seatId, news);
    },
  });
  const settled = async (id: string, outcome: "confirmed" | "declined"): Promise<RutinaNews | undefined> => {
    const postId = await proposalPostOf(deps.db, deps.twinId, id);
    return postId === undefined ? undefined : { kind: "settled", postId, outcome };
  };
  // A PRESS ON A PROPOSAL CARD ANSWERS THAT CARD ALONE (Codex r1): pressed
  // after the rep accepted it in the thread, Activar is `already` and
  // Descartar is refused — never the Descartar Rutinas has for a rutina that
  // runs.
  if (act.proposal !== undefined) {
    const card =
      act.rutina === undefined ? undefined : await proposalPostOf(deps.db, deps.twinId, act.rutina.id);
    if (card !== act.proposal) return refused;
    if (act.rutina!.state !== "pending") return act.verb === "activate_automation" ? already : refused;
  }
  switch (act.verb) {
    case "activate_automation": {
      if (act.rutina === undefined) return refused;
      if (act.rutina.state === "active") return already;
      const activated = await activateRutina(deps.db, { twinId: deps.twinId, id: act.rutina.id });
      return activated === undefined ? refused : done(activated.retired, await settled(act.rutina.id, "confirmed"));
    }
    case "discard_automation": {
      // DESCARTAR IS THE REP'S RUTINAS' ALONE (CONTEXT.md *Rutinas*): one of
      // Dito's carries the switch and nothing else, so the act refuses it.
      if (act.rutina === undefined) return refused;
      const ended = await discardRutina(deps.db, { twinId: deps.twinId, id: act.rutina.id });
      if (ended === undefined) return refused;
      return done(
        ended,
        act.rutina.state === "pending"
          ? await settled(act.rutina.id, "declined")
          : { kind: "thread", event: { kind: "rutina.discarded", rutinaId: act.rutina.id } },
      );
    }
    case "pause_automation":
    case "resume_automation": {
      // A PROPOSAL CARRIES NO SWITCH: it runs nothing until it is accepted.
      if (act.rutina !== undefined && act.rutina.state !== "active") return refused;
      const paused = act.verb === "pause_automation";
      const changed = await setAutomationPaused(deps.db, {
        twinId: deps.twinId,
        seatId: scope.seatId,
        automationId: act.key,
        paused,
      });
      if (!changed) return already;
      return done(
        [],
        act.rutina === undefined
          ? undefined
          : { kind: "thread", event: { kind: paused ? "rutina.paused" : "rutina.resumed", rutinaId: act.rutina.id } },
      );
    }
  }
}

/** What an act on a rutina tells once it has committed: a proposal card settled, or an event for the day's thread. */
type RutinaNews =
  | { readonly kind: "settled"; readonly postId: string; readonly outcome: "confirmed" | "declined" }
  | { readonly kind: "thread"; readonly event: RaisedThreadEvent };

/** Tells it — the seat's pages and the day's thread — and never fails the act that committed. */
function tellRutinaNews(deps: DashboardActDeps, seatId: string, news: RutinaNews): void {
  try {
    if (news.kind === "thread") {
      deps.thread?.raise(deps.twinId, news.event);
      return;
    }
    deps.events?.publish(seatId, { kind: "settle", postId: news.postId, outcome: news.outcome });
    // THE REP'S OWN ACT ON THE CARD, as every button's settle is (`local-api.ts`).
    deps.thread?.raise(deps.twinId, { kind: "post.settled", postId: news.postId, outcome: news.outcome, byRep: true });
  } catch {
    // The act committed; a page reads it on its next read.
  }
}

/**
 * ONE SCOPE SWITCH (ticket #223; spec #214 decisions 5 and 7).
 *
 * The whole of the act is `scoping.ts`': the allowlist row, the request row the
 * plane serves, and the `scope_change` chain entry, in one transaction inside
 * this one. What is here is the mapping from a verb to a direction and from a
 * direction to the API's own words.
 *
 * `already` FOR A SWITCH THAT DID NOT MOVE, which is what `ScopeAct.changed`
 * exists to say: a rep who taps a switch that was already in that position has
 * performed an act — it is chained, recorded and answered — and the surface
 * gets a word that lets it say «ya estaba» rather than reporting a failure.
 *
 * NO RECEIPT, AND THAT IS A DECISION. A receipt is a `system_send` — a real
 * WhatsApp message into the rep's own thread — and link day's ordinary shape is
 * a rep flipping several switches in a row on the scoping page, which would put
 * one message per tap into a thread they have not opened yet. The page itself
 * re-renders with the switch in its new position, so the rep already has the
 * answer; and a receipt would need a new `notices` kind for a message nobody
 * asked for. The three acts that DO post one are the three where the rep's
 * answer is a fact about the record rather than about the control they just
 * touched.
 */
async function runScopeAct(
  deps: DashboardActDeps,
  args: {
    readonly verb: DashboardScopeActVerb;
    readonly target: ChatTarget;
    readonly actId: string;
  },
): Promise<PerformedAct> {
  const scope = {
    db: deps.db,
    hmacKey: deps.hmacKey,
    twinId: deps.twinId,
    dashboardActId: args.actId,
  };
  const acted =
    args.verb === "scope_in"
      ? await scopeChatIn(scope, args.target.chat)
      : await scopeChatOut(scope, args.target.chat);
  return {
    outcome: acted.changed ? "performed" : "already",
    // `acted` EITHER WAY, because the run DID something: it wrote a request
    // row the plane will serve and an entry on the chain, and an idempotent
    // repeat is still an act (`scoping.ts`' own rule). The outcome word is
    // what distinguishes the two, and the act row carries it.
    disposition: "acted",
  };
}

/**
 * The execution's own pair: one record and one content-free chain entry
 * (ADR-0020).
 *
 * THE ENTRY IS APPENDED BEFORE THE RECORD IS RETURNED, fail-closed, which is
 * the runner's own order: an act whose reference cannot be rendered leaves no
 * record and no entry rather than a malformed one that can never be repaired.
 *
 * A REFUSAL WITH NO TRIGGER STILL ANSWERS THE CALLER, and it is the one path
 * here that records nothing. It is reached when the post id names no post of
 * this twin — so there is no card, no act row and nothing an execution could
 * be ABOUT; `triggerRef` would have nothing to render and `dashboard_acts`
 * nothing to point at. What the rep gets is the refusal, and what the store
 * gets is the honest absence of a run that never had a subject.
 */
async function recordDashboardAct(
  deps: RepActDeps,
  args: {
    readonly executionId: string;
    readonly startedAt: Date;
    readonly trigger: DashboardActTrigger | undefined;
    readonly disposition: Disposition;
    readonly outcome: TwinApiActOutcome;
  },
): Promise<TwinApiActOutcome> {
  if (args.trigger === undefined) return args.outcome;
  const chain = twinExecutionChain(deps.db, deps.hmacKey);
  await chain.append(
    executionAuditEntry(
      args.trigger,
      DETERMINISTIC_INSTRUCTIONS,
      args.disposition,
    ),
  );
  const store = new TwinExecutionStore({
    client: deps.db,
    twinId: deps.twinId,
    executionId: args.executionId,
  });
  const endedAt = new Date();
  await store.recordExecution({
    trigger: args.trigger,
    instructionsDigest: DETERMINISTIC_INSTRUCTIONS,
    // NO TOOL LIST, because nothing was handed one: the act is the run.
    toolNames: [],
    startedAt: args.startedAt,
    endedAt,
    // NO ITERATIONS AND NO TOKENS: no model was asked anything.
    iterations: 0,
    tokens: { input: 0, output: 0 },
    disposition: args.disposition,
    // THE REALTIME LANE, because a rep is waiting on the answer — the same
    // reason the thread's own executions declare it (spec #171 decision 3).
    lane: "realtime",
  });
  return args.outcome;
}

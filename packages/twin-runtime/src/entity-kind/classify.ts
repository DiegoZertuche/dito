/**
 * ONE CLASSIFICATION, RUN — the shape all three wakes share (ticket #176;
 * the two-axis review's Standards axis).
 *
 * The classification is one shipped definition, and the point of that is
 * undone if invoking it is three hand-copies. Each caller wrote out the same steps —
 * build the trigger off the wake, build the definition off the bundle's
 * conversation and the seat's zone, run, record either way — and each could
 * have drifted on any of them: a caller that forgot
 * `renderGesturesForModel` would show one model a conversation with bare
 * gestures in it, and nothing would have said so.
 *
 * WHAT THE CALLERS STILL OWN is what happens AFTER, and that is the real
 * variation between them rather than an accident: the live confirmation
 * fail-stops the pass, the startup backlog reports the binding and carries
 * on, and the hand-run backfill stops the sweep. So this returns a
 * discriminated outcome and decides nothing about it.
 *
 * IT RUNS THROUGH THE ONE ENGINE (ticket #363): the shipped `entity_kind`
 * definition on the no-row path (`executeStep`), on the caller's connection,
 * which records the turn — one record and one chain entry — on it.
 *
 * IT DOES NOT OPEN THE TRANSACTION. Every caller commits the
 * classification WITH something else — the crossing and the marker, the
 * create, the kind — and ADR-0020's rule is that the record, the entry and
 * the act commit together or not at all. A helper that opened its own
 * transaction would put the record in one and the act in another.
 */
import { ENTITY_KINDS, type EntityKind } from "@dito/aperture";
import type { Bundle } from "@dito/bundle";
import type { Harness } from "@dito/execution";
import type pg from "pg";
import { renderGesturesForModel } from "../reactions.js";
import { executeStep } from "../runs/engine.js";
import { ENTITY_KIND_DEFINITION } from "../runs/shipped-conversations.js";
import { traceFor, type RuntimeTrace } from "../trace-render.js";
import { ENTITY_KIND_WAKE } from "./automation.js";

/**
 * What one classification decided, or the refusal it left instead.
 *
 * A REFUSAL IS A VALUE HERE RATHER THAN A THROW, because the three callers
 * answer it differently — the live confirmation stops the pass, the startup
 * backlog reports the binding and carries on, the hand-run backfill stops
 * the sweep — and a broken store is still thrown, so none of them can mistake
 * one for the other.
 */
export type Classification = ClassifiedKind | RefusedClassification;

/** The kind the model answered, one the Ledger has. */
export interface ClassifiedKind {
  readonly kind: EntityKind;
}

/** A run that produced no kind, with the record and entry it left behind. */
export interface RefusedClassification {
  readonly refused: Error;
}

/** The binding whose customer is being classified. */
export interface ClassifiableBinding {
  readonly chatJid: string;
  readonly entityId: string;
  /** The name as the REP confirmed it — never one model text produced. */
  readonly displayName: string;
}

/**
 * Runs one classification on the caller's connection, inside the caller's
 * transaction, and records it — one record and one chain entry, whichever
 * way it ended.
 */
export async function classifyBinding(
  deps: {
    readonly harness: Harness;
    /** The caller's connection, its transaction open. */
    readonly db: pg.ClientBase;
    readonly bundle: Bundle;
    readonly twinId: string;
    readonly hmacKey: Uint8Array;
    /** The id the record lands under, the caller's. */
    readonly executionId: string;
    /** The ADR-0015 rung — this classification's own, never derived. */
    readonly model: string;
    /** The seat's zone; unset means the host clock, as everywhere else. */
    readonly timeZone?: string;
    /**
     * Where this run's per-call trace goes, if anywhere (#177 hotfix 1). It
     * takes the runtime's own shape — trigger first — because the trigger is
     * built below, off the wake.
     */
    readonly trace?: RuntimeTrace;
  },
  binding: ClassifiableBinding,
): Promise<Classification> {
  const wake = ENTITY_KIND_WAKE;
  // THE OCCASION AND THE MECHANISM COME OFF THE WAKE, not restated here:
  // `runExecution` refuses a trigger that disagrees with it, and this is
  // where the ids the occasion binds are added to them.
  const trigger = {
    kind: wake.occasion,
    mechanism: wake.mechanism,
    twinId: deps.twinId,
    chatJid: binding.chatJid,
    entityId: binding.entityId,
  } as const;
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ran = await executeStep(
    { harness: deps.harness, db: deps.db, twinId: deps.twinId, hmacKey: deps.hmacKey },
    {
      definition: ENTITY_KIND_DEFINITION,
      conversation: {
        kind: "entity_kind",
        deps: {
          displayName: binding.displayName,
          // Through the one gesture renderer (#97), like every other surface
          // that puts a conversation in front of a model.
          conversation: renderGesturesForModel(deps.bundle, deps.bundle.readConversation(binding.chatJid)),
          timeZone,
        },
        holds: (output) =>
          isEntityKind(output["kind"])
            ? undefined
            : `kind is one of ${ENTITY_KINDS.join(" or ")}, and there is no third value`,
      },
      inputs: {},
      trigger,
      wake,
      lane: "realtime",
      executionId: deps.executionId,
      // WHEN THIS ONE WAS PICKED UP, per classification rather than per
      // sweep: the `now` part is about this run.
      now: new Date(),
      model: deps.model,
      ...traceFor(deps.trace, trigger),
    },
  );
  const kind = ran.settlement.output?.["kind"];
  if (ran.settlement.disposition !== "classified" || !isEntityKind(kind)) {
    return {
      refused: new Error(
        `the kind classification ended ${ran.settlement.disposition} with no kind the Ledger has`,
      ),
    };
  }
  return { kind };
}

/** Whether a classification came back with a kind. */
export function classified(
  outcome: Classification,
): outcome is ClassifiedKind {
  return "kind" in outcome;
}

function isEntityKind(word: unknown): word is EntityKind {
  return typeof word === "string" && (ENTITY_KINDS as readonly string[]).includes(word);
}

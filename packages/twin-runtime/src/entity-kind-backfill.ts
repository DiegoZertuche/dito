/**
 * The kind backfill (ticket #60), in the shape of the crossing backlog
 * (#50): entities the Ledger already holds, filed before anything
 * determined what they were.
 *
 * Slice 3 filed every entity `person` — a claim nothing supported, and the
 * reason ADR-0035's phone rung was comparing two placeholders. Every entity
 * created from here on gets a determination at its create; these are the
 * ones that predate that, and leaving them asserting `person` would leave
 * the rung inert for exactly the records the rig already has.
 *
 * RE-INFERRED, NOT CLEARED. There is no NULL to fall back to and no third
 * value to hide in: each entity is judged again, from the name the rep
 * confirmed and that chat's own words, and the answer is filed — so after
 * this pass every value in the column is a determination something made.
 *
 * SCOPED TO THIS TWIN'S OWN BINDINGS. The Ledger is company-scoped and this
 * lists the whole company, but a chat's history lives in ONE bundle: an
 * entity another rep bound is judged by that rep's runtime, with the
 * conversation in front of it, rather than here from a bare name. Those are
 * reported, never guessed at.
 *
 * IT NEVER OVERRULES A PERSON, and it does not have to remember to: the
 * aperture refuses a MODEL determination on an entity a human has ruled on,
 * inside the unit and under the row lock (`fileEntityKind`). This sweep just
 * reports what came back — which is also why an operator correcting an entity
 * WHILE this runs cannot lose their correction to a model call that started
 * before they typed it.
 *
 * BY HAND, NOT AT STARTUP, and that is a decision rather than an omission.
 * It costs one model call per entity, and nothing in the store says "this
 * one has been determined" — the chain records determinations, and reading
 * it for the `by:human` ones is a provenance question, but per-run progress
 * state is a store nobody has needed yet. So it runs from the operator's
 * hand trigger, and every entity minted after it is determined at its own
 * create. See `scripts/rig-entity-kind.ts`.
 */
import type { Harness } from "@dito/execution";
import { randomUUID } from "node:crypto";
import {
  fileEntityKind,
  listFiledEntities,
  readTwinCompanies,
  type EntityKindOutcome,
} from "@dito/aperture";
import type { Bundle } from "@dito/bundle";
import type { Dek } from "@dito/crypto";
import type pg from "pg";
import { withDbTransaction } from "./db-tx.js";
import { classified, classifyBinding } from "./entity-kind/classify.js";
import type { ModelCallConfig } from "./model-config.js";

export interface EntityKindBackfillDeps {
  readonly db: pg.Client;
  readonly bundle: Bundle;
  readonly dek: Dek;
  readonly twinId: string;
  /**
   * The company to sweep (Codex r3). Named by the caller and then CHECKED
   * against this twin's own Ledger grants, rather than derived from them:
   * the operator types a company id, and a stale `DITO_TWIN_ID` beside it
   * would otherwise quietly sweep a different tenant than the one they
   * asked for and leave theirs untouched.
   */
  readonly companyId: string;
  readonly harness: Harness;
  readonly kindModel: ModelCallConfig;
  /**
   * The seat's IANA zone, for the classification's own «now» part. Unset
   * means the host clock, as it does on the runtime's own deps.
   */
  readonly timeZone?: string;
  /** The audit chain's HMAC key: every determination appends a link (ADR-0020). */
  readonly hmacKey: Uint8Array;
}

/**
 * One entity this pass looked at: the aperture's own outcome, plus the name
 * that makes a wrong determination visible to whoever reads the report.
 */
export interface EntityKindDetermined extends EntityKindOutcome {
  readonly displayName: string;
}

export interface EntityKindBackfillResult {
  readonly determined: readonly EntityKindDetermined[];
  /**
   * Entities a human already determined the kind of. Left exactly as they
   * left them — the model does not overrule a person.
   */
  readonly handCorrected: readonly string[];
  /**
   * Entities this twin's bundle holds no binding for — another rep's
   * customers. Left alone: judging them from a name with no conversation
   * is a worse determination than the one their own twin will make.
   */
  readonly skipped: readonly string[];
}

/** A sweep aimed at a company this twin has no standing in. */
export class EntityKindBackfillScopeError extends Error {
  override readonly name = "EntityKindBackfillScopeError";
  constructor(twinId: string, companyId: string) {
    super(
      `twin ${twinId} has no Ledger standing in company ${companyId}; refusing to sweep a company it does not belong to (ticket #60)`,
    );
  }
}

/** Re-infers the kind of every entity this twin bound, in one company. */
export async function backfillEntityKinds(
  deps: EntityKindBackfillDeps,
): Promise<EntityKindBackfillResult> {
  const ctx = { db: deps.db, dek: deps.dek, hmacKey: deps.hmacKey };
  // The scope is CHECKED against the aperture's own answer rather than
  // taken from the caller (ADR-0035), and refused rather than corrected:
  // an operator who named the wrong company wants to hear so, not to have
  // a different one swept for them.
  const standing = await readTwinCompanies(ctx, deps.twinId);
  if (!standing.includes(deps.companyId)) {
    throw new EntityKindBackfillScopeError(deps.twinId, deps.companyId);
  }
  const boundByEntity = new Map(
    deps.bundle.listChatBindings().map((b) => [b.entityId, b]),
  );

  const determined: EntityKindDetermined[] = [];
  const handCorrected: string[] = [];
  const skipped: string[] = [];
  for (const entity of await listFiledEntities(ctx, deps.companyId)) {
    const binding = boundByEntity.get(entity.entityId);
    if (binding === undefined) {
      skipped.push(entity.entityId);
      continue;
    }
    // THE SAME AUTOMATION AND THE SAME `request` WAKE as the live
    // confirmation and the startup backlog (ticket #176; AC 2 leaves this
    // sweep no other path to a model), through the one helper all three
    // call.
    //
    // TWO TRANSACTIONS, AND THE SECOND ONE IS THE APERTURE'S OWN (Codex
    // round 2). They cannot be one, and the reason is a LOCK ORDER. An
    // execution takes the audit chain's tail lock first — `runExecution`
    // appends its entry before it returns or throws, which is what makes it
    // fail-closed — and `fileEntityKind` takes the COMPANY's merge lock
    // before it chains, because a kind decides merge eligibility and the
    // matcher reads kinds and writes inside one transaction. Running both in
    // one transaction here would hold audit-then-company, while a human
    // correcting a kind by hand holds company-then-audit: a cycle, and
    // Postgres would abort one of them — quite possibly the person's.
    //
    // SO THE CLASSIFICATION COMMITS ITS OWN ACCOUNT FIRST, alone, and the
    // determination is filed after it in the aperture's own unit. Neither
    // transaction holds both locks, so no cycle exists. The alternative —
    // taking the company lock before the model call — would block every
    // correction and every merge in that company for the length of a model
    // call, once per entity, for the whole sweep.
    //
    // WHAT THE SPLIT COSTS, recorded rather than discovered: a crash between
    // the two leaves a `classified` record with nothing filed. This is a
    // hand-run sweep over entities that already exist, it is idempotent, and
    // the next run re-classifies and files — and ADR-0020's rule is
    // untouched, because the record and its entry are still one commit.
    const classification = await withDbTransaction(deps.db, () =>
      classifyBinding(
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
      ),
    );
    // THE SWEEP STOPS ON A REFUSAL, which is what the harness's uncaught
    // throw did and what an operator running this by hand wants: a run that
    // cannot judge one entity has probably lost the model, and a report
    // silently missing half a company is worse than a stopped sweep. What is
    // new is that the refusal leaves a `failed` record and its chain entry,
    // committed by the transaction above before the throw.
    if (!classified(classification)) throw classification.refused;
    const outcome = await fileEntityKind(ctx, {
      companyId: deps.companyId,
      entityId: entity.entityId,
      kind: classification.kind,
      determinedBy: "model",
    });
    if (outcome.deferredToHuman) {
      handCorrected.push(entity.entityId);
      continue;
    }
    determined.push({ ...outcome, displayName: entity.displayName });
  }
  return { determined, handCorrected, skipped };
}

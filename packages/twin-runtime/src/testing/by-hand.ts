/**
 * THE DAY'S READ AND ITS POST BY HAND, FOR A SUITE (ticket #364).
 *
 * Both are runs of Dito's automations, and a run belongs to the twin's seat;
 * a suite whose twin fixture carries no seat of its own is given a linked one
 * first, then the production hand trigger runs (`runs/by-hand.ts`).
 */
import type { DailyDisclosureDeps } from "../disclosure.js";
import type { DailyExtractionDeps, ExtractionSteering } from "../extraction-pass.js";
import {
  runDailyDisclosure as disclosureByHand,
  runDailyExtraction as extractionByHand,
  type DailyDisclosureResult,
  type DailyExtractionResult,
} from "../runs/by-hand.js";
import { seatOnce } from "./seat.js";

/** The day's post, as a run of the twin's seat. */
export async function runDailyDisclosure(deps: DailyDisclosureDeps, now: Date): Promise<DailyDisclosureResult> {
  await seatOnce(deps.db, deps.twinId);
  return await disclosureByHand(deps, now);
}

/** ...and the day's read the same way. */
export async function runDailyExtraction(
  deps: DailyExtractionDeps,
  now: Date,
  steering?: ExtractionSteering,
): Promise<DailyExtractionResult> {
  await seatOnce(deps.db, deps.twinId);
  return await extractionByHand(deps, now, steering);
}

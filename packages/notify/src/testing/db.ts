/**
 * The Postgres test plumbing this package's integration suite drives, from
 * the seam's own source (ticket #219).
 *
 * A RELATIVE-PATH RE-EXPORT RATHER THAN A PACKAGE IMPORT, which is this
 * repo's convention for exactly this problem (`owner-twin/src/testing/db.ts`
 * states it at length): every package's `src/testing` is excluded from its
 * build, so the fixtures never ship and are not reachable through
 * `@dito/notify`. One set of fixtures, one destructive-reset guard, no copy
 * to drift.
 *
 * NOTHING THIS PACKAGE SHIPS PASSES THROUGH HERE. `src/testing` is out of
 * `tsconfig.build.json`, so the seam stays out of `@dito/notify`'s
 * dependency graph — which matters more here than usual, because notify is
 * class 4 of ADR-0013 and the smaller its graph the fewer ways there are to
 * reach it.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export {
  pgErrorCode,
  resetAndMigrate,
  TEST_DATABASE_URL,
  withClient,
} from "../../../seam/src/testing/db.js";

/** A seat, as notify reads one. */
export interface SeatFixture {
  readonly companyId: string;
  readonly twinId: string;
  readonly seatId: string;
  readonly repDisplayName: string;
  readonly email: string | null;
}

/**
 * One company and one seat, written straight to the registries.
 *
 * THE EMAIL IS OBVIOUSLY SYNTHETIC and carries no digit: `.test` is the
 * reserved TLD, and the digit-free local part keeps the Ledger wall sweep's
 * subscriber-number rule from ever having to think about a fixture (it
 * sweeps every text column of `public.seats`, this one included).
 */
export async function seedSeat(
  db: pg.ClientBase,
  options: { readonly email?: string | null; readonly repDisplayName?: string } = {},
): Promise<SeatFixture> {
  const seat: SeatFixture = {
    companyId: randomUUID(),
    twinId: randomUUID(),
    seatId: randomUUID(),
    repDisplayName: options.repDisplayName ?? "Mauricio Torres",
    email: options.email === undefined ? "rep@example.test" : options.email,
  };
  await db.query(
    "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
    [seat.companyId, "Abarrotes de prueba"],
  );
  await db.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state, email)
     VALUES ($1, $2, $3, $4, 'linked', $5)`,
    [
      seat.seatId,
      seat.companyId,
      seat.twinId,
      seat.repDisplayName,
      seat.email,
    ],
  );
  return seat;
}

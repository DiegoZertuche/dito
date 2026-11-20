/**
 * THE DASHBOARD'S DOOR, FOR A SUITE (ticket #261).
 *
 * Two things every suite that drives the door needs: a seat with an open
 * login — the fourth fence a message passes and a button does not — and a way
 * to put one message through. The write goes through `writeDoorMessage`, the
 * production path, so the seal and the session check are the ones the API
 * performs rather than an INSERT a test composed.
 *
 * IT LIVES HERE BECAUSE SEVERAL SUITES DRIVE IT: the thread's own seam suite,
 * the references' and the day's, and a copy in each is the copy that drifts (`thread-deps.ts`
 * and `settle.ts` are the same shape for the same reason).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Dek } from "@dito/crypto";
import type { TwinApiMessageAbout } from "@dito/seam";
import type pg from "pg";
import { writeDoorMessage } from "../door.js";

/** A seat, its company and one open login of that seat's. */
export interface DoorSeat {
  readonly companyId: string;
  readonly seatId: string;
  readonly sessionId: string;
}

/** Registers a company, a seat for this twin, and one open session. */
export async function seatAtTheDoor(
  client: pg.Client,
  twinId: string,
): Promise<DoorSeat> {
  const companyId = randomUUID();
  const seatId = randomUUID();
  const sessionId = randomUUID();
  await client.query(
    "INSERT INTO companies (id, display_name) VALUES ($1, $2)",
    [companyId, `Ferretería ${companyId.slice(0, 4)}`],
  );
  await client.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, $4, 'linked')`,
    [seatId, companyId, twinId, "Mauricio Cantú"],
  );
  await client.query(
    `INSERT INTO sessions (id, company_id, seat_id, token_sha256, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
    [sessionId, companyId, seatId, randomBytes(32)],
  );
  return { companyId, seatId, sessionId };
}

/**
 * One message typed at the door; returns its row id.
 *
 * IT THROWS ON A REFUSAL rather than returning one, because every caller here
 * is setting a scene: a fixture the door turned away is a test that would go
 * on to assert about a message nobody sent.
 */
export async function typeAtTheDoor(
  client: pg.Client,
  twin: { readonly twinId: string; readonly dek: Dek },
  seat: DoorSeat,
  text: string,
  /** The line of the notes card these words correct, when they do (#344). */
  about?: TwinApiMessageAbout,
): Promise<string> {
  const written = await writeDoorMessage(
    { db: client, dek: twin.dek, twinId: twin.twinId },
    { companyId: seat.companyId, seatId: seat.seatId },
    { text, sessionId: seat.sessionId, now: new Date(), ...(about === undefined ? {} : { about }) },
  );
  if (!written.ok) {
    throw new Error(`the door refused a fixture message: ${written.reason}`);
  }
  return written.messageId;
}

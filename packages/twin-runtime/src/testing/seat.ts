/**
 * A LINKED SEAT FOR A SUITE'S TWIN (ticket #364).
 *
 * The day's extraction and its disclosure are runs of Dito's automations, and
 * a run belongs to a seat and moves only while that seat is linked (the
 * seat-state gate, ADR-0012). A suite that reads or posts a day therefore
 * seats its twin first; asking twice is free.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

/** The twin's company and its one linked seat, written once. */
export async function seatTheTwin(
  client: pg.ClientBase,
  twin: { readonly twinId: string; readonly companyId: string; readonly seatId: string },
): Promise<void> {
  await client.query(
    "INSERT INTO companies (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [twin.companyId, `Ferretería ${twin.companyId.slice(0, 4)}`],
  );
  await client.query(
    `INSERT INTO seats (id, company_id, twin_id, rep_display_name, state)
     VALUES ($1, $2, $3, 'Mauricio Cantú', 'linked')
     ON CONFLICT DO NOTHING`,
    [twin.seatId, twin.companyId, twin.twinId],
  );
}

/**
 * ...or, for a suite whose twin fixture carries no seat of its own, a linked
 * seat for the twin when it has none yet.
 */
export async function seatOnce(client: pg.ClientBase, twinId: string): Promise<void> {
  const seated = await client.query("SELECT 1 FROM seats WHERE twin_id = $1", [twinId]);
  if (seated.rows.length > 0) return;
  await seatTheTwin(client, { twinId, companyId: randomUUID(), seatId: randomUUID() });
}

/**
 * FR-70 reconciliation (slice AC 9, ADR-0006): the SQL join over the seam
 * tables proving every outbound customer_send matches a recorded tap for
 * its own draft and twin — a checked invariant, not a belief. Runs as a CI
 * invariant over the integration corpus and against rig data
 * (scripts/fr70-check.mjs).
 *
 * The schema's FKs and CHECKs make most mismatches unrepresentable; this
 * join is the independent auditor over them, and the sole catcher of the
 * representable one — a twin that differs between a command, its tapped draft
 * and whatever minted the tap.
 *
 * BOTH MINTERS ARE COVERED, and by two classes rather than one (ticket
 * #224). The matcher's tap is pinned to a raw plane-delivered event, so its
 * binding is read off `wa_events`; the dashboard's tap has no event at all,
 * so its binding is read off the command the same transaction wrote. An
 * inner join on the seam event would have left every rep-web tap reconciled
 * by nothing.
 */
import pg from "pg";

export interface Fr70Violation {
  /** What the violation hangs off: "command:<uuid>" or "tap:<uuid>". */
  subject: string;
  reason: string;
}

export interface Fr70Report {
  /** Outbound customer_send commands examined. */
  customerSends: number;
  violations: Fr70Violation[];
}

/** Reconciles outbound send commands against taps on the given seam. */
export async function reconcileFr70(client: pg.ClientBase): Promise<Fr70Report> {
  const countRes = await client.query(
    "SELECT count(*)::int AS n FROM send_commands WHERE send_class = 'customer_send'",
  );
  const violationsRes = await client.query(
    `SELECT 'command:' || sc.id AS subject,
            CASE
              WHEN t.id IS NULL THEN 'customer_send without a matching tap for its draft'
              WHEN d.id IS NULL THEN 'customer_send without a draft'
              WHEN d.twin_id <> sc.twin_id THEN 'command twin differs from draft twin'
              WHEN d.destination <> sc.destination THEN 'command destination differs from tapped draft destination'
              ELSE 'command payload_ref is not the canonical ref of its tapped draft'
            END AS reason
       FROM send_commands sc
       LEFT JOIN taps t ON t.id = sc.tap_id AND t.draft_id = sc.draft_id
       LEFT JOIN drafts d ON d.id = sc.draft_id
      WHERE sc.send_class = 'customer_send'
        AND (t.id IS NULL OR d.id IS NULL
             OR d.twin_id <> sc.twin_id
             OR d.destination <> sc.destination
             OR sc.payload_ref <> 'draft:' || sc.draft_id)
      UNION ALL
     SELECT 'command:' || sc.id, 'system_send carries a tap'
       FROM send_commands sc
      WHERE sc.send_class = 'system_send' AND sc.tap_id IS NOT NULL
      UNION ALL
     -- The other direction: a tap with no command locked its draft (the
     -- UNIQUE(draft_id) single-use lock) without any send — the writer's
     -- one-transaction contract (ADR-0006) makes this unreachable, so a row
     -- here means that contract broke somewhere.
     SELECT 'tap:' || t.id, 'tap without a send command — draft locked, nothing sent'
       FROM taps t
       LEFT JOIN send_commands sc ON sc.tap_id = t.id
      WHERE sc.id IS NULL
      UNION ALL
     -- The same-twin binding (ADR-0006): the raw plane-delivered event that
     -- minted a tap must belong to the tapped draft's own twin — an
     -- affirmation from another twin's stream can never release a draft.
     SELECT 'tap:' || t.id, 'tap source event twin differs from draft twin'
       FROM taps t
       JOIN drafts d ON d.id = t.draft_id
       JOIN wa_events e ON e.id = t.source_event_id
      WHERE e.twin_id <> d.twin_id
      UNION ALL
     -- ...AND THE SAME BINDING FOR A TAP WITH NO SOURCE EVENT (ticket #224;
     -- ADR-0006's second minter). The class above is an INNER JOIN on
     -- wa_events, so a tap the DASHBOARD minted — which has no seam event,
     -- because the rep pressed a button rather than sending a message
     -- (taps_matcher_requires_event_check) — falls out of it entirely and
     -- would be reconciled by nothing.
     --
     -- What replaces the event's twin as the second reading is the COMMAND's:
     -- the writer derives both the tap's draft and the command's twin from
     -- the same draft row in one transaction, so the two agreeing is the
     -- store's own statement that the pair was minted together. A rep-web tap
     -- whose draft belongs to another twin than the command it authorized is
     -- exactly the representable mismatch this whole join exists to catch,
     -- arriving by the door the first minter does not use.
     SELECT 'tap:' || t.id,
            'source-less tap authorizes a command for another twin than its draft'
       FROM taps t
       JOIN drafts d ON d.id = t.draft_id
       JOIN send_commands sc ON sc.tap_id = t.id
      WHERE t.source_event_id IS NULL
        AND sc.twin_id <> d.twin_id
      ORDER BY 1`,
  );
  return {
    customerSends: countRes.rows[0].n,
    violations: violationsRes.rows.map((row) => ({
      subject: row.subject,
      reason: row.reason,
    })),
  };
}

/**
 * Script entry: reconciles the seam at `databaseUrl` (rig data or the CI
 * integration corpus). Constructs its own client so callers stay
 * dependency-free.
 */
export async function reconcileFr70At(databaseUrl: string): Promise<Fr70Report> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await reconcileFr70(client);
  } finally {
    await client.end();
  }
}

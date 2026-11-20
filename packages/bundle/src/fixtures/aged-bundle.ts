/**
 * Fixture builders for bundles that are not at the current schema version
 * (ADR-0029): an "aged" bundle as an older build would have written it —
 * using exactly the versioned migration artifacts that build shipped — and
 * a future-stamped bundle a newer build would have left behind.
 *
 * Fixture machinery only (ticket #31: the fixture generator produces
 * historically-shaped bundles from these, so tests hold both a
 * slice-1-shaped and a current-shaped bundle). Deliberately NOT exported
 * from the package index — production bundles are born current through
 * createBundle, never aged.
 */
import type { Dek } from "@dito/crypto";
import type { ConversationRow } from "../bundle.js";
import { openKeyed } from "../keyed-db.js";
import { BUNDLE_MIGRATIONS } from "../migrations.js";

/**
 * The schema version each additive column of the message store first
 * existed at — a build older than that never knew it, so a seed row
 * carrying one cannot be replayed into its schema (refusing beats silently
 * dropping fixture data).
 */
const COLUMN_SINCE: readonly {
  readonly column: string;
  readonly since: number;
  readonly read: (row: ConversationRow) => string | number | undefined;
}[] = [
  /** The sender push-name (ticket #31). */
  { column: "push_name", since: 3, read: (row) => row.pushName },
  /** The reaction's target and emoji (ticket #97). */
  { column: "reaction_to", since: 5, read: (row) => row.reactionTo },
  { column: "reaction_emoji", since: 5, read: (row) => row.reactionEmoji },
  /** The reactor's own millisecond clock (ticket #109). */
  { column: "sender_ts_ms", since: 6, read: (row) => row.senderTsMs },
  /** The opaque delivery's kind and the message it stands for (ticket #124). */
  { column: "opaque_kind", since: 7, read: (row) => row.opaqueKind },
  { column: "opaque_of", since: 7, read: (row) => row.opaqueOf },
];

/**
 * Creates a bundle exactly as the build whose latest schema version was
 * `version` would have: migrations 1..version applied, stamped `version`,
 * holding `rows` (every schema version to date stores conversation rows).
 */
export function createBundleAtVersion(
  path: string,
  dek: Dek,
  version: number,
  rows: readonly ConversationRow[] = [],
): void {
  const applicable = BUNDLE_MIGRATIONS.filter((m) => m.version <= version);
  if (applicable.length === 0 || applicable.length !== version) {
    throw new Error(`no such historical schema version: ${version}`);
  }
  const db = openKeyed(path, dek, { fileMustExist: false });
  try {
    for (const migration of applicable) {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }
    // The historical column set, as of THIS version.
    const additive = COLUMN_SINCE.filter((c) => version >= c.since);
    const columns = [
      "chat_jid",
      "message_id",
      "sender_jid",
      "from_me",
      "occurred_at",
      "content",
      ...additive.map((c) => c.column),
    ];
    const insert = db.prepare(
      `INSERT INTO conversation_messages (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      for (const { column, since, read } of COLUMN_SINCE) {
        if (version < since && read(row) !== undefined) {
          throw new Error(
            `schema v${version} predates ${column}: seed row ${row.messageId} cannot carry one`,
          );
        }
      }
      insert.run(
        row.chatJid,
        row.messageId,
        row.senderJid,
        row.fromMe ? 1 : 0,
        row.occurredAt,
        row.content,
        ...additive.map((c) => c.read(row) ?? null),
      );
    }
  } finally {
    db.close();
  }
}

/** Restamps an existing bundle's schema version (e.g. to fake a newer build's stamp). */
export function stampSchemaVersion(
  path: string,
  dek: Dek,
  version: number,
): void {
  const db = openKeyed(path, dek, { fileMustExist: true });
  try {
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

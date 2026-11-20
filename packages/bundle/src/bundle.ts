/**
 * The twin's bundle (ADR-0007): one SQLCipher-encrypted SQLite file holding
 * all twin memory, opened only under that twin's DEK. It holds conversation
 * rows, message vectors, the entity mirror, the customers' references (#321),
 * the rep notepad (#260), the thread's own items (#320) and the twin's
 * working memory (#322).
 *
 * SQLCipher keying: the file uses the SQLCipher 4.x on-disk format
 * (cipher='sqlcipher', legacy=4) and is keyed with a raw 256-bit key
 * derived from the DEK (deriveBundleKey — HKDF, purpose-bound, so the raw
 * DEK never leaves @dito/crypto custody). A raw key means no passphrase
 * KDF: the DEK is the only way in, and destroying the twin's KMS key
 * destroys the bundle with it (ADR-0009, retirement).
 */
import { closeSync, openSync } from "node:fs";
import type Database from "better-sqlite3-multiple-ciphers";
import type { Dek } from "@dito/crypto";
import {
  BundleAlreadyExistsError,
  BundleSchemaTooNewError,
  BundleUninitializedError,
  ChatAlreadyBoundError,
  MessageNotInStoreError,
  VectorDimensionMismatchError,
  WrongBundleKeyError,
} from "./errors.js";
import { inDeliveryOrder } from "./delivery-order.js";
import { foldOpaqueDeliveries } from "./opaque-fold.js";
import { openKeyed } from "./keyed-db.js";
import {
  AUTOMATION_SENTENCE_CAP,
  BUNDLE_MIGRATIONS,
  BUNDLE_SCHEMA_VERSION,
  MESSAGE_VECTOR_DIMS,
  NOTEPAD_CAP,
  notepadLength,
  OPEN_MATTER_LABEL_CAP,
  WORKING_MEMORY_CAP,
  WORKING_MEMORY_MATTERS_CAP,
} from "./migrations.js";

/**
 * One conversation row: a chat's message with its metadata, nothing more
 * (slice AC 10). `occurredAt` is an ISO-8601 UTC instant, which makes
 * lexicographic order chronological order.
 */
export interface ConversationRow {
  readonly chatJid: string;
  /** The rail's external message id, unique within its chat. */
  readonly messageId: string;
  readonly senderJid: string;
  readonly fromMe: boolean;
  readonly occurredAt: string;
  readonly content: string;
  /**
   * The sender's WhatsApp push-name, when the delivery carried one
   * (payload v:1 gains it additively on the live path, #30, and on
   * backfill, #33): bindings are proposed from it and unconfirmed posts
   * render it with the provisional marker (spec #29 decisions 3 and 7).
   */
  readonly pushName?: string;
  /**
   * The message this row REACTS TO — set only on a reaction (ticket #97;
   * ADR-0041), where `messageId` is the reaction's own stanza id. Absent on
   * an ordinary message, which is what makes "did the rep type this, or tap
   * it?" a question the store can answer.
   */
  readonly reactionTo?: string;
  /**
   * The emoji placed, on a reaction row — the EMPTY STRING on a removal,
   * exactly as the rail sends it, so absence and retraction stay different
   * things. Set whenever `reactionTo` is, and it is the other half of what
   * the gesture line is re-composed from at read time: `content` holds the
   * line as it read when the row was stored, which is what the vector
   * indexes, but a target that arrives later must still reach the model.
   */
  readonly reactionEmoji?: string;
  /**
   * The reactor's own clock in whole milliseconds, on a reaction row — the
   * seam payload's `sender_ts_ms`, which ADR-0041 names as the fold key
   * (ticket #109). `inDeliveryOrder` is its one reader and states there why
   * a second-granular `occurredAt` needs it. Absent on an ordinary message,
   * and on a reaction stored before schema v6 knew the column.
   */
  readonly senderTsMs?: number;
  /**
   * The rail's own name for a delivery the plane could not read — set only
   * on an opaque row (ticket #124; ADR-0042), where `messageId` is the
   * seam's `<stanza>:opaque` identity rather than the message's own.
   * Absent on everything else, which is what makes «is this row a
   * placeholder?» a question the STORE answers rather than one a reader
   * infers from the text: the fold reads it, and so does the embedding
   * backlog, which never selects a row that has one.
   */
  readonly opaqueKind?: string;
  /**
   * The message this opaque row STANDS FOR — its identity minus the
   * `:opaque` suffix (`opaqueRowStandsFor` in @dito/seam reads it out).
   * Set beside `opaqueKind` whenever the rail supplied a stanza id, and
   * absent on the id-less `opaque:<hash>` shape, which stands for no
   * message and therefore folds with nothing.
   */
  readonly opaqueOf?: string;
}

/**
 * One entry in the entity mirror (ticket #31, ADR-0004): the rep-confirmed
 * association of one WhatsApp chat with one entity. Bindings live ONLY
 * here — rep-side, inside the bundle, never owner-visible; the crossing
 * (slice 3) inherits only rep-confirmed rows.
 */
export interface ChatBinding {
  readonly chatJid: string;
  /** The entity the chat is bound to (minted at confirmation, #34). */
  readonly entityId: string;
  /** The entity's name as the rep confirmed it. */
  readonly displayName: string;
  /** ISO-8601 UTC instant of the rep's confirmation. */
  readonly confirmedAt: string;
}

/**
 * WHAT A CUSTOMER REFERENCE NAMES (ticket #321; CONTEXT.md *Reference*): a
 * customer the rep confirmed, by its entity, or a chat nobody has confirmed
 * yet. `number` is the reference itself — the twin writes it `[c<number>]`.
 */
export type CustomerReference =
  | { readonly number: number; readonly entityId: string }
  | { readonly number: number; readonly chatJid: string };

/**
 * One message the other side of a chat wrote under a push-name, newest first
 * — what an unconfirmed chat is named by, and what its binding question can
 * be anchored to (ticket #321).
 */
export interface PushNameRow {
  readonly messageId: string;
  readonly pushName: string;
}

/**
 * ONE VERSION OF THE REP NOTEPAD (ticket #260; spec #258; CONTEXT.md *Rep
 * notepad*).
 *
 * WHAT THE REP TAUGHT, AND WHO WROTE IT DOWN. `text` is the rep's own words
 * — the whole notebook, never a delta — and the three fields beside it are
 * the provenance a reader needs to tell a version from this minute from one
 * left over from last month: which execution wrote it, when, and the rep's
 * own message that authorized it (the rep-evidenced gate's own id,
 * ADR-0013). Opaque ids only; nothing here says what a customer said.
 *
 * `version` IS THE ROW'S OWN AUTOINCREMENT, and it is here because it is the
 * one thing that makes "append-only" readable through the API: a caller that
 * wrote twice reads back a second number, so "nothing was dropped" is a
 * property they can check rather than take on trust.
 */
export interface NotepadVersion {
  /** The version's own number — 1 for the first, one more for each write. */
  readonly version: number;
  /** The rep's own words, whole. Empty is the rep clearing their notebook. */
  readonly text: string;
  /** When it was written, as an ISO-8601 UTC instant. */
  readonly writtenAt: string;
  /** The execution that wrote it. */
  readonly executionId: string;
  /** The rep's own message that authorized it (ADR-0013's third gate). */
  readonly evidenceRef: string;
}

/**
 * WHAT ONE NOTEPAD WRITE DID — a value, and never a throw for the cap
 * (ticket #260; spec #258: "an over-limit write returns a structured error
 * listing the current text and instructing consolidate-and-retry").
 *
 * THE CAP IS NOT AN ERROR, IT IS AN ANSWER. The whole notebook is the unit of
 * a write, so a refusal has to hand back everything a retry needs: the bound,
 * what this attempt weighed, and THE TEXT THAT STILL STANDS — so the
 * consolidation is made from what the rep really taught rather than from
 * whatever the caller remembered of it. That is the whole mechanism by which
 * a full notebook is rewritten instead of a rule being quietly dropped.
 *
 * A GENUINE SQLite FAILURE STILL THROWS. This union is about the one refusal
 * the caller is expected to act on; a broken store is not something anybody
 * consolidates their way out of.
 */
export type NotepadWrite =
  | { readonly outcome: "written"; readonly version: NotepadVersion }
  | {
      readonly outcome: "over_cap";
      readonly cap: number;
      readonly charsAttempted: number;
      /** The text this write did NOT replace — empty when none is stored. */
      readonly currentText: string;
    };

/**
 * WHAT ONE OPEN MATTER IS ABOUT (ticket #322; spec #318 decision 32): an
 * entity — a customer — or a post — a card on the canvas — by the id its own
 * store minted.
 *
 * A STABLE ID AND NEVER A WIRE REFERENCE. The twin names things in a turn by
 * small numbers that mean something only inside that turn; a matter outlives
 * the turn that opened it, so the writer resolves the number to the id before
 * anything is stored (`thread/working-memory.ts`).
 */
export interface OpenMatterSubject {
  readonly kind: "entity" | "post";
  readonly id: string;
}

/** One open matter: the twin's short label for it and what it is about. */
export interface OpenMatter {
  /** The twin's own words — the chip's text. */
  readonly label: string;
  readonly about: OpenMatterSubject;
}

/**
 * ONE VERSION OF THE TWIN'S WORKING MEMORY (ticket #322; spec #318 decision
 * 2): the whole prose and the whole list, as one write left them.
 *
 * THE NOTEPAD'S SHAPE WITHOUT ITS EVIDENCE. These are the twin's own notes,
 * so who wrote them is the execution alone; `version` is the row's own
 * autoincrement for the reason `NotepadVersion` gives.
 */
export interface WorkingMemoryVersion {
  readonly version: number;
  readonly text: string;
  readonly matters: readonly OpenMatter[];
  readonly writtenAt: string;
  readonly executionId: string;
}

/**
 * WHAT ONE WORKING-MEMORY WRITE DID — a value, and never a throw for a cap.
 *
 * `NotepadWrite`'s argument: the refusal carries what a rewrite needs, which
 * is the caps, what this attempt weighed and the version that still stands.
 */
export type WorkingMemoryWrite =
  | { readonly outcome: "written"; readonly version: WorkingMemoryVersion }
  | {
      readonly outcome: "over_cap";
      readonly cap: number;
      readonly charsAttempted: number;
      readonly mattersCap: number;
      readonly mattersAttempted: number;
      readonly labelCap: number;
      /** The labels past `labelCap`, as the write gave them. */
      readonly labelsTooLong: readonly string[];
      /** The version this write did NOT replace — absent when none is stored. */
      readonly current: WorkingMemoryVersion | undefined;
    };

/**
 * ONE RUTINA'S CONTENT (ticket #325; ADR-0014 as amended): the workflow
 * definition the twin wrote, as the JSON text its seam row pins by digest,
 * and the twin's own first-person sentence about it. `id` is the seam row's.
 *
 * THE DEFINITION TRAVELS AS TEXT, never as a parsed value: this package
 * holds no workflow vocabulary, and the runtime parses and digests what it
 * reads back, so the bytes the digest was taken over are the bytes kept.
 */
export interface AutomationContent {
  readonly id: string;
  readonly definition: string;
  readonly sentence: string;
  readonly writtenAt: string;
  readonly executionId: string;
  /** The line the turn that wrote it answered — the rep's message — or that turn's own id when an event woke it (ticket #386). */
  readonly evidenceRef: string;
}

/**
 * ONE VERSION OF ONE WORKSPACE FILE (ticket #326; ADR-0011 as amended): what
 * the runtime's snapshot found at a step boundary, immutable once written.
 * `path` is relative to the workspace; `title` is what code read off the
 * content; `runId` is the run whose step wrote it, absent for the thread's
 * own turn.
 */
export interface WorkspaceVersion {
  readonly id: string;
  readonly path: string;
  readonly version: number;
  readonly sha256: string;
  readonly title: string;
  readonly content: string;
  readonly writtenAt: string;
  readonly executionId: string;
  readonly runId?: string;
}

/**
 * ONE WORKSPACE DOCUMENT AS A LIST NAMES IT (ticket #368): its latest
 * version's id, its path, its title, that version's number and when it was
 * written — never its content.
 */
export interface WorkspaceDocument {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly version: number;
  readonly writtenAt: string;
}

/** The outcome of one idempotent ingest write (ticket #31). */
export interface IngestResult {
  /** Whether THIS call stored the row (false: it already existed). */
  readonly stored: boolean;
  /** The message's stable interior id — the vector tables key by it (#32). */
  readonly storeId: number;
  /**
   * The content the store actually holds for this message — the winning
   * row's, which on a losing re-delivery is NOT what the caller passed
   * (first write wins). Embed from this, never from the caller's row:
   * one bundle state must have exactly one index (#32).
   */
  readonly content: string;
  /**
   * Whether the row the store HOLDS is an opaque delivery (ticket #124) —
   * the same rule as `content` one field further: what may be embedded is
   * decided by what the store holds, never by what the caller passed
   * (Codex r1). A caller that read only its own row would embed the
   * placeholder the store kept whenever the two rows disagree about their
   * class, which is exactly the never-embedded invariant ADR-0042 rests
   * on.
   */
  readonly opaque: boolean;
}

/** The outcome of one idempotent vector write (ticket #32). */
export interface VectorWriteResult {
  /** Whether THIS call stored the vector (false: one already existed). */
  readonly stored: boolean;
}

/** A message store row still awaiting its vector (#32's backlog selection). */
export interface UnembeddedMessage {
  /** The message's stable interior id — the vector write keys by it. */
  readonly storeId: number;
  /** The text the embedder turns into the vector. */
  readonly content: string;
}

/** One retrieval hit (ticket #32): a stored message with its distance to the query. */
export interface ScoredMessage {
  readonly message: ConversationRow;
  /** Cosine distance to the query vector — 0 is identical, smaller is nearer. */
  readonly distance: number;
}

/** How a retrieval query is scoped and bounded (ticket #32). */
export interface SearchOptions {
  /** Restrict hits to one chat's messages (vec0 partition pruning). */
  readonly chatJid?: string;
  /**
   * Put one chat's messages OUT OF THIS QUERY'S REACH (ticket #196; ADR-0033;
   * spec #193 decision 18: "excluded at the row source and never by filter").
   *
   * The extraction execution searches every conversation of the rep's EXCEPT
   * the twin thread: a rep's instruction to their twin must never become a
   * fact about a customer, and the twin thread is where those instructions
   * live. This is the row source rather than a filter over the result — the
   * predicate rides INSIDE the vec0 KNN subquery, so the partition is pruned
   * before `k` is applied and the page comes back full of chats the caller
   * may see.
   *
   * WHY A FILTER WOULD NOT DO, and it is the same arithmetic `searchMessages`
   * already records for opaque rows: the subquery applies `k` first, so a row
   * dropped afterwards consumes a slot and the page comes back short — which
   * the callers read as "the store is exhausted". A twin whose thread is
   * busier than its customers' chats would report an empty history while the
   * answer sat in the store.
   */
  readonly excludeChatJid?: string;
  /** At most this many hits (default 10). */
  readonly limit?: number;
}

/**
 * An open bundle. The class is not exported as a value — construction goes
 * through createBundle/openBundle so every live handle is keyed, verified,
 * and migrated.
 */
class Bundle {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /** The bundle's stamped schema version (ADR-0029). */
  get schemaVersion(): number {
    return readSchemaVersion(this.#db);
  }

  /**
   * Enumerates the bundle's interior stores (table names) from the live
   * schema — FR-73's registry of rep-side stores. Everything here is
   * bundle-resident under the twin's one key by construction, and a store
   * added by a later migration joins the enumeration with no code change
   * (ticket #31; sqlite-vec shadow tables included — they hold vector
   * content and are as real as their parent).
   */
  listStores(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * The message store's ingest write (ticket #31): idempotent by
   * (chat, WhatsApp message id) — a re-delivered event, a crash-replay,
   * or a live/backfill overlap (#33) resolves to the one stored row, first
   * write wins. Returns whether this call stored the row and the message's
   * stable interior id (the vector tables key by it, #32).
   */
  ingestMessage(row: ConversationRow): IngestResult {
    const res = this.#db
      .prepare(
        `INSERT INTO conversation_messages
           (chat_jid, message_id, sender_jid, from_me, occurred_at, content,
            push_name, reaction_to, reaction_emoji, sender_ts_ms,
            opaque_kind, opaque_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_jid, message_id) DO NOTHING`,
      )
      .run(
        row.chatJid,
        row.messageId,
        row.senderJid,
        row.fromMe ? 1 : 0,
        row.occurredAt,
        row.content,
        row.pushName ?? null,
        row.reactionTo ?? null,
        row.reactionEmoji ?? null,
        row.senderTsMs ?? null,
        row.opaqueKind ?? null,
        row.opaqueOf ?? null,
      );
    if (res.changes === 1) {
      return {
        stored: true,
        storeId: Number(res.lastInsertRowid),
        content: row.content,
        opaque: row.opaqueKind !== undefined,
      };
    }
    const existing = this.#db
      .prepare(
        "SELECT id, content, opaque_kind FROM conversation_messages WHERE chat_jid = ? AND message_id = ?",
      )
      .get(row.chatJid, row.messageId) as
      | { id: number; content: string; opaque_kind: string | null }
      | undefined;
    if (existing === undefined) {
      // Unreachable while (chat_jid, message_id) is the sole conflict
      // target on this single-holder synchronous connection — but if a
      // later migration adds another constraint, a swallowed insert must
      // fail loudly, never resolve to a phantom row.
      throw new Error(
        `ingest stored nothing yet found no existing row for (${row.chatJid}, ${row.messageId}) — a constraint other than the message-id rule swallowed the insert`,
      );
    }
    return {
      stored: false,
      storeId: existing.id,
      content: existing.content,
      opaque: existing.opaque_kind !== null,
    };
  }

  /**
   * Reads one chat's messages in chronological order — the order every
   * surface that puts this conversation in front of a model reads it in.
   *
   * `ORDER BY occurred_at, id` is the COARSE order; `inDeliveryOrder` is the
   * fine one (ticket #109). A reaction's `occurred_at` is the rail's stanza
   * timestamp at whole SECONDS, so a 👍 and the removal that retracts it can
   * carry the same instant and be stored in the order the seam happened to
   * receive them — the reactor's own millisecond clock is what says which
   * tap came first, and this is the one place that spends it.
   *
   * AND `foldOpaqueDeliveries` DECIDES WHICH ROW STANDS (ticket #124). The
   * seam folds nothing, so twin memory can hold both the readable row for
   * a message and the opaque row that says the plane could not read it —
   * one message is still one beat, and the fold is what makes that true
   * for every reader of this conversation at once.
   */
  readConversation(chatJid: string): ConversationRow[] {
    const rows = this.#db
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS}
         FROM conversation_messages
         WHERE chat_jid = ?
         ORDER BY occurred_at, id`,
      )
      .all(chatJid) as ConversationMessageRow[];
    return inDeliveryOrder(
      foldOpaqueDeliveries(rows.map(toConversationRow), (row) => row),
      (row) => row,
    );
  }

  /**
   * One stored message by its rail id, or undefined when twin memory does
   * not hold it (ticket #97): the deterministic read-back a reaction's
   * target text comes from. Undefined is a real answer — a gesture at a
   * message from before the QR code has nothing to inline.
   */
  readMessage(chatJid: string, messageId: string): ConversationRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT ${CONVERSATION_COLUMNS}
         FROM conversation_messages
         WHERE chat_jid = ? AND message_id = ?`,
      )
      .get(chatJid, messageId) as ConversationMessageRow | undefined;
    return row === undefined ? undefined : toConversationRow(row);
  }

  /**
   * How many message vectors the bundle holds (ticket #31: born zero;
   * #32's embedding path fills the sqlite-vec table — vectors never leave
   * the bundle, ADR-0007).
   */
  countMessageVectors(): number {
    const row = this.#db
      .prepare("SELECT count(*) AS n FROM message_vectors")
      .get() as { n: number };
    return row.n;
  }

  /**
   * The messages still awaiting their vector, oldest first (interior
   * order), at most `limit` of them — one bite of the embedding backlog
   * (ticket #32). Restart-safety comes from this selection: a killed
   * batch re-selects only what it never wrote.
   *
   * AN OPAQUE DELIVERY IS NEVER SELECTED (ticket #124; ADR-0042: "never
   * embedded"). A placeholder is not an utterance — indexing «[foto]»
   * would put the husk's pollution back into the vector store under a new
   * name, and every such row would rank against every other. Excluded HERE
   * rather than at each write site so it is a property of twin memory: the
   * backlog is the one selection that would otherwise reach a row whose
   * ingest deliberately skipped embedding, and the loop that drains it
   * assumes everything it selects can be given a vector.
   */
  listUnembeddedMessages(limit: number): UnembeddedMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT m.id, m.content
           FROM conversation_messages m
          WHERE m.id NOT IN (SELECT message_id FROM message_vectors)
            AND m.opaque_kind IS NULL
          ORDER BY m.id
          LIMIT ?`,
      )
      .all(limit) as { id: number; content: string }[];
    return rows.map((r) => ({ storeId: r.id, content: r.content }));
  }

  /** Whether the message with this interior id already has its vector. */
  hasMessageVector(storeId: number): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM message_vectors WHERE message_id = ?")
        .get(storeId) !== undefined
    );
  }

  /**
   * Stores one message's embedding, keyed by the message's stable interior
   * id (ticket #32). Idempotent, first write wins — a crash-replay or a
   * re-delivered event resolves onto the stored vector, never a duplicate
   * (the vector analogue of the message store's ingest rule). The vector
   * is partitioned under the message's own chat, read from the message
   * store — chat-scoped retrieval prunes by construction.
   */
  writeMessageVector(
    storeId: number,
    embedding: Float32Array,
  ): VectorWriteResult {
    const blob = vectorBlob(embedding);
    const message = this.#db
      .prepare("SELECT chat_jid FROM conversation_messages WHERE id = ?")
      .get(storeId) as { chat_jid: string } | undefined;
    if (message === undefined) {
      throw new MessageNotInStoreError(storeId);
    }
    if (this.hasMessageVector(storeId)) {
      return { stored: false };
    }
    // vec0 demands a true INTEGER binding for its primary key (a JS
    // number binds as REAL through this driver and is refused): BigInt.
    this.#db
      .prepare(
        "INSERT INTO message_vectors (message_id, chat_jid, embedding) VALUES (?, ?, ?)",
      )
      .run(BigInt(storeId), message.chat_jid, blob);
    return { stored: true };
  }

  /**
   * The nearest stored messages to a query vector (ticket #32): cosine
   * order over the sqlite-vec store, nearest first, optionally scoped to
   * one chat, or scoped AWAY from one (the vec0 partition prunes either way
   * — a globally-nearer hit in another chat can never leak into the scope,
   * and a hit in an excluded chat can never leak out of it, ticket #196).
   * The query vector never persists anywhere; hits come back through the
   * message store's own row shape.
   *
   * Mechanics note vs ADR-0007: the ADR sketches quantized vectors hot
   * in RAM with a full-precision rescore; this slice searches the
   * full-precision vectors exactly, in SQL, inside the bundle. The
   * residency invariant (vectors under the one key) is identical; the
   * RAM-cache layer is a ceiling-driven optimization (~100K vectors)
   * that can arrive behind this same API when a slice needs it.
   *
   * RETRIEVAL IS NOT OPAQUE-AWARE, and that is a recorded limit rather than
   * an oversight (ticket #124; Codex r2 built it, r3 showed the cost).
   * ADR-0042 puts opaque rows outside the vector store outright — «never
   * embedded» — so a placeholder can never BE a hit; and a legacy husk that
   * an opaque row now stands over already has a vector, so it can still be
   * one. Filtering the husk out here looked free and is not: the vec0
   * subquery applies `k` BEFORE any outer predicate, so an excluded row
   * consumes a slot and the page comes back short — which is exactly the
   * signal `searchEligible` reads as «the store is exhausted» (see
   * `answering.ts`). The twin would then report no history while the answer
   * sat in the store, which is a worse failure than the blank line it
   * removed, and sizing it correctly means over-fetching by the number of
   * opaque rows in the chat, which is unbounded in a media-heavy one.
   * Expansion and exclusion are one decision and the ADR forecloses the
   * expansion half; the transcript is where the fold shows.
   */
  searchMessages(
    embedding: Float32Array,
    options: SearchOptions = {},
  ): ScoredMessage[] {
    const query = vectorBlob(embedding);
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
    // KNN runs inside the vec0 subquery (MATCH + k, partition-pruned when
    // scoped); the join hydrates each hit from the message store.
    // BOTH PREDICATES RIDE INSIDE THE SUBQUERY, on the vec0 PARTITION KEY, so
    // each one prunes partitions before `k` selects rows rather than filtering
    // the page after it (`SearchOptions.excludeChatJid` argues why that
    // distinction is the whole of ADR-0033's exclusion).
    const scope = [
      options.chatJid === undefined ? "" : "AND chat_jid = @chatJid",
      options.excludeChatJid === undefined
        ? ""
        : "AND chat_jid != @excludeChatJid",
    ]
      .filter((clause) => clause !== "")
      .join(" ");
    const rows = this.#db
      .prepare(
        `SELECT m.chat_jid, m.message_id, m.sender_jid, m.from_me,
                m.occurred_at, m.content, m.push_name, m.reaction_to,
                m.reaction_emoji, m.sender_ts_ms, m.opaque_kind, m.opaque_of,
                v.distance
           FROM (SELECT message_id, distance
                   FROM message_vectors
                  WHERE embedding MATCH @query AND k = @k ${scope}) v
           JOIN conversation_messages m ON m.id = v.message_id
          ORDER BY v.distance, m.id`,
      )
      .all({
        query,
        k: limit,
        ...(options.chatJid === undefined ? {} : { chatJid: options.chatJid }),
        ...(options.excludeChatJid === undefined
          ? {}
          : { excludeChatJid: options.excludeChatJid }),
      }) as (ConversationMessageRow & { distance: number })[];
    return rows.map((r) => ({
      message: toConversationRow(r),
      distance: r.distance,
    }));
  }

  /**
   * Writes one rep-confirmed binding into the entity mirror (#34's
   * ceremony calls this). One binding per chat, first confirmation
   * stands: rebinding is entity lifecycle (rename/merge), out of scope
   * until the crossing — a second confirm refuses typed.
   */
  confirmChatBinding(binding: ChatBinding): void {
    try {
      this.#db.transaction(() => {
        this.#db
          .prepare(
            `INSERT INTO entity_mirror (chat_jid, entity_id, display_name, confirmed_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            binding.chatJid,
            binding.entityId,
            binding.displayName,
            binding.confirmedAt,
          );
        this.#referTo(binding);
      })();
    } catch (err) {
      if (
        (err as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      ) {
        throw new ChatAlreadyBoundError(binding.chatJid, { cause: err });
      }
      throw err;
    }
  }

  /**
   * THE CONFIRMED CUSTOMER'S REFERENCE, given at the confirmation and in its
   * transaction (ticket #321): the reference the chat already had while
   * nobody had confirmed it becomes the customer's, so a reference the twin
   * wrote before the «si» names the same person after it. An entity that
   * already has one keeps it, and the chat's own goes — one reference per
   * customer.
   */
  #referTo(binding: ChatBinding): void {
    const own = this.referenceOfEntity(binding.entityId);
    const chat = this.#db
      .prepare(`SELECT number FROM customer_references WHERE chat_jid = ?`)
      .get(binding.chatJid) as { number: number } | undefined;
    if (own === undefined && chat !== undefined) {
      this.#db
        .prepare(
          `UPDATE customer_references SET entity_id = ?, chat_jid = NULL WHERE number = ?`,
        )
        .run(binding.entityId, chat.number);
    } else if (own === undefined) {
      this.#db
        .prepare(`INSERT INTO customer_references (entity_id) VALUES (?)`)
        .run(binding.entityId);
    } else if (chat !== undefined) {
      this.#db
        .prepare(`DELETE FROM customer_references WHERE number = ?`)
        .run(chat.number);
    }
  }

  /** A confirmed customer's reference (ticket #321). */
  referenceOfEntity(entityId: string): number | undefined {
    const row = this.#db
      .prepare(`SELECT number FROM customer_references WHERE entity_id = ?`)
      .get(entityId) as { number: number } | undefined;
    return row?.number;
  }

  /**
   * The reference a chat is named by — its customer's when the rep confirmed
   * it, its own when one was given while nobody had — or nothing. This method
   * gives none; `referenceForChat` is the one that does.
   */
  referenceOfChat(chatJid: string): number | undefined {
    const binding = this.readChatBinding(chatJid);
    if (binding !== undefined) return this.referenceOfEntity(binding.entityId);
    const row = this.#db
      .prepare(`SELECT number FROM customer_references WHERE chat_jid = ?`)
      .get(chatJid) as { number: number } | undefined;
    return row?.number;
  }

  /**
   * ...and the same, giving a chat nobody has confirmed its own reference the
   * first time the twin is shown it (ticket #321). Once given it stands for
   * the rest of the chat's life, and a confirmation hands it to the customer.
   */
  referenceForChat(chatJid: string): number {
    const known = this.referenceOfChat(chatJid);
    if (known !== undefined) return known;
    if (this.readChatBinding(chatJid) !== undefined) {
      // A CONFIRMED CHAT WHOSE CUSTOMER HAS NO REFERENCE is a bundle older
      // than v11's backfill could reach — impossible past the migration —
      // and minting one here would give a confirmed customer a chat's row.
      throw new Error(
        `the chat's customer has no reference, though every confirmation gives one (ticket #321)`,
      );
    }
    return Number(
      this.#db
        .prepare(`INSERT INTO customer_references (chat_jid) VALUES (?)`)
        .run(chatJid).lastInsertRowid,
    );
  }

  /** What a reference names, or nothing when no row has that number. */
  readReference(number: number): CustomerReference | undefined {
    const row = this.#db
      .prepare(
        `SELECT number, entity_id, chat_jid FROM customer_references WHERE number = ?`,
      )
      .get(number) as
      | { number: number; entity_id: string | null; chat_jid: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return row.entity_id !== null
      ? { number: row.number, entityId: row.entity_id }
      : { number: row.number, chatJid: row.chat_jid! };
  }

  /**
   * Every chat the rep confirmed as one customer's, in the order they
   * confirmed them (ticket #321) — the order a chat is picked by.
   */
  chatsOfEntity(entityId: string): ChatBinding[] {
    const rows = this.#db
      .prepare(
        `SELECT chat_jid, entity_id, display_name, confirmed_at
           FROM entity_mirror WHERE entity_id = ?
          ORDER BY confirmed_at, chat_jid`,
      )
      .all(entityId) as ChatBindingRow[];
    return rows.map(toChatBinding);
  }

  /**
   * The push-names the other side of a chat wrote under, newest first, one
   * row per message (ticket #321): what an unconfirmed chat is named by and
   * what its binding question can rest on. A gesture is not a message, and
   * an empty push-name names nobody.
   */
  pushNamesFromOtherSide(chatJid: string, limit: number): PushNameRow[] {
    const rows = this.#db
      .prepare(
        `SELECT message_id, push_name
           FROM conversation_messages
          WHERE chat_jid = ? AND from_me = 0 AND reaction_to IS NULL
            AND push_name IS NOT NULL AND push_name <> ''
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?`,
      )
      .all(chatJid, limit) as { message_id: string; push_name: string }[];
    return rows.map((row) => ({ messageId: row.message_id, pushName: row.push_name }));
  }

  /** Reads one chat's rep-confirmed binding, if the rep has confirmed one. */
  readChatBinding(chatJid: string): ChatBinding | undefined {
    const row = this.#db
      .prepare(
        `SELECT chat_jid, entity_id, display_name, confirmed_at
         FROM entity_mirror WHERE chat_jid = ?`,
      )
      .get(chatJid) as ChatBindingRow | undefined;
    return row === undefined ? undefined : toChatBinding(row);
  }

  /**
   * WHEN EACH CONVERSATION LAST SAID ANYTHING, by chat (ticket #196, Codex
   * round 1).
   *
   * ONE STATEMENT AND NO CONTENT, which is the whole reason it exists beside
   * `readConversation`. The extraction's `list_chats` needs one instant per
   * bound chat and nothing else; reading it through `readConversation` loads
   * every column of every message in that chat, folds its opaque deliveries
   * and sorts it in JavaScript — once per binding, synchronously, on the loop
   * that also drafts. A rep with imported history would pay for their whole
   * message store to answer a question about a timestamp, and the batch lane
   * would block the realtime one it exists to stay off.
   *
   * `idx_conversation_messages_chat_time` is what makes it cheap: the group
   * is the index's own leading column and the max is its tail.
   *
   * The instant is the ROW's, not the delivery order's — `readConversation`
   * re-orders a reaction against its target, and "when did this conversation
   * last say anything" is not a question that ordering changes.
   */
  lastMessageInstants(): Map<string, string> {
    const rows = this.#db
      .prepare(
        `SELECT chat_jid, max(occurred_at) AS last_at
           FROM conversation_messages
          GROUP BY chat_jid`,
      )
      .all() as { chat_jid: string; last_at: string }[];
    return new Map(rows.map((row) => [row.chat_jid, row.last_at]));
  }

  /**
   * EACH CONVERSATION'S NEWEST MESSAGE: WHEN, AND WHICH SIDE WROTE IT, by
   * chat (ticket #396) — what the twin's `list_chats` tells a customer who is
   * waiting on the rep from one the rep is waiting on.
   *
   * A MESSAGE, NOT A GESTURE, for `lastMessageFromOtherSide`'s reason: a
   * thumbs-up is not a reply. ONE STATEMENT AND NO CONTENT: SQLite takes a
   * bare column from the row `max` chose, so the side is the newest row's.
   */
  lastMessages(): Map<string, { readonly occurredAt: string; readonly fromMe: boolean }> {
    const rows = this.#db
      .prepare(
        `SELECT chat_jid, max(occurred_at) AS last_at, from_me
           FROM conversation_messages
          WHERE reaction_to IS NULL
          GROUP BY chat_jid`,
      )
      .all() as { chat_jid: string; last_at: string; from_me: number }[];
    return new Map(rows.map((row) => [row.chat_jid, { occurredAt: row.last_at, fromMe: row.from_me === 1 }]));
  }

  /**
   * WHEN THE OTHER SIDE OF ONE CHAT LAST WROTE, or undefined when it never
   * has (ticket #300): the day `resolve_chat`'s hint tells two chats
   * confirmed under one name apart by.
   *
   * A MESSAGE, NOT A GESTURE. A reaction row is the other side tapping an
   * emoji at something, and «te escribió el 26» about a thumbs-up would be a
   * claim the rep checks and finds false. An opaque row stays: the plane
   * could not read it, but the other side did send it.
   *
   * ONE ROW AND NO CONTENT. `idx_conversation_messages_chat_time` leads with
   * the chat and ends with the instant, so the walk runs backwards from the
   * newest row and stops at the first one the other side wrote — its cost is
   * the rows after that one (the rep's own messages and anybody's
   * reactions), never the chat's history.
   */
  lastMessageFromOtherSide(chatJid: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT occurred_at
           FROM conversation_messages
          WHERE chat_jid = ? AND from_me = 0 AND reaction_to IS NULL
          ORDER BY occurred_at DESC
          LIMIT 1`,
      )
      .get(chatJid) as { occurred_at: string } | undefined;
    return row?.occurred_at;
  }

  /**
   * THE FIRST MESSAGE THE OTHER SIDE WROTE IN ANY OF THESE CHATS AFTER AN
   * INSTANT, or undefined (ticket #324): what a run's wait on a customer's
   * reply is due on — its id and its instant, and never its words.
   *
   * A MESSAGE, NOT A GESTURE, for `lastMessageFromOtherSide`'s reason: a
   * thumbs-up is not a reply. ONE ROW AND NO CONTENT, walking
   * `idx_conversation_messages_chat_time` forward from the instant.
   */
  firstMessageFromOtherSideAfter(
    chatJids: readonly string[],
    after: string,
  ): { readonly messageId: string; readonly occurredAt: string } | undefined {
    if (chatJids.length === 0) return undefined;
    const row = this.#db
      .prepare(
        `SELECT message_id, occurred_at
           FROM conversation_messages
          WHERE chat_jid IN (${chatJids.map(() => "?").join(", ")})
            AND from_me = 0 AND reaction_to IS NULL AND occurred_at > ?
          ORDER BY occurred_at
          LIMIT 1`,
      )
      .get(...chatJids, after) as { message_id: string; occurred_at: string } | undefined;
    return row === undefined ? undefined : { messageId: row.message_id, occurredAt: row.occurred_at };
  }

  /** Every rep-confirmed binding in the mirror (chat order). */
  listChatBindings(): ChatBinding[] {
    const rows = this.#db
      .prepare(
        `SELECT chat_jid, entity_id, display_name, confirmed_at
         FROM entity_mirror ORDER BY chat_jid`,
      )
      .all() as ChatBindingRow[];
    return rows.map(toChatBinding);
  }

  /**
   * Appends what the rep has taught, or refuses it for length (ticket #260).
   *
   * THE WHOLE NOTEBOOK IS THE UNIT, and that is what makes the cap safe. A
   * caller handed "add this rule" could only ever drop an older one when the
   * block filled up; a caller handed "here is the notebook" rewrites it, and
   * the refusal below gives it the standing text to rewrite FROM. So there is
   * no partial write and no edit — every write is a new version of the whole
   * thing (ADR-0033; #41 Q5).
   *
   * CHECKED HERE, BEFORE THE STATEMENT, AND ALSO IN THE SCHEMA. The typed
   * refusal is what a caller can act on — a constraint exception is not — and
   * the CHECK is what makes the bound a property of the store rather than of
   * this method's manners. `notepadLength` is what keeps the two counting the
   * same characters.
   *
   * CONCURRENT WRITERS LAND IN ORDER AND THE NEWEST IS CURRENT, which is a
   * hazard worth naming rather than a guarantee. The rep runtime runs several
   * executions at once over one open bundle (its own `lanes.ts`), so two
   * turns that each rewrite the notebook from the same starting text leave
   * the later one current and the earlier one a version behind it. Nothing is
   * destroyed — that is exactly what append-only buys — but the current text
   * is one writer's view of the notebook rather than a merge of two, and a
   * caller that needs "the text I was shown is still the text that stands"
   * has to establish it itself.
   */
  writeNotepad(args: {
    readonly text: string;
    readonly writtenAt: string;
    readonly executionId: string;
    readonly evidenceRef: string;
  }): NotepadWrite {
    const chars = notepadLength(args.text);
    if (chars > NOTEPAD_CAP) {
      return {
        outcome: "over_cap",
        cap: NOTEPAD_CAP,
        charsAttempted: chars,
        // THE TEXT THAT STILL STANDS, read at the refusal rather than
        // remembered by the caller: a consolidation made from anything else
        // is a consolidation that can lose a rule.
        currentText: this.readNotepad()?.text ?? "",
      };
    }
    const row = this.#db
      .prepare(
        `INSERT INTO notepad_versions (text, written_at, execution_id, evidence_ref)
         VALUES (?, ?, ?, ?)
         RETURNING id, text, written_at, execution_id, evidence_ref`,
      )
      .get(
        args.text,
        args.writtenAt,
        args.executionId,
        args.evidenceRef,
      ) as NotepadRow;
    return { outcome: "written", version: toNotepadVersion(row) };
  }

  /**
   * What the rep has taught the twin, as it stands — or nothing, when they
   * have taught it nothing at all (ticket #260).
   *
   * THE NEWEST ROW IS THE CURRENT ONE, which is the whole of the
   * append-only design: every earlier version stays where it was written and
   * no reader has to know that to read the notebook.
   *
   * `undefined` IS "NOBODY HAS TAUGHT THIS TWIN ANYTHING" and is a different
   * answer from a version whose text is EMPTY, which is the rep clearing
   * their notebook (#264's delete). The recipe renders the two the same way
   * — the default line alone — and the store still says which happened.
   */
  readNotepad(): NotepadVersion | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, text, written_at, execution_id, evidence_ref
           FROM notepad_versions ORDER BY id DESC LIMIT 1`,
      )
      .get() as NotepadRow | undefined;
    return row === undefined ? undefined : toNotepadVersion(row);
  }

  /**
   * The version one act wrote, current or not — or nothing, when that act
   * wrote none (ticket #264).
   *
   * RECOVERY'S QUESTION, NOT A READER'S. A Mi libreta save commits its act
   * row, writes the version, then commits its account; a runtime that fails
   * between the last two leaves an act with no account, and the only fact
   * that says whether its version landed is this table. `evidence_ref` is the
   * act's own id, so the answer is exact whatever was written after it.
   */
  readNotepadByEvidence(evidenceRef: string): NotepadVersion | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, text, written_at, execution_id, evidence_ref
           FROM notepad_versions WHERE evidence_ref = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(evidenceRef) as NotepadRow | undefined;
    return row === undefined ? undefined : toNotepadVersion(row);
  }

  /**
   * Appends a version of the twin's working memory, or refuses it for length
   * (ticket #322).
   *
   * `writeNotepad`'s shape and its reasons: the whole prose and the whole
   * list are the unit, every cap is checked here before the statement AND in
   * the schema, and a refusal is a value carrying the version that stands.
   * The label's cap is this method's alone (`OPEN_MATTER_LABEL_CAP` argues
   * why the schema cannot hold it).
   */
  writeWorkingMemory(args: {
    readonly text: string;
    readonly matters: readonly OpenMatter[];
    readonly writtenAt: string;
    readonly executionId: string;
  }): WorkingMemoryWrite {
    const chars = notepadLength(args.text);
    const labelsTooLong = args.matters
      .map((matter) => matter.label)
      .filter((label) => notepadLength(label) > OPEN_MATTER_LABEL_CAP);
    if (
      chars > WORKING_MEMORY_CAP ||
      args.matters.length > WORKING_MEMORY_MATTERS_CAP ||
      labelsTooLong.length > 0
    ) {
      return {
        outcome: "over_cap",
        cap: WORKING_MEMORY_CAP,
        charsAttempted: chars,
        mattersCap: WORKING_MEMORY_MATTERS_CAP,
        mattersAttempted: args.matters.length,
        labelCap: OPEN_MATTER_LABEL_CAP,
        labelsTooLong,
        current: this.readWorkingMemory(),
      };
    }
    const row = this.#db
      .prepare(
        `INSERT INTO working_memory_versions (text, matters, written_at, execution_id)
         VALUES (?, ?, ?, ?)
         RETURNING id, text, matters, written_at, execution_id`,
      )
      .get(
        args.text,
        JSON.stringify(
          args.matters.map((matter) => ({
            label: matter.label,
            about: { kind: matter.about.kind, id: matter.about.id },
          })),
        ),
        args.writtenAt,
        args.executionId,
      ) as WorkingMemoryRow;
    return { outcome: "written", version: toWorkingMemoryVersion(row) };
  }

  /**
   * The twin's working memory as it stands — or nothing, when it has never
   * written one (ticket #322). The newest row is the current one.
   */
  readWorkingMemory(): WorkingMemoryVersion | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, text, matters, written_at, execution_id
           FROM working_memory_versions ORDER BY id DESC LIMIT 1`,
      )
      .get() as WorkingMemoryRow | undefined;
    return row === undefined ? undefined : toWorkingMemoryVersion(row);
  }

  /**
   * Writes one rutina's content (ticket #325). The sentence's cap is checked
   * here and in v13's CHECK, one number (`AUTOMATION_SENTENCE_CAP`); a
   * sentence past it is the caller's to refuse before it gets here, so this
   * throws rather than answering.
   */
  writeAutomation(content: AutomationContent): void {
    const chars = notepadLength(content.sentence);
    if (chars < 1 || chars > AUTOMATION_SENTENCE_CAP) {
      throw new RangeError(
        `a rutina's sentence is 1 to ${String(AUTOMATION_SENTENCE_CAP)} characters; this one is ${String(chars)} (ticket #325)`,
      );
    }
    this.#db
      .prepare(
        `INSERT INTO automation_definitions (id, definition, sentence, written_at, execution_id, evidence_ref)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        content.id,
        content.definition,
        content.sentence,
        content.writtenAt,
        content.executionId,
        content.evidenceRef,
      );
  }

  /** One rutina's content, or nothing when the bundle holds none for that id. */
  readAutomation(id: string): AutomationContent | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, definition, sentence, written_at, execution_id, evidence_ref
           FROM automation_definitions WHERE id = ?`,
      )
      .get(id) as AutomationRow | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          definition: row.definition,
          sentence: row.sentence,
          writtenAt: row.written_at,
          executionId: row.execution_id,
          evidenceRef: row.evidence_ref,
        };
  }

  /** Every rutina id this bundle holds content for (ticket #325). */
  listAutomationIds(): string[] {
    const rows = this.#db.prepare("SELECT id FROM automation_definitions ORDER BY id").all() as {
      id: string;
    }[];
    return rows.map((row) => row.id);
  }

  /**
   * Deletes one rutina's content — once its seam row is gone (ticket #325:
   * «both hard-deleted with the automation»). Whether a row was there to
   * delete.
   */
  deleteAutomation(id: string): boolean {
    return this.#db.prepare("DELETE FROM automation_definitions WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Writes one version of one workspace file (ticket #326). The caller names
   * the version — one more than the path's last — and the store refuses a
   * second row for the same path and version, so a version once written is
   * never replaced; nothing updates a row (v14's trigger).
   */
  writeWorkspaceVersion(version: WorkspaceVersion): void {
    this.#db
      .prepare(
        `INSERT INTO workspace_versions (id, path, version, sha256, title, content, written_at, execution_id, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.path,
        version.version,
        version.sha256,
        version.title,
        version.content,
        version.writtenAt,
        version.executionId,
        version.runId ?? null,
      );
  }

  /** One workspace version by its id, or nothing when the bundle holds none. */
  readWorkspaceVersion(id: string): WorkspaceVersion | undefined {
    const row = this.#db
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspace_versions WHERE id = ?`)
      .get(id) as WorkspaceVersionRow | undefined;
    return row === undefined ? undefined : toWorkspaceVersion(row);
  }

  /** A workspace file's newest version, or nothing when it has none. */
  latestVersionOf(path: string): WorkspaceVersion | undefined {
    const row = this.#db
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspace_versions WHERE path = ? ORDER BY version DESC LIMIT 1`)
      .get(path) as WorkspaceVersionRow | undefined;
    return row === undefined ? undefined : toWorkspaceVersion(row);
  }

  /**
   * EVERY WORKSPACE DOCUMENT, ONE ROW EACH (ticket #368): each path's latest
   * version, newest first — what Mi libreta lists, whether or not a card for
   * the document is still on the canvas.
   */
  listWorkspaceDocuments(): WorkspaceDocument[] {
    const rows = this.#db
      .prepare(
        `SELECT id, path, title, version, written_at FROM workspace_versions w
          WHERE version = (SELECT max(version) FROM workspace_versions v WHERE v.path = w.path)
          ORDER BY written_at DESC, path`,
      )
      .all() as { id: string; path: string; title: string; version: number; written_at: string }[];
    return rows.map((row) => ({ id: row.id, path: row.path, title: row.title, version: row.version, writtenAt: row.written_at }));
  }

  /** Every version of one workspace file, oldest first. */
  listWorkspaceVersions(path: string): WorkspaceVersion[] {
    const rows = this.#db
      .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspace_versions WHERE path = ? ORDER BY version`)
      .all(path) as WorkspaceVersionRow[];
    return rows.map(toWorkspaceVersion);
  }

  /**
   * ERASES ONE WORKSPACE DOCUMENT (ticket #326): every version of the path,
   * and recall's item for each, at once — erasure, never an edit; a version
   * that stays is whole. How many versions went.
   */
  deleteWorkspaceVersions(path: string): number {
    return this.#db.transaction(() => {
      this.#db
        .prepare(
          `DELETE FROM thread_items WHERE role = 'workspace' AND id IN (SELECT id FROM workspace_versions WHERE path = ?)`,
        )
        .run(path);
      return this.#db.prepare("DELETE FROM workspace_versions WHERE path = ?").run(path).changes;
    })();
  }

  /**
   * Records one item of the twin thread's day (ticket #320) — idempotent by its
   * id, so a pass that indexes a turn twice stores it once.
   */
  recordThreadItem(item: ThreadItem & { readonly embedding?: Float32Array }): void {
    this.#db
      .prepare(
        `INSERT INTO thread_items (id, session_id, day, role, door, at, text, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        item.id,
        item.sessionId,
        item.day,
        item.role,
        item.door ?? null,
        item.at,
        item.text,
        item.embedding === undefined ? null : vectorBlob(item.embedding),
      );
  }

  /**
   * The thread's items matching a search, by words and by meaning (ticket
   * #320), newest-matched first within each half and the word matches first.
   *
   * THE WORDS ARE MATCHED HERE, FOLDED — case and accents off — because
   * SQLite's own `lower()` folds ASCII alone and «cotización» is how a rep
   * writes it. Every word of the query must appear. THE MEANING SIDE scores
   * the stored vectors against the query's by cosine distance, nearest first.
   * Both read only this store, inside the days asked for.
   */
  searchThreadItems(query: ThreadItemQuery): ThreadItem[] {
    const window = `day >= @since AND day <= @until`;
    const bounds = {
      since: query.since ?? "",
      until: query.until ?? "9999-12-31",
    };
    const limit = query.limit;
    const found = new Map<string, ThreadItem>();
    const words = foldedWords(query.words);
    if (words.length > 0) {
      const rows = this.#db
        .prepare(
          `SELECT id, session_id, day, role, door, at, text
             FROM thread_items WHERE ${window}
            ORDER BY at DESC, id DESC`,
        )
        .all(bounds) as ThreadItemRow[];
      for (const row of rows) {
        if (found.size >= limit) break;
        const text = foldText(row.text);
        if (words.every((word) => text.includes(word))) {
          found.set(row.id, toThreadItem(row));
        }
      }
    }
    if (query.embedding !== undefined && found.size < limit) {
      const rows = this.#db
        .prepare(
          `SELECT id, session_id, day, role, door, at, text
             FROM thread_items
            WHERE embedding IS NOT NULL AND ${window}
            ORDER BY vec_distance_cosine(embedding, @query), at DESC, id DESC
            LIMIT @k`,
        )
        .all({ ...bounds, query: vectorBlob(query.embedding), k: limit }) as ThreadItemRow[];
      for (const row of rows) {
        if (found.size >= limit) break;
        if (!found.has(row.id)) found.set(row.id, toThreadItem(row));
      }
    }
    return [...found.values()];
  }

  /** One item of the thread's day, whole, by its id. */
  readThreadItem(id: string): ThreadItem | undefined {
    const row = this.#db
      .prepare(
        `SELECT id, session_id, day, role, door, at, text
           FROM thread_items WHERE id = ?`,
      )
      .get(id) as ThreadItemRow | undefined;
    return row === undefined ? undefined : toThreadItem(row);
  }

  close(): void {
    this.#db.close();
  }
}

export type { Bundle };

/**
 * Every column `toConversationRow` reads — named once, so the two reads
 * that hydrate a whole row cannot drift apart when the store grows a
 * column (as it did at #97).
 */
const CONVERSATION_COLUMNS =
  "chat_jid, message_id, sender_jid, from_me, occurred_at, content, push_name, reaction_to, reaction_emoji, sender_ts_ms, opaque_kind, opaque_of";

/** Retrieval hits beyond this are noise this slice (#32's default bite). */
const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Validates the width and wraps a vector as the raw float32 blob
 * sqlite-vec speaks — the one gate every vector crosses on its way into
 * a statement (write and search alike).
 */
function vectorBlob(embedding: Float32Array): Buffer {
  if (embedding.length !== MESSAGE_VECTOR_DIMS) {
    throw new VectorDimensionMismatchError(
      MESSAGE_VECTOR_DIMS,
      embedding.length,
    );
  }
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

interface ConversationMessageRow {
  chat_jid: string;
  message_id: string;
  sender_jid: string;
  from_me: 0 | 1;
  occurred_at: string;
  content: string;
  push_name: string | null;
  reaction_to: string | null;
  reaction_emoji: string | null;
  sender_ts_ms: number | null;
  opaque_kind: string | null;
  opaque_of: string | null;
}

function toConversationRow(row: ConversationMessageRow): ConversationRow {
  return {
    chatJid: row.chat_jid,
    messageId: row.message_id,
    senderJid: row.sender_jid,
    fromMe: row.from_me === 1,
    occurredAt: row.occurred_at,
    content: row.content,
    ...(row.push_name === null ? {} : { pushName: row.push_name }),
    ...(row.reaction_to === null ? {} : { reactionTo: row.reaction_to }),
    // "" is a removal, never an absence — so the null test, not a falsy one.
    ...(row.reaction_emoji === null
      ? {}
      : { reactionEmoji: row.reaction_emoji }),
    // Absent on a message, and on a reaction older than schema v6.
    ...(row.sender_ts_ms === null ? {} : { senderTsMs: row.sender_ts_ms }),
    // Absent on everything but an opaque delivery (schema v7).
    ...(row.opaque_kind === null ? {} : { opaqueKind: row.opaque_kind }),
    ...(row.opaque_of === null ? {} : { opaqueOf: row.opaque_of }),
  };
}

interface ChatBindingRow {
  chat_jid: string;
  entity_id: string;
  display_name: string;
  confirmed_at: string;
}

function toChatBinding(row: ChatBindingRow): ChatBinding {
  return {
    chatJid: row.chat_jid,
    entityId: row.entity_id,
    displayName: row.display_name,
    confirmedAt: row.confirmed_at,
  };
}

interface NotepadRow {
  id: number;
  text: string;
  written_at: string;
  execution_id: string;
  evidence_ref: string;
}

function toNotepadVersion(row: NotepadRow): NotepadVersion {
  return {
    version: row.id,
    text: row.text,
    writtenAt: row.written_at,
    executionId: row.execution_id,
    evidenceRef: row.evidence_ref,
  };
}

interface AutomationRow {
  id: string;
  definition: string;
  sentence: string;
  written_at: string;
  execution_id: string;
  evidence_ref: string;
}

interface WorkingMemoryRow {
  id: number;
  text: string;
  matters: string;
  written_at: string;
  execution_id: string;
}

function toWorkingMemoryVersion(row: WorkingMemoryRow): WorkingMemoryVersion {
  return {
    version: row.id,
    text: row.text,
    // THE COLUMN IS VALID JSON BY ITS CHECK and every writer goes through
    // `writeWorkingMemory`, so this parse is over an array this module wrote.
    matters: JSON.parse(row.matters) as readonly OpenMatter[],
    writtenAt: row.written_at,
    executionId: row.execution_id,
  };
}

function readSchemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/**
 * Runs forward-only migrations to the current version, each step atomic
 * with its version bump (ADR-0029) — before any read leaves this module.
 */
function migrateToCurrent(db: Database.Database, path: string): void {
  const from = readSchemaVersion(db);
  if (from > BUNDLE_SCHEMA_VERSION) {
    throw new BundleSchemaTooNewError(path, from, BUNDLE_SCHEMA_VERSION);
  }
  for (const migration of BUNDLE_MIGRATIONS) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

/** Creates a new bundle file under the DEK, stamped and migrated to the current schema. */
export function createBundle(path: string, dek: Dek): Bundle {
  // Reserve the path atomically: O_CREAT|O_EXCL ("wx") is the kernel's own
  // exclusivity — no check-then-open race, and a symlink at the path
  // (dangling included) is refused rather than followed. Owner-only mode:
  // twin memory is nobody else's to read (ADR-0007).
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new BundleAlreadyExistsError(path);
    }
    throw err;
  }
  const db = openKeyed(path, dek, { fileMustExist: true });
  try {
    migrateToCurrent(db, path);
  } catch (err) {
    db.close();
    throw err;
  }
  return new Bundle(db);
}

/**
 * Opens an existing bundle under the DEK; forward-only migrations run
 * before any read, and reopening an already-current bundle is a no-op
 * (idempotent, ADR-0029).
 */
export function openBundle(path: string, dek: Dek): Bundle {
  const db = openKeyed(path, dek, { fileMustExist: true });
  try {
    // First touch of the file: under a wrong key SQLCipher refuses here
    // (SQLITE_NOTADB) — mapped to the typed refusal, never a fallback.
    // A version-0 file is refused too: SQLite happily treats an empty or
    // truncated file as a brand-new database, and "migrating" one would
    // dress total data loss up as a healthy empty bundle.
    if (readSchemaVersion(db) === 0) {
      throw new BundleUninitializedError(path);
    }
    migrateToCurrent(db, path);
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === "SQLITE_NOTADB") {
      throw new WrongBundleKeyError(path, { cause: err });
    }
    throw err;
  }
  return new Bundle(db);
}

/** The columns a workspace version is read with. */
const WORKSPACE_COLUMNS = "id, path, version, sha256, title, content, written_at, execution_id, run_id";

interface WorkspaceVersionRow {
  id: string;
  path: string;
  version: number;
  sha256: string;
  title: string;
  content: string;
  written_at: string;
  execution_id: string;
  run_id: string | null;
}

function toWorkspaceVersion(row: WorkspaceVersionRow): WorkspaceVersion {
  return {
    id: row.id,
    path: row.path,
    version: row.version,
    sha256: row.sha256,
    title: row.title,
    content: row.content,
    writtenAt: row.written_at,
    executionId: row.execution_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
  };
}

/** Who an item of the thread's day is from (ticket #320). */
export type ThreadItemRole = "rep" | "twin" | "event" | "workspace";

/** One item of the twin thread's day, as the store holds it (ticket #320). */
export interface ThreadItem {
  readonly id: string;
  /** The day's session it belongs to. */
  readonly sessionId: string;
  /** The seat-local day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly role: ThreadItemRole;
  /** The door a rep's line came through, or the door a reply answered at. */
  readonly door?: "dashboard" | "twin_thread";
  /** ISO instant. */
  readonly at: string;
  readonly text: string;
}

/** A search over the thread's items (ticket #320). */
export interface ThreadItemQuery {
  /** The words every lexical match must hold. */
  readonly words: readonly string[];
  /** The query's vector, for the meaning side. */
  readonly embedding?: Float32Array;
  /** The first seat-local day searched, `YYYY-MM-DD`, inclusive. */
  readonly since?: string;
  /** The last seat-local day searched, `YYYY-MM-DD`, inclusive. */
  readonly until?: string;
  readonly limit: number;
}

interface ThreadItemRow {
  id: string;
  session_id: string;
  day: string;
  role: ThreadItemRole;
  door: "dashboard" | "twin_thread" | null;
  at: string;
  text: string;
}

function toThreadItem(row: ThreadItemRow): ThreadItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    day: row.day,
    role: row.role,
    ...(row.door === null ? {} : { door: row.door }),
    at: row.at,
    text: row.text,
  };
}

/** A text with case and accents folded off, as the word match compares it. */
function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es");
}

/** The query's words, folded, empty ones dropped. */
function foldedWords(words: readonly string[]): string[] {
  return words.map(foldText).filter((word) => word !== "");
}

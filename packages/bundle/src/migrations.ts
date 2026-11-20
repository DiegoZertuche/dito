/**
 * Bundle schema migrations (ADR-0029): every bundle carries a schema version
 * stamp (SQLite's user_version); migrations are forward-only, run at
 * bundle-open before any read, and each step commits atomically with its
 * version bump — a bundle restored mid-migration simply re-runs the step.
 *
 * The list is the versioned artifact: a schema change is a new entry here,
 * visible in review before it is live (ADR-0029's rule for Postgres, applied
 * to the bundle's one migration home).
 */

export interface BundleMigration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

/**
 * HOW LONG THE REP NOTEPAD MAY BE, in characters (ticket #260; spec #258;
 * ADR-0033 — "one hard-capped block the rep writes").
 *
 * ONE NUMBER, TWO ENFORCEMENTS, AND THEY ARE THE SAME EXPRESSION. Migration
 * v9 interpolates it into its `CHECK (length(text) <= …)` and `writeNotepad`
 * compares against it before the statement, so the typed refusal the model
 * consolidates against and the constraint that makes the bound a property of
 * the STORE cannot state two different caps.
 *
 * MOVING IT IS A NEW MIGRATION, never an edit here. The CHECK belongs to
 * every bundle already stamped v9, so a smaller number would leave those
 * bundles on the old bound while this build refused earlier — which is why
 * v9's SQL is pinned by checksum in `migrations.test.ts`: changing this
 * constant fails that pin rather than drifting quietly.
 *
 * CHARACTERS, WHICH IS WHAT SQLite's `length()` COUNTS. The cap is a bound
 * on how much the rep may teach, so it is counted the way a person counts —
 * code points, not UTF-16 units and not bytes (`notepadLength`).
 */
export const NOTEPAD_CAP = 1500;

/**
 * HOW LONG THE TWIN'S WORKING MEMORY'S PROSE MAY BE, in characters (ticket
 * #322; spec #318 decision 2 — «capped at a value fixed at build a little above
 * the notepad's 1,500 characters»).
 *
 * TWO THOUSAND, A THIRD ABOVE THE NOTEPAD, because the two hold different
 * things at different rates. The notepad is the rep's standing rules, which
 * change when the rep teaches; the working memory is who is waiting on what
 * today, written by the twin in any turn, and a busy day holds a dozen live
 * matters at a sentence or two each. Two thousand characters is that day with
 * room to say why each one is open, and still a block the model reads on
 * every wake for about 600 tokens.
 *
 * `NOTEPAD_CAP`'s rules hold here word for word: one number interpolated into
 * migration v12's CHECK and compared by `writeWorkingMemory` before the
 * statement, CHARACTERS as SQLite's `length()` counts them (`notepadLength`),
 * and moving it is a new migration whose checksum pin fails first.
 */
export const WORKING_MEMORY_CAP = 2000;

/**
 * HOW MANY OPEN MATTERS THE WORKING MEMORY MAY LIST (ticket #322; spec #318
 * decision 32), counted as entries.
 *
 * TWELVE, BECAUSE EACH ONE IS A CHIP. The list is what code renders above the
 * bar's composer, one chip per matter, and a row of more than a dozen is a
 * list nobody picks from. It is a second cap beside the prose's because the
 * two are read differently: the prose by the model, the list by the rep's
 * eye. Held in the schema the same way — v12's CHECK on the JSON array's
 * length — so a write around the API is refused by the store.
 */
export const WORKING_MEMORY_MATTERS_CAP = 12;

/**
 * HOW LONG ONE OPEN MATTER'S LABEL MAY BE, in characters (ticket #322).
 *
 * SIXTY: the label IS the chip's text and the subject of the line a tap asks
 * («¿Dónde quedamos con Torres, el pedido del jueves?»), so it is a few words
 * the way a teammate names a thread, never a sentence. Checked by the writer
 * and not by the schema, because a SQLite CHECK cannot reach inside a JSON
 * array's elements; the writer is the one path into the store.
 */
export const OPEN_MATTER_LABEL_CAP = 60;

/**
 * HOW LONG A RUTINA'S SENTENCE MAY BE, in characters (ticket #325; spec #318
 * decision 29 — Rutinas shows the automation in the twin's first person).
 *
 * TWO HUNDRED AND EIGHTY: the sentence is the card's one line about what the
 * twin will do and when, the size of the shipped automations' own sentences
 * on the same page, with room for a customer's name and a time. Held in
 * v13's CHECK and compared by `writeAutomation` before the statement, the
 * notepad's rule, so the store and the writer cannot disagree.
 */
export const AUTOMATION_SENTENCE_CAP = 280;

export const BUNDLE_MIGRATIONS: readonly BundleMigration[] = [
  {
    version: 1,
    description:
      "conversation rows — a chat's messages with their metadata, nothing more (slice AC 10; ADR-0007: conversation history lives only inside the bundle)",
    sql: `
      CREATE TABLE conversation_messages (
        id INTEGER PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        from_me INTEGER NOT NULL CHECK (from_me IN (0, 1)),
        occurred_at TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE (chat_jid, message_id)
      );
    `,
  },
  {
    version: 2,
    description:
      "chronological read path — index conversation rows by (chat, occurred_at) so readConversation stays a range scan as history grows",
    sql: `
      CREATE INDEX idx_conversation_messages_chat_time
        ON conversation_messages (chat_jid, occurred_at);
    `,
  },
  {
    version: 3,
    description:
      "the slice-2 memory interior (ticket #31, spec #29 decision 8): the message store grows the sender push-name (nullable — filled once payload v:1 carries it, #30/#33; bindings and provisional-name rendering need it, spec #29 decisions 3 and 7), the entity mirror is born (rep-confirmed chat↔entity bindings, ADR-0004 — only ever here, never owner-visible; #34 fills it), and the sqlite-vec vector table is born (BGE-M3 dense vectors, 1024 dims — #32 fills it; vectors never leave the bundle, ADR-0007)",
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN push_name TEXT;
      CREATE TABLE entity_mirror (
        chat_jid TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        confirmed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE message_vectors USING vec0(
        message_id INTEGER PRIMARY KEY,
        embedding FLOAT[1024]
      );
    `,
  },
  {
    version: 4,
    description:
      "the retrieval-ready vector store (ticket #32, spec #29 decision 9): the vector table is recreated with the message's chat as a vec0 partition key (chat-scoped retrieval prunes to one chat's vectors instead of filtering after a global scan) and the cosine distance metric BGE-M3's normalized dense vectors are compared under. Dropping the v3 table loses nothing by construction: it was born empty at v3 and no build before this one ever wrote a vector (countMessageVectors was the whole v3 surface)",
    sql: `
      DROP TABLE message_vectors;
      CREATE VIRTUAL TABLE message_vectors USING vec0(
        message_id INTEGER PRIMARY KEY,
        chat_jid TEXT PARTITION KEY,
        embedding FLOAT[1024] DISTANCE_METRIC=cosine
      );
    `,
  },
  {
    version: 5,
    description:
      "reactions in twin memory (ticket #97; ADR-0041): a conversation row gains the id of the message it REACTS TO and the emoji placed on it — both null on an ordinary message, and the emoji is the EMPTY STRING on a removal. A reaction is remembered IN the message store rather than beside it, so it embeds, retrieves and renders as the beat it is with no second machinery. Two columns rather than one because the gesture line is COMPOSED, not stored: `reaction_to` keeps a gesture distinguishable from something the rep typed (which is what ‘has the rep already answered this by hand?’ must not confuse, ticket #75), and the pair is what lets the line be re-rendered against the target as twin memory holds it AT READ TIME — a gesture whose target arrives later must not stay bare forever",
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN reaction_to TEXT;
      ALTER TABLE conversation_messages ADD COLUMN reaction_emoji TEXT;
    `,
  },
  {
    version: 6,
    description:
      "the reactor's own clock (ticket #109): a conversation row gains `sender_ts_ms`, the seam payload's whole-millisecond instant ADR-0041 names as the fold key — null on an ordinary message and on every reaction stored before this version. `occurred_at` is the rail's stanza timestamp at WHOLE SECONDS, so a mistaken 👍 and the removal a fifth of a second later are indistinguishable under it, and a chronological read renders the retraction first whenever the seam happened to receive it first — a withdrawn agreement reading as one that stands. This column is the only thing that can break that tie, and `inDeliveryOrder` is its one reader. Nullable and NOT backfilled, deliberately: the value exists only in the seam payload the row was ingested from, so an older row genuinely has no clock, and a second holding one keeps its coarse order rather than being sorted on a number invented for it",
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN sender_ts_ms INTEGER;
    `,
  },
  {
    version: 7,
    description:
      "opaque deliveries in twin memory (ticket #124; ADR-0042): a conversation row gains the rail's own `opaque_kind` for a delivery the plane could not read, and `opaque_of` — the message that delivery stands for, read off its seam identity. Both null on everything else, which is what makes ‘is this row a placeholder?’ a question the store answers rather than one a reader infers from the text. Two columns for the reasons v5 needed two: `opaque_kind` is what keeps the row out of the embedding backlog (a placeholder is never embedded — that is what ends the empty-text husk's pollution of the vector store) and what a later promotion counts by, while `opaque_of` is the key the consumer's fold decides on, and it is ABSENT on the id-less `opaque:<hash>` shape, which truthfully stands for no message",
    sql: `
      ALTER TABLE conversation_messages ADD COLUMN opaque_kind TEXT;
      ALTER TABLE conversation_messages ADD COLUMN opaque_of TEXT;
    `,
  },
  {
    version: 8,
    description:
      "the twin thread's focus (ticket #175; spec #171 decisions 8(5) and 24; ADR-0033 as amended 2026-09-04): what the twin and the rep were just discussing — the chat and entity last resolved, the window of history the answer rested on, the draft last discussed, the candidates of an open ask, the execution that wrote it and when. It is the FIRST SINGLETON in this store, and the CHECK is what makes it one: the bundle is one file per twin (ADR-0007), so there is no `twin_id` column to key on and 'one row per twin' has to be spelled as 'one row' — `id INTEGER PRIMARY KEY CHECK (id = 1)`, which the upsert targets by conflict. Every column but the last three is NULLABLE because a thread turn legitimately resolves nothing: 'gracias' leaves a focus that names no chat, and a row of nulls is the honest record of a turn that discussed nobody — different from no row at all, which is a twin that has never been spoken to. `candidates` is NOT NULL and holds a JSON array because the empty list is a statement (no ask is open) rather than an absence, and because an ask's candidates are ORDERED — the next execution re-serves them in the order the rep was shown, which is what 'el segundo' resolves against. It carries no content: a chat address, an entity id, a name the rep already confirmed, two instants and two ids. It takes the next free version by build order (ADR-0029), which is the step ADR-0033's amendment assigns it — the notepad takes the eight-to-nine step at v9 below — and it moves FR-73's store count from seven to eight",
    sql: `
      CREATE TABLE focus (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chat_jid TEXT,
        entity_id TEXT,
        display_name TEXT,
        window_from TEXT,
        window_to TEXT,
        draft_id TEXT,
        candidates TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        written_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 9,
    description:
      "the rep notepad (ticket #260; spec #258; ADR-0033 as amended): what the rep has told the twin about how they work — register, how to address one customer, a sign-off, any standing rule — in their own words, written by them alone and never crossing the wall. APPEND-ONLY VERSIONS WITH THE NEWEST CURRENT, which is the one shape choice this table makes and the opposite of v8's singleton beside it: a focus is what the LAST turn resolved and is replaced whole, while a notepad is something the rep TAUGHT, and a teach that silently overwrote what they taught last month would lose it with nothing to read back. So `id` autoincrements, the current text is the newest row, and every earlier one stays (#41 Q5). An EMPTY `text` is a legal version — the rep clearing their notebook (#264's delete) — and is a different fact from no row at all, which is a twin nobody has taught anything. `execution_id` and `evidence_ref` are WHO wrote it: the execution, and the rep's own message that asked for it, which is the rep-evidenced gate's own id (ADR-0013). Opaque ids, never content. THE CAP IS IN THE SCHEMA, not only in the writer: `length()` counts characters in SQLite, so the CHECK and `writeNotepad`'s own comparison are one number (`NOTEPAD_CAP`) enforced at the same place — the write — and a write around the API is refused by the store rather than accepted quietly. It takes the next free version by build order (ADR-0029), which is the eight → nine step ADR-0033's 2026-09-04 amendment assigns it, and it moves FR-73's store count from eight to nine",
    sql: `
      CREATE TABLE notepad_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL CHECK (length(text) <= ${String(NOTEPAD_CAP)}),
        written_at TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        evidence_ref TEXT NOT NULL
      );
    `,
  },
  {
    version: 10,
    description:
      "the twin thread's own items (ticket #320; spec #318 decision 19): one row per thing the day's session holds that the twin may look for again — the rep's line with the door it came through, the twin's reply, an event's line — with the session it belongs to, the seat-local day, the instant, the text and its vector. Written by the runtime per turn from what it already holds; NEVER a tool's result, because customer text reaches the thread only through the tool that returned it (spec #318 decision 12) and that tool is how it is found again. ONE TABLE AND NO vec0: the vector is a BLOB beside the row and the meaning search scores it with sqlite-vec's `vec_distance_cosine` over the rows of the days asked for — one rep's own conversation is days of a few dozen items, so a scan is the cheaper machine and FR-73's store count moves by exactly one. `embedding` is NULL on an event, whose line is ids and words and has no meaning to search by. Opaque ids and the twin's own words; it moves FR-73's store count from nine to ten",
    sql: `
      CREATE TABLE thread_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        day TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('rep', 'twin', 'event')),
        door TEXT CHECK (door IS NULL OR door IN ('dashboard', 'twin_thread')),
        at TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX idx_thread_items_day ON thread_items (day, at, id);
    `,
  },
  {
    version: 11,
    description:
      "one stable reference per customer, and the focus retires (ticket #321; spec #318 decisions 16 and 18; D15, ruled 2026-09-28). `customer_references` gives every customer the twin can name one small number of its own, written `[c<number>]` wherever the twin speaks of them all day long, so a reference from the morning and one from the afternoon name the same customer. A row names an ENTITY — a customer the rep confirmed, one row however many chats the entity has — or a CHAT nobody has confirmed yet, which the twin may still name with the provisional mark; the CHECK makes it exactly one of the two. AUTOINCREMENT is the 'never reused' rule: a number a confirmation retires is never handed to somebody else. Every entity already in the mirror is backfilled here, in the order the rep confirmed them. The focus table goes with it: the day's session carries what the focus carried, and a reference the conversation already holds is what a rep pointing back at somebody resolves against. Opaque ids only; FR-73's store count stays at ten, one store out and one in",
    sql: `
      DROP TABLE focus;
      CREATE TABLE customer_references (
        number INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT UNIQUE,
        chat_jid TEXT UNIQUE,
        CHECK ((entity_id IS NULL) <> (chat_jid IS NULL))
      );
      INSERT INTO customer_references (entity_id)
        SELECT entity_id FROM entity_mirror
         GROUP BY entity_id
         ORDER BY min(confirmed_at), entity_id;
    `,
  },
  {
    version: 12,
    description:
      "the twin's working memory (ticket #322; spec #318 decisions 2, 32 and 33; ADR-0033 as amended): the twin's OWN notes about what is live with this rep — who is waiting on what, what the rep asked, what is half done — as prose, beside a typed list of open matters, each a short label and the stable id of what it is about (an entity or a post). The twin writes it in any turn, an event's included, and nothing tidies it but the twin. APPEND-ONLY VERSIONS WITH THE NEWEST CURRENT, the notepad's shape beside it and for the same reason: every write is the whole text and the whole list, and an earlier version is what a wrong rewrite is read back from (disclosed-and-undoable-after: Mi libreta shows it, every version is kept). `matters` is a JSON array of `{label, about: {kind, id}}` — ids the stores mint, never a per-turn reference and never content anybody but the twin wrote. `execution_id` is WHO wrote it; there is no evidence column, because no rep line authorizes the twin's own notes. BOTH CAPS ARE IN THE SCHEMA: the prose by `length()` and the list by its count, so a write around the API is refused by the store. It moves FR-73's store count from ten to eleven",
    sql: `
      CREATE TABLE working_memory_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL CHECK (length(text) <= ${String(WORKING_MEMORY_CAP)}),
        matters TEXT NOT NULL CHECK (
          json_valid(matters)
          AND json_type(matters) = 'array'
          AND json_array_length(matters) <= ${String(WORKING_MEMORY_MATTERS_CAP)}
        ),
        written_at TEXT NOT NULL,
        execution_id TEXT NOT NULL
      );
    `,
  },
  {
    version: 13,
    description:
      "the rutinas' content (ticket #325; spec #318 decisions 28 and 29; ADR-0014 as amended — an automation the twin authors keeps its content in the bundle and an opaque coordination row in the seam): one row per automation the twin wrote through `create_automation`, keyed by the seam row's own id — its workflow definition as JSON, which the seam row pins by digest, and the twin's first-person sentence Rutinas shows. `execution_id` is the turn that wrote it and `evidence_ref` the rep's own message that asked for it or answered the twin's proposal (ADR-0013's rep-evidenced gate). ONE ROW PER AUTOMATION, NEVER VERSIONS: a change to an active rutina is a new automation with a row of its own, and Descartar deletes both halves, so a row here lives exactly as long as its seam row. The sentence's cap is in the schema as well as the writer (`AUTOMATION_SENTENCE_CAP`). Named `automation_definitions` rather than after the seam's `automations` row it pairs with, so no SQL outside this package can be read as addressing a bundle store. It moves FR-73's store count from eleven to twelve",
    sql: `
      CREATE TABLE automation_definitions (
        id TEXT PRIMARY KEY,
        definition TEXT NOT NULL CHECK (json_valid(definition) AND json_type(definition) = 'object'),
        sentence TEXT NOT NULL CHECK (length(sentence) BETWEEN 1 AND ${String(AUTOMATION_SENTENCE_CAP)}),
        written_at TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        evidence_ref TEXT NOT NULL
      );
    `,
  },
  {
    version: 14,
    description:
      "the twin's workspace, versioned (ticket #326; spec #318 decision 35; ADR-0011 as amended — a version is a snapshot of the workspace directory taken by the runtime at a step boundary, immutable, with its row in the bundle). `workspace_versions` holds one row per file the snapshot found changed: its path inside the workspace, its version — one more than the path's last, the pair unique — the content's sha256, the title code read off it (its first Markdown heading, else its file name), the content itself, when it was taken, the execution whose boundary took it and the run it belongs to when a run's step wrote it. IMMUTABLE BY TRIGGER: no row is ever updated, so a version a card or a citation names is the text it named; rollback is a new version. A row is deleted only with the document — every version of one path at once — which is erasure, never an edit. `thread_items` is rebuilt to admit the role `workspace`: recall indexes a version beside the thread's own items, in the one store the twin's own memory is searched in, its vector beside its row as theirs are. Opaque ids and the twin's own words; it moves FR-73's store count from twelve to thirteen",
    sql: `
      CREATE TABLE workspace_versions (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL CHECK (length(path) > 0),
        version INTEGER NOT NULL CHECK (version >= 1),
        sha256 TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        written_at TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        run_id TEXT,
        UNIQUE (path, version)
      );
      CREATE TRIGGER workspace_versions_immutable
        BEFORE UPDATE ON workspace_versions
        BEGIN SELECT RAISE(ABORT, 'a workspace version is immutable: write a new version'); END;
      CREATE TABLE thread_items_v14 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        day TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('rep', 'twin', 'event', 'workspace')),
        door TEXT CHECK (door IS NULL OR door IN ('dashboard', 'twin_thread')),
        at TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
      );
      INSERT INTO thread_items_v14 (id, session_id, day, role, door, at, text, embedding)
        SELECT id, session_id, day, role, door, at, text, embedding FROM thread_items;
      DROP TABLE thread_items;
      ALTER TABLE thread_items_v14 RENAME TO thread_items;
      CREATE INDEX idx_thread_items_day ON thread_items (day, at, id);
    `,
  },
];

/**
 * BGE-M3 dense embedding dimensionality — the width the vector store is
 * born with (migration v4's FLOAT[1024]). The embedder boundary (#32)
 * produces vectors of exactly this width; anything else refuses.
 */
export const MESSAGE_VECTOR_DIMS = 1024;

/**
 * How long a notepad text is, counted as SQLite counts it (ticket #260).
 *
 * CODE POINTS, NOT `String.length`. SQLite's `length()` over TEXT returns
 * characters, and JavaScript's returns UTF-16 units — so a notebook of emoji
 * would be twice as long to the writer as to the CHECK, and the two
 * enforcements of `NOTEPAD_CAP` would disagree about the same string. The
 * spread is the cheapest count that matches the store.
 */
export function notepadLength(text: string): number {
  return [...text].length;
}

const last = BUNDLE_MIGRATIONS[BUNDLE_MIGRATIONS.length - 1];
if (last === undefined) throw new Error("bundle migration list is empty");
for (const [i, m] of BUNDLE_MIGRATIONS.entries()) {
  if (m.version !== i + 1) {
    throw new Error(
      `bundle migrations must be dense and ordered from 1 (ADR-0029, forward-only); found version ${m.version} at index ${i}`,
    );
  }
}

/** The schema version this build stamps and migrates to. */
export const BUNDLE_SCHEMA_VERSION: number = last.version;

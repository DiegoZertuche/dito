/**
 * Schema evolution at the bundle's open seam (ADR-0029, minimal): stamped
 * bundles, forward-only migration at open before any read, idempotent
 * reopen. Aged bundles are built from the very migration artifacts an older
 * build shipped (src/fixtures/aged-bundle.ts), against real SQLCipher.
 */
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDekFromMaterial } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_SCHEMA_VERSION,
  BundleSchemaTooNewError,
  MESSAGE_VECTOR_DIMS,
  createBundle,
  openBundle,
} from "./index.js";
import { BUNDLE_MIGRATIONS } from "./migrations.js";
import {
  createBundleAtVersion,
  stampSchemaVersion,
} from "./fixtures/aged-bundle.js";
import { openKeyed } from "./keyed-db.js";
import { useTmpDirs } from "./testing/tmp.js";

const tmpDir = useTmpDirs("dito-bundle-mig-");
function tmpBundlePath(): string {
  return join(tmpDir(), "twin.bundle");
}

/**
 * The bundle-side analogue of atlas.sum: SHA-256 of each SHIPPED
 * migration's SQL, pinned the day it shipped. History is append-only —
 * editing a shipped step would silently strand every already-stamped
 * bundle on a schema this build no longer produces (and would let the
 * aged-bundle test fixtures drift along with the edit, hiding it). A
 * schema change is a NEW version appended here with its new hash.
 */
const SHIPPED_MIGRATION_SHA256: Record<number, string> = {
  1: "507a9f772c5ec433c186c3cad7a70d7cd16dc7a8a27d121ecd2410803866466a",
  2: "0619e9aff3ed2375bec987761dc86f205336a79112ad2936ff56d4a5544c1ee3",
  3: "bb5e6a7b0e0538b42137abce2f1e1d1eb13b28589eda8d3df618ad943e017c63",
  4: "4f538c7f9a06a7466e2f983c5c78d5817b16c179c0f14403d402d8e6bbe1e9a5",
  5: "4eb99f5227892f74f12bb596bdca8472640d14b09c3e48a949004578f488fb55",
  6: "3340814a4f5fe107f53bcb596172c039eec9caceb3084084b77c1cc396977265",
  7: "6f242117b30004dfa4fcd352fd898cf09a132dffd57c62f1612e71fc6b8eb92a",
  8: "9fd356222f89e11b45dc4eb31025ae9960c839f98526724fd2fceb749ce9f54f",
  9: "57e140e52dbd30943b85fac4a16a527a52a912e8a2a4d5be703c78c2b4f06610",
  10: "928018fa9bda6e5ca37c5757dfdc4cc43999680d0bfe8b8c3f844ddd680769f1",
  11: "4af651b02747ff71d9b2cfbe444d4a9136b7e23846b29af2d973118f07e30f38",
  12: "aea77fba7335876d2b4d305ec8219e8118f872180f24e190b76bcbabf44cce92",
  13: "35351090b8a05ba5089d30f61d51af4a0d9365c3734ba5f8176a4e8cea9fee39",
  14: "22b2ce249bb959afe51a71e5bc384db991eb162be2d213c8e62982a088ed7f63",
};

describe("forward-only schema evolution (ADR-0029 minimal)", () => {
  it("shipped migrations are immutable — every entry matches its pinned checksum", () => {
    expect(BUNDLE_MIGRATIONS.map((m) => m.version)).toEqual(
      Object.keys(SHIPPED_MIGRATION_SHA256).map(Number),
    );
    for (const migration of BUNDLE_MIGRATIONS) {
      const hash = createHash("sha256").update(migration.sql).digest("hex");
      expect(`${migration.version}:${hash}`).toBe(
        `${migration.version}:${SHIPPED_MIGRATION_SHA256[migration.version]}`,
      );
    }
  });

  it("migrates an older build's bundle forward at open, before any read, keeping its rows — and reopen is idempotent", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));

    // A bundle exactly as the v1 build left it, holding one message.
    createBundleAtVersion(path, dek, 1, [
      {
        chatJid: "5215550001@s.whatsapp.net",
        messageId: "3EB0-AGED-1",
        senderJid: "5215550001@s.whatsapp.net",
        fromMe: false,
        occurredAt: "2026-08-27T09:00:00.000Z",
        content: "buenos días, ¿tiene precio de mayoreo?",
      },
    ]);

    // Idempotent reopen: the first open migrates forward before any read;
    // later opens migrate nothing; every open reads exactly what the old
    // build wrote.
    for (let i = 0; i < 2; i++) {
      const reopened = openBundle(path, dek);
      expect(reopened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      const rows = reopened.readConversation("5215550001@s.whatsapp.net");
      expect(rows.map((r) => r.messageId)).toEqual(["3EB0-AGED-1"]);
      reopened.close();
    }
  });

  it("a slice-1-shaped bundle (v2) migrates in place at open to the slice-2 schema, rows intact (ticket #31, ADR-0029)", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));

    // A bundle exactly as the slice-1 build (schema v2) left it on the rig.
    createBundleAtVersion(path, dek, 2, [
      {
        chatJid: "5215550001@s.whatsapp.net",
        messageId: "3EB0-S1-1",
        senderJid: "5215550001@s.whatsapp.net",
        fromMe: false,
        occurredAt: "2026-08-27T09:00:00.000Z",
        content: "¿tiene precio de mayoreo?",
      },
    ]);

    // Slice 2's interior (the message store's push-name column, the entity
    // mirror, the vector tables — retrieval-ready at v4, ticket #32)
    // arrives at open — before any read — and a re-open re-runs harmlessly
    // (idempotent, ADR-0029).
    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(
        opened.readConversation("5215550001@s.whatsapp.net").map((r) => r.messageId),
      ).toEqual(["3EB0-S1-1"]);
      // The interior is born, and born EMPTY: migration invents no
      // bindings and no vectors — it only makes room.
      expect(opened.listStores()).toContain("entity_mirror");
      expect(opened.listStores()).toContain("message_vectors");
      expect(opened.listChatBindings()).toEqual([]);
      expect(opened.countMessageVectors()).toBe(0);
      opened.close();
    }
  });

  it("a v3-shaped bundle (the #31 interior, pre-retrieval vec0) migrates in place at open to the v4 vector store — rows intact, vectors born empty, immediately searchable (ticket #32, ADR-0029)", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V3-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T09:00:00.000Z",
      content: "¿me aparta las 40 cajas?",
      pushName: "Sra. Garza",
    };

    // A bundle exactly as the v3 build left it: the pre-partition vector
    // table exists and is empty (no v3 build ever wrote a vector — the
    // whole v3 surface was countMessageVectors).
    createBundleAtVersion(path, dek, 3, [aged]);

    // v4 arrives at open (recreating the empty vec0 store, ADR-0029
    // forward-only), a re-open re-runs harmlessly, and every open reads
    // exactly what the old build wrote.
    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      expect(opened.countMessageVectors()).toBe(0);
      opened.close();
    }

    // The migrated store is retrieval-ready: the aged message takes a
    // vector and comes back from a chat-scoped search — the rig's
    // slice-1 history becomes searchable in place, never rebuilt.
    const opened = openBundle(path, dek);
    const { stored, storeId } = opened.ingestMessage(aged);
    expect(stored).toBe(false); // the aged row itself, resolved by message id
    const vector = new Float32Array(MESSAGE_VECTOR_DIMS);
    vector[0] = 1;
    expect(opened.writeMessageVector(storeId, vector)).toEqual({
      stored: true,
    });
    const hits = opened.searchMessages(vector, { chatJid: CHAT, limit: 1 });
    expect(hits.map((h) => h.message.messageId)).toEqual(["3EB0-V3-1"]);
    opened.close();
  });

  it("a v4-shaped bundle (the rig's slice-3 memory) migrates in place at open to the v5 reaction column — rows intact, and a gesture stores beside them (ticket #97, ADR-0029)", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V4-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T09:00:00.000Z",
      content: "¿me mandas 20 bultos?",
      pushName: "Sra. Garza",
    };

    createBundleAtVersion(path, dek, 4, [aged]);

    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      // The aged row is untouched and carries no target: migration
      // invents nothing, it only makes room.
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      opened.close();
    }

    // A gesture at that aged message now stores beside it, and reads back
    // pointing at what it reacted to.
    const opened = openBundle(path, dek);
    opened.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-V4-RX",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T09:01:00.000Z",
      content: "[reacción 👍 a: «¿me mandas 20 bultos?»]",
      reactionTo: "3EB0-V4-1",
      reactionEmoji: "👍",
    });
    expect(
      opened.readConversation(CHAT).map((r) => [r.reactionTo, r.reactionEmoji]),
    ).toEqual([
      [undefined, undefined],
      ["3EB0-V4-1", "👍"],
    ]);
    expect(opened.readMessage(CHAT, "3EB0-V4-1")).toEqual(aged);
    opened.close();
  });

  it("a v7-shaped bundle (the rig's slice-4 memory) migrates in place at open to the current schema — rows intact, and the focus v8 brought gone again (tickets #175, #321; ADR-0029)", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V7-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-09-03T16:20:00.000Z",
      content: "¿ya salió la factura?",
      pushName: "Torres",
    };

    // A bundle exactly as the slice-4 build (schema v7) left it on the rig —
    // the state the boundary session's re-linked rig is really in.
    createBundleAtVersion(path, dek, 7, [aged]);

    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      expect(opened.listStores()).not.toContain("focus");
      opened.close();
    }
  });

  it("refuses a bundle stamped newer than this build — forward-only, fail closed", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    createBundle(path, dek).close();
    stampSchemaVersion(path, dek, BUNDLE_SCHEMA_VERSION + 1);

    // A build must never read (or "migrate down") a bundle from its
    // future: refusal is typed, nothing opens.
    let caught: unknown;
    try {
      openBundle(path, dek);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleSchemaTooNewError);
  });
});

describe("the rep notepad arrives at v9 (ticket #260; spec #258; ADR-0033 as amended)", () => {
  it("a v8-shaped bundle (the rig's slice-6a memory) migrates in place at open to the v9 notepad — rows intact, the notepad born absent", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V8-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-09-18T16:20:00.000Z",
      content: "¿ya salió la factura?",
      pushName: "Torres",
    };

    // A bundle exactly as the slice-6a build (schema v8) left it on the rig.
    createBundleAtVersion(path, dek, 8, [aged]);

    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      // The aged row is untouched and the notepad is born ABSENT: migration
      // invents nothing, it only makes room.
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      expect(opened.listStores()).toContain("notepad_versions");
      expect(opened.readNotepad()).toBeUndefined();
      opened.close();
    }

    // ...and the rig's next teach turn writes into it in place, with the aged
    // history it answers from still there.
    const opened = openBundle(path, dek);
    opened.writeNotepad({
      text: "con Torres siempre de usted",
      writtenAt: "2026-09-20T17:00:00.000Z",
      executionId: "0e2c7a52-0000-4000-8000-000000000001",
      evidenceRef: "0e2c7a52-0000-4000-8000-0000000000e1",
    });
    expect(opened.readNotepad()?.text).toBe("con Torres siempre de usted");
    expect(opened.readConversation(CHAT)).toEqual([aged]);
    opened.close();
  });
});

describe("stable customer references arrive at v11, and the focus goes (ticket #321; spec #318 decisions 16 and 18)", () => {
  it("a v10-shaped bundle with a focus row and two confirmed customers migrates in place: the focus is dropped and each customer gets one reference, in the order the rep confirmed them", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    createBundleAtVersion(path, dek, 10);
    const db = openKeyed(path, dek, { fileMustExist: true });
    try {
      const bind = db.prepare(
        `INSERT INTO entity_mirror (chat_jid, entity_id, display_name, confirmed_at) VALUES (?, ?, ?, ?)`,
      );
      bind.run("5215550002@s.whatsapp.net", "entity-later", "Garza", "2026-09-20T10:00:00.000Z");
      bind.run("5215550001@s.whatsapp.net", "entity-first", "Torres", "2026-09-10T10:00:00.000Z");
      bind.run("5215550003@s.whatsapp.net", "entity-first", "Torres", "2026-09-25T10:00:00.000Z");
      db.exec(
        `INSERT INTO focus (id, candidates, execution_id, written_at) VALUES (1, '[]', 'e', '2026-10-01T10:00:00.000Z')`,
      );
    } finally {
      db.close();
    }

    const opened = openBundle(path, dek);
    expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(opened.listStores()).not.toContain("focus");
    expect(opened.referenceOfEntity("entity-first")).toBe(1);
    expect(opened.referenceOfEntity("entity-later")).toBe(2);
    expect(opened.referenceOfChat("5215550003@s.whatsapp.net")).toBe(1);
    opened.close();
  });

  it("refuses a reference row that names both a customer and a chat, or neither — by the schema, not by the writer", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    createBundle(path, dek).close();
    const db = openKeyed(path, dek, { fileMustExist: true });
    try {
      expect(() =>
        db.exec(`INSERT INTO customer_references (entity_id, chat_jid) VALUES ('e', 'c')`),
      ).toThrow(/CHECK/iu);
      expect(() => db.exec(`INSERT INTO customer_references DEFAULT VALUES`)).toThrow(/CHECK/iu);
    } finally {
      db.close();
    }
  });
});

describe("the twin's working memory arrives at v12 (ticket #322; spec #318 decision 2)", () => {
  it("a v11-shaped bundle (the rig's #321 memory) migrates in place at open — rows and the notepad intact, the working memory born absent", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V11-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-10-03T16:20:00.000Z",
      content: "¿ya salió mi pedido?",
      pushName: "Torres",
    };
    createBundleAtVersion(path, dek, 11, [aged]);

    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      expect(opened.listStores()).toContain("working_memory_versions");
      expect(opened.listStores()).toContain("notepad_versions");
      expect(opened.readWorkingMemory()).toBeUndefined();
      opened.close();
    }

    const opened = openBundle(path, dek);
    opened.writeWorkingMemory({
      text: "Torres espera su pedido.",
      matters: [
        { label: "Torres, el pedido", about: { kind: "entity", id: "0e2c7a52-0000-4000-8000-0000000000aa" } },
      ],
      writtenAt: "2026-10-04T17:00:00.000Z",
      executionId: "0e2c7a52-0000-4000-8000-000000000001",
    });
    expect(opened.readWorkingMemory()?.version).toBe(1);
    expect(opened.readConversation(CHAT)).toEqual([aged]);
    opened.close();
  });
});

describe("the rutinas' content arrives at v13 (ticket #325; spec #318 decision 28)", () => {
  it("a v12-shaped bundle (the rig's #322 memory) migrates in place at open — rows and the working memory intact, no rutina held", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V12-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-10-05T16:20:00.000Z",
      content: "¿me mandas la lista?",
      pushName: "Torres",
    };
    createBundleAtVersion(path, dek, 12, [aged]);
    const RUTINA = "0e2c7a52-0000-4000-8000-0000000000c1";

    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      expect(opened.listStores()).toContain("automation_definitions");
      expect(opened.listStores()).toContain("working_memory_versions");
      expect(opened.readAutomation(RUTINA)).toBeUndefined();
      opened.close();
    }

    const opened = openBundle(path, dek);
    const content = {
      id: RUTINA,
      definition: '{"name":"Clientes sin contacto","budget":{"iterations":6,"tokens":60000},"steps":[]}',
      sentence: "Cada viernes a las 9 te mando la lista de los clientes que no has contactado en la semana.",
      writtenAt: "2026-10-06T17:00:00.000Z",
      executionId: "0e2c7a52-0000-4000-8000-000000000001",
      evidenceRef: "0e2c7a52-0000-4000-8000-000000000002",
    };
    opened.writeAutomation(content);
    expect(opened.readAutomation(RUTINA)).toEqual(content);
    // DESCARTAR TAKES THE CONTENT WITH THE ROW: nothing of it is left to read.
    expect(opened.deleteAutomation(RUTINA)).toBe(true);
    expect(opened.readAutomation(RUTINA)).toBeUndefined();
    expect(opened.deleteAutomation(RUTINA)).toBe(false);
    opened.close();
  });

  it("refuses a sentence past the cap before the statement", () => {
    const bundle = openBundle(
      (() => {
        const path = tmpBundlePath();
        createBundleAtVersion(path, createDekFromMaterial(Buffer.alloc(32, 7)), 12, []);
        return path;
      })(),
      createDekFromMaterial(Buffer.alloc(32, 7)),
    );
    expect(() =>
      bundle.writeAutomation({
        id: "0e2c7a52-0000-4000-8000-0000000000c2",
        definition: "{}",
        sentence: "x".repeat(281),
        writtenAt: "2026-10-06T17:00:00.000Z",
        executionId: "e",
        evidenceRef: "r",
      }),
    ).toThrow(/1 to 280 characters/u);
    bundle.close();
  });
});

describe("the workspace's versions arrive at v14 (ticket #326; spec #318 decision 35)", () => {
  it("a v13-shaped bundle migrates in place at open — its rows and the thread's own items intact, the workspace empty and recall open to it", () => {
    const path = tmpBundlePath();
    const dek = createDekFromMaterial(randomBytes(32));
    const CHAT = "5215550001@s.whatsapp.net";
    const aged = {
      chatJid: CHAT,
      messageId: "3EB0-V13-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-10-06T16:20:00.000Z",
      content: "¿me mandas la cotización?",
      pushName: "Torres",
    };
    createBundleAtVersion(path, dek, 13, [aged]);
    const db = openKeyed(path, dek, { fileMustExist: true });
    db.prepare(
      `INSERT INTO thread_items (id, session_id, day, role, door, at, text, embedding)
       VALUES ('item-1', 'session-1', '2026-10-06', 'rep', 'twin_thread', '2026-10-06T16:21:00.000Z', 'búscame hoteles', NULL)`,
    ).run();
    db.close();

    for (let i = 0; i < 2; i++) {
      const opened = openBundle(path, dek);
      expect(opened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(opened.readConversation(CHAT)).toEqual([aged]);
      expect(opened.listStores()).toContain("workspace_versions");
      expect(opened.readThreadItem("item-1")).toMatchObject({ role: "rep", door: "twin_thread", text: "búscame hoteles" });
      expect(opened.latestVersionOf("hoteles.md")).toBeUndefined();
      opened.close();
    }

    const opened = openBundle(path, dek);
    opened.recordThreadItem({
      id: "version-1",
      sessionId: "session-1",
      day: "2026-10-07",
      role: "workspace",
      at: "2026-10-07T10:00:00.000Z",
      text: "Hoteles en Madrid",
    });
    expect(opened.readThreadItem("version-1")?.role).toBe("workspace");
    opened.close();
  });
});

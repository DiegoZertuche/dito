/**
 * The twin's bundle at its public seam (ADR-0007): a real SQLCipher file
 * that opens only under the twin's DEK. Real SQLCipher in every test —
 * never mocked (ADR-0028). DEKs here are constructed locally (the same
 * factory the KMS unwrap path uses); the KMS-integrated open lives in the
 * integration lane.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createDekFromMaterial } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_SCHEMA_VERSION,
  BundleAlreadyExistsError,
  BundleUninitializedError,
  ChatAlreadyBoundError,
  MESSAGE_VECTOR_DIMS,
  MessageNotInStoreError,
  NOTEPAD_CAP,
  OPEN_MATTER_LABEL_CAP,
  VectorDimensionMismatchError,
  WORKING_MEMORY_CAP,
  WORKING_MEMORY_MATTERS_CAP,
  WrongBundleKeyError,
  createBundle,
  openBundle,
} from "./index.js";
import { openKeyed } from "./keyed-db.js";
import { useTmpDirs } from "./testing/tmp.js";

const tmpDir = useTmpDirs("dito-bundle-");
function tmpBundlePath(): string {
  return join(tmpDir(), "twin.bundle");
}

function freshDek() {
  return createDekFromMaterial(randomBytes(32));
}

describe("bundle create/open under the DEK (ADR-0007)", () => {
  it("creates a stamped bundle that reopens under the same DEK, and the file on disk is ciphertext", () => {
    const path = tmpBundlePath();
    const dek = freshDek();

    const created = createBundle(path, dek);
    created.close();

    // Encrypted at rest: a real, non-empty file that is NOT plaintext
    // SQLite (ADR-0007 — twin memory is one file that dies with one key).
    const raw = readFileSync(path);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.subarray(0, 16).toString("latin1")).not.toContain(
      "SQLite format 3",
    );

    // Every bundle carries a schema version stamp (ADR-0029).
    const reopened = openBundle(path, dek);
    expect(reopened.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    reopened.close();
  });

  it("refuses a wrong DEK with a typed error — fails closed, nothing readable", () => {
    const path = tmpBundlePath();
    createBundle(path, freshDek()).close();

    // Under the wrong key the data simply does not open (retirement-by-
    // key-destruction is true from the first byte, ADR-0009 via ADR-0007).
    let caught: unknown;
    try {
      openBundle(path, freshDek());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WrongBundleKeyError);
  });

  it("refuses to create through a symlink, dangling included — path reservation is exclusive", () => {
    const dir = tmpDir();
    const path = join(dir, "twin.bundle");
    // A dangling symlink at the bundle path: exists-style checks say
    // "nothing here", but creating through it would write the bundle at
    // an attacker-chosen target. O_EXCL refuses symlinks outright.
    symlinkSync(join(dir, "elsewhere.bundle"), path);

    let caught: unknown;
    try {
      createBundle(path, freshDek());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleAlreadyExistsError);
    // And nothing materialized at the symlink's target.
    expect(existsSync(join(dir, "elsewhere.bundle"))).toBe(false);
  });

  it("refuses an empty or truncated file — total data loss must never look like a healthy empty bundle", () => {
    const dek = freshDek();

    // A bundle truncated to zero bytes (the worst corruption: SQLite would
    // happily treat it as a brand-new database and migrations would
    // "heal" it into an empty twin memory).
    const truncated = tmpBundlePath();
    createBundle(truncated, dek).close();
    truncateSync(truncated, 0);
    let caught: unknown;
    try {
      openBundle(truncated, dek);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleUninitializedError);

    // A file that never was a bundle (touched empty) is refused the same
    // way: version 0 is not a stamp any build ever leaves behind.
    const neverCreated = tmpBundlePath();
    writeFileSync(neverCreated, "");
    let caught2: unknown;
    try {
      openBundle(neverCreated, dek);
    } catch (err) {
      caught2 = err;
    }
    expect(caught2).toBeInstanceOf(BundleUninitializedError);
  });

  it("refuses to create over an existing file — creating is never adopting", () => {
    const path = tmpBundlePath();
    createBundle(path, freshDek()).close();

    // A second create at the same path must not open, reuse, or overwrite
    // the file under any key — one twin, one file, one explicit creation.
    let caught: unknown;
    try {
      createBundle(path, freshDek());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BundleAlreadyExistsError);
  });
});

describe("conversation rows (slice AC 10)", () => {
  const CHAT = "5215550001@s.whatsapp.net";
  const OTHER_CHAT = "5215559999@s.whatsapp.net";
  const SELF = "5215550000@s.whatsapp.net";

  it("names each chat's newest message — when, and which side wrote it — and never a gesture (ticket #396)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const row = (chatJid: string, messageId: string, fromMe: boolean, occurredAt: string, reactionTo?: string): void => {
      bundle.ingestMessage({
        chatJid,
        messageId,
        senderJid: fromMe ? SELF : chatJid,
        fromMe,
        occurredAt,
        content: reactionTo === undefined ? "un mensaje" : "",
        ...(reactionTo === undefined ? {} : { reactionTo, reactionEmoji: "👍" }),
      });
    };
    row(CHAT, "A-1", false, "2026-10-12T15:00:00.000Z");
    row(CHAT, "A-2", true, "2026-10-12T15:30:00.000Z");
    // THE CUSTOMER'S THUMBS-UP IS NOT A REPLY: the rep still wrote last.
    row(CHAT, "A-3", false, "2026-10-12T16:00:00.000Z", "A-2");
    row(OTHER_CHAT, "B-1", true, "2026-10-12T14:00:00.000Z");
    row(OTHER_CHAT, "B-2", false, "2026-10-12T14:10:00.000Z");
    expect(bundle.lastMessages()).toEqual(
      new Map([
        [CHAT, { occurredAt: "2026-10-12T15:30:00.000Z", fromMe: true }],
        [OTHER_CHAT, { occurredAt: "2026-10-12T14:10:00.000Z", fromMe: false }],
      ]),
    );
    bundle.close();
  });

  it("persists a chat's messages with their metadata and reads them back in order, scoped to the chat", () => {
    const path = tmpBundlePath();
    const dek = freshDek();

    const bundle = createBundle(path, dek);
    bundle.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-INBOUND-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T14:03:00.000Z",
      content: "¿me mandas 40 cajas para el jueves?",
    });
    bundle.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-REPLY-1",
      senderJid: SELF,
      fromMe: true,
      occurredAt: "2026-08-27T14:05:30.000Z",
      content: "claro, se las mando el jueves temprano",
    });
    bundle.ingestMessage({
      chatJid: OTHER_CHAT,
      messageId: "3EB0-OTHER-1",
      senderJid: OTHER_CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T14:04:00.000Z",
      content: "otro pedido distinto",
    });
    bundle.close();

    // Rows survive close/reopen — conversation history lives only in the
    // bundle (ADR-0007), so persistence IS the product behavior.
    const reopened = openBundle(path, dek);
    expect(reopened.readConversation(CHAT)).toEqual([
      {
        chatJid: CHAT,
        messageId: "3EB0-INBOUND-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:03:00.000Z",
        content: "¿me mandas 40 cajas para el jueves?",
      },
      {
        chatJid: CHAT,
        messageId: "3EB0-REPLY-1",
        senderJid: SELF,
        fromMe: true,
        occurredAt: "2026-08-27T14:05:30.000Z",
        content: "claro, se las mando el jueves temprano",
      },
    ]);
    reopened.close();
  });

  it("ingests a message exactly once by (chat, WhatsApp message id) — a re-delivered event cannot double-store (ticket #31)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const row = {
      chatJid: CHAT,
      messageId: "3EB0-ING-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T16:00:00.000Z",
      content: "¿me aparta 10 cajas?",
    };

    const first = bundle.ingestMessage(row);
    const second = bundle.ingestMessage(row);

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(false);
    // The store id is the message's stable interior identity — the vector
    // tables key by it (#32) — so a replay resolves to the SAME row.
    expect(second.storeId).toBe(first.storeId);
    expect(bundle.readConversation(CHAT)).toHaveLength(1);
    bundle.close();
  });

  it("stores the sender push-name when the payload carries it — bindings and «(sin confirmar)» rendering need it (spec #29 decision 7)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    bundle.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-PN-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T16:10:00.000Z",
      content: "soy la Sra. Garza, ¿tiene tomate?",
      pushName: "Sra. Garza",
    });
    bundle.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-PN-2",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T16:11:00.000Z",
      content: "¿y cebolla?",
      // No push-name on this delivery — absence-tolerant (the live path
      // gains the field additively, #30; until then every row is bare).
    });

    expect(bundle.readConversation(CHAT)).toEqual([
      {
        chatJid: CHAT,
        messageId: "3EB0-PN-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T16:10:00.000Z",
        content: "soy la Sra. Garza, ¿tiene tomate?",
        pushName: "Sra. Garza",
      },
      {
        chatJid: CHAT,
        messageId: "3EB0-PN-2",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T16:11:00.000Z",
        content: "¿y cebolla?",
      },
    ]);
    bundle.close();
  });

  describe("two beats of one second read in delivery order (ticket #109)", () => {
    const SECOND = "2026-08-27T16:20:00.000Z";

    /** One reaction delivery, ingested in the order the seam saw it. */
    function gesture(
      bundle: ReturnType<typeof createBundle>,
      messageId: string,
      emoji: string,
      senderTsMs?: number,
    ): void {
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId,
        senderJid: CHAT,
        fromMe: false,
        occurredAt: SECOND,
        // The line a model reads is composed elsewhere (`reactions.ts`,
        // which this package cannot import) and no assertion here reads it,
        // so this stands in rather than mimicking a format it cannot share.
        content: `gesture ${messageId}`,
        reactionTo: "3EB0-ASK",
        reactionEmoji: emoji,
        ...(senderTsMs === undefined ? {} : { senderTsMs }),
      });
    }

    it("puts the 👍 before the removal that retracts it, whichever order the seam delivered them in", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      // Delivered removal-first — a reconnect, a retry — and both rows carry
      // the SAME whole-second `occurred_at`, which is all the rail's stanza
      // timestamp has. Only the reactor's own clock says which tap was first.
      gesture(bundle, "3EB0-RX-REMOVE", "", Date.parse(SECOND) + 200);
      gesture(bundle, "3EB0-RX-SET", "👍", Date.parse(SECOND));

      expect(bundle.readConversation(CHAT).map((row) => row.messageId)).toEqual(
        ["3EB0-RX-SET", "3EB0-RX-REMOVE"],
      );
      bundle.close();
    });

    it("holds a same-second message in its own slot while the gestures around it are re-dealt — the message has no clock to be sorted on", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      // The inverted fixture, which is the only one that pins anything: the
      // two gestures arrive in the WRONG order with the message between
      // them. So the message cannot keep its arrival order against both,
      // and the reaction pair is what the tie-break is for.
      gesture(bundle, "3EB0-RX-LATE", "❤️", Date.parse(SECOND) + 900);
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-SAID",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: SECOND,
        content: "va",
      });
      gesture(bundle, "3EB0-RX-EARLY", "👍", Date.parse(SECOND) + 100);

      // The message never leaves position 2; the gestures swap around it.
      // A reaction DOES jump it — the cost recorded in `inDeliveryOrder`,
      // and the honest one: the alternative is the pair reading backwards.
      expect(bundle.readConversation(CHAT).map((row) => row.messageId)).toEqual(
        ["3EB0-RX-EARLY", "3EB0-SAID", "3EB0-RX-LATE"],
      );
      bundle.close();
    });

    it("leaves a whole second alone when ANY of its reactions has no clock — an upgraded bundle is never worse than the one it upgraded from", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      // THE ROLLING-UPGRADE TRACE, and the reason the guard covers the whole
      // second rather than just the clockless row. What really happened: a
      // removal at .100, a set at .900, a removal at .950 — the second ENDS
      // ON A REMOVAL. A reconnect delivered them backwards, and a v5 build
      // (no `sender_ts_ms` column) stored the first before the upgrade.
      gesture(bundle, "3EB0-RX-V5-REMOVAL", "");
      gesture(bundle, "3EB0-RX-SET", "👍", Date.parse(SECOND) + 900);
      gesture(bundle, "3EB0-RX-REMOVAL", "", Date.parse(SECOND) + 100);

      // Coarse order, untouched. Shuffling only the two CLOCKED rows would
      // end this second on the set — a standing 👍 the rep had withdrawn,
      // and strictly worse than what v5 itself showed.
      expect(bundle.readConversation(CHAT).map((row) => row.messageId)).toEqual(
        ["3EB0-RX-V5-REMOVAL", "3EB0-RX-SET", "3EB0-RX-REMOVAL"],
      );
      bundle.close();
    });
  });

  it("enumerates its interior stores through the API — no consumer ever touches bundle SQL (ticket #31, FR-73's registry)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const stores = bundle.listStores();
    // The slice-2 interior: the message store, the entity mirror, and the
    // vector tables. A store added by a later migration joins this
    // enumeration by construction — it comes from the live schema, not a
    // hand-kept list.
    expect(stores).toContain("conversation_messages");
    expect(stores).toContain("entity_mirror");
    expect(stores).toContain("message_vectors");
    bundle.close();
  });

  /**
   * THE CONSUMER'S FOLD (ticket #124; ADR-0042). The seam records
   * deliveries and folds nothing, so twin memory can hold two rows about
   * one message — the readable one and the opaque one that says the plane
   * could not read it. Which one STANDS is decided here, once, where every
   * reader of a conversation already ends up.
   */
  describe("an opaque delivery in twin memory (ticket #124; ADR-0042)", () => {
    const PHOTO = "3EB0-PHOTO-1";

    function opaque(
      bundle: ReturnType<typeof createBundle>,
      messageId: string,
      kind: string,
      standsFor: string | undefined,
      occurredAt = "2026-08-27T14:04:00.000Z",
    ): number {
      return bundle.ingestMessage({
        chatJid: CHAT,
        messageId,
        senderJid: CHAT,
        fromMe: false,
        occurredAt,
        content: "[foto]",
        opaqueKind: kind,
        ...(standsFor === undefined ? {} : { opaqueOf: standsFor }),
      }).storeId;
    }

    it("holds the placeholder as its own row, keyed by the seam identity, and reads its kind back", () => {
      const path = tmpBundlePath();
      const dek = freshDek();
      const bundle = createBundle(path, dek);
      opaque(bundle, `${PHOTO}:opaque`, "imageMessage", PHOTO);
      bundle.close();

      const reopened = openBundle(path, dek);
      expect(reopened.readConversation(CHAT)).toEqual([
        {
          chatJid: CHAT,
          messageId: `${PHOTO}:opaque`,
          senderJid: CHAT,
          fromMe: false,
          occurredAt: "2026-08-27T14:04:00.000Z",
          content: "[foto]",
          opaqueKind: "imageMessage",
          opaqueOf: PHOTO,
        },
      ]);
      reopened.close();
    });

    it("renders the READABLE row over the opaque one for the same message — a retry fixes memory rather than duplicating it", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      opaque(bundle, `${PHOTO}:opaque`, "undecryptable", PHOTO);
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: PHOTO,
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:04:00.000Z",
        content: "¿me mandas 20 bultos?",
      });

      expect(bundle.readConversation(CHAT).map((row) => row.content)).toEqual([
        "¿me mandas 20 bultos?",
      ]);
      bundle.close();
    });

    it("renders the OPAQUE row over the empty-text husk for the same message — existing memory heals on the next relink", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      // The husk a pre-ADR-0042 plane wrote for a photo: a message row
      // that says somebody said nothing.
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: PHOTO,
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:04:00.000Z",
        content: "",
      });
      opaque(bundle, `${PHOTO}:opaque`, "imageMessage", PHOTO);

      expect(bundle.readConversation(CHAT).map((row) => row.content)).toEqual([
        "[foto]",
      ]);
      bundle.close();
    });

    it("leaves an opaque row that stands for NO message standing — nothing folds with a delivery the rail never identified", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: PHOTO,
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:03:00.000Z",
        content: "¿me mandas 20 bultos?",
      });
      opaque(bundle, "opaque:9f2c1a", "imageMessage", undefined);

      expect(bundle.readConversation(CHAT).map((row) => row.content)).toEqual([
        "¿me mandas 20 bultos?",
        "[foto]",
      ]);
      bundle.close();
    });

    it("never folds away a GESTURE, whose content is legitimately empty in one of the two readers", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      // A reaction the plane first delivered malformed (so it wrote an
      // opaque row standing for that stanza id) and then well-formed. The
      // gesture is what the twin can read, so IT stands — and it must not
      // be mistaken for the empty-text husk on its way there. The
      // extraction window builds gesture beats with an empty `content` and
      // composes the line afterwards, which is where testing emptiness
      // alone would drop the real gesture and keep the placeholder.
      bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-RX-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:05:00.000Z",
        content: "",
        reactionTo: "3EB0-TARGET-1",
        reactionEmoji: "👍",
      });
      opaque(
        bundle,
        "3EB0-RX-1:opaque",
        "reaction/reaction_to",
        "3EB0-RX-1",
        "2026-08-27T14:05:00.000Z",
      );

      expect(
        bundle.readConversation(CHAT).map((row) => row.messageId),
      ).toEqual(["3EB0-RX-1"]);
      bundle.close();
    });

    it("reports the CLASS the store holds, so a caller can never embed a placeholder it did not pass", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      const first = bundle.ingestMessage({
        chatJid: CHAT,
        messageId: `${PHOTO}:opaque`,
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:04:00.000Z",
        content: "[foto]",
        opaqueKind: "imageMessage",
        opaqueOf: PHOTO,
      });
      // A row of the OTHER class landing on the same key — only reachable
      // through a plane that composed an identity the decoder refuses, and
      // the answer must still be about what the store HOLDS, exactly as it
      // is for `content`.
      const losing = bundle.ingestMessage({
        chatJid: CHAT,
        messageId: `${PHOTO}:opaque`,
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:04:00.000Z",
        content: "¿me mandas 20 bultos?",
      });

      expect(first).toMatchObject({ stored: true, opaque: true });
      expect(losing).toMatchObject({
        stored: false,
        opaque: true,
        content: "[foto]",
      });
      bundle.close();
    });

    it("is never selected for embedding — the placeholder ends the husk's pollution of the vector store", () => {
      const bundle = createBundle(tmpBundlePath(), freshDek());
      const said = bundle.ingestMessage({
        chatJid: CHAT,
        messageId: "3EB0-SAID-1",
        senderJid: CHAT,
        fromMe: false,
        occurredAt: "2026-08-27T14:03:00.000Z",
        content: "¿me mandas 20 bultos?",
      }).storeId;
      opaque(bundle, `${PHOTO}:opaque`, "imageMessage", PHOTO);

      // The backlog is the store's own selection, so "never embedded" is a
      // property of twin memory rather than a habit at each write site.
      expect(bundle.listUnembeddedMessages(10)).toEqual([
        { storeId: said, content: "¿me mandas 20 bultos?" },
      ]);
      bundle.close();
    });
  });
});

describe("the entity mirror (ticket #31 — born empty this ticket, #34 fills it; ADR-0004)", () => {
  const CHAT = "5215550001@s.whatsapp.net";

  it("is born empty, holds a rep-confirmed binding after confirmation, and the binding survives reopen", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);

    expect(bundle.listChatBindings()).toEqual([]);
    expect(bundle.readChatBinding(CHAT)).toBeUndefined();

    // A binding is born only from the rep's confirmation (#34's ceremony
    // writes it; this is the store's contract): one chat, one entity, the
    // name the rep confirmed.
    const binding = {
      chatJid: CHAT,
      entityId: "0e2c7a52-0000-4000-8000-000000000042",
      displayName: "Sra. Garza",
      confirmedAt: "2026-08-27T17:00:00.000Z",
    };
    bundle.confirmChatBinding(binding);
    expect(bundle.readChatBinding(CHAT)).toEqual(binding);
    bundle.close();

    // Rep-side only, inside the bundle, under the key (ADR-0004/0007):
    // persistence in the encrypted file IS the product behavior.
    const reopened = openBundle(path, dek);
    expect(reopened.listChatBindings()).toEqual([binding]);
    reopened.close();
  });

  it("holds at most one binding per chat — a second confirmation refuses typed, never silently rebinds", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const binding = {
      chatJid: CHAT,
      entityId: "0e2c7a52-0000-4000-8000-000000000042",
      displayName: "Sra. Garza",
      confirmedAt: "2026-08-27T17:00:00.000Z",
    };
    bundle.confirmChatBinding(binding);

    // Rebinding a chat is entity lifecycle (rename/merge) — out of scope
    // until the crossing (spec #29): a second confirm is a refusal, and
    // the first confirmation stands untouched.
    let caught: unknown;
    try {
      bundle.confirmChatBinding({
        ...binding,
        entityId: "0e2c7a52-0000-4000-8000-000000000099",
        displayName: "Otra Persona",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChatAlreadyBoundError);
    expect(bundle.readChatBinding(CHAT)).toEqual(binding);
    bundle.close();
  });
});

describe("customer references (ticket #321; spec #318 decision 18; CONTEXT.md *Reference*)", () => {
  const CHAT = "5215550001@s.whatsapp.net";
  const SECOND = "5215550002@s.whatsapp.net";
  const ENTITY = "0e2c7a52-0000-4000-8000-000000000042";

  function binding(chatJid: string, entityId: string, confirmedAt: string) {
    return { chatJid, entityId, displayName: "Sra. Garza", confirmedAt };
  }

  it("gives a customer one reference at the confirmation, and it survives reopen", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);
    bundle.confirmChatBinding(binding(CHAT, ENTITY, "2026-08-27T17:00:00.000Z"));
    const number = bundle.referenceOfEntity(ENTITY);
    expect(number).toBe(1);
    expect(bundle.readReference(1)).toEqual({ number: 1, entityId: ENTITY });
    expect(bundle.referenceOfChat(CHAT)).toBe(1);
    bundle.close();

    const reopened = openBundle(path, dek);
    expect(reopened.referenceOfEntity(ENTITY)).toBe(1);
    reopened.close();
  });

  it("names a customer with two chats by one reference, and lists the chats in the order the rep confirmed them", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    bundle.confirmChatBinding(binding(SECOND, ENTITY, "2026-08-28T17:00:00.000Z"));
    bundle.confirmChatBinding(binding(CHAT, ENTITY, "2026-08-27T17:00:00.000Z"));
    expect(bundle.referenceOfChat(CHAT)).toBe(1);
    expect(bundle.referenceOfChat(SECOND)).toBe(1);
    expect(bundle.chatsOfEntity(ENTITY).map((chat) => chat.chatJid)).toEqual([CHAT, SECOND]);
    bundle.close();
  });

  it("gives a chat nobody confirmed its own reference once, and the confirmation hands that same reference to the customer", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    expect(bundle.referenceOfChat(CHAT)).toBeUndefined();
    const given = bundle.referenceForChat(CHAT);
    expect(bundle.referenceForChat(CHAT)).toBe(given);
    expect(bundle.readReference(given)).toEqual({ number: given, chatJid: CHAT });

    bundle.confirmChatBinding(binding(CHAT, ENTITY, "2026-08-27T17:00:00.000Z"));
    expect(bundle.referenceOfEntity(ENTITY)).toBe(given);
    expect(bundle.readReference(given)).toEqual({ number: given, entityId: ENTITY });
    bundle.close();
  });

  it("never hands a retired number to anybody else", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    bundle.confirmChatBinding(binding(CHAT, ENTITY, "2026-08-27T17:00:00.000Z"));
    const retired = bundle.referenceForChat(SECOND);
    // The customer already has a reference, so the second chat's own goes.
    bundle.confirmChatBinding(binding(SECOND, ENTITY, "2026-08-28T17:00:00.000Z"));
    expect(bundle.readReference(retired)).toBeUndefined();
    expect(bundle.referenceForChat("5215550003@s.whatsapp.net")).toBe(retired + 1);
    bundle.close();
  });

  it("reads the push-names the other side wrote under, newest first, leaving out gestures and the rep's own rows", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const row = (messageId: string, occurredAt: string, extra: object) => ({
      chatJid: CHAT,
      messageId,
      senderJid: CHAT,
      fromMe: false,
      occurredAt,
      content: "hola",
      ...extra,
    });
    bundle.ingestMessage(row("m1", "2026-08-27T09:00:00.000Z", { pushName: "Garza" }));
    bundle.ingestMessage(row("m2", "2026-08-27T10:00:00.000Z", { pushName: "Sra. Garza" }));
    bundle.ingestMessage(row("m3", "2026-08-27T11:00:00.000Z", { pushName: "Sra. Garza", reactionTo: "m2", reactionEmoji: "👍" }));
    bundle.ingestMessage(row("m4", "2026-08-27T12:00:00.000Z", { fromMe: true, pushName: "Diego" }));
    expect(bundle.pushNamesFromOtherSide(CHAT, 10)).toEqual([
      { messageId: "m2", pushName: "Sra. Garza" },
      { messageId: "m1", pushName: "Garza" },
    ]);
    bundle.close();
  });

  it("joins the store enumeration FR-73 audits, and the focus is gone from it", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    expect(bundle.listStores()).toContain("customer_references");
    expect(bundle.listStores()).not.toContain("focus");
    bundle.close();
  });
});

describe("the vector tables (ticket #31 — born empty, #32 fills them; ADR-0007)", () => {
  it("are born empty inside the bundle — vectors never exist anywhere else", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    // Ingesting a message mints no vector: embedding is the runtime's
    // work (#32) — the bundle stores vectors, it never invents them.
    bundle.ingestMessage({
      chatJid: "5215550001@s.whatsapp.net",
      messageId: "3EB0-VEC-1",
      senderJid: "5215550001@s.whatsapp.net",
      fromMe: false,
      occurredAt: "2026-08-27T16:20:00.000Z",
      content: "¿tiene chile en polvo?",
    });
    expect(bundle.countMessageVectors()).toBe(0);
    bundle.close();
  });
});

describe("the message vector store (ticket #32 — vectors live only inside the bundle; ADR-0007)", () => {
  const CHAT = "5215550001@s.whatsapp.net";

  /** A unit vector along one dimension of the BGE-M3 embedding space. */
  function unitVector(dim: number): Float32Array {
    const v = new Float32Array(MESSAGE_VECTOR_DIMS);
    v[dim] = 1;
    return v;
  }

  function ingest(
    bundle: ReturnType<typeof createBundle>,
    messageId: string,
    content: string,
    chatJid: string = CHAT,
  ): number {
    return bundle.ingestMessage({
      chatJid,
      messageId,
      senderJid: chatJid,
      fromMe: false,
      occurredAt: "2026-08-27T16:20:00.000Z",
      content,
    }).storeId;
  }

  it("stores one vector per message keyed by its interior id — first write wins, a replay never duplicates, and the vector survives reopen", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);
    const storeId = ingest(bundle, "3EB0-VW-1", "¿tiene chile en polvo?");

    expect(bundle.hasMessageVector(storeId)).toBe(false);
    expect(bundle.writeMessageVector(storeId, unitVector(0))).toEqual({
      stored: true,
    });
    expect(bundle.hasMessageVector(storeId)).toBe(true);
    expect(bundle.countMessageVectors()).toBe(1);

    // A replayed write (crash-replay, re-delivered event) resolves onto
    // the stored vector: first write wins, never a duplicate — the vector
    // analogue of the message store's ingest rule (#31).
    expect(bundle.writeMessageVector(storeId, unitVector(1))).toEqual({
      stored: false,
    });
    expect(bundle.countMessageVectors()).toBe(1);
    bundle.close();

    // Inside the encrypted file, under the key — persistence IS the
    // product behavior (ADR-0007: vectors never leave the bundle).
    const reopened = openBundle(path, dek);
    expect(reopened.hasMessageVector(storeId)).toBe(true);
    expect(reopened.countMessageVectors()).toBe(1);
    reopened.close();
  });

  it("refuses a vector of the wrong width, and a vector for a message the store does not hold — typed, nothing stored", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const storeId = ingest(bundle, "3EB0-VR-1", "¿tiene tomate?");

    // The embedder boundary produces BGE-M3-shaped vectors (1024 dims);
    // anything else is a broken embedder, never something to store.
    let caught: unknown;
    try {
      bundle.writeMessageVector(storeId, new Float32Array(3));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VectorDimensionMismatchError);
    expect(bundle.countMessageVectors()).toBe(0);

    // A vector may only ever accompany a stored message — an orphan
    // vector would be memory nothing can read back.
    let caught2: unknown;
    try {
      bundle.writeMessageVector(storeId + 999, unitVector(0));
    } catch (err) {
      caught2 = err;
    }
    expect(caught2).toBeInstanceOf(MessageNotInStoreError);
    expect(bundle.countMessageVectors()).toBe(0);
    bundle.close();
  });

  it("reports the content actually stored, so a losing re-delivery can never be indexed against the winning row (Codex r2)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const stored = bundle.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-CONFLICT-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T16:30:00.000Z",
      content: "texto guardado",
    });
    expect(stored).toEqual({
      stored: true,
      storeId: stored.storeId,
      content: "texto guardado",
      opaque: false,
    });

    // Same (chat, message id), different text: first write wins in the
    // store, so the result must report the STORED text — whoever embeds
    // from this result indexes what a reader will actually read back.
    const losing = bundle.ingestMessage({
      chatJid: CHAT,
      messageId: "3EB0-CONFLICT-1",
      senderJid: CHAT,
      fromMe: false,
      occurredAt: "2026-08-27T16:31:00.000Z",
      content: "texto perdedor",
    });
    expect(losing).toEqual({
      stored: false,
      storeId: stored.storeId,
      content: "texto guardado",
      opaque: false,
    });
    bundle.close();
  });

  it("lists exactly the messages still awaiting their vector, oldest first, honoring the batch limit — the backlog selection is restart-safe by construction", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const first = ingest(bundle, "3EB0-UB-1", "¿tiene precio de mayoreo?");
    const second = ingest(bundle, "3EB0-UB-2", "le mando la lista");
    const third = ingest(bundle, "3EB0-UB-3", "¿y las 40 cajas?");

    // The whole backlog, oldest first (interior order — the order the
    // store gave the ids out).
    expect(bundle.listUnembeddedMessages(10)).toEqual([
      { storeId: first, content: "¿tiene precio de mayoreo?" },
      { storeId: second, content: "le mando la lista" },
      { storeId: third, content: "¿y las 40 cajas?" },
    ]);
    // The batch limit bounds one bite of the backlog.
    expect(bundle.listUnembeddedMessages(2)).toEqual([
      { storeId: first, content: "¿tiene precio de mayoreo?" },
      { storeId: second, content: "le mando la lista" },
    ]);

    // An embedded message leaves the backlog — a killed batch re-selects
    // only what it never wrote, so a resume loses nothing and repeats
    // nothing (#32 restart-safety comes from this selection).
    bundle.writeMessageVector(second, unitVector(0));
    expect(bundle.listUnembeddedMessages(10)).toEqual([
      { storeId: first, content: "¿tiene precio de mayoreo?" },
      { storeId: third, content: "¿y las 40 cajas?" },
    ]);
    bundle.close();
  });

  it("returns the nearest messages for a query vector — cosine order, scopeable to one chat, never crossing the scope for a globally-nearer hit", () => {
    const OTHER_CHAT = "5215550002@s.whatsapp.net";
    const bundle = createBundle(tmpBundlePath(), freshDek());

    // Hand-built vectors at known angles to the query u(0):
    //   exact  = u(0)            → cosine distance 0
    //   near   = [3,1,0,…]/√10   → ≈ 0.051
    //   far    = [1,1,0,…]/√2    → ≈ 0.293
    //   ortho  = u(1)            → 1
    const exact = ingest(bundle, "3EB0-SR-1", "las 40 cajas del jueves");
    const far = ingest(bundle, "3EB0-SR-2", "gracias, buen día");
    const near = ingest(
      bundle,
      "3EB0-SR-3",
      "¿me aparta las cajas?",
      OTHER_CHAT,
    );
    const ortho = ingest(bundle, "3EB0-SR-4", "mándame la ubicación", OTHER_CHAT);
    const withDims = (entries: readonly (readonly [number, number])[]) => {
      const v = new Float32Array(MESSAGE_VECTOR_DIMS);
      for (const [dim, value] of entries) v[dim] = value;
      return v;
    };
    bundle.writeMessageVector(exact, unitVector(0));
    bundle.writeMessageVector(far, withDims([[0, 1], [1, 1]]));
    bundle.writeMessageVector(near, withDims([[0, 3], [1, 1]]));
    bundle.writeMessageVector(ortho, unitVector(1));

    // Global: cosine order across every chat, nearest first.
    const globalHits = bundle.searchMessages(unitVector(0), { limit: 3 });
    expect(globalHits.map((h) => h.message.messageId)).toEqual([
      "3EB0-SR-1",
      "3EB0-SR-3",
      "3EB0-SR-2",
    ]);
    expect(globalHits[0]!.distance).toBeCloseTo(0, 5);
    expect(globalHits[0]!.message.content).toBe("las 40 cajas del jueves");
    for (let i = 1; i < globalHits.length; i++) {
      expect(globalHits[i]!.distance).toBeGreaterThanOrEqual(
        globalHits[i - 1]!.distance,
      );
    }

    // Chat-scoped: only the scoped chat's messages — the globally-nearest
    // hit in another chat never leaks into the scope.
    const scoped = bundle.searchMessages(unitVector(0), {
      chatJid: OTHER_CHAT,
      limit: 3,
    });
    expect(scoped.map((h) => h.message.messageId)).toEqual([
      "3EB0-SR-3",
      "3EB0-SR-4",
    ]);

    // The limit bounds the hit count; a chat with no vectors is empty.
    expect(bundle.searchMessages(unitVector(0), { limit: 1 })).toHaveLength(1);
    expect(
      bundle.searchMessages(unitVector(0), {
        chatJid: "5215559999@s.whatsapp.net",
        limit: 3,
      }),
    ).toEqual([]);
    bundle.close();
  });
});

describe("the rep notepad (ticket #260; spec #258; ADR-0033 as amended)", () => {
  const EXECUTION = "0e2c7a52-0000-4000-8000-000000000001";
  const EVIDENCE = "0e2c7a52-0000-4000-8000-0000000000e1";

  /** One write, with everything the caller did not name filled in. */
  function write(
    bundle: ReturnType<typeof createBundle>,
    text: string,
    at = "2026-09-20T17:00:00.000Z",
  ) {
    return bundle.writeNotepad({
      text,
      writtenAt: at,
      executionId: EXECUTION,
      evidenceRef: EVIDENCE,
    });
  }

  it("is born absent, holds what the rep taught, and survives reopen", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);

    // Born ABSENT rather than empty: a twin nobody has taught anything is a
    // different fact from a rep who cleared their notebook.
    expect(bundle.readNotepad()).toBeUndefined();

    const written = write(bundle, "con Fuentes siempre de usted");
    expect(written.outcome).toBe("written");
    expect(bundle.readNotepad()).toEqual({
      version: 1,
      text: "con Fuentes siempre de usted",
      writtenAt: "2026-09-20T17:00:00.000Z",
      executionId: EXECUTION,
      evidenceRef: EVIDENCE,
    });
    bundle.close();

    // Twin-side, inside the bundle, under the one key (ADR-0007, ADR-0033):
    // what the rep taught dies with the key and never crosses the wall.
    const reopened = openBundle(path, dek);
    expect(reopened.readNotepad()?.text).toBe("con Fuentes siempre de usted");
    reopened.close();
  });

  it("appends versions with the newest current, and keeps every earlier one", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);

    write(bundle, "con Fuentes siempre de usted", "2026-09-20T17:00:00.000Z");
    write(bundle, "con Fuentes de usted; firmo «saludos»", "2026-09-20T17:05:00.000Z");

    const current = bundle.readNotepad();
    expect(current?.version).toBe(2);
    expect(current?.text).toBe("con Fuentes de usted; firmo «saludos»");
    bundle.close();

    // APPEND-ONLY IS THE CLAIM, so it is asserted against the raw store: the
    // API only ever shows the newest, and "nothing the rep taught is ever
    // overwritten" is a property of the TABLE (ADR-0033; #41 Q5).
    const db = openKeyed(path, dek, { fileMustExist: true });
    try {
      const rows = db
        .prepare("SELECT id, text FROM notepad_versions ORDER BY id")
        .all() as { id: number; text: string }[];
      expect(rows).toEqual([
        { id: 1, text: "con Fuentes siempre de usted" },
        { id: 2, text: "con Fuentes de usted; firmo «saludos»" },
      ]);
    } finally {
      db.close();
    }
  });

  it("takes an empty version — the delete, which the recipe reads as nothing taught", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    write(bundle, "con Fuentes siempre de usted");
    expect(write(bundle, "").outcome).toBe("written");
    // The row exists and its text is empty, which is the rep clearing the
    // notebook — different from never having written one.
    expect(bundle.readNotepad()?.text).toBe("");
    expect(bundle.readNotepad()?.version).toBe(2);
    bundle.close();
  });

  it("finds the version a given act wrote, whether or not it is still current (#264)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const first = bundle.writeNotepad({
      text: "con Fuentes siempre de usted",
      writtenAt: "2026-09-20T17:00:00.000Z",
      executionId: EXECUTION,
      evidenceRef: "act-one",
    });
    bundle.writeNotepad({
      text: "con Fuentes de tú",
      writtenAt: "2026-09-20T17:05:00.000Z",
      executionId: EXECUTION,
      evidenceRef: "act-two",
    });
    expect(first.outcome).toBe("written");
    // THE EARLIER VERSION IS STILL FOUND BY ITS EVIDENCE after a later one
    // became current — which is what recovery asks of an act whose account
    // never landed.
    expect(bundle.readNotepadByEvidence("act-one")?.text).toBe(
      "con Fuentes siempre de usted",
    );
    expect(bundle.readNotepadByEvidence("act-two")?.version).toBe(2);
    expect(bundle.readNotepadByEvidence("act-three")).toBeUndefined();
    bundle.close();
  });

  it("refuses a write past the cap and hands back the text that still stands", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    write(bundle, "con Fuentes siempre de usted");

    const tooLong = "a".repeat(NOTEPAD_CAP + 1);
    const refused = write(bundle, tooLong);
    // A VALUE, NEVER A THROW (spec #258: "an over-limit write returns a
    // structured error listing the current text"), and it carries what the
    // consolidate-and-retry needs: the cap, what was attempted, and the text
    // the rep taught that is still standing.
    expect(refused).toEqual({
      outcome: "over_cap",
      cap: NOTEPAD_CAP,
      charsAttempted: NOTEPAD_CAP + 1,
      currentText: "con Fuentes siempre de usted",
    });
    // NOTHING WAS DROPPED: the store is exactly where it was.
    expect(bundle.readNotepad()?.text).toBe("con Fuentes siempre de usted");
    expect(bundle.readNotepad()?.version).toBe(1);
    bundle.close();
  });

  it("refuses over the cap with nothing taught yet, and the standing text is empty", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const refused = write(bundle, "b".repeat(NOTEPAD_CAP + 40));
    expect(refused).toEqual({
      outcome: "over_cap",
      cap: NOTEPAD_CAP,
      charsAttempted: NOTEPAD_CAP + 40,
      currentText: "",
    });
    expect(bundle.readNotepad()).toBeUndefined();
    bundle.close();
  });

  it("counts characters the way SQLite's own length() does, so the API and the CHECK agree", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    // ONE CHARACTER, TWO UTF-16 UNITS. `String.length` would call 750 emoji
    // 1,500 characters and refuse the 751st while SQLite's `length()` still
    // read 751 — two different caps on one store.
    const emoji = "🙂".repeat(NOTEPAD_CAP);
    expect(emoji.length).toBe(NOTEPAD_CAP * 2);
    expect(write(bundle, emoji).outcome).toBe("written");
    expect(write(bundle, `${emoji}🙂`)).toMatchObject({
      outcome: "over_cap",
      charsAttempted: NOTEPAD_CAP + 1,
    });
    bundle.close();
  });

  it("holds the cap in the schema too — a write around the API is refused by SQLite", () => {
    // THE CHECK IS THE CLAIM, so it is asserted against the raw store rather
    // than through `writeNotepad`, whose own check would never reach it: the
    // cap is a property of the TABLE and not of one writer's manners.
    const path = tmpBundlePath();
    const dek = freshDek();
    createBundle(path, dek).close();

    const db = openKeyed(path, dek, { fileMustExist: true });
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO notepad_versions (text, written_at, execution_id, evidence_ref)
             VALUES (?, ?, ?, ?)`,
          )
          .run("c".repeat(NOTEPAD_CAP + 1), "2026-09-20T17:00:00.000Z", EXECUTION, EVIDENCE),
      ).toThrow(/CHECK/iu);
    } finally {
      db.close();
    }
  });

  it("joins the store enumeration FR-73 audits (spec #258: eight to nine)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    expect(bundle.listStores()).toContain("notepad_versions");
    bundle.close();
  });
});

describe("the twin's working memory (ticket #322; spec #318 decisions 2 and 32)", () => {
  const EXECUTION = "0e2c7a52-0000-4000-8000-000000000001";
  const TORRES = { kind: "entity", id: "0e2c7a52-0000-4000-8000-0000000000aa" } as const;
  const CARD = { kind: "post", id: "0e2c7a52-0000-4000-8000-0000000000bb" } as const;

  function write(
    bundle: ReturnType<typeof createBundle>,
    text: string,
    matters: readonly { label: string; about: typeof TORRES | typeof CARD }[] = [],
    at = "2026-10-04T17:00:00.000Z",
  ) {
    return bundle.writeWorkingMemory({ text, matters, writtenAt: at, executionId: EXECUTION });
  }

  it("is born absent, holds the prose and the typed open matters, and survives reopen", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);
    expect(bundle.readWorkingMemory()).toBeUndefined();

    expect(
      write(bundle, "Torres espera saber cuándo sale su pedido.", [
        { label: "Torres, el pedido", about: TORRES },
        { label: "el borrador de la mañana", about: CARD },
      ]).outcome,
    ).toBe("written");
    bundle.close();

    const reopened = openBundle(path, dek);
    expect(reopened.readWorkingMemory()).toEqual({
      version: 1,
      text: "Torres espera saber cuándo sale su pedido.",
      matters: [
        { label: "Torres, el pedido", about: TORRES },
        { label: "el borrador de la mañana", about: CARD },
      ],
      writtenAt: "2026-10-04T17:00:00.000Z",
      executionId: EXECUTION,
    });
    reopened.close();
  });

  it("appends a version per write with the newest current, and keeps every earlier one", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);
    write(bundle, "Torres espera su pedido.", [{ label: "Torres, el pedido", about: TORRES }]);
    write(bundle, "Lo de Torres quedó.", [], "2026-10-04T18:00:00.000Z");
    expect(bundle.readWorkingMemory()).toMatchObject({ version: 2, text: "Lo de Torres quedó.", matters: [] });
    bundle.close();

    const db = openKeyed(path, dek, { fileMustExist: true });
    try {
      expect(
        db.prepare("SELECT id, text FROM working_memory_versions ORDER BY id").all(),
      ).toEqual([
        { id: 1, text: "Torres espera su pedido." },
        { id: 2, text: "Lo de Torres quedó." },
      ]);
    } finally {
      db.close();
    }
  });

  it("refuses prose past its cap, a list past its count and a label past its length, handing back what stands", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    write(bundle, "Torres espera su pedido.", [{ label: "Torres, el pedido", about: TORRES }]);
    const standing = bundle.readWorkingMemory();

    const prose = write(bundle, "a".repeat(WORKING_MEMORY_CAP + 1));
    expect(prose).toEqual({
      outcome: "over_cap",
      cap: 2000,
      charsAttempted: 2001,
      mattersCap: 12,
      mattersAttempted: 0,
      labelCap: 60,
      labelsTooLong: [],
      current: standing,
    });
    const many = write(
      bundle,
      "corto",
      Array.from({ length: WORKING_MEMORY_MATTERS_CAP + 1 }, (_, at) => ({
        label: `asunto ${String(at)}`,
        about: TORRES,
      })),
    );
    expect(many).toMatchObject({ outcome: "over_cap", mattersAttempted: 13 });
    const long = "l".repeat(OPEN_MATTER_LABEL_CAP + 1);
    expect(write(bundle, "corto", [{ label: long, about: CARD }])).toMatchObject({
      outcome: "over_cap",
      labelsTooLong: [long],
    });
    // Nothing was written by any of the three.
    expect(bundle.readWorkingMemory()).toEqual(standing);
    bundle.close();
  });

  it("holds both caps in the schema — a write around the API is refused by SQLite", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    createBundle(path, dek).close();
    const db = openKeyed(path, dek, { fileMustExist: true });
    const insert = db.prepare(
      "INSERT INTO working_memory_versions (text, matters, written_at, execution_id) VALUES (?, ?, ?, ?)",
    );
    try {
      expect(() =>
        insert.run("c".repeat(WORKING_MEMORY_CAP + 1), "[]", "2026-10-04T17:00:00.000Z", EXECUTION),
      ).toThrow(/CHECK/iu);
      expect(() =>
        insert.run(
          "corto",
          JSON.stringify(Array.from({ length: WORKING_MEMORY_MATTERS_CAP + 1 }, () => ({}))),
          "2026-10-04T17:00:00.000Z",
          EXECUTION,
        ),
      ).toThrow(/CHECK/iu);
      expect(() => insert.run("corto", "not json", "2026-10-04T17:00:00.000Z", EXECUTION)).toThrow(
        /CHECK/iu,
      );
    } finally {
      db.close();
    }
  });

  it("joins the store enumeration FR-73 audits (ten to eleven)", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    expect(bundle.listStores()).toContain("working_memory_versions");
    bundle.close();
  });
});

describe("the twin's workspace, versioned (ticket #326; ADR-0011 as amended)", () => {
  const EXECUTION = "0e2c7a52-0000-4000-8000-000000000001";

  function version(path: string, number: number, content: string) {
    return {
      id: `0e2c7a52-0000-4000-8000-00000000${String(number).padStart(2, "0")}${path.length.toString(16).padStart(2, "0")}`,
      path,
      version: number,
      sha256: `sha-${String(number)}`,
      title: "Hoteles en Madrid",
      content,
      writtenAt: "2026-10-07T17:00:00.000Z",
      executionId: EXECUTION,
    };
  }

  it("keeps every version of a document, each readable by its id, the newest the latest", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const first = version("hoteles.md", 1, "# Hoteles en Madrid\n\nuno");
    const second = { ...version("hoteles.md", 2, "# Hoteles en Madrid\n\ndos"), runId: "0e2c7a52-0000-4000-8000-0000000000aa" };
    bundle.writeWorkspaceVersion(first);
    bundle.writeWorkspaceVersion(second);

    expect(bundle.readWorkspaceVersion(first.id)).toEqual(first);
    expect(bundle.readWorkspaceVersion(second.id)).toEqual(second);
    expect(bundle.latestVersionOf("hoteles.md")).toEqual(second);
    expect(bundle.listWorkspaceVersions("hoteles.md").map((one) => one.version)).toEqual([1, 2]);
    expect(bundle.latestVersionOf("otro.md")).toBeUndefined();
    bundle.close();
  });

  it("refuses a second write of a version, and any change to one written", () => {
    const path = tmpBundlePath();
    const dek = freshDek();
    const bundle = createBundle(path, dek);
    const first = version("hoteles.md", 1, "# Hoteles\n");
    bundle.writeWorkspaceVersion(first);

    expect(() => bundle.writeWorkspaceVersion({ ...first, id: "0e2c7a52-0000-4000-8000-0000000000ff", content: "otra" })).toThrow(/UNIQUE/u);
    bundle.close();
    const db = openKeyed(path, dek, { fileMustExist: true });
    expect(() => db.prepare("UPDATE workspace_versions SET content = 'otra' WHERE id = ?").run(first.id)).toThrow(/immutable/u);
    db.close();
    const reopened = openBundle(path, dek);
    expect(reopened.readWorkspaceVersion(first.id)?.content).toBe("# Hoteles\n");
    reopened.close();
  });

  it("erases a document whole — every version and recall's item for each — and nothing else", () => {
    const bundle = createBundle(tmpBundlePath(), freshDek());
    const kept = version("otro.md", 1, "# Otro\n");
    for (const one of [version("hoteles.md", 1, "# Hoteles\n"), version("hoteles.md", 2, "# Hoteles\n\nmás"), kept]) {
      bundle.writeWorkspaceVersion(one);
      bundle.recordThreadItem({ id: one.id, sessionId: "s", day: "2026-10-07", role: "workspace", at: one.writtenAt, text: one.content });
    }

    expect(bundle.deleteWorkspaceVersions("hoteles.md")).toBe(2);
    expect(bundle.listWorkspaceVersions("hoteles.md")).toEqual([]);
    expect(bundle.searchThreadItems({ words: ["Hoteles"], limit: 8 })).toEqual([]);
    expect(bundle.readWorkspaceVersion(kept.id)).toEqual(kept);
    expect(bundle.readThreadItem(kept.id)?.role).toBe("workspace");
    bundle.close();
  });
});

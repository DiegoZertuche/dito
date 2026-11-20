/**
 * The inbound payload contract (ticket #22 hand-off, binding): a
 * `wa_events.payload_enc` blob decrypts under the twin's DEK to versioned
 * JSON `v: 1` with chat_jid (PN-canonical), sender_jid, from_me,
 * message_id, text, quoted_message_id?. Real envelope crypto — the DEK
 * path is never mocked (ADR-0028); local key material is the fixture path.
 */
import { randomBytes } from "node:crypto";
import { createDekFromMaterial } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
  opaquePlaceholder,
  opaqueRowStandsFor,
  WaPayloadError,
} from "./payload.js";

const dek = createDekFromMaterial(randomBytes(32));

/** Seals a plane-shaped v1 payload the way `plane/ingest` does (envelope-compatible by #22's cross-language tests). */
function sealed(payload: Record<string, unknown>): Uint8Array {
  return dek.encrypt(Buffer.from(JSON.stringify(payload), "utf8"));
}

describe("wa_events payload decode (ingest contract v1, ticket #22)", () => {
  it("decrypts a plane-sealed v1 payload to the pinned message fields", () => {
    const blob = sealed({
      v: 1,
      chat_jid: "5215550001@s.whatsapp.net",
      sender_jid: "5215550001@s.whatsapp.net",
      from_me: false,
      message_id: "3EB0-DR-1",
      text: "¿me mandas 40 cajas para el jueves?",
    });

    expect(decodeWaMessagePayload(dek, blob)).toEqual({
      chatJid: "5215550001@s.whatsapp.net",
      senderJid: "5215550001@s.whatsapp.net",
      fromMe: false,
      messageId: "3EB0-DR-1",
      text: "¿me mandas 40 cajas para el jueves?",
      quotedMessageId: undefined,
    });
  });

  it("carries quoted_message_id through when present (the matcher's raw input rides the same contract)", () => {
    const blob = sealed({
      v: 1,
      chat_jid: "5215550000@s.whatsapp.net",
      sender_jid: "5215550000@s.whatsapp.net",
      from_me: true,
      message_id: "3EB0-DR-2",
      text: "va",
      quoted_message_id: "3EB0-QUOTED-1",
    });

    expect(decodeWaMessagePayload(dek, blob).quotedMessageId).toBe(
      "3EB0-QUOTED-1",
    );
  });

  it("decodes the additive v:1 evolutions when present: the #33 backfill marker and the #30 push_name", () => {
    const blob = sealed({
      v: 1,
      chat_jid: "5215550001@s.whatsapp.net",
      sender_jid: "5215550001@s.whatsapp.net",
      from_me: false,
      message_id: "3EB0-BF-1",
      text: "¿tiene azúcar en costal?",
      push_name: "Sra. Garza",
      backfill: true,
    });

    const decoded = decodeWaMessagePayload(dek, blob);
    expect(decoded.backfill).toBe(true);
    expect(decoded.pushName).toBe("Sra. Garza");
  });

  it("the marker and push name stay absent — never defaulted — on a live-shaped payload (additive evolution only)", () => {
    const blob = sealed({
      v: 1,
      chat_jid: "5215550001@s.whatsapp.net",
      sender_jid: "5215550001@s.whatsapp.net",
      from_me: false,
      message_id: "3EB0-BF-2",
      text: "buenas tardes",
    });

    const decoded = decodeWaMessagePayload(dek, blob);
    expect(decoded.backfill).toBeUndefined();
    expect(decoded.pushName).toBeUndefined();
  });

  it("refuses a mistyped backfill marker or push_name loudly — additive never means unvalidated", () => {
    const base = {
      v: 1,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "m",
      text: "t",
    };
    expect(() =>
      decodeWaMessagePayload(dek, sealed({ ...base, backfill: "yes" })),
    ).toThrow(WaPayloadError);
    expect(() =>
      decodeWaMessagePayload(dek, sealed({ ...base, push_name: 7 })),
    ).toThrow(WaPayloadError);
  });

  it("refuses an unknown payload version loudly — a newer plane means upgrading the runtime, never guessing", () => {
    const blob = sealed({
      v: 2,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "m",
      text: "t",
    });

    expect(() => decodeWaMessagePayload(dek, blob)).toThrow(WaPayloadError);
    expect(() => decodeWaMessagePayload(dek, blob)).toThrow(/version/);
  });

  it("refuses a structurally malformed payload loudly", () => {
    const blob = sealed({ v: 1, chat_jid: "x@s.whatsapp.net" });
    expect(() => decodeWaMessagePayload(dek, blob)).toThrow(WaPayloadError);
  });

  it("a tampered blob is refused by the envelope itself (GCM auth), before any parsing", () => {
    const blob = Uint8Array.from(
      sealed({
        v: 1,
        chat_jid: "x@s.whatsapp.net",
        sender_jid: "x@s.whatsapp.net",
        from_me: false,
        message_id: "m",
        text: "t",
      }),
    );
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    expect(() => decodeWaMessagePayload(dek, blob)).toThrow();
  });
});

describe("wa_events reaction payload decode (ticket #97; ADR-0041)", () => {
  it("decrypts a plane-sealed v1 reaction to the pinned reaction fields", () => {
    const blob = sealed({
      v: 1,
      chat_jid: "5215550001@s.whatsapp.net",
      sender_jid: "5215550001@s.whatsapp.net",
      from_me: false,
      message_id: "3EB0-RX-1",
      reaction_to: "3EB0-DR-1",
      emoji: "👍",
      sender_ts_ms: 1_788_000_000_000,
    });

    expect(decodeWaReactionPayload(dek, blob)).toEqual({
      chatJid: "5215550001@s.whatsapp.net",
      senderJid: "5215550001@s.whatsapp.net",
      fromMe: false,
      messageId: "3EB0-RX-1",
      reactionTo: "3EB0-DR-1",
      emoji: "👍",
      senderTsMs: 1_788_000_000_000,
      pushName: undefined,
      backfill: undefined,
    });
  });

  it("a set, a change and a removal all decode — the removal is the empty emoji, never a missing field", () => {
    const base = {
      v: 1,
      chat_jid: "5215550001@s.whatsapp.net",
      sender_jid: "5215550001@s.whatsapp.net",
      from_me: true,
      reaction_to: "3EB0-DR-1",
    };
    const set = decodeWaReactionPayload(
      dek,
      sealed({ ...base, message_id: "r1", emoji: "👍", sender_ts_ms: 1 }),
    );
    const changed = decodeWaReactionPayload(
      dek,
      sealed({ ...base, message_id: "r2", emoji: "❤️", sender_ts_ms: 2 }),
    );
    const removed = decodeWaReactionPayload(
      dek,
      sealed({ ...base, message_id: "r3", emoji: "", sender_ts_ms: 3 }),
    );

    expect([set.emoji, changed.emoji, removed.emoji]).toEqual(["👍", "❤️", ""]);
    // Every delivery is its own row pointing at the same target, and the
    // fold key orders them (ADR-0041: nothing folds in the plane).
    expect([set.reactionTo, changed.reactionTo, removed.reactionTo]).toEqual([
      "3EB0-DR-1",
      "3EB0-DR-1",
      "3EB0-DR-1",
    ]);
    expect([set.senderTsMs, changed.senderTsMs, removed.senderTsMs]).toEqual([
      1, 2, 3,
    ]);
  });

  it("carries the same additive v:1 evolutions messages carry: push_name and the backfill marker", () => {
    const decoded = decodeWaReactionPayload(
      dek,
      sealed({
        v: 1,
        chat_jid: "5215550001@s.whatsapp.net",
        sender_jid: "5215550001@s.whatsapp.net",
        from_me: false,
        message_id: "3EB0-RX-2",
        reaction_to: "3EB0-DR-1",
        emoji: "👍",
        sender_ts_ms: 1_788_000_000_000,
        push_name: "Sra. Garza",
        backfill: true,
      }),
    );

    expect(decoded.pushName).toBe("Sra. Garza");
    expect(decoded.backfill).toBe(true);
  });

  it("refuses a reaction missing its target, its emoji or its fold key — the shape is its own, never the message shape bent", () => {
    const base = {
      v: 1,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "r",
      reaction_to: "m",
      emoji: "👍",
      sender_ts_ms: 1,
    };
    const common = {
      v: base.v,
      chat_jid: base.chat_jid,
      sender_jid: base.sender_jid,
      from_me: base.from_me,
      message_id: base.message_id,
    };
    const noTarget = { ...common, emoji: base.emoji, sender_ts_ms: 1 };
    const noEmoji = { ...common, reaction_to: "m", sender_ts_ms: 1 };
    const noFoldKey = { ...common, reaction_to: "m", emoji: base.emoji };
    for (const without of [noTarget, noEmoji, noFoldKey]) {
      expect(() => decodeWaReactionPayload(dek, sealed(without))).toThrow(
        WaPayloadError,
      );
    }
    expect(() =>
      decodeWaReactionPayload(dek, sealed({ ...base, sender_ts_ms: "1" })),
    ).toThrow(WaPayloadError);
    expect(() =>
      decodeWaReactionPayload(dek, sealed({ ...base, sender_ts_ms: 1.5 })),
    ).toThrow(WaPayloadError);
  });

  it("refuses an unknown payload version exactly as the message decoder does — the version rule is untouched", () => {
    const blob = sealed({
      v: 2,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "r",
      reaction_to: "m",
      emoji: "👍",
      sender_ts_ms: 1,
    });

    expect(() => decodeWaReactionPayload(dek, blob)).toThrow(WaPayloadError);
    expect(() => decodeWaReactionPayload(dek, blob)).toThrow(/version/);
  });

  // Each decoder refuses the OTHER TYPE'S SHAPE — not every payload that
  // mentions the other type's fields. Unknown keys stay ignored in both
  // shapes, which is the rule that made `push_name` and `backfill`
  // additive; a decoder that refused a field because some other type owns
  // it would refuse the next additive evolution too. What decides which
  // decoder runs is the row's `event_type`, and the plane writes both.
  it("a message payload is not a reaction payload — neither decoder accepts the other's shape", () => {
    const message = sealed({
      v: 1,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "m",
      text: "va",
    });
    const reaction = sealed({
      v: 1,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "r",
      reaction_to: "m",
      emoji: "👍",
      sender_ts_ms: 1,
    });

    expect(() => decodeWaReactionPayload(dek, message)).toThrow(WaPayloadError);
    expect(() => decodeWaMessagePayload(dek, reaction)).toThrow(WaPayloadError);
  });
});

describe("wa_events opaque payload decode (ticket #124; ADR-0042)", () => {
  /** The pinned opaque shape, minus whatever a case leaves out. */
  const OPAQUE = {
    v: 1,
    chat_jid: "5215550001@s.whatsapp.net",
    sender_jid: "5215550001@s.whatsapp.net",
    from_me: false,
    message_id: "3EB0-PHOTO-1:opaque",
    kind: "imageMessage",
    reason: "no_slot",
    sender_ts_ms: 1_788_000_000_000,
  };

  it("decrypts a plane-sealed v1 opaque delivery to the pinned fields", () => {
    expect(decodeWaOpaquePayload(dek, sealed(OPAQUE))).toEqual({
      chatJid: "5215550001@s.whatsapp.net",
      senderJid: "5215550001@s.whatsapp.net",
      fromMe: false,
      messageId: "3EB0-PHOTO-1:opaque",
      kind: "imageMessage",
      reason: "no_slot",
      senderTsMs: 1_788_000_000_000,
      pushName: undefined,
      backfill: undefined,
    });
  });

  it("carries the same additive v:1 evolutions the other shapes carry: push_name and the backfill marker", () => {
    const decoded = decodeWaOpaquePayload(
      dek,
      sealed({ ...OPAQUE, push_name: "Sra. Garza", backfill: true }),
    );

    expect(decoded.pushName).toBe("Sra. Garza");
    expect(decoded.backfill).toBe(true);
  });

  it("decodes all three reasons the plane may state — and nothing else, because the set is closed", () => {
    for (const reason of ["no_slot", "undecryptable", "malformed"]) {
      expect(
        decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, reason })).reason,
      ).toBe(reason);
    }
    for (const reason of ["", "unknown", "no-slot", 1]) {
      expect(() =>
        decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, reason })),
      ).toThrow(WaPayloadError);
    }
  });

  it("refuses an opaque delivery missing its kind, its reason or its sender clock — the shape is its own, never the message shape bent", () => {
    const common = {
      v: OPAQUE.v,
      chat_jid: OPAQUE.chat_jid,
      sender_jid: OPAQUE.sender_jid,
      from_me: OPAQUE.from_me,
      message_id: OPAQUE.message_id,
    };
    const noKind = { ...common, reason: "no_slot", sender_ts_ms: 1 };
    const noReason = { ...common, kind: "imageMessage", sender_ts_ms: 1 };
    const noClock = { ...common, kind: "imageMessage", reason: "no_slot" };
    for (const without of [noKind, noReason, noClock]) {
      expect(() => decodeWaOpaquePayload(dek, sealed(without))).toThrow(
        WaPayloadError,
      );
    }
    // An empty kind is no kind: the placeholder is composed FROM it.
    expect(() =>
      decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, kind: "" })),
    ).toThrow(WaPayloadError);
    expect(() =>
      decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, sender_ts_ms: "1" })),
    ).toThrow(WaPayloadError);
    expect(() =>
      decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, sender_ts_ms: 1.5 })),
    ).toThrow(WaPayloadError);
  });

  it("refuses an identity that is neither of the two permitted shapes — an unsuffixed one would take the readable row's place in twin memory, forever", () => {
    for (const messageId of [
      "3EB0-PHOTO-1", // unsuffixed: the readable row's own key
      "",
      ":opaque",
      "opaque:",
      "opaque",
      "3EB0-PHOTO-1:OPAQUE",
    ]) {
      expect(() =>
        decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, message_id: messageId })),
      ).toThrow(WaPayloadError);
    }
    // ...and both permitted shapes decode, including a stanza half that
    // carries colons of its own (#101 composes reaction ids that do).
    for (const messageId of [
      "3EB0-PHOTO-1:opaque",
      "opaque:9f2c1a",
      "3EB0-T:r:5215550001:1788000000000:opaque",
    ]) {
      expect(
        decodeWaOpaquePayload(dek, sealed({ ...OPAQUE, message_id: messageId }))
          .messageId,
      ).toBe(messageId);
    }
  });

  it("refuses an unknown payload version exactly as the other decoders do — the version rule is untouched", () => {
    const blob = sealed({ ...OPAQUE, v: 2 });

    expect(() => decodeWaOpaquePayload(dek, blob)).toThrow(WaPayloadError);
    expect(() => decodeWaOpaquePayload(dek, blob)).toThrow(/version/);
  });

  it("no decoder accepts another type's shape — what decides is the row's event_type", () => {
    const message = sealed({
      v: 1,
      chat_jid: "x@s.whatsapp.net",
      sender_jid: "x@s.whatsapp.net",
      from_me: false,
      message_id: "m",
      text: "va",
    });
    const opaque = sealed(OPAQUE);

    expect(() => decodeWaOpaquePayload(dek, message)).toThrow(WaPayloadError);
    expect(() => decodeWaMessagePayload(dek, opaque)).toThrow(WaPayloadError);
    expect(() => decodeWaReactionPayload(dek, opaque)).toThrow(WaPayloadError);
  });
});

describe("the placeholder beat, composed from the kind by code (ADR-0042)", () => {
  it("names a photo, a voice note, and — for everything else — a message the twin could not read", () => {
    expect(opaquePlaceholder("imageMessage")).toBe("[foto]");
    expect(opaquePlaceholder("audioMessage")).toBe("[nota de voz]");
    for (const kind of [
      "undecryptable",
      "protocolMessage/REVOKE",
      "pollCreationMessage",
      "stickerMessage",
      "reaction",
    ]) {
      expect(opaquePlaceholder(kind)).toBe("[mensaje que no se pudo leer]");
    }
  });

  it("still names a photo or a voice note when the kind carries the missing field a `malformed` row states", () => {
    // The contract records `malformed`'s missing field through `kind`, so
    // an id-less photo arrives as `imageMessage/message_id`. The twin can
    // say it was a photo, and does.
    expect(opaquePlaceholder("imageMessage/message_id")).toBe("[foto]");
    expect(opaquePlaceholder("audioMessage/message_id")).toBe("[nota de voz]");
    // ...and a slash-qualified kind that is not media keeps the honest
    // fallback, as it would without a qualifier.
    expect(opaquePlaceholder("protocolMessage/REVOKE")).toBe(
      "[mensaje que no se pudo leer]",
    );
    expect(opaquePlaceholder("reaction/reaction_to")).toBe(
      "[mensaje que no se pudo leer]",
    );
  });

  it("never puts the rail's own word in front of the rep", () => {
    expect(opaquePlaceholder("imageMessage")).not.toContain("imageMessage");
  });
});

describe("an opaque row's identity says which message it stands for (ADR-0042)", () => {
  it("reads the message id back out of a `<stanza>:opaque` identity", () => {
    expect(opaqueRowStandsFor("3EB0-PHOTO-1:opaque")).toBe("3EB0-PHOTO-1");
  });

  it("says NOTHING for the id-less shape — a delivery with no stanza id stands for no message", () => {
    expect(opaqueRowStandsFor("opaque:9f2c1a")).toBeUndefined();
    expect(opaqueRowStandsFor(":opaque")).toBeUndefined();
  });

  it("says nothing for a readable row's id, which stands for itself", () => {
    expect(opaqueRowStandsFor("3EB0-PHOTO-1")).toBeUndefined();
  });
});

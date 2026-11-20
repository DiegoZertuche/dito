/**
 * THE NAME→CUSTOMER LOOKUP, AND THE TOOL IT ARRIVES AS (tickets #175, #321;
 * spec #171 decision 5; spec #318 decision 18; ADR-0004, ADR-0013).
 *
 * The fold is what «escríbele a Torres» turns into: the rep types a name and
 * the runtime looks for it among the chats the rep themselves confirmed. Two
 * callers share it — the search's `counterparty` scoping, which narrows to
 * one chat when exactly one matches, and `resolve_chat`, which hands back
 * every customer it matches, each by their stable reference.
 *
 * REAL SQLCIPHER, NEVER A STUB BUNDLE (ADR-0028). The thing under test is a
 * fold over rows the entity mirror really holds, and a hand-written
 * `listChatBindings` would be this suite agreeing with itself about what a
 * binding is.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createBundle, type Bundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import { describe, expect, it } from "vitest";
import { threadDeps } from "../testing/thread-deps.js";
import { useTmpDirs } from "../testing/tmp.js";
import { foldName, resolveChatCandidates } from "./chats.js";
import { customersOf } from "./references.js";
import { ServedHits } from "./served.js";
import { RESOLVE_CHAT_COLUMNS, RESOLVE_CHAT_TOOL, resolveChatTool } from "./tools.js";


const tmpDir = useTmpDirs("dito-thread-chats-");

const TORRES_A = "5215550001@s.whatsapp.net";
const TORRES_B = "5215550002@s.whatsapp.net";
const GARZA = "5215550003@s.whatsapp.net";
const DIEGO_8416 = "5218110008416@s.whatsapp.net";
const DIEGO_0537 = "5218110000537@s.whatsapp.net";
const OTHER_8416 = "5213330008416@s.whatsapp.net";
const DIEGO_LID = "111222333444555@lid";

/** What the other side wrote — never something the model may be shown. */
const SAID = "mándame la cotización";

/** One message from the other side of a chat, at an instant. */
function otherSideWrites(bundle: Bundle, chatJid: string, at: string): void {
  bundle.ingestMessage({
    chatJid,
    messageId: `M-${chatJid}-${at}`,
    senderJid: chatJid,
    fromMe: false,
    occurredAt: at,
    content: SAID,
  });
}

/** ...one from the rep. */
function repWritesIn(bundle: Bundle, chatJid: string, at: string): void {
  bundle.ingestMessage({
    chatJid,
    messageId: `R-${chatJid}-${at}`,
    senderJid: "5215550000@s.whatsapp.net",
    fromMe: true,
    occurredAt: at,
    content: "va, te la mando",
  });
}

/** ...and a reaction from the other side, which is a gesture and not writing. */
function otherSideReacts(bundle: Bundle, chatJid: string, at: string): void {
  bundle.ingestMessage({
    chatJid,
    messageId: `G-${chatJid}-${at}`,
    senderJid: chatJid,
    fromMe: false,
    occurredAt: at,
    content: "reaccionó 👍",
    reactionTo: `R-${chatJid}-2026-09-20T18:00:00.000Z`,
    reactionEmoji: "👍",
  });
}

/**
 * A bundle holding exactly the bindings a test names — each its own customer,
 * unless a binding names the entity it shares with another (the two-chat
 * customer, which no path but a fixture writes today).
 */
function bundleWith(
  bindings: readonly { chatJid: string; displayName: string; entity?: number }[],
): Bundle {
  const bundle = createBundle(
    join(tmpDir(), "twin.bundle"),
    createDekFromMaterial(randomBytes(32)),
  );
  for (const [index, binding] of bindings.entries()) {
    bundle.confirmChatBinding({
      chatJid: binding.chatJid,
      entityId: `0e2c7a52-0000-4000-8000-00000000000${String(binding.entity ?? index + 1)}`,
      displayName: binding.displayName,
      confirmedAt: `2026-08-27T17:00:0${String(index)}.000Z`,
    });
  }
  return bundle;
}

/** The deps a lookup runs over: the bundle's own references. */
function lookupDeps(bundle: Bundle) {
  const served = new ServedHits(customersOf(bundle, "5215550000@s.whatsapp.net"));
  return { deps: threadDeps({ bundle, served }), served };
}

describe("the fold from a typed name to the rep's own chats (ticket #175)", () => {
  it("is case- and accent-insensitive, because the rep types a name and not an identifier", () => {
    expect(foldName("  Sra. GARZA ")).toBe("sra. garza");
    expect(foldName("Torrés")).toBe(foldName("torres"));
    expect(foldName("")).toBe("");
  });

  it("returns every bound chat the name matches, in the mirror's own order", () => {
    // The FOLD returns both — telling them apart is `resolve_chat`'s
    // question, not this one's.
    const bundle = bundleWith([
      { chatJid: TORRES_A, displayName: "Torres" },
      { chatJid: TORRES_B, displayName: "torrés" },
      { chatJid: GARZA, displayName: "Sra. Garza" },
    ]);
    expect(
      resolveChatCandidates(bundle, "TORRES").map((c) => c.chatJid),
    ).toEqual([TORRES_A, TORRES_B]);
    expect(resolveChatCandidates(bundle, "Sra. Garza")).toEqual([
      {
        chatJid: GARZA,
        entityId: "0e2c7a52-0000-4000-8000-000000000003",
        displayName: "Sra. Garza",
      },
    ]);
    bundle.close();
  });

  it("matches a name by its WHOLE WORDS, which is what makes the ask answerable (Codex r1)", () => {
    // THE DECISION THIS TICKET RECORDS. Under exact-only matching the only
    // way two chats can match one name is for both to be confirmed under
    // the SAME one — so every ask reads «¿Torres o Torres?», which is a
    // choice the rep cannot make and which ADR-0039's completeness test
    // refuses. Whole words are what make the ordinary ambiguity two
    // distinguishable answers.
    const bundle = bundleWith([
      { chatJid: TORRES_A, displayName: "Torres Hermanos" },
      { chatJid: TORRES_B, displayName: "Juan Torres" },
      { chatJid: GARZA, displayName: "Sra. Garza" },
    ]);
    expect(
      resolveChatCandidates(bundle, "Torres").map((c) => c.displayName),
    ).toEqual(["Torres Hermanos", "Juan Torres"]);
    expect(
      resolveChatCandidates(bundle, "Torres Hermanos").map((c) => c.chatJid),
    ).toEqual([TORRES_A]);
    // Punctuation the rep did or did not type decides nothing.
    expect(resolveChatCandidates(bundle, "sra garza")).toHaveLength(1);
    bundle.close();
  });

  it("never matches a fragment of a word, and never words out of order", () => {
    // A SUBSTRING IS A SEARCH AND NOT A NAME. The rep is naming somebody,
    // so the words have to line up on their own boundaries — and in their
    // own order, because «Hermanos Torres» is a different person from
    // «Torres Hermanos».
    const bundle = bundleWith([
      { chatJid: TORRES_A, displayName: "Torres Hermanos" },
    ]);
    expect(resolveChatCandidates(bundle, "Torr")).toEqual([]);
    expect(resolveChatCandidates(bundle, "orres")).toEqual([]);
    expect(resolveChatCandidates(bundle, "Hermanos Torres")).toEqual([]);
    expect(resolveChatCandidates(bundle, "Hermanos")).toHaveLength(1);
    bundle.close();
  });

  it("resolves nothing for an empty name, rather than every chat", () => {
    const bundle = bundleWith([{ chatJid: TORRES_A, displayName: "Torres" }]);
    expect(resolveChatCandidates(bundle, "   ")).toEqual([]);
    bundle.close();
  });
});

describe("`resolve_chat` returns customers by their references (ADR-0013 as amended; ticket #321)", () => {
  it("pins three columns and nothing else — a reference, a name and the chats, never an address", () => {
    expect(RESOLVE_CHAT_COLUMNS).toEqual(["ref", "name", "chats"]);
    expect(resolveChatTool(threadDeps()).name).toBe(RESOLVE_CHAT_TOOL);
  });

  it("serves one match with the customer's own reference, and the result names no address", async () => {
    const bundle = bundleWith([
      { chatJid: TORRES_A, displayName: "Torres" },
      { chatJid: GARZA, displayName: "Sra. Garza" },
    ]);
    const { deps } = lookupDeps(bundle);
    const result = await resolveChatTool(deps).run({ name: "Torres" });
    expect(result).toBe(
      [
        "[c1] Torres — one chat:",
        "  chat 1: number ending 0001; the other side has not written yet",
      ].join("\n"),
    );
    expect(result).not.toContain(TORRES_A);
    expect(result).not.toContain("0e2c7a52");
    bundle.close();
  });

  it("gives the same reference to the same customer on every lookup — it names them all day", async () => {
    const bundle = bundleWith([
      { chatJid: TORRES_A, displayName: "Torres" },
      { chatJid: GARZA, displayName: "Sra. Garza" },
    ]);
    const first = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "Sra. Garza" });
    const later = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "Garza" });
    expect(first.split("\n")[0]).toBe("[c2] Sra. Garza — one chat:");
    expect(later.split("\n")[0]).toBe("[c2] Sra. Garza — one chat:");
    bundle.close();
  });

  it("serves two customers of one name as two references — what the twin reads about each tells them apart", async () => {
    const bundle = bundleWith([
      { chatJid: TORRES_A, displayName: "Torres Hermanos" },
      { chatJid: TORRES_B, displayName: "Juan Torres" },
    ]);
    const result = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "torres" });
    expect(result.split("\n").filter((line) => line.startsWith("["))).toEqual([
      "[c1] Torres Hermanos — one chat:",
      "[c2] Juan Torres — one chat:",
    ]);
    bundle.close();
  });

  it("serves a customer with two chats as ONE reference, each chat with its tail and the day the other side last wrote", async () => {
    const bundle = bundleWith([
      { chatJid: DIEGO_8416, displayName: "Diego Zertuche", entity: 7 },
      { chatJid: DIEGO_0537, displayName: "Diego Zertuche", entity: 7 },
    ]);
    // 03:00 UTC on the 27th is still the 26th in Monterrey.
    otherSideWrites(bundle, DIEGO_8416, "2026-09-27T03:00:00.000Z");
    otherSideWrites(bundle, DIEGO_0537, "2026-09-12T18:00:00.000Z");
    // The rep's own later message, and the other side's later GESTURE, say
    // nothing about when the other side last wrote.
    repWritesIn(bundle, DIEGO_0537, "2026-09-20T18:00:00.000Z");
    otherSideReacts(bundle, DIEGO_0537, "2026-09-25T18:00:00.000Z");
    const result = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "Diego Zertuche" });
    expect(result).toBe(
      [
        "[c1] Diego Zertuche — 2 chats; say which when you write to them:",
        "  chat 1: number ending 8416; the other side last wrote on Saturday, Sep 26, 2026",
        "  chat 2: number ending 0537; the other side last wrote on Saturday, Sep 12, 2026",
      ].join("\n"),
    );
    bundle.close();
  });

  it("shows no digits for a chat the rail addresses by LID, whose digits are nobody's number", async () => {
    const bundle = bundleWith([
      { chatJid: DIEGO_8416, displayName: "Diego Zertuche", entity: 7 },
      { chatJid: DIEGO_LID, displayName: "Diego Zertuche", entity: 7 },
    ]);
    otherSideWrites(bundle, DIEGO_LID, "2026-09-12T18:00:00.000Z");
    const result = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "Diego Zertuche" });
    expect(result).toContain("chat 2: no number shown; the other side last wrote on Saturday, Sep 12, 2026");
    expect(result).not.toContain("111222333444555");
    bundle.close();
  });

  it("never shows the model an address, an entity id or a word anybody wrote (ADR-0013)", async () => {
    const bundle = bundleWith([
      { chatJid: DIEGO_8416, displayName: "Diego Zertuche" },
      { chatJid: OTHER_8416, displayName: "Diego Zertuche" },
      { chatJid: DIEGO_LID, displayName: "Diego Zertuche" },
    ]);
    otherSideWrites(bundle, DIEGO_8416, "2026-09-26T18:00:00.000Z");
    otherSideWrites(bundle, OTHER_8416, "2026-09-12T18:00:00.000Z");
    otherSideWrites(bundle, DIEGO_LID, "2026-09-01T18:00:00.000Z");
    const result = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "Diego Zertuche" });
    for (const address of [DIEGO_8416, OTHER_8416, DIEGO_LID]) {
      expect(result).not.toContain(address);
      expect(result).not.toContain(address.split("@")[0]);
    }
    expect(result).not.toContain("0e2c7a52");
    expect(result).not.toContain(SAID);
    bundle.close();
  });

  it("says plainly when no customer of the rep's is confirmed under that name", async () => {
    const bundle = bundleWith([{ chatJid: GARZA, displayName: "Sra. Garza" }]);
    const { deps } = lookupDeps(bundle);
    const result = await resolveChatTool(deps).run({ name: "Torres" });
    expect(result).toContain("No customer");
    bundle.close();
  });

  it("refuses a call with no name, in words the model can act on", async () => {
    const bundle = bundleWith([{ chatJid: TORRES_A, displayName: "Torres" }]);
    const result = await resolveChatTool(lookupDeps(bundle).deps).run({ name: "  " });
    expect(result).toMatch(/^rejected:/u);
    bundle.close();
  });
});

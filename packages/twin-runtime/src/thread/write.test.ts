/**
 * WHAT `create_draft` REFUSES, AND WHAT ITS POST ANNOUNCES (tickets #175,
 * #314; ADR-0006, ADR-0013 as amended).
 *
 * The refusals are calls that must never reach a write, and the tool itself
 * writes nothing — it holds the draft for the turn's caller, which writes it
 * with the turn's words (ticket #368). That ordering is the claim: a draft is
 * written only for a customer the rep confirmed, with words for the customer,
 * and only once per message. The write itself is proven at the Postgres seam
 * (`thread-references.int.test.ts`), where a draft is a row the send lock
 * can walk.
 *
 * The landing cases land the held draft the way the caller does and read the
 * post it hands its client: the sealed parts opened under the real twin key,
 * under the post id the tool named. A knock held on that post is landed at the
 * Postgres seam (`thread-day.int.test.ts`), where `addKnock` reads the card.
 */
import { randomBytes } from "node:crypto";
import { createDekFromMaterial } from "@dito/crypto";
import type { Bundle } from "@dito/bundle";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { landDraft } from "../drafts.js";
import { openSealedParts } from "../posts.js";
import { notepadBundle } from "../testing/notepad-bundle.js";
import { threadDeps } from "../testing/thread-deps.js";
import { ActSlot } from "./acts.js";
import { knockTool } from "./canvas-tools.js";
import type { Customer, Customers } from "./references.js";
import { ServedHits } from "./served.js";
import { CREATE_DRAFT_TOOL, createDraftTool } from "./write.js";

const TORRES = "5215550001@s.whatsapp.net";
const DIEGO_8416 = "5218110008416@s.whatsapp.net";
const DIEGO_0537 = "5218110000537@s.whatsapp.net";
const LAURA = "5215550003@s.whatsapp.net";

/**
 * The customers a run can name: Torres on one chat, Diego on two — one
 * reference, two numbers — and Laura, whom nobody has confirmed.
 */
const CUSTOMERS: Readonly<Record<number, Customer>> = {
  1: {
    reference: 1,
    entityId: "E-1",
    name: "Torres",
    shown: "Torres",
    chats: [{ chatJid: TORRES, tail: "0001" }],
    anchors: [],
  },
  2: {
    reference: 2,
    entityId: "E-2",
    name: "Diego",
    shown: "Diego",
    chats: [
      { chatJid: DIEGO_8416, tail: "8416" },
      { chatJid: DIEGO_0537, tail: "0537" },
    ],
    anchors: [],
  },
  3: {
    reference: 3,
    name: "Laura",
    shown: "Laura (sin confirmar)",
    chats: [{ chatJid: LAURA }],
    anchors: ["M-3"],
  },
};
const customers: Customers = (reference) => CUSTOMERS[reference];

/** A run whose references name those three, and the deps built over it. */
function run(overrides: Parameters<typeof threadDeps>[0] = {}) {
  return threadDeps({ served: new ServedHits(customers), ...overrides });
}

/** The draft the tool would write if nothing refused it. */
const GOOD = {
  entity: "c1",
  text: "Ya está lista la factura, se la mando hoy.",
};

describe("`create_draft` writes to a customer by reference, and the pick is the twin's (ticket #321)", () => {
  it("declares the tap as its gate — the approval comes BEFORE the effect (ADR-0006)", () => {
    expect(createDraftTool(run()).gate).toBe("approve-before");
    expect(createDraftTool(run()).name).toBe(CREATE_DRAFT_TOOL);
  });

  it("refuses a reference that names no customer, before the turn's one act is spent", async () => {
    const deps = run();
    const outcome = await createDraftTool(deps).run({ ...GOOD, entity: "c9" });
    expect(outcome.performed).toBe(false);
    expect(outcome.told).toContain("[c9] names no customer");
    // The slot is still free: the twin can correct the reference this turn.
    expect(deps.acts.claim("create_draft")).toEqual({ ok: true });
  });

  it("refuses an `entity` that is not a reference at all", async () => {
    const outcome = await createDraftTool(run()).run({ ...GOOD, entity: "Torres" });
    expect(outcome.told).toContain("`entity` is the customer's reference");
  });

  it("refuses a chat nobody has confirmed — a Borrador never goes where the rep has not said who it is", async () => {
    const outcome = await createDraftTool(run()).run({ ...GOOD, entity: "c3" });
    expect(outcome.told).toContain("nobody has confirmed");
  });

  it("refuses a customer with two chats and no pick, asking for one", async () => {
    const outcome = await createDraftTool(run()).run({ ...GOOD, entity: "[c2]" });
    expect(outcome.performed).toBe(false);
    expect(outcome.told).toContain("has 2 chats, so say which one");
  });

  it("refuses a pick that is not one of that customer's chats", async () => {
    for (const chat of [0, 3, 1.5, "2"]) {
      const outcome = await createDraftTool(run()).run({ ...GOOD, entity: "c2", chat });
      expect(outcome.performed, String(chat)).toBe(false);
      expect(outcome.told, String(chat)).toContain("is not one of [c2]'s chats");
    }
  });

  it("refuses a second chat for a customer who has one", async () => {
    const outcome = await createDraftTool(run()).run({ ...GOOD, chat: 2 });
    expect(outcome.told).toContain("is not one of [c1]'s chats");
  });

  it("refuses an empty message — there is nothing to put in front of the rep", async () => {
    for (const text of ["", "   "]) {
      const outcome = await createDraftTool(run()).run({ ...GOOD, text });
      expect(outcome.performed).toBe(false);
      expect(outcome.told).toContain("`text` is the message itself");
    }
  });

  it("refuses a reference in the message — nothing renders it, so the customer would read the marker", async () => {
    const outcome = await createDraftTool(run()).run({
      ...GOOD,
      text: "Hola [c1], ya está la factura.",
    });
    expect(outcome.performed).toBe(false);
    expect(outcome.told).toContain("what the customer reads");
  });

  it("takes no clause for the rep: why the draft exists is the turn's own words (ticket #368)", () => {
    const declared = createDraftTool(run());
    expect(Object.keys(declared.inputSchema.properties ?? {})).not.toContain("porque");
    expect(declared.inputSchema.required).toEqual(["entity", "text"]);
  });

  it("refuses a second effect in one message, naming the tool that already acted", async () => {
    const acts = new ActSlot();
    acts.claim("dismiss_draft");
    const outcome = await createDraftTool(run({ acts })).run(GOOD);
    expect(outcome.performed).toBe(false);
    expect(outcome.told).toContain("already acted this turn (dismiss_draft)");
  });
});

/** The id the store gives the draft's post. */
const WRITTEN_POST = "77777777-7777-4777-8777-777777777777";

/**
 * A run that may write: a client that keeps every
 * statement it is handed, the real twin key, and a twin memory holding no
 * messages for the chat.
 */
function writingRun() {
  const statements: { readonly text: string; readonly params: readonly unknown[] }[] = [];
  const db = {
    query: (text: string, params: readonly unknown[] = []) => {
      statements.push({ text, params });
      // A POST'S ROW SAYS ITS ID AND INSTANT BACK: the id the twin knocks on,
      // the instant its reminder is scheduled from.
      if (/INSERT INTO posts\b/u.test(text)) {
        return Promise.resolve({ rows: [{ id: WRITTEN_POST, posted_at: new Date("2026-10-08T15:00:00Z") }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  } as unknown as pg.ClientBase;
  const dek = createDekFromMaterial(randomBytes(32));
  const memory = notepadBundle();
  const bundle = new Proxy(memory, {
    get: (target, property, receiver: unknown) =>
      property === "readConversation"
        ? () => []
        : Reflect.get(target, property, receiver),
  }) as Bundle;
  const deps = run({ db, dek, bundle });
  /** The held draft written as the turn's caller writes it, with no words of the twin's. */
  const land = async () => {
    const held = deps.draft.held;
    if (held === undefined) throw new Error("no draft was held");
    await landDraft(db, { twinId: deps.twinId, selfChatJid: deps.selfChatJid, dek }, held, { words: "", mentions: [] });
  };
  /** The post `recordDraft` wrote: its parts, opened, and the id it was written under. */
  const post = () => {
    const insert = statements.find((s) => s.text.includes("INSERT INTO posts"));
    if (insert === undefined) throw new Error("no post was written");
    return { parts: openSealedParts(dek, insert.params[2] as Uint8Array), id: insert.params[11] };
  };
  /** The chat the draft row was written for. */
  const destination = () =>
    statements.find((s) => s.text.includes("INSERT INTO drafts"))?.params[3];
  return { deps, land, post, destination };
}

describe("a draft the rep asked for is announced by the knock tool, on the post create_draft names (#314, #358)", () => {
  it("takes no sentence for the phone: the knock is the knock tool's row", () => {
    const declared = createDraftTool(run()).inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(declared.properties)).not.toContain("knock");
  });

  it("lands the draft alone and tells the twin the post's id, which the knock tool takes", async () => {
    const writing = writingRun();
    const outcome = await createDraftTool(writing.deps).run(GOOD);
    expect(outcome.performed).toBe(true);
    const held = writing.deps.draft.held;
    if (held === undefined) throw new Error("no draft was held");
    expect(outcome.told).toContain(`post ${held.postId}, draft ${held.id}`);
    await writing.land();
    expect(writing.post().parts.map((part) => part.kind)).toEqual(["draft"]);
    // THE POST LANDS UNDER THE ID THE TWIN WAS TOLD.
    expect(writing.post().id).toBe(held.postId);
  });
});

describe("the draft goes to the chat the twin picked, and the card shows its tail (ticket #321)", () => {
  it("writes to a one-chat customer's chat with no pick, and the card carries no tail", async () => {
    const writing = writingRun();
    const outcome = await createDraftTool(writing.deps).run(GOOD);
    expect(outcome.performed).toBe(true);
    await writing.land();
    expect(writing.destination()).toBe(TORRES);
    const draft = writing.post().parts.find((part) => part.kind === "draft");
    expect(draft).toMatchObject({ kind: "draft", counterparty: "Torres" });
    expect(draft).not.toHaveProperty("tail");
  });

  it("writes to the second chat of a two-chat customer when the twin picks it, and the card shows that number's tail", async () => {
    const writing = writingRun();
    const outcome = await createDraftTool(writing.deps).run({ ...GOOD, entity: "c2", chat: 2 });
    expect(outcome.performed).toBe(true);
    await writing.land();
    expect(writing.destination()).toBe(DIEGO_0537);
    expect(writing.post().parts.find((part) => part.kind === "draft")).toMatchObject({
      counterparty: "Diego",
      tail: "0537",
    });
  });

  it("holds the draft for the turn's caller and writes nothing itself — its timing is the caller's too (ticket #368)", async () => {
    const writing = writingRun();
    await createDraftTool(writing.deps).run(GOOD);
    expect(writing.deps.draft.held).toMatchObject({ executionId: writing.deps.executionId, destination: TORRES });
    expect(() => writing.post()).toThrow("no post was written");
    expect(writing.deps.draftTiming.timing).toBeUndefined();
  });
});

/**
 * A run whose twin memory names Torres `c1` and Diego's two chats `c2`, as the
 * feed reads a draft's customer — and a client that keeps every statement.
 */
function knockingRun() {
  const statements: string[] = [];
  const db = {
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as pg.ClientBase;
  const references: Readonly<Record<string, number>> = { [TORRES]: 1, [DIEGO_8416]: 2, [DIEGO_0537]: 2 };
  const bundle = new Proxy(notepadBundle(), {
    get: (target, property, receiver: unknown) =>
      property === "referenceForChat"
        ? (chatJid: string) => references[chatJid]
        : Reflect.get(target, property, receiver),
  }) as Bundle;
  const deps = run({ db, bundle });
  return { deps, statements };
}

describe("a knock on the post create_draft named is held with the draft and lands with it (#358)", () => {
  it("passes the knock tool's floors, writes nothing, and is held on the draft until the post lands", async () => {
    const { deps, statements } = knockingRun();
    expect((await createDraftTool(deps).run(GOOD)).performed).toBe(true);
    const held = deps.draft.held!;
    const outcome = await knockTool(deps).run({
      post_id: held.postId,
      sentence: "Listo el mensaje para [c1] sobre la factura.",
    });
    expect(outcome).toMatchObject({ performed: true, act: "knocked" });
    expect(outcome.told).toContain(`post ${held.postId}`);
    expect(statements.filter((text) => text.includes("post_knocks"))).toEqual([]);
    expect(deps.draft.held?.knock).toEqual({
      sentence: "Listo el mensaje para Torres sobre la factura.",
      customers: ["c1"],
    });
  });

  it("refuses a second knock on the same landing", async () => {
    const { deps } = knockingRun();
    await createDraftTool(deps).run(GOOD);
    const postId = deps.draft.held!.postId;
    await knockTool(deps).run({ post_id: postId, sentence: "Listo lo de [c1]." });
    const again = await knockTool(deps).run({ post_id: postId, sentence: "Ya quedó lo de [c1]." });
    expect(again.performed).toBe(false);
    expect(again.told).toContain("has already had its knock");
    expect(deps.draft.held?.knock?.sentence).toBe("Listo lo de Torres.");
  });

  it("refuses a knock naming another customer, or carrying a link, and spends nothing", async () => {
    const { deps } = knockingRun();
    await createDraftTool(deps).run(GOOD);
    const postId = deps.draft.held!.postId;
    for (const [sentence, reason] of [
      ["Listo el mensaje para [c2].", "names a customer that card is not about"],
      ["Listo lo de [c1]: https://dito.mx/d/1", "the sentence was refused"],
    ] as const) {
      const outcome = await knockTool(deps).run({ post_id: postId, sentence });
      expect(outcome.performed, sentence).toBe(false);
      expect(outcome.told, sentence).toContain(reason);
      expect(deps.draft.held?.knock, sentence).toBeUndefined();
    }
    // ...SO THE LANDING'S ONE KNOCK IS STILL THE TWIN'S TO WRITE.
    expect((await knockTool(deps).run({ post_id: postId, sentence: "Listo lo de [c1]." })).performed).toBe(true);
  });
});

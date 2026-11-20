/**
 * THE CANVAS, AS THE TWIN THREAD READS IT (ticket #320; spec #318 decision
 * 10; design §3.2) — the one rendering every wake's block and `read_canvas`
 * share.
 */
import { describe, expect, it } from "vitest";
import type { FeedPost } from "../feed.js";
import { inicioOrder, renderCanvas, type CardOrigin, type CanvasView } from "./canvas-tools.js";
import type { Customers } from "./references.js";
import { ServedHits } from "./served.js";

const ZONE = "America/Monterrey";
const AT = new Date("2026-10-03T14:00:00.000Z");
const LAURA = "6f0c3a52-0000-4000-8000-000000000001";
const NOTES = "6f0c3a52-0000-4000-8000-000000000002";
const GONE = "6f0c3a52-0000-4000-8000-000000000003";

/** Laura's reference, as the bundle holds it: the one her card is matched by. */
const LAURAS: Customers = (reference) =>
  reference === 4
    ? {
        reference: 4,
        entityId: "e1",
        name: "Laura Garza",
        shown: "Laura Garza",
        chats: [{ chatJid: "5215550004@s.whatsapp.net", tail: "0004" }],
        anchors: [],
      }
    : undefined;

function draftFor(id: string, counterparty: string, knocked = false): FeedPost {
  return {
    id,
    at: AT,
    executionId: null,
    origin: "composed",
    customer: "c4",
    parts: [
      { kind: "draft", draftId: `d-${id}`, counterparty, body: "sí, te las aparto", acts: ["tap", "dismiss"] },
      ...(knocked ? [{ kind: "knock" as const, text: "Te dejé la respuesta.", acts: [] }] : []),
    ],
  };
}

const NOTES_POST: FeedPost = {
  id: NOTES,
  at: AT,
  executionId: null,
  origin: "composed",
  parts: [
    {
      kind: "record-lines",
      disclosurePostId: "dp",
      acts: ["retract"],
      lines: [
        { index: 1, text: "Le cotizaste 40 cajas.", provenance: "", disclosureLineId: "l1", entityId: "e1", retracted: false, retractable: true },
        { index: 2, text: "Te pidió el jueves.", provenance: "", disclosureLineId: "l2", entityId: "e1", retracted: false, retractable: false },
      ],
      windowClosesAt: AT,
    },
  ],
};

const SEEN_AT = new Date("2026-10-03T15:30:00.000Z");
const KNOCKED_AT = new Date("2026-10-03T14:05:00.000Z");
const RUN_AT = new Date("2026-10-03T13:00:00.000Z");
const ASKED = "6f0c3a52-0000-4000-8000-000000000004";

describe("the canvas block (ticket #401)", () => {
  it("lists every card in the order the rep sees it, top first, by spot — its origin, seen and knocked instants, offer and spotlight", () => {
    const view: CanvasView = {
      waiting: [draftFor(LAURA, "Laura Garza"), NOTES_POST, { ...draftFor(ASKED, "Laura Garza"), at: SEEN_AT }],
      seen: new Map([[NOTES, SEEN_AT]]),
      knocked: new Map([[LAURA, KNOCKED_AT]]),
      origins: new Map<string, CardOrigin>([
        [LAURA, { kind: "customer" }],
        [NOTES, { kind: "run", automation: "rutina", name: "La lista de [c4] del viernes", startedAt: RUN_AT, step: 2 }],
        [ASKED, { kind: "ask" }],
      ]),
      settled: [{ postId: GONE, outcome: "dismissed" }],
      curation: {
        version: 1,
        spotlight: NOTES,
        order: [NOTES, LAURA],
        offers: [{ postId: LAURA, sentence: "¿Le confirmo a Laura Garza la entrega?" }],
        left: [],
        at: AT,
      },
      spotlight: { postId: LAURA, since: KNOCKED_AT },
    };
    const served = new ServedHits(LAURAS);
    expect(renderCanvas(view, served, ZONE)).toBe(
      [
        "3 cards on the rep's dashboard right now, in the order they see them, top first:",
        `1. post ${NOTES} · the day's notes, 1 line the rep can still mark wrong · from your rutina "La lista de [c4] del viernes", the pass started [Saturday, Oct 3, 2026, 07:00:00 CST], step 2 · waiting since [Saturday, Oct 3, 2026, 08:00:00 CST] · seen [Saturday, Oct 3, 2026, 09:30:00 CST] · never knocked`,
        `2. post ${LAURA} · a draft reply for [c4] · from a customer's message · waiting since [Saturday, Oct 3, 2026, 08:00:00 CST] · not seen yet · knocked [Saturday, Oct 3, 2026, 08:05:00 CST] · you left an offer on it · in the spotlight since [Saturday, Oct 3, 2026, 08:05:00 CST]`,
        `3. post ${ASKED} · a draft reply for [c4] · from the rep's ask · waiting since [Saturday, Oct 3, 2026, 09:30:00 CST] · not seen yet · never knocked`,
        `Settled in the last hour: post ${GONE} discarded.`,
      ].join("\n"),
    );
    // NO FIRST-PLACE WORD AND NO OLD ORDER LINE: the spot numbers say it.
    expect(renderCanvas(view, new ServedHits(LAURAS), ZONE)).not.toContain("The order you last chose");
    // THE BLOCK GROUNDS A LINE'S FIGURES with every id and every reference
    // taken out: the 4 of [c4] is nobody's figure.
    const grounds = served.state().grounds.join("\n");
    expect(grounds).not.toContain("Laura Garza");
    expect(grounds).not.toContain(LAURA);
    expect(grounds).not.toContain("[c4]");
    expect(grounds).toContain("3 cards on the rep's dashboard");
  });

  it("lists the cards the twin took off on their own, as hidden from the rep", () => {
    const view: CanvasView = {
      waiting: [draftFor(LAURA, "Laura Garza"), NOTES_POST],
      seen: new Map(),
      settled: [],
      curation: { version: 3, order: [NOTES], offers: [], left: [LAURA], at: AT },
    };
    const block = renderCanvas(view, new ServedHits(LAURAS), ZONE).split("\n");
    expect(block[0]).toBe("1 card on the rep's dashboard right now, in the order they see them, top first:");
    expect(block[1]).toMatch(new RegExp(`^1\\. post ${NOTES} `, "u"));
    expect(block[2]).toBe("1 card you took off the dashboard, still waiting and hidden from the rep there until you place it again:");
    expect(block[3]).toMatch(new RegExp(`^- post ${LAURA} · a draft reply for \\[c4\\] · written by Dito`, "u"));
  });

  it("orders the cards the arrangement does not name after it, oldest first, as Inicio does", () => {
    const later = { ...draftFor(ASKED, "Laura Garza"), at: SEEN_AT };
    expect(
      inicioOrder([draftFor(LAURA, "x"), NOTES_POST, later], { version: 1, spotlight: later.id, order: [later.id], offers: [], left: [], at: AT }).map(
        (post) => post.id,
      ),
    ).toEqual([ASKED, LAURA, NOTES]);
  });

  it("names a card whose customer the bundle no longer holds by what it is, with no reference", () => {
    const view: CanvasView = { waiting: [draftFor(LAURA, "Laura Garza")], seen: new Map(), settled: [] };
    expect(renderCanvas(view, new ServedHits(() => undefined), ZONE)).toContain(`1. post ${LAURA} · a draft reply · written by Dito · waiting since`);
  });

  it("says plainly when nothing waits", () => {
    expect(renderCanvas({ waiting: [], seen: new Map(), settled: [] }, new ServedHits(LAURAS), ZONE)).toBe(
      "Nothing waits on the rep's dashboard right now.",
    );
  });
});

/**
 * THE TRIGGER RECORD (ticket #178; spec #171 decision 10; ADR-0014 as
 * amended 2026-09-04 — "the trigger record carries both its mechanism and
 * its occasion, so the execution record and the audit entry say what a run
 * was about and how it came to be").
 *
 * Two claims, and the second is the one that costs something if it breaks:
 * a reference renders both words, and it renders the ids the way audit
 * coverage looks for them.
 */
import { describe, expect, it } from "vitest";
import { wakeAccepts } from "./automation.js";
import { OCCASIONS, triggerRef, type Trigger } from "./trigger.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const QUESTION = "22222222-2222-4222-8222-222222222222";
const TWIN = "33333333-3333-4333-8333-333333333333";
const NOTICE = "44444444-4444-4444-8444-444444444444";

const OWNER_QUESTION: Trigger = {
  kind: "owner_question",
  mechanism: "request",
  companyId: COMPANY,
  ownerQuestionId: QUESTION,
};

const CHAT_TURN: Trigger = {
  kind: "chat_turn",
  mechanism: "seam_event",
  twinId: TWIN,
  chatJid: "5215550001@s.whatsapp.net",
  anchorEventId: "412",
  eventIds: ["410", "411", "412"],
};

const THREAD_MESSAGE: Trigger = {
  kind: "twin_thread_message",
  mechanism: "seam_event",
  twinId: TWIN,
  door: "twin_thread",
  eventId: "512",
};

/** The same occasion, arrived through the dashboard's door (ticket #261). */
const DOOR_MESSAGE: Trigger = {
  kind: "twin_thread_message",
  mechanism: "seam_event",
  twinId: TWIN,
  door: "dashboard",
  eventId: "4b8f2c10-0000-4000-8000-000000000001",
};

const ENTITY = "55555555-5555-4555-8555-555555555555";

const ENTITY_KIND: Trigger = {
  kind: "entity_kind",
  mechanism: "request",
  twinId: TWIN,
  chatJid: "5215550001@s.whatsapp.net",
  entityId: ENTITY,
};

describe("a trigger reference names the occasion, the mechanism and the ids", () => {
  it("renders all four, and nothing else", () => {
    // The whole string, pinned: what an entry's `ref` carries is
    // append-only, so it is worth writing down rather than asserting in
    // pieces that would each pass over a string missing the others.
    expect(triggerRef(OWNER_QUESTION)).toBe(
      `trigger:owner_question mechanism:request company:${COMPANY} owner_question:${QUESTION}`,
    );
  });

  it("carries no content — the question's text is not reachable from a trigger", () => {
    // The one field of an owner question that IS content is its text, and
    // the type has no place to put it. Said as a test because ADR-0020's
    // claim is about what a chain entry can hold, and this string is the
    // only part of an entry an execution composes.
    expect(Object.keys(OWNER_QUESTION).sort()).toEqual([
      "companyId",
      "kind",
      "mechanism",
      "ownerQuestionId",
    ]);
  });

  it("keeps the token audit coverage joins on (`owner_question:<id>`)", () => {
    // `audit-coverage.ts`'s `execution` class matches an entry by finding
    // this token inside the ref. The mechanism was added BESIDE the ids for
    // exactly this reason, and a future edit that folded it into one of them
    // would turn the owner lane's `--require-acts=execution` red on the rig
    // and nowhere else.
    expect(triggerRef(OWNER_QUESTION)).toContain(`owner_question:${QUESTION}`);
    expect(triggerRef(OWNER_QUESTION)).toContain(`company:${COMPANY}`);
  });
});

describe("a settled customer turn's reference (ticket #172)", () => {
  it("renders the twin, the anchor and how many events the turn held", () => {
    // The whole string, pinned for the reason the owner's is: the ref is
    // append-only once written, so what it carries is worth writing down
    // rather than asserting in pieces.
    expect(triggerRef(CHAT_TURN)).toBe(
      `trigger:chat_turn mechanism:seam_event twin:${TWIN} event:412 events:3`,
    );
  });

  it("names no chat and no JID, though the trigger carries one", () => {
    // THE CLAIM THIS TICKET EXISTS FOR. The rep chain's refs have never
    // carried a JID (`consumer.ts`'s two precedents are `twin:… event:…`
    // and `twin:… question:…`), because a chat address dereferences to
    // chat identity (ADR-0004) and a chain entry is content-free
    // (ADR-0020). The trigger holds the chat because the occasion IS a
    // chat's turn; the reference is where that stops.
    expect(triggerRef(CHAT_TURN)).not.toContain("@");
    expect(triggerRef(CHAT_TURN)).not.toContain("5215550001");
    // The occasion WORD holds "chat" and must — what may not appear is the
    // address, so the claim is about the token rather than the substring.
    expect(triggerRef(CHAT_TURN).split(" ").map((token) => token.split(":")[0]))
      .toEqual(["trigger", "mechanism", "twin", "event", "events"]);
  });

  it("keeps the occasion the first token after `trigger:`", () => {
    // The coverage class joins on the occasion word, so it stays where the
    // owner's is (`triggerRef`'s own docblock).
    expect(triggerRef(CHAT_TURN).split(" ")[0]).toBe("trigger:chat_turn");
  });

  it("carries the turn's events and nothing a message said", () => {
    expect(Object.keys(CHAT_TURN).sort()).toEqual([
      "anchorEventId",
      "chatJid",
      "eventIds",
      "kind",
      "mechanism",
      "twinId",
    ]);
  });

  it("counts a one-message turn as one", () => {
    expect(
      triggerRef({
        kind: "chat_turn",
        mechanism: "seam_event",
        twinId: TWIN,
        chatJid: "5215550001@s.whatsapp.net",
        anchorEventId: "9",
        eventIds: ["9"],
      }),
    ).toBe(`trigger:chat_turn mechanism:seam_event twin:${TWIN} event:9 events:1`);
  });
});

describe("a rep message in the twin thread (ticket #173)", () => {
  it("renders the twin and the rep's own event, and says the rep quoted nothing", () => {
    // The whole string, pinned for the reason the other two are: the ref is
    // append-only once written.
    expect(triggerRef(THREAD_MESSAGE)).toBe(
      `trigger:twin_thread_message mechanism:seam_event twin:${TWIN} event:512 quoted:none door:twin_thread`,
    );
  });

  it("names the twin post the rep quoted, by the id the rep side minted", () => {
    expect(triggerRef({ ...THREAD_MESSAGE, quotedPostId: NOTICE })).toBe(
      `trigger:twin_thread_message mechanism:seam_event twin:${TWIN} event:512 quoted:${NOTICE} door:twin_thread`,
    );
  });

  it("carries no message text, no chat and no JID", () => {
    // The rep's own words are the one field of a thread message that IS
    // content, and the type has no place to put them — the same claim the
    // owner question's test makes about a question's text.
    expect(Object.keys(THREAD_MESSAGE).sort()).toEqual([
      "door",
      "eventId",
      "kind",
      "mechanism",
      "twinId",
    ]);
    for (const trigger of [
      THREAD_MESSAGE,
      { ...THREAD_MESSAGE, quotedPostId: NOTICE },
      DOOR_MESSAGE,
    ] as Trigger[]) {
      expect(triggerRef(trigger)).not.toContain("@");
      expect(
        triggerRef(trigger)
          .split(" ")
          .map((token) => token.split(":")[0]),
      ).toEqual(["trigger", "mechanism", "twin", "event", "quoted", "door"]);
    }
  });

  it("names which door the rep spoke through, in the last position (#261)", () => {
    // THE DOOR IS THE ONE THING AN ENTRY COULD NOT OTHERWISE SAY: `event:` is
    // opaque, so which store it lives in — and therefore whether this run's
    // answer was sent to the thread or posted at the dashboard's door — is
    // readable from the chain only because this token is here.
    expect(triggerRef(DOOR_MESSAGE)).toBe(
      `trigger:twin_thread_message mechanism:seam_event twin:${TWIN} event:4b8f2c10-0000-4000-8000-000000000001 quoted:none door:dashboard`,
    );
  });

  it("keeps the occasion the first token after `trigger:`", () => {
    expect(triggerRef(THREAD_MESSAGE).split(" ")[0]).toBe(
      "trigger:twin_thread_message",
    );
  });

  it("is not the owner's occasion, so the rep chain's coverage class claims it", () => {
    // `audit-coverage.ts`'s `rep_execution` class is stated as the
    // complement — `c.ref NOT LIKE '%owner_question:%'` — so a new rep-side
    // occasion is covered by construction, and this is the assertion that
    // says so.
    expect(triggerRef(THREAD_MESSAGE)).not.toContain("owner_question:");
  });
});

describe("an event that woke the twin thread (ticket #319)", () => {
  it("renders the twin, the event's word and the post it is about", () => {
    expect(
      triggerRef({
        kind: "twin_thread_event",
        mechanism: "seam_event",
        twinId: TWIN,
        event: "post.landed",
        postId: NOTICE,
      }),
    ).toBe(
      `trigger:twin_thread_event mechanism:seam_event twin:${TWIN} event:post.landed post:${NOTICE}`,
    );
  });

  it("says `post:none` for an event about no post, in the same position", () => {
    expect(
      triggerRef({
        kind: "twin_thread_event",
        mechanism: "seam_event",
        twinId: TWIN,
        event: "rail",
      }),
    ).toBe(`trigger:twin_thread_event mechanism:seam_event twin:${TWIN} event:rail post:none`);
  });
});

describe("a binding's kind classification (ticket #176)", () => {
  it("renders the twin and the entity, and says code asked", () => {
    // The whole string, pinned for the reason the other three are: a ref is
    // append-only once written.
    expect(triggerRef(ENTITY_KIND)).toBe(
      `trigger:entity_kind mechanism:request twin:${TWIN} entity:${ENTITY}`,
    );
  });

  it("names no chat and no JID, though the trigger carries one", () => {
    // `chat_turn`'s claim, exactly: the occasion IS a chat's — spec #171
    // decision 10 names the chat among what this trigger carries, so a
    // reader of the VALUE can say which conversation was classified — and
    // the reference is where that stops, because a chat address
    // dereferences to chat identity (ADR-0004) and a chain entry is
    // content-free (ADR-0020).
    expect(triggerRef(ENTITY_KIND)).not.toContain("@");
    expect(triggerRef(ENTITY_KIND)).not.toContain("5215550001");
    expect(
      triggerRef(ENTITY_KIND)
        .split(" ")
        .map((token) => token.split(":")[0]),
    ).toEqual(["trigger", "mechanism", "twin", "entity"]);
  });

  it("carries the chat and the entity, and not a syllable of the conversation", () => {
    // What the classification READS is the chat's own words; what the
    // record carries is two ids and an address the ref never renders.
    expect(Object.keys(ENTITY_KIND).sort()).toEqual([
      "chatJid",
      "entityId",
      "kind",
      "mechanism",
      "twinId",
    ]);
  });

  it("keeps the occasion the first token after `trigger:`", () => {
    expect(triggerRef(ENTITY_KIND).split(" ")[0]).toBe("trigger:entity_kind");
  });

  it("is not the owner's occasion, so the rep chain's coverage class claims it", () => {
    // `audit-coverage.ts`'s `rep_execution` class is the complement —
    // `c.ref NOT LIKE '%owner_question:%'` — so this occasion is covered
    // with no edit there, which is what the class's own docblock promises.
    expect(triggerRef(ENTITY_KIND)).not.toContain("owner_question:");
  });

  it("says code asked rather than an event arriving", () => {
    // The mechanism is `request` at all three call sites — the live
    // confirmation, the startup backlog and the hand-run backfill — and it
    // can be no other: no seam event and no clock is behind a
    // classification (spec #171 decision 26, "a request from code").
    expect(triggerRef(ENTITY_KIND)).toContain("mechanism:request");
  });
});

const SEAT = "77777777-7777-4777-8777-777777777777";
const ARRIVAL_ROW = "88888888-8888-4888-8888-888888888888";

const ARRIVAL: Trigger = {
  kind: "arrival",
  mechanism: "request",
  twinId: TWIN,
  seatId: SEAT,
  arrivalId: ARRIVAL_ROW,
  visit: "return",
  arrivedAt: "2026-09-26T17:45:00.000Z",
  lastArrivedAt: "2026-09-26T14:10:00.000Z",
};

describe("the rep's arrival on Inicio (ticket #266)", () => {
  it("renders the twin, the seat, the arrival, the visit and both instants", () => {
    expect(triggerRef(ARRIVAL)).toBe(
      `trigger:arrival mechanism:request twin:${TWIN} seat:${SEAT} arrival:${ARRIVAL_ROW} visit:return at:2026-09-26T17:45:00.000Z last:2026-09-26T14:10:00.000Z`,
    );
  });

  it("says `last:none` on a first arrival ever, in the same position", () => {
    const first: Trigger = {
      kind: "arrival",
      mechanism: "request",
      twinId: TWIN,
      seatId: SEAT,
      arrivalId: ARRIVAL_ROW,
      visit: "first_of_day",
      arrivedAt: "2026-09-26T14:10:00.000Z",
    };
    expect(triggerRef(first).split(" ").at(-1)).toBe("last:none");
    expect(triggerRef(first)).toContain("visit:first_of_day");
  });

  it("names no line, no curation and no customer — metadata only", () => {
    expect(triggerRef(ARRIVAL)).not.toContain("@");
    expect(
      triggerRef(ARRIVAL)
        .split(" ")
        .map((token) => token.split(":")[0]),
    ).toEqual(["trigger", "mechanism", "twin", "seat", "arrival", "visit", "at", "last"]);
  });

  it("is not the owner's occasion, so the rep chain's coverage class claims it", () => {
    expect(triggerRef(ARRIVAL)).not.toContain("owner_question:");
  });
});

describe("the occasions are a closed set every one of which has a record", () => {
  it("names the slice's occasions", () => {
    // `extraction` and `daily_disclosure` are the words a request names in
    // `runtime_requests`; every other one carries the ids its occasion binds.
    expect([...OCCASIONS]).toEqual([
      "owner_question",
      "chat_turn",
      "twin_thread_message",
      "entity_kind",
      "extraction",
      "daily_disclosure",
      // #224: a rep pressed a button on a card — the first occasion with no
      // model in it, whose whole run is code doing what the button said.
      "dashboard_act",
      // #266: the rep opened Inicio — the first occasion whose trigger is the
      // rep merely looking.
      "arrival",
      // #319: something the twin thread is told about woke it — the first
      // occasion with no rep line and no request behind it.
      "twin_thread_event",
      // #323: one step of a workflow run — the first occasion that is one
      // part of a job longer than a turn.
      "run_step",
    ]);
  });
});

describe("a wake's mechanism is the word the record carries", () => {
  it("accepts the one mechanism a wake declares, and no other", () => {
    const request = { kind: "trigger", mechanism: "request", occasion: "owner_question" } as const;
    const event = {
      kind: "trigger",
      mechanism: "seam_event",
      occasion: "chat_turn",
      predicate: { sources: ["whatsapp"], eventTypes: ["message"] },
    } as const;
    expect(wakeAccepts(request, "request")).toBe(true);
    expect(wakeAccepts(request, "seam_event")).toBe(false);
    expect(wakeAccepts(request, "schedule")).toBe(false);
    expect(wakeAccepts(event, "seam_event")).toBe(true);
    expect(wakeAccepts(event, "request")).toBe(false);
  });

  it("is the mechanism the owner twin's record and its audit ref both carry", () => {
    expect(OWNER_QUESTION.mechanism).toBe("request");
    expect(triggerRef(OWNER_QUESTION)).toContain("mechanism:request");
  });
});

/**
 * THE WIRE AND THE READ MODEL ARE PINNED TO EACH OTHER (ticket #224; #221's
 * decision 10, answered).
 *
 * `readFeed` answers a `FeedPage` whose instants are `Date`s; rep-web receives
 * a `TwinFeedPage` whose instants are ISO strings, because a `Date` does not
 * survive JSON. So the two are genuinely two types — and two types describing
 * one thing is exactly the shape that drifts. This is the pin.
 *
 * IT IS A COMPILE-TIME TEST AS WELL AS A RUNTIME ONE, and both halves earn
 * their place. The compile-time half is `feedPageOnTheWire`'s own signature:
 * it returns `TwinFeedPage` and reads a `FeedPage`, and it names every field
 * rather than handing the object to `JSON.stringify` — so a field grown on the
 * read model with no arm here is a type error in the package that owns both.
 *
 * The RUNTIME half is what a signature cannot say: that the projection LOSES
 * nothing. A function returning the right type could still drop a field, and
 * TypeScript's structural typing would not care — `TwinFeedPage` would be
 * satisfied by an object missing an optional field, and the card that renders
 * it would draw a blank. So this sweeps a post carrying EVERY part kind with
 * EVERY optional field present, and compares the projection's own keys against
 * the read model's, field by field.
 *
 * WHY IT LIVES IN THIS PACKAGE. It is the one that may import both: rep-web
 * must not depend on `@dito/twin-runtime` (it holds the bundle, the KMS client
 * and every automation registry, and the dashboard holds no key), and
 * `@dito/seam` must not depend on the runtime either. The runtime imports the
 * seam, so this is the only place the comparison can be made at all.
 */
import {
  DOORS,
  SHIPPED_AUTOMATIONS,
  type TwinActsLog,
  type TwinExchange,
  type TwinExchanges,
  type TwinFeedPage,
  type TwinFeedPart,
} from "@dito/seam";
import { OCCASIONS, type TwinThreadMessageTrigger } from "@dito/execution";
import { describe, expect, it } from "vitest";
import { RUNTIME_REQUEST_OCCASIONS } from "./runtime-requests.js";
import { actsLogOnTheWire, type ActsLog, type LoggedAct } from "./acts-log.js";
import { exchangesOnTheWire, type Exchange, type Exchanges } from "./exchanges.js";
import { feedPageOnTheWire, type FeedPage, type OpenedPart } from "./feed.js";

/**
 * ONE POST CARRYING EVERY PART KIND WITH EVERY OPTIONAL FIELD SET.
 *
 * A fixture and not a fetch: this file is about the PROJECTION, so the read
 * model is constructed rather than read, and the seam suite is where a real
 * `readFeed` over real rows is driven (`feed.int.test.ts`).
 *
 * EVERY OPTIONAL FIELD IS PRESENT ON PURPOSE. An absent one proves nothing —
 * a projection that dropped it would agree with a projection that kept it — so
 * the fixture is the maximal post and the sweep below compares key sets.
 */
const READ_MODEL: FeedPage = {
  posts: [
    {
      id: "3f8b7a10-0000-4000-8000-000000000001",
      at: new Date("2026-09-08T15:04:05.123Z"),
      executionId: "3f8b7a10-0000-4000-8000-000000000002",
      origin: "composed",
      // WHICH DOOR ASKED (ticket #261) — present, because the fixture is the
      // MAXIMAL post and the sweep below compares key sets.
      askedOn: "dashboard",
      parts: [
        { kind: "prose", text: "Laura volvió a preguntar.", acts: [] },
        {
          kind: "draft",
          draftId: "3f8b7a10-0000-4000-8000-000000000003",
          counterparty: "Laura Garza",
          body: "¡Hola, Laura! Ya quedó.",
          // A DRAFT THAT COMMITS THE REP, AND WHY (ticket #343).
          delicate: true,
          reason: "Le dejé $172, 8% abajo de lista, porque Torres le ofreció lo mismo.",
          acts: ["tap", "dismiss"],
        },
        {
          kind: "record-lines",
          disclosurePostId: "3f8b7a10-0000-4000-8000-000000000004",
          groups: [{ counterparty: "Laura Garza", indexes: [1] }],
          lines: [
            {
              index: 1,
              text: "Le cotizaste a Laura Garza $18,400 por persona.",
              provenance: "su chat, hoy 15:07",
              disclosureLineId: "3f8b7a10-0000-4000-8000-000000000005",
              counterparty: "Laura Garza",
              entityId: "3f8b7a10-0000-4000-8000-000000000006",
              retractable: true,
              retracted: false,
            },
          ],
          windowClosesAt: new Date("2026-09-09T19:00:00.000Z"),
          acts: ["retract"],
        },
        {
          kind: "question",
          subject: "binding",
          aboutEventId: "4210",
          proposedName: "Refacciones RS",
          // WHAT THE REP ANSWERED AND WHICH CHAT IT WAS ABOUT (ticket #255):
          // an answered question offers no acts, and the fixture is the
          // MAXIMAL part, so it carries all three and the sweep below compares
          // key sets.
          answer: "confirmed",
          chatNumber: "5218100000001",
          chatName: "Refacciones RS",
          acts: [],
        },
        { kind: "receipt", text: "Listo, lo descarté.", acts: [] },
        // THE SENTENCE NO SURFACE DRAWS still crosses the wire, because the
        // wire is the POST (ticket #262): a kind held back here would be a
        // part the runtime opens and the projection silently loses.
        { kind: "knock", text: "Te dejé listo lo de Laura.", acts: [] },
        // THE ARRIVAL POST'S LAYOUT (ticket #266): post ids, crossing as they
        // are, because the canvas draws its cards in this order.
        {
          kind: "curation",
          spotlight: "3f8b7a10-0000-4000-8000-000000000007",
          order: [
            "3f8b7a10-0000-4000-8000-000000000007",
            "3f8b7a10-0000-4000-8000-000000000008",
          ],
          acts: [],
        },
      ],
    },
  ],
  nextCursor: "MjAyNi0wOS0wOA",
};

describe("the feed's wire shape and its read model cannot drift (#224)", () => {
  it("projects every field of every part, by name", () => {
    const wire: TwinFeedPage = feedPageOnTheWire(READ_MODEL);
    const post = READ_MODEL.posts[0]!;
    const projected = wire.posts[0]!;
    // The post's own fields, keys compared as SETS: a projection that added a
    // field the wire does not declare would fail here too, which is the other
    // direction of the same drift.
    expect(new Set(Object.keys(projected))).toEqual(
      new Set(Object.keys(post)),
    );
    expect(projected.parts).toHaveLength(post.parts.length);
    for (const [index, part] of post.parts.entries()) {
      const projectedPart = projected.parts[index]!;
      expect(`${part.kind}: ${[...Object.keys(projectedPart)].sort().join(",")}`).toBe(
        `${part.kind}: ${[...Object.keys(part)].sort().join(",")}`,
      );
    }
  });

  it("turns every instant into an ISO string and changes nothing else", () => {
    const wire = feedPageOnTheWire(READ_MODEL);
    const post = wire.posts[0]!;
    // The literals are the fixture's own instants, written out rather than
    // recomputed with `toISOString` — an assertion that called the same method
    // the code calls would pass by construction.
    expect(post.at).toBe("2026-09-08T15:04:05.123Z");
    const lines = post.parts.find((part) => part.kind === "record-lines");
    expect(lines?.kind === "record-lines" ? lines.windowClosesAt : undefined).toBe(
      "2026-09-09T19:00:00.000Z",
    );
    expect(wire.nextCursor).toBe("MjAyNi0wOS0wOA");
    // ...and one value of every other type, unchanged.
    const draft = post.parts.find((part) => part.kind === "draft");
    expect(draft?.kind === "draft" ? draft.body : undefined).toBe(
      "¡Hola, Laura! Ya quedó.",
    );
    expect(draft?.kind === "draft" ? draft.acts : undefined).toEqual([
      "tap",
      "dismiss",
    ]);
    // ...AND THE REASON THE PILL RAISES BEFORE THE TAP, as the twin wrote it (ticket #343).
    expect(draft?.kind === "draft" ? [draft.delicate, draft.reason] : undefined).toEqual([
      true,
      "Le dejé $172, 8% abajo de lista, porque Torres le ofreció lo mismo.",
    ]);
    // ...AND THE DOOR THAT ASKED, a string on both sides (ticket #261).
    expect(post.askedOn).toBe("dashboard");
    // ...AND THE QUESTION'S THREE WORDS, which are strings on both sides: the
    // answer the rep gave, the chat's own number and the name their phone has
    // for it (ticket #255; boundary #225, F34 and F35).
    // ...AND THE KNOCK'S OWN TEXT, which no card prints and notify reads.
    const knock = post.parts.find((part) => part.kind === "knock");
    expect(knock?.kind === "knock" ? knock.text : undefined).toBe(
      "Te dejé listo lo de Laura.",
    );
    const question = post.parts.find((part) => part.kind === "question");
    expect(
      question?.kind === "question"
        ? `${question.answer ?? ""} ${question.chatNumber ?? ""} ${question.chatName ?? ""}`
        : undefined,
    ).toBe("confirmed 5218100000001 Refacciones RS");
  });

  it("drops an absent optional field rather than sending it as null", () => {
    // ADR-0034's rule, carried onto the wire: a field nothing recorded is
    // ABSENT, never a default. A `null` on the wire would render as a blank
    // where a card is supposed to draw nothing at all.
    const bare: FeedPage = {
      posts: [
        {
          id: READ_MODEL.posts[0]!.id,
          at: READ_MODEL.posts[0]!.at,
          executionId: null,
          origin: "reexpressed",
          parts: [
            {
              kind: "draft",
              draftId: "3f8b7a10-0000-4000-8000-000000000003",
              counterparty: "5218100000000 (sin confirmar)",
              body: "sin porqué",
              acts: ["tap", "dismiss"],
            },
          ],
        },
      ],
    };
    const wire = feedPageOnTheWire(bare);
    expect("nextCursor" in wire).toBe(false);
    // A PROACTIVE POST CARRIES NO DOOR AT ALL (ticket #261): a draft goes to
    // both surfaces, so `askedOn` is absent rather than null or a default.
    expect("askedOn" in wire.posts[0]!).toBe(false);
    const part = wire.posts[0]!.parts[0]!;
    expect("tail" in part).toBe(false);
  });

  it("names the same seven part kinds on both sides", () => {
    // The unions are compared through their DISCRIMINANTS, because that is
    // what a surface switches on: a kind on one side and not the other is a
    // card nothing draws or a part nothing produces.
    const wireKinds: readonly TwinFeedPart["kind"][] = [
      "prose",
      "draft",
      "record-lines",
      "question",
      "receipt",
      "knock",
      "curation",
    ];
    const modelKinds: readonly OpenedPart["kind"][] = [
      "prose",
      "draft",
      "record-lines",
      "question",
      "receipt",
      "knock",
      "curation",
    ];
    expect([...wireKinds].sort()).toEqual([...modelKinds].sort());
    // ...and the fixture exercises all seven, so the sweep above is total.
    expect(
      new Set(READ_MODEL.posts[0]!.parts.map((part) => part.kind)),
    ).toEqual(new Set(modelKinds));
  });
});

/**
 * ONE EXCHANGE CARRYING EVERY FIELD, for the sweep below (tickets #261 and
 * #263).
 *
 * `reply` AND `settled` TOGETHER, the maximal value on purpose, exactly as the
 * post above it is: an absent field proves nothing, because a projection that
 * dropped it would agree with one that kept it.
 */
const EXCHANGE: Exchange = {
  messageId: "3f8b7a10-0000-4000-8000-00000000000a",
  at: new Date("2026-09-22T16:04:05.123Z"),
  text: "¿qué quedó con lo de Garza?",
  reply: READ_MODEL.posts[0]!,
  settled: true,
};

/** ...and the page it rides on, with every field of a page set. */
const PAGE: Exchanges = {
  today: "2026-09-22",
  days: [{ day: "2026-09-22", exchanges: [EXCHANGE] }],
  nextUntil: "2026-09-19",
};

describe("the door's exchanges cross the wire by name too (#261, #263)", () => {
  it("projects every field of a page and of an exchange, by name", () => {
    const wire: TwinExchanges = exchangesOnTheWire(PAGE);
    expect(new Set(Object.keys(wire))).toEqual(new Set(Object.keys(PAGE)));
    expect(new Set(Object.keys(wire.days[0]!))).toEqual(
      new Set(Object.keys(PAGE.days[0]!)),
    );
    const exchange = wire.days[0]!.exchanges[0]! as TwinExchange;
    expect(new Set(Object.keys(exchange))).toEqual(new Set(Object.keys(EXCHANGE)));
  });

  it("turns the message's instant into an ISO string and changes nothing else", () => {
    const wire = exchangesOnTheWire(PAGE);
    const exchange = wire.days[0]!.exchanges[0]!;
    // The literal is the fixture's own instant, written out rather than
    // recomputed with `toISOString` — an assertion that called the same method
    // the code calls would pass by construction.
    expect(exchange.at).toBe("2026-09-22T16:04:05.123Z");
    expect(exchange.text).toBe("¿qué quedó con lo de Garza?");
    expect(exchange.reply?.at).toBe("2026-09-08T15:04:05.123Z");
    expect(exchange.settled).toBe(true);
    // THE DAYS STAY DATES: nothing on the way out turns one into an instant.
    expect(wire.today).toBe("2026-09-22");
    expect(wire.days[0]!.day).toBe("2026-09-22");
    expect(wire.nextUntil).toBe("2026-09-19");
  });

  it("drops an absent reply, flag and cursor rather than sending them as null", () => {
    const waiting: Exchange = {
      messageId: EXCHANGE.messageId,
      at: EXCHANGE.at,
      text: EXCHANGE.text,
    };
    const wire = exchangesOnTheWire({
      today: PAGE.today,
      days: [{ day: PAGE.today, exchanges: [waiting] }],
    });
    const exchange = wire.days[0]!.exchanges[0]!;
    // NO REPLY AND NO FLAG IS «THE TWIN IS STILL THINKING», which is what a
    // page resumes waiting on after a reload. A `null` on the wire would be a
    // third state nothing means — and so would a `null` cursor.
    expect("reply" in exchange).toBe(false);
    expect("settled" in exchange).toBe(false);
    expect("nextUntil" in wire).toBe(false);
  });

  it("names the same two doors on the seam and on the trigger", () => {
    // THE TRIGGER'S DOOR AND THE POST'S COLUMN ARE ONE VOCABULARY, and this is
    // the only package that may import both — `@dito/execution` depends on
    // nothing, so it restates the two words as a literal union rather than
    // importing the seam's constant. A word added to one and not the other is
    // a red build here instead of a post nothing renders.
    const doors: readonly TwinThreadMessageTrigger["door"][] = [
      "twin_thread",
      "dashboard",
    ];
    expect([...doors].sort()).toEqual([...DOORS].sort());
  });
});

/**
 * ONE DAY OF THE ACTS LOG WITH EVERY OPTIONAL FIELD SET (ticket #267) — the
 * maximal value, for the reason the post above is: an absent field proves
 * nothing. A retraction's line and day and a link on one act is a shape no
 * store produces, and that is the point of a fixture that sweeps key sets.
 */
const LOGGED: LoggedAct = {
  act: "retracted",
  at: new Date("2026-09-22T18:00:00.000Z"),
  name: "Laura Garza",
  line: 2,
  notesDay: "2026-09-21",
  opens: "inicio",
};

const LOG: ActsLog = {
  today: "2026-09-22",
  day: "2026-09-21",
  back: 1,
  acts: [LOGGED],
};

describe("the acts log crosses the wire by name (#267)", () => {
  it("projects every field of a day and of a line, by name", () => {
    const wire: TwinActsLog = actsLogOnTheWire(LOG);
    expect(new Set(Object.keys(wire))).toEqual(new Set(Object.keys(LOG)));
    expect(new Set(Object.keys(wire.acts[0]!))).toEqual(new Set(Object.keys(LOGGED)));
  });

  it("turns each instant into an ISO string and keeps the days as dates", () => {
    const wire = actsLogOnTheWire(LOG);
    expect(wire.acts[0]!.at).toBe("2026-09-22T18:00:00.000Z");
    expect([wire.today, wire.day, wire.acts[0]!.notesDay]).toEqual([
      "2026-09-22",
      "2026-09-21",
      "2026-09-21",
    ]);
  });

  it("drops absent subject fields rather than sending null", () => {
    const wire = actsLogOnTheWire({
      today: LOG.today,
      day: LOG.today,
      back: 0,
      acts: [{ act: "sent", at: LOGGED.at }],
    });
    expect(Object.keys(wire.acts[0]!).sort()).toEqual(["act", "at"]);
  });

  it("names each of Dito's automations a rep may ask to run by the occasion the execution package knows", () => {
    // THE SEAM RESTATES THE SHIPPED NAMES, because it depends on nothing that
    // declares them; a request names its run's automation by the occasion it
    // asks for (`runtime-requests.ts`), and this is the one package that sees
    // all three lists.
    for (const occasion of RUNTIME_REQUEST_OCCASIONS) {
      expect(SHIPPED_AUTOMATIONS).toContain(occasion);
      expect(OCCASIONS).toContain(occasion);
    }
  });
});

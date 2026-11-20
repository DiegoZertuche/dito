/**
 * THE WAKE LIST AND THE EVENT LINE (ticket #319; spec #318 decision 11; design
 * §6, ruled 2026-09-27).
 */
import { describe, expect, it } from "vitest";
import { fateOf, renderEvent, type ThreadEvent } from "./events.js";

const POST = "6f0c3a52-0000-4000-8000-000000000001";
const OTHER = "6f0c3a52-0000-4000-8000-000000000002";

/** The rep arrived at the dashboard; the row and the seat ride along, never told. */
function arrived(firstOfDay: boolean): ThreadEvent {
  return {
    kind: "arrival",
    door: "dashboard",
    firstOfDay,
    arrival: {
      arrivalId: "6f0c3a52-0000-4000-8000-0000000000a1",
      seatId: "6f0c3a52-0000-4000-8000-0000000000b1",
      arrivedAt: new Date(0),
    },
  };
}

/** The rep selected a phrase on a card; the selection's id and the seat ride along, never told. */
function selected(): ThreadEvent {
  return {
    kind: "selection",
    postId: POST,
    phrase: "[c1] pidió 300 bultos",
    selectionId: "6f0c3a52-0000-4000-8000-0000000000c1",
    seatId: "6f0c3a52-0000-4000-8000-0000000000b1",
  };
}

describe("which events wake a turn, and which only append", () => {
  const none = { top: undefined };

  it("wakes on every landed post, always", () => {
    expect(fateOf({ kind: "post.landed", postId: POST, postKind: "draft", source: "chat_turn" }, none)).toBe("wake");
  });

  it("wakes on a settle only when it was the rep's own act on the spotlighted card", () => {
    const settle = (byRep: boolean): ThreadEvent => ({
      kind: "post.settled",
      postId: POST,
      outcome: "dismissed",
      byRep,
    });
    expect(fateOf(settle(true), { top: POST })).toBe("wake");
    expect(fateOf(settle(true), { top: OTHER })).toBe("append");
    expect(fateOf(settle(true), none)).toBe("append");
    expect(fateOf(settle(false), { top: POST })).toBe("append");
  });

  it("appends a seen-stamp", () => {
    expect(fateOf({ kind: "post.seen", postId: POST }, none)).toBe("append");
  });

  it("wakes on the rep's arrival: the thread greets them (#320)", () => {
    expect(fateOf(arrived(true), none)).toBe("wake");
    expect(fateOf(arrived(false), none)).toBe("wake");
  });

  it("appends the rail's state, dropped or back: the link never wakes the twin (#401)", () => {
    expect(fateOf({ kind: "rail", state: "dropped", since: "2026-10-13T09:36:00.000Z" }, none)).toBe("append");
    expect(fateOf({ kind: "rail", state: "linked" }, none)).toBe("append");
  });

  it("wakes on a phrase the rep selected on a card: they are asking what it is (#341)", () => {
    expect(fateOf(selected(), none)).toBe("wake");
  });
});

describe("an event reads as metadata, never as anybody's words", () => {
  it("carries its word and its ids, stamped in the seat's zone", () => {
    expect(
      renderEvent(
        { kind: "post.landed", postId: POST, postKind: "draft", source: "chat_turn" },
        new Date("2026-10-03T15:00:00Z"),
        "America/Monterrey",
      ),
    ).toBe(
      `[Event · Saturday, Oct 3, 2026, 09:00:00 CST] post.landed {"post_id":"${POST}","kind":"draft","source":"chat_turn"}`,
    );
    expect(
      renderEvent({ kind: "post.settled", postId: POST, outcome: "sent", byRep: false }, new Date(0), "UTC"),
    ).toContain(`post.settled {"post_id":"${POST}","outcome":"sent"}`);
    expect(
      renderEvent(arrived(false), new Date(0), "UTC"),
    ).toBe('[Event · Thursday, Jan 1, 1970, 00:00:00 UTC] arrival {"door":"dashboard","first_of_day":false}');
  });

  it("names a selection by its card and the phrase as the twin wrote it — never the ids that route its line (#341)", () => {
    expect(renderEvent(selected(), new Date(0), "UTC")).toBe(
      `[Event · Thursday, Jan 1, 1970, 00:00:00 UTC] selection {"post_id":"${POST}","phrase":"[c1] pidió 300 bultos"}`,
    );
  });
});

describe("a run wakes the thread at its start, its end and its failure, never its steps (#323)", () => {
  const none = { top: undefined };
  const RUN = "6f0c3a52-0000-4000-8000-0000000000e1";

  it("wakes on a run's start, and on its end however it ended", () => {
    expect(fateOf({ kind: "run.started", runId: RUN }, none)).toBe("append");
    expect(fateOf({ kind: "run.finished", runId: RUN, state: "succeeded" }, none)).toBe("wake");
    expect(fateOf({ kind: "run.finished", runId: RUN, state: "cancelled" }, none)).toBe("wake");
  });

  it("wakes on a run that failed", () => {
    expect(fateOf({ kind: "run.failed", runId: RUN, step: 1 }, none)).toBe("wake");
  });

  it("only appends a step that ended and a wait that parked the run", () => {
    expect(fateOf({ kind: "run.step", runId: RUN, step: 0, state: "succeeded" }, none)).toBe("append");
    expect(fateOf({ kind: "run.suspended", runId: RUN, step: 0 }, none)).toBe("append");
  });

  it("tells a run by its id, the step as the rep counts it and the state word — nothing it did", () => {
    const at = new Date(0);
    expect(renderEvent({ kind: "run.started", runId: RUN }, at, "UTC")).toBe(
      `[Event · Thursday, Jan 1, 1970, 00:00:00 UTC] run.started {"run_id":"${RUN}"}`,
    );
    expect(renderEvent({ kind: "run.step", runId: RUN, step: 1, state: "succeeded" }, at, "UTC")).toContain(
      `run.step {"run_id":"${RUN}","step":"2","state":"succeeded"}`,
    );
    expect(renderEvent({ kind: "run.suspended", runId: RUN, step: 0 }, at, "UTC")).toContain(
      `run.suspended {"run_id":"${RUN}","step":"1","state":"waiting"}`,
    );
    expect(renderEvent({ kind: "run.finished", runId: RUN, state: "succeeded", postId: POST }, at, "UTC")).toContain(
      `run.finished {"run_id":"${RUN}","state":"succeeded","post_id":"${POST}"}`,
    );
    expect(renderEvent({ kind: "run.failed", runId: RUN, step: 2 }, at, "UTC")).toContain(
      `run.failed {"run_id":"${RUN}","step":"3","state":"failed"}`,
    );
  });
});

describe("what the rep did to a rutina reaches the day's thread and wakes nothing (#386)", () => {
  const none = { top: undefined };
  const RUTINA = "6f0c3a52-0000-4000-8000-0000000000f1";

  it("appends the switch and Descartar on an active rutina: the rep did it knowing what they did", () => {
    for (const kind of ["rutina.paused", "rutina.resumed", "rutina.discarded"] as const) {
      expect(fateOf({ kind, rutinaId: RUTINA }, none)).toBe("append");
    }
  });

  it("tells it by the rutina's id and what the rep did, nothing it does", () => {
    const at = new Date(0);
    expect(renderEvent({ kind: "rutina.paused", rutinaId: RUTINA }, at, "UTC")).toBe(
      `[Event · Thursday, Jan 1, 1970, 00:00:00 UTC] rutina.paused {"rutina_id":"${RUTINA}"}`,
    );
    expect(renderEvent({ kind: "rutina.resumed", rutinaId: RUTINA }, at, "UTC")).toContain(
      `rutina.resumed {"rutina_id":"${RUTINA}"}`,
    );
    expect(renderEvent({ kind: "rutina.discarded", rutinaId: RUTINA }, at, "UTC")).toContain(
      `rutina.discarded {"rutina_id":"${RUTINA}"}`,
    );
  });
});

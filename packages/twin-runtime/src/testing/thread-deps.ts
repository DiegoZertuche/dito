/**
 * ONE `ThreadDeps` FIXTURE FOR EVERY UNIT SUITE THAT BUILDS ONE (ticket
 * #174).
 *
 * Three suites built one by hand — the definition's, the recipes' and the
 * submission's — and #174 gave the type six more fields (the connection,
 * the key, the twin, the chain key, the trigger and the act slot), which is
 * the moment three hand-built literals stop being cheaper than one fixture.
 * The tell is not the repetition: it is that each of the three would have
 * had to invent a trigger, and a suite inventing a trigger is a suite that
 * can quietly disagree with the consumer about what a trigger looks like.
 *
 * EVERY DEFAULT IS A REFUSAL, and that is the design. A suite that does not
 * touch Postgres gets a client that throws on any query; one that does not
 * search gets an embedder that rejects. So a test asserting something about
 * the PROMPT cannot accidentally pass because a stub returned an empty
 * result set, and a test that needs a real connection has to say so by
 * overriding it.
 *
 * NOT FOR THE INTEGRATION SUITES. They go through the consumer, which
 * builds the real thing from a real event on a real connection — the
 * pre-agreed Postgres seam (spec #18) — and a fixture there would be a
 * second answer to "what is a thread execution built over".
 */
import type { Dek } from "@dito/crypto";
import type { TwinThreadMessageTrigger } from "@dito/execution";
import type pg from "pg";
import { DEFAULT_REP_LANGUAGE } from "../rep-language.js";
import { notepadBundle } from "./notepad-bundle.js";
import { ActSlot } from "../thread/acts.js";
import type { ThreadDeps } from "../thread/deps.js";
import { TurnDraftTiming } from "../thread/draft-timing.js";
import { HeldDraftSlot } from "../drafts.js";
import { TurnBindingProposal } from "../thread/propose-binding.js";
import type { Customers } from "../thread/references.js";
import { ServedHits } from "../thread/served.js";

/** The rep's own thread, in the fixture's world. */
export const FIXTURE_SELF_CHAT = "5215550000@s.whatsapp.net";
/** The rep's own message id — the one row a search may never serve. */
export const FIXTURE_MESSAGE_ID = "3EB0-THE-MESSAGE";
/** The seat's zone, pinned so every rendered instant is exact. */
export const FIXTURE_ZONE = "America/Monterrey";
export const FIXTURE_TWIN_ID = "11111111-1111-4111-8111-111111111111";
/** This execution's own event — what a rep-act tool's evidence must equal. */
export const FIXTURE_EVENT_ID = "22222222-2222-4222-8222-222222222222";
/** ...and the execution itself, which a rep-initiated draft's timing names. */
export const FIXTURE_EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
/**
 * When the runtime picked the fixture's message up — and, unremarkably, when
 * the seam received it: a unit fixture has no queue to wait in, and the two
 * instants exist to be told apart by a suite that cares.
 */
export const FIXTURE_SEEN_AT = new Date("2026-09-04T18:30:00Z");

/** The trigger the fixture's execution was created by. */
export const FIXTURE_TRIGGER: TwinThreadMessageTrigger = {
  kind: "twin_thread_message",
  mechanism: "seam_event",
  twinId: FIXTURE_TWIN_ID,
  door: "twin_thread",
  eventId: FIXTURE_EVENT_ID,
};

/** A stub that fails loudly rather than pretending to be a store. */
function refusing<T>(what: string): T {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(`this suite does not use ${what}`);
      },
    },
  ) as T;
}


/** A run's customers when a suite names none: every reference names nobody. */
export const NOBODY: Customers = () => undefined;

/**
 * One `ThreadDeps`, with everything a suite did not ask for set to
 * something that refuses.
 */
export function threadDeps(overrides: Partial<ThreadDeps> = {}): ThreadDeps {
  return {
    db: refusing<pg.ClientBase>("Postgres"),
    dek: refusing<Dek>("the twin key"),
    twinId: FIXTURE_TWIN_ID,
    executionId: FIXTURE_EXECUTION_ID,
    hmacKey: new Uint8Array(32),
    trigger: FIXTURE_TRIGGER,
    bundle: notepadBundle(),
    embedder: { embed: () => Promise.reject(new Error("not called")) },
    selfChatJid: FIXTURE_SELF_CHAT,
    message: "¿qué me pidió la Sra. Garza la semana pasada?",
    messageId: FIXTURE_MESSAGE_ID,
    canvasBlock: "Nothing waits on the rep's dashboard right now.",
    repLanguage: DEFAULT_REP_LANGUAGE,
    timeZone: FIXTURE_ZONE,
    eventReceivedAt: FIXTURE_SEEN_AT,
    runtimeSeenAt: FIXTURE_SEEN_AT,
    draftTiming: new TurnDraftTiming(),
    draft: new HeldDraftSlot(),
    binding: new TurnBindingProposal(),
    served: new ServedHits(NOBODY),
    acts: new ActSlot(),
    ...overrides,
  };
}

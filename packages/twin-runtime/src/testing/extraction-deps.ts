/**
 * ONE `ExtractionDeps` FIXTURE FOR EVERY UNIT SUITE THAT BUILDS ONE (ticket
 * #196), in `thread-deps.ts`'s shape and for its reason.
 *
 * The type gained six fields when the three reads arrived — the connection,
 * the twin, twin memory, the embedder, the self-chat and this run's served
 * references — which is the moment a hand-built literal in each suite stops
 * being cheaper than one fixture.
 *
 * EVERY DEFAULT IS A REFUSAL, and that is the design — the same refusing
 * floor a stamped definition is built over (`refusingExtractionDeps`). A
 * suite that does not touch Postgres gets a client that throws on any query;
 * one that does not search gets an embedder that throws too. So a test
 * asserting something about the PROMPT cannot accidentally pass because a
 * stub returned an empty result set, and a test that needs a real store has
 * to say so by overriding it.
 *
 * NOT FOR THE INTEGRATION SUITES. They drive the daily pass, which builds the
 * real thing from a real claim on a real connection — the pre-agreed Postgres
 * seam (spec #18) — and a fixture there would be a second answer to "what an
 * extraction execution is built over".
 */
import type { ConversationRow } from "@dito/bundle";
import {
  refusingExtractionDeps,
  type ExtractionDeps,
} from "../extraction/deps.js";

/** The rep's own thread, in the fixture's world — the one chat a search may not reach. */
export const FIXTURE_SELF_CHAT = "5215550000@s.whatsapp.net";
/** The seat's zone, pinned so every rendered instant is exact. */
export const FIXTURE_ZONE = "America/Monterrey";
export const FIXTURE_TWIN_ID = "44444444-4444-4444-8444-444444444444";
/** The customer whose day the fixture is extracting. */
export const FIXTURE_CHAT = "5215559401@s.whatsapp.net";

function row(id: string, content: string, fromMe = false): ConversationRow {
  return {
    chatJid: FIXTURE_CHAT,
    messageId: id,
    senderJid: fromMe ? FIXTURE_SELF_CHAT : FIXTURE_CHAT,
    fromMe,
    occurredAt: "2026-09-04T18:00:00.000Z",
    content,
  };
}

/**
 * One `ExtractionDeps`, with everything a suite did not ask for set to
 * something that refuses.
 */
export function extractionDeps(
  overrides: Partial<ExtractionDeps> = {},
): ExtractionDeps {
  return {
    // THE REFUSING FLOOR IS THE SHIPPED ONE (`extraction/deps.ts`), so a
    // fixture and a stamped definition cannot disagree about what an
    // extraction is built over. What this adds is the fixture's own CONTENT.
    ...refusingExtractionDeps(),
    counterparty: "Ferreteria Fuentes",
    transcript: [row("WAMID-OLD", "buenas")],
    day: [row("WAMID-1", "me mandas 40 cajas"), row("WAMID-2", "va", true)],
    timeZone: FIXTURE_ZONE,
    twinId: FIXTURE_TWIN_ID,
    selfChatJid: FIXTURE_SELF_CHAT,
    ...overrides,
  };
}

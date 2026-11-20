/**
 * A BLANK THE TWIN LEAVES IN A DRAFT (ticket #342; spec #318; the spine's
 * movement 8, «Me falta un dato»; ADR-0037 as amended).
 *
 * When one fact the reply turns on is one only the rep has, the twin leaves a
 * blank rather than guessing: a marker in the body (`draftBlankMarker` in
 * `@dito/seam`) and a typed slot beside it — the key the marker names, a short
 * label in the twin's words and the one question it would ask the rep. Code
 * renders the slot (the card's capsule, the pill's question); the twin composed
 * every word of it when it drafted.
 *
 * THE ONE CHECK IS STRUCTURAL, and it is the only one (agentic first, Diego,
 * 2026-09-29): every marker in the body names a declared blank and every
 * blank's marker is in the body exactly once. Whether a blank was the right
 * call, and what it asks, is the twin's judgement and nothing here reads it.
 * A mismatch is FEEDBACK — the tool's own refusal pattern — so the model
 * calls again inside the budget it has.
 *
 * AND THE FILL is the same marker's other half: the body with one marker
 * replaced by the words the twin took from the rep's answer, and where those
 * words landed, so a card can wash them in.
 */
import {
  DRAFT_BLANK_CLOSE,
  DRAFT_BLANK_OPEN,
  draftBlankMarker,
  type TwinFeedDraftBlank,
  type TwinFeedDraftFill,
} from "@dito/seam";

/** One blank, as the draft part seals it. */
export type DraftBlank = TwinFeedDraftBlank;

/** Where a fill landed, as the draft part seals it. */
export type DraftFill = TwinFeedDraftFill;

/**
 * THE SHAPE A KEY THE MODEL COINS TAKES: a short lower-case identifier, so a
 * marker is something it can write back exactly.
 */
const SUBMITTED_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * THE SHAPE A STORED KEY TAKES: `b1`, `b2`… in the order the body marks them,
 * assigned by code (Codex r2). The model's own key is a word it chose — it
 * could be «laura_precio» — and the key is stored in the clear, in
 * `draft_blanks` and on a door row, where erasure does not reach. So code
 * renames every blank before anything is written, and the stores' CHECKs
 * hold this shape; what the blank is about stays in its sealed label.
 */
export const BLANK_KEY_PATTERN = /^b[1-9][0-9]{0,2}$/;

/** Every marker in a body whose brackets pair, its key captured. */
const MARKER = new RegExp(`${DRAFT_BLANK_OPEN}([^${DRAFT_BLANK_OPEN}${DRAFT_BLANK_CLOSE}]*)${DRAFT_BLANK_CLOSE}`, "gu");

/** The blanks' schema, as both drafting tools declare it. */
export const BLANKS_SCHEMA = {
  type: ["array", "null"],
  description: `The facts only the rep has that this draft leaves blank, or null when it leaves none. Each one stands in the text as ${draftBlankMarker("key")} — its key between those two brackets, exactly once — where the fact goes.`,
  items: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "A short lower-case identifier for the blank, letters, digits and underscores: what the marker in the text names.",
      },
      label: {
        type: "string",
        description:
          "What is missing, in one or two words of the conversation's language, as the rep will see it inside the blank.",
      },
      question: {
        type: "string",
        description:
          "The one question you would ask the rep for this fact, in their language, with what you already know that helps them answer.",
      },
    },
    required: ["key", "label", "question"],
    additionalProperties: false,
  },
} as const;

/** What reading a call's blanks against its body came to. */
export type BlanksRead =
  | {
      readonly ok: true;
      /** The blanks in the order the body marks them, each under its stored key. */
      readonly blanks: readonly DraftBlank[];
      /** The body with every marker renamed to its stored key. */
      readonly body: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The blanks a call declared, read from `unknown` and paired with the
 * body's markers — or why they do not pair — renamed to the keys code stores
 * (`BLANK_KEY_PATTERN`).
 */
export function readBlanks(input: unknown, body: string): BlanksRead {
  const declared: DraftBlank[] = [];
  if (input !== undefined && input !== null) {
    if (!Array.isArray(input)) return refused("blanks is a list, or null");
    for (const one of input as unknown[]) {
      const slot = slotOf(one);
      if ("reason" in slot) return refused(slot.reason);
      if (declared.some((held) => held.key === slot.key)) {
        return refused(`two blanks carry the key "${slot.key}": each key names one blank`);
      }
      declared.push(slot);
    }
  }
  const marked = markersIn(body);
  if ("reason" in marked) return refused(marked.reason);
  for (const key of marked.keys) {
    if (!declared.some((blank) => blank.key === key)) {
      return refused(
        `the text carries ${draftBlankMarker(key)} and no blank has the key "${key}": declare it in blanks, or write the fact out`,
      );
    }
  }
  for (const blank of declared) {
    const times = marked.keys.filter((key) => key === blank.key).length;
    if (times !== 1) {
      return refused(
        `the blank "${blank.key}" stands in the text ${String(times)} time(s): write ${draftBlankMarker(blank.key)} exactly once, where the fact goes`,
      );
    }
  }
  // EVERY MARKER IS A DECLARED BLANK'S AND EACH APPEARS ONCE, so the marked
  // order is the blanks' order: the first marker becomes `b1`.
  // ONE PASS, so a model key that happens to read `b2` cannot collide with a
  // name another blank is given.
  const stored = new Map(marked.keys.map((key, at) => [key, `b${String(at + 1)}`] as const));
  const blanks = marked.keys.map((key) => ({ ...declared.find((blank) => blank.key === key)!, key: stored.get(key)! }));
  const renamed = body.replace(MARKER, (_whole, key: string) => draftBlankMarker(stored.get(key)!));
  return { ok: true, blanks, body: renamed };
}

/** One declared slot, or why it is not one. */
function slotOf(value: unknown): DraftBlank | { readonly reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "each blank is an object with key, label and question" };
  }
  const given = value as Record<string, unknown>;
  const key = given["key"];
  if (typeof key !== "string" || !SUBMITTED_KEY_PATTERN.test(key)) {
    return {
      reason: `a blank's key is a short lower-case identifier — letters, digits and underscores, starting with a letter — and ${JSON.stringify(key)} is not one`,
    };
  }
  const label = given["label"];
  if (typeof label !== "string" || label.trim() === "") {
    return { reason: `the blank "${key}" needs a label: what is missing, in a word or two` };
  }
  const question = given["question"];
  if (typeof question !== "string" || question.trim() === "") {
    return { reason: `the blank "${key}" needs the question you would ask the rep for it` };
  }
  return { key, label: label.trim(), question: question.trim() };
}

/**
 * Every marker's key in the body, in order — or why the brackets do not pair.
 * A bracket with no partner is refused rather than read as text: it is a
 * marker the model half-wrote, and sent as text it would reach the customer.
 */
function markersIn(body: string): { readonly keys: readonly string[] } | { readonly reason: string } {
  const keys: string[] = [];
  let at = 0;
  for (;;) {
    const open = body.indexOf(DRAFT_BLANK_OPEN, at);
    const stray = body.indexOf(DRAFT_BLANK_CLOSE, at);
    if (open === -1) {
      if (stray !== -1) return { reason: `the text carries a ${DRAFT_BLANK_CLOSE} that closes no blank` };
      return { keys };
    }
    if (stray !== -1 && stray < open) {
      return { reason: `the text carries a ${DRAFT_BLANK_CLOSE} that closes no blank` };
    }
    const close = body.indexOf(DRAFT_BLANK_CLOSE, open + DRAFT_BLANK_OPEN.length);
    const nested = body.indexOf(DRAFT_BLANK_OPEN, open + DRAFT_BLANK_OPEN.length);
    if (close === -1 || (nested !== -1 && nested < close)) {
      return { reason: `the text carries a ${DRAFT_BLANK_OPEN} that opens no blank: write each one as ${draftBlankMarker("key")}` };
    }
    keys.push(body.slice(open + DRAFT_BLANK_OPEN.length, close));
    at = close + DRAFT_BLANK_CLOSE.length;
  }
}

/** The body with one blank's marker replaced by `value`, and where the value landed. */
export function fillBody(
  body: string,
  key: string,
  value: string,
): { readonly body: string; readonly start: number; readonly end: number } | undefined {
  const marker = draftBlankMarker(key);
  const start = body.indexOf(marker);
  if (start === -1) return undefined;
  return {
    body: `${body.slice(0, start)}${value}${body.slice(start + marker.length)}`,
    start,
    end: start + value.length,
  };
}

/** Whether words carry either bracket — a value the fill would turn into half a marker. */
export function carriesMarker(text: string): boolean {
  return text.includes(DRAFT_BLANK_OPEN) || text.includes(DRAFT_BLANK_CLOSE);
}

function refused(reason: string): BlanksRead {
  return { ok: false, reason };
}

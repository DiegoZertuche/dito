/**
 * A DELICATE DRAFT AND ITS REASON (ticket #343; spec #318; the spine's
 * movement 11, «Antes de que la mandes»; ADR-0037 as amended).
 *
 * A draft that commits the rep to something — a price below list, a delivery
 * date, an apology — is marked delicate by the twin, which writes beside it
 * what it decided and why, in two sentences at most. The rep reads that reason
 * in the pill while resting on Enviar, before the tap. The twin composed every
 * word when it drafted; code decides only when the pill raises it.
 *
 * THE CHECK IS STRUCTURAL, and it is the only one (agentic first, Diego,
 * 2026-09-29): the flag and the reason come together or not at all, and the
 * reason fits the pill. Whether a draft commits the rep is the twin's
 * judgement and nothing here reads it. A refusal is FEEDBACK — the drafting
 * tool's own pattern — so the model calls again inside its budget.
 *
 * NO STORE OF ITS OWN. The flag and the reason are sealed in the draft part
 * (`DraftPart` in `posts.ts`), with the twin's other words: the rep reads
 * them, the twin reads them back through `read_post`, and nothing else does —
 * the send lock never asks whether a draft is delicate, so nothing needs them
 * in the clear.
 */

/**
 * THE MOST SENTENCES A REASON RUNS: the ticket's «two sentences at most» —
 * what the twin decided, and why. Counted by `Intl.Segmenter`'s sentence
 * breaks, which read a figure's decimal point («$172.50») as no end.
 */
export const REASON_MAX_SENTENCES = 2;

/**
 * THE MOST CHARACTERS A REASON RUNS, counted in code points. The pill's line is
 * 15 px over a panel about 640 px wide, some 80 characters to a line, and the
 * spine raises the reason «in two lines»; 300 is two full sentences with room
 * for a figure and a name, and the prototype's own reason (173 characters,
 * an offer to change it included) sits well inside. Past it the risen pill
 * covers the card the rep is about to send.
 */
export const REASON_MAX_CHARS = 300;

/** The two fields' schemas, as both drafting tools declare them. */
export const DELICATE_SCHEMA = {
  type: ["boolean", "null"],
  description:
    "True when this draft commits the rep to something they would want to weigh before it goes — a price below list, a delivery date, an apology are examples; you judge. Null or false otherwise.",
} as const;

export const REASON_SCHEMA = {
  type: ["string", "null"],
  description: `When delicate is true: what you decided in this draft and why, in the rep's language, in ${String(REASON_MAX_SENTENCES)} sentences at most and under ${String(REASON_MAX_CHARS)} characters. Null otherwise.`,
} as const;

/** A delicate draft's two fields, as the draft part seals them. */
export interface DraftDelicacy {
  readonly delicate: true;
  readonly reason: string;
}

/** What reading a call's flag and reason came to. */
export type DelicacyRead =
  | { readonly ok: true; readonly delicacy?: DraftDelicacy }
  | { readonly ok: false; readonly refused: string };

/** The flag and the reason a call declared, read from `unknown`, paired and bounded — or why not. */
export function readDelicacy(delicate: unknown, reason: unknown): DelicacyRead {
  if (delicate !== undefined && delicate !== null && typeof delicate !== "boolean") {
    return refused("delicate is true, false or null");
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return refused("reason is text, or null");
  }
  const written = typeof reason === "string" ? reason.trim() : "";
  if (delicate !== true) {
    if (written === "") return { ok: true };
    return refused(
      "reason is written and delicate is not true: a reason goes only with a delicate draft — set delicate true, or leave reason null",
    );
  }
  if (written === "") {
    return refused(
      "delicate is true and reason is empty: a delicate draft carries the reason the rep reads before sending it",
    );
  }
  const sentences = sentencesIn(written);
  if (sentences > REASON_MAX_SENTENCES) {
    return refused(
      `reason runs ${String(sentences)} sentences: write it in two at most — what you decided, and why`,
    );
  }
  const characters = [...written].length;
  if (characters > REASON_MAX_CHARS) {
    return refused(
      `reason runs ${String(characters)} characters: keep it under ${String(REASON_MAX_CHARS)} — two short sentences`,
    );
  }
  return { ok: true, delicacy: { delicate: true, reason: written } };
}

/** How many sentences the text runs, by the platform's own sentence breaks. */
function sentencesIn(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  return [...segmenter.segment(text)].filter((one) => one.segment.trim() !== "").length;
}

function refused(why: string): DelicacyRead {
  return { ok: false, refused: why };
}

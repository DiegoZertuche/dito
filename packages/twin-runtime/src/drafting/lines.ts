/**
 * HOW A STORED MESSAGE READS TO THE MODEL — one renderer, three readers
 * (ticket #172).
 *
 * The recent transcript, the retrieved memories and whatever
 * `search_memory` returns are all the same thing: rows out of twin memory,
 * shown to a model that has to tell who said what. Three renderings of that
 * would be three ways for the same message to look, and the model would
 * spend attention reconciling them — which is the argument `now.ts` already
 * makes about two date formats in one prompt.
 *
 * `rep` AND `counterparty`, NOT NAMES. The line says which SIDE spoke and
 * never who they are: the counterparty's name is one part's job
 * (`chat_binding`) and saying it on every line would teach the model to
 * write it, which is the one thing a provisional name must not become. It is
 * also what the drafting prompt has always done, so the transcript the model
 * reads is unchanged.
 */
import type { ConversationRow } from "@dito/bundle";
import { renderTurnInstant } from "@dito/execution";

/** One row, as the model reads it. */
function line(row: ConversationRow): string {
  return `${row.fromMe ? "rep" : "counterparty"}: ${row.content}`;
}

/** A run of rows, oldest first, one per line. */
export function renderTranscriptLines(
  rows: readonly ConversationRow[],
): string {
  return rows.map(line).join("\n");
}

/**
 * A SEARCH's hits — the same line, with the instant in front of it (ticket
 * #172; Codex r1 and the two-axis review's Spec axis, independently).
 *
 * WHY THESE CARRY A DATE AND THE TWO CONTEXT BLOCKS DO NOT. The recent
 * transcript and the retrieved memories are the harness's own two blocks,
 * preserved line for line because the ticket's first acceptance criterion is
 * that nothing about what the model already reads changes. The SEARCH is
 * new, and it exists to reach further BACK than either of them — the promise
 * made last month is the case it was cut for — so a hit with no date is a
 * hit the model cannot place against the «now» it was handed. The tool's
 * declaration says `occurred_at` and its description promises "when it was
 * sent"; without this the declaration and the digest attested to a
 * projection the tool did not serve.
 *
 * `renderTurnInstant` IS THE ONE FORMATTER, which is #139's own rule: one
 * rendering for the turn header, every extraction beat and every
 * automation's «now» part, "so no two of them can disagree about a date".
 * English bracketed metadata, in the seat's zone, so it cannot be mistaken
 * for anybody's speech.
 */
export function renderSearchHits(
  rows: readonly ConversationRow[],
  timeZone: string,
): string {
  return rows
    .map(
      (row) =>
        `[${renderTurnInstant(new Date(row.occurredAt), timeZone)}] ${line(row)}`,
    )
    .join("\n");
}

/**
 * The turn's own messages, NUMBERED and with no speaker.
 *
 * DIFFERENT ON PURPOSE, and it is #75's own rule: the two blocks must not be
 * confusable, so the SHAPE of a line says which block it belongs to even
 * out of context. Every message here is the counterparty's — the turn is
 * counterparty inbound by construction — so a speaker would be a column with
 * one value, and the numbers are what let the model see it is answering
 * three things rather than one.
 */
export function renderTurnLines(rows: readonly ConversationRow[]): string {
  return rows.map((row, at) => `${at + 1}. ${row.content}`).join("\n");
}

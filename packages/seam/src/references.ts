/**
 * THE GRAMMAR OF THE TWIN'S PROSE THAT A SURFACE CUTS (tickets #321, #401), on
 * its own so the dashboard's client code can cut prose with it: this module
 * imports nothing, and `@dito/seam/references` brings nothing else into a
 * browser bundle. The runtime (`thread/references.ts`) and the page
 * (`prose.ts`) both cut with these patterns, so the two never disagree on
 * where a reference or a mark ends.
 */

/**
 * A REFERENCE AS THE TWIN WRITES IT IN PROSE, as a fresh pattern (a `g` regex
 * keeps state): `[c7]`. Group 1 is the reference's number.
 */
export function referenceInProse(): RegExp {
  return /\[c(\d+)\]/gu;
}

/**
 * A MARK: WORDS OF THE TWIN'S THAT MEAN ONE OF ITS CARDS, as a fresh pattern —
 * `[the words](<post id>)`, the words free to hold a reference, so a name is
 * `[[c7]](<post id>)` (ticket #401; Diego, 2026-10-13: which card words open,
 * and where the twin's mark goes as the line plays, is the twin's choice, never
 * code's). Group 1 is the words, group 2 the card the twin wrote.
 *
 * The card is whatever the twin wrote between the parentheses, angle brackets
 * and spaces around it dropped — so a placeholder copied as written still
 * parses as a mark (Codex r4) — and one that is no card on the canvas renders
 * as the words alone: rendering, never a refusal.
 */
export function markInProse(): RegExp {
  return /\[((?:[^[\]]|\[c\d+\])+)\]\(\s*<?\s*([^()<>]{1,80}?)\s*>?\s*\)/gu;
}

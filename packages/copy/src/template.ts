/**
 * A TEMPLATE AND ITS RENDERER (ticket #219 AC 1; spec #214 decision 13;
 * ADR-0022, ADR-0037 as amended).
 *
 * A template is code-owned chrome: a subject and a body that may label, name
 * or explain, with holes for the few values an occasion binds. It states
 * nothing about the rep's record — ADR-0037's amendment is what permits a
 * fixed sentence here at all, and its limit is the reason the slot types are
 * six bounded things rather than a parameter bag.
 *
 * PARSED ONCE, THEN JOINED — never `String.replace` over the finished text.
 * Two failures follow from replacing: a value containing `{url}` would be
 * read as a second hole and filled, so a caller who controls one slot could
 * reach another; and a value containing `$&` would be read as a replacement
 * pattern. Segments make both impossible by construction rather than by
 * escaping, which is the same argument `stringLiterals`' hand-written
 * scanner makes one package over.
 *
 * BOTH DIRECTIONS ARE CHECKED, which is this repo's convention for anything
 * that is a record (`fr73-shared-stores.ts`, the composed-language
 * allowlist): every hole in the text must be a declared slot, and every
 * declared slot must appear in the text. A declared slot no hole uses is a
 * caller passing a value nobody renders — which is how a message quietly
 * stops carrying the thing its caller believes it carries.
 */
import {
  acceptsSlotValue,
  renderSlotValue,
  SLOT_TYPES,
  type SlotType,
  type SlotValue,
} from "./slots.js";

/** Every refusal this package makes. One type: a caller either gets the message or does not. */
export class CopyError extends Error {
  override readonly name = "CopyError";
}

/** One template: what it is called, what it says, and what it may be handed. */
export interface CopyTemplate {
  /** The catalog key. `@dito/notify` binds a message type to one of these. */
  readonly key: string;
  readonly subject: string;
  readonly body: string;
  /** Slot name → type. The record of what an occasion may bind. */
  readonly slots: Readonly<Record<string, SlotType>>;
}

/** A rendered message: the two things an email needs and nothing else. */
export interface RenderedCopy {
  readonly subject: string;
  readonly body: string;
}

/** How an occasion binds a template's slots. */
export type SlotValues = Readonly<Record<string, SlotValue>>;

/** What a render may need beyond the values. */
export interface RenderOptions {
  /**
   * The zone an `instant` slot is rendered in — the rep's own.
   *
   * REQUIRED EXACTLY WHEN A TEMPLATE DECLARES AN INSTANT, and absent
   * otherwise: see `renderSlotValue`'s header for why there is no default.
   */
  readonly timeZone?: string;
}

/** `{slot}` — the one hole syntax, and a slot name is an identifier. */
const HOLE = /\{([A-Za-z][A-Za-z0-9_]*)\}/gu;

/** One piece of a parsed template: fixed text, or a slot to fill. */
type Segment = { readonly text: string } | { readonly slot: string };

/**
 * One template's text as segments, or a refusal.
 *
 * A LONE `{` OR `}` IS A REFUSAL rather than literal text. A template is
 * written by hand into this package's source, so a brace the author meant
 * as a hole and mistyped is the likely case by far — and rendering it as
 * text would put `{nombre}` in a rep's inbox and fail nothing.
 */
function segments(text: string, where: string): Segment[] {
  const found: Segment[] = [];
  let at = 0;
  for (const match of text.matchAll(HOLE)) {
    const start = match.index;
    if (start > at) found.push({ text: text.slice(at, start) });
    found.push({ slot: match[1]! });
    at = start + match[0].length;
  }
  if (at < text.length) found.push({ text: text.slice(at) });
  for (const segment of found) {
    if (!("text" in segment)) continue;
    if (/[{}]/u.test(segment.text)) {
      throw new CopyError(
        `${where}: a brace that is not a \`{slot}\` hole — write the hole, or take the brace out`,
      );
    }
  }
  return found;
}

/** Every slot name one template's subject and body use, in first-seen order. */
function holesOf(template: CopyTemplate): string[] {
  const seen: string[] = [];
  for (const [where, text] of [
    ["subject", template.subject],
    ["body", template.body],
  ] as const) {
    for (const segment of segments(text, `${template.key}.${where}`)) {
      if ("slot" in segment && !seen.includes(segment.slot)) seen.push(segment.slot);
    }
  }
  return seen;
}

/**
 * One template, checked against itself — the shape a registry runs over
 * every entry it holds at construction, so a malformed template fails at
 * import rather than at the one send that needed it.
 */
export function checkTemplate(template: CopyTemplate): void {
  if (template.key.trim() === "") {
    throw new CopyError("a template with no key");
  }
  for (const [slot, type] of Object.entries(template.slots)) {
    if (!SLOT_TYPES.includes(type)) {
      throw new CopyError(
        `${template.key}: slot \`${slot}\` declares the type \`${type}\`, which is not one of ${SLOT_TYPES.join(", ")}`,
      );
    }
  }
  const holes = holesOf(template);
  const declared = Object.keys(template.slots);
  for (const hole of holes) {
    if (!declared.includes(hole)) {
      throw new CopyError(
        `${template.key}: the text fills \`{${hole}}\`, which no slot declares`,
      );
    }
  }
  for (const slot of declared) {
    if (!holes.includes(slot)) {
      throw new CopyError(
        `${template.key}: slot \`${slot}\` is declared and never rendered`,
      );
    }
  }
}

/**
 * One message, rendered from a complete, typed slot set — or a refusal.
 *
 * THE REFUSAL IS THE FEATURE. Every caller of this function is about to put
 * text in front of a person over a channel that has no undo, so the three
 * ways a slot set can be wrong — a slot missing, a slot nobody declared, a
 * value of the wrong shape — are all refusals with the slot named, and none
 * of them renders a partial message.
 */
export function renderTemplate(
  template: CopyTemplate,
  values: SlotValues,
  options: RenderOptions = {},
): RenderedCopy {
  checkTemplate(template);
  const declared = Object.entries(template.slots);
  for (const passed of Object.keys(values)) {
    if (!(passed in template.slots)) {
      throw new CopyError(
        `${template.key}: no slot \`${passed}\` — this template takes ${declared.length === 0 ? "none" : declared.map(([slot]) => slot).join(", ")}`,
      );
    }
  }
  for (const [slot, type] of declared) {
    if (!(slot in values)) {
      throw new CopyError(`${template.key}: slot \`${slot}\` was not given a value`);
    }
    if (!acceptsSlotValue(type, values[slot]!)) {
      throw new CopyError(
        `${template.key}: slot \`${slot}\` was given a value its type \`${type}\` does not accept`,
      );
    }
    if (type === "instant" && options.timeZone === undefined) {
      throw new CopyError(
        `${template.key}: slot \`${slot}\` is an instant and no time zone was given — an instant has no default zone`,
      );
    }
  }
  const fill = (text: string, where: string): string =>
    segments(text, `${template.key}.${where}`)
      .map((segment) =>
        "text" in segment
          ? segment.text
          : renderSlotValue(values[segment.slot]!, options.timeZone),
      )
      .join("");
  return {
    subject: fill(template.subject, "subject"),
    body: fill(template.body, "body"),
  };
}

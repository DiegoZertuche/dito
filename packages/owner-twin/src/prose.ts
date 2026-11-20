/**
 * The two text rules this package shares (ticket #130).
 *
 * ONE SLOT GRAMMAR, ONE FOLD, and both are here because three modules read
 * each of them: the guard refuses prose that types a value, the renderer
 * fills the slots that value should have been in, and the context rendering
 * kills the slots of an earlier turn. `guard.ts` argues that "the guard
 * cannot drift from the renderer" — a regular expression written out three
 * times is exactly the drift that argument forbids.
 */

/**
 * A slot: where the model says a value goes, and code puts one.
 *
 * DOUBLE BRACKETS AROUND A BARE NUMBER, because the model has to be able to
 * write it without escaping anything and a reader of a stored answer has to
 * be able to see it. The digits inside a slot are not a number the model
 * typed — they are the reference — so every sweep over "what the model
 * wrote" runs over prose with the slots taken out.
 *
 * A FUNCTION AND NOT A CONSTANT, because a `g` regular expression carries
 * `lastIndex` between calls: one shared instance used by both `matchAll`
 * and `test` is a stateful global that answers differently on alternate
 * calls.
 */
export function slotPattern(): RegExp {
  return /\[\[(\d+)\]\]/g;
}

/** The references a piece of prose says it will have filled, in order. */
export function slotReferences(prose: string): readonly number[] {
  return [...prose.matchAll(slotPattern())].map((match) => Number(match[1]));
}

/** ...and the prose with every slot removed, which is what the model TYPED. */
export function typedProse(prose: string): string {
  return prose.replace(slotPattern(), " ");
}

/**
 * Case- and accent-insensitive, the way a person types a name.
 *
 * THE SAME FOLD AS `owner-reads.ts`'S AND `answering.ts`'S, and this is the
 * third place in the repo it appears — which is recorded on #129 and on
 * this ticket rather than fixed here, because the fix is a package below
 * all three and inventing a fourth normalization would be worse than any of
 * them. What this file does hold is the rule that it appears ONCE inside
 * this package: the seat resolution and the guard's name sweep have to
 * agree about what "the same name" is, or a name the tools resolved is one
 * the guard would not recognise in prose.
 */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

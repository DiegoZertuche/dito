/**
 * THE DAILY DISCLOSURE'S SLOT GRAMMAR (tickets #173, #321; ADR-0037 as
 * amended).
 *
 * A slot is where the model says a value goes and code puts one. The
 * disclosure's composer writes the day's opening and closing in its own
 * words; a customer's name is a value the record holds, so it travels as
 * `[[N]]` — a number the execution's own served map hands it — and the
 * renderer folds in the name.
 *
 * ONE EXECUTION, ONE MESSAGE, AND THAT IS WHY A PER-RUN NUMBER IS ENOUGH
 * HERE. The disclosure composes one post from one served map and nothing
 * reads its numbers again, so they mean one thing for as long as they exist.
 * The twin thread speaks all day in one session, where a number minted per
 * turn would name two customers by the evening — so it names customers by
 * their stable references instead (`thread/references.ts`), and this grammar
 * is the disclosure's alone.
 *
 * DOUBLE BRACKETS AROUND A BARE NUMBER, WHICH IS THE OWNER SIDE'S OWN
 * GRAMMAR (`packages/owner-twin/src/prose.ts`): two spellings of the same
 * idea would be one more thing a reader of a stored post has to learn. The
 * digits inside a slot are not a number the model typed — they are a
 * reference — so every sweep over "what the model wrote" runs over prose with
 * the slots removed.
 *
 * WHY IT IS COPIED AND NOT IMPORTED. `@dito/owner-twin` is on the far side of
 * the wall and this package may not depend on it (ADR-0002; the dependency
 * wall test). Recorded as a remainder on #173.
 */

/**
 * A slot, as a fresh pattern.
 *
 * A FUNCTION AND NOT A CONSTANT, because a `g` regular expression carries
 * `lastIndex` between calls: one shared instance used by both `matchAll` and
 * `test` is a stateful global that answers differently on alternate calls
 * (the owner side's own note).
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
 * The prose with every slot replaced by the value its reference names.
 *
 * WHAT «CODE RENDERS THE VALUE» MEANS, concretely (ADR-0037 as amended). The
 * twin wrote the sentence and said where a name goes; this is the step that
 * puts the name there — the one the rep reads, resolved rep-side from what
 * the search served, never a string model text produced.
 *
 * AN UNRESOLVED SLOT CANNOT REACH HERE. The guard refuses a slot naming a
 * reference this run did not serve (`disclosure/guard.ts`), so every slot has a value by
 * the time anything renders; `fill` returning `undefined` would mean the
 * guard and the renderer disagree, and leaving the slot in the prose would
 * turn that disagreement into a rep reading `[[2]]`. So it throws, at the one
 * seam where the two halves meet.
 */
export function foldSlots(
  prose: string,
  fill: (ref: number) => string | undefined,
): string {
  return prose.replace(slotPattern(), (slot, digits: string) => {
    const value = fill(Number(digits));
    if (value === undefined) {
      throw new Error(
        `the answer carries the slot ${slot}, which nothing served this turn can fill — the guard should have refused it (ticket #173)`,
      );
    }
    return value;
  });
}

/**
 * The slot as the instructions show it, so the grammar is written down once.
 *
 * A CONSTANT RATHER THAN A LITERAL IN THE PROMPT, for the reason the guard's
 * label is: what the model is TOLD to write and what the renderer reads have
 * to be the same shape, and a prompt spelling it `[[n]]` while the pattern
 * matched `[[1]]` would refuse every well-meant answer. `N` is a placeholder
 * inside a placeholder, which is why it is not a number.
 */
export const SLOT_EXAMPLE = "[[N]]";

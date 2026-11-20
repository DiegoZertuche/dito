/**
 * WHAT A KIND CLASSIFICATION IS SHOWN, AS RECIPES (ticket #176; spec #171
 * decision 26: "Context: `now`, the chat's recent messages, the name").
 *
 * Two parts beside the runtime's `now`, and both render from `deps` rather
 * than from a parameter — see `deps.ts` for why a conversation cannot be one.
 * The harness composed one user turn out of both; splitting them into named
 * parts is what makes the diff readable ("the name part changed") and what
 * the digest stamps.
 *
 * THE ORDER IS THE SPEC'S. `now` first, because it is framing rather than
 * material; then the NAME, because the name usually settles it and the
 * instructions say so; then the conversation, which is what the model reads
 * when the name does not settle it.
 *
 * EVERY PART SAYS WHEN IT HAS NOTHING, rather than vanishing. A chat with no
 * history is the ordinary case for a binding confirmed off a first message,
 * and a model shown no conversation block could not tell "this chat has no
 * history" from "nobody looked" — the same silence-about-an-absence the
 * drafting recipes argue against.
 */
import type { NamedPart, RecipeRegistry } from "@dito/execution";
import type { EntityKindDeps } from "./deps.js";
import { renderConversationWindow } from "./lines.js";

export const THE_NAME_RECIPE = "the_name";
export const RECENT_MESSAGES_RECIPE = "recent_messages";

/**
 * THE NAME THE REP CONFIRMED (spec #171 decision 26: "the name").
 *
 * IT IS THE REP'S OWN WORD, and the part says so, because that is what makes
 * it usable evidence: the rep was shown a name the rail supplied and said
 * yes to it (#34), so a business name here was chosen by a person rather
 * than guessed by a phone book.
 */
const theName = (deps: EntityKindDeps) => (): NamedPart => ({
  name: "the customer's name",
  text: `The customer's name, as the rep confirmed it: ${deps.displayName}`,
});

/**
 * THE CHAT'S OWN WORDS (spec #171 decision 26: "the chat's recent
 * messages"), windowed at both ends by `lines.ts`.
 */
const recentMessages = (deps: EntityKindDeps) => (): NamedPart => {
  const window = renderConversationWindow(deps.conversation);
  return {
    name: "the conversation",
    text:
      window ??
      "There is no conversation with this customer yet — decide from the name.",
  };
};

/**
 * The two, by name, as the engine's one recipe registry renders them for an
 * entity-kind turn (`runs/conversation.ts`).
 *
 * A CONSTANT, NEVER A GLOBAL ANYTHING WRITES INTO — the rule `registry.ts`
 * states. Every entry is a factory, so the value holds no execution's data
 * and two concurrent classifications share nothing but the code.
 */
export const ENTITY_KIND_RECIPES: RecipeRegistry<EntityKindDeps> = Object.freeze(
  {
    [THE_NAME_RECIPE]: { parameters: {}, create: theName },
    [RECENT_MESSAGES_RECIPE]: { parameters: {}, create: recentMessages },
  },
);

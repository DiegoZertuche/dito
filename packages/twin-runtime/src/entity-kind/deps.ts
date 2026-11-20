/**
 * WHAT ONE KIND CLASSIFICATION IS BUILT OVER (ticket #176; spec #171
 * decisions 9 and 26).
 *
 * The smallest deps in the repo, and that is the shape of the occasion
 * rather than an omission: the classification decides one thing about one
 * customer from two inputs — the name the rep confirmed, and that chat's own
 * words — and it has no tool, no connection and nothing to write. Everything
 * it reaches for is here, and there is nothing else it could reach.
 *
 * NO BUNDLE AND NO CONNECTION, which is the difference from the drafting and
 * thread deps beside it. Those hold the bundle because their tools search it
 * live; this classification has no tools, so the conversation
 * is READ AND RENDERED BEFORE IT GETS HERE — through the one gesture
 * renderer (#97), by the caller, exactly as the harness did it. Recipes are
 * synchronous, and a bundle here would be a reach nothing uses.
 *
 * WHY THE CONVERSATION IS NOT A PARAMETER. `ParameterValue` is scalar by
 * design: "a parameter rich enough to be an object would be content
 * travelling under the name of a parameter" (`registry.ts`). A conversation
 * is a list of messages, so it cannot be one and should not try to be — what
 * a spec declares is a recipe's NAME and the SHAPE of what varies.
 */
import type { ConversationRow } from "@dito/bundle";

/** What one kind classification's parts are built over. */
export interface EntityKindDeps {
  /**
   * The entity's name as the REP confirmed it at the binding — usually the
   * rail's push-name, and never a name model text produced (#34's decision
   * 1). It is the input the name-settles-it rule turns on.
   */
  readonly displayName: string;
  /**
   * That chat's messages, oldest first, gestures already composed against
   * twin memory as it stands (#97) and unreadable deliveries already
   * carrying their code-rendered placeholder (ADR-0042). May be empty: a
   * chat whose history the bundle has not got is judged from the name alone
   * rather than refused, which is the harness's own rule and is why the
   * recipe says so out loud.
   */
  readonly conversation: readonly ConversationRow[];
  /**
   * The seat's IANA zone, resolved by the caller — what the «now» part is
   * rendered in.
   *
   * REQUIRED HERE THOUGH IT IS OPTIONAL ON THE RUNTIME'S DEPS, for the
   * reason the drafting deps give: unset on the runtime means the host
   * clock, and the resolution happens once at the caller so nothing
   * downstream can disagree about an hour (#139).
   */
  readonly timeZone: string;
}

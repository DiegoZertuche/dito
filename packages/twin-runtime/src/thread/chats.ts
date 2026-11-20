/**
 * FROM A NAME THE REP TYPED TO CHATS THE REP CONFIRMED (ticket #175; spec
 * #171 decision 5; ADR-0004 — the entity mirror is the only place bindings
 * exist).
 *
 * ONE FOLD, TWO CALLERS, and that is why this is its own module rather than
 * a private function in either of them. The search's `counterparty` narrows
 * to one chat when exactly one matches; `resolve_chat` hands the whole set
 * back so two of them can become the ask. Those are two READINGS of one
 * resolution, and two implementations would be two chances for the twin to
 * scope a search to a chat it would then refuse to draft for.
 *
 * THE MATCH IS BY WHOLE WORDS, and this is the decision the ticket asked to
 * be made and recorded. A name matches when the folded strings are EQUAL, or
 * when the typed words appear as a contiguous run of whole words inside the
 * confirmed name — so «Torres» finds «Torres Hermanos» and «Juan Torres»,
 * and «Torr» finds neither.
 *
 * IT WAS EXACT-ONLY FIRST, AND THE ASK IS WHY IT IS NOT (Codex round 1,
 * finding 2). Under exact matching the only way two chats can match one name
 * is for both to be confirmed under the SAME name — so every ask this ticket
 * can produce reads «¿Torres o Torres?», with nothing in it the rep can use
 * to choose. That fails ADR-0039's own test: a «si» has to leave a
 * meaningful record, and a choice between two identical labels is one the
 * rep cannot make. Matching whole words is what makes the ordinary
 * ambiguity — «Torres Hermanos» and «Juan Torres» — a question with two
 * distinguishable answers.
 *
 * WHAT IT COSTS THE SEARCH, stated rather than hidden. `search_memory`'s
 * `counterparty` keeps its rule exactly — one match scopes, anything else
 * runs unscoped — and what changed is which names have one match: a rep who
 * writes «lo de Torres» now narrows to the one Torres chat instead of
 * searching everything. That is narrower than the rep asked for only if they
 * meant a different Torres, in which case there are two and it stays
 * unscoped.
 *
 * SUBSTRINGS ARE NOT MATCHES, which is what keeps this from being a guess.
 * The typed words must line up on word boundaries, so «Tor» matches nothing
 * and «Hermanos» matches «Torres Hermanos» — the rep is naming somebody, not
 * searching.
 *
 * WHAT IS NOT HERE, and why (recorded on the ticket). An UNBOUND chat whose
 * push-name folds equal is invisible to this module, so the twin cannot tell
 * «I have no chat by that name» from «I have one, and you never confirmed
 * who it is»; distinguishing them needs an enumeration of the rep's chats
 * that twin memory does not offer and nothing else wants.
 */
import type { Bundle } from "@dito/bundle";


/**
 * One chat a typed name resolved to — the binding's three identifying
 * fields, which is what a candidate is made of.
 *
 * `confirmedAt` IS LEFT BEHIND deliberately: when the ceremony happened is a
 * fact about the BINDING, and a candidate is a choice the rep is being
 * offered now.
 */
export interface ChatCandidate {
  readonly chatJid: string;
  readonly entityId: string;
  /** The name the rep confirmed — what the model is shown, as a ref's label. */
  readonly displayName: string;
}

/**
 * Every chat of the rep's whose CONFIRMED name is this one, in the mirror's
 * own order (chat order) — empty when none is.
 *
 * BOUND CHATS ONLY, which is the projection ADR-0004 allows and the safety
 * this ticket needs: `create_draft` writes to a chat this resolution served,
 * so a chat nobody confirmed can never be a destination, and «(sin
 * confirmar)» can never appear in a rep-initiated Borrador's frame.
 */
export function resolveChatCandidates(
  bundle: Bundle,
  name: string,
): readonly ChatCandidate[] {
  const wanted = foldWords(name);
  // An empty name matches nothing rather than everything: the alternative
  // is a call with a blank parameter offering the rep every chat they have.
  if (wanted.length === 0) return [];
  return bundle
    .listChatBindings()
    .filter((binding) => namesTheSame(wanted, foldWords(binding.displayName)))
    .map((binding) => ({
      chatJid: binding.chatJid,
      entityId: binding.entityId,
      displayName: binding.displayName,
    }));
}

/**
 * WHAT A CUSTOMER'S CHAT LOOKS LIKE TO THE TWIN WHEN IT PICKS ONE (tickets
 * #300, #321): «number ending 8416; the other side last wrote on Saturday,
 * Sep 26, 2026».
 *
 * FACTS THE TWIN READS, NEVER KEYS CODE MATCHES. A customer with two numbers
 * is one reference, and when the twin writes to them it picks the chat; this
 * is what it picks by, and the tail on the draft card is what the rep checks
 * the pick by before the tap. Nothing compares the twin's or the rep's words
 * against it.
 *
 * ENGLISH METADATA, LIKE EVERY VALUE CODE WRITES INTO A TURN (#139's rule,
 * `renderTurnInstant`'s form without the hour). A chat the other side never
 * wrote in says so: never having written is itself something to pick by.
 */
export function renderChatFacts(tail: string | undefined, lastWroteOn: string | undefined): string {
  const wrote =
    lastWroteOn === undefined
      ? "the other side has not written yet"
      : `the other side last wrote on ${new Intl.DateTimeFormat("en-US", {
          weekday: "long",
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${lastWroteOn}T00:00:00Z`))}`;
  return tail === undefined ? `no number shown; ${wrote}` : `number ending ${tail}; ${wrote}`;
}

/**
 * WHETHER A PIECE OF THE REP'S OWN PROSE NAMES SOMEBODY (ticket #195; ruling
 * 3 on #177).
 *
 * THE SAME FOLD, READ THE OTHER WAY ROUND. `resolveChatCandidates` asks
 * whether the words the rep typed name a confirmed binding; this asks
 * whether a name appears as a contiguous run of whole words inside a
 * sentence they wrote — «lo de la Sra. Garza» names «Sra. Garza», and «lo de
 * las cajas» names nobody. One implementation, because two would be two
 * answers to "did the rep say this name" on a surface where the answer
 * decides which of two customers gets the turn's one question.
 */
export function mentionsName(prose: string, name: string): boolean {
  const wanted = foldWords(name);
  if (wanted.length === 0) return false;
  return namesTheSame(wanted, foldWords(prose));
}

/**
 * ...AND THE SAME, ALLOWING THE NAME TO BE SHORTENED (ticket #195; Codex
 * round 3).
 *
 * `resolveChatCandidates` READS «Torres» AS «Torres Hermanos», so anywhere
 * the question is "did they name this customer" rather than "did they write
 * this string", the shortened form counts. Bounded to the ENDS of the name,
 * which is where a person shortens one: a word from the MIDDLE of
 * «Ferretería del Norte» would otherwise make «del» a name.
 *
 * WHERE IT IS NOT USED, AND WHY (recorded on the ticket). The general
 * typed-name refusal keeps the whole name: a push-name is whatever the other
 * side set it to, so one that begins or ends with an ordinary word — a real
 * fixture in this repo is called «quien sea» — would make that word
 * unwriteable and starve a turn that is trying to answer. Here the cost is
 * bounded: the sentences this reads are the rep's own message and the one
 * question the reply asks.
 */
export function mentionsNameOrPart(prose: string, name: string): boolean {
  const wanted = foldWords(name);
  if (wanted.length === 0) return false;
  const said = foldWords(prose);
  for (let length = wanted.length; length >= 1; length -= 1) {
    if (namesTheSame(wanted.slice(0, length), said)) return true;
    if (
      length < wanted.length &&
      namesTheSame(wanted.slice(wanted.length - length), said)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Case- and accent-insensitive, because the rep types a name and not an
 * identifier — the same normalization the guard and the drafting contract
 * use for the same job.
 */
export function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * ...and the same fold cut into WORDS, which is what a name is compared by.
 *
 * Everything that is not a letter or a digit is a separator, so «Sra. Garza»
 * and «Sra Garza» are the same two words and punctuation the rep did or did
 * not type decides nothing.
 */
function foldWords(name: string): readonly string[] {
  return foldName(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

/**
 * Whether the typed words name this binding: the same words, or a contiguous
 * run of them inside it.
 *
 * CONTIGUOUS AND IN ORDER, because a name is a phrase rather than a bag of
 * words: «Torres Hermanos» is named by «Torres» and by «Hermanos», and not
 * by «Hermanos Torres», which is somebody else.
 */
function namesTheSame(
  typed: readonly string[],
  confirmed: readonly string[],
): boolean {
  if (typed.length > confirmed.length) return false;
  for (let at = 0; at + typed.length <= confirmed.length; at += 1) {
    if (typed.every((word, i) => word === confirmed[at + i])) return true;
  }
  return false;
}

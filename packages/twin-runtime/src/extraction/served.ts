/**
 * WHAT ONE EXTRACTION'S READS ACTUALLY SERVED (ticket #196; spec #193
 * decision 18: "References are wire references into what this run served, as
 * in the thread").
 *
 * A **wire reference** is a small integer scoped to one run — "1", "2", "3" —
 * and it is the only handle the model ever gets on a conversation, a
 * retrieved message or a filed line. A row's own identity (its chat address,
 * its rail message id, its entity) is the runtime's, and the model is never
 * shown one and never asked for one.
 *
 * WHAT THE REFERENCES ARE FOR HERE, which is NOT what they are for in the
 * thread. The thread's answer CITES its references and the guard resolves
 * them against its map, which is what keeps a citation honest. An
 * extraction's filing cites nothing of the kind: a candidate fact names
 * the DAY's own message and only ever that (`the_day`; `fileOne` refuses
 * anything else), because history and search results ground a resolution and
 * are never a fact's source. So a reference does two things here. It lets the
 * model NARROW its next read — «search that conversation», «read what is
 * filed for that customer» — without ever being handed or asked for a chat
 * address, which is `resolve_chat`'s own argument applied to a read: there is
 * no parameter a poisoned message could put an address into, because the only
 * thing that selects a conversation is a number this run minted. And it makes
 * one row distinguishable from another to whoever reads the trace.
 *
 * ONE COUNTER ACROSS ALL THREE READS, which is the thread's rule and for its
 * reason: the model is handed small integers and never asked which sort of
 * thing one is, so two numbering schemes would be two meanings for `[3]`.
 *
 * ONLY CONVERSATIONS ARE KEPT, because a conversation is the only reference
 * anything resolves. A message's number and a line's number are labels the
 * model reads and hands back to nobody; keeping a map of them would be a
 * store with no reader, and a reader is what makes a map honest.
 *
 * ONE REFERENCE PER CONVERSATION PER RUN. `list_chats` serves the rep's bound
 * conversations, and a second call must not mint second numbers for them: the
 * model could then narrow to one reference while reading the other's filed
 * lines, and a reader of the trace could not tell that the two are the same
 * customer. The first reference wins, because it is the one already printed
 * in front of the model.
 *
 * IT IS MUTABLE AND RUN-SCOPED, which is why it arrives through the deps
 * rather than being built inside a tool: three reads draw from one counter
 * and two of them resolve what a third served, and they are all constructed
 * together from one `ExtractionDeps`.
 */

/** One conversation of the rep's, as `list_chats` served it. */
export interface ServedChat {
  /** The wire reference: what the model narrows a read with. */
  readonly ref: number;
  readonly chatJid: string;
  /** The entity the rep confirmed this chat belongs to. */
  readonly entityId: string;
  /** The name the rep confirmed — the only label the model is shown. */
  readonly displayName: string;
  /** When this conversation last said anything, as twin memory holds it. */
  readonly lastMessageAt: string | undefined;
}

/** One retrieved message, as `search_chat_history` served it. */
export interface ServedMessage {
  readonly ref: number;
  /** The counterparty this chat belongs to, named as the rep would see them. */
  readonly counterparty: string;
  readonly fromMe: boolean;
  readonly occurredAt: string;
  readonly content: string;
}

/** One disclosure line, as `read_filed_facts` served it. */
export interface ServedLine {
  readonly ref: number;
  /** When the aperture filed it — the rep-side row's own instant. */
  readonly filedAt: string;
  /** The line as STORED, never re-rendered (ADR-0034). */
  readonly text: string;
  /** Whether the rep has since marked the fact wrong (FR-33). */
  readonly retracted: boolean;
}

/** The run-scoped recorder: the three reads draw from it and resolve it. */
export class ServedReads {
  readonly #chats = new Map<number, ServedChat>();
  readonly #byChatJid = new Map<string, ServedChat>();
  readonly #reached = new Set<string>();
  #nextRef = 1;

  /**
   * Records conversations and hands them back with their wire references —
   * assigned HERE, sequentially across the whole run, so two reads never hand
   * the model the same number for two different things.
   *
   * IT LOOKS BEFORE IT SERVES (the header's rule): a conversation this run has
   * already served keeps the reference it was already printed under.
   */
  serveChats(rows: readonly Omit<ServedChat, "ref">[]): readonly ServedChat[] {
    return rows.map((row) => {
      const already = this.#byChatJid.get(row.chatJid);
      if (already !== undefined) return already;
      const chat: ServedChat = { ...row, ref: this.#nextRef };
      this.#nextRef += 1;
      this.#chats.set(chat.ref, chat);
      this.#byChatJid.set(chat.chatJid, chat);
      return chat;
    });
  }

  /**
   * Numbers one read's rows, in the order the model is shown them — so every
   * reference names the line it is printed beside.
   */
  number<T>(rows: readonly T[]): readonly (T & { readonly ref: number })[] {
    return rows.map((row) => {
      const numbered = { ...row, ref: this.#nextRef };
      this.#nextRef += 1;
      return numbered;
    });
  }

  /** One served conversation by its reference, or nothing under that number. */
  chat(ref: number): ServedChat | undefined {
    return this.#chats.get(ref);
  }

  /**
   * Records the conversations one search served rows FROM (Codex round 2).
   *
   * IT IS NOT THE SAME QUESTION AS `serveChats`. That one is «which
   * conversations may the model NAME in a later read»; this is «whose words
   * has the model now READ», which is a wider set — a search over every chat
   * serves hits from chats `list_chats` never listed, and an unbound one is
   * never listed at all.
   */
  reach(chatJids: readonly string[]): void {
    for (const chatJid of chatJids) this.#reached.add(chatJid);
  }

  /**
   * Every conversation this run's reads have shown the model the words of
   * (Codex round 2; ADR-0004).
   *
   * WHAT THE FILING DOES WITH IT: the aperture's wall sweep refuses a payload
   * carrying the number of the chat a fact is filed against, and until the
   * search existed that was every chat the model had seen. Now it is not, so
   * the filing hands this set over and the sweep covers those too — a
   * customer's number that arrived through another customer's conversation is
   * chat identity like any other.
   *
   * RUN-SCOPED AND NEVER PERSISTED. It is a fact about what THIS execution
   * was shown, and it lives exactly as long as the execution does.
   */
  reached(): readonly string[] {
    return [...this.#reached];
  }
}

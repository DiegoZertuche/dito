/**
 * WHAT ONE THREAD EXECUTION'S SEARCH ACTUALLY SERVED (ticket #173; spec #171
 * decision 21).
 *
 * A citation is the runtime's record, never the model's prose. The model
 * picks WHICH retrieved messages its answer rests on, by the small integers
 * the search handed it; this is the map those integers resolve against, and
 * a reference the search never served cannot become a citation however the
 * model was steered.
 *
 * A CITATION IS NOT A CUSTOMER REFERENCE (ticket #321). A hit's number is
 * consumed by the turn that read it and nothing reads it again — so it stays
 * per run, counted from 1. A
 * customer is named by their own stable reference (`references.ts`), which
 * means the same row in every turn of the day, and this map holds none.
 *
 * IT IS MUTABLE AND RUN-SCOPED, which is why it arrives through the deps
 * rather than being built inside the tool. The tool writes it and the
 * answer's guard reads it, and the two are constructed together from
 * one `ThreadDeps` — so "the refs this answer cites" and "the refs this run
 * served" are two readings of one value and cannot drift.
 */
import { withoutReferences, type Customers } from "./references.js";

/**
 * One retrieved message, as the search serves it and the answer cites it
 * back.
 *
 * `answering.ts`'s binding ceremony reads `pushName`, `fromMe` and `chatJid`
 * off a cited hit to decide whether a chat has a name to propose (#34).
 */
export interface ServedHit {
  /** The citation's number: what the model cites. Run-scoped, never an id. */
  readonly ref: number;
  readonly chatJid: string;
  /** The WhatsApp message id — the runtime's handle back to this row's seam event. */
  readonly messageId: string;
  /** The counterparty this chat belongs to, named as the rep would see them. */
  readonly counterparty: string;
  /** The customer reference of that chat; absent for the rep's own thread. */
  readonly customer?: number;
  /**
   * The last four digits of this chat's number when its customer has more
   * than one chat (ticket #321) — what the twin picks the chat by when it
   * writes to them, from the conversation the message came out of.
   */
  readonly chatTail?: string;
  readonly fromMe: boolean;
  readonly occurredAt: string;
  readonly content: string;
  /**
   * The chat's raw rail push-name, when it has one — the runtime's own
   * bookkeeping for the binding ceremony's «or answer» trigger (#34), never
   * something the model is shown or asked about.
   */
  readonly pushName?: string;
}

/**
 * ONE CONVERSATION NOBODY HAS CONFIRMED, as a search served it (ticket #195;
 * spec #193 decision 27), by its stable reference (ticket #321).
 *
 * IT IS WHAT THE REPLY'S OWN BINDING QUESTION IS ABOUT. The rep asks about a
 * customer whose chat nobody has confirmed; the answer names them
 * provisionally and asks, in the same message, whether that chat is them.
 *
 * `pushName` IS THE RAIL'S AND THE ONLY NAME A «si» COULD CONFIRM (#34's
 * recorded decision 1) — the name the reference renders, read from the
 * bundle (`references.ts`), so the name the rep reads and the name a «si»
 * binds are one value.
 *
 * `asked` IS READ AT SERVE TIME AND IS NOT THE AUTHORITY. The once-ever rule
 * is decided under the per-twin ceremony lock at commit (`answering.ts`);
 * this copy tells the model the rep has already been asked about the chat.
 */
export interface ServedUnconfirmedChat {
  readonly reference: number;
  readonly chatJid: string;
  readonly pushName: string;
  readonly asked: boolean;
}

/**
 * What the guard is allowed to know about a run's searches and the
 * customers it can name — the whole of it, as a value a test can write by
 * hand.
 */
export interface ServedAnswerState {
  /** Every hit served this run, by citation number. */
  readonly hits: ReadonlyMap<number, ServedHit>;
  /**
   * Every conversation nobody has confirmed that a search served this run,
   * by its reference (ticket #195) — what the binding question's rules read
   * about the turn.
   */
  readonly unconfirmed: ReadonlyMap<number, ServedUnconfirmedChat>;
  /** From a customer reference to the customer it names (ticket #321). */
  readonly customers: Customers;
  /**
   * EVERYTHING THIS RUN WAS SHOWN THAT A LINE'S FIGURES MAY COME FROM (ticket
   * #320): the canvas block and each read's text (`thread/line.ts`).
   */
  readonly grounds: readonly string[];
}

/** An id as the store mints them, wherever it stands in a text. */
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** The run-scoped recorder: the tools write it, the contract reads it. */
export class ServedHits {
  readonly #customers: Customers;
  readonly #hits = new Map<number, ServedHit>();
  readonly #unconfirmed = new Map<number, ServedUnconfirmedChat>();
  readonly #grounds: string[] = [];
  #nextRef = 1;

  constructor(customers: Customers) {
    this.#customers = customers;
  }

  /**
   * Records one search's rows and hands back the hits with their citation
   * numbers — assigned HERE, sequentially across the whole run, so two
   * searches never hand the model the same number for two rows. The rows
   * arrive in the order the model is shown them and the numbers follow it.
   */
  serve(rows: readonly Omit<ServedHit, "ref">[]): readonly ServedHit[] {
    return rows.map((row) => {
      const hit: ServedHit = { ...row, ref: this.#nextRef };
      this.#nextRef += 1;
      this.#hits.set(hit.ref, hit);
      return hit;
    });
  }

  /**
   * Records the conversations one search saw that nobody has confirmed. One
   * entry per reference: a second search over the same chat refreshes it.
   */
  serveUnconfirmed(chats: readonly ServedUnconfirmedChat[]): void {
    for (const chat of chats) this.#unconfirmed.set(chat.reference, chat);
  }

  /** The run's way from a reference to its customer — the guard's and the renderer's one. */
  get customers(): Customers {
    return this.#customers;
  }

  /**
   * Records text this run was shown that a line's figures may come from —
   * with every id and every customer reference taken out, because the digits
   * inside either are not a figure anybody was shown.
   */
  ground(text: string): void {
    this.#grounds.push(withoutReferences(text.replace(UUID, "")));
  }

  /** Records a read the model asked for that completed (ticket #320). */
  read(text: string): void {
    this.ground(text);
  }

  /** What the guard sees. A snapshot, so a later search cannot rewrite it. */
  state(): ServedAnswerState {
    return {
      hits: new Map(this.#hits),
      unconfirmed: new Map(this.#unconfirmed),
      customers: this.#customers,
      grounds: [...this.#grounds],
    };
  }
}
